import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaults, validateSettings } from './settings.js'

const DAY = 86_400_000
const TEN_MINUTES = 600_000

export function describeStorageError(error) {
  if (error.code === 'SHIQU_SQLITE_UNAVAILABLE') {
    return { reason: 'SQLITE_UNAVAILABLE', hint: '当前 DSH Host 缺少 SQLite 支持，请确认 Desktop 安装完整。' }
  }
  const sqliteCode = Number.isInteger(error.errcode) ? error.errcode & 0xff : undefined
  if (sqliteCode === 5 || sqliteCode === 6) {
    return { reason: 'SQLITE_BUSY', hint: '数据库正在被占用。关闭其他 DSH 实例或数据库工具后重试。' }
  }
  if ([8, 14].includes(sqliteCode) || ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) {
    return { reason: 'SQLITE_ACCESS', hint: '无法访问数据库文件或目录。确认 knowledge.sqlite 是文件，且 DSH 可读写 shiqu 目录。' }
  }
  if (sqliteCode === 11 || sqliteCode === 26) {
    return { reason: 'SQLITE_INVALID', hint: 'SQLite 无法识别或校验此数据库。请保留原文件，并从已知可用的备份副本排查。' }
  }
  if (sqliteCode === 1 && /^(?:no such (?:column|table):|table .* has no column named)/i.test(error.message)) {
    return { reason: 'SQLITE_SCHEMA', hint: '数据库表结构与当前插件不匹配。请保留原文件，并记录插件版本和错误码。' }
  }
  if (sqliteCode === 13 || error.code === 'ENOSPC') {
    return { reason: 'SQLITE_FULL', hint: '数据库所在磁盘空间不足。释放空间后重试。' }
  }
  return { reason: 'SQLITE_INIT_FAILED', hint: '数据库初始化失败。请保留原文件，并记录插件版本和错误码。' }
}

