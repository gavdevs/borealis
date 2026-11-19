import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ApiError, apiRequest, reportAvailability, submitReport } from './api.js'

function stubFetch(response: Response): Mock {
  const fetcher = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

afterEach(() => vi.unstubAllGlobals())

describe('web report requests', () => {
  it('sends a web-sourced report with the mutation guard and JSON body', async () => {
    const fetcher = stubFetch(Response.json({ ok: true, number: 3, url: 'https://github.com/gavdevs/borealis/issues/3' }, { status: 201 }))
    const receipt = await submitReport({ title: 'Pairing failed', description: 'The code was rejected for a fresh phone.' })

    expect(receipt).toEqual({ ok: true, number: 3, url: 'https://github.com/gavdevs/borealis/issues/3' })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/borealis/v1/reports')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('X-Borealis-Request')).toBe('1')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'Pairing failed', description: 'The code was rejected for a fresh phone.', source: 'web',
    })
  })

  it('surfaces the server error message for an unconfigured tracker', async () => {
    stubFetch(Response.json({ error: 'Report filing is not configured on this companion.' }, { status: 503 }))
    const error = await submitReport({ title: 'Bug', description: 'Something is not working.' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(503)
    expect((error as Error).message).toContain('not configured')
  })

  it('reads report availability without a mutation guard', async () => {
    const fetcher = stubFetch(Response.json({ configured: true }))
    expect(await reportAvailability()).toEqual({ configured: true })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/borealis/v1/reports')
    expect(init.method).toBe('GET')
    expect(new Headers(init.headers).get('X-Borealis-Request')).toBeNull()
  })

  it('keeps the shared request error shape for other endpoints', async () => {
    stubFetch(Response.json({ error: 'Sign in to your Borealis account.' }, { status: 401 }))
    await expect(apiRequest('/me/apps')).rejects.toBeInstanceOf(ApiError)
  })
})
