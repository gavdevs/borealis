// Explicit, temporary write test against an initialized service and its database.
// node --env-file=.env scripts/hosted-smoke.mjs --allow-test-writes [https://...]
import assert from 'node:assert/strict'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { createClient } from '@libsql/client/web'

if (process.argv[2] !== '--allow-test-writes') throw new Error('Pass --allow-test-writes to create and remove temporary test accounts and a phone.')
const base = new URL(process.argv[3] ?? 'https://borealis.loosewire.dev').origin
if (!base.startsWith('https://') && !base.startsWith('http://127.0.0.1:')) throw new Error('Use HTTPS, or a loopback runtime.')
if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) throw new Error('Supply the matching Turso database credentials privately.')
const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
// Exercise the reported 16-character signup case, not just long passphrases.
const password = randomBytes(12).toString('base64url')
const minimumPassword = randomBytes(9).toString('base64url')
const replacement = randomBytes(9).toString('base64url')
const usernames = ['a', 'b'].map(part => `smoke_${part}_${randomBytes(8).toString('hex')}`)
const deviceBearer = `brl_device_${randomBytes(32).toString('base64url')}`
const digest = createHash('sha256').update(deviceBearer).digest('hex')
const createdAccountIds = new Set()
let stage = 'checking initialized database'
let fixtureWritesStarted = false
async function request(path, expected, { method = 'GET', body, cookie, bearer, origin = base } = {}) {
  const response = await fetch(`${base}/api/borealis/v1${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', 'X-Borealis-Request': '1', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, got ${response.status}`)
  // Better Auth can send several cookies. Never split a combined Set-Cookie
  // header on commas: Expires attributes can contain commas themselves.
  const sessionCookies = response.headers.getSetCookie().filter(value =>
    /^(?:__Host-)?borealis_session=/.test(value))
  for (const value of sessionCookies) {
    // Keep assertion messages generic so a failure cannot print the credential.
    assert.ok(/;\s*HttpOnly(?:;|$)/i.test(value), 'Session cookie must be HttpOnly.')
    assert.ok(/;\s*SameSite=Strict(?:;|$)/i.test(value), 'Session cookie must use SameSite=Strict.')
    assert.ok(/;\s*Path=\/(?:;|$)/i.test(value), 'Session cookie must use Path=/.')
    if (base.startsWith('https://')) {
      assert.ok(value.startsWith('__Host-borealis_session='), 'HTTPS session cookie must use the __Host- prefix.')
      assert.ok(/;\s*Secure(?:;|$)/i.test(value), 'HTTPS session cookie must be Secure.')
      assert.ok(!/;\s*Domain=/i.test(value), 'Host-only session cookie must not set Domain.')
    }
  }
  const sessionCookie = sessionCookies.at(-1)?.split(';')[0]
  return { body: await response.json(), cookie: sessionCookie?.endsWith('=') ? undefined : sessionCookie }
}

