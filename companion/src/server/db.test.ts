import { createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateSigningKey } from './crypto.js'
import { BorealisDatabase } from './db.js'

const NOW = '2026-09-25T12:00:00.000Z'
const LATER = '2026-09-25T12:01:00.000Z'
const EXPIRES = '2026-09-25T12:10:00.000Z'
const SIGNER = 'a'.repeat(64)
const PACKAGE = 'com.example.bank'

describe('Borealis libSQL database', () => {
  let database: BorealisDatabase

  beforeEach(async () => {
    database = new BorealisDatabase(createClient({ url: ':memory:' }))
    await database.migrate()
  })

  afterEach(() => database.close())

  async function pendingPairing(suffix = 'one') {
    await database.createPairing({
      id: `pairing-${suffix}`,
      userCode: `CODE-${suffix}`,
      userCodeDigest: `code-digest-${suffix}`,
      pollSecretDigest: `poll-digest-${suffix}`,
      deviceBearerDigest: `bearer-digest-${suffix}`,
      deviceLabel: `Light Phone ${suffix}`,
      createdAt: NOW,
      expiresAt: EXPIRES,
    })
  }

  async function activeDevice(suffix = 'one', ownerAccountId?: string) {
    await pendingPairing(suffix)
    await database.approvePairing(`code-digest-${suffix}`, `device-${suffix}`, NOW, ownerAccountId)
    await database.activatePairing(`pairing-${suffix}`, `poll-digest-${suffix}`, NOW)
    return `device-${suffix}`
  }

  async function allowedApp() {
    return database.createAllowlist({
      packageName: PACKAGE,
      displayName: 'Example Bank',
      publisher: 'Example Financial',
      reason: 'Card controls',
      signerSha256: SIGNER,
    }, NOW)
  }

  async function account(id = 'alice', bootstrap = false) {
    return database.createAccount({
      id,
      username: id,
      passwordHash: `password-hash-${id}`,
      createdAt: NOW,
      sessionDigest: `session-${id}`,
      sessionExpiresAt: EXPIRES,
      bootstrap,
    })
  }

  it('preserves existing signing identity and exact binary key bytes through migrations', async () => {
    const key = generateSigningKey()
    await database.client.execute({
      sql: 'INSERT INTO server_keys (key_id, public_key_spki, private_key_pkcs8, created_at) VALUES (?, ?, ?, ?)',
      args: [key.keyId, key.publicKeySpki, key.privateKeyPkcs8, NOW],
    })
    await database.migrate()
    expect(await database.getOrCreateSigningKey(LATER)).toEqual(key)
    const stored = await database.client.execute('SELECT typeof(public_key_spki) AS public_type, typeof(private_key_pkcs8) AS private_type FROM server_keys')
    expect(stored.rows[0]).toMatchObject({ public_type: 'blob', private_type: 'blob' })
  })

  it('creates only one signing identity during concurrent first access', async () => {
    const secondWrapper = new BorealisDatabase(database.client)
    const keys = await Promise.all([
      database.getOrCreateSigningKey(NOW),
      secondWrapper.getOrCreateSigningKey(NOW),
      database.getOrCreateSigningKey(LATER),
    ])
    expect(keys[1]).toEqual(keys[0])
    expect(keys[2]).toEqual(keys[0])
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM server_keys')).rows[0]?.count).toBe(1)
  })

  it('loads a pre-provisioned signing key without creating one for Worker requests', async () => {
    expect(await database.getSigningKey()).toBeNull()
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM server_keys')).rows[0]?.count).toBe(0)
    const created = await database.getOrCreateSigningKey(NOW)
    expect(await database.getSigningKey()).toEqual(created)
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM server_keys')).rows[0]?.count).toBe(1)
  })

  it('approves each pairing once and activates idempotently', async () => {
    await pendingPairing()
    const approvals = await Promise.all([
      database.approvePairing('code-digest-one', 'device-one', NOW),
      database.approvePairing('code-digest-one', 'device-two', NOW),
    ])
    expect(approvals.filter(Boolean)).toHaveLength(1)
    expect(await database.listDevices()).toHaveLength(1)
    expect(await database.authenticateDevice('bearer-digest-one')).toBeNull()
    const activated = await database.activatePairing('pairing-one', 'poll-digest-one', NOW)
    expect(activated).toMatchObject({ id: 'device-one', activatedAt: NOW, revision: 1 })
    expect(await database.activatePairing('pairing-one', 'poll-digest-one', LATER)).toEqual(activated)
    expect(await database.authenticateDevice('bearer-digest-one')).toEqual(activated)
    expect(await database.listPairings(LATER)).toEqual([])
  })

  it('rejects wrong secrets, pending activation, and expired pairing approvals', async () => {
    await pendingPairing()
    expect(await database.getPairing('pairing-one', 'wrong-secret', NOW)).toBeNull()
    expect(await database.activatePairing('pairing-one', 'poll-digest-one', NOW)).toBeNull()
    expect(await database.approvePairing('code-digest-one', 'device-one', EXPIRES)).toBeNull()
    expect(await database.getPairing('pairing-one', 'poll-digest-one', EXPIRES)).toMatchObject({ state: 'expired' })
    expect(await database.listDevices()).toEqual([])
  })

  it('rolls back the new device if pairing approval cannot be recorded', async () => {
    await pendingPairing()
    await database.client.execute(`CREATE TRIGGER reject_approval BEFORE UPDATE ON pairings
      BEGIN SELECT RAISE(ABORT, 'test approval failure'); END`)
    await expect(database.approvePairing('code-digest-one', 'device-one', NOW)).rejects.toThrow('test approval failure')
    expect(await database.listDevices()).toEqual([])
    expect(await database.getPairing('pairing-one', 'poll-digest-one', NOW)).toMatchObject({ state: 'pending', deviceId: null })
  })

  it('never activates a device revoked after pairing approval', async () => {
    await pendingPairing()
    await database.approvePairing('code-digest-one', 'device-one', NOW)
    expect(await database.revokeDevice('device-one', LATER)).toBe(true)
    expect(await database.activatePairing('pairing-one', 'poll-digest-one', LATER)).toBeNull()
    expect(await database.getDevice('device-one')).toMatchObject({ activatedAt: null, revokedAt: LATER })
    expect(await database.getPairing('pairing-one', 'poll-digest-one', LATER)).toMatchObject({ state: 'approved' })
  })

  it('rolls back assignment and revision if its initial job cannot be queued', async () => {
    const deviceId = await activeDevice()
    await allowedApp()
    await database.client.execute(`CREATE TRIGGER reject_job BEFORE INSERT ON jobs
      BEGIN SELECT RAISE(ABORT, 'test job failure'); END`)
    await expect(database.assignPackage(deviceId, PACKAGE, NOW)).rejects.toThrow('test job failure')
    expect(await database.getDevice(deviceId)).toMatchObject({ revision: 1, assignments: [] })
    expect(await database.listJobs(deviceId)).toEqual([])
    await database.client.execute('DROP TRIGGER reject_job')
    expect(await database.assignPackage(deviceId, PACKAGE, NOW)).toMatchObject({ created: true, job: { status: 'queued' } })
  })

  it('assigns once, delivers jobs with pinned signers, and keeps terminal reports idempotent', async () => {
    const deviceId = await activeDevice()
    await allowedApp()
    const assignment = await database.assignPackage(deviceId, PACKAGE, NOW)
    expect(assignment).toMatchObject({ created: true, job: { status: 'queued' } })
    expect(await database.assignPackage(deviceId, PACKAGE, NOW)).toEqual({ created: false, job: null })
    expect(await database.getDevice(deviceId)).toMatchObject({ revision: 2, assignments: [PACKAGE] })
    const sync = await database.listSyncJobs(deviceId, LATER)
    expect(sync).toHaveLength(1)
    expect(sync[0]).toMatchObject({ status: 'delivered', deliveredAt: LATER, acceptedSignerSha256: [SIGNER] })
    expect(await database.getDevice(deviceId)).toMatchObject({ lastSeenAt: LATER })
    expect(await database.getJobAcceptedSigners(assignment!.job!.id)).toEqual([SIGNER])
    const report = {
      jobId: assignment!.job!.id,
      deviceId,
      status: 'succeeded' as const,
      installedVersionCode: 42,
      observedSignerSha256: [SIGNER],
      message: 'Installed',
      now: LATER,
    }
    expect(await database.reportJob(report)).toBe(3)
    expect(await database.reportJob({ ...report, installedVersionCode: 99 })).toBe(3)
    expect(await database.reportJob({ ...report, status: 'failed' })).toBeNull()
    expect(await database.getJob(report.jobId)).toMatchObject({ status: 'succeeded', installedVersionCode: 42, completedAt: LATER })
    expect(await database.listSyncJobs(deviceId, LATER)).toEqual([])
  })

  it('rolls back report status if the corresponding revision update fails', async () => {
    const deviceId = await activeDevice()
    await allowedApp()
    const assignment = await database.assignPackage(deviceId, PACKAGE, NOW)
    await database.client.execute(`CREATE TRIGGER reject_revision BEFORE UPDATE OF revision ON devices
      BEGIN SELECT RAISE(ABORT, 'test revision failure'); END`)
    await expect(database.reportJob({
      jobId: assignment!.job!.id,
      deviceId,
      status: 'succeeded',
      installedVersionCode: 42,
      observedSignerSha256: [SIGNER],
      message: null,
      now: LATER,
    })).rejects.toThrow('test revision failure')
    expect(await database.getJob(assignment!.job!.id)).toMatchObject({ status: 'queued', completedAt: null })
    expect(await database.getDevice(deviceId)).toMatchObject({ revision: 2 })
  })

  it('rolls back revocation when pending-job cancellation fails', async () => {
    const deviceId = await activeDevice()
    await allowedApp()
    await database.assignPackage(deviceId, PACKAGE, NOW)
    await database.client.execute(`CREATE TRIGGER reject_cancellation BEFORE UPDATE ON jobs
      BEGIN SELECT RAISE(ABORT, 'test cancellation failure'); END`)
    await expect(database.revokeDevice(deviceId, LATER)).rejects.toThrow('test cancellation failure')
    expect(await database.getDevice(deviceId)).toMatchObject({ revokedAt: null, revision: 2 })
    expect(await database.listJobs(deviceId)).toMatchObject([{ status: 'queued' }])
  })

  it('atomically revokes a concurrently assigned phone and blocks further queueing', async () => {
    const deviceId = await activeDevice()
    await allowedApp()
    await Promise.all([
      database.assignPackage(deviceId, PACKAGE, NOW),
      database.revokeDevice(deviceId, LATER),
    ])
    expect(await database.getDevice(deviceId)).toMatchObject({ revokedAt: LATER, revision: 3 })
    expect(await database.listJobs(deviceId)).toMatchObject([{ status: 'cancelled', completedAt: LATER }])
    expect(await database.authenticateDevice('bearer-digest-one')).toBeNull()
    expect(await database.queueJob(deviceId, PACKAGE, 'forbidden-job', LATER)).toBeNull()
    expect(await database.listSyncJobs(deviceId, LATER)).toEqual([])
    expect(await database.revokeDevice(deviceId, LATER)).toBe(false)
  })

  it('removes assignments and allowlist entries with cancellation and revision changes', async () => {
    const deviceOne = await activeDevice()
    const deviceTwo = await activeDevice('two')
    await allowedApp()
    await database.assignPackage(deviceOne, PACKAGE, NOW)
    await database.assignPackage(deviceTwo, PACKAGE, NOW)
    expect(await database.removeAssignment(deviceOne, PACKAGE, LATER)).toBe(true)
    expect(await database.removeAssignment(deviceOne, PACKAGE, LATER)).toBe(false)
    expect(await database.getDevice(deviceOne)).toMatchObject({ revision: 3, assignments: [] })
    expect(await database.listJobs(deviceOne)).toMatchObject([{ status: 'cancelled', message: 'Assignment removed.' }])
    expect(await database.deleteAllowlist(PACKAGE, LATER)).toBe(true)
    expect(await database.deleteAllowlist(PACKAGE, LATER)).toBe(false)
    expect(await database.getDevice(deviceTwo)).toMatchObject({ revision: 3, assignments: [] })
    expect(await database.listJobs(deviceTwo)).toMatchObject([{ status: 'cancelled', message: 'Removed from the Borealis allowlist.' }])
    expect(await database.listAllowlist()).toEqual([])
  })

  it('rolls back a duplicate job ID without changing the device revision', async () => {
    const deviceId = await activeDevice()
    await allowedApp()
    const assignment = await database.assignPackage(deviceId, PACKAGE, NOW)
    await expect(database.queueJob(deviceId, PACKAGE, assignment!.job!.id, LATER)).rejects.toThrow()
    expect(await database.getDevice(deviceId)).toMatchObject({ revision: 2 })
    expect(await database.listJobs(deviceId)).toHaveLength(1)
  })

  it('creates member accounts with canonical unique usernames and no email or recovery code fields', async () => {
    expect(await account('Alice')).toEqual({ id: 'Alice', username: 'alice', role: 'member', createdAt: NOW })
    expect(await account('alice')).toBeNull()
    expect(await database.findAccountCredentials('ALICE')).toEqual({
      account: { id: 'Alice', username: 'alice', role: 'member', createdAt: NOW },
      passwordHash: 'password-hash-Alice',
    })
    expect(await database.getAccountCredentials('Alice')).toEqual(await database.findAccountCredentials('alice'))
    expect(await database.findAccountCredentials('missing')).toBeNull()
    const columns = (await database.client.execute('PRAGMA table_info(accounts)')).rows.map((row) => row.name)
    expect(columns).toEqual(['id', 'username', 'password_hash', 'role', 'created_at'])
  })

  it('expires and revokes sessions and checks the verified password hash when signing in', async () => {
    const alice = await account()
    expect(await database.getSession('session-alice', NOW)).toEqual({ account: alice, createdAt: NOW, expiresAt: EXPIRES })
    expect(await database.getSession('session-alice', EXPIRES)).toBeNull()
    expect(await database.createAccountSession('alice', 'wrong-hash', 'wrong-session', EXPIRES, NOW)).toBeNull()
    expect(await database.getSession('wrong-session', NOW)).toBeNull()
    expect(await database.createAccountSession('alice', 'password-hash-alice', 'new-session', EXPIRES, LATER)).toEqual(alice)
    expect(await database.getSession('new-session', LATER)).toMatchObject({ account: alice, createdAt: LATER })
    await database.deleteSession('new-session')
    expect(await database.getSession('new-session', LATER)).toBeNull()
    expect(await database.getSession('session-alice', LATER)).not.toBeNull()
  })

  it('changes a password atomically and invalidates every old session and stale verification', async () => {
    const alice = await account()
    await database.createAccountSession('alice', 'password-hash-alice', 'second-session', EXPIRES, NOW)
    expect(await database.changeAccountPassword('alice', 'password-hash-alice', 'new-password-hash', 'replacement-session', EXPIRES, LATER)).toEqual(alice)
    expect(await database.getSession('session-alice', LATER)).toBeNull()
    expect(await database.getSession('second-session', LATER)).toBeNull()
    expect(await database.getSession('replacement-session', LATER)).toMatchObject({ account: alice })
    expect(await database.findAccountCredentials('alice')).toMatchObject({ passwordHash: 'new-password-hash' })
    expect(await database.createAccountSession('alice', 'password-hash-alice', 'stale-session', EXPIRES, LATER)).toBeNull()
    expect(await database.changeAccountPassword('alice', 'password-hash-alice', 'another-hash', 'stale-replacement', EXPIRES, LATER)).toBeNull()
    expect(await database.getSession('replacement-session', LATER)).not.toBeNull()
  })

  it('rolls back password and session revocation if the replacement session cannot be stored', async () => {
    await account()
    await database.client.execute(`CREATE TRIGGER reject_session BEFORE INSERT ON account_sessions
      BEGIN SELECT RAISE(ABORT, 'test session failure'); END`)
    await expect(database.changeAccountPassword('alice', 'password-hash-alice', 'new-hash', 'replacement', EXPIRES, LATER))
      .rejects.toThrow('test session failure')
    expect(await database.findAccountCredentials('alice')).toMatchObject({ passwordHash: 'password-hash-alice' })
    expect(await database.getSession('session-alice', LATER)).not.toBeNull()
  })

  it('claims legacy phones and saved apps only through one-time curator bootstrap', async () => {
    const legacyDevice = await activeDevice('legacy')
    await allowedApp()
    await database.assignPackage(legacyDevice, PACKAGE, NOW)
    const signingKey = await database.getOrCreateSigningKey(NOW)
    await account('member')
    const memberDevice = await activeDevice('member', 'member')
    expect(await database.listDevices('member')).toMatchObject([{ id: memberDevice }])
    expect(await database.listAccountApps('member')).toEqual([])
    expect(await database.getDevice(legacyDevice, 'member')).toBeNull()
    expect(await database.isBootstrapAvailable()).toBe(true)
    expect(await account('curator', true)).toMatchObject({ role: 'curator' })
    expect(await database.isBootstrapAvailable()).toBe(false)
    expect(await database.listDevices('curator')).toMatchObject([{ id: legacyDevice, assignments: [PACKAGE] }])
    expect(await database.listAccountApps('curator')).toMatchObject([{ packageName: PACKAGE }])
    expect(await database.getDevice(memberDevice, 'curator')).toBeNull()
    expect(await account('second-curator', true)).toBeNull()
    expect(await database.getOrCreateSigningKey(LATER)).toEqual(signingKey)
  })

  it('allows exactly one curator bootstrap during concurrent attempts', async () => {
    const attempts = await Promise.all([account('first', true), account('second', true)])
    expect(attempts.filter(Boolean)).toHaveLength(1)
    expect((await database.client.execute("SELECT COUNT(*) AS count FROM accounts WHERE role = 'curator'")).rows[0]?.count).toBe(1)
    expect(await database.isBootstrapAvailable()).toBe(false)
  })

  it('rolls back a failed bootstrap without consuming its claim or legacy ownership', async () => {
    const legacyDevice = await activeDevice('legacy')
    await database.client.execute(`CREATE TRIGGER reject_session BEFORE INSERT ON account_sessions
      BEGIN SELECT RAISE(ABORT, 'test session failure'); END`)
    await expect(account('curator', true)).rejects.toThrow('test session failure')
    expect(await database.isBootstrapAvailable()).toBe(true)
    expect(await database.getAccountCredentials('curator')).toBeNull()
    const deviceRow = await database.client.execute({ sql: 'SELECT owner_account_id FROM devices WHERE id = ?', args: [legacyDevice] })
    expect(deviceRow.rows[0]?.owner_account_id).toBeNull()
    await database.client.execute('DROP TRIGGER reject_session')
    expect(await account('curator', true)).toMatchObject({ role: 'curator' })
  })

  it('isolates phone reads and writes and requires apps to be in the owner’s private collection', async () => {
    await account('alice')
    await account('bob')
    const aliceDevice = await activeDevice('alice', 'alice')
    const bobDevice = await activeDevice('bob', 'bob')
    await allowedApp()
    expect(await database.assignPackage(aliceDevice, PACKAGE, NOW, 'alice')).toBeNull()
    expect(await database.addAccountApp('alice', 'com.unknown.app', NOW)).toBeNull()
    expect(await database.addAccountApp('alice', PACKAGE, NOW)).toMatchObject({ packageName: PACKAGE })
    expect(await database.addAccountApp('alice', PACKAGE, NOW)).toMatchObject({ packageName: PACKAGE })
    expect(await database.listAccountApps('alice')).toHaveLength(1)
    expect(await database.listAccountApps('bob')).toEqual([])
    expect(await database.assignPackage(aliceDevice, PACKAGE, NOW, 'alice')).toMatchObject({ created: true })
    expect(await database.getDevice(aliceDevice, 'bob')).toBeNull()
    expect(await database.listDevices('bob')).toMatchObject([{ id: bobDevice }])
    expect(await database.listJobs(aliceDevice, 'bob')).toEqual([])
    expect(await database.listJobs(aliceDevice, 'alice')).toHaveLength(1)
    expect(await database.revokeDevice(aliceDevice, LATER, 'bob')).toBe(false)
    expect(await database.removeAssignment(aliceDevice, PACKAGE, LATER, 'bob')).toBe(false)
    expect(await database.assignPackage(aliceDevice, PACKAGE, LATER, 'bob')).toBeNull()
    expect(await database.queueJob(aliceDevice, PACKAGE, 'forbidden-job', LATER, 'bob')).toBeNull()
    expect(await database.queueJob(bobDevice, PACKAGE, 'unsaved-job', LATER, 'bob')).toBeNull()
    expect(await database.getDevice(aliceDevice, 'alice')).toMatchObject({ revokedAt: null, revision: 2, assignments: [PACKAGE] })
    expect(await database.listDevices('')).toEqual([])
  })

  it('removes a private collection app only from its owner’s phones and queues', async () => {
    await account('alice')
    await account('bob')
    const aliceDevice = await activeDevice('alice', 'alice')
    const bobDevice = await activeDevice('bob', 'bob')
    await allowedApp()
    await database.addAccountApp('alice', PACKAGE, NOW)
    await database.addAccountApp('bob', PACKAGE, NOW)
    await database.assignPackage(aliceDevice, PACKAGE, NOW, 'alice')
    await database.assignPackage(bobDevice, PACKAGE, NOW, 'bob')
    expect(await database.removeAccountApp('alice', PACKAGE, LATER)).toBe(true)
    expect(await database.removeAccountApp('alice', PACKAGE, LATER)).toBe(false)
    expect(await database.listAccountApps('alice')).toEqual([])
    expect(await database.listAccountApps('bob')).toHaveLength(1)
    expect(await database.getDevice(aliceDevice, 'alice')).toMatchObject({ assignments: [], revision: 3 })
    expect(await database.getDevice(bobDevice, 'bob')).toMatchObject({ assignments: [PACKAGE], revision: 2 })
    expect(await database.listJobs(aliceDevice, 'alice')).toMatchObject([{ status: 'cancelled' }])
    expect(await database.listJobs(bobDevice, 'bob')).toMatchObject([{ status: 'queued' }])
    expect(await database.getAllowlist(PACKAGE)).not.toBeNull()
    expect(await database.deleteAllowlist(PACKAGE, LATER)).toBe(true)
    expect(await database.listAccountApps('bob')).toEqual([])
  })

  it('previews only exact pending pairing codes without exposing other owners or unclaimed lists', async () => {
    await account('alice')
    await account('bob')
    await pendingPairing('alice')
    await pendingPairing('unclaimed')
    expect(await database.listPairings(NOW, 'alice')).toEqual([])
    expect(await database.listPairings(NOW, 'bob')).toEqual([])
    expect(await database.previewPairing('wrong-code', NOW)).toBeNull()
    expect(await database.previewPairing('code-digest-alice', NOW)).toMatchObject({ id: 'pairing-alice', state: 'pending' })
    await database.approvePairing('code-digest-alice', 'device-alice', NOW, 'alice')
    expect(await database.previewPairing('code-digest-alice', NOW)).toBeNull()
    expect(await database.listPairings(NOW, 'alice')).toMatchObject([{ id: 'pairing-alice', state: 'approved' }])
    expect(await database.listPairings(NOW, 'bob')).toEqual([])
    expect(await database.previewPairing('code-digest-unclaimed', EXPIRES)).toBeNull()
    expect(await database.approvePairing('code-digest-alice', 'device-bob', NOW, 'bob')).toBeNull()
    expect(await database.getDevice('device-alice', 'bob')).toBeNull()
  })

  it('enforces atomic rate-limit counters, independent buckets, and expiry reset', async () => {
    const attempts = await Promise.all(Array.from({ length: 4 }, () => database.consumeRateLimit('peer-login', 2, 60, NOW)))
    expect(attempts).toEqual([true, true, false, false])
    expect(await database.consumeRateLimit('another-peer', 2, 60, NOW)).toBe(true)
    expect(await database.consumeRateLimit('peer-signup', 2, 60, NOW)).toBe(true)
    expect(await database.consumeRateLimit('peer-login', 2, 60, LATER)).toBe(true)
    expect(await database.consumeRateLimit('peer-login', 2, 60, LATER)).toBe(true)
    expect(await database.consumeRateLimit('peer-login', 2, 60, LATER)).toBe(false)
    await expect(database.consumeRateLimit('invalid', 0, 60, NOW)).rejects.toThrow(RangeError)
  })

  it('adds ownership to an old devices table without deleting records or claiming them', async () => {
    const legacyClient = createClient({ url: ':memory:' })
    const legacyDatabase = new BorealisDatabase(legacyClient)
    try {
      await legacyClient.execute(`CREATE TABLE devices (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, bearer_digest TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
        activated_at TEXT, last_seen_at TEXT, revoked_at TEXT
      )`)
      await legacyClient.execute({
        sql: 'INSERT INTO devices (id, label, bearer_digest, created_at, activated_at) VALUES (?, ?, ?, ?, ?)',
        args: ['old-phone', 'Existing phone', 'old-bearer', NOW, NOW],
      })
      await legacyDatabase.migrate()
      await legacyDatabase.migrate()
      expect(await legacyDatabase.getDevice('old-phone')).toMatchObject({ label: 'Existing phone', revision: 1, activatedAt: NOW })
      expect(await legacyDatabase.listDevices('some-new-account')).toEqual([])
      const row = (await legacyClient.execute("SELECT owner_account_id FROM devices WHERE id = 'old-phone'")).rows[0]
      expect(row?.owner_account_id).toBeNull()
      const columns = (await legacyClient.execute('PRAGMA table_info(devices)')).rows.filter((column) => column.name === 'owner_account_id')
      expect(columns).toHaveLength(1)
      expect(await legacyDatabase.isBootstrapAvailable()).toBe(true)
    } finally {
      legacyDatabase.close()
    }
  })
})