function ensureRunSchema(db) {
  // Versions <=0.1.3 used day as the primary key, which prevented multiple runs in one day.
  // Preserve their history atomically. Legacy runs count against today's automatic quota.
  db.exec('BEGIN IMMEDIATE')
  try {
    const columns = db.prepare('PRAGMA table_info(runs)').all()
    if (columns.some(column => column.name === 'day' && column.pk === 1)) {
      db.exec(`
        ALTER TABLE runs RENAME TO runs_legacy;
        CREATE TABLE runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          day TEXT NOT NULL, started INTEGER NOT NULL, outcome TEXT NOT NULL,
          details TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT 'scheduled'
        );
        INSERT INTO runs (day, started, outcome, details, trigger)
          SELECT day, started, outcome, details, 'legacy' FROM runs_legacy;
        DROP TABLE runs_legacy;
      `)
    } else if (!columns.length) {
      db.exec(`CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL, started INTEGER NOT NULL, outcome TEXT NOT NULL,
        details TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT 'scheduled'
      )`)
    } else if (!columns.some(column => column.name === 'trigger')) {
      // Some existing multi-run databases predate trigger tracking.
      db.exec("ALTER TABLE runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'legacy'")
    }
    db.exec('CREATE INDEX IF NOT EXISTS runs_day_trigger ON runs(day, trigger)')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function openState(file) {
  const sqlite = process.getBuiltinModule('node:sqlite')
  if (!sqlite) {
    throw Object.assign(new Error('The DSH Host runtime does not provide node:sqlite'), { code: 'SHIQU_SQLITE_UNAVAILABLE' })
  }
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new sqlite.DatabaseSync(file)
  try {
    db.exec(`
      PRAGMA busy_timeout = 2000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (session TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS moderation (digest TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS discoveries (
        id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, topic TEXT NOT NULL, title TEXT NOT NULL,
        summary TEXT NOT NULL, reason TEXT NOT NULL, category TEXT NOT NULL,
        source TEXT NOT NULL, published TEXT, added INTEGER NOT NULL, status TEXT NOT NULL, feedback INTEGER NOT NULL DEFAULT 0
      );
    `)
    ensureRunSchema(db)
  } catch (error) {
    db.close()
    throw error
  }

  return {
    settings() {
      const row = db.prepare('SELECT value FROM settings WHERE id=1').get()
      return row ? validateSettings(JSON.parse(row.value)) : { ...defaults }
    },
    saveSettings(input) {
      const settings = validateSettings(input)
      db.prepare('INSERT INTO settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
        .run(JSON.stringify(settings))
    },
    cursor(id) {
      return db.prepare('SELECT seq FROM cursors WHERE session=?').get(id)?.seq ?? -1
    },
    saveCursors(cursors) {
      const upsert = db.prepare('INSERT INTO cursors VALUES (?, ?) ON CONFLICT(session) DO UPDATE SET seq=max(seq, excluded.seq)')
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const { id, seq } of cursors) upsert.run(id, seq)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    automaticCount(day) {
      return db.prepare("SELECT COUNT(*) AS count FROM runs WHERE day=? AND trigger<>'manual'").get(day).count
    },
    // The limit applies to scheduled rounds only. Manual rounds may always be claimed;
    // they neither consume scheduled slots nor bypass the running-job lock.
    claim(day, started, trigger, dailyLimit) {
      const result = db.prepare(`INSERT INTO runs (day, started, outcome, details, trigger)
      SELECT ?, ?, 'running', '{}', ? WHERE NOT EXISTS (
          SELECT 1 FROM runs WHERE outcome='running' AND started > ?
        ) AND (?='manual' OR (
          SELECT COUNT(*) FROM runs WHERE day=? AND trigger<>'manual'
        ) < ?)`)
        .run(day, started, trigger, started - TEN_MINUTES, trigger, day, dailyLimit)
      return result.changes ? Number(result.lastInsertRowid) : null
    },
    finish(id, outcome, details = {}) {
      db.prepare('UPDATE runs SET outcome=?, details=? WHERE id=?').run(outcome, JSON.stringify(details), id)
    },
    latest() {
      const row = db.prepare('SELECT * FROM runs ORDER BY started DESC, id DESC LIMIT 1').get()
      if (!row) return null
      return { ...row, outcome: row.outcome === 'running' && Date.now() - row.started > TEN_MINUTES
        ? 'interrupted' : row.outcome, details: JSON.parse(row.details) }
    },
    recentTopics() {
      return db.prepare("SELECT details FROM runs WHERE outcome IN ('complete','no-match') ORDER BY started DESC, id DESC LIMIT 8")
        .all().flatMap(row => JSON.parse(row.details).topic || [])
    },
    recentFeedback() {
      return db.prepare('SELECT topic, feedback FROM discoveries WHERE feedback<>0 ORDER BY added DESC LIMIT 25').all()
    },
    wasBlocked(digest) {
      return db.prepare('SELECT 1 FROM moderation WHERE digest=?').get(digest) !== undefined
    },
    rememberBlock(digest, now) {
      db.prepare('INSERT OR IGNORE INTO moderation VALUES (?, ?)').run(digest, now)
    },
    history() {
      return db.prepare('SELECT * FROM discoveries ORDER BY added DESC, id LIMIT 100').all()
    },
    hasUrl(url) {
      return db.prepare('SELECT 1 FROM discoveries WHERE url=?').get(url) !== undefined
    },
    queue(item) {
      db.prepare(`INSERT INTO discoveries
        (id, url, topic, title, summary, reason, category, source, published, added, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(url) DO NOTHING`)
        .run(item.id, item.url, item.topic, item.title, item.summary, item.reason, item.category,
          item.source, item.published, item.added)
    },
    pending() {
      return db.prepare("SELECT * FROM discoveries WHERE status='pending' ORDER BY added ASC LIMIT 24").all()
    },
    setStatus(id, status) {
      db.prepare('UPDATE discoveries SET status=? WHERE id=?').run(status, id)
    },
    feedback(id, value) {
      return db.prepare('UPDATE discoveries SET feedback=? WHERE id=?').run(value, id).changes === 1
    },
    prune(now) {
      db.prepare("DELETE FROM discoveries WHERE feedback=0 AND status IN ('duplicate','expired') AND added < ?").run(now - 90 * DAY)
      db.prepare('DELETE FROM moderation WHERE created < ?').run(now - 90 * DAY)
    },
    close() {
      db.close()
    },
  }
}
