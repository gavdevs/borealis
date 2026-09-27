import { createHash, createPublicKey, verify } from 'node:crypto'
import { createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BorealisConfig } from './config.js'
import { BorealisDatabase } from './db.js'
import { createBorealisApp } from './app.js'
import type { PlayAppDetails, PlaySearchProvider } from './play-search.js'
import type { InstallJobPayload, SignedJobEnvelope } from '../shared/api.js'

const API = '/api/borealis/v1'
const PASSWORD = 'fixture account passphrase'
const PACKAGE = 'com.example.bank'
const NOW = '2026-09-25T12:00:00.000Z'
const config: BorealisConfig = {
  adminToken: 'test-admin-token-that-is-long-enough', databasePath: ':memory:',
  publicBaseUrl: 'https://borealis.test', port: 8787, pairingTtlMinutes: 10,
  jobTtlSeconds: 900, playLanguage: 'en', playCountry: 'us',
}
const metadata: PlayAppDetails = {
  packageName: PACKAGE, displayName: 'Example Bank', publisher: 'Example Financial',
  detailUrl: `https://play.google.com/store/apps/details?id=${PACKAGE}`,
  category: 'FINANCE', description: 'Card controls and email notifications. Open browser help if needed.',
}
type App = Awaited<ReturnType<typeof createBorealisApp>>
type Phone = { deviceId: string; signingPublicKey: string; bearer: string }

