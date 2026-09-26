import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { generateSigningKey } from './crypto.js'
import { openDatabase } from './database.js'
import type { BorealisDatabase } from './db.js'

const directories: string[] = []
const databases: BorealisDatabase[] = []
const NOW = '2026-09-25T12:00:00.000Z'

afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

describe('database connection', () => {
  it('preserves an existing node:sqlite signing identity and persists data across reconnects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'borealis-database-test-'))
    directories.push(directory)
    const path = join(directory, 'existing.sqlite')
    const key = generateSigningKey()
    const legacy = new DatabaseSync(path)
    try {
      legacy.exec(`CREATE TABLE server_keys (
        key_id TEXT PRIMARY KEY, public_key_spki BLOB NOT NULL,
        private_key_pkcs8 BLOB NOT NULL, created_at TEXT NOT NULL
      )`)
      legacy.prepare('INSERT INTO server_keys VALUES (?, ?, ?, ?)')
        .run(key.keyId, key.publicKeySpki, key.privateKeyPkcs8, NOW)
    } finally {
      legacy.close()
    }

    const first = await openDatabase({ databasePath: path })
    databases.push(first)
    expect(await first.getOrCreateSigningKey(NOW)).toEqual(key)
    await first.createAllowlist({ packageName: 'example.bank', displayName: 'Test bank', publisher: 'Test publisher', reason: 'Test fixture', signerSha256: null }, NOW)
    first.close()
    databases.pop()

    const second = await openDatabase({ databasePath: path })
    databases.push(second)
    expect(await second.getOrCreateSigningKey(NOW)).toEqual(key)
    expect(await second.listAllowlist()).toMatchObject([{ packageName: 'example.bank' }])
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('supports an isolated local in-memory database', async () => {
    const database = await openDatabase({ databasePath: ':memory:' })
    databases.push(database)
    expect(await database.listDevices()).toEqual([])
  })

  it('never silently falls back to local storage with partial remote credentials', async () => {
    await expect(openDatabase({ databasePath: ':memory:', tursoDatabaseUrl: 'libsql://example.turso.io' }))
      .rejects.toThrow('Both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required')
    await expect(openDatabase({ databasePath: ':memory:', tursoAuthToken: 'fixture-token' }))
      .rejects.toThrow('Both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required')
  })
})
