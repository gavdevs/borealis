import { randomUUID } from 'node:crypto'
import type { Client, InValue, Transaction, TransactionMode } from '@libsql/client'
import type { AccountSummary, AllowlistItem, DeviceLibraryItem, DeviceSummary, JobSummary, PairingSummary, PlaySearchResult, UsageStats } from '../shared/api.js'
import { migrateBetterAuth } from './better-auth-migration.js'
import { generateSigningKey, type PersistedSigningKey } from './crypto.js'

type PairingRow = {
  id: string
  user_code: string
  user_code_digest: string
  poll_secret_digest: string
  device_bearer_digest: string
  device_label: string
  state: string
  device_id: string | null
  created_at: string
  expires_at: string
}

type DeviceRow = {
  id: string
  owner_account_id: string | null
  label: string
  bearer_digest: string
  revision: number
  created_at: string
  activated_at: string | null
  last_seen_at: string | null
  revoked_at: string | null
}

type AccountRow = {
  id: string
  username: string
  password_hash: string
  role: AccountSummary['role']
  created_at: string
}

type AllowlistRow = {
  package_name: string
  display_name: string
  publisher: string
  reason: string
  signer_sha256: string | null
  created_at: string
  updated_at: string
}

type JobRow = {
  id: string
  device_id: string
  package_name: string
  display_name: string
  accepted_signer_sha256: string
  action: 'install_or_update'
  status: JobSummary['status']
  created_at: string
  delivered_at: string | null
  completed_at: string | null
  installed_version_code: number | null
  observed_signer_sha256: string | null
  report_message: string | null
}

export type PairingRecord = {
  id: string
  userCode: string
  deviceLabel: string
  state: PairingSummary['state']
  deviceId: string | null
  deviceBearerDigest: string
  expiresAt: string
  createdAt: string
}

export type SyncJobRecord = JobSummary & {
  acceptedSignerSha256: string[]
}

type Executor = Pick<Client, 'execute'>

// Local clients may have only one connection (notably :memory:). Serialize
// their operations so a concurrent request cannot borrow an active transaction.
// Remote clients use independent streams and the database's transaction locks.
const localOperations = new WeakMap<Client, Promise<void>>()

export class BorealisDatabase {
  constructor(readonly client: Client) {}

  close(): void {
    this.client.close()
  }

  // Better Auth shares the local SQLite connection with domain operations.
  // Serialize its transactions through the same gate; remote requests retain
  // their independent libSQL streams and do not share request-bound promises.
  runAuth<T>(operation: () => Promise<T>): Promise<T> {
    return this.run(operation)
  }

  async migrate(): Promise<void> {
    await this.run(async () => {
      await this.client.execute('PRAGMA foreign_keys = ON')
      await this.client.batch(`
      CREATE TABLE IF NOT EXISTS server_keys (
        key_id TEXT PRIMARY KEY,
        public_key_spki BLOB NOT NULL,
        private_key_pkcs8 BLOB NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        bearer_digest TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        last_seen_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS pairings (
        id TEXT PRIMARY KEY,
        user_code TEXT NOT NULL,
        user_code_digest TEXT NOT NULL UNIQUE,
        poll_secret_digest TEXT NOT NULL UNIQUE,
        device_bearer_digest TEXT NOT NULL,
        device_label TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'activated')),
        device_id TEXT REFERENCES devices(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS allowlist (
        package_name TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        publisher TEXT NOT NULL,
        reason TEXT NOT NULL,
        signer_sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assignments (
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        package_name TEXT NOT NULL REFERENCES allowlist(package_name) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (device_id, package_name)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        package_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        accepted_signer_sha256 TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action = 'install_or_update'),
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'delivered', 'installing', 'awaiting_user_action',
          'review_required', 'succeeded', 'failed', 'cancelled'
        )),
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        completed_at TEXT,
        installed_version_code INTEGER,
        observed_signer_sha256 TEXT,
        report_message TEXT
      );

      CREATE INDEX IF NOT EXISTS jobs_device_status_idx ON jobs(device_id, status, created_at);
      CREATE INDEX IF NOT EXISTS pairings_expiry_idx ON pairings(expires_at);

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('member', 'curator')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_sessions (
        digest TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_apps (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        package_name TEXT NOT NULL REFERENCES allowlist(package_name) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, package_name)
      );

      CREATE TABLE IF NOT EXISTS service_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        key TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS account_sessions_account_idx ON account_sessions(account_id);
      CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx ON account_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS auth_rate_limits_expiry_idx ON auth_rate_limits(expires_at);
      `.split(';').map((sql) => sql.trim()).filter(Boolean), 'write')
    })
    // Checking and altering under one write lock makes concurrent startup safe.
    // Legacy devices remain unowned until the authenticated curator bootstrap.
    await this.transaction(async (tx) => {
      const columns = await all<{ name: string }>(tx, 'PRAGMA table_info(devices)')
      if (!columns.some(({ name }) => name === 'owner_account_id')) {
        await tx.execute('ALTER TABLE devices ADD COLUMN owner_account_id TEXT REFERENCES accounts(id)')
      }
      await tx.execute('CREATE INDEX IF NOT EXISTS devices_owner_idx ON devices(owner_account_id, created_at)')
    })
    await this.transaction(migrateBetterAuth)
  }

