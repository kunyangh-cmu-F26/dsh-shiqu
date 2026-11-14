import { privateExcerpt } from './research.js'

const MAX_MESSAGE_CHARS = 320
const MAX_CONTEXT_CHARS = 3_200
const RECENT_MS = 14 * 86_400_000
const MAX_SAMPLE_CHARS = 9_000
const MAX_SAMPLE_MESSAGES = 32

export function humanMessages(events, after, now) {
  return events.flatMap(event => {
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user' ||
        !Number.isSafeInteger(event.seq) || event.seq <= after ||
        !Number.isFinite(event.time) || event.time < now - RECENT_MS) return []
    const blocks = Array.isArray(event.data.content) ? event.data.content : []
    const text = privateExcerpt(blocks.filter(block => block?.type === 'text')
      .map(block => block.text).join(' '), MAX_MESSAGE_CHARS)
    return text ? [{ seq: event.seq, time: event.time, text }] : []
  }).slice(-12)
}

// A read-only snapshot of selected conversations. Unlike the unread-message
// cursor, this includes older human turns from inactive Sessions so a fresh
// per-run summary can still identify durable interests. Keep dates so the
// model cannot accidentally treat a six-month-old plan as a new request.
export function sampledConversation(events, now) {
  return events.flatMap(event => {
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user' ||
        !Number.isSafeInteger(event.seq) || !Number.isFinite(event.time) ||
        event.time < 0 || event.time > now + 86_400_000) return []
    const blocks = Array.isArray(event.data.content) ? event.data.content : []
    const text = privateExcerpt(blocks.filter(block => block?.type === 'text')
      .map(block => block.text).join(' '), MAX_MESSAGE_CHARS)
    return text ? [{ time: event.time, text }] : []
  }).slice(-12)
}

function routeFrom(events) {
  let lastUsed
  let pending
  for (const event of events) {
    if (event.type === 'model/selection') {
      const { provider, model, reasoningEffort } = event.data ?? {}
      if (provider && model) pending = { provider, model, reasoningEffort, time: event.time ?? 0 }
    }
    if (event.type === 'request/header') {
      const { provider, model, reasoningEffort } = event.data?.header?.config ?? {}
      if (provider && model) {
        lastUsed = { provider, model, time: event.time ?? 0 }
        if (reasoningEffort && !event.data.header.adapterDefaults?.reasoningEffort) lastUsed.reasoningEffort = reasoningEffort
        if (pending?.provider === provider && pending.model === model &&
            pending.reasoningEffort === lastUsed.reasoningEffort) pending = undefined
      }
    }
  }
  return pending ?? lastUsed
}

