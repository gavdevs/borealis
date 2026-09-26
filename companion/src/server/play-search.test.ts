import { describe, expect, it } from 'vitest'
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
})
