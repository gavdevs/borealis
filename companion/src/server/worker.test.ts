import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSigningKey } from './crypto.js'
import { BorealisDatabase } from './db.js'
import { fetchBorealisWorker, trustedCloudflareClientAddress } from './worker.js'

const libsql = vi.hoisted(() => ({ createClient: vi.fn() }))

vi.mock('@libsql/client/web', () => ({ createClient: libsql.createClient }))

const signingKey = generateSigningKey()

type WorkerEnvironment = Parameters<typeof fetchBorealisWorker>[1]

describe('Cloudflare Worker adapter', () => {
  let close: ReturnType<typeof vi.fn>
  let assetFetch: ReturnType<typeof vi.fn>
  let rateLimit: ReturnType<typeof vi.fn>
  let getSigningKey: ReturnType<typeof vi.spyOn>
  let getOrCreateSigningKey: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    close = vi.fn()
    assetFetch = vi.fn(async () => new Response('asset', { status: 200 }))
    rateLimit = vi.fn(async () => ({ success: true }))
    libsql.createClient.mockReturnValue({ close })
    getSigningKey = vi.spyOn(BorealisDatabase.prototype, 'getSigningKey').mockResolvedValue(signingKey)
    getOrCreateSigningKey = vi.spyOn(BorealisDatabase.prototype, 'getOrCreateSigningKey')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    libsql.createClient.mockReset()
  })

  it('serves non-API requests from the static asset binding without touching runtime services', async () => {
    const request = new Request('https://borealis.loosewire.dev/settings')

    const response = await fetchBorealisWorker(request, environment())

    expect(await response.text()).toBe('asset')
    expect(assetFetch).toHaveBeenCalledWith(request)
    expect(rateLimit).not.toHaveBeenCalled()
    expect(libsql.createClient).not.toHaveBeenCalled()
  })

  it('rejects API requests without Cloudflare trusted client metadata before the limiter or database', async () => {
    const response = await fetchBorealisWorker(apiRequest('/health'), environment())

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'A trusted Cloudflare client address is required.' })
    expect(rateLimit).not.toHaveBeenCalled()
    expect(libsql.createClient).not.toHaveBeenCalled()
  })

  it('returns a retryable response when the edge limiter rejects the client before opening a database', async () => {
    rateLimit.mockResolvedValue({ success: false })

    const response = await fetchBorealisWorker(apiRequest('/health', '203.0.113.10'), environment())

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(rateLimit).toHaveBeenCalledWith({ key: '203.0.113.10' })
    expect(libsql.createClient).not.toHaveBeenCalled()
  })

  it('opens one web client per API request and uses only the existing signing key', async () => {
    const response = await fetchBorealisWorker(apiRequest('/health', '2001:db8::1'), environment())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'borealis' })
    expect(rateLimit).toHaveBeenCalledWith({ key: '2001:db8::1' })
    expect(libsql.createClient).toHaveBeenCalledOnce()
    expect(libsql.createClient).toHaveBeenCalledWith({
      url: 'libsql://borealis.example.turso.io',
      authToken: 'fixture-token',
    })
    expect(getSigningKey).toHaveBeenCalledOnce()
    expect(getOrCreateSigningKey).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('fails closed when the deliberate migration has not created a signing key', async () => {
    getSigningKey.mockResolvedValue(null)

    const response = await fetchBorealisWorker(apiRequest('/health', '203.0.113.10'), environment())

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('5')
    expect(await response.json()).toEqual({
      error: 'Borealis has not been initialized. Run the database migration before deploying.',
    })
    expect(getOrCreateSigningKey).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps unknown API routes in the API and returns JSON instead of the SPA shell', async () => {
    const response = await fetchBorealisWorker(apiRequest('/unknown', '203.0.113.10'), environment())

    expect(response.status).toBe(404)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'Not found.' })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(assetFetch).not.toHaveBeenCalled()
  })

  it('recognizes the exact /api boundary as API traffic', async () => {
    const request = new Request('https://borealis.loosewire.dev/api', {
      headers: { 'CF-Connecting-IP': '203.0.113.10' },
    })

    const response = await fetchBorealisWorker(request, environment())

    expect(response.status).toBe(404)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(assetFetch).not.toHaveBeenCalled()
  })

  it('accepts bounded Cloudflare addresses and rejects missing or oversized values', () => {
    expect(trustedCloudflareClientAddress(new Request('https://example.test', {
      headers: { 'CF-Connecting-IP': ' 203.0.113.10 ' },
    }))).toBe('203.0.113.10')
    expect(trustedCloudflareClientAddress(new Request('https://example.test'))).toBeNull()
    expect(trustedCloudflareClientAddress(new Request('https://example.test', {
      headers: { 'CF-Connecting-IP': '1'.repeat(46) },
    }))).toBeNull()
  })

  function environment(): WorkerEnvironment {
    return {
      API_RATE_LIMIT: { limit: rateLimit },
      ASSETS: { fetch: assetFetch },
      BOREALIS_PUBLIC_BASE_URL: 'https://borealis.loosewire.dev',
      BOREALIS_PAIRING_TTL_MINUTES: '10',
      BOREALIS_JOB_TTL_SECONDS: '900',
      BOREALIS_PLAY_LANGUAGE: 'en',
      BOREALIS_PLAY_COUNTRY: 'us',
      BOREALIS_ADMIN_TOKEN: 'test-admin-token-that-is-long-enough',
      TURSO_DATABASE_URL: 'libsql://borealis.example.turso.io',
      TURSO_AUTH_TOKEN: 'fixture-token',
    } as WorkerEnvironment
  }
})

function apiRequest(path: string, clientAddress?: string): Request {
  return new Request(`https://borealis.loosewire.dev/api/borealis/v1${path}`, {
    headers: clientAddress ? { 'CF-Connecting-IP': clientAddress } : undefined,
  })
}