// Session rows shown by sessionController.list() are not necessarily active Agents.
// Prefer the host's cold-safe inspection path, then read the durable log directly.
// The persistence SessionHandle.read API is positional (read(offset?, length?));
// passing {signal} as the first argument causes cold-session reads to fail.
export function createSessionReader(ctx, state) {
  const snapshots = new Map()

  async function sessionData(id, cachedRevision, signal) {
    signal.throwIfAborted()
    const agent = ctx.get('agents')?.get?.(id)
    if (agent?.session?.snapshotEvents) {
      const events = agent.session.snapshotEvents()
      const revision = 'live:' + (events.at(-1)?.seq ?? -1)
      return revision === cachedRevision ? { revision } : { revision, events }
    }

    // inspect() reads both attached and cold persisted sessions without
    // activating the Agent (and without a write lock).
    const controller = ctx.get('sessionController')
    let controllerError
    if (typeof controller?.inspect === 'function') {
      try {
        const inspection = await controller.inspect(id, signal)
        signal.throwIfAborted()
        if (inspection && Array.isArray(inspection.events)) {
          const events = inspection.events
          const revision = 'inspect:' + (events.at(-1)?.seq ?? -1)
          return revision === cachedRevision ? { revision } : { revision, events }
        }
      } catch (error) {
        signal.throwIfAborted()
        controllerError = error
      }
    }

    const persistence = ctx.get('sessionPersistence')
    if (!persistence) {
      if (controllerError) throw controllerError
      throw Object.assign(new Error('No session reader available'), { code: 'SESSIONS_UNAVAILABLE' })
    }
    // Backend contract: stat(id), open(id, 'read'), handle.read().
    // An inactive session has no Agent, but can still have a complete log.
    const stat = await persistence.stat(id)
    signal.throwIfAborted()
    if (!stat) return null
    const revision = stat.revision
    if (revision !== undefined && cachedRevision !== undefined && revision === cachedRevision) return { revision }
    const handle = await persistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      signal.throwIfAborted()
      if (!Array.isArray(events)) {
        throw Object.assign(new Error('Session log has no events array'), { code: 'SESSION_HISTORY_INVALID' })
      }
      return { revision: revision ?? 'read:' + (events.at(-1)?.seq ?? -1), events }
    } finally {
      await handle.close()
    }
  }

  function failureCode(error) {
    const code = error?.code
    if (typeof code === 'string') {
      if (/MIGRATION|FORMAT|VERSION/i.test(code)) return 'format-incompatible'
      if (/CORRUPT|INVALID/i.test(code)) return 'invalid-history'
      if (/NOT_FOUND/i.test(code)) return 'not-found'
      if (code === 'SESSIONS_UNAVAILABLE') return 'reader-unavailable'
    }
    if (/Migration|Format|Version/i.test(error?.name ?? '')) return 'format-incompatible'
    if (/Corruption/i.test(error?.name ?? '')) return 'invalid-history'
    return 'read-failed'
  }

  return {
    async list(signal) {
      const sessions = new Map()
      const controller = ctx.get('sessionController')
      if (typeof controller?.list === 'function') {
        try {
          const { items } = await controller.list({}, signal)
          if (Array.isArray(items) && items.length) {
            return items.filter(session => typeof session.sessionId === 'string' && session.origin !== 'subagent')
              .map(session => ({ id: session.sessionId, title: session.projections?.values?.title ?? '' }))
          }
        } catch {
          signal.throwIfAborted()
          // The persistence catalog remains usable when remote identity gates the controller.
        }
      }
      const persistence = ctx.get('sessionPersistence')
      const items = await persistence?.list() ?? []
      signal.throwIfAborted()
      for (const item of items) {
        const id = item.header?.id
        if (typeof id === 'string' && item.header.origin !== 'subagent') sessions.set(id, { id, title: '' })
      }
      const agents = ctx.get('agents')
      for (const agent of agents?.list?.() ?? []) {
        const id = agent.session?.id ?? agent.id
        if (typeof id !== 'string' || agent.session?.header?.origin === 'subagent') continue
        const title = ctx.get('sessionTitle')?.get(agent.session)?.title ?? ''
        sessions.set(id, { id, title })
      }
      return [...sessions.values()].sort((a, b) => Number(Boolean(b.title)) - Number(Boolean(a.title)) || a.id.localeCompare(b.id))
    },
    // Explicit diagnostics expose only availability and model-selection status,
    // never session message bodies or raw storage exception text.
    async diagnose(settings, signal) {
      const ids = [...new Set([...settings.sessions, settings.researchSession].filter(Boolean))]
      const results = await Promise.all(ids.map(async id => {
        const roles = [settings.sessions.includes(id) ? 'interest' : '', id === settings.researchSession ? 'research' : ''].filter(Boolean)
        try {
          const snapshot = await sessionData(id, undefined, signal)
          if (!snapshot) return { id, roles, status: 'not-found' }
          return { id, roles, status: 'readable', eventCount: snapshot.events.length,
            hasModel: Boolean(routeFrom(snapshot.events)) }
        } catch (error) {
          signal.throwIfAborted()
          return { id, roles, status: failureCode(error) }
        }
      }))
      signal.throwIfAborted()
      return results
    },
    async inspect(settings, now, signal) {
      const interestIds = new Set(settings.sessions)
      const researchId = settings.researchSession
      const ids = researchId ? new Set([...interestIds, researchId]) : interestIds
      for (const id of snapshots.keys()) {
        if (!ids.has(id)) snapshots.delete(id)
      }
      const examined = await Promise.allSettled([...ids].map(async id => {
        const observes = interestIds.has(id)
        const previous = snapshots.get(id)
        const revision = previous?.observes === observes ? previous.revision : undefined
        const snapshot = await sessionData(id, revision, signal)
        if (!snapshot) {
          snapshots.delete(id)
          return null
        }
        const cursor = observes ? state.cursor(id) : -1
        if (!snapshot.events && previous) return { ...previous, messages: previous.messages.filter(message => message.seq > cursor) }
        if (!snapshot.events) return null
        const result = { id, observes, revision: snapshot.revision, route: routeFrom(snapshot.events),
          messages: observes ? humanMessages(snapshot.events, cursor, now) : [],
          sample: observes ? sampledConversation(snapshot.events, now) : [] }
        snapshots.set(id, result)
        return result
      }))
      signal.throwIfAborted()
      const available = examined.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
      const unreadableSessions = [...ids].flatMap((id, index) => {
        const result = examined[index]
        if (result.status === 'rejected') return [{ id, reason: failureCode(result.reason) }]
        if (!result.value) return [{ id, reason: 'not-found' }]
        return []
      })
      const allMessages = available.flatMap(session => session.messages
        .filter(message => message.time >= now - RECENT_MS).map(message => ({ ...message, id: session.id })))
        .sort((a, b) => b.time - a.time || b.seq - a.seq)
      let remaining = MAX_CONTEXT_CHARS
      const messages = []
      const cursors = new Map()
      for (const message of allMessages) {
        if (remaining < 60 || messages.length >= 12) break
        const text = message.text.slice(0, remaining)
        messages.push(text)
        remaining -= text.length
        cursors.set(message.id, Math.max(message.seq, cursors.get(message.id) ?? -1))
      }
      // Bound model input across all observed Sessions, newest evidence first.
      // Do not include Session IDs in model-visible context.
      let sampleChars = MAX_SAMPLE_CHARS
      const samples = available.flatMap(session => (session.sample ?? [])
        .map(message => ({ ...message, id: session.id })))
        .sort((a, b) => b.time - a.time).slice(0, MAX_SAMPLE_MESSAGES)
      const groups = new Map()
      for (const message of samples) {
        if (sampleChars < 40) break
        const text = message.text.slice(0, sampleChars)
        sampleChars -= text.length
        if (!groups.has(message.id)) groups.set(message.id, [])
        groups.get(message.id).push({ date: new Date(message.time).toISOString().slice(0, 10), text })
      }
      const conversations = [...groups.values()].map((items, index) => ({
        source: index + 1, messages: items.reverse(),
      }))
      const research = available.find(session => session.id === researchId)
      const route = researchId ? research?.route : settings.provider ? { provider: settings.provider, model: settings.model } :
        available.map(session => session.route).filter(Boolean).sort((a, b) => b.time - a.time)[0]
      const modelIssue = researchId && !research ? 'research-session-unavailable' :
        researchId && !route ? 'research-session-no-model' : 'no-model'
      return { messages, conversations, route: route && researchId ? { ...route, sessionId: researchId } : route,
        modelIssue, cursors: [...cursors].map(([id, seq]) => ({ id, seq })),
        unreadable: unreadableSessions.filter(item => interestIds.has(item.id)).length,
        unreadableSessions }
    },
  }
}
