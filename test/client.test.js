import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { defaults } from '../src/settings.js'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function mountSettings(fetchReply) {
  let factory
  let section
  const state = []
  let hook = 0
  let effects = []
  const timeouts = new Map()
  let timerId = 0
  let poll
  let cleanups = []
  let mounted = false
  const React = {
    createElement(type, props, ...children) { return { type, props, children } },
    useState(initial) {
      const index = hook++
      if (!(index in state)) state[index] = initial
      return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next }]
    },
    useRef(value) {
      const index = hook++
      if (!(index in state)) state[index] = { current: value }
      return state[index]
    },
    useEffect(fn) { hook++; effects.push(fn) },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(module) { factory = module.factory } } },
    fetch: fetchReply,
    setInterval(callback) { poll = callback; return 1 },
    clearInterval() {},
    setTimeout(callback) { timeouts.set(++timerId, callback); return timerId },
    clearTimeout(id) { timeouts.delete(id) },
  }, { filename: 'client.js' })
  const plugin = factory(name => {
    assert.equal(name, 'react')
    return React
  })
  plugin.apply({ get(name) {
    assert.equal(name, 'slots')
    return { inject(_, callback) { callback() }, register(_, component) { section = component } }
  } })
  return {
    poll: () => poll(),
    close: () => cleanups.forEach(cleanup => cleanup?.()),
    async debounce() {
      for (const [id, callback] of timeouts) {
        timeouts.delete(id)
        callback()
      }
      await new Promise(resolve => setImmediate(resolve))
    },
    async render() {
      hook = 0
      effects = []
      section()
      if (!mounted) {
        cleanups = effects.map(effect => effect())
        mounted = true
      }
      await new Promise(resolve => setImmediate(resolve))
      hook = 0
      effects = []
      return section()
    },
  }
}

function collectText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(collectText).join('')
}

test('settings surface displays actionable Host-route diagnostics for plain-text 404', async () => {
  const calls = []
  const client = mountSettings(async path => {
    calls.push(path)
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  })
  const tree = await client.render()
  assert.deepEqual(calls, ['/api/dsh-shiqu/state'])
  assert.match(collectText(tree), /HTTP 404/)
  assert.match(collectText(tree), /插件是否已启用/)
  assert.doesNotMatch(collectText(tree), /Unexpected token/)
})

test('settings surface does not throw a JSON parsing error for non-JSON 503', async () => {
  const client = mountSettings(async () => new Response('<html>error</html>', { status: 503 }))
  const tree = await client.render()
  assert.match(collectText(tree), /不是 JSON（HTTP 503/)
})

test('the plugin only requires the webServer service to expose settings', () => {
  const entry = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(entry, /export const inject = \['webServer'\]/)
  assert.match(entry, /get llm\(\) \{ return ctx\.get\('llm'\) \}/)
  assert.match(entry, /get web\(\) \{ return ctx\.get\('web'\) \}/)
})

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    for (const item of Array.isArray(child) ? child : [child]) {
      const match = findNode(item, predicate)
      if (match) return match
    }
  }
}

test('Agent panel enables tool controls and saves the selected permissions and limit', async () => {
  const writes = []
  const client = mountSettings(async (path, request) => {
    if (path.endsWith('/state')) return Response.json({ settings: defaults, history: [], panelToken: 'token' })
    if (path.endsWith('/sessions')) return Response.json({ sessions: [] })
    assert.match(path, /\/settings$/)
    writes.push(JSON.parse(request.body))
    return Response.json({ ok: true })
  })
  let tree = await client.render()
  const permission = (tree, label) => findNode(tree, node => node.type === 'label'
    && collectText(node) === label).children.find(node => node.type === 'input')
  assert.equal(permission(tree, '允许 Agent 网页搜索').props.disabled, true)
  permission(tree, '让研究模型自动调用工具').props.onChange({ target: { checked: true } })
  tree = await client.render()
  assert.equal(permission(tree, '允许 Agent 网页搜索').props.disabled, false)
  permission(tree, '允许 Agent 网页搜索').props.onChange({ target: { checked: false } })
  findNode(tree, node => node.type === 'input' && node.props.max === 6).props.onChange({ target: { value: '4' } })
  await client.debounce()
  assert.deepEqual(writes.map(({ agentResearch, agentWebSearch, agentToolLimit }) =>
    [agentResearch, agentWebSearch, agentToolLimit]), [[true, false, 4]])
})

test('panel recovers after state and session requests fail during Host startup', async () => {
  let stateReady = false
  let sessionsReady = false
  const client = mountSettings(async path => {
    if (path.endsWith('/state')) return stateReady
      ? Response.json({ settings: defaults, history: [], panelToken: 'token' })
      : new Response('not found', { status: 404 })
    return sessionsReady ? Response.json({ sessions: [{ id: 'session-cold', title: '影像笔记' }] })
      : new Response('not found', { status: 404 })
  })
  assert.match(collectText(await client.render()), /HTTP 404 · \/state/)
  stateReady = true
  await client.poll()
  assert.match(collectText(await client.render()), /HTTP 404 · \/sessions/)
  sessionsReady = true
  await client.poll()
  const panel = await client.render()
  assert.doesNotMatch(collectText(panel), /HTTP 404/)
  assert.ok(findNode(panel, node => node.type === 'option' && node.props.value === 'session-cold'))
})