describe('Borealis personal-library API', () => {
  let database: BorealisDatabase
  let app: App
  let alice: string
  let playSearch: PlaySearchProvider
  let phoneCount: number

  beforeEach(async () => {
    database = new BorealisDatabase(createClient({ url: ':memory:' }))
    await database.migrate()
    playSearch = {
      search: vi.fn(async () => [metadata]),
      details: vi.fn(async (packageName) => packageName === PACKAGE ? metadata : null),
    }
    app = await createBorealisApp({ config, database, playSearch, clock: () => new Date(NOW), clientAddress: () => 'fixture-peer' })
    phoneCount = 0
    alice = await signup('alice')
  })
  afterEach(() => database.close())

  function request(path: string, session?: string, body?: unknown, method?: string) {
    return app.request(`${API}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(session ? { Cookie: session } : {}), 'Content-Type': 'application/json',
        'X-Borealis-Request': '1', Origin: config.publicBaseUrl,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  async function signup(username: string) {
    const response = await request('/auth/signup', undefined, { username, password: PASSWORD })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ account: { role: 'member' } })
    return response.headers.getSetCookie().find((cookie) => cookie.startsWith('__Host-borealis_session='))!.split(';')[0]!
  }
  async function pair(session = alice): Promise<Phone> {
    const bearer = `brl_device_${Buffer.alloc(32, ++phoneCount).toString('base64url')}`
    const created = await request('/pairings', undefined, {
      deviceLabel: 'Light Phone', deviceBearerDigest: createHash('sha256').update(bearer).digest('hex'),
    })
    expect(created.status).toBe(201)
    const pairing = await created.json() as { pairingId: string; userCode: string; pollSecret: string }
    const approved = await request('/me/pairings/approve', session, { userCode: pairing.userCode })
    expect(approved.status).toBe(200)
    const activated = await app.request(`${API}/pairings/${pairing.pairingId}/activate`, {
      method: 'POST', headers: { Authorization: `Bearer ${pairing.pollSecret}` },
    })
    expect(activated.status).toBe(200)
    return { ...await activated.json() as { deviceId: string; signingPublicKey: string }, bearer }
  }
  function phoneRequest(phone: Phone, path: string, body?: unknown) {
    return app.request(`${API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${phone.bearer}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  async function add(session = alice) {
    const response = await request('/me/apps', session, { packageName: PACKAGE })
    expect(response.status).toBe(201)
  }
  async function job(phone: Phone) {
    const response = await phoneRequest(phone, `/device/library/${PACKAGE}/job`, {})
    expect(response.status).toBe(200)
    const { job: envelope } = await response.json() as { job: SignedJobEnvelope }
    const publicKey = createPublicKey({ key: Buffer.from(phone.signingPublicKey, 'base64url'), format: 'der', type: 'spki' })
    expect(verify(null, Buffer.from(envelope.payload), publicKey, Buffer.from(envelope.signature, 'base64url'))).toBe(true)
    return JSON.parse(envelope.payload) as InstallJobPayload
  }

  it('keeps health public, requires search authentication, and removes curator/bootstrap endpoints', async () => {
    expect((await request('/health')).status).toBe(200)
    expect((await request('/catalog/search?q=bank')).status).toBe(401)
    expect((await request('/admin/allowlist', alice)).status).toBe(404)
    expect((await request('/admin/allowlist', alice, metadata)).status).toBe(404)
    expect((await request('/auth/bootstrap', alice, { username: 'owner', password: PASSWORD, adminToken: config.adminToken })).status).toBe(404)
    expect(await (await request('/auth/session', alice)).json()).not.toHaveProperty('bootstrapAvailable')
  })

  it('searches canonical policy-eligible Play apps for ordinary accounts and does not use an approval catalog', async () => {
    expect(await database.listAllowlist()).toEqual([])
    const response = await request('/catalog/search?q=bank', alice)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ results: [{ packageName: PACKAGE, displayName: metadata.displayName }] })
    expect(playSearch.search).toHaveBeenCalledWith('bank', 12)
    expect(playSearch.details).toHaveBeenCalledWith(PACKAGE)
  })

  it('rejects client-supplied metadata and uses official details for additions', async () => {
    expect((await request('/me/apps', alice, { packageName: PACKAGE, category: 'FINANCE' })).status).toBe(400)
    expect((await request('/me/apps', alice, { packageName: 'com.example.missing' })).status).toBe(404)
    await add()
    expect(await (await request('/me/apps', alice)).json()).toMatchObject({ items: [{ displayName: metadata.displayName, publisher: metadata.publisher }] })
    await add()
    expect((await (await request('/me/apps', alice)).json() as { items: unknown[] }).items).toHaveLength(1)
  })

  it('makes canonical Lifestyle tools such as Hatch Sleep available to any account without a package approval', async () => {
    const hatch = { ...metadata, packageName: 'com.hatchbaby.rest', displayName: 'Hatch Sleep', category: 'LIFESTYLE' }
    vi.mocked(playSearch.search).mockResolvedValue([hatch])
    vi.mocked(playSearch.details).mockResolvedValue(hatch)
    const bob = await signup('bob')
    for (const session of [alice, bob]) {
      expect(await (await request('/catalog/search?q=hatch', session)).json()).toMatchObject({ results: [{ packageName: hatch.packageName }] })
      expect((await request('/me/apps', session, { packageName: hatch.packageName })).status).toBe(201)
      expect(await (await request('/me/apps', session)).json()).toMatchObject({ items: [{ packageName: hatch.packageName }] })
    }
  })

  it.each([
    ['SOCIAL', 'Social Feed', 'com.example.social'], ['GAME_PUZZLE', 'Puzzle', 'com.example.game'],
    ['ENTERTAINMENT', 'Videos', 'com.example.video'], ['PRODUCTIVITY', 'Gmail', 'com.google.android.gm'],
    ['PRODUCTIVITY', 'Microsoft Outlook', 'com.microsoft.office.outlook'], ['TOOLS', 'Quiet Browser', 'com.example.browser'],
    ['UNKNOWN', 'Mystery App', 'com.example.mystery'],
  ])('excludes %s / %s from search and direct package additions', async (category, displayName, packageName) => {
    const blocked = { ...metadata, category, displayName, packageName }
    vi.mocked(playSearch.search).mockResolvedValue([blocked])
    vi.mocked(playSearch.details).mockResolvedValue(blocked)
    expect(await (await request('/catalog/search?q=app', alice)).json()).toMatchObject({ results: [] })
    const response = await request('/me/apps', alice, { packageName })
    expect(response.status).toBe(403)
    expect(await response.json()).toHaveProperty('error', expect.stringMatching(/not available/))
    expect(await database.listAllowlist()).toEqual([])
  })

  it('fails closed with a helpful error when metadata cannot be verified', async () => {
    vi.mocked(playSearch.details).mockRejectedValue(new Error('private upstream detail'))
    const response = await request('/me/apps', alice, { packageName: PACKAGE })
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('private upstream detail')
    const search = await request('/catalog/search?q=bank', alice)
    expect(search.status).toBe(502)
    expect(await search.text()).not.toContain('private upstream detail')
  })

  it('skips an unavailable search candidate without losing other eligible results', async () => {
    vi.mocked(playSearch.search).mockResolvedValue([{ ...metadata, packageName: 'com.example.missing' }, metadata])
    vi.mocked(playSearch.details).mockImplementation(async (packageName) => {
      if (packageName !== PACKAGE) throw new Error('unavailable')
      return metadata
    })
    expect(await (await request('/catalog/search?q=bank', alice)).json()).toMatchObject({ results: [{ packageName: PACKAGE }] })
  })

  it('caps detail work at eight candidates and excludes obvious browser identities before fetching details', async () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({ ...metadata, packageName: `com.example.bank${index}` }))
    vi.mocked(playSearch.search).mockResolvedValue([{ ...metadata, packageName: 'com.android.chrome', displayName: 'Chrome' }, ...candidates])
    vi.mocked(playSearch.details).mockImplementation(async (packageName) => ({ ...metadata, packageName }))
    const result = await request('/catalog/search?q=bank&limit=20', alice)
    expect(result.status).toBe(200)
    expect(playSearch.details).toHaveBeenCalledTimes(8)
    expect(playSearch.details).not.toHaveBeenCalledWith('com.android.chrome')
    expect((await result.json() as { results: unknown[] }).results).toHaveLength(8)
  })

  it('makes additions available to every owned phone, including phones paired later, without assignments or jobs', async () => {
    const first = await pair()
    await add()
    const second = await pair()
    for (const phone of [first, second]) {
      const sync = await phoneRequest(phone, '/device/sync')
      expect(await sync.json()).toMatchObject({ library: [{ packageName: PACKAGE, displayName: metadata.displayName }], jobs: [] })
      expect(await database.listJobs(phone.deviceId)).toEqual([])
      expect((await request(`/me/devices/${phone.deviceId}/assignments`, alice)).status).toBe(404)
    }
  })

  it('signs first-install jobs without publisher review, reuses active work, and preserves library after success', async () => {
    await add()
    const phone = await pair()
    const payloads = await Promise.all([job(phone), job(phone)])
    expect(payloads[0]!.jobId).toBe(payloads[1]!.jobId)
    const payload = payloads[0]!
    expect(payload).toMatchObject({ deviceId: phone.deviceId, packageName: PACKAGE, acceptedSignerSha256: [], schemaVersion: 1 })
    const report = await phoneRequest(phone, `/device/jobs/${payload.jobId}/report`, {
      status: 'succeeded', installedVersionCode: 42, observedSignerSha256: ['a'.repeat(64)],
    })
    expect(report.status).toBe(200)
    for (let i = 0; i < 2; i++) {
      expect(await (await phoneRequest(phone, '/device/sync')).json()).toMatchObject({ library: [{ packageName: PACKAGE }], jobs: [] })
    }
    expect(await database.listJobs(phone.deviceId)).toHaveLength(1)
    expect((await job(phone)).jobId).not.toBe(payload.jobId)
    expect(await database.listJobs(phone.deviceId)).toHaveLength(2)
  })

  it('preserves historical publisher-review failures while letting the phone request a fresh install', async () => {
    await add()
    const phone = await pair()
    const old = await job(phone)
    expect((await phoneRequest(phone, `/device/jobs/${old.jobId}/report`, {
      status: 'review_required', observedSignerSha256: ['a'.repeat(64)], message: 'Legacy publisher review.',
    })).status).toBe(200)
    const fresh = await job(phone)
    expect(fresh.jobId).not.toBe(old.jobId)
    expect(fresh.acceptedSignerSha256).toEqual([])
    const jobs = await database.listJobs(phone.deviceId)
    expect(jobs).toHaveLength(2)
    expect(jobs.find((item) => item.id === old.jobId)?.status).toBe('review_required')
  })

  it('enforces account and device isolation for libraries, jobs, reports, and phone management', async () => {
    const bob = await signup('bob')
    const alicePhone = await pair()
    const bobPhone = await pair(bob)
    await add()
    expect(await (await request('/me/apps', bob)).json()).toEqual({ items: [] })
    expect(await (await phoneRequest(bobPhone, '/device/sync')).json()).toMatchObject({ library: [], jobs: [] })
    expect((await phoneRequest(bobPhone, `/device/library/${PACKAGE}/job`, {})).status).toBe(404)
    const aliceJob = await job(alicePhone)
    expect((await phoneRequest(bobPhone, `/device/jobs/${aliceJob.jobId}/report`, { status: 'failed' })).status).toBe(404)
    expect((await request(`/me/devices/${alicePhone.deviceId}/jobs`, bob)).status).toBe(404)
    expect((await request(`/me/devices/${alicePhone.deviceId}/jobs`, bob, { packageName: PACKAGE })).status).toBe(404)
    expect((await request(`/me/devices/${alicePhone.deviceId}`, bob, undefined, 'DELETE')).status).toBe(404)
    expect((await request(`/me/apps/${PACKAGE}`, bob, undefined, 'DELETE')).status).toBe(404)
  })

  it('removes library permission only from that account and cancels pending jobs without deleting history', async () => {
    const bob = await signup('bob')
    await add()
    await add(bob)
    const alicePhone = await pair()
    const bobPhone = await pair(bob)
    const pending = await job(alicePhone)
    const beforeRemoval = await database.getDevice(alicePhone.deviceId)
    expect((await request(`/me/apps/${PACKAGE}`, alice, undefined, 'DELETE')).status).toBe(200)
    expect(await (await phoneRequest(alicePhone, '/device/sync')).json()).toMatchObject({ library: [], jobs: [] })
    expect((await phoneRequest(alicePhone, `/device/library/${PACKAGE}/job`, {})).status).toBe(404)
    expect(await database.getJob(pending.jobId)).toMatchObject({ status: 'cancelled' })
    expect((await database.getDevice(alicePhone.deviceId))!.revision).toBe(beforeRemoval!.revision + 1)
    expect(await (await phoneRequest(bobPhone, '/device/sync')).json()).toMatchObject({ library: [{ packageName: PACKAGE }] })
  })

  it('rejects revoked/unknown credentials and browser mutations without their CSRF guard', async () => {
    const phone = await pair()
    await add()
    expect((await app.request(`${API}/me/apps`, { method: 'POST', headers: { Cookie: alice, 'Content-Type': 'application/json' }, body: JSON.stringify({ packageName: PACKAGE }) })).status).toBe(403)
    expect((await request(`/me/devices/${phone.deviceId}`, alice, undefined, 'DELETE')).status).toBe(200)
    expect((await phoneRequest(phone, '/device/sync')).status).toBe(401)
    expect((await phoneRequest(phone, `/device/library/${PACKAGE}/job`, {})).status).toBe(401)
  })

  it('lets exactly one account claim a phone when pairing approvals race', async () => {
    const bob = await signup('bob')
    const created = await request('/pairings', undefined, {
      deviceLabel: 'Shared pairing screen', deviceBearerDigest: 'd'.repeat(64),
    })
    const pairing = await created.json() as { userCode: string }
    const responses = await Promise.all([
      request('/me/pairings/approve', alice, { userCode: pairing.userCode }),
      request('/me/pairings/approve', bob, { userCode: pairing.userCode }),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404])
    const aliceDevices = await (await request('/me/devices', alice)).json() as { devices: unknown[] }
    const bobDevices = await (await request('/me/devices', bob)).json() as { devices: unknown[] }
    expect(aliceDevices.devices.length + bobDevices.devices.length).toBe(1)
    expect(await database.listDevices()).toHaveLength(1)
  })
})
