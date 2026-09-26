import { createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BorealisDatabase } from './db.js'

const NOW = '2026-09-25T12:00:00.000Z'
const LATER = '2026-09-25T12:01:00.000Z'
const EXPIRES = '2026-09-25T12:10:00.000Z'
const LEGACY_HASH = `scrypt$32768$8$3$${'12'.repeat(16)}$${'ab'.repeat(64)}`
const PACKAGE = 'com.example.bank'

describe('Better Auth additive migration and domain account bridge', () => {
  let database: BorealisDatabase

  beforeEach(async () => {
    database = new BorealisDatabase(createClient({ url: ':memory:' }))
    await database.migrate()
  })

  afterEach(() => database.close())

  async function legacyAccount(id = 'alice', bootstrap = false) {
    return database.createAccount({
      id, username: id, passwordHash: LEGACY_HASH, createdAt: NOW,
      sessionDigest: `legacy-session-${id}`, sessionExpiresAt: EXPIRES, bootstrap,
    })
  }

  async function insertBetterAuthUser(id: string, username = id) {
    await database.client.execute({
      sql: `INSERT INTO ba_user (id, name, email, emailVerified, createdAt, updatedAt, username)
        VALUES (?, ?, ?, 0, ?, ?, ?)`,
      args: [id, username, `${username}@users.borealis.invalid`, NOW, NOW, username],
    })
  }

  async function allowedApp() {
    await database.createAllowlist({
      packageName: PACKAGE, displayName: 'Example Bank', publisher: 'Example Financial',
      reason: 'Card controls', signerSha256: 'a'.repeat(64),
    }, NOW)
  }

  async function device(id: string, owner: string | null = null) {
    await database.client.execute({
      sql: 'INSERT INTO devices (id, owner_account_id, label, bearer_digest, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [id, owner, id, `bearer-${id}`, NOW],
    })
  }

  it('copies exact legacy verifiers without changing ids, ownership, keys, or old sessions', async () => {
    const signer = await database.getOrCreateSigningKey(NOW)
    await allowedApp()
    await device('legacy-phone')
    const original = await legacyAccount('alice', true)
    await database.migrate()

    expect((await database.client.execute('SELECT * FROM ba_user')).rows).toEqual([
      expect.objectContaining({
        id: 'alice', username: 'alice', name: 'alice', email: 'alice@users.borealis.invalid',
        emailVerified: 0, createdAt: NOW, updatedAt: NOW,
      }),
    ])
    expect((await database.client.execute('SELECT * FROM ba_account')).rows).toEqual([
      expect.objectContaining({ accountId: 'alice', providerId: 'credential', userId: 'alice', password: LEGACY_HASH }),
    ])
    expect(await database.getAccount('alice')).toEqual(original)
    expect(await database.getAccountCredentials('alice')).toMatchObject({ passwordHash: LEGACY_HASH })
    expect((await database.client.execute('SELECT owner_account_id FROM devices')).rows[0]?.owner_account_id).toBe('alice')
    expect(await database.listAccountApps('alice')).toHaveLength(1)
    expect(await database.getSigningKey()).toEqual(signer)
    expect(await database.getSession('legacy-session-alice', LATER)).toMatchObject({ account: original })
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM ba_session')).rows[0]?.count).toBe(0)
    expect(await database.isBootstrapAvailable()).toBe(false)
  })

  it('is idempotent and never restores a changed or deliberately removed credential', async () => {
    await legacyAccount()
    await database.migrate()
    await database.client.execute("UPDATE ba_account SET password = 'replacement-managed-hash'")
    await database.migrate()
    expect((await database.client.execute('SELECT password FROM ba_account')).rows).toEqual([{ password: 'replacement-managed-hash' }])
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM ba_user')).rows[0]?.count).toBe(1)

    await database.client.execute('DELETE FROM ba_account')
    await database.migrate()
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM ba_account')).rows[0]?.count).toBe(0)
    await database.client.execute('DELETE FROM ba_user')
    await database.migrate()
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM ba_user')).rows[0]?.count).toBe(0)
    expect(await database.getAccount('alice')).toMatchObject({ id: 'alice' })
  })

  it('rolls back the entire account backfill when credential insertion fails', async () => {
    await legacyAccount()
    await database.client.execute(`CREATE TRIGGER reject_ba_account BEFORE INSERT ON ba_account
      BEGIN SELECT RAISE(ABORT, 'test credential failure'); END`)
    await expect(database.migrate()).rejects.toThrow('test credential failure')
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM ba_user')).rows[0]?.count).toBe(0)
    expect((await database.client.execute("SELECT COUNT(*) AS count FROM service_metadata WHERE key LIKE 'better_auth_legacy_account:%'")).rows[0]?.count).toBe(0)
    expect(await database.getAccountCredentials('alice')).toMatchObject({ passwordHash: LEGACY_HASH })
    await database.client.execute('DROP TRIGGER reject_ba_account')
    await database.migrate()
    expect((await database.client.execute('SELECT password FROM ba_account')).rows[0]?.password).toBe(LEGACY_HASH)
  })

  it('fails closed on an existing Better Auth identity mismatch', async () => {
    await legacyAccount()
    await insertBetterAuthUser('alice', 'different_user')
    await expect(database.migrate()).rejects.toThrow('conflicting account identity')
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM ba_account')).rows[0]?.count).toBe(0)
    expect((await database.client.execute('SELECT username FROM ba_user')).rows[0]?.username).toBe('different_user')
  })

  it('mirrors new users as members without retaining a password in the domain table', async () => {
    await insertBetterAuthUser('new-user', 'quiet_phone')
    const input = { id: 'new-user', username: '  Quiet_Phone  ', createdAt: NOW }
    const expected = { id: 'new-user', username: 'quiet_phone', role: 'member', createdAt: NOW }
    expect(await database.ensureBetterAuthAccount(input)).toEqual(expected)
    expect(await database.ensureBetterAuthAccount({ ...input, createdAt: LATER })).toEqual(expected)
    expect(await database.getAccount('new-user')).toEqual(expected)
    expect(await database.getAccountCredentials('new-user')).toMatchObject({ passwordHash: 'better-auth-managed' })
    expect(await database.getAccount('missing')).toBeNull()
    await database.migrate()
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM ba_account')).rows[0]?.count).toBe(0)
  })

  it('does not link another id to an existing username or overwrite a curator', async () => {
    await legacyAccount('alice', true)
    expect(await database.ensureBetterAuthAccount({ id: 'alice', username: 'ALICE', createdAt: LATER })).toMatchObject({
      id: 'alice', username: 'alice', role: 'curator', createdAt: NOW,
    })
    expect(await database.ensureBetterAuthAccount({ id: 'attacker', username: 'alice', createdAt: NOW })).toBeNull()
    expect(await database.ensureBetterAuthAccount({ id: 'alice', username: 'attacker', createdAt: NOW })).toBeNull()
    expect(await database.ensureBetterAuthAccount({ id: 'invalid', username: 'bad@email', createdAt: NOW })).toBeNull()
    expect(await database.getAccount('attacker')).toBeNull()
    expect(await database.getAccountCredentials('alice')).toMatchObject({ passwordHash: LEGACY_HASH })
  })

  it('allows exactly one owner claim and transfers only unowned legacy devices', async () => {
    await database.ensureBetterAuthAccount({ id: 'alice', username: 'alice', createdAt: NOW })
    await database.ensureBetterAuthAccount({ id: 'bob', username: 'bob', createdAt: NOW })
    await allowedApp()
    await database.addAccountApp('alice', PACKAGE, NOW)
    await device('unowned')
    await device('bobs-phone', 'bob')

    expect(await database.claimBetterAuthOwner('missing', NOW)).toBeNull()
    expect(await database.isBootstrapAvailable()).toBe(true)
    const claims = await Promise.all([
      database.claimBetterAuthOwner('alice', LATER),
      database.claimBetterAuthOwner('bob', LATER),
    ])
    expect(claims).toEqual([{ id: 'alice', username: 'alice', role: 'curator', createdAt: NOW }, null])
    expect((await database.client.execute('SELECT id, owner_account_id FROM devices ORDER BY id')).rows).toEqual([
      { id: 'bobs-phone', owner_account_id: 'bob' }, { id: 'unowned', owner_account_id: 'alice' },
    ])
    expect(await database.listAccountApps('alice')).toHaveLength(1)
    expect(await database.getAccount('bob')).toMatchObject({ role: 'member' })
    expect(await database.claimBetterAuthOwner('alice', LATER)).toBeNull()
    expect(await database.isBootstrapAvailable()).toBe(false)
  })

  it('rolls back owner promotion, bootstrap marker and device claims on failure', async () => {
    await database.ensureBetterAuthAccount({ id: 'alice', username: 'alice', createdAt: NOW })
    await allowedApp()
    await device('unowned')
    await database.client.execute(`CREATE TRIGGER reject_claim_apps BEFORE INSERT ON account_apps
      BEGIN SELECT RAISE(ABORT, 'test claim failure'); END`)
    await expect(database.claimBetterAuthOwner('alice', LATER)).rejects.toThrow('test claim failure')
    expect(await database.isBootstrapAvailable()).toBe(true)
    expect(await database.getAccount('alice')).toMatchObject({ role: 'member' })
    expect((await database.client.execute('SELECT owner_account_id FROM devices')).rows[0]?.owner_account_id).toBeNull()
    expect(await database.listAccountApps('alice')).toEqual([])
  })
})
