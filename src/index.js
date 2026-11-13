import { homedir } from 'node:os'
import { join } from 'node:path'
import { createDiscovery } from './discovery.js'
import { engram } from './engram.js'
import { registerPanel } from './panel.js'
import { createSessionReader } from './sessions.js'
import { openState } from './state.js'

export const name = 'dsh-shiqu'
export const inject = ['webServer', 'llm', 'web', 'sessionPersistence', 'agents']

const POLL_INTERVAL = 180_000

export function apply(ctx, config = {}) {
  const pluginHome = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'shiqu')
  ctx.effect(function* () {
    const state = openState(join(pluginHome, 'knowledge.sqlite'))
    const lifetime = new AbortController()
    const sessions = createSessionReader(ctx, state)
    const discovery = createDiscovery({
      state, sessions, palace: engram(ctx.webServer), host: { llm: ctx.llm, web: ctx.web }, shutdown: lifetime.signal,
    })
    let unregister
    let timer
    yield async () => {
      unregister?.()
      clearInterval(timer)
      try {
        lifetime.abort()
        await discovery.settled()?.catch(() => undefined)
      } finally {
        state.close()
      }
    }

    unregister = registerPanel(ctx.webServer, { state, discovery, sessions, shutdown: lifetime.signal })
    timer = setInterval(() => {
      discovery.start('scheduled').catch(error => {
        if (!lifetime.signal.aborted) ctx.logger.warn('dsh-shiqu: scheduled run could not start (%s)', error?.name ?? 'Error')
      })
    }, POLL_INTERVAL)
    timer.unref()
  })
}
