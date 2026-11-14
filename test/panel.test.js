import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { registerPanel } from '../src/panel.js'

test('Desktop can save settings and run research when its proxy removes Origin', async () => {
  let handle
  let settings = { enabled: false }
  let runs = 0
  let storageAvailable = true
  const services = {
    state: {
      settings: () => settings,
      latest: () => null,
      history: () => [],
      automaticCount: () => 0,
      saveSettings: next => { settings = next },
    },
    discovery: {
      busy: () => false,
      start: async () => {
        runs++
        return { outcome: 'complete' }
      },
    },
  }
  registerPanel({ register: route => { handle = route.handler } }, {
    getServices: () => storageAvailable ? services : undefined,
    shutdown: new AbortController().signal,
    reportError: (path, error) => assert.fail(`${path}: ${error}`),
    sessions: {
      async list() { return [{ id: 'cold', title: '' }] },
      async diagnose() { return [{ id: 'cold', roles: ['interest'], status: 'readable', eventCount: 50, hasModel: true }] },
    },
  })

  async function request(path, method, headers = {}, body = {}) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method, headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', ...headers },
      url: '/api/dsh-shiqu/' + path, socket: { remoteAddress: '127.0.0.1' },
    })
    const response = {}
    await handle(req, {
      writeHead: status => { response.status = status },
      end: text => { response.body = JSON.parse(text) },
    })
    return response
  }

  const snapshot = await request('state', 'GET')
  assert.equal(snapshot.status, 200)
  const panel = { 'x-dsh-shiqu-panel-token': snapshot.body.panelToken }
  assert.equal((await request('settings', 'POST')).status, 403)
  assert.equal((await request('settings', 'POST', { ...panel, origin: 'https://example.org' })).status, 403)
  assert.equal((await request('settings', 'POST', panel, { enabled: true })).status, 200)
  assert.deepEqual((await request('state', 'GET')).body.settings, { enabled: true })
  assert.equal((await request('run', 'POST', panel)).body.outcome, 'complete')
  assert.equal(runs, 1)
  assert.equal((await request('diagnose', 'POST', panel)).body.sessions[0].status, 'readable')
  storageAvailable = false
  const unavailable = await request('state', 'GET')
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.body.code, 'SHIQU_STORAGE_UNAVAILABLE')
  assert.equal((await request('sessions', 'GET')).body.sessions[0].id, 'cold')
  assert.equal((await request('settings', 'POST', panel)).status, 503)
  storageAvailable = true
  assert.deepEqual((await request('state', 'GET')).body.settings, { enabled: true })
})
