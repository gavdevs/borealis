import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { AllowlistItem, DeviceSummary, JobSummary, PairingSummary } from '../shared/api.js'
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
  label: string
  bearer_digest: string
  revision: number
  created_at: string
  activated_at: string | null
  last_seen_at: string | null
  revoked_at: string | null
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

export class BorealisDatabase {
  readonly sqlite: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.sqlite = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.sqlite.exec('PRAGMA foreign_keys = ON')
    if (path !== ':memory:') this.sqlite.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  close(): void {
    this.sqlite.close()
  }

  private migrate(): void {
    this.sqlite.exec(`
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
    `)
  }

  getOrCreateSigningKey(now: string): PersistedSigningKey {
    const existing = this.sqlite.prepare(
      'SELECT key_id, public_key_spki, private_key_pkcs8 FROM server_keys ORDER BY created_at LIMIT 1',
    ).get() as { key_id: string; public_key_spki: Uint8Array; private_key_pkcs8: Uint8Array } | undefined

    if (existing) {
      return {
        keyId: existing.key_id,
        publicKeySpki: Buffer.from(existing.public_key_spki),
        privateKeyPkcs8: Buffer.from(existing.private_key_pkcs8),
      }
    }

    const key = generateSigningKey()
    this.sqlite.prepare(
      'INSERT INTO server_keys (key_id, public_key_spki, private_key_pkcs8, created_at) VALUES (?, ?, ?, ?)',
    ).run(key.keyId, key.publicKeySpki, key.privateKeyPkcs8, now)
    return key
  }

  listAllowlist(): AllowlistItem[] {
    const rows = this.sqlite.prepare('SELECT * FROM allowlist ORDER BY display_name COLLATE NOCASE').all() as AllowlistRow[]
    return rows.map(mapAllowlist)
  }

  getAllowlist(packageName: string): AllowlistItem | null {
    const row = this.sqlite.prepare('SELECT * FROM allowlist WHERE package_name = ?').get(packageName) as AllowlistRow | undefined
    return row ? mapAllowlist(row) : null
  }

