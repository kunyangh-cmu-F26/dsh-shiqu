import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionReader } from '../src/sessions.js'
import { openState } from '../src/state.js'

const now = Date.now()
const signal = new AbortController().signal

function harness(t, history) {
  const state = openState(':memory:')
  t.after(() => state.close())
  const persistence = {
    async stat(id) { return history[id] && { revision: history[id].length } },
    async open(id, mode) {
      assert.equal(mode, 'read')
      return { read: async () => ({ events: history[id] }), close: async () => {} }
    },
  }
  const ctx = { get: name => name === 'sessionPersistence' ? persistence : undefined }
  const reader = createSessionReader(ctx, state)
  return (inputs) => {
    state.saveSettings(inputs)
    return reader.inspect(state.settings(), now, signal)
  }
}

const message = (text, seq) => ({ type: 'user/message', seq, time: now,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const selection = (provider, model, effort) => ({ type: 'model/selection', time: now,
  data: { provider, model, reasoningEffort: effort } })
const request = (provider, model, effort) => ({ type: 'request/header', time: now,
  data: { header: { config: { provider, model, reasoningEffort: effort } } } })

test('uses the chosen research model without reading its chat as an interest source', async t => {
  const inspect = harness(t, {
    chat: [request('chat-provider', 'chat-model'), message('摄影兴趣', 1)],
    research: [selection('research-provider', 'research-model', 'high'), message('独立研究会话消息', 1)],
  })
  const result = await inspect({ sessions: ['chat'], researchSession: 'research', provider: 'old', model: 'old' })
  assert.deepEqual(result.route, { provider: 'research-provider', model: 'research-model',
    reasoningEffort: 'high', time: now, sessionId: 'research' })
  assert.deepEqual(result.messages, ['摄影兴趣'])
  assert.deepEqual(result.cursors, [{ id: 'chat', seq: 1 }])

  const observed = await inspect({ sessions: ['research'], researchSession: 'research' })
  assert.deepEqual(observed.messages, ['独立研究会话消息'])
  const unobserved = await inspect({ sessions: [], researchSession: 'research' })
  assert.deepEqual(unobserved.messages, [])
})

test('retains pending selection until a matching request consumes it', async t => {
  const history = { research: [request('provider', 'previous'), selection('provider', 'next'), request('provider', 'previous')] }
  const inspect = harness(t, history)
  assert.equal((await inspect({ researchSession: 'research' })).route.model, 'next')
  history.research.push(request('provider', 'next'), request('provider', 'newest'))
  assert.equal((await inspect({ researchSession: 'research' })).route.model, 'newest')
})

test('reports missing or unconfigured research sessions and preserves legacy model choices', async t => {
  const inspect = harness(t, { chat: [request('chat-provider', 'chat-model')], empty: [] })
  const missing = await inspect({ sessions: ['chat'], researchSession: 'missing' })
  assert.equal(missing.modelIssue, 'research-session-unavailable')
  assert.equal(missing.route, undefined)
  const empty = await inspect({ sessions: ['chat'], researchSession: 'empty' })
  assert.equal(empty.modelIssue, 'research-session-no-model')
  assert.equal(empty.route, undefined)
  assert.equal((await inspect({ sessions: ['chat'] })).route.model, 'chat-model')
  const explicit = await inspect({ sessions: ['chat'], provider: 'manual', model: 'manual' })
  assert.equal(explicit.route.model, 'manual')
})

test('cold persisted session appears in picker and can be read without an Agent', async t => {
  const state = openState(':memory:')
  t.after(() => state.close())
  let inspections = 0
  const past = now - 35 * 86_400_000
  const ctx = { get: name => {
    if (name === 'sessionController') return {
      async list() { return { items: [{ sessionId: 'cold', projections: { values: { title: '旧对话' } } }] } },
      async inspect(id) {
        assert.equal(id, 'cold')
        inspections++
        return { events: [{ ...message('摄影入门和相机曝光', 1), time: past }, request('fixture', 'model')] }
      },
    }
    if (name === 'agents') return { get() { return undefined } }
  } }
  const reader = createSessionReader(ctx, state)
  assert.deepEqual(await reader.list(signal), [{ id: 'cold', title: '旧对话' }])
  const settings = { ...state.settings(), sessions: ['cold'] }
  const reading = await reader.inspect(settings, now, signal)
  assert.equal(reading.messages.length, 0) // Not a fresh 14-day trigger.
  assert.equal(reading.conversations.length, 1) // Still usable for interest summary.
  assert.equal(reading.conversations[0].messages[0].text, '摄影入门和相机曝光')
  assert.equal(reading.route.model, 'model')
  assert.equal(reading.unreadable, 0)
  assert.equal((await reader.diagnose(settings, signal))[0].status, 'readable')
  assert.ok(inspections >= 1)
})

test('uses positional persistence read for an inactive session when controller is unavailable', async t => {
  const state = openState(':memory:')
  t.after(() => state.close())
  let closeCount = 0
  const reader = createSessionReader({ get: name => name === 'sessionPersistence' ? {
    async stat(id) { return id === 'cold' && { revision: 'r1' } },
    async open(id, mode) {
      assert.equal(id, 'cold')
      assert.equal(mode, 'read')
      return {
        async read(offset, length) {
          assert.equal(offset, undefined)
          assert.equal(length, undefined)
          return { events: [message('想研究相机曝光', 0)] }
        },
        async close() { closeCount++ },
      }
    },
  } : undefined }, state)
  const settings = { ...state.settings(), sessions: ['cold'] }
  assert.equal((await reader.inspect(settings, now, signal)).unreadable, 0)
  assert.equal(closeCount, 1)
})

test('reports unreadable session failure without exposing content', async t => {
  const state = openState(':memory:')
  t.after(() => state.close())
  const reader = createSessionReader({ get: name => name === 'sessionPersistence' ? {
    async stat() { throw Object.assign(new Error('private token secret'), { code: 'SESSION_FORMAT_UNSUPPORTED' }) },
  } : undefined }, state)
  const settings = { ...state.settings(), sessions: ['old'] }
  const result = await reader.diagnose(settings, signal)
  assert.deepEqual(result, [{ id: 'old', roles: ['interest'], status: 'format-incompatible' }])
  const reading = await reader.inspect(settings, now, signal)
  assert.equal(reading.unreadable, 1)
  assert.deepEqual(reading.unreadableSessions, [{ id: 'old', reason: 'format-incompatible' }])
})
