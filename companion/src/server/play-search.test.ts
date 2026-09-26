import { describe, expect, it, vi } from 'vitest'
import { GooglePlayWebSearchProvider, parseGooglePlaySearchHtml } from './play-search.js'

const PLAY_FIXTURE = `
  <main>
    <a aria-label="North Bank" href="/store/apps/details?id=com.example.northbank&amp;hl=en">
      <img src="https://images.example/north.png">
      <span>North Bank</span><span>North Financial</span>
    </a>
    <a aria-label="Transit Pass" href="/store/apps/details?id=org.example.transit">
      <span>Transit Pass</span><span>Civic Mobility</span>
    </a>
    <a href="/store/apps/details?id=com.example.northbank"><span>Duplicate</span></a>
  </main>
`

const MAX_HTML_BYTES = 4 * 1024 * 1024
const LENGTH_HEADER_CASES: Array<Record<string, string>> = [{}, { 'Content-Length': '1' }]

function chunkedResponse(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let next = 0
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
    cancel,
  }), { headers })
  return { response, cancel }
}

function providerFor(response: Response) {
  return new GooglePlayWebSearchProvider('en', 'us', async () => response)
}

describe('Google Play web search provider', () => {
  it('extracts unique public app metadata from a fixture', () => {
    expect(parseGooglePlaySearchHtml(PLAY_FIXTURE, 10)).toEqual([
      expect.objectContaining({
        packageName: 'com.example.northbank',
        displayName: 'North Bank',
        detailUrl: 'https://play.google.com/store/apps/details?id=com.example.northbank',
      }),
      expect.objectContaining({
        packageName: 'org.example.transit',
        displayName: 'Transit Pass',
      }),
    ])
  })

  it('uses the fixed Play origin and locale without forwarding credentials', async () => {
    let requestedUrl = ''
    const fetcher: typeof fetch = async (input, init) => {
      requestedUrl = input.toString()
      expect(init?.headers).not.toHaveProperty('Authorization')
      return new Response(PLAY_FIXTURE, { status: 200 })
    }
    const provider = new GooglePlayWebSearchProvider('en', 'us', fetcher)
    const results = await provider.search('bank app', 1)

    const requested = new URL(requestedUrl)
    expect(requested.origin).toBe('https://play.google.com')
    expect(requested.searchParams.get('q')).toBe('bank app')
    expect(results).toHaveLength(1)
  })

  it('rejects excessive Content-Length before buffering and cancels the response', async () => {
    const { response, cancel } = chunkedResponse([new TextEncoder().encode(PLAY_FIXTURE)], {
      'Content-Length': String(MAX_HTML_BYTES + 1),
    })
    await expect(providerFor(response).search('bank', 1)).rejects.toThrow('Google Play search response is too large.')
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it.each(LENGTH_HEADER_CASES)('enforces the byte limit with absent or misleading length headers: %j', async (headers) => {
    const { response, cancel } = chunkedResponse([
      new Uint8Array(MAX_HTML_BYTES / 2),
      new Uint8Array(MAX_HTML_BYTES / 2),
      new Uint8Array(1),
      new Uint8Array(1),
    ], headers)
    await expect(providerFor(response).search('bank', 1)).rejects.toThrow('Google Play search response is too large.')
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it('accepts a response exactly at the byte limit and preserves parsed results', async () => {
    const fixture = new TextEncoder().encode(PLAY_FIXTURE)
    const body = new Uint8Array(MAX_HTML_BYTES).fill(32)
    body.set(fixture)
    const { response } = chunkedResponse([body])
    expect(await providerFor(response).search('bank', 1)).toMatchObject([{ packageName: 'com.example.northbank' }])
    expect(response.body?.locked).toBe(false)
  })

  it('preserves UTF-8 characters split between response chunks', async () => {
    const fixture = PLAY_FIXTURE.replaceAll('North Bank', 'Café 🌲 Bank')
    const bytes = new TextEncoder().encode(fixture)
    const split = bytes.findIndex((byte) => byte >= 0x80) + 1
    const { response } = chunkedResponse([bytes.subarray(0, split), bytes.subarray(split)])
    expect(await providerFor(response).search('bank', 1)).toMatchObject([{ displayName: 'Café 🌲 Bank' }])
    expect(response.body?.locked).toBe(false)
  })

  it('sanitizes upstream stream failures and releases the reader', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error('upstream private debug detail')) },
    }))
    await expect(providerFor(response).search('bank', 1)).rejects.toThrow('Google Play search response could not be read.')
    expect(response.body?.locked).toBe(false)
  })

  it('sanitizes fetch failures without forwarding upstream exception details', async () => {
    const provider = new GooglePlayWebSearchProvider('en', 'us', async () => {
      throw new Error('upstream private debug detail')
    })
    await expect(provider.search('bank', 1)).rejects.toThrow('Google Play search could not be reached.')
  })

  it('cancels error response bodies without reading their contents', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 502 })
    await expect(providerFor(response).search('bank', 1)).rejects.toThrow('Google Play search returned HTTP 502.')
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })
})
