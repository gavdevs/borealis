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
const password = randomBytes(24).toString('base64url')
const replacement = randomBytes(24).toString('base64url')
const usernames = ['a', 'b'].map(part => `smoke_${part}_${randomBytes(8).toString('hex')}`)
const deviceBearer = `brl_device_${randomBytes(32).toString('base64url')}`
const digest = createHash('sha256').update(deviceBearer).digest('hex')
let stage = 'checking initialized database'
async function request(path, expected, { method = 'GET', body, cookie, bearer, origin = base } = {}) {
  const response = await fetch(`${base}/api/borealis/v1${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', 'X-Borealis-Request': '1', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, got ${response.status}`)
  const setCookie = response.headers.get('set-cookie')
  if (setCookie && base.startsWith('https://')) {
    assert.match(setCookie, /^__Host-borealis_session=/)
    assert.match(setCookie, /; Secure/i)
    assert.match(setCookie, /; HttpOnly/i)
    assert.match(setCookie, /; SameSite=Strict/i)
  }
  return { body: await response.json(), cookie: setCookie?.split(';')[0] }
}
try {
  const original = (await client.execute('SELECT key_id, public_key_spki FROM server_keys ORDER BY created_at LIMIT 1')).rows[0]
  assert.ok(original, 'Run db:migrate before testing.')
  const bootstrapBefore = (await client.execute("SELECT value FROM service_metadata WHERE key='bootstrap_claimed'")).rows
  const packageName = (await client.execute('SELECT package_name FROM allowlist ORDER BY package_name LIMIT 1')).rows[0]?.package_name
  await request('/health', 200)
  await request('/auth/signup', 403, { method: 'POST', body: { username: usernames[0], password }, origin: 'https://untrusted.example' })
  stage = 'signup and secure cookies in the hosted runtime'
  const alice = await request('/auth/signup', 201, { method: 'POST', body: { username: usernames[0], password } })
  const bob = await request('/auth/signup', 201, { method: 'POST', body: { username: usernames[1], password } })
  assert.equal(alice.body.account.role, 'member')
  assert.equal(bob.body.account.role, 'member')
  assert.ok(alice.cookie && bob.cookie)
  await request('/admin/allowlist', 403, { cookie: alice.cookie })
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
    await request(`/me/devices/${phoneId}/assignments`, 201, { method: 'POST', cookie: alice.cookie, body: { packageName } })
    const synced = (await request('/device/sync', 200, { bearer: deviceBearer })).body
    assert.equal(synced.jobs.length, 1)
    const envelope = synced.jobs[0]
    const key = createPublicKey({ key: Buffer.from(original.public_key_spki), type: 'spki', format: 'der' })
    assert.ok(verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64url')))
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
  console.log('Passed: hosted authentication, secure cookies, CSRF, account isolation, pairing, signing identity, signed jobs, password changes, and signout.')
} catch (error) {
  console.error(`Hosted verification failed during ${stage}: ${error instanceof assert.AssertionError ? error.message : 'runtime or network error'}. No credentials were printed.`)
  process.exitCode = 1
} finally {
  try {
    await client.batch([
      { sql: 'DELETE FROM jobs WHERE device_id IN (SELECT id FROM devices WHERE bearer_digest=?)', args: [digest] },
      { sql: 'DELETE FROM assignments WHERE device_id IN (SELECT id FROM devices WHERE bearer_digest=?)', args: [digest] },
      { sql: 'DELETE FROM pairings WHERE device_bearer_digest=?', args: [digest] },
      { sql: 'DELETE FROM devices WHERE bearer_digest=?', args: [digest] },
      { sql: 'DELETE FROM accounts WHERE username IN (?,?)', args: usernames },
    ], 'write')
    assert.equal((await client.execute({ sql: 'SELECT id FROM accounts WHERE username IN (?,?)', args: usernames })).rows.length, 0)
    console.log('Removed only this run’s temporary accounts and phone. Catalog, owner setup, and real accounts were not changed.')
  } catch {
    console.error(`Temporary cleanup failed. Inspect only fixture usernames ${usernames.join(', ')} before proceeding.`)
    process.exitCode = 1
  }
  client.close()
}
