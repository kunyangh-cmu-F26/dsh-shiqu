import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDiscovery } from '../src/discovery.js'
import { knowledgeId } from '../src/engram.js'
import { humanMessages } from '../src/sessions.js'
import { localTime } from '../src/settings.js'
import { collectSources, parseFeed } from '../src/sources.js'
import { openState } from '../src/state.js'

const start = Date.parse('2026-11-13T17:20:00Z')
const route = { provider: 'fixture', model: 'fixture' }
const signal = new AbortController().signal

function setup(t, { initialMessages = [], conversationMessages = [], moderateAt, failImport } = {}) {
  let time = start
  let messages = initialMessages
  let writes = 0
  let calls = []
  let importFailed = false
  let profile = ['我最近想练日落人像']
  const state = openState(':memory:')
  t.after(() => state.close())
  state.saveSettings({ enabled: true, fallbackAt: '17:00', timeZone: 'America/Los_Angeles' })
  const palace = {
    async readInterests() { return profile },
    async importItem() {
      writes++
      if (failImport && !importFailed) {
        importFailed = true
        throw new Error('Engram unavailable')
      }
      return 'imported'
    },
  }
  const sessions = {
    async inspect() {
      const fresh = state.cursor('test') < 1
      return { route, messages: fresh ? messages : [],
        conversations: conversationMessages.length ? [{ source: 1, messages: conversationMessages.map(text =>
          ({ date: '2026-11-13', text })) }] : [],
        cursors: fresh && messages.length ? [{ id: 'test', seq: 1 }] : [], unreadable: 0 }
    },
  }
  const host = {
    llm: {
      async *stream(options) {
        const selection = options.system.includes('候选网页摘要')
        const summary = options.system.includes('从指定的聊天记录中概括')
        calls.push(summary ? 'summary' : selection ? 'select' : 'topic')
        if (moderateAt === calls.at(-1)) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'content_filter', message: 'marked' } } }
          return
        }
        const text = JSON.stringify(summary ? { topics: ['人像摄影', '调色'] } :
          selection ? { items: [{ source: 0, category: 'guide',
          summary: '使用反光板补足面部阴影', reason: '适合日落实拍' }] } :
          { topic: '日落人像', query: '日落人像 反光板' })
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    web: {
      async search({ query }) {
        assert.equal(query, '日落人像 反光板')
        calls.push('search')
        if (moderateAt === 'search') throw Object.assign(new Error('内容审查'), { code: 'content_filter' })
        return { sources: [{ url: 'https://example.com/guide?utm_source=one', title: '反光板实拍', snippet: '银色反光板补光' }] }
      },
    },
  }
  const discovery = createDiscovery({ state, palace, sessions, host, now: () => time, shutdown: signal })
  return { state, discovery, writes: () => writes, calls: () => calls,
    setTime(value) { time = Date.parse(value) }, setMessages(value) { messages = value },
    clearProfile() { profile = [] } }
}

test('runs early when an interest appears and manual research bypasses the daily cap', async t => {
  const instance = setup(t)
  assert.equal((await instance.discovery.start('scheduled')).outcome, 'waiting')
  assert.deepEqual(instance.calls(), [])
  instance.setMessages(['最近想练日落人像'])
  const run = instance.discovery.start('scheduled')
  assert.equal((await instance.discovery.start('manual')).outcome, 'busy')
  assert.equal((await run).outcome, 'complete')
  assert.deepEqual(instance.calls(), ['topic', 'search', 'select'])
  assert.equal(instance.state.cursor('test'), 1)
  const [item] = instance.state.history()
  assert.equal(item.url, 'https://example.com/guide')
  assert.equal(item.id, knowledgeId(item.url))
  assert.equal(item.status, 'imported')
  assert.equal(instance.state.feedback(item.id, -1), true)
  assert.deepEqual(instance.state.recentFeedback().map(row => ({ ...row })), [{ topic: '日落人像', feedback: -1 }])
  assert.equal(instance.state.automaticCount('2026-11-13'), 1)
  assert.equal((await instance.discovery.start('scheduled')).outcome, 'daily-limit')
  assert.equal((await instance.discovery.start('manual')).outcome, 'no-match')
  assert.equal(instance.state.automaticCount('2026-11-13'), 1)
  assert.equal((await instance.discovery.start('manual')).outcome, 'no-match')
})

test('summarizes selected inactive conversation excerpts once per exploration', async t => {
  const instance = setup(t, { conversationMessages: ['我想练人像摄影', '最近试 Lightroom 调色'] })
  instance.setTime('2026-11-14T01:01:00Z')
  assert.equal((await instance.discovery.start('manual')).outcome, 'complete')
  assert.deepEqual(instance.calls(), ['summary', 'topic', 'search', 'select'])
  assert.equal((await instance.discovery.start('manual')).outcome, 'no-match')
  assert.deepEqual(instance.calls(), ['summary', 'topic', 'search', 'select', 'summary', 'topic', 'search'])
})

test('moderated conversation summary stops exploration before topic selection', async t => {
  const instance = setup(t, { conversationMessages: ['想学习人像摄影'], moderateAt: 'summary' })
  assert.equal((await instance.discovery.start('manual')).outcome, 'blocked')
  assert.equal(instance.state.latest().details.stage, 'summary')
  assert.deepEqual(instance.calls(), ['summary'])
  assert.equal((await instance.discovery.start('manual')).outcome, 'blocked')
  assert.deepEqual(instance.calls(), ['summary'])
})

