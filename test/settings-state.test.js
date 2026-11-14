import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { describeStorageError, openState } from '../src/state.js'
import { defaults, DEFAULT_MAX_TOKENS, validateSettings } from '../src/settings.js'
import { chooseTopic, summarizeConversations } from '../src/research.js'

const start = Date.parse('2026-11-13T19:00:00Z')
const day = '2026-11-13'

test('token budget defaults to 8000 and can be overridden or reset', async () => {
  assert.equal(DEFAULT_MAX_TOKENS, 8000)
  assert.equal(defaults.tokenBudget, null)
  const seen = []
  const llm = { async *stream(options) {
    seen.push(options.maxTokens)
    yield { type: 'text-delta', index: 0, text: options.system.includes('从指定的聊天记录中概括')
      ? '{"topics":["人像摄影","技术教程"]}' : '{"topic":"人像摄影","query":"人像摄影 日落"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const route = { provider: 'p', model: 'm' }
  const signal = new AbortController().signal
  await summarizeConversations(llm, route, [{ source: 1, messages: [{ date: '2026-11-12', text: '我想学习摄影' }] }], signal)
  await chooseTopic(llm, route, { interests: ['人像摄影'], messages: [], feedback: [], history: [] }, signal, 12000)
  assert.deepEqual(seen, [8000, 12000])
  assert.equal(validateSettings({ tokenBudget: 15000 }).tokenBudget, 15000)
  assert.equal(validateSettings({ tokenBudget: null }).tokenBudget, null)
  assert.throws(() => validateSettings({ tokenBudget: 8000.5 }), /Token/)
  assert.throws(() => validateSettings({ dailyLimit: 0 }), /每日/)
})

test('daily automatic cap is configurable; manual runs bypass and do not consume quota', t => {
  const state = openState(':memory:')
  t.after(() => state.close())
  state.saveSettings({ dailyLimit: 3 })
  assert.equal(state.settings().dailyLimit, 3)
  for (let i = 0; i < 3; i++) {
    const id = state.claim(day, start + i, 'scheduled', 3)
    assert.ok(id)
    state.finish(id, 'complete')
  }
  assert.equal(state.automaticCount(day), 3)
  assert.equal(state.claim(day, start + 4, 'scheduled', 3), null)
  for (let i = 0; i < 4; i++) {
    const id = state.claim(day, start + 5 + i, 'manual', 3)
    assert.ok(id)
    state.finish(id, 'no-match')
  }
  assert.equal(state.automaticCount(day), 3)
  assert.equal(state.latest().trigger, 'manual')
})

test('migrates legacy one-run-per-day database without deleting research history', t => {
  const dir = mkdtempSync(join(tmpdir(), 'shiqu-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'knowledge.sqlite')
  const original = new DatabaseSync(path)
  original.exec(`CREATE TABLE runs (day TEXT PRIMARY KEY, started INTEGER NOT NULL,
    outcome TEXT NOT NULL, details TEXT NOT NULL);`)
  original.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run(day, start, 'complete', '{"topic":"摄影"}')
  original.close()
  const state = openState(path)
  t.after(() => state.close())
  assert.equal(state.automaticCount(day), 1)
  assert.equal(state.latest().details.topic, '摄影')
  const manual = state.claim(day, start + 5, 'manual', 1)
  assert.ok(manual)
  state.finish(manual, 'no-match')
  assert.equal(state.automaticCount(day), 1)
  assert.equal(state.latest().trigger, 'manual')
})

test('adds the trigger column to existing multi-run history and preserves settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiqu-test-'))
  const path = join(dir, 'knowledge.sqlite')
  try {
    using original = new DatabaseSync(path)
    original.exec(`
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL, started INTEGER NOT NULL, outcome TEXT NOT NULL, details TEXT NOT NULL
      );
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
    `)
    original.prepare('INSERT INTO settings VALUES (1, ?)').run('{"tokenBudget":12000}')
    const insert = original.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?)')
    insert.run(20, day, start, 'complete', '{"topic":"摄影"}')
    insert.run(21, day, start + 1, 'failed', '{"code":"max-tokens"}')

    const migrated = openState(path)
    try {
      assert.equal(migrated.settings().tokenBudget, 12000)
      assert.deepEqual(migrated.recentTopics(), ['摄影'])
      assert.equal(migrated.automaticCount(day), 2)
      assert.equal(migrated.latest().id, 21)
      assert.equal(migrated.latest().trigger, 'legacy')
      assert.equal(migrated.latest().details.code, 'max-tokens')
      const manual = migrated.claim(day, start + 2, 'manual', 1)
      assert.ok(manual > 21)
      migrated.finish(manual, 'complete')
    } finally {
      migrated.close()
    }

    const reopened = openState(path)
    try {
      assert.equal(reopened.latest().trigger, 'manual')
      assert.equal(reopened.automaticCount(day), 2)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('storage error details classify failures without exposing filesystem paths', () => {
  const cases = [
    [{ errcode: 1, message: 'no such column: trigger' }, 'SQLITE_SCHEMA'],
    [{ errcode: 517 }, 'SQLITE_BUSY'],
    [{ errcode: 14 }, 'SQLITE_ACCESS'],
    [{ code: 'EACCES', message: 'denied at C:\\private' }, 'SQLITE_ACCESS'],
    [{ errcode: 26 }, 'SQLITE_INVALID'],
    [{ errcode: 13 }, 'SQLITE_FULL'],
    [{ code: 'SHIQU_SQLITE_UNAVAILABLE' }, 'SQLITE_UNAVAILABLE'],
    [{ errcode: 1, message: 'other failure' }, 'SQLITE_INIT_FAILED'],
  ]
  for (const [error, reason] of cases) {
    const diagnostic = describeStorageError(error)
    assert.equal(diagnostic.reason, reason)
    assert.doesNotMatch(diagnostic.hint, /private/)
  }
})
