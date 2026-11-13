import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaults, validateSettings } from './settings.js'

const DAY = 86_400_000
const TEN_MINUTES = 600_000

export function openState(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA busy_timeout = 2000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (
      day TEXT PRIMARY KEY, started INTEGER NOT NULL, outcome TEXT NOT NULL, details TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cursors (session TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS moderation (digest TEXT PRIMARY KEY, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS discoveries (
      id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, topic TEXT NOT NULL, title TEXT NOT NULL,
      summary TEXT NOT NULL, reason TEXT NOT NULL, category TEXT NOT NULL,
      source TEXT NOT NULL, published TEXT, added INTEGER NOT NULL, status TEXT NOT NULL, feedback INTEGER NOT NULL DEFAULT 0
    );
  `)

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
    claim(day, now) {
      return db.prepare(`INSERT OR IGNORE INTO runs
        SELECT ?, ?, 'running', '{}' WHERE NOT EXISTS (
          SELECT 1 FROM runs WHERE outcome='running' AND started > ?
        )`).run(day, now, now - TEN_MINUTES).changes === 1
    },
    runForDay(day) {
      return db.prepare('SELECT 1 FROM runs WHERE day=?').get(day) !== undefined
    },
    finish(day, outcome, details = {}) {
      db.prepare('UPDATE runs SET outcome=?, details=? WHERE day=?').run(outcome, JSON.stringify(details), day)
    },
    latest() {
      const row = db.prepare('SELECT * FROM runs ORDER BY started DESC LIMIT 1').get()
      if (!row) return null
      return { ...row, outcome: row.outcome === 'running' && Date.now() - row.started > TEN_MINUTES
        ? 'interrupted' : row.outcome, details: JSON.parse(row.details) }
    },
    recentTopics() {
      return db.prepare("SELECT details FROM runs WHERE outcome IN ('complete','no-match') ORDER BY started DESC LIMIT 8")
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