test('storage failures show a safe diagnostic and read-only sessions until retry succeeds', async () => {
  let storageReady = false
  const client = mountSettings(async path => {
    if (path.endsWith('/state')) {
      if (storageReady) return Response.json({ settings: defaults, history: [], panelToken: 'token' })
      return Response.json({
        error: '无法打开 knowledge.sqlite',
        code: 'SHIQU_STORAGE_UNAVAILABLE',
        reason: 'SQLITE_SCHEMA',
        hint: '数据库表结构与当前插件不匹配。',
      }, { status: 503 })
    }
    assert.match(path, /\/sessions$/)
    return Response.json({ sessions: [{ id: 'session-cold', title: '影像笔记' }] })
  })
  const recovery = await client.render()
  assert.match(collectText(recovery), /SQLITE_SCHEMA/)
  assert.match(collectText(recovery), /会话列表（只读）.*影像笔记/)
  assert.doesNotMatch(collectText(recovery), /立即研究/)
  storageReady = true
  await findNode(recovery, node => node.type === 'button' && collectText(node) === '重试连接').props.onClick()
  const restored = await client.render()
  assert.match(collectText(restored), /立即研究/)
  assert.doesNotMatch(collectText(restored), /SQLITE_SCHEMA/)
})

test('manual research flushes the latest settings before starting and closing flushes pending changes', async () => {
  const writes = []
  const client = mountSettings(async (path, request) => {
    if (path.endsWith('/state')) return Response.json({ settings: { ...defaults, tokenBudget: 8000 }, history: [], panelToken: 'token' })
    if (path.endsWith('/sessions')) return Response.json({ sessions: [] })
    writes.push([path.split('/').at(-1), JSON.parse(request.body)])
    return Response.json({ outcome: 'complete' })
  })
  let panel = await client.render()
  const editBudget = (tree, value) => findNode(tree, node => node.type === 'input' && node.props.min === 512)
    .props.onChange({ target: { value } })
  editBudget(panel, '11000')
  editBudget(panel, '12000')
  await findNode(panel, node => node.type === 'button' && collectText(node).includes('立即研究')).props.onClick()
  await client.debounce()
  assert.deepEqual(writes.map(([path, body]) => [path, body.tokenBudget]),
    [['settings', 12000], ['run', undefined]])
  panel = await client.render()
  editBudget(panel, '13000')
  client.close()
  await client.debounce()
  assert.equal(writes.at(-1)[1].tokenBudget, 13000)
})

test('discovery feedback highlights one choice, dims the other, and can be switched or cleared', async () => {
  const id = 'item-1'
  const writes = []
  let feedback = 0
  let resolveWrite
  let rejectWrite = false
  const client = mountSettings(async (path, request) => {
    if (path.endsWith('/state')) return Response.json({
      settings: defaults, panelToken: 'token',
      history: [{ id, feedback, title: '摄影教程', source: 'web', status: 'imported', added: 1 }],
    })
    if (path.endsWith('/sessions')) return Response.json({ sessions: [] })
    assert.match(path, /\/feedback$/)
    const write = JSON.parse(request.body)
    writes.push(write)
    if (writes.length === 1) await new Promise(resolve => { resolveWrite = resolve })
    if (rejectWrite) return Response.json({ error: '反馈保存失败。' }, { status: 503 })
    feedback = write.value
    return Response.json({ ok: true })
  })
  const getButton = (tree, label) => findNode(tree, node => node.type === 'button' && collectText(node) === label)
  const choices = ['有用', '少找这类']
  const verify = (tree, selected, saving = false) => {
    const [useful, less] = choices.map(label => getButton(tree, label).props)
    assert.deepEqual([useful['aria-pressed'], less['aria-pressed']], [selected === 1, selected === -1])
    assert.deepEqual([useful.disabled, less.disabled], [saving, saving])
    if (selected === 0) {
      assert.equal(useful.style.background, less.style.background)
    } else {
      const [active, muted] = selected === 1 ? [useful, less] : [less, useful]
      assert.match(active.style.background, /--dsw-alias-state-business-primary/)
      assert.match(muted.style.color, /--dsw-alias-label-secondary/)
    }
  }

  verify(await client.render(), 0)
  const pending = getButton(await client.render(), '有用').props.onClick()
  verify(await client.render(), 1, true)
  resolveWrite()
  await pending
  verify(await client.render(), 1)
  await getButton(await client.render(), '少找这类').props.onClick()
  verify(await client.render(), -1)
  await getButton(await client.render(), '少找这类').props.onClick()
  verify(await client.render(), 0)
  rejectWrite = true
  await getButton(await client.render(), '有用').props.onClick()
  const restored = await client.render()
  verify(restored, 0)
  assert.match(collectText(restored), /反馈保存失败/)
  assert.deepEqual(writes, [1, -1, 0, 1].map(value => ({ id, value })))
})
