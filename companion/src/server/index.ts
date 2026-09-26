import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { loadConfig } from './config.js'
import { BorealisDatabase } from './db.js'
import { createBorealisApp } from './app.js'
import { GooglePlayWebSearchProvider } from './play-search.js'

const config = loadConfig()
const database = new BorealisDatabase(config.databasePath)
const playSearch = new GooglePlayWebSearchProvider(config.playLanguage, config.playCountry)
const app = createBorealisApp({ config, database, playSearch })
const clientRoot = resolve(process.cwd(), 'dist/client')

if (existsSync(clientRoot)) {
  app.use('/assets/*', serveStatic({ root: clientRoot }))
  app.get('*', serveStatic({ path: resolve(clientRoot, 'index.html') }))
}

const server = serve({
  fetch: app.fetch,
  hostname: '0.0.0.0',
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
