import { privateExcerpt } from './research.js'

const MAX_MESSAGE_CHARS = 320
const MAX_CONTEXT_CHARS = 3_200
const RECENT_MS = 14 * 86_400_000

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

export function createSessionReader(ctx, state) {
  const snapshots = new Map()

  async function sessionData(id, cachedRevision, signal) {
    const agent = ctx.get('agents')?.get?.(id)
    if (agent?.session?.snapshotEvents) {
      const events = agent.session.snapshotEvents()
      const revision = 'live:' + (events.at(-1)?.seq ?? -1)
      return revision === cachedRevision ? { revision } : { revision, events }
    }
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) throw new Error('SESSIONS_UNAVAILABLE')
    const stat = await persistence.stat(id, { signal })
    if (!stat) return null
    if (stat.revision !== undefined && stat.revision === cachedRevision) {
      return { revision: stat.revision }
    }
    const handle = await persistence.open(id, 'read', { signal })
    try {
      const result = await handle.read({ signal })
      return { revision: result.revision ?? stat.revision, events: result.events }
    } finally {
      await handle.close()
    }
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
          // Some hosts gate the controller by remote identity. The local persistence catalog still works.
          signal.throwIfAborted()
        }
      }
      const persistence = ctx.get('sessionPersistence')
      const items = await persistence?.list({ signal }) ?? []
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
        if (!snapshot.events) return { ...previous, messages: previous.messages.filter(message => message.seq > cursor) }
        const result = { id, observes, revision: snapshot.revision, route: routeFrom(snapshot.events),
          messages: observes ? humanMessages(snapshot.events, cursor, now) : [] }
        snapshots.set(id, result)
        return result
      }))
      signal.throwIfAborted()
      const available = examined.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
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
      const research = available.find(session => session.id === researchId)
      const route = researchId ? research?.route : settings.provider ? { provider: settings.provider, model: settings.model } :
        available.map(session => session.route).filter(Boolean).sort((a, b) => b.time - a.time)[0]
      const modelIssue = researchId && !research ? 'research-session-unavailable' :
        researchId && !route ? 'research-session-no-model' : 'no-model'
      return { messages, route: route && researchId ? { ...route, sessionId: researchId } : route,
        modelIssue, cursors: [...cursors].map(([id, seq]) => ({ id, seq })),
        unreadable: settings.sessions.length - available.filter(session => session.observes).length }
    },
  }
}
