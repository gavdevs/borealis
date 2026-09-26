import type { PlaySearchResult } from '../shared/api.js'

export interface PlaySearchProvider {
  search(query: string, limit: number): Promise<PlaySearchResult[]>
}

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

export class GooglePlayWebSearchProvider implements PlaySearchProvider {
  constructor(
    private readonly language = 'en',
    private readonly country = 'us',
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async search(query: string, limit: number): Promise<PlaySearchResult[]> {
    const url = new URL('https://play.google.com/store/search')
    url.searchParams.set('q', query)
    url.searchParams.set('c', 'apps')
    url.searchParams.set('hl', this.language)
    url.searchParams.set('gl', this.country)

    let response: Response
    try {
      response = await this.fetcher(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Borealis/0.1 (+personal companion; public Play metadata only)',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new PlaySearchResponseError('Google Play search could not be reached.')
    }
    return parseGooglePlaySearchHtml(await readSearchHtml(response), limit)
  }
}
