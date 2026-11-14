const MAX_SESSIONS = 12
const MAX_SUBSCRIPTIONS = 12
const SESSION_ID = /^[\w.:-]{1,160}$/

export const DEFAULT_MAX_TOKENS = 8_000

export const defaults = Object.freeze({
  enabled: false,
  dailyLimit: 1,
  tokenBudget: null, // null uses the default maxTokens budget
  fallbackAt: '17:00',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  explore: true,
  webSearch: true,
  sessions: [],
  researchSession: '',
  subscriptions: [],
  provider: '',
  model: '',
})

export function webUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined
    url.hash = ''
    return url
  } catch {
    return undefined
  }
}

export function canonicalUrl(value) {
  const url = webUrl(value)
  if (!url) return undefined
  for (const key of url.searchParams.keys().toArray()) {
    if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  return url.href
}

function validateSubscription(subscription) {
  if (typeof subscription?.value !== 'string') throw new Error('订阅地址格式错误。')
  const value = subscription.value.trim()
  if (subscription.type === 'github' && /^[\w.-]{1,39}\/[\w.-]{1,100}$/.test(value)) {
    if (value.split('/').some(part => part === '.' || part === '..')) throw new Error('GitHub 仓库名无效。')
    return { type: 'github', value: value.toLowerCase() }
  }
  if (subscription.type === 'feed' && webUrl(value)) {
    return { type: 'feed', value: canonicalUrl(value) }
  }
  throw new Error('订阅需要 owner/repo 或完整的 RSS/Atom 地址。')
}

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置格式错误。')
  const { enabled, dailyLimit, tokenBudget, fallbackAt, timeZone, explore, webSearch, sessions, researchSession, subscriptions, provider, model } = { ...defaults, ...input }
  if (![enabled, explore, webSearch].every(value => typeof value === 'boolean')) throw new Error('配置开关格式错误。')
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 24) throw new Error('每日自动研究次数应为 1–24。')
  if (tokenBudget !== null && (!Number.isInteger(tokenBudget) || tokenBudget < 512 || tokenBudget > 65_536)) {
    throw new Error('Token 预算应为 512–65536，或关闭自定义以使用默认 8000。')
  }
  if (typeof fallbackAt !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fallbackAt)) throw new Error('时间应为 HH:MM。')
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 80) throw new Error('时区无效。')
  try {
    new Intl.DateTimeFormat('en', { timeZone })
  } catch {
    throw new Error('时区无效。请填写如 America/Los_Angeles 或 Asia/Shanghai。')
  }
  if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS ||
      !sessions.every(id => typeof id === 'string' && SESSION_ID.test(id))) {
    throw new Error('最多允许选 12 个有效会话。')
  }
  if (typeof researchSession !== 'string' || (researchSession !== '' && !SESSION_ID.test(researchSession))) {
    throw new Error('研究会话 ID 无效。')
  }
  if (!Array.isArray(subscriptions) || subscriptions.length > MAX_SUBSCRIPTIONS) throw new Error('最多允许 12 个订阅。')
  if (![provider, model].every(value => typeof value === 'string' && value.length <= 150 && !/[\r\n]/.test(value)) ||
      Boolean(provider.trim()) !== Boolean(model.trim())) throw new Error('请同时填写模型提供商和模型 ID，或将两项都留空。')

  const uniqueSubscriptions = new Map()
  for (const raw of subscriptions) {
    const subscription = validateSubscription(raw)
    uniqueSubscriptions.set(`${subscription.type}:${subscription.value}`, subscription)
  }
  return { enabled, dailyLimit, tokenBudget, fallbackAt, timeZone, explore, webSearch, sessions: [...new Set(sessions)], researchSession,
    subscriptions: [...uniqueSubscriptions.values()], provider: provider.trim(), model: model.trim() }
}

export function localTime(now, timeZone) {
  const format = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const values = Object.fromEntries(format.formatToParts(now).map(({ type, value }) => [type, value]))
  return { day: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` }
}
