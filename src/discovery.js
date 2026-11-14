import { createHash } from 'node:crypto'
import { collectAgentSources, researchTools } from './agent-research.js'
import { knowledgeId } from './engram.js'
import { chooseTopic, isModeration, privateExcerpt, selectKnowledge, summarizeConversations } from './research.js'
import { localTime } from './settings.js'
import { collectSources, isRecentUpdate } from './sources.js'

const RUN_TIMEOUT = 180_000
const IMPORT_TIMEOUT = 24_000
const UPDATE_LIFETIME = 30 * 86_400_000
const INTEREST_SIGNAL = /研究|最近|喜欢|感兴趣|想(?:看|学|练|做|试|找|了解)|在(?:看|学|练|做|试|找)|怎么|如何|有没有|推荐|教程|案例|练习|项目|插件|版本|\b(?:learn|trying|working on|interested|tutorial|looking for|release|update|project|how (?:to|do|can))\b/i

function categoryIsFresh(item, now) {
  return item.category !== 'update' || isRecentUpdate(item, now)
}

function stageFailure(stage, error) {
  const code = typeof error?.code === 'string' && /^[\w.-]{1,80}$/.test(error.code) ? error.code : undefined
  if (isModeration(error)) return { outcome: 'blocked', details: { stage, code: 'CONTENT_FILTER' } }
  return { outcome: 'failed', details: { stage, code: code ?? (error?.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED') } }
}

function finalOutcome(result, imported) {
  if (result.filtered) return 'blocked'
  if (result.pending) return 'import-pending'
  return imported ? 'complete' : 'no-match'
}

function inputDigest(stage, value) {
  return createHash('sha256').update(JSON.stringify([stage, value])).digest('hex')
}

// Spread automatic fallback rounds across the remaining local day rather than
// consuming a raised daily quota in consecutive 3-minute polling cycles.
function scheduledSlotDue(slot, settings, completed) {
  if (slot.time < settings.fallbackAt) return false
  const [hour, minute] = slot.time.split(':').map(Number)
  const [fallbackHour, fallbackMinute] = settings.fallbackAt.split(':').map(Number)
  const remainingMinutes = 24 * 60 - (fallbackHour * 60 + fallbackMinute)
  const elapsedMinutes = hour * 60 + minute - (fallbackHour * 60 + fallbackMinute)
  return completed < 1 + Math.floor(elapsedMinutes * settings.dailyLimit / remainingMinutes)
}

function previousBlock() {
  return Object.assign(new Error('Input previously blocked.'), { code: 'CONTENT_FILTER_PREVIOUS' })
}

export function createDiscovery({ state, palace, sessions, host, now = Date.now, shutdown }) {
  let active

  async function flushPending(signal) {
    let imported = 0
    let pending = 0
    for (const item of state.pending().slice(0, 3)) {
      if (item.category === 'update' && now() - Date.parse(item.published) > UPDATE_LIFETIME) {
        state.setStatus(item.id, 'expired')
        continue
      }
      try {
        const status = await palace.importItem(item, AbortSignal.any([signal, AbortSignal.timeout(IMPORT_TIMEOUT)]))
        state.setStatus(item.id, status)
        if (status === 'imported') imported++
      } catch (error) {
        signal.throwIfAborted()
        if (isModeration(error)) {
          state.setStatus(item.id, 'blocked')
          return { imported, pending, filtered: 1, code: 'CONTENT_FILTER' }
        }
        pending++
        // A failed import keeps its deterministic ID for the next scheduled round.
        return { imported, pending, code: stageFailure('import', error).details.code }
      }
    }
    return { imported, pending }
  }

  async function run(trigger) {
    const settings = state.settings()
    if (!settings.enabled && trigger !== 'manual') return { outcome: 'disabled' }
    if (!settings.webSearch && settings.subscriptions.length === 0) return { outcome: 'no-source' }
    const tools = researchTools(settings)
    if (settings.agentResearch && !tools.length) return { outcome: 'no-agent-tools' }
    const started = now()
    const slot = localTime(started, settings.timeZone)
    const automaticCount = state.automaticCount(slot.day)
    if (trigger !== 'manual' && automaticCount >= settings.dailyLimit) return { outcome: 'daily-limit' }
    if (trigger === 'scheduled' && slot.time >= settings.fallbackAt &&
        !scheduledSlotDue(slot, settings, automaticCount)) return { outcome: 'waiting' }
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(RUN_TIMEOUT)])
    const reading = await sessions.inspect(settings, started, signal)
    const early = trigger === 'scheduled' && slot.time < settings.fallbackAt
    if (early && !reading.messages.some(message => INTEREST_SIGNAL.test(message))) return { outcome: 'waiting' }
    if (!reading.route) return { outcome: reading.modelIssue ?? 'no-model' }
    const runId = state.claim(slot.day, started, trigger, settings.dailyLimit)
    if (runId === null) return { outcome: state.automaticCount(slot.day) >= settings.dailyLimit && trigger !== 'manual'
      ? 'daily-limit' : 'busy' }

    let stage = 'engram-read'
    let fingerprint
    let topic
    let outcome
    let details = {}
    let agentDetails
    try {
      if (state.pending().length > 0) {
        stage = 'import'
        const resumed = await flushPending(signal)
        if (resumed.pending || resumed.filtered) {
          outcome = resumed.filtered ? 'blocked' : 'import-pending'
          details = { ...resumed, stage }
          state.finish(runId, outcome, details)
          return { outcome }
        }
        details.imported = resumed.imported
        stage = 'engram-read'
      }
      state.prune(started)
      const interests = (await palace.readInterests(signal)).map(text => privateExcerpt(text, 600)).filter(Boolean)
      if (interests.length === 0 && reading.messages.length === 0 && !reading.conversations?.length) {
        outcome = 'no-interest'
      } else {
        let conversationInterests = []
        if (reading.conversations?.length) {
          stage = 'summary'
          fingerprint = inputDigest(stage, reading.conversations)
          if (state.wasBlocked(fingerprint)) throw previousBlock()
          conversationInterests = await summarizeConversations(host.llm, reading.route,
            reading.conversations, signal, settings.tokenBudget)
        }
        stage = 'topic'
        const dayNumber = Math.floor(Date.parse(slot.day) / 86_400_000)
        fingerprint = inputDigest(stage, [interests, conversationInterests, reading.messages])
        if (state.wasBlocked(fingerprint)) throw previousBlock()
        const plan = await chooseTopic(host.llm, reading.route, {
          interests: [...interests, ...conversationInterests], messages: reading.messages, feedback: state.recentFeedback(),
          history: [...new Set(state.recentTopics())], exploration: settings.explore && dayNumber % 5 === 0,
        }, signal, settings.tokenBudget)
        if (!plan) {
          outcome = 'no-match'
          state.saveCursors(reading.cursors)
        } else {
          topic = plan.topic
          stage = 'search'
          fingerprint = undefined
          const hasUrl = url => state.hasUrl(url)
          let gathered
          if (tools.length) {
            fingerprint = inputDigest('agent-search', [plan, tools.map(tool => tool.name), settings.subscriptions])
            if (state.wasBlocked(fingerprint)) throw previousBlock()
            const agent = await collectAgentSources({
              llm: host.llm, web: host.web, tools, route: reading.route, settings, plan, now: started, hasUrl, signal,
            })
            agentDetails = { toolCalls: agent.calls, ...(agent.fallback ? { fallback: agent.fallback } : {}) }
            if (!agent.fallback) gathered = agent
          }
          fingerprint = undefined
          const sourceSettings = settings.agentResearch ? {
            webSearch: settings.webSearch && settings.agentWebSearch,
            subscriptions: settings.agentSubscriptions ? settings.subscriptions : [],
          } : settings
          gathered ??= await collectSources(host.web, sourceSettings, plan, started, hasUrl, signal)
          const { sources, failed, filtered, attempted } = gathered
          details = { ...details, failed, filtered, attempted }
          if (filtered && (!sources.length || (agentDetails && !agentDetails.fallback))) {
            outcome = 'blocked'
            details.stage = 'search'
          } else if (!sources.length && failed === attempted) {
            outcome = 'failed'
            details.stage = 'search'
          } else {
            stage = 'select'
            fingerprint = inputDigest(stage, [topic, sources])
            if (state.wasBlocked(fingerprint)) throw previousBlock()
            const selected = sources.length ? await selectKnowledge(host.llm, reading.route, topic, sources, signal, settings.tokenBudget) : []
            const worthy = selected.filter(item => categoryIsFresh(item, started))
            for (const item of worthy) {
              state.queue({ ...item, id: knowledgeId(item.url), topic, added: started, source: item.type })
            }
            stage = 'import'
            fingerprint = undefined
            const result = await flushPending(signal)
            details = { ...details, ...result, imported: (details.imported ?? 0) + result.imported,
              filtered: filtered + (result.filtered ?? 0) }
            outcome = finalOutcome(result, details.imported)
            if (result.filtered || result.pending) details.stage = stage
            state.saveCursors(reading.cursors)
          }
        }
      }
    } catch (error) {
      const failure = stageFailure(stage, error)
      if (failure.outcome === 'blocked' && fingerprint) state.rememberBlock(fingerprint, started)
      outcome = failure.outcome
      details = failure.details
    }
    if (details.imported && ['no-interest', 'no-match'].includes(outcome)) outcome = 'complete'
    state.finish(runId, outcome, { ...details, ...(agentDetails ? { agent: agentDetails } : {}),
      ...(topic ? { topic } : {}), unreadable: reading.unreadable,
      unreadableSessions: reading.unreadableSessions ?? [] })
    return { outcome }
  }

  return {
    busy: () => active !== undefined,
    start(trigger) {
      if (active) return Promise.resolve({ outcome: 'busy' })
      active = run(trigger).finally(() => { active = undefined })
      return active
    },
    settled: () => active,
  }
}
