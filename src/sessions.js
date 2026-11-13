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
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type !== 'request/header') continue
    const { provider, model } = event.data?.header?.config ?? {}
    if (provider && model) return { provider, model, time: event.time ?? 0 }
  }
  return null
}

export function createSessionReader(ctx, state) {
  const snapshots = new Map()

  async function sessionData(id, signal) {
    const agent = ctx.get('agents')?.get?.(id)
    if (agent?.session?.snapshotEvents) {
      const events = agent.session.snapshotEvents()
      const revision = 'live:' + (events.at(-1)?.seq ?? -1)
      return revision === snapshots.get(id)?.revision ? { revision } : { revision, events }
    }
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) throw new Error('SESSIONS_UNAVAILABLE')
    const stat = await persistence.stat(id, { signal })
    if (!stat) return null
    if (stat.revision !== undefined && stat.revision === snapshots.get(id)?.revision) {
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
      for (const id of snapshots.keys()) {
        if (!settings.sessions.includes(id)) snapshots.delete(id)
      }
      const examined = await Promise.allSettled(settings.sessions.map(async id => {
        const snapshot = await sessionData(id, signal)
        if (!snapshot) {
          snapshots.delete(id)
          return null
        }
        const cursor = state.cursor(id)
        const previous = snapshots.get(id)
        if (!snapshot.events) return { ...previous, messages: previous.messages.filter(message => message.seq > cursor) }
        const result = { id, revision: snapshot.revision, route: routeFrom(snapshot.events),
          messages: humanMessages(snapshot.events, cursor, now) }
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
      const route = settings.provider ? { provider: settings.provider, model: settings.model } :
        available.map(session => session.route).filter(Boolean).sort((a, b) => b.time - a.time)[0]
      return { messages, route, cursors: [...cursors].map(([id, seq]) => ({ id, seq })),
        unreadable: examined.filter(result => result.status === 'rejected' || !result.value).length }
    },
  }
}
