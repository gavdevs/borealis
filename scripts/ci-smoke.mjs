// Read-only production smoke checks; never create an account or pairing.
const origin = 'https://borealis.loosewire.dev'
async function request(path, expectedStatus) {
  const response = await fetch(`${origin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (response.status !== expectedStatus) throw new Error(`${path}: expected ${expectedStatus}, received ${response.status}`)
  return response
}
const health = await (await request('/api/borealis/v1/health', 200)).json()
if (health.status !== 'ok' || health.service !== 'borealis') throw new Error('Unexpected health response')
const session = await (await request('/api/borealis/v1/auth/session', 200)).json()
if (session.account !== null) throw new Error('Anonymous request received an account')
await request('/api/borealis/v1/me/devices', 401)
await request('/api/borealis/v1/admin/allowlist', 401)
const page = await request('/', 200)
const html = await page.text()
if (!page.headers.get('content-type')?.includes('text/html') || !html.includes('id="root"')) throw new Error('Companion HTML is missing')
const script = html.match(/<script[^>]+src="(\/assets\/[^"?#]+\.js)"/)?.[1]
if (!script) throw new Error('Companion JavaScript entrypoint is missing')
const asset = await request(script, 200)
if (!asset.headers.get('content-type')?.includes('javascript')) throw new Error('Companion asset returned something other than JavaScript')
if (!page.headers.get('content-security-policy')) throw new Error('Companion security policy is missing')
await request('/api/unknown', 404)
console.log('Production health, anonymous session, access controls, HTML, JavaScript, and security headers passed.')