async function removeFixtures() {
  const tx = await client.transaction('write')
  try {
    const accounts = (await tx.execute({
      sql: 'SELECT id, username, role FROM accounts WHERE username IN (?, ?)', args: usernames,
    })).rows
    const users = (await tx.execute({
      sql: 'SELECT id, username, email FROM ba_user WHERE username IN (?, ?)', args: usernames,
    })).rows
    for (const account of accounts) {
      assert.ok(account.role === 'member', 'Refusing to remove a non-member fixture account.')
      const user = users.find(value => value.username === account.username)
      assert.ok(!user || user.id === account.id, 'Fixture auth and domain account identities do not match.')
    }
    for (const user of users) {
      assert.ok(user.email === `${user.username}@users.borealis.invalid`, 'Fixture auth alias does not match.')
    }
    const accountIds = new Set([...accounts, ...users].map(value => value.id))
    assert.ok([...createdAccountIds].every(id => accountIds.has(id)),
      'Created service accounts were not found in this database; fixture cleanup requires the matching database.')
    const devices = (await tx.execute({
      sql: 'SELECT owner_account_id FROM devices WHERE bearer_digest = ?', args: [digest],
    })).rows
    assert.ok(devices.every(value => value.owner_account_id === null || accountIds.has(value.owner_account_id)),
      'Refusing to remove a fixture phone owned by another account.')
    for (const id of accountIds) {
      const domainAccount = (await tx.execute({ sql: 'SELECT username, role FROM accounts WHERE id = ?', args: [id] })).rows[0]
      const authUser = (await tx.execute({ sql: 'SELECT username, email FROM ba_user WHERE id = ?', args: [id] })).rows[0]
      assert.ok(!domainAccount || (usernames.includes(domainAccount.username) && domainAccount.role === 'member'),
        'Refusing to remove a non-fixture domain identity.')
      assert.ok(!authUser || (usernames.includes(authUser.username)
        && authUser.email === `${authUser.username}@users.borealis.invalid`), 'Refusing to remove a non-fixture auth identity.')
      const otherPhones = await tx.execute({
        sql: 'SELECT id FROM devices WHERE owner_account_id = ? AND bearer_digest != ?', args: [id, digest],
      })
      assert.ok(otherPhones.rows.length === 0, 'Refusing to remove a fixture account with another phone.')
    }

    // Delete children explicitly: the remote connection may not enable SQLite
    // foreign-key cascades. Every predicate is bound to this run's fixture IDs.
    for (const statement of [
      { sql: 'DELETE FROM jobs WHERE device_id IN (SELECT id FROM devices WHERE bearer_digest = ?)', args: [digest] },
      { sql: 'DELETE FROM assignments WHERE device_id IN (SELECT id FROM devices WHERE bearer_digest = ?)', args: [digest] },
      { sql: 'DELETE FROM pairings WHERE device_bearer_digest = ?', args: [digest] },
      { sql: 'DELETE FROM devices WHERE bearer_digest = ?', args: [digest] },
    ]) await tx.execute(statement)
    for (const id of accountIds) {
      for (const sql of [
        'DELETE FROM account_sessions WHERE account_id = ?',
        'DELETE FROM account_apps WHERE account_id = ?',
        'DELETE FROM ba_session WHERE userId = ?',
        'DELETE FROM ba_account WHERE userId = ?',
        'DELETE FROM ba_user WHERE id = ?',
        'DELETE FROM accounts WHERE id = ?',
      ]) await tx.execute({ sql, args: [id] })
    }
    await tx.commit()
  } catch (error) {
    if (!tx.closed) await tx.rollback()
    throw error
  } finally {
    tx.close()
  }
}
try {
  const original = (await client.execute('SELECT key_id, public_key_spki FROM server_keys ORDER BY created_at LIMIT 1')).rows[0]
  assert.ok(original, 'Run pnpm worker:migrate before testing.')
  assert.equal((await client.execute({ sql: 'SELECT id FROM accounts WHERE username IN (?, ?)', args: usernames })).rows.length, 0,
    'Fixture usernames already exist; do not continue.')
  assert.equal((await client.execute({ sql: 'SELECT id FROM ba_user WHERE username IN (?, ?)', args: usernames })).rows.length, 0,
    'Fixture usernames already exist in Better Auth; do not continue.')
  const bootstrapBefore = (await client.execute("SELECT value FROM service_metadata WHERE key='bootstrap_claimed'")).rows
  const packageName = (await client.execute('SELECT package_name FROM allowlist ORDER BY package_name LIMIT 1')).rows[0]?.package_name
  await request('/health', 200)
  fixtureWritesStarted = true
  await request('/auth/signup', 403, { method: 'POST', body: { username: usernames[0], password }, origin: 'https://untrusted.example' })
  stage = 'signup and secure cookies in the hosted runtime'
  const alice = await request('/auth/signup', 201, { method: 'POST', body: { username: usernames[0], password } })
  createdAccountIds.add(alice.body.account.id)
  const bob = await request('/auth/signup', 201, { method: 'POST', body: { username: usernames[1], password: minimumPassword } })
  createdAccountIds.add(bob.body.account.id)
  assert.equal(alice.body.account.role, 'member')
  assert.equal(bob.body.account.role, 'member')
  assert.ok(alice.cookie && bob.cookie)
  const hostedAccounts = (await client.execute({ sql: 'SELECT id FROM accounts WHERE username IN (?, ?)', args: usernames })).rows
  assert.ok(hostedAccounts.length === 2
    && hostedAccounts.some(value => value.id === alice.body.account.id)
    && hostedAccounts.some(value => value.id === bob.body.account.id), 'Service and supplied database fixtures do not match.')
  await request('/admin/allowlist', 404, { cookie: alice.cookie })
  stage = 'account isolation and owner-bound pairing'
  if (packageName) await request('/me/apps', 201, { method: 'POST', cookie: alice.cookie, body: { packageName } })
  assert.equal((await request('/me/apps', 200, { cookie: bob.cookie })).body.items.length, 0)
  const pairing = (await request('/pairings', 201, { method: 'POST', body: { deviceLabel: 'Temporary hosted verification phone', deviceBearerDigest: digest } })).body
  assert.equal((await request('/me/pairings', 200, { cookie: bob.cookie })).body.pairings.length, 0)
  await request('/me/pairings/preview', 200, { method: 'POST', cookie: alice.cookie, body: { userCode: pairing.userCode } })
  const approved = (await request('/me/pairings/approve', 200, { method: 'POST', cookie: alice.cookie, body: { userCode: pairing.userCode } })).body
  const phoneId = approved.device.id
  const activation = (await request(`/pairings/${pairing.pairingId}/activate`, 200, { method: 'POST', bearer: pairing.pollSecret })).body
  assert.equal(activation.keyId, original.key_id)
  await request(`/me/devices/${phoneId}/jobs`, 404, { cookie: bob.cookie })
  await request(`/me/devices/${phoneId}`, 404, { method: 'DELETE', cookie: bob.cookie })
  if (packageName) {
    const synced = (await request('/device/sync', 200, { bearer: deviceBearer })).body
    assert.ok(synced.library.some(app => app.packageName === packageName), 'Pre-pairing library app did not reach phone.')
    const envelope = (await request(`/device/library/${encodeURIComponent(packageName)}/job`, 200,
      { method: 'POST', bearer: deviceBearer, body: {} })).body.job
    const key = createPublicKey({ key: Buffer.from(original.public_key_spki), type: 'spki', format: 'der' })
    assert.ok(verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64url')))
    const payload = JSON.parse(envelope.payload)
    assert.equal(payload.packageName, packageName)
    assert.equal(payload.deviceId, phoneId)
    assert.deepEqual(payload.acceptedSignerSha256, [])
  }
  stage = 'signin, password changes, and session revocation'
  const secondLogin = await request('/auth/signin', 200, { method: 'POST', body: { username: usernames[0].toUpperCase(), password } })
  const changed = await request('/auth/change-password', 200, { method: 'POST', cookie: alice.cookie, body: { currentPassword: password, newPassword: replacement } })
  await request('/me/devices', 401, { cookie: alice.cookie })
  await request('/me/devices', 401, { cookie: secondLogin.cookie })
  await request('/me/devices', 200, { cookie: changed.cookie })
  await request('/auth/signin', 401, { method: 'POST', body: { username: usernames[0], password } })
  const signedIn = await request('/auth/signin', 200, { method: 'POST', body: { username: usernames[0], password: replacement } })
  await request('/auth/signout', 200, { method: 'POST', cookie: signedIn.cookie, body: {} })
  assert.equal((await request('/auth/session', 200, { cookie: signedIn.cookie })).body.account, null)
  assert.deepEqual((await client.execute("SELECT value FROM service_metadata WHERE key='bootstrap_claimed'")).rows, bootstrapBefore)
  console.log('Passed: hosted authentication, secure cookies, CSRF, account isolation, pairing, signing identity, password changes, and signout.')
  console.log(packageName ? 'Passed: library sync and signed install-job verification.' : 'Signed install-job verification skipped: no cached package is available.')
} catch (error) {
  console.error(`Hosted verification failed during ${stage}: ${error instanceof assert.AssertionError ? error.message : 'runtime or network error'}. No credentials were printed.`)
  process.exitCode = 1
} finally {
  try {
    if (fixtureWritesStarted) {
      await removeFixtures()
      assert.equal((await client.execute({ sql: 'SELECT id FROM accounts WHERE username IN (?, ?)', args: usernames })).rows.length, 0)
      assert.equal((await client.execute({ sql: 'SELECT id FROM ba_user WHERE username IN (?, ?)', args: usernames })).rows.length, 0)
      console.log('Removed only this run’s temporary auth/domain accounts, sessions, credentials, and phone. Catalog, owner setup, and real accounts were not changed.')
    } else console.log('No fixture writes were started; nothing was removed.')
  } catch {
    console.error(`Temporary cleanup failed. Inspect only fixture usernames ${usernames.join(', ')} before proceeding.`)
    process.exitCode = 1
  }
  client.close()
}
