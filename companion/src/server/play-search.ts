import type { PlaySearchResult } from '../shared/api.js'

export interface PlaySearchProvider {
  search(query: string, limit: number): Promise<PlaySearchResult[]>
  details(packageName: string): Promise<PlayAppDetails | null>
}

export type PlayAppDetails = PlaySearchResult & { category: string; description: string }

type FetchLike = typeof fetch

const APP_ANCHOR_PATTERN = /<a\b([^>]*?)href="\/store\/apps\/details\?id=([A-Za-z][A-Za-z0-9_.]+)[^"]*"([^>]*)>([\s\S]*?)<\/a>/g
const TAG_PATTERN = /<[^>]+>/g
const MAX_SEARCH_HTML_BYTES = 4 * 1024 * 1024

class PlaySearchResponseError extends Error {}

async function readSearchHtml(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  try {
    if (!response.ok) {
      throw new PlaySearchResponseError(`Google Play search returned HTTP ${response.status}.`)
    }
    const contentLength = response.headers.get('Content-Length')
    if (contentLength !== null && Number(contentLength) > MAX_SEARCH_HTML_BYTES) {
      throw new PlaySearchResponseError('Google Play search response is too large.')
    }
    if (!reader) return ''

    // Count the bytes actually received, including decompressed/chunked bodies.
    // A single bounded buffer avoids an unbounded list of tiny stream chunks.
    const bytes = new Uint8Array(MAX_SEARCH_HTML_BYTES)
    let byteLength = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (chunk.value.byteLength > MAX_SEARCH_HTML_BYTES - byteLength) {
        throw new PlaySearchResponseError('Google Play search response is too large.')
      }
      bytes.set(chunk.value, byteLength)
      byteLength += chunk.value.byteLength
    }
    // Decode only after collecting bytes so UTF-8 codepoints split across
    // network chunks retain their original text.
    return new TextDecoder().decode(bytes.subarray(0, byteLength))
  } catch (error) {
    if (error instanceof PlaySearchResponseError) throw error
    console.error(JSON.stringify({
      event: 'play_search_body_read_error',
      status: response.status,
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
    }))
    throw new PlaySearchResponseError('Google Play search response could not be read.')
  } finally {
    if (reader) {
      try { await reader.cancel() } catch { /* Preserve the original read error. */ }
      reader.releaseLock()
    }
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function anchorText(html: string): string[] {
  return [...html.matchAll(/<(?:span|div)[^>]*>([^<]{2,120})<\/(?:span|div)>/g)]
    .map((match) => decodeHtml((match[1] ?? '').replace(TAG_PATTERN, '')))
    .filter((value) => value.length > 1 && !value.startsWith('$'))
}

export function parseGooglePlaySearchHtml(html: string, limit: number): PlaySearchResult[] {
  const normalizedHtml = html.replace(/&quot;/g, '"')
  const seen = new Set<string>()
  const results: PlaySearchResult[] = []

  for (const match of normalizedHtml.matchAll(APP_ANCHOR_PATTERN)) {
    const packageName = match[2]
    if (!packageName || seen.has(packageName)) continue

    const attributes = `${match[1] ?? ''} ${match[3] ?? ''}`
    const body = match[4] ?? ''
    const text = anchorText(body)
    const ariaLabel = attributes.match(/aria-label="([^"]+)"/)?.[1]
    const displayName = decodeHtml(ariaLabel ?? text[0] ?? packageName)
    const publisher = text.find((value) => value !== displayName && value !== packageName) ?? 'Publisher not listed'
    const iconUrl = body.match(/<img[^>]+src="(https:[^"]+)"/)?.[1]

    seen.add(packageName)
    results.push({
      packageName,
      displayName,
      publisher,
      ...(iconUrl ? { iconUrl: decodeHtml(iconUrl) } : {}),
      detailUrl: `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}`,
    })
    if (results.length >= limit) break
  }

  return results
}

