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
