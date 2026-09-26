import { createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBorealisApp } from './app.js'
import { BorealisDatabase } from './db.js'
import type { BorealisConfig } from './config.js'
import { sha256Hex } from './crypto.js'
import type { AccountSummary } from '../shared/api.js'

const API = '/api/borealis/v1'
const PASSWORD = 'borealis test passphrase only'
const NEW_PASSWORD = 'a different test passphrase only'
const config: BorealisConfig = {
  adminToken: 'fixture-owner-setup-token-not-a-secret', databasePath: ':memory:',
  publicBaseUrl: 'https://borealis.test', port: 8787, pairingTtlMinutes: 10,
  jobTtlSeconds: 900, playLanguage: 'en', playCountry: 'us',
}
const cookie = (response: Response) => response.headers.get('set-cookie')!.split(';')[0]!

describe('username and password accounts', () => {
  let database: BorealisDatabase
  let app: Awaited<ReturnType<typeof createBorealisApp>>
  let now: Date
  let address: string
  beforeEach(async () => {
    now = new Date('2026-09-25T12:00:00.000Z')
    address = 'fixture-peer'
    database = new BorealisDatabase(createClient({ url: ':memory:' }))
    await database.migrate()
    app = await createBorealisApp({ config, database, playSearch: { async search() { return [] } }, clock: () => now, clientAddress: () => address })
  })
  afterEach(() => database.close())
  function request(path: string, body?: unknown, session?: string, extra: Record<string, string> = {}) {
    return app.request(`https://borealis.test${API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Borealis-Request': '1', Origin: 'https://borealis.test', ...(session ? { Cookie: session } : {}), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  it('signs up without email, hashes credentials, uses a secure cookie, and resumes after refresh', async () => {
    expect(await (await request('/auth/session')).json()).toMatchObject({ account: null, bootstrapAvailable: true })
    const signup = await request('/auth/signup', { username: '  Quiet_Phone  ', password: PASSWORD })
    expect(signup.status).toBe(201)
    const body = await signup.json() as { account: AccountSummary }
    expect(body).toEqual({ account: { id: expect.any(String), username: 'quiet_phone', role: 'member', createdAt: now.toISOString() } })
    expect(signup.headers.get('cache-control')).toBe('no-store')
    const header = signup.headers.get('set-cookie')!
    expect(header).toContain('__Host-borealis_session=')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Strict')
    expect(header).toContain('Path=/')
    expect(header).not.toContain('Domain=')
    const session = cookie(signup)
    expect(await (await request('/auth/session', undefined, session)).json()).toMatchObject(body)
    const stored = (await database.client.execute('SELECT * FROM accounts')).rows[0]!
    expect(stored.password_hash).not.toBe(PASSWORD)
    expect(stored.password_hash).toMatch(/^scrypt\$/)
    const storedSession = (await database.client.execute('SELECT * FROM account_sessions')).rows[0]!
    expect(storedSession.digest).toBe(sha256Hex(session.split('=')[1]!))
    expect(Object.keys(stored)).not.toContain('email')
    expect((await request('/auth/signin', { username: 'QUIET_PHONE', password: PASSWORD })).status).toBe(200)
  })

  it('rejects duplicates, invalid usernames, short passwords, and unexpected email or role fields', async () => {
    expect((await request('/auth/signup', { username: 'duplicate', password: PASSWORD })).status).toBe(201)
    expect((await request('/auth/signup', { username: 'DUPLICATE', password: PASSWORD })).status).toBe(409)
    expect((await request('/auth/signup', { username: 'bad@email.test', password: PASSWORD })).status).toBe(400)
    expect((await request('/auth/signup', { username: 'new_user', password: 'short' })).status).toBe(400)
    expect((await request('/auth/signup', { username: 'new_user', password: PASSWORD, role: 'curator' })).status).toBe(400)
    address = 'email-field-validation-peer'
    expect((await request('/auth/signup', { username: 'new_user', password: PASSWORD, email: 'not@stored.test' })).status).toBe(400)
  })

  it('returns the same credential failure for wrong passwords and unknown usernames', async () => {
    await request('/auth/signup', { username: 'member', password: PASSWORD })
    const wrong = await request('/auth/signin', { username: 'member', password: 'wrong password value' })
    const absent = await request('/auth/signin', { username: 'unknown', password: 'wrong password value' })
    expect(wrong.status).toBe(401)
    expect(absent.status).toBe(401)
    expect(await wrong.json()).toEqual(await absent.json())
    expect(wrong.headers.get('set-cookie')).toBeNull()
  })

  it('revokes sessions on signout and expires them on the server after 30 days', async () => {
    const signup = await request('/auth/signup', { username: 'member', password: PASSWORD })
    const first = cookie(signup)
    const login = await request('/auth/signin', { username: 'member', password: PASSWORD })
    const second = cookie(login)
    expect(first).not.toBe(second)
    expect((await request('/auth/signout', {}, first)).status).toBe(200)
    expect(await (await request('/auth/session', undefined, first)).json()).toMatchObject({ account: null })
    expect(await (await request('/auth/session', undefined, second)).json()).toMatchObject({ account: { username: 'member' } })
    now = new Date(now.getTime() + 30 * 86400_000)
    expect(await (await request('/auth/session', undefined, second)).json()).toMatchObject({ account: null })
  })

  it('requires the current password and invalidates every old session when changed', async () => {
    const first = cookie(await request('/auth/signup', { username: 'member', password: PASSWORD }))
    const second = cookie(await request('/auth/signin', { username: 'member', password: PASSWORD }))
    const wrong = await request('/auth/change-password', { currentPassword: 'wrong', newPassword: NEW_PASSWORD }, first)
    expect(wrong.status).toBe(400)
    const changed = await request('/auth/change-password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, first)
    expect(changed.status).toBe(200)
    const replacement = cookie(changed)
    for (const old of [first, second]) expect(await (await request('/auth/session', undefined, old)).json()).toMatchObject({ account: null })
    expect(await (await request('/auth/session', undefined, replacement)).json()).toMatchObject({ account: { username: 'member' } })
    expect((await request('/auth/signin', { username: 'member', password: PASSWORD })).status).toBe(401)
    expect((await request('/auth/signin', { username: 'member', password: NEW_PASSWORD })).status).toBe(200)
  })

  it('blocks cross-origin and missing-header browser mutations, including login CSRF', async () => {
    for (const headers of [{ Origin: 'https://attacker.test' }, { 'X-Borealis-Request': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const response = await request('/auth/signup', { username: 'member', password: PASSWORD }, undefined, headers)
      expect(response.status).toBe(403)
    }
    expect((await request('/auth/signin', {}, undefined, { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM accounts')).rows[0]!.count).toBe(0)
  })

  it('limits attempts durably even when app instances change and ignores spoofed forwarding headers', async () => {
    for (let index = 0; index < 5; index++) {
      expect((await request('/auth/signup', {}, undefined, { 'X-Forwarded-For': `spoof-${index}` })).status).toBe(400)
    }
    app = await createBorealisApp({ config, database, playSearch: { async search() { return [] } }, clock: () => now, clientAddress: () => address })
    const limited = await request('/auth/signup', { username: 'member', password: PASSWORD })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('3600')
    address = 'another-real-peer'
    expect((await request('/auth/signup', { username: 'member', password: PASSWORD })).status).toBe(201)
    address = 'fixture-peer'
    now = new Date(now.getTime() + 3600_000)
    expect((await request('/auth/signup', { username: 'second', password: PASSWORD })).status).toBe(201)
  })

  it('does not let public signup claim ownership or grant curator privileges', async () => {
    const publicSignup = await request('/auth/signup', { username: 'first_member', password: PASSWORD })
    expect(await publicSignup.json()).toMatchObject({ account: { role: 'member' } })
    const badSetup = await request('/auth/bootstrap', { username: 'owner', password: PASSWORD, adminToken: 'wrong' })
    expect(badSetup.status).toBe(401)
    const setup = await request('/auth/bootstrap', { username: 'owner', password: PASSWORD, adminToken: config.adminToken })
    expect(setup.status).toBe(201)
    expect(await setup.json()).toMatchObject({ account: { role: 'curator' } })
    expect((await request('/auth/bootstrap', { username: 'owner_again', password: PASSWORD, adminToken: config.adminToken })).status).toBe(409)
    expect(await (await request('/auth/session')).json()).toMatchObject({ bootstrapAvailable: false })
    const legacy = await app.request(`${API}/admin/allowlist`, { headers: { Authorization: `Bearer ${config.adminToken}` } })
    expect(legacy.status).toBe(401)
  })
})
