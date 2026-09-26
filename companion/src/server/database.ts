import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient as createWebClient } from '@libsql/client/web'
import type { Client } from '@libsql/client'
import type { BorealisConfig } from './config.js'
import { BorealisDatabase } from './db.js'

type DatabaseConfig = Pick<BorealisConfig, 'databasePath' | 'tursoDatabaseUrl' | 'tursoAuthToken'>

export async function openDatabase(config: DatabaseConfig): Promise<BorealisDatabase> {
  let client: Client
  let localPath: string | undefined
  if (config.tursoDatabaseUrl || config.tursoAuthToken) {
    if (!config.tursoDatabaseUrl || !config.tursoAuthToken) {
      throw new Error('Both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required for Turso.')
    }
    // Use the fetch-based driver; no native SQLite dependency enters this path.
    client = createWebClient({ url: config.tursoDatabaseUrl, authToken: config.tursoAuthToken })
  } else {
    const { createClient } = await import('@libsql/client')
    if (config.databasePath === ':memory:') {
      client = createClient({ url: ':memory:', concurrency: 1 })
    } else {
      const path = resolve(config.databasePath)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      client = createClient({ url: pathToFileURL(path).href, concurrency: 1 })
      localPath = path
    }
  }

  const database = new BorealisDatabase(client)
  try {
    if (localPath && existsSync(localPath)) chmodSync(localPath, 0o600)
    await database.migrate()
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
