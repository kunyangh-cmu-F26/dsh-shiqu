import { SaxesParser } from 'saxes'
import { canonicalUrl } from './settings.js'
import { isModeration, privateExcerpt } from './research.js'

const SOURCE_LIMIT = 16
const MAX_FEED_CHARS = 500_000
const FRESH_UPDATE_MS = 30 * 86_400_000

function parseDate(raw) {
  if (!raw) return null
  const time = Date.parse(raw)
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null
}

function normalizedSource(row, type) {
  const url = canonicalUrl(row.url)
  const title = privateExcerpt(row.title, 180)
  const evidence = privateExcerpt(row.evidence, 900)
  if (!url || !title || !evidence || title.includes('[隐去]')) return null
  return { url, title, evidence, type, host: new URL(url).hostname, published: parseDate(row.date) }
}

export function parseFeed(xml, base) {
  const parser = new SaxesParser({ xmlns: true })
  const items = []
  const stack = []
  let entry = null
  let field
  let fieldDepth
  let content = ''

  parser.on('doctype', () => { throw new Error('FEED_UNSUPPORTED_DOCTYPE') })
  parser.on('error', error => { throw error })
  parser.on('opentag', tag => {
    const name = tag.local.toLowerCase()
    stack.push(name)
    if (name === 'item' || name === 'entry') {
      if (!entry) entry = { depth: stack.length }
      return
    }
    if (!entry || stack.length !== entry.depth + 1) return
    if (name === 'link' && tag.attributes.href?.value) {
      const rel = tag.attributes.rel?.value ?? 'alternate'
      if (rel === 'alternate') entry.link ??= tag.attributes.href.value
      return
    }
    if (['title', 'link', 'description', 'summary', 'content', 'encoded', 'published', 'updated', 'pubdate', 'date'].includes(name)) {
      field = name
      fieldDepth = stack.length
      content = ''
    }
  })
  const appendText = text => {
    if (field && content.length < 2_500) content += text.slice(0, 2_500 - content.length)
  }
  parser.on('text', appendText)
  parser.on('cdata', appendText)
  parser.on('closetag', () => {
    if (entry && field && stack.length === fieldDepth) {
      entry[field] ??= content.trim()
      field = undefined
    }
    if (entry && stack.length === entry.depth) {
      if (entry.link && items.length < 20) {
        try {
          items.push({
            url: new URL(entry.link, base).href, title: entry.title,
            evidence: (entry.description || entry.summary || entry.encoded || entry.content || '').replace(/<[^<>]*>/g, ' '),
            date: entry.published || entry.pubdate || entry.updated || entry.date,
          })
        } catch {
          // A malformed entry link does not invalidate the rest of the feed.
        }
      }
      entry = null
    }
    stack.pop()
  })
  if (xml.length > MAX_FEED_CHARS) throw new Error('FEED_TOO_LARGE')
  parser.write(xml).close()
  return items
}

function releases(json) {
  const rows = JSON.parse(json)
  if (!Array.isArray(rows)) throw new Error('GITHUB_BAD_RESPONSE')
  return rows.filter(row => !row.draft && !row.prerelease).slice(0, 6).map(row => ({
    url: row.html_url,
    title: row.tag_name && row.name !== row.tag_name ? [row.tag_name, row.name].filter(Boolean).join(' · ') : row.name || row.tag_name,
    evidence: row.body,
    date: row.published_at,
  }))
}

async function readSubscription(web, subscription, signal) {
  const isGitHub = subscription.type === 'github'
  const url = isGitHub ? 'https://api.github.com/repos/' + subscription.value + '/releases?per_page=6' : subscription.value
  const response = await web.fetch({ url }, AbortSignal.any([signal, AbortSignal.timeout(18_000)]))
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('SOURCE_HTTP_' + response.statusCode)
  }
  if (response.truncated || response.body?.kind !== 'text') throw new Error('SOURCE_BODY_UNAVAILABLE')
  const rows = isGitHub ? releases(response.body.content) : parseFeed(response.body.content, response.url || url)
  return rows.slice(0, 6).map(row => normalizedSource(row, subscription.type)).filter(Boolean)
}

export async function collectSources(web, settings, plan, now, hasUrl, signal) {
  const searches = []
  if (settings.webSearch) {
    searches.push(Promise.resolve().then(async () => {
      const result = await web.search({ query: plan.query, maxResults: 8 },
        AbortSignal.any([signal, AbortSignal.timeout(25_000)]))
      return result.sources.map(row => normalizedSource({
        url: row.url, title: row.title, evidence: row.summary || row.snippet, date: row.publishedAt,
      }, 'web')).filter(Boolean)
    }))
  }
  const subscriptions = settings.subscriptions.map(subscription => readSubscription(web, subscription, signal))
  const responses = await Promise.allSettled([...searches, ...subscriptions])
  signal.throwIfAborted()
  const sources = new Map()
  let failed = 0
  let filtered = 0
  const successful = []
  for (const response of responses) {
    if (response.status === 'rejected') {
      if (isModeration(response.reason)) filtered += 1
      else failed += 1
    } else {
      successful.push(response.value)
    }
  }
  // Round-robin gives web search and the configured subscriptions room to contribute.
  const maxPosition = Math.max(0, ...successful.map(rows => rows.length))
  for (let index = 0; index < maxPosition; index++) {
    for (const rows of successful) {
      const source = rows[index]
      if (!source || hasUrl(source.url) || sources.has(source.url)) continue
      if (source.type === 'github' && !isRecentUpdate(source, now)) continue
      if (sources.size < SOURCE_LIMIT) sources.set(source.url, source)
    }
  }
  return { sources: [...sources.values()], failed, filtered, attempted: responses.length }
}

export function isRecentUpdate(source, now) {
  if (!source.published) return false
  const age = now - Date.parse(source.published)
  return age >= -86_400_000 && age <= FRESH_UPDATE_MS
}
