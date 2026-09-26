import { createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBorealisApp } from './app.js'
import { createAccountAuth } from './better-auth.js'
import { BorealisDatabase } from './db.js'
import type { BorealisConfig } from './config.js'
import { sha256Hex } from './crypto.js'
import { hashPassword as hashLegacyPassword } from './passwords.js'
import type { AccountSummary } from '../shared/api.js'

const API = '/api/borealis/v1'
const PASSWORD = 'borealis test passphrase only'
const NEW_PASSWORD = 'a different test passphrase only'
const config: BorealisConfig = {
  adminToken: 'fixture-owner-setup-token-not-a-secret', databasePath: ':memory:',
  publicBaseUrl: 'https://borealis.test', port: 8787, pairingTtlMinutes: 10,
  jobTtlSeconds: 900, playLanguage: 'en', playCountry: 'us',
}
const cookie = (response: Response) => response.headers.getSetCookie()
  .find((value) => value.startsWith('__Host-borealis_session='))!.split(';')[0]!

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
    expect(stored.password_hash).toBe('better-auth-managed')
    const credential = (await database.client.execute('SELECT * FROM ba_account')).rows[0]!
    expect(credential).toMatchObject({ userId: body.account.id, accountId: body.account.id, providerId: 'credential' })
    expect(typeof credential.password).toBe('string')
    expect(credential.password).not.toBe(PASSWORD)
    expect(credential.password).not.toBe(stored.password_hash)
    const storedSession = (await database.client.execute('SELECT * FROM ba_session')).rows[0]!
    const signedCookieValue = decodeURIComponent(session.slice(session.indexOf('=') + 1))
    expect(signedCookieValue.startsWith(`${storedSession.token}.`)).toBe(true)
    expect(signedCookieValue).not.toBe(storedSession.token)
    const librarySession = await createAccountAuth(config, database).api.getSession({ headers: new Headers({ Cookie: session }) })
    expect(librarySession).toMatchObject({ user: { id: body.account.id, username: 'quiet_phone' }, session: { token: storedSession.token } })
    const sessionLifetime = Date.parse(String(storedSession.expiresAt)) - Date.parse(String(storedSession.createdAt))
    expect(sessionLifetime).toBeGreaterThanOrEqual(30 * 86400_000 - 1_000)
    expect(sessionLifetime).toBeLessThanOrEqual(30 * 86400_000 + 1_000)
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM account_sessions')).rows[0]!.count).toBe(0)
    expect(Object.keys(stored)).not.toContain('email')
    expect((await database.client.execute('SELECT email FROM ba_user')).rows[0]!.email).toBe('quiet_phone@users.borealis.invalid')
    expect(JSON.stringify(body)).not.toContain('@users.borealis.invalid')
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
    expect(absent.headers.get('set-cookie')).toBeNull()
  })

  it('revokes sessions on signout and expires them on the server after 30 days', async () => {
    const signup = await request('/auth/signup', { username: 'member', password: PASSWORD })
    const first = cookie(signup)
    const login = await request('/auth/signin', { username: 'member', password: PASSWORD })
    const second = cookie(login)
    expect(first).not.toBe(second)
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM ba_session')).rows[0]!.count).toBe(2)
    expect((await request('/auth/signout', {}, first)).status).toBe(200)
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM ba_session')).rows[0]!.count).toBe(1)
    expect(await (await request('/auth/session', undefined, first)).json()).toMatchObject({ account: null })
    expect(await (await request('/auth/session', undefined, second)).json()).toMatchObject({ account: { username: 'member' } })
    // Better Auth owns its clock independently of the app's injected rate-limit
    // clock. Expire the real database record rather than mocking global timers.
    await database.client.execute({ sql: 'UPDATE ba_session SET expiresAt = ?', args: [new Date(Date.now() - 1_000).toISOString()] })
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
    expect(replacement).not.toBe(first)
    expect(replacement).not.toBe(second)
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM ba_session')).rows[0]!.count).toBe(1)
    for (const old of [first, second]) expect(await (await request('/auth/session', undefined, old)).json()).toMatchObject({ account: null })
    expect(await (await request('/auth/session', undefined, replacement)).json()).toMatchObject({ account: { username: 'member' } })
    expect((await request('/auth/signin', { username: 'member', password: PASSWORD })).status).toBe(401)
    expect((await request('/auth/signin', { username: 'member', password: NEW_PASSWORD })).status).toBe(200)
  })

  it('rolls back a password change and preserves both sessions when its replacement session cannot be stored', async () => {
    const first = cookie(await request('/auth/signup', { username: 'member', password: PASSWORD }))
    const second = cookie(await request('/auth/signin', { username: 'member', password: PASSWORD }))
    const oldCredentials = (await database.client.execute('SELECT password FROM ba_account')).rows
    const oldSessions = (await database.client.execute('SELECT id, token FROM ba_session ORDER BY id')).rows
    expect(oldSessions).toHaveLength(2)
    await database.client.execute(`CREATE TRIGGER reject_ba_session BEFORE INSERT ON ba_session
      BEGIN SELECT RAISE(ABORT, 'fixture replacement session storage failure'); END`)

    const failed = await request('/auth/change-password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, first)
    expect(failed.status).toBe(503)
    const body = await failed.json() as { error: string }
    expect(body.error).not.toMatch(/password is incorrect/i)
    expect(body.error).not.toContain('fixture replacement session storage failure')
    expect(failed.headers.get('set-cookie')).toBeNull()
    expect((await database.client.execute('SELECT password FROM ba_account')).rows).toEqual(oldCredentials)
    expect((await database.client.execute('SELECT id, token FROM ba_session ORDER BY id')).rows).toEqual(oldSessions)
    for (const session of [first, second]) {
      expect(await (await request('/auth/session', undefined, session)).json()).toMatchObject({ account: { username: 'member' } })
    }

    await database.client.execute('DROP TRIGGER reject_ba_session')
    expect((await request('/auth/signin', { username: 'member', password: NEW_PASSWORD })).status).toBe(401)
    expect((await request('/auth/signin', { username: 'member', password: PASSWORD })).status).toBe(200)
  })

  it('reports session storage failure during sign-in as unavailable rather than incorrect credentials', async () => {
    const session = cookie(await request('/auth/signup', { username: 'member', password: PASSWORD }))
    const oldSessions = (await database.client.execute('SELECT id, token FROM ba_session ORDER BY id')).rows
    await database.client.execute(`CREATE TRIGGER reject_ba_session BEFORE INSERT ON ba_session
      BEGIN SELECT RAISE(ABORT, 'fixture sign-in session storage failure'); END`)

    const failed = await request('/auth/signin', { username: 'member', password: PASSWORD }, session)
    expect(failed.status).toBe(503)
    const body = await failed.json() as { error: string }
    expect(body.error).not.toMatch(/username or password is incorrect/i)
    expect(body.error).not.toContain('fixture sign-in session storage failure')
    expect(failed.headers.get('set-cookie')).toBeNull()
    expect((await database.client.execute('SELECT id, token FROM ba_session ORDER BY id')).rows).toEqual(oldSessions)
    expect(await (await request('/auth/session', undefined, session)).json()).toMatchObject({ account: { username: 'member' } })

    await database.client.execute('DROP TRIGGER reject_ba_session')
    expect((await request('/auth/signin', { username: 'member', password: PASSWORD })).status).toBe(200)
  })

  it('rejects unsigned, tampered, and database-revoked Better Auth session cookies', async () => {
    const session = cookie(await request('/auth/signup', { username: 'member', password: PASSWORD }))
    const storedSession = (await database.client.execute('SELECT token FROM ba_session')).rows[0]!
    const unsigned = `__Host-borealis_session=${storedSession.token}`
    const tampered = `${session}x`
    for (const invalid of [unsigned, tampered]) {
      expect(await (await request('/auth/session', undefined, invalid)).json()).toMatchObject({ account: null })
      expect((await request('/me/apps', undefined, invalid)).status).toBe(401)
    }
    expect((await request('/me/apps', undefined, session)).status).toBe(200)
    await database.client.execute('DELETE FROM ba_session')
    expect(await (await request('/auth/session', undefined, session)).json()).toMatchObject({ account: null })
    expect((await request('/me/apps', undefined, session)).status).toBe(401)
  })

  it('keeps raw Better Auth endpoints private so callers cannot bypass Borealis validation or expose internal aliases', async () => {
    const signup = await request('/auth/signup', { username: 'member', password: PASSWORD })
    const session = cookie(signup)
    const initial = await (await request('/auth/session', undefined, session)).json() as { account: AccountSummary; bootstrapAvailable: boolean }
    for (const path of [
      '/auth/sign-up/email', '/auth/sign-in/email', '/auth/sign-in/username',
      '/auth/request-password-reset', '/auth/reset-password', '/auth/change-email',
      '/auth/update-user', '/auth/delete-user', '/auth/set-password',
    ]) {
      const response = await request(path, {
        username: 'bypassed', email: 'bypassed@users.borealis.invalid',
        password: PASSWORD, role: 'curator', name: 'bypassed',
      }, session)
      expect(response.status, path).toBe(404)
      expect(await response.text()).not.toContain('@users.borealis.invalid')
    }
    for (const path of ['/auth/get-session', '/auth/list-sessions']) {
      expect((await request(path, undefined, session)).status, path).toBe(404)
    }
    expect((await request('/auth/change-password', {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: false,
    }, session)).status).toBe(400)
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM ba_user')).rows[0]!.count).toBe(1)
    expect(await (await request('/auth/session', undefined, session)).json()).toEqual(initial)
    expect(JSON.stringify(initial)).not.toContain('email')
    expect(JSON.stringify(initial)).not.toContain('@users.borealis.invalid')
    const signin = await request('/auth/signin', { username: 'member', password: PASSWORD })
    expect(signin.status).toBe(200)
    expect(await signin.json()).toEqual({ account: initial.account })
  })

  it('migrates legacy credentials without changing password bytes, ownership, roles, or saved apps', async () => {
    const legacyPassword = '  legacy cafe\u0301 passphrase 🌲  '
    const legacyHash = await hashLegacyPassword(legacyPassword)
    const legacyCookie = '__Host-borealis_session=legacy-browser-session'
    const legacyAccount = await database.createAccount({
      id: 'legacy-owner-id', username: 'legacy_owner', passwordHash: legacyHash,
      createdAt: now.toISOString(), sessionDigest: sha256Hex('legacy-browser-session'),
      sessionExpiresAt: new Date(Date.now() + 86400_000).toISOString(), bootstrap: true,
    })
    await database.createAllowlist({
      packageName: 'com.example.bank', displayName: 'Example Bank', publisher: 'Example Financial',
      reason: 'Card controls', signerSha256: 'a'.repeat(64),
    }, now.toISOString())
    await database.addAccountApp('legacy-owner-id', 'com.example.bank', now.toISOString())
    await database.client.execute({
      sql: `INSERT INTO devices (id, label, bearer_digest, created_at, activated_at, owner_account_id)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: ['legacy-phone', 'My Light Phone', 'legacy-device-bearer', now.toISOString(), now.toISOString(), 'legacy-owner-id'],
    })
    const signingKey = await database.getOrCreateSigningKey(now.toISOString())

    await database.migrate()
    await database.migrate()
    expect((await database.client.execute('SELECT password FROM ba_account')).rows).toEqual([{ password: legacyHash }])
    expect((await database.client.execute('SELECT id, username FROM ba_user')).rows).toEqual([{ id: 'legacy-owner-id', username: 'legacy_owner' }])
    expect(await (await request('/auth/session', undefined, legacyCookie)).json()).toMatchObject({ account: null })
    expect((await request('/auth/signin', { username: 'legacy_owner', password: legacyPassword.normalize('NFKC') })).status).toBe(401)
    expect((await request('/auth/signin', { username: 'legacy_owner', password: legacyPassword.trim() })).status).toBe(401)
    const signin = await request('/auth/signin', { username: 'LEGACY_OWNER', password: legacyPassword })
    expect(signin.status).toBe(200)
    expect(await signin.json()).toEqual({ account: legacyAccount })
    const session = cookie(signin)
    expect(await (await request('/me/devices', undefined, session)).json()).toMatchObject({ devices: [{ id: 'legacy-phone' }] })
    expect(await (await request('/me/apps', undefined, session)).json()).toMatchObject({ items: [{ packageName: 'com.example.bank' }] })
    expect((await request('/admin/allowlist', undefined, session)).status).toBe(200)
    expect(await database.authenticateDevice('legacy-device-bearer')).toMatchObject({ id: 'legacy-phone' })
    expect(await database.getOrCreateSigningKey(now.toISOString())).toEqual(signingKey)
    expect(await database.isBootstrapAvailable()).toBe(false)

    const changed = await request('/auth/change-password', { currentPassword: legacyPassword, newPassword: NEW_PASSWORD }, session)
    expect(changed.status).toBe(200)
    const newHash = (await database.client.execute('SELECT password FROM ba_account')).rows[0]!.password
    expect(newHash).not.toBe(legacyHash)
    await database.migrate()
    expect((await database.client.execute('SELECT password FROM ba_account')).rows).toEqual([{ password: newHash }])
    expect((await database.client.execute('SELECT password_hash FROM accounts')).rows[0]!.password_hash).toBe(legacyHash)
    expect(await (await request('/auth/session', undefined, session)).json()).toMatchObject({ account: null })
    expect((await request('/auth/signin', { username: 'legacy_owner', password: legacyPassword })).status).toBe(401)
    expect((await request('/auth/signin', { username: 'legacy_owner', password: NEW_PASSWORD })).status).toBe(200)
    expect(await database.getAccount('legacy-owner-id')).toEqual(legacyAccount)
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
