import { createHash, createPublicKey, verify } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BorealisConfig } from './config.js'
import { BorealisDatabase } from './db.js'
import { createBorealisApp } from './app.js'
import type { PlaySearchProvider } from './play-search.js'

const API = '/api/borealis/v1'
const ADMIN_TOKEN = 'test-admin-token-that-is-long-enough'
const DEVICE_BEARER = `brl_device_${Buffer.alloc(32, 7).toString('base64url')}`
const DEVICE_DIGEST = createHash('sha256').update(DEVICE_BEARER).digest('hex')
const SIGNER = 'a'.repeat(64)

const config: BorealisConfig = {
  adminToken: ADMIN_TOKEN,
  databasePath: ':memory:',
  publicBaseUrl: 'https://borealis.test',
  port: 8787,
  pairingTtlMinutes: 10,
  jobTtlSeconds: 900,
  playLanguage: 'en',
  playCountry: 'us',
}

const playSearch: PlaySearchProvider = {
  async search(query, limit) {
    return [{
      packageName: 'com.example.bank',
      displayName: `Result for ${query}`,
      publisher: 'Example Financial',
      detailUrl: 'https://play.google.com/store/apps/details?id=com.example.bank',
    }].slice(0, limit)
  },
}

function adminHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    'Content-Type': 'application/json',
  }
}

function deviceHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${DEVICE_BEARER}`,
    'Content-Type': 'application/json',
  }
}

describe('Borealis API', () => {
  let database: BorealisDatabase
  let app: ReturnType<typeof createBorealisApp>

  beforeEach(() => {
    database = new BorealisDatabase(':memory:')
    app = createBorealisApp({
      config,
      database,
      playSearch,
      clock: () => new Date('2026-09-25T12:00:00.000Z'),
    })
  })

  afterEach(() => database.close())

  it('exposes health and fixture-backed catalog search without admin auth', async () => {
    const health = await app.request(`${API}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok', service: 'borealis' })

    const search = await app.request(`${API}/catalog/search?q=bank&limit=4`)
    expect(search.status).toBe(200)
    expect(await search.json()).toMatchObject({
      query: 'bank',
      results: [{ packageName: 'com.example.bank' }],
    })
  })

  it('rejects admin routes without the configured bearer token', async () => {
    const response = await app.request(`${API}/admin/allowlist`)
    expect(response.status).toBe(401)
  })

  it('pairs a device, signs exact job bytes, and requires signer review before install', async () => {
    const pairingResponse = await app.request(`${API}/pairings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceLabel: 'Gav’s Light Phone', deviceBearerDigest: DEVICE_DIGEST }),
    })
    expect(pairingResponse.status).toBe(201)
    const pairing = await pairingResponse.json() as {
      pairingId: string
      userCode: string
      pollSecret: string
    }

    const pendingResponse = await app.request(`${API}/pairings/${pairing.pairingId}`, {
      headers: { Authorization: `Bearer ${pairing.pollSecret}` },
    })
    expect(await pendingResponse.json()).toMatchObject({ state: 'pending' })

    const approvalResponse = await app.request(`${API}/admin/pairings/approve`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ userCode: pairing.userCode }),
    })
    expect(approvalResponse.status).toBe(200)
    const approval = await approvalResponse.json() as { device: { id: string } }

    const activationResponse = await app.request(`${API}/pairings/${pairing.pairingId}/activate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.pollSecret}` },
    })
    expect(activationResponse.status).toBe(200)
    const activation = await activationResponse.json() as {
      deviceId: string
      keyId: string
      signingPublicKey: string
    }
    expect(activation.deviceId).toBe(approval.device.id)

    const allowResponse = await app.request(`${API}/admin/allowlist`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        packageName: 'com.example.bank',
        displayName: 'Example Bank',
        publisher: 'Example Financial',
        reason: 'Card controls required away from home.',
      }),
    })
    expect(allowResponse.status).toBe(201)

    const assignResponse = await app.request(`${API}/admin/devices/${activation.deviceId}/assignments`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ packageName: 'com.example.bank' }),
    })
    expect(assignResponse.status).toBe(201)

    const syncResponse = await app.request(`${API}/device/sync`, { headers: deviceHeaders() })
    expect(syncResponse.status).toBe(200)
    const sync = await syncResponse.json() as {
      jobs: Array<{ keyId: string; payload: string; signature: string }>
    }
    expect(sync.jobs).toHaveLength(1)
    const envelope = sync.jobs[0]!
    const publicKey = createPublicKey({
      key: Buffer.from(activation.signingPublicKey, 'base64url'),
      type: 'spki',
      format: 'der',
    })
    expect(verify(null, Buffer.from(envelope.payload, 'utf8'), publicKey, Buffer.from(envelope.signature, 'base64url'))).toBe(true)
    const payload = JSON.parse(envelope.payload) as { jobId: string; acceptedSignerSha256: string[]; deviceId: string }
    expect(envelope.keyId).toBe(activation.keyId)
    expect(payload).toMatchObject({
      schemaVersion: 1,
      deviceId: activation.deviceId,
      action: 'install_or_update',
      packageName: 'com.example.bank',
      acceptedSignerSha256: [],
    })

    const prematureSuccess = await app.request(`${API}/device/jobs/${payload.jobId}/report`, {
      method: 'POST',
      headers: deviceHeaders(),
      body: JSON.stringify({ status: 'succeeded', installedVersionCode: 42 }),
    })
    expect(prematureSuccess.status).toBe(409)

    const review = await app.request(`${API}/device/jobs/${payload.jobId}/report`, {
      method: 'POST',
      headers: deviceHeaders(),
      body: JSON.stringify({ status: 'review_required', observedSignerSha256: [SIGNER] }),
    })
    expect(review.status).toBe(200)

    const jobsResponse = await app.request(`${API}/admin/devices/${activation.deviceId}/jobs`, {
      headers: adminHeaders(),
    })
    expect(await jobsResponse.json()).toMatchObject({
      jobs: [{ status: 'review_required', observedSignerSha256: [SIGNER] }],
    })

    const pinResponse = await app.request(`${API}/admin/allowlist/com.example.bank`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({
        displayName: 'Example Bank',
        publisher: 'Example Financial',
        reason: 'Card controls required away from home.',
        signerSha256: SIGNER,
      }),
    })
    expect(pinResponse.status).toBe(200)

    const requeueResponse = await app.request(`${API}/admin/devices/${activation.deviceId}/jobs`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ packageName: 'com.example.bank' }),
    })
    expect(requeueResponse.status).toBe(201)

    const pinnedSyncResponse = await app.request(`${API}/device/sync`, { headers: deviceHeaders() })
    const pinnedSync = await pinnedSyncResponse.json() as { jobs: Array<{ payload: string }> }
    const pinnedPayload = JSON.parse(pinnedSync.jobs[0]!.payload) as { acceptedSignerSha256: string[] }
    expect(pinnedPayload.acceptedSignerSha256).toEqual([SIGNER])
  })
})
