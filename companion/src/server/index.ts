import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { loadConfig } from './config.js'
import { openDatabase } from './database.js'
import { createBorealisApp } from './app.js'
import { GooglePlayWebSearchProvider } from './play-search.js'

const config = loadConfig()
const database = await openDatabase(config)
const playSearch = new GooglePlayWebSearchProvider(config.playLanguage, config.playCountry)
const app = await createBorealisApp({
  config, database, playSearch,
  clientAddress: (context) => getConnInfo(context).remote.address ?? 'unavailable',
}).catch((error: unknown) => {
  database.close()
  throw error
})
const clientRoot = resolve(process.cwd(), 'dist/client')

if (existsSync(clientRoot)) {
  app.use('/assets/*', serveStatic({ root: clientRoot }))
  app.get('*', serveStatic({ path: resolve(clientRoot, 'index.html') }))
}

const server = serve({
  fetch: app.fetch,
  hostname: config.host ?? '127.0.0.1',
  port: config.port,
}, (info) => {
  console.log(`Borealis companion listening on http://localhost:${info.port}`)
})

function shutdown(): void {
  server.close(() => {
    database.close()
    process.exit(0)
  })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
