import { createHash, createPublicKey, verify } from 'node:crypto'
import { createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BorealisConfig } from './config.js'
import { BorealisDatabase } from './db.js'
import { createBorealisApp } from './app.js'
import type { PlaySearchProvider } from './play-search.js'

const API = '/api/borealis/v1'
const ADMIN_TOKEN = 'test-admin-token-that-is-long-enough'
const CURATOR_PASSWORD = 'curator password long enough'
const MEMBER_PASSWORD = 'member password long enough'
const DEVICE_BEARER = deviceBearer(7)
const DEVICE_DIGEST = digest(DEVICE_BEARER)
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

type App = Awaited<ReturnType<typeof createBorealisApp>>
type PairingFixture = {
  pairingId: string
  userCode: string
  pollSecret: string
}

describe('Borealis API', () => {
  let database: BorealisDatabase
  let app: App
  let curatorCookie: string

  beforeEach(async () => {
    database = new BorealisDatabase(createClient({ url: ':memory:' }))
    await database.migrate()
    app = await createBorealisApp({
      config,
      database,
      playSearch,
      clock: () => new Date('2026-09-25T12:00:00.000Z'),
      clientAddress: () => 'test-peer',
    })
    curatorCookie = await bootstrapCurator(app)
  })

  afterEach(() => database.close())

  it('keeps health public but requires a session for catalog and rejects the legacy admin bearer', async () => {
    const health = await app.request(`${API}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok', service: 'borealis' })

    const anonymousSearch = await app.request(`${API}/catalog/search?q=bank&limit=4`)
    expect(anonymousSearch.status).toBe(401)

    const search = await app.request(`${API}/catalog/search?q=bank&limit=4`, {
      headers: sessionHeaders(curatorCookie),
    })
    expect(search.status).toBe(200)
    expect(await search.json()).toMatchObject({
      query: 'bank',
      results: [{ packageName: 'com.example.bank', displayName: 'Result for bank' }],
    })

    const legacyAdmin = await app.request(`${API}/admin/allowlist`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(legacyAdmin.status).toBe(401)
  })

  it('limits catalog mutation to curators and gives members only filtered curated results', async () => {
    await createAllowlistItem(app, curatorCookie, {
      packageName: 'com.example.bank',
      displayName: 'Example Bank',
      publisher: 'Example Financial',
      reason: 'Card controls required away from home.',
    })
    await createAllowlistItem(app, curatorCookie, {
      packageName: 'org.example.transit',
      displayName: 'City Transit',
      publisher: 'Transit Authority',
      reason: 'Tickets and live service alerts.',
    })
    const memberCookie = await signUp(app, 'alice')

    const memberSearch = await app.request(`${API}/catalog/search?q=financial&limit=10`, {
      headers: sessionHeaders(memberCookie),
    })
    expect(memberSearch.status).toBe(200)
    expect(await memberSearch.json()).toMatchObject({
      results: [{
        packageName: 'com.example.bank',
        displayName: 'Example Bank',
        publisher: 'Example Financial',
      }],
    })

    const memberMutation = await app.request(`${API}/admin/allowlist`, {
      method: 'POST',
      headers: mutationHeaders(memberCookie),
      body: JSON.stringify({
        packageName: 'com.example.unapproved',
        displayName: 'Unapproved',
        publisher: 'Unknown',
        reason: 'This must not be accepted.',
      }),
    })
    expect(memberMutation.status).toBe(403)

    const missingGuard = await app.request(`${API}/admin/allowlist`, {
      method: 'POST',
      headers: {
        Cookie: curatorCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        packageName: 'com.example.csrf',
        displayName: 'CSRF',
        publisher: 'Unknown',
        reason: 'This request is missing the browser guard.',
      }),
    })
    expect(missingGuard.status).toBe(403)
  })

  it('awaits allowlist writes and returns resolved records from read and delete routes', async () => {
    const item = {
      packageName: 'com.example.bank',
      displayName: 'Example Bank',
      publisher: 'Example Financial',
      reason: 'Card controls required away from home.',
    }
    await createAllowlistItem(app, curatorCookie, item)

    const listed = await app.request(`${API}/admin/allowlist`, { headers: sessionHeaders(curatorCookie) })
    expect(await listed.json()).toMatchObject({ items: [item] })
    const found = await app.request(`${API}/admin/allowlist/${item.packageName}`, {
      headers: sessionHeaders(curatorCookie),
    })
    expect(await found.json()).toMatchObject({ item })

    const duplicate = await app.request(`${API}/admin/allowlist`, {
      method: 'POST',
      headers: mutationHeaders(curatorCookie),
      body: JSON.stringify(item),
    })
    expect(duplicate.status).toBe(409)

    const deleted = await app.request(`${API}/admin/allowlist/${item.packageName}`, {
      method: 'DELETE',
      headers: mutationHeaders(curatorCookie),
      body: JSON.stringify({}),
    })
    expect(deleted.status).toBe(200)
    const missing = await app.request(`${API}/admin/allowlist/${item.packageName}`, {
      headers: sessionHeaders(curatorCookie),
    })
    expect(missing.status).toBe(404)
    const alreadyDeleted = await app.request(`${API}/admin/allowlist/${item.packageName}`, {
      method: 'DELETE',
      headers: mutationHeaders(curatorCookie),
      body: JSON.stringify({}),
    })
    expect(alreadyDeleted.status).toBe(404)
  })

  it('rejects an unknown device instead of treating an asynchronous auth lookup as a device', async () => {
    const response = await app.request(`${API}/device/sync`, { headers: phoneHeaders(DEVICE_BEARER) })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'This device is not active.' })
  })

  it('pairs an owned device, saves the app before assignment, and signs exact job bytes', async () => {
    const pairing = await createPhonePairing(app, 'Gav’s Light Phone', DEVICE_DIGEST)
    const preview = await app.request(`${API}/me/pairings/preview`, {
      method: 'POST',
      headers: mutationHeaders(curatorCookie),
      body: JSON.stringify({ userCode: pairing.userCode }),
    })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ pairing: { deviceLabel: 'Gav’s Light Phone', state: 'pending' } })

    const approvalResponse = await approvePairing(app, curatorCookie, pairing.userCode)
    expect(approvalResponse.status).toBe(200)
    const approval = await approvalResponse.json() as { device: { id: string } }
    const approvedPairings = await app.request(`${API}/me/pairings`, { headers: sessionHeaders(curatorCookie) })
    expect(await approvedPairings.json()).toMatchObject({ pairings: [{ id: pairing.pairingId }] })

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

    await createAllowlistItem(app, curatorCookie, {
      packageName: 'com.example.bank',
      displayName: 'Example Bank',
      publisher: 'Example Financial',
      reason: 'Card controls required away from home.',
    })
    const saved = await app.request(`${API}/me/apps`, {
      method: 'POST',
      headers: mutationHeaders(curatorCookie),
      body: JSON.stringify({ packageName: 'com.example.bank' }),
    })
    expect(saved.status).toBe(201)

    const assignResponse = await app.request(`${API}/me/devices/${activation.deviceId}/assignments`, {
      method: 'POST',
      headers: mutationHeaders(curatorCookie),
      body: JSON.stringify({ packageName: 'com.example.bank' }),
    })
    expect(assignResponse.status).toBe(201)

    const syncResponse = await app.request(`${API}/device/sync`, { headers: phoneHeaders(DEVICE_BEARER) })
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
      headers: phoneJsonHeaders(DEVICE_BEARER),
      body: JSON.stringify({ status: 'succeeded', installedVersionCode: 42 }),
    })
    expect(prematureSuccess.status).toBe(409)

    const review = await app.request(`${API}/device/jobs/${payload.jobId}/report`, {
      method: 'POST',
      headers: phoneJsonHeaders(DEVICE_BEARER),
      body: JSON.stringify({ status: 'review_required', observedSignerSha256: [SIGNER] }),
    })
    expect(review.status).toBe(200)

    const jobsResponse = await app.request(`${API}/me/devices/${activation.deviceId}/jobs`, {
      headers: sessionHeaders(curatorCookie),
    })
    expect(await jobsResponse.json()).toMatchObject({
      jobs: [{ status: 'review_required', observedSignerSha256: [SIGNER] }],
    })

    const pinResponse = await app.request(`${API}/admin/allowlist/com.example.bank`, {
      method: 'PUT',
      headers: mutationHeaders(curatorCookie),
      body: JSON.stringify({
        displayName: 'Example Bank',
        publisher: 'Example Financial',
        reason: 'Card controls required away from home.',
        signerSha256: SIGNER,
      }),
    })
    expect(pinResponse.status).toBe(200)

    const requeueResponse = await app.request(`${API}/me/devices/${activation.deviceId}/jobs`, {
      method: 'POST',
      headers: mutationHeaders(curatorCookie),
      body: JSON.stringify({ packageName: 'com.example.bank' }),
    })
    expect(requeueResponse.status).toBe(201)

    const pinnedSyncResponse = await app.request(`${API}/device/sync`, { headers: phoneHeaders(DEVICE_BEARER) })
    const pinnedSync = await pinnedSyncResponse.json() as { jobs: Array<{ payload: string }> }
    const pinnedPayload = JSON.parse(pinnedSync.jobs[0]!.payload) as { acceptedSignerSha256: string[] }
    expect(pinnedPayload.acceptedSignerSha256).toEqual([SIGNER])

    const devicesResponse = await app.request(`${API}/me/devices`, { headers: sessionHeaders(curatorCookie) })
    expect(await devicesResponse.json()).toMatchObject({ devices: [{ id: activation.deviceId }] })
    const assignmentsResponse = await app.request(`${API}/me/devices/${activation.deviceId}/assignments`, {
      headers: sessionHeaders(curatorCookie),
    })
    expect(await assignmentsResponse.json()).toMatchObject({ assignments: [{ packageName: 'com.example.bank' }] })

    const revokeResponse = await app.request(`${API}/me/devices/${activation.deviceId}`, {
      method: 'DELETE',
      headers: mutationHeaders(curatorCookie),
      body: JSON.stringify({}),
    })
    expect(revokeResponse.status).toBe(200)
    const revokedSyncResponse = await app.request(`${API}/device/sync`, { headers: phoneHeaders(DEVICE_BEARER) })
    expect(revokedSyncResponse.status).toBe(401)
  })

  it('enforces account ownership across apps, pairings, devices, assignments, and jobs', async () => {
    const aliceCookie = await signUp(app, 'alice')
    const bobCookie = await signUp(app, 'bob')
    await createAllowlistItem(app, curatorCookie, {
      packageName: 'com.example.bank',
      displayName: 'Example Bank',
      publisher: 'Example Financial',
      reason: 'Card controls required away from home.',
    })
    const pairing = await createPhonePairing(app, 'Alice Phone', DEVICE_DIGEST)

    const alicePending = await app.request(`${API}/me/pairings`, { headers: sessionHeaders(aliceCookie) })
    const bobPending = await app.request(`${API}/me/pairings`, { headers: sessionHeaders(bobCookie) })
    expect(await alicePending.json()).toEqual({ pairings: [] })
    expect(await bobPending.json()).toEqual({ pairings: [] })

    const approval = await approvePairing(app, aliceCookie, pairing.userCode)
    expect(approval.status).toBe(200)
    const approved = await approval.json() as { device: { id: string } }
    const activated = await app.request(`${API}/pairings/${pairing.pairingId}/activate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.pollSecret}` },
    })
    expect(activated.status).toBe(200)

    const save = await app.request(`${API}/me/apps`, {
      method: 'POST',
      headers: mutationHeaders(aliceCookie),
      body: JSON.stringify({ packageName: 'com.example.bank' }),
    })
    expect(save.status).toBe(201)
    const assigned = await app.request(`${API}/me/devices/${approved.device.id}/assignments`, {
      method: 'POST',
      headers: mutationHeaders(aliceCookie),
      body: JSON.stringify({ packageName: 'com.example.bank' }),
    })
    expect(assigned.status).toBe(201)

    const bobApps = await app.request(`${API}/me/apps`, { headers: sessionHeaders(bobCookie) })
    expect(await bobApps.json()).toEqual({ items: [] })
    const bobDeleteApp = await app.request(`${API}/me/apps/com.example.bank`, {
      method: 'DELETE',
      headers: mutationHeaders(bobCookie),
      body: JSON.stringify({}),
    })
    expect(bobDeleteApp.status).toBe(404)

    const bobPairings = await app.request(`${API}/me/pairings`, { headers: sessionHeaders(bobCookie) })
    expect(await bobPairings.json()).toEqual({ pairings: [] })
    const bobUsedPreview = await app.request(`${API}/me/pairings/preview`, {
      method: 'POST',
      headers: mutationHeaders(bobCookie),
      body: JSON.stringify({ userCode: pairing.userCode }),
    })
    expect(bobUsedPreview.status).toBe(404)

    const bobDevices = await app.request(`${API}/me/devices`, { headers: sessionHeaders(bobCookie) })
    expect(await bobDevices.json()).toEqual({ devices: [] })
    const crossGetAssignments = await app.request(`${API}/me/devices/${approved.device.id}/assignments`, {
      headers: sessionHeaders(bobCookie),
    })
    expect(crossGetAssignments.status).toBe(404)
    const crossAssign = await app.request(`${API}/me/devices/${approved.device.id}/assignments`, {
      method: 'POST',
      headers: mutationHeaders(bobCookie),
      body: JSON.stringify({ packageName: 'com.example.bank' }),
    })
    expect(crossAssign.status).toBe(404)
    const crossRemove = await app.request(`${API}/me/devices/${approved.device.id}/assignments/com.example.bank`, {
      method: 'DELETE',
      headers: mutationHeaders(bobCookie),
      body: JSON.stringify({}),
    })
    expect(crossRemove.status).toBe(404)
    const crossGetJobs = await app.request(`${API}/me/devices/${approved.device.id}/jobs`, {
      headers: sessionHeaders(bobCookie),
    })
    expect(crossGetJobs.status).toBe(404)
    const crossQueue = await app.request(`${API}/me/devices/${approved.device.id}/jobs`, {
      method: 'POST',
      headers: mutationHeaders(bobCookie),
      body: JSON.stringify({ packageName: 'com.example.bank' }),
    })
    expect(crossQueue.status).toBe(404)
    const crossRevoke = await app.request(`${API}/me/devices/${approved.device.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(bobCookie),
      body: JSON.stringify({}),
    })
    expect(crossRevoke.status).toBe(404)

    const aliceDevices = await app.request(`${API}/me/devices`, { headers: sessionHeaders(aliceCookie) })
    expect(await aliceDevices.json()).toMatchObject({ devices: [{ id: approved.device.id }] })
    const aliceApps = await app.request(`${API}/me/apps`, { headers: sessionHeaders(aliceCookie) })
    expect(await aliceApps.json()).toMatchObject({ items: [{ packageName: 'com.example.bank' }] })
  })

  it('lets exactly one account claim a pairing when approvals race', async () => {
    const aliceCookie = await signUp(app, 'alice')
    const bobCookie = await signUp(app, 'bob')
    const pairing = await createPhonePairing(app, 'Race Phone', digest(deviceBearer(9)))

    const [aliceApproval, bobApproval] = await Promise.all([
      approvePairing(app, aliceCookie, pairing.userCode),
      approvePairing(app, bobCookie, pairing.userCode),
    ])
    expect([aliceApproval.status, bobApproval.status].sort()).toEqual([200, 404])

    const winnerCookie = aliceApproval.status === 200 ? aliceCookie : bobCookie
    const loserCookie = aliceApproval.status === 200 ? bobCookie : aliceCookie
    const winnerPairings = await app.request(`${API}/me/pairings`, { headers: sessionHeaders(winnerCookie) })
    const loserPairings = await app.request(`${API}/me/pairings`, { headers: sessionHeaders(loserCookie) })
    expect(await winnerPairings.json()).toMatchObject({ pairings: [{ id: pairing.pairingId }] })
    expect(await loserPairings.json()).toEqual({ pairings: [] })

    const winnerDevices = await app.request(`${API}/me/devices`, { headers: sessionHeaders(winnerCookie) })
    const loserDevices = await app.request(`${API}/me/devices`, { headers: sessionHeaders(loserCookie) })
    expect((await winnerDevices.json() as { devices: unknown[] }).devices).toHaveLength(1)
    expect(await loserDevices.json()).toEqual({ devices: [] })
  })
})

