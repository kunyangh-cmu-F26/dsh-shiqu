const PATH = '/api/dsh-shiqu'
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])
const MAX_REQUEST = 32_000

function sameSite(req) {
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? ''
  if (!/^(?:127\.(?:\d{1,3}\.){2}\d{1,3}|::1)$/.test(peer)) return false
  try {
    const host = new URL('http://' + req.headers.host)
    if (!LOOPBACK.has(host.hostname)) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    if (req.method === 'GET') return true
    const origin = new URL(req.headers.origin)
    const expectedProtocol = req.socket.encrypted ? 'https:' : 'http:'
    return origin.host === host.host && origin.protocol === expectedProtocol &&
      /^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')
  } catch {
    return false
  }
}

function respond(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_REQUEST) throw new Error('请求过大。')
    chunks.push(chunk)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式错误。')
  return body
}

export function registerPanel(server, { state, discovery, sessions, shutdown }) {
  return server.register({
    kind: 'prefix', path: PATH, auth: 'anonymous',
    async handler(req, res) {
      if (!sameSite(req)) return respond(res, 403, { error: '请在本机 DSH 设置中操作。' })
      const path = new URL(req.url, 'http://127.0.0.1').pathname.slice(PATH.length)
      try {
        if (req.method === 'GET' && path === '/state') {
          return respond(res, 200, { settings: state.settings(), latest: state.latest(),
            busy: discovery.busy(), history: state.history() })
        }
        if (req.method === 'GET' && path === '/sessions') {
          return respond(res, 200, { sessions: await sessions.list(AbortSignal.any([shutdown, AbortSignal.timeout(5_000)])) })
        }
        if (req.method !== 'POST') return respond(res, 404, { error: '操作不存在。' })
        const body = await readBody(req)
        if (path === '/settings') {
          state.saveSettings(body)
          return respond(res, 200, { ok: true })
        }
        if (path === '/run') {
          const status = await discovery.start('manual')
          return respond(res, 200, status)
        }
        if (path === '/feedback') {
          if (typeof body.id !== 'string' || ![-1, 0, 1].includes(body.value)) {
            return respond(res, 400, { error: '反馈格式错误。' })
          }
          if (!state.feedback(body.id, body.value)) return respond(res, 404, { error: '找不到收录记录。' })
          return respond(res, 200, { ok: true })
        }
        return respond(res, 404, { error: '操作不存在。' })
      } catch (error) {
        if (path === '/settings' || error instanceof SyntaxError || error.message === '请求过大。') {
          const message = error instanceof SyntaxError ? '请求格式错误。' : error.message
          return respond(res, 400, { error: message })
        }
        return respond(res, 503, { error: '暂时无法完成操作，请查看宿主日志。' })
      }
    },
  })
}
