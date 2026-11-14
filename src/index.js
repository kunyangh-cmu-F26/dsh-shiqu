import { homedir } from 'node:os'
import { join } from 'node:path'
import { createDiscovery } from './discovery.js'
import { engram } from './engram.js'
import { registerPanel } from './panel.js'
import { createSessionReader } from './sessions.js'
import { openState } from './state.js'

export const name = 'dsh-shiqu'
// The settings panel must be available even if optional research services are
// absent or still starting. Cold-session reading and model calls resolve them
// only when requested. Requiring all of them previously left the Host route
// unregistered while the browser settings section was still visible.
export const inject = ['webServer']

const POLL_INTERVAL = 180_000
const STORAGE_RETRY_INTERVAL = 5_000

export function apply(ctx, config = {}) {
  const pluginHome = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'shiqu')
  ctx.effect(function* () {
    const lifetime = new AbortController()
    let services
    let retryAt = 0
    const sessions = createSessionReader(ctx, { cursor: id => services.state.cursor(id) })
    let unregister
    let timer
    function reportError(operation, error) {
      ctx.logger.warn('dsh-shiqu: %s (%s)', operation, error?.code ?? error?.name ?? 'Error')
    }
    function getServices() {
      if (services || lifetime.signal.aborted || Date.now() < retryAt) return services
      let state
      try {
        state = openState(join(pluginHome, 'knowledge.sqlite'))
      } catch (error) {
        retryAt = Date.now() + STORAGE_RETRY_INTERVAL
        ctx.logger.warn('dsh-shiqu: knowledge.sqlite initialization failed: %s', error.message)
        return undefined
      }
      const discovery = createDiscovery({
        state, sessions, palace: engram(ctx.webServer),
        host: { get llm() { return ctx.get('llm') }, get web() { return ctx.get('web') } },
        shutdown: lifetime.signal,
      })
      services = { state, discovery }
      return services
    }

    yield async () => {
      unregister?.()
      clearInterval(timer)
      try {
        lifetime.abort()
        await services?.discovery.settled()?.catch(() => undefined)
      } finally {
        services?.state.close()
      }
    }

    unregister = registerPanel(ctx.webServer, { getServices, sessions, shutdown: lifetime.signal, reportError })
    getServices()
    timer = setInterval(() => {
      getServices()?.discovery.start('scheduled').catch(error => {
        if (!lifetime.signal.aborted) reportError('scheduled run could not start', error)
      })
    }, POLL_INTERVAL)
    timer.unref()
  })
}