  async isBootstrapAvailable(): Promise<boolean> {
    return this.run(async () => !(await first(this.client,
      "SELECT key FROM service_metadata WHERE key = 'bootstrap_claimed'")))
  }

  async getAccount(accountId: string): Promise<AccountSummary | null> {
    return this.run(async () => {
      const row = await first<AccountRow>(this.client, 'SELECT * FROM accounts WHERE id = ?', [accountId])
      return row ? mapAccount(row) : null
    })
  }

  async usageStats(): Promise<UsageStats> {
    // A simple creation count is the whole usage signal; no events are written.
    const row = await first<{ count: number }>(this.client, 'SELECT COUNT(*) AS count FROM accounts')
    return { accounts: row?.count ?? 0 }
  }

  // Call only with an authenticated Better Auth user or its trusted create hook.
  // The domain row owns phones/apps; Better Auth owns all new password records.
  async ensureBetterAuthAccount(input: {
    id: string
    username: string
    createdAt: string
  }): Promise<AccountSummary | null> {
    const username = input.username.trim().toLowerCase()
    if (!/^[a-z0-9_]{3,32}$/.test(username) || !Number.isFinite(Date.parse(input.createdAt))) return null
    return this.transaction(async (tx) => {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO accounts (id, username, password_hash, role, created_at)
          VALUES (?, ?, 'better-auth-managed', 'member', ?)`,
        args: [input.id, username, input.createdAt],
      })
      const row = await first<AccountRow>(tx, 'SELECT * FROM accounts WHERE id = ? AND username = ?', [input.id, username])
      return row ? mapAccount(row) : null
    })
  }

  async claimBetterAuthOwner(accountId: string, now: string): Promise<AccountSummary | null> {
    return this.transaction(async (tx) => {
      if (await first(tx, "SELECT key FROM service_metadata WHERE key = 'bootstrap_claimed'")) return null
      const row = await first<AccountRow>(tx, 'SELECT * FROM accounts WHERE id = ?', [accountId])
      if (!row) return null
      await tx.execute({ sql: "UPDATE accounts SET role = 'curator' WHERE id = ?", args: [accountId] })
      await tx.execute({
        sql: "INSERT INTO service_metadata (key, value) VALUES ('bootstrap_claimed', ?)",
        args: [accountId],
      })
      await tx.execute({
        sql: 'UPDATE devices SET owner_account_id = ? WHERE owner_account_id IS NULL',
        args: [accountId],
      })
      await tx.execute({
        sql: 'INSERT OR IGNORE INTO account_apps (account_id, package_name, created_at) SELECT ?, package_name, ? FROM allowlist',
        args: [accountId, now],
      })
      return { ...mapAccount(row), role: 'curator' }
    })
  }

  async createAccount(input: {
    id: string
    username: string
    passwordHash: string
    createdAt: string
    sessionDigest: string
    sessionExpiresAt: string
    bootstrap?: boolean
  }): Promise<AccountSummary | null> {
    return this.transaction(async (tx) => {
      if (input.bootstrap && await first(tx,
        "SELECT key FROM service_metadata WHERE key = 'bootstrap_claimed'")) return null
      const role: AccountSummary['role'] = input.bootstrap ? 'curator' : 'member'
      const username = input.username.toLowerCase()
      const inserted = await tx.execute({
        sql: 'INSERT OR IGNORE INTO accounts (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
        args: [input.id, username, input.passwordHash, role, input.createdAt],
      })
      if (inserted.rowsAffected !== 1) return null
      await insertSession(tx, input.id, input.sessionDigest, input.sessionExpiresAt, input.createdAt)
      if (input.bootstrap) {
        await tx.execute({
          sql: "INSERT INTO service_metadata (key, value) VALUES ('bootstrap_claimed', ?)",
          args: [input.id],
        })
        await tx.execute({
          sql: 'UPDATE devices SET owner_account_id = ? WHERE owner_account_id IS NULL',
          args: [input.id],
        })
        await tx.execute({
          sql: 'INSERT INTO account_apps (account_id, package_name, created_at) SELECT ?, package_name, ? FROM allowlist',
          args: [input.id, input.createdAt],
        })
      }
      return { id: input.id, username, role, createdAt: input.createdAt }
    })
  }

  async findAccountCredentials(username: string): Promise<{ account: AccountSummary; passwordHash: string } | null> {
    return this.run(async () => {
      const row = await first<AccountRow>(this.client, 'SELECT * FROM accounts WHERE username = ?', [username.toLowerCase()])
      return row ? { account: mapAccount(row), passwordHash: row.password_hash } : null
    })
  }

  async getAccountCredentials(accountId: string): Promise<{ account: AccountSummary; passwordHash: string } | null> {
    return this.run(async () => {
      const row = await first<AccountRow>(this.client, 'SELECT * FROM accounts WHERE id = ?', [accountId])
      return row ? { account: mapAccount(row), passwordHash: row.password_hash } : null
    })
  }

  async createAccountSession(accountId: string, passwordHash: string, sessionDigest: string, expiresAt: string, now: string): Promise<AccountSummary | null> {
    return this.transaction(async (tx) => {
      // Password verification happens before this call. Check the exact hash
      // again while locked so a concurrent password change cannot mint a session.
      const account = await first<AccountRow>(tx,
        'SELECT * FROM accounts WHERE id = ? AND password_hash = ?', [accountId, passwordHash])
      if (!account) return null
      await insertSession(tx, account.id, sessionDigest, expiresAt, now)
      return mapAccount(account)
    })
  }

  async getSession(digest: string, now: string): Promise<{
    account: AccountSummary
    createdAt: string
    expiresAt: string
  } | null> {
    return this.run(async () => {
      const row = await first<AccountRow & { session_created_at: string; expires_at: string }>(this.client,
        `SELECT accounts.*, account_sessions.created_at AS session_created_at, account_sessions.expires_at
          FROM account_sessions JOIN accounts ON accounts.id = account_sessions.account_id
          WHERE account_sessions.digest = ? AND account_sessions.expires_at > ?`, [digest, now])
      return row ? { account: mapAccount(row), createdAt: row.session_created_at, expiresAt: row.expires_at } : null
    })
  }

  async deleteSession(digest: string): Promise<void> {
    await this.run(async () => {
      await this.client.execute({ sql: 'DELETE FROM account_sessions WHERE digest = ?', args: [digest] })
    })
  }

  async changeAccountPassword(accountId: string, currentPasswordHash: string, newPasswordHash: string, newSessionDigest: string, expiresAt: string, now: string): Promise<AccountSummary | null> {
    return this.transaction(async (tx) => {
      const updated = await tx.execute({
        sql: 'UPDATE accounts SET password_hash = ? WHERE id = ? AND password_hash = ?',
        args: [newPasswordHash, accountId, currentPasswordHash],
      })
      if (updated.rowsAffected !== 1) return null
      await tx.execute({ sql: 'DELETE FROM account_sessions WHERE account_id = ?', args: [accountId] })
      await insertSession(tx, accountId, newSessionDigest, expiresAt, now)
      const account = await first<AccountRow>(tx, 'SELECT * FROM accounts WHERE id = ?', [accountId])
      return account ? mapAccount(account) : null
    })
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number, nowISO: string): Promise<boolean> {
    const now = Date.parse(nowISO)
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || !Number.isFinite(now)) {
      throw new RangeError('Rate limit and window must be positive integers with a valid timestamp.')
    }
    const expiresAt = new Date(now + windowSeconds * 1000).toISOString()
    return this.transaction(async (tx) => {
      // Bound cleanup work per request; the expiry index avoids a table scan.
      await tx.execute({
        sql: `DELETE FROM auth_rate_limits WHERE key IN (
          SELECT key FROM auth_rate_limits WHERE expires_at <= ? ORDER BY expires_at LIMIT 100
        )`,
        args: [nowISO],
      })
      const row = await first<{ attempts: number; expires_at: string }>(tx,
        'SELECT attempts, expires_at FROM auth_rate_limits WHERE key = ?', [key])
      if (row && row.expires_at > nowISO) {
        if (row.attempts >= limit) return false
        await tx.execute({ sql: 'UPDATE auth_rate_limits SET attempts = attempts + 1 WHERE key = ?', args: [key] })
      } else {
        await tx.execute({
          sql: `INSERT INTO auth_rate_limits (key, attempts, expires_at) VALUES (?, 1, ?)
            ON CONFLICT(key) DO UPDATE SET attempts = 1, expires_at = excluded.expires_at`,
          args: [key, expiresAt],
        })
      }
      return true
    })
  }

  async listAccountApps(accountId: string): Promise<AllowlistItem[]> {
    return this.run(async () => {
      const rows = await all<AllowlistRow>(this.client,
        `SELECT allowlist.* FROM allowlist JOIN account_apps USING (package_name)
          WHERE account_apps.account_id = ? ORDER BY display_name COLLATE NOCASE`, [accountId])
      return rows.map(mapAllowlist)
    })
  }

  async addResolvedAccountApp(accountId: string, app: PlaySearchResult, now: string): Promise<AllowlistItem | null> {
    return this.transaction(async (tx) => {
      if (!await first(tx, 'SELECT id FROM accounts WHERE id = ?', [accountId])) return null
      // Retain the existing table as public metadata storage so old libraries
      // survive. It no longer represents curator permissions or publisher trust.
      await tx.execute({
        sql: `INSERT INTO allowlist (package_name, display_name, publisher, reason, signer_sha256, created_at, updated_at)
          VALUES (?, ?, ?, 'Practical tool from Google Play.', NULL, ?, ?)
          ON CONFLICT(package_name) DO UPDATE SET display_name = excluded.display_name,
            publisher = excluded.publisher, updated_at = excluded.updated_at`,
        args: [app.packageName, app.displayName, app.publisher, now, now],
      })
      const added = await tx.execute({
        sql: 'INSERT OR IGNORE INTO account_apps (account_id, package_name, created_at) VALUES (?, ?, ?)',
        args: [accountId, app.packageName, now],
      })
      if (added.rowsAffected === 1) {
        await tx.execute({
          sql: 'UPDATE devices SET revision = revision + 1 WHERE owner_account_id = ? AND revoked_at IS NULL',
          args: [accountId],
        })
      }
      return getAllowlist(tx, app.packageName)
    })
  }

  async listDeviceLibrary(deviceId: string): Promise<DeviceLibraryItem[]> {
    return this.run(async () => {
      const rows = await all<{ package_name: string; display_name: string }>(this.client,
        `SELECT allowlist.package_name, allowlist.display_name FROM devices
          JOIN account_apps ON account_apps.account_id = devices.owner_account_id
          JOIN allowlist ON allowlist.package_name = account_apps.package_name
          WHERE devices.id = ? AND devices.activated_at IS NOT NULL AND devices.revoked_at IS NULL
          ORDER BY allowlist.display_name COLLATE NOCASE`, [deviceId])
      return rows.map((row) => ({ packageName: row.package_name, displayName: row.display_name }))
    })
  }

  async queueLibraryJob(deviceId: string, packageName: string, now: string, ownerAccountId?: string): Promise<JobSummary | null> {
    return this.transaction(async (tx) => {
      const device = await getOwnedDeviceRow(tx, deviceId, ownerAccountId)
      if (!device || !device.activated_at || device.revoked_at || !device.owner_account_id
        || !await hasAccountApp(tx, device.owner_account_id, packageName)) return null
      const app = await getAllowlist(tx, packageName)
      if (!app) return null
      const active = await first<JobRow>(tx, `SELECT * FROM jobs WHERE device_id = ? AND package_name = ?
        AND status IN ('queued', 'delivered', 'installing', 'awaiting_user_action') ORDER BY created_at DESC LIMIT 1`,
      [deviceId, packageName])
      if (active) return mapJob(active)
      // New jobs never copy legacy shared publisher approvals. Android checks
      // the signer of installed versions before accepting an update.
      return insertJob(tx, deviceId, { ...app, signerSha256: null }, randomUUID(), now)
    })
  }

  async addAccountApp(accountId: string, packageName: string, now: string): Promise<AllowlistItem | null> {
    return this.transaction(async (tx) => {
      const allowed = await getAllowlist(tx, packageName)
      if (!allowed || !await first(tx, 'SELECT id FROM accounts WHERE id = ?', [accountId])) return null
      await tx.execute({
        sql: 'INSERT OR IGNORE INTO account_apps (account_id, package_name, created_at) VALUES (?, ?, ?)',
        args: [accountId, packageName, now],
      })
      return allowed
    })
  }

  async removeAccountApp(accountId: string, packageName: string, now: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      const removed = await tx.execute({
        sql: 'DELETE FROM account_apps WHERE account_id = ? AND package_name = ?',
        args: [accountId, packageName],
      })
      if (removed.rowsAffected !== 1) return false
      await tx.execute({
        sql: `UPDATE jobs SET status = 'cancelled', completed_at = ?, report_message = 'Removed from your app collection.'
          WHERE package_name = ? AND status IN ('queued', 'delivered')
            AND device_id IN (SELECT id FROM devices WHERE owner_account_id = ?)`,
        args: [now, packageName, accountId],
      })
      await tx.execute({
        sql: 'UPDATE devices SET revision = revision + 1 WHERE owner_account_id = ? AND revoked_at IS NULL',
        args: [accountId],
      })
      await tx.execute({
        sql: `DELETE FROM assignments WHERE package_name = ?
          AND device_id IN (SELECT id FROM devices WHERE owner_account_id = ?)`,
        args: [packageName, accountId],
      })
      return true
    })
  }

  async getSigningKey(): Promise<PersistedSigningKey | null> {
    return this.run(() => getSigningKey(this.client))
  }

  async getOrCreateSigningKey(now: string): Promise<PersistedSigningKey> {
    // The write lock covers both lookup and first creation, including when
    // multiple server instances start against the same remote database.
    return this.transaction(async (tx) => {
      const existing = await getSigningKey(tx)
      if (existing) return existing
      const key = generateSigningKey()
      await tx.execute({
        sql: 'INSERT INTO server_keys (key_id, public_key_spki, private_key_pkcs8, created_at) VALUES (?, ?, ?, ?)',
        args: [key.keyId, key.publicKeySpki, key.privateKeyPkcs8, now],
      })
      return key
    })
  }

  async listAllowlist(): Promise<AllowlistItem[]> {
    return this.run(async () => {
      const rows = await all<AllowlistRow>(this.client, 'SELECT * FROM allowlist ORDER BY display_name COLLATE NOCASE')
      return rows.map(mapAllowlist)
    })
  }

  async getAllowlist(packageName: string): Promise<AllowlistItem | null> {
    return this.run(() => getAllowlist(this.client, packageName))
  }

  async createAllowlist(item: Omit<AllowlistItem, 'createdAt' | 'updatedAt'>, now: string): Promise<AllowlistItem | null> {
    return this.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `INSERT OR IGNORE INTO allowlist (
          package_name, display_name, publisher, reason, signer_sha256, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [item.packageName, item.displayName, item.publisher, item.reason, item.signerSha256, now, now],
      })
      return result.rowsAffected === 1 ? getAllowlist(tx, item.packageName) : null
    })
  }

  async updateAllowlist(
    packageName: string,
    item: Omit<AllowlistItem, 'packageName' | 'createdAt' | 'updatedAt'>,
    now: string,
  ): Promise<AllowlistItem | null> {
    return this.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `UPDATE allowlist
          SET display_name = ?, publisher = ?, reason = ?, signer_sha256 = ?, updated_at = ?
          WHERE package_name = ?`,
        args: [item.displayName, item.publisher, item.reason, item.signerSha256, now, packageName],
      })
      return result.rowsAffected === 1 ? getAllowlist(tx, packageName) : null
    })
  }

  async deleteAllowlist(packageName: string, now: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      await tx.execute({
        sql: `UPDATE jobs SET status = 'cancelled', completed_at = ?, report_message = 'Removed from the Borealis allowlist.'
          WHERE package_name = ? AND status IN ('queued', 'delivered')`,
        args: [now, packageName],
      })
      await tx.execute({
        sql: `UPDATE devices SET revision = revision + 1
          WHERE id IN (SELECT device_id FROM assignments WHERE package_name = ?)`,
        args: [packageName],
      })
      const result = await tx.execute({ sql: 'DELETE FROM allowlist WHERE package_name = ?', args: [packageName] })
      return result.rowsAffected === 1
    })
  }

  async createPairing(input: {
    id: string
    userCode: string
    userCodeDigest: string
    pollSecretDigest: string
    deviceBearerDigest: string
    deviceLabel: string
    createdAt: string
    expiresAt: string
  }): Promise<void> {
    await this.run(async () => {
      await this.client.execute({
        sql: `INSERT INTO pairings (
          id, user_code, user_code_digest, poll_secret_digest, device_bearer_digest,
          device_label, state, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        args: [input.id, input.userCode, input.userCodeDigest, input.pollSecretDigest,
          input.deviceBearerDigest, input.deviceLabel, input.createdAt, input.expiresAt],
      })
    })
  }

  async getPairing(id: string, pollSecretDigest: string, now: string): Promise<PairingRecord | null> {
    return this.run(async () => {
      const row = await first<PairingRow>(this.client,
        'SELECT * FROM pairings WHERE id = ? AND poll_secret_digest = ?', [id, pollSecretDigest])
      return row ? mapPairing(row, now) : null
    })
  }

  async previewPairing(userCodeDigest: string, now: string): Promise<PairingSummary | null> {
    return this.run(async () => {
      const row = await first<PairingRow>(this.client,
        "SELECT * FROM pairings WHERE user_code_digest = ? AND state = 'pending' AND expires_at > ?", [userCodeDigest, now])
      return row ? pairingSummary(row, now) : null
    })
  }

  async listPairings(now: string, ownerAccountId?: string): Promise<PairingSummary[]> {
    return this.run(async () => {
      const rows = ownerAccountId === undefined
        ? await all<PairingRow>(this.client,
          "SELECT * FROM pairings WHERE state != 'activated' ORDER BY created_at DESC LIMIT 50")
        : await all<PairingRow>(this.client,
          `SELECT pairings.* FROM pairings JOIN devices ON devices.id = pairings.device_id
            WHERE pairings.state = 'approved' AND devices.owner_account_id = ?
            ORDER BY pairings.created_at DESC LIMIT 50`, [ownerAccountId])
      return rows.map((row) => pairingSummary(row, now))
    })
  }

  async approvePairing(userCodeDigest: string, deviceId: string, now: string, ownerAccountId?: string): Promise<PairingRecord | null> {
    return this.transaction(async (tx) => {
      const row = await first<PairingRow>(tx,
        "SELECT * FROM pairings WHERE user_code_digest = ? AND state = 'pending'",
        [userCodeDigest])
      if (!row || row.expires_at <= now) return null
      await tx.execute({
        sql: 'INSERT INTO devices (id, label, bearer_digest, created_at, owner_account_id) VALUES (?, ?, ?, ?, ?)',
        args: [deviceId, row.device_label, row.device_bearer_digest, now, ownerAccountId ?? null],
      })
      await tx.execute({
        sql: "UPDATE pairings SET state = 'approved', device_id = ? WHERE id = ?",
        args: [deviceId, row.id],
      })
      return mapPairing({ ...row, state: 'approved', device_id: deviceId }, now)
    })
  }

  async activatePairing(id: string, pollSecretDigest: string, now: string): Promise<DeviceSummary | null> {
    return this.transaction(async (tx) => {
      const row = await first<PairingRow>(tx,
        'SELECT * FROM pairings WHERE id = ? AND poll_secret_digest = ?', [id, pollSecretDigest])
      const pairing = row ? mapPairing(row, now) : null
      if (!pairing || pairing.state === 'pending' || pairing.state === 'expired' || !pairing.deviceId) return null
      const result = await tx.execute({
        sql: 'UPDATE devices SET activated_at = COALESCE(activated_at, ?) WHERE id = ? AND revoked_at IS NULL',
        args: [now, pairing.deviceId],
      })
      if (result.rowsAffected !== 1) return null
      await tx.execute({ sql: "UPDATE pairings SET state = 'activated' WHERE id = ?", args: [id] })
      return getDevice(tx, pairing.deviceId)
    })
  }

  async authenticateDevice(bearerDigest: string): Promise<DeviceSummary | null> {
    return this.transaction(async (tx) => {
      const row = await first<DeviceRow>(tx, `SELECT * FROM devices
        WHERE bearer_digest = ? AND activated_at IS NOT NULL AND revoked_at IS NULL`, [bearerDigest])
      return row ? mapDevice(tx, row) : null
    }, 'read')
  }

  async getDevice(id: string, ownerAccountId?: string): Promise<DeviceSummary | null> {
    return this.transaction((tx) => getDevice(tx, id, ownerAccountId), 'read')
  }

  async listDevices(ownerAccountId?: string): Promise<DeviceSummary[]> {
    return this.transaction(async (tx) => {
      const ownerFilter = ownerAccountId === undefined ? '' : ' WHERE owner_account_id = ?'
      const ownerArgs = ownerAccountId === undefined ? [] : [ownerAccountId]
      const rows = await all<DeviceRow>(tx, `SELECT * FROM devices${ownerFilter} ORDER BY created_at DESC`, ownerArgs)
      const assignments = await all<{ device_id: string; package_name: string }>(tx,
        `SELECT assignments.device_id, assignments.package_name FROM assignments
          JOIN devices ON devices.id = assignments.device_id${ownerFilter} ORDER BY package_name`, ownerArgs)
      const byDevice = new Map<string, string[]>()
      for (const { device_id, package_name } of assignments) {
        const packages = byDevice.get(device_id) ?? []
        packages.push(package_name)
        byDevice.set(device_id, packages)
      }
      return rows.map((row) => deviceSummary(row, byDevice.get(row.id) ?? []))
    }, 'read')
  }

  async revokeDevice(id: string, now: string, ownerAccountId?: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      const ownerFilter = ownerAccountId === undefined ? '' : ' AND owner_account_id = ?'
      const result = await tx.execute({
        sql: `UPDATE devices SET revoked_at = ?, revision = revision + 1 WHERE id = ? AND revoked_at IS NULL${ownerFilter}`,
        args: ownerAccountId === undefined ? [now, id] : [now, id, ownerAccountId],
      })
      if (result.rowsAffected === 1) {
        await tx.execute({
          sql: `UPDATE jobs SET status = 'cancelled', completed_at = ?, report_message = 'Device access revoked.'
            WHERE device_id = ? AND status IN ('queued', 'delivered')`,
          args: [now, id],
        })
      }
      return result.rowsAffected === 1
    })
  }

  async assignPackage(deviceId: string, packageName: string, now: string, ownerAccountId?: string): Promise<{ created: boolean; job: JobSummary | null } | null> {
    return this.transaction(async (tx) => {
      const device = await getOwnedDeviceRow(tx, deviceId, ownerAccountId)
      const allowed = await getAllowlist(tx, packageName)
      if (!device || device.revoked_at || !allowed) return null
      if (ownerAccountId !== undefined && !await hasAccountApp(tx, ownerAccountId, packageName)) return null
      const result = await tx.execute({
        sql: 'INSERT OR IGNORE INTO assignments (device_id, package_name, created_at) VALUES (?, ?, ?)',
        args: [deviceId, packageName, now],
      })
      const created = result.rowsAffected === 1
      const job = created ? await insertJob(tx, deviceId, allowed, randomUUID(), now) : null
      return { created, job }
    })
  }

  async removeAssignment(deviceId: string, packageName: string, now: string, ownerAccountId?: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      if (ownerAccountId !== undefined && !await getOwnedDeviceRow(tx, deviceId, ownerAccountId)) return false
      const result = await tx.execute({
        sql: 'DELETE FROM assignments WHERE device_id = ? AND package_name = ?',
        args: [deviceId, packageName],
      })
      if (result.rowsAffected === 1) {
        await tx.execute({
          sql: `UPDATE jobs SET status = 'cancelled', completed_at = ?, report_message = 'Assignment removed.'
            WHERE device_id = ? AND package_name = ? AND status IN ('queued', 'delivered')`,
          args: [now, deviceId, packageName],
        })
        await bumpDeviceRevision(tx, deviceId)
      }
      return result.rowsAffected === 1
    })
  }

  async queueJob(deviceId: string, packageName: string, id: string, now: string, ownerAccountId?: string): Promise<JobSummary | null> {
    return this.transaction(async (tx) => {
      const ownerFilter = ownerAccountId === undefined ? '' : ' AND devices.owner_account_id = ?'
      const device = await first<DeviceRow>(tx, `SELECT devices.* FROM devices
        JOIN assignments ON assignments.device_id = devices.id
        WHERE devices.id = ? AND assignments.package_name = ?${ownerFilter}`,
      ownerAccountId === undefined ? [deviceId, packageName] : [deviceId, packageName, ownerAccountId])
      const allowed = await getAllowlist(tx, packageName)
      if (!device || device.revoked_at || !allowed) return null
      if (ownerAccountId !== undefined && !await hasAccountApp(tx, ownerAccountId, packageName)) return null
      return insertJob(tx, deviceId, allowed, id, now)
    })
  }

  async listJobs(deviceId: string, ownerAccountId?: string): Promise<JobSummary[]> {
    return this.run(async () => {
      const ownerFilter = ownerAccountId === undefined ? '' : ' AND devices.owner_account_id = ?'
      const rows = await all<JobRow>(this.client, `SELECT jobs.* FROM jobs
        JOIN devices ON devices.id = jobs.device_id
        WHERE jobs.device_id = ?${ownerFilter} ORDER BY jobs.created_at DESC LIMIT 100`,
      ownerAccountId === undefined ? [deviceId] : [deviceId, ownerAccountId])
      return rows.map(mapJob)
    })
  }

  async listSyncJobs(deviceId: string, now: string): Promise<SyncJobRecord[]> {
    return this.transaction(async (tx) => {
      // Authentication occurs earlier in the HTTP request; check revocation
      // again under the delivery lock before returning install instructions.
      const device = await first<DeviceRow>(tx,
        'SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL', [deviceId])
      if (!device) return []
      await tx.execute({
        sql: `UPDATE jobs SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?)
          WHERE device_id = ? AND status = 'queued'
            AND (? IS NULL OR package_name IN (SELECT package_name FROM account_apps WHERE account_id = ?))`,
        args: [now, deviceId, device.owner_account_id, device.owner_account_id],
      })
      const rows = await all<JobRow>(tx, `SELECT * FROM jobs
        WHERE device_id = ? AND status IN ('queued', 'delivered')
          AND (? IS NULL OR package_name IN (SELECT package_name FROM account_apps WHERE account_id = ?))
        ORDER BY created_at`, [deviceId, device.owner_account_id, device.owner_account_id])
      await tx.execute({ sql: 'UPDATE devices SET last_seen_at = ? WHERE id = ?', args: [now, deviceId] })
      return rows.map((row) => ({
        ...mapJob(row),
        acceptedSignerSha256: JSON.parse(row.accepted_signer_sha256) as string[],
      }))
    })
  }

  async getJob(id: string): Promise<JobSummary | null> {
    return this.run(() => getJob(this.client, id))
  }

  async getJobAcceptedSigners(id: string): Promise<string[]> {
    return this.run(async () => {
      const row = await first<{ accepted_signer_sha256: string }>(this.client,
        'SELECT accepted_signer_sha256 FROM jobs WHERE id = ?', [id])
      return row ? JSON.parse(row.accepted_signer_sha256) as string[] : []
    })
  }

  async reportJob(input: {
    jobId: string
    deviceId: string
    status: JobSummary['status']
    installedVersionCode: number | null
    observedSignerSha256: string[]
    message: string | null
    now: string
  }): Promise<number | null> {
    return this.transaction(async (tx) => {
      const existing = await getJob(tx, input.jobId)
      const device = await first<DeviceRow>(tx,
        'SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL', [input.deviceId])
      if (!existing || existing.deviceId !== input.deviceId || !device) return null
      const terminalStatuses: JobSummary['status'][] = ['review_required', 'succeeded', 'failed', 'cancelled']
      if (terminalStatuses.includes(existing.status)) {
        return existing.status === input.status ? device.revision : null
      }
      const completedAt = terminalStatuses.includes(input.status) ? input.now : null
      const result = await tx.execute({
        sql: `UPDATE jobs
          SET status = ?, installed_version_code = ?, observed_signer_sha256 = ?, report_message = ?, completed_at = ?
          WHERE id = ? AND device_id = ?
            AND status NOT IN ('review_required', 'succeeded', 'failed', 'cancelled')`,
        args: [input.status, input.installedVersionCode, JSON.stringify(input.observedSignerSha256),
          input.message, completedAt, input.jobId, input.deviceId],
      })
      if (result.rowsAffected !== 1) return null
      await bumpDeviceRevision(tx, input.deviceId)
      return device.revision + 1
    })
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.client.protocol !== 'file') return operation()
    const previous = localOperations.get(this.client) ?? Promise.resolve()
    const result = previous.then(operation)
    localOperations.set(this.client, result.then(() => undefined, () => undefined))
    return result
  }

  private transaction<T>(operation: (tx: Transaction) => Promise<T>, mode: TransactionMode = 'write'): Promise<T> {
    return this.run(async () => {
      const tx = await this.client.transaction(mode)
      try {
        const result = await operation(tx)
        await tx.commit()
        return result
      } catch (error) {
        if (!tx.closed) await tx.rollback()
        throw error
      } finally {
        tx.close()
      }
    })
  }
}

async function all<T>(db: Executor, sql: string, args: InValue[] = []): Promise<T[]> {
  return (await db.execute({ sql, args })).rows as unknown as T[]
}

async function first<T>(db: Executor, sql: string, args: InValue[] = []): Promise<T | undefined> {
  return (await all<T>(db, sql, args))[0]
}

async function getSigningKey(db: Executor): Promise<PersistedSigningKey | null> {
  const row = await first<{
    key_id: string
    public_key_spki: ArrayBuffer
    private_key_pkcs8: ArrayBuffer
  }>(db, 'SELECT key_id, public_key_spki, private_key_pkcs8 FROM server_keys ORDER BY created_at LIMIT 1')
  return row ? {
    keyId: row.key_id,
    publicKeySpki: Buffer.from(row.public_key_spki),
    privateKeyPkcs8: Buffer.from(row.private_key_pkcs8),
  } : null
}

async function getAllowlist(db: Executor, packageName: string): Promise<AllowlistItem | null> {
  const row = await first<AllowlistRow>(db, 'SELECT * FROM allowlist WHERE package_name = ?', [packageName])
  return row ? mapAllowlist(row) : null
}

async function getJob(db: Executor, id: string): Promise<JobSummary | null> {
  const row = await first<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [id])
  return row ? mapJob(row) : null
}

async function getOwnedDeviceRow(db: Executor, id: string, ownerAccountId?: string): Promise<DeviceRow | undefined> {
  return ownerAccountId === undefined
    ? first<DeviceRow>(db, 'SELECT * FROM devices WHERE id = ?', [id])
    : first<DeviceRow>(db, 'SELECT * FROM devices WHERE id = ? AND owner_account_id = ?', [id, ownerAccountId])
}

async function getDevice(db: Executor, id: string, ownerAccountId?: string): Promise<DeviceSummary | null> {
  const row = await getOwnedDeviceRow(db, id, ownerAccountId)
  return row ? mapDevice(db, row) : null
}

async function hasAccountApp(db: Executor, accountId: string, packageName: string): Promise<boolean> {
  return Boolean(await first(db, 'SELECT package_name FROM account_apps WHERE account_id = ? AND package_name = ?', [accountId, packageName]))
}

async function insertSession(db: Executor, accountId: string, digest: string, expiresAt: string, now: string): Promise<void> {
  await db.execute({
    sql: 'INSERT INTO account_sessions (digest, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    args: [digest, accountId, now, expiresAt],
  })
}

function mapAccount(row: AccountRow): AccountSummary {
  return { id: row.id, username: row.username, role: row.role, createdAt: row.created_at }
}

function pairingSummary(row: PairingRow, now: string): PairingSummary {
  const pairing = mapPairing(row, now)
  return {
    id: pairing.id,
    userCode: pairing.userCode,
    deviceLabel: pairing.deviceLabel,
    state: pairing.state,
    expiresAt: pairing.expiresAt,
    createdAt: pairing.createdAt,
  }
}

async function mapDevice(db: Executor, row: DeviceRow): Promise<DeviceSummary> {
  const assignments = await all<{ package_name: string }>(db,
    'SELECT package_name FROM assignments WHERE device_id = ? ORDER BY package_name', [row.id])
  return deviceSummary(row, assignments.map(({ package_name }) => package_name))
}

function deviceSummary(row: DeviceRow, assignments: string[]): DeviceSummary {
  return {
    id: row.id,
    label: row.label,
    revision: row.revision,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    assignments,
  }
}

async function insertJob(db: Executor, deviceId: string, allowed: AllowlistItem, id: string, now: string): Promise<JobSummary | null> {
  const acceptedSigners = allowed.signerSha256 ? [allowed.signerSha256] : []
  await db.execute({
    sql: `INSERT INTO jobs (
      id, device_id, package_name, display_name, accepted_signer_sha256, action, status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'install_or_update', 'queued', ?)`,
    args: [id, deviceId, allowed.packageName, allowed.displayName, JSON.stringify(acceptedSigners), now],
  })
  await bumpDeviceRevision(db, deviceId)
  return getJob(db, id)
}

async function bumpDeviceRevision(db: Executor, deviceId: string): Promise<void> {
  await db.execute({ sql: 'UPDATE devices SET revision = revision + 1 WHERE id = ?', args: [deviceId] })
}

function mapAllowlist(row: AllowlistRow): AllowlistItem {
  return {
    packageName: row.package_name,
    displayName: row.display_name,
    publisher: row.publisher,
    reason: row.reason,
    signerSha256: row.signer_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapPairing(row: PairingRow, now: string): PairingRecord {
  return {
    id: row.id,
    userCode: row.user_code,
    deviceLabel: row.device_label,
    state: row.expires_at <= now && row.state !== 'activated' ? 'expired' : row.state as PairingSummary['state'],
    deviceId: row.device_id,
    deviceBearerDigest: row.device_bearer_digest,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

function mapJob(row: JobRow): JobSummary {
  return {
    id: row.id,
    deviceId: row.device_id,
    packageName: row.package_name,
    displayName: row.display_name,
    action: row.action,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    completedAt: row.completed_at,
    installedVersionCode: row.installed_version_code,
    observedSignerSha256: row.observed_signer_sha256 ? JSON.parse(row.observed_signer_sha256) as string[] : [],
    message: row.report_message,
  }
}
