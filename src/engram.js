import { createHash } from 'node:crypto'

const HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])
const MAX_RESPONSE = 1_000_000

export class EngramError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

async function readJson(response) {
  if (!response.ok) {
    await response.body?.cancel()
    throw new EngramError('ENGRAM_HTTP_' + response.status)
  }
  let length = 0
  const chunks = []
  for await (const chunk of response.body ?? []) {
    length += chunk.byteLength
    if (length > MAX_RESPONSE) throw new EngramError('ENGRAM_RESPONSE_TOO_LARGE')
    chunks.push(Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new EngramError('ENGRAM_BAD_RESPONSE')
  }
}

export function engram(webServer, request = fetch) {
  async function api(path, signal, body) {
    let base
    try {
      base = new URL(webServer.getOrigin())
    } catch {
      throw new EngramError('ENGRAM_WEB_UNAVAILABLE')
    }
    if (!HOSTS.has(base.hostname)) throw new EngramError('ENGRAM_LOOPBACK_REQUIRED')
    const response = await request(new URL('/api/engram/' + path, base), {
      signal, redirect: 'error',
      ...(body && {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base.origin },
        body: JSON.stringify(body),
      }),
    })
    return readJson(response)
  }

  return {
    async readInterests(signal) {
      const [profile, preferences] = await Promise.all([
        api('profile-block?scope=user', signal),
        api('list?scope=user&status=active&kind=preference&limit=10', signal),
      ])
      if (!Array.isArray(preferences.records) || !Object.hasOwn(profile, 'block')) {
        throw new EngramError('ENGRAM_BAD_RESPONSE')
      }
      return [profile.block?.content, ...preferences.records.map(record => record.content)]
        .filter(text => typeof text === 'string')
    },
    async importItem(item, signal) {
      const version = item.published ? '｜发布日期 ' + item.published : ''
      const content = [
        '[拾趣｜外部知识] ' + item.title,
        '主题：' + item.topic,
        '要点：' + item.summary,
        '来源：' + item.url + version,
        '收录：' + new Date(item.added).toISOString().slice(0, 10),
      ].join('\n')
      const record = {
        id: item.id, memoryId: item.id, scope: 'shared', status: 'active',
        kind: item.category === 'update' ? 'fact' : 'skill', content,
        importance: 0.45, confidence: 0.5, createdAt: item.added,
        lastAccessedAt: item.added, accessCount: 0,
        sourceSessionId: null, sourceRound: null, sourceSeq: null,
      }
      const result = await api('import', signal, { scope: 'shared', data: { records: [record], edges: [] } })
      if (result.importedIds?.includes(item.id)) return 'imported'
      if (result.skippedDuplicates === 1 && result.conflicts === 0) {
        const lookup = new URLSearchParams({ scope: 'shared', q: '来源：' + item.url, limit: '10' })
        const found = await api('list?' + lookup, signal)
        if (found.records?.some(existing => existing.id === item.id)) return 'imported'
        return 'duplicate'
      }
      if (result.conflicts === 1) return 'conflict'
      throw new EngramError('ENGRAM_IMPORT_UNCONFIRMED')
    },
  }
}

export function knowledgeId(url) {
  return 'shiqu-' + createHash('sha256').update(url).digest('hex').slice(0, 32)
}