export function parseGooglePlayDetailsHtml(html: string, packageName: string): PlayAppDetails | null {
  for (const json of jsonLdBlocks(html)) {
    let value: unknown
    try { value = JSON.parse(json) } catch { continue }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const app = value as Record<string, unknown>
    if (app['@type'] !== 'SoftwareApplication' || app.operatingSystem !== 'ANDROID'
      || typeof app.url !== 'string' || typeof app.name !== 'string'
      || typeof app.applicationCategory !== 'string') continue
    let url: URL
    try { url = new URL(app.url) } catch { continue }
    if (url.origin !== 'https://play.google.com' || url.searchParams.get('id') !== packageName) continue
    const author = app.author && typeof app.author === 'object' && !Array.isArray(app.author)
      ? app.author as Record<string, unknown> : null
    if (typeof author?.name !== 'string' || !author.name.trim() || !app.name.trim()) continue
    return {
      packageName,
      displayName: app.name.trim().slice(0, 100),
      publisher: author.name.trim().slice(0, 120),
      detailUrl: `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}`,
      category: app.applicationCategory.trim().toUpperCase(),
      description: typeof app.description === 'string' ? app.description.slice(0, 5_000) : '',
      ...(typeof app.image === 'string' && app.image.startsWith('https://') ? { iconUrl: app.image } : {}),
    }
  }
  return null
}

function* jsonLdBlocks(html: string): Generator<string> {
  // Play's app record is a small JSON-LD document inside a much larger page.
  // Scan a literal marker with native string search instead of repeatedly
  // walking unrelated, often megabyte-sized inline scripts with a regexp.
  let cursor = 0
  for (let count = 0; count < 32; count++) {
    const marker = html.indexOf('application/ld+json', cursor)
    if (marker < 0) return
    cursor = marker + 'application/ld+json'.length
    const opening = html.lastIndexOf('<', marker)
    const openingEnd = html.indexOf('>', marker)
    if (opening < 0 || openingEnd < marker || openingEnd - opening > 2_048) continue
    const tag = html.slice(opening, openingEnd + 1)
    if (!/^<script\b/i.test(tag) || !/\btype=["']application\/ld\+json["']/i.test(tag)) continue
    const closing = html.indexOf('</', openingEnd + 1)
    if (closing < 0 || closing - openingEnd > 64 * 1024 || !/^<\/script\s*>/i.test(html.slice(closing, closing + 20))) continue
    cursor = closing + 2
    yield html.slice(openingEnd + 1, closing)
  }
}

export class GooglePlayWebSearchProvider implements PlaySearchProvider {
  constructor(
    private readonly language = 'en',
    private readonly country = 'us',
    // workerd treats the global `fetch` as a privileged function: storing it in
    // a property and calling `this.fetcher(...)` throws "Illegal invocation:
    // function called with incorrect `this` reference". Bind the global at
    // capture so the default path always runs with the correct receiver, while
    // keeping the constructor seam for tests. Node's undici fetch is unbound,
    // so this is a no-op there.
    private readonly fetcher: FetchLike = fetch.bind(globalThis),
  ) {}

  async search(query: string, limit: number): Promise<PlaySearchResult[]> {
    const url = new URL('https://play.google.com/store/search')
    url.searchParams.set('q', query)
    url.searchParams.set('c', 'apps')
    url.searchParams.set('hl', this.language)
    url.searchParams.set('gl', this.country)

    return parseGooglePlaySearchHtml(await this.fetchHtml(url), limit)
  }

  async details(packageName: string): Promise<PlayAppDetails | null> {
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName)) return null
    const url = new URL('https://play.google.com/store/apps/details')
    url.searchParams.set('id', packageName)
    url.searchParams.set('hl', this.language)
    url.searchParams.set('gl', this.country)
    const html = await this.fetchHtml(url, true)
    return parseGooglePlayDetailsHtml(html, packageName)
  }

  private async fetchHtml(url: URL, allowMissing = false): Promise<string> {
    let response: Response
    try {
      response = await this.fetcher(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Borealis/0.1 (+personal companion; public Play metadata only)',
        },
        // The Cloudflare Workers runtime rejects redirect: 'error', so 'manual'
        // plus the explicit check below preserves the "reject redirects" intent.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      // The sanitized message below is shown to users. Log the real error for
      // the operator (wrangler tail / observability); keep internals out of the
      // user-facing payload.
      console.error(JSON.stringify({
        event: 'play_search_network_error',
        url: url.toString(),
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
      }))
      throw new PlaySearchResponseError('Google Play search could not be reached.')
    }
    if ((response.type as string) === 'opaqueredirect'
      || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel()
      throw new PlaySearchResponseError('Google Play search did not return a page.')
    }
    if (allowMissing && response.status === 404) {
      await response.body?.cancel()
      return ''
    }
    return readSearchHtml(response)
  }
}