async function bootstrapCurator(app: App): Promise<string> {
  const response = await app.request(`${API}/auth/bootstrap`, {
    method: 'POST',
    headers: anonymousMutationHeaders(),
    body: JSON.stringify({
      adminToken: ADMIN_TOKEN,
      username: 'curator',
      password: CURATOR_PASSWORD,
    }),
  })
  expect(response.status).toBe(201)
  return responseCookie(response)
}

async function signUp(app: App, username: string): Promise<string> {
  const response = await app.request(`${API}/auth/signup`, {
    method: 'POST',
    headers: anonymousMutationHeaders(),
    body: JSON.stringify({ username, password: MEMBER_PASSWORD }),
  })
  expect(response.status).toBe(201)
  return responseCookie(response)
}

async function createAllowlistItem(
  app: App,
  cookie: string,
  item: { packageName: string; displayName: string; publisher: string; reason: string },
): Promise<void> {
  const response = await app.request(`${API}/admin/allowlist`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify(item),
  })
  expect(response.status).toBe(201)
}

async function createPhonePairing(app: App, deviceLabel: string, deviceBearerDigest: string): Promise<PairingFixture> {
  const response = await app.request(`${API}/pairings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceLabel, deviceBearerDigest }),
  })
  expect(response.status).toBe(201)
  return await response.json() as PairingFixture
}

async function approvePairing(app: App, cookie: string, userCode: string): Promise<Response> {
  return await app.request(`${API}/me/pairings/approve`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ userCode }),
  })
}

function responseCookie(response: Response): string {
  const setCookie = response.headers.get('Set-Cookie')
  expect(setCookie).toBeTruthy()
  return setCookie!.split(';', 1)[0]!
}

function anonymousMutationHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Borealis-Request': '1',
  }
}

function mutationHeaders(cookie: string): Record<string, string> {
  return {
    ...anonymousMutationHeaders(),
    Cookie: cookie,
  }
}

function sessionHeaders(cookie: string): Record<string, string> {
  return { Cookie: cookie }
}

function phoneHeaders(bearer: string): Record<string, string> {
  return { Authorization: `Bearer ${bearer}` }
}

function phoneJsonHeaders(bearer: string): Record<string, string> {
  return {
    ...phoneHeaders(bearer),
    'Content-Type': 'application/json',
  }
}

function deviceBearer(seed: number): string {
  return `brl_device_${Buffer.alloc(32, seed).toString('base64url')}`
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