test('runs at the fallback time and deduplicates the same source on the next local date', async t => {
  const instance = setup(t)
  instance.setTime('2026-11-14T01:01:00Z')
  assert.equal((await instance.discovery.start('scheduled')).outcome, 'complete')
  instance.setTime('2026-11-15T01:01:00Z')
  assert.equal((await instance.discovery.start('scheduled')).outcome, 'no-match')
  assert.equal(instance.writes(), 1)
  assert.equal(instance.state.history().length, 1)
})

for (const stage of ['topic', 'search', 'select']) {
  test('ends the blocked stage and leaves the cursor unprocessed for ' + stage, async t => {
    const instance = setup(t, { initialMessages: ['最近想练日落人像'], moderateAt: stage })
    assert.equal((await instance.discovery.start('scheduled')).outcome, 'blocked')
    assert.equal(instance.state.latest().details.stage, stage)
    assert.equal(instance.state.history().length, 0)
    assert.equal(instance.state.cursor('test'), -1)
    assert.equal(instance.calls().at(-1), stage)
  })
}

test('does not submit the same blocked topic input to a model on the next day', async t => {
  const instance = setup(t, { initialMessages: ['最近想练日落人像'], moderateAt: 'topic' })
  assert.equal((await instance.discovery.start('scheduled')).outcome, 'blocked')
  instance.setTime('2026-11-14T17:20:00Z')
  assert.equal((await instance.discovery.start('scheduled')).outcome, 'blocked')
  assert.deepEqual(instance.calls(), ['topic'])
  assert.equal(instance.writes(), 0)
})

test('reconciles pending imports on a later run even after the interest disappears', async t => {
  const instance = setup(t, { failImport: true })
  assert.equal((await instance.discovery.start('manual')).outcome, 'import-pending')
  assert.equal(instance.state.history()[0].status, 'pending')
  instance.clearProfile()
  instance.setTime('2026-11-14T20:01:00Z')
  assert.equal((await instance.discovery.start('manual')).outcome, 'complete')
  assert.equal(instance.state.history()[0].status, 'imported')
  assert.equal(instance.writes(), 2)
})

test('reads recent human turns and ignores Speak Up messages and earlier reads', () => {
  const message = (seq, kind, time) => ({ type: 'user/message', seq, time,
    data: { source: { kind }, content: [{ type: 'text', text: '最近想练日落人像' }] } })
  const events = [message(1, 'user', start), message(2, 'speak-up', start),
    message(3, 'plugin:dsh-engram', start), message(4, 'user', start - 15 * 86_400_000),
    message(5, 'user', start)]
  assert.deepEqual(humanMessages(events, 1, start).map(value => value.seq), [5])
  assert.deepEqual(localTime(Date.parse('2026-11-14T01:01Z'), 'America/Los_Angeles'),
    { day: '2026-11-13', time: '17:01' })
})

test('reads namespaced Atom and RSS and rejects document type declarations', () => {
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Guide &amp; tips</title>' +
    '<link href="/guide"/><summary><![CDATA[<b>Case study</b>]]></summary></entry></feed>'
  assert.deepEqual(parseFeed(atom, 'https://example.com/feed'), [
    { url: 'https://example.com/guide', title: 'Guide & tips', evidence: ' Case study ', date: undefined },
  ])
  const rss = '<rss><channel><item><title>New release</title><link>https://example.org/release</link>' +
    '<pubDate>13 Nov 2026 12:00:00 GMT</pubDate><description>Changes</description></item></channel></rss>'
  assert.equal(parseFeed(rss, 'https://example.org')[0].date, '13 Nov 2026 12:00:00 GMT')
  assert.throws(() => parseFeed('<!DOCTYPE foo><foo/>', 'https://example.org'), /FEED_UNSUPPORTED_DOCTYPE/)
})

test('collects search, GitHub releases and feeds within one round and omits prereleases and stale updates', async () => {
  const web = {
    async search() {
      return { sources: [{ url: 'https://example.com/web', title: 'Web guide', snippet: 'Reproducible steps' }] }
    },
    async fetch({ url }) {
      const evidence = url.includes('api.github.com') ? JSON.stringify([
        { tag_name: 'v2.1', html_url: 'https://github.com/demo/project/releases/tag/v2.1', body: 'Fix', published_at: '2026-11-11' },
        { tag_name: 'v2', html_url: 'https://github.com/demo/project/releases/tag/v2', body: 'Old', published_at: '2026-01-01' },
        { tag_name: 'v3', html_url: 'https://github.com/demo/project/releases/tag/v3', body: 'Preview', published_at: '2026-11-12', prerelease: true },
      ]) : '<rss><channel><item><title>Blog</title><link>https://example.com/blog</link><description>Details</description></item></channel></rss>'
      return { url, statusCode: 200, body: { kind: 'text', content: evidence } }
    },
  }
  const result = await collectSources(web, {
    webSearch: true, subscriptions: [{ type: 'github', value: 'demo/project' }, { type: 'feed', value: 'https://example.com/feed' }],
  }, { query: 'project' }, start, () => false, signal)
  assert.deepEqual(result.sources.map(source => source.type), ['web', 'github', 'feed'])
  assert.equal(result.sources[1].title, 'v2.1')
  assert.equal(result.failed, 0)
})