  createAllowlist(item: Omit<AllowlistItem, 'createdAt' | 'updatedAt'>, now: string): AllowlistItem | null {
    const result = this.sqlite.prepare(`
      INSERT OR IGNORE INTO allowlist (
        package_name, display_name, publisher, reason, signer_sha256, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(item.packageName, item.displayName, item.publisher, item.reason, item.signerSha256, now, now)
    return result.changes === 1 ? this.getAllowlist(item.packageName) : null
  }

  updateAllowlist(
    packageName: string,
    item: Omit<AllowlistItem, 'packageName' | 'createdAt' | 'updatedAt'>,
    now: string,
  ): AllowlistItem | null {
    const result = this.sqlite.prepare(`
      UPDATE allowlist
      SET display_name = ?, publisher = ?, reason = ?, signer_sha256 = ?, updated_at = ?
      WHERE package_name = ?
    `).run(item.displayName, item.publisher, item.reason, item.signerSha256, now, packageName)
    return result.changes === 1 ? this.getAllowlist(packageName) : null
  }

  deleteAllowlist(packageName: string, now: string): boolean {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const devices = this.sqlite.prepare('SELECT device_id FROM assignments WHERE package_name = ?').all(packageName) as Array<{ device_id: string }>
      this.sqlite.prepare(`
        UPDATE jobs SET status = 'cancelled', completed_at = ?, report_message = 'Removed from the Borealis allowlist.'
        WHERE package_name = ? AND status IN ('queued', 'delivered')
      `).run(now, packageName)
      const result = this.sqlite.prepare('DELETE FROM allowlist WHERE package_name = ?').run(packageName)
      if (result.changes === 1) {
        const update = this.sqlite.prepare('UPDATE devices SET revision = revision + 1 WHERE id = ?')
        devices.forEach(({ device_id }) => update.run(device_id))
      }
      this.sqlite.exec('COMMIT')
      return result.changes === 1
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  createPairing(input: {
    id: string
    userCode: string
    userCodeDigest: string
    pollSecretDigest: string
    deviceBearerDigest: string
    deviceLabel: string
    createdAt: string
    expiresAt: string
  }): void {
    this.sqlite.prepare(`
      INSERT INTO pairings (
        id, user_code, user_code_digest, poll_secret_digest, device_bearer_digest,
        device_label, state, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      input.id,
      input.userCode,
      input.userCodeDigest,
      input.pollSecretDigest,
      input.deviceBearerDigest,
      input.deviceLabel,
      input.createdAt,
      input.expiresAt,
    )
  }

  getPairing(id: string, pollSecretDigest: string, now: string): PairingRecord | null {
    const row = this.sqlite.prepare(
      'SELECT * FROM pairings WHERE id = ? AND poll_secret_digest = ?',
    ).get(id, pollSecretDigest) as PairingRow | undefined
    return row ? mapPairing(row, now) : null
  }

  listPairings(now: string): PairingSummary[] {
    const rows = this.sqlite.prepare(
      "SELECT * FROM pairings WHERE state != 'activated' ORDER BY created_at DESC LIMIT 50",
    ).all() as PairingRow[]
    return rows.map((row) => {
      const pairing = mapPairing(row, now)
      return {
        id: pairing.id,
        userCode: pairing.userCode,
        deviceLabel: pairing.deviceLabel,
        state: pairing.state,
        expiresAt: pairing.expiresAt,
        createdAt: pairing.createdAt,
      }
    })
  }

  approvePairing(userCodeDigest: string, deviceId: string, now: string): PairingRecord | null {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const row = this.sqlite.prepare(
        "SELECT * FROM pairings WHERE user_code_digest = ? AND state = 'pending'",
      ).get(userCodeDigest) as PairingRow | undefined
      if (!row || row.expires_at <= now) {
        this.sqlite.exec('ROLLBACK')
        return null
      }

      this.sqlite.prepare(`
        INSERT INTO devices (id, label, bearer_digest, created_at)
        VALUES (?, ?, ?, ?)
      `).run(deviceId, row.device_label, row.device_bearer_digest, now)
      this.sqlite.prepare(
        "UPDATE pairings SET state = 'approved', device_id = ? WHERE id = ?",
      ).run(deviceId, row.id)
      this.sqlite.exec('COMMIT')
      return this.getPairing(row.id, row.poll_secret_digest, now)
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  activatePairing(id: string, pollSecretDigest: string, now: string): DeviceSummary | null {
    const pairing = this.getPairing(id, pollSecretDigest, now)
    if (!pairing || pairing.state === 'pending' || pairing.state === 'expired' || !pairing.deviceId) return null

    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      this.sqlite.prepare(
        'UPDATE devices SET activated_at = COALESCE(activated_at, ?) WHERE id = ? AND revoked_at IS NULL',
      ).run(now, pairing.deviceId)
      this.sqlite.prepare("UPDATE pairings SET state = 'activated' WHERE id = ?").run(id)
      this.sqlite.exec('COMMIT')
      return this.getDevice(pairing.deviceId)
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  authenticateDevice(bearerDigest: string): DeviceSummary | null {
    const row = this.sqlite.prepare(`
      SELECT * FROM devices
      WHERE bearer_digest = ? AND activated_at IS NOT NULL AND revoked_at IS NULL
    `).get(bearerDigest) as DeviceRow | undefined
    return row ? this.mapDevice(row) : null
  }

  getDevice(id: string): DeviceSummary | null {
    const row = this.sqlite.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined
    return row ? this.mapDevice(row) : null
  }

  listDevices(): DeviceSummary[] {
    const rows = this.sqlite.prepare('SELECT * FROM devices ORDER BY created_at DESC').all() as DeviceRow[]
    return rows.map((row) => this.mapDevice(row))
  }

  private mapDevice(row: DeviceRow): DeviceSummary {
    const assignments = this.sqlite.prepare(
      'SELECT package_name FROM assignments WHERE device_id = ? ORDER BY package_name',
    ).all(row.id) as Array<{ package_name: string }>
    return {
      id: row.id,
      label: row.label,
      revision: row.revision,
      createdAt: row.created_at,
      activatedAt: row.activated_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      assignments: assignments.map(({ package_name }) => package_name),
    }
  }

  revokeDevice(id: string, now: string): boolean {
    const result = this.sqlite.prepare(`
      UPDATE devices SET revoked_at = ?, revision = revision + 1
      WHERE id = ? AND revoked_at IS NULL
    `).run(now, id)
    if (result.changes === 1) {
      this.sqlite.prepare(`
        UPDATE jobs SET status = 'cancelled', completed_at = ?, report_message = 'Device access revoked.'
        WHERE device_id = ? AND status IN ('queued', 'delivered')
      `).run(now, id)
    }
    return result.changes === 1
  }

  assignPackage(deviceId: string, packageName: string, now: string): { created: boolean; job: JobSummary | null } | null {
    const device = this.getDevice(deviceId)
    const allowed = this.getAllowlist(packageName)
    if (!device || device.revokedAt || !allowed) return null

    const result = this.sqlite.prepare(
      'INSERT OR IGNORE INTO assignments (device_id, package_name, created_at) VALUES (?, ?, ?)',
    ).run(deviceId, packageName, now)
    const created = result.changes === 1
    const job = created ? this.queueJob(deviceId, packageName, randomUUID(), now) : null
    return { created, job }
  }

  removeAssignment(deviceId: string, packageName: string, now: string): boolean {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const result = this.sqlite.prepare(
        'DELETE FROM assignments WHERE device_id = ? AND package_name = ?',
      ).run(deviceId, packageName)
      if (result.changes === 1) {
        this.sqlite.prepare(`
          UPDATE jobs SET status = 'cancelled', completed_at = ?, report_message = 'Assignment removed.'
          WHERE device_id = ? AND package_name = ? AND status IN ('queued', 'delivered')
        `).run(now, deviceId, packageName)
        this.bumpDeviceRevision(deviceId)
      }
      this.sqlite.exec('COMMIT')
      return result.changes === 1
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  queueJob(deviceId: string, packageName: string, id: string, now: string): JobSummary | null {
    const device = this.getDevice(deviceId)
    const allowed = this.getAllowlist(packageName)
    if (!device || device.revokedAt || !allowed || !device.assignments.includes(packageName)) return null

    const acceptedSignerSha256 = allowed.signerSha256 ? [allowed.signerSha256] : []
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      this.sqlite.prepare(`
        INSERT INTO jobs (
          id, device_id, package_name, display_name, accepted_signer_sha256,
          action, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'install_or_update', 'queued', ?)
      `).run(id, deviceId, packageName, allowed.displayName, JSON.stringify(acceptedSignerSha256), now)
      this.bumpDeviceRevision(deviceId)
      this.sqlite.exec('COMMIT')
      return this.getJob(id)
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  listJobs(deviceId: string): JobSummary[] {
    const rows = this.sqlite.prepare(
      'SELECT * FROM jobs WHERE device_id = ? ORDER BY created_at DESC LIMIT 100',
    ).all(deviceId) as JobRow[]
    return rows.map(mapJob)
  }

  listSyncJobs(deviceId: string, now: string): SyncJobRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM jobs
      WHERE device_id = ? AND status IN ('queued', 'delivered')
      ORDER BY created_at
    `).all(deviceId) as JobRow[]
    if (rows.some((row) => row.status === 'queued')) {
      this.sqlite.prepare(`
        UPDATE jobs SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?)
        WHERE device_id = ? AND status = 'queued'
      `).run(now, deviceId)
    }
    this.sqlite.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, deviceId)
    return rows.map((row) => ({
      ...mapJob({ ...row, status: row.status === 'queued' ? 'delivered' : row.status }),
      acceptedSignerSha256: JSON.parse(row.accepted_signer_sha256) as string[],
    }))
  }

  getJob(id: string): JobSummary | null {
    const row = this.sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    return row ? mapJob(row) : null
  }

  getJobAcceptedSigners(id: string): string[] {
    const row = this.sqlite.prepare(
      'SELECT accepted_signer_sha256 FROM jobs WHERE id = ?',
    ).get(id) as { accepted_signer_sha256: string } | undefined
    return row ? JSON.parse(row.accepted_signer_sha256) as string[] : []
  }

  reportJob(input: {
    jobId: string
    deviceId: string
    status: JobSummary['status']
    installedVersionCode: number | null
    observedSignerSha256: string[]
    message: string | null
    now: string
  }): number | null {
    const existing = this.getJob(input.jobId)
    if (!existing || existing.deviceId !== input.deviceId) return null
    const terminalStatuses: JobSummary['status'][] = ['review_required', 'succeeded', 'failed', 'cancelled']
    if (terminalStatuses.includes(existing.status)) {
      return existing.status === input.status ? this.getDevice(input.deviceId)?.revision ?? null : null
    }
    const completedAt = ['review_required', 'succeeded', 'failed', 'cancelled'].includes(input.status) ? input.now : null
    const result = this.sqlite.prepare(`
      UPDATE jobs
      SET status = ?, installed_version_code = ?, observed_signer_sha256 = ?, report_message = ?, completed_at = ?
      WHERE id = ? AND device_id = ?
        AND status NOT IN ('review_required', 'succeeded', 'failed', 'cancelled')
    `).run(
      input.status,
      input.installedVersionCode,
      JSON.stringify(input.observedSignerSha256),
      input.message,
      completedAt,
      input.jobId,
      input.deviceId,
    )
    if (result.changes !== 1) return null
    this.bumpDeviceRevision(input.deviceId)
    return this.getDevice(input.deviceId)?.revision ?? null
  }

  private bumpDeviceRevision(deviceId: string): void {
    this.sqlite.prepare('UPDATE devices SET revision = revision + 1 WHERE id = ?').run(deviceId)
  }
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
