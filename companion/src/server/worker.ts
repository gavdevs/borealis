import { createClient } from '@libsql/client/web'
import { createBorealisApp } from './app.js'
import { loadWorkerConfig } from './config.js'
import { BorealisDatabase } from './db.js'
import { GooglePlayWebSearchProvider } from './play-search.js'

const API_PREFIX = '/api'

export async function fetchBorealisWorker(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname
  if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) {
    return await env.ASSETS.fetch(request)
  }

  const clientAddress = trustedCloudflareClientAddress(request)
  if (!clientAddress) {
    return Response.json({ error: 'A trusted Cloudflare client address is required.' }, {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  let database: BorealisDatabase | undefined
  try {
    const { success } = await env.API_RATE_LIMIT.limit({ key: clientAddress })
    if (!success) return rateLimited()

    const config = loadWorkerConfig(env)
    const client = createClient({
      url: config.tursoDatabaseUrl,
      authToken: config.tursoAuthToken,
    })
    database = new BorealisDatabase(client)

    const signingKey = await database.getSigningKey()
    if (!signingKey) {
      return serviceUnavailable('Borealis has not been initialized. Run the database migration before deploying.')
    }

    const app = await createBorealisApp({
      config,
      database,
      signingKey,
      passwordRuntime: 'worker',
      playSearch: new GooglePlayWebSearchProvider(config.playLanguage, config.playCountry),
      clientAddress: () => clientAddress,
    })
    const response = await app.fetch(request)
    // Keep malformed and future API routes out of browser/CDN caches too; the
    // app-level middleware already applies this to the current API namespace.
    response.headers.set('Cache-Control', 'no-store')
    return response
  } catch (error) {
    logWorkerError('request_failed', error)
    return serviceUnavailable('Borealis is temporarily unavailable.')
  } finally {
    if (database) {
      try {
        database.close()
      } catch (error) {
        logWorkerError('database_close_failed', error)
      }
    }
  }
}

export function trustedCloudflareClientAddress(request: Request): string | null {
  const address = request.headers.get('CF-Connecting-IP')?.trim()
  return address && address.length <= 45 ? address : null
}

function rateLimited(): Response {
  return Response.json({ error: 'Too many requests. Try again later.' }, {
    status: 429,
    headers: {
      'Cache-Control': 'no-store',
      'Retry-After': '60',
    },
  })
}

function serviceUnavailable(message: string): Response {
  return Response.json({ error: message }, {
    status: 503,
    headers: {
      'Cache-Control': 'no-store',
      'Retry-After': '5',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function logWorkerError(event: string, error: unknown): void {
  console.error(JSON.stringify({
    event,
    error: error instanceof Error ? error.name : 'UnknownError',
  }))
}

export default {
  fetch: fetchBorealisWorker,
} satisfies ExportedHandler<Env>
