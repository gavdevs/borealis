#!/usr/bin/env node
// Run from any directory. Private material stays outside tracked source.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = resolve(root, '.secrets')
const keystore = resolve(directory, 'borealis-release.p12')
const passwordFile = resolve(directory, 'borealis-release-password')
const alias = 'borealis'
const upload = process.argv.includes('--upload')
if (process.argv.slice(2).some((argument) => argument !== '--upload')) {
  throw new Error('Usage: node scripts/setup-signing.mjs [--upload]')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0) {
    // Do not echo command output: a credential tool could include sensitive data.
    throw new Error(`${command} failed (exit ${result.status ?? 'unavailable'}). No secret output was printed.`)
  }
  return result.stdout
}

mkdirSync(directory, { recursive: true, mode: 0o700 })
chmodSync(directory, 0o700)
for (const path of [keystore, passwordFile]) {
  run('git', ['check-ignore', '--quiet', path], { cwd: root })
}
if (existsSync(keystore) !== existsSync(passwordFile)) {
  throw new Error('Incomplete signing material exists. Restore its matching backup; do not replace an established signing identity.')
}
const existed = existsSync(keystore)
if (!existed) {
  const password = randomBytes(48).toString('base64url')
  writeFileSync(passwordFile, `${password}\n`, { flag: 'wx', mode: 0o600 })
  run('keytool', [
    '-genkeypair', '-noprompt', '-keystore', keystore, '-storetype', 'PKCS12',
    '-storepass:env', 'BOREALIS_KEYTOOL_PASSWORD', '-keypass:env', 'BOREALIS_KEYTOOL_PASSWORD',
    '-alias', alias, '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000',
    '-dname', 'CN=Borealis, OU=Android Release',
  ], { env: { ...process.env, BOREALIS_KEYTOOL_PASSWORD: password } })
}
chmodSync(keystore, 0o600)
chmodSync(passwordFile, 0o600)
const password = readFileSync(passwordFile, 'utf8').trim()
const certificate = run('keytool', [
  '-exportcert', '-keystore', keystore, '-storepass:env', 'BOREALIS_KEYTOOL_PASSWORD', '-alias', alias,
], { env: { ...process.env, BOREALIS_KEYTOOL_PASSWORD: password } })
const fingerprint = createHash('sha256').update(certificate).digest('hex')
if (upload) {
  const secrets = {
    BOREALIS_RELEASE_KEYSTORE_BASE64: readFileSync(keystore).toString('base64'),
    BOREALIS_RELEASE_STORE_PASSWORD: password,
    BOREALIS_RELEASE_KEY_PASSWORD: password,
    BOREALIS_RELEASE_KEY_ALIAS: alias,
    BOREALIS_RELEASE_CERT_SHA256: fingerprint,
  }
  for (const [name, value] of Object.entries(secrets)) {
    run('gh', ['secret', 'set', name, '--repo', 'gavdevs/borealis'], { input: value })
    console.log(`Configured ${name}.`)
  }
}
console.log(`${existed ? 'Reused' : 'Created'} the Borealis release identity.`)
console.log(`Certificate SHA-256: ${fingerprint}`)
console.log(`Back up both ${keystore} and ${passwordFile} securely off this machine.`)
console.log('GitHub secrets are not a recoverable backup. Losing this key prevents updates to installed release APKs.')
