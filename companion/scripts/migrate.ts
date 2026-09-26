import { createClient } from '@libsql/client/web'
import { loadTursoConfig } from '../src/server/config.js'
import { BorealisDatabase } from '../src/server/db.js'

let database: BorealisDatabase | undefined

try {
  const config = loadTursoConfig(process.env)
  database = new BorealisDatabase(createClient({
    url: config.tursoDatabaseUrl,
    authToken: config.tursoAuthToken,
  }))
  await database.migrate()
  await database.getOrCreateSigningKey(new Date().toISOString())
  console.log('Borealis database migration and signing-key initialization completed.')
} catch (error) {
  console.error('Borealis database migration failed.', error instanceof Error ? error.name : 'UnknownError')
  process.exitCode = 1
} finally {
  try {
    database?.close()
  } catch (error) {
    console.error('Borealis database cleanup failed.', error instanceof Error ? error.name : 'UnknownError')
    process.exitCode = 1
  }
}
