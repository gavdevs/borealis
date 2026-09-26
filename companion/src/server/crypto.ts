import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto'

export type PersistedSigningKey = {
  keyId: string
  publicKeySpki: Buffer
  privateKeyPkcs8: Buffer
}

export function generateSigningKey(): PersistedSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeySpki = publicKey.export({ type: 'spki', format: 'der' })
  const privateKeyPkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' })
  const fingerprint = createHash('sha256').update(publicKeySpki).digest('hex')
  return {
    keyId: `ed25519:${fingerprint.slice(0, 24)}`,
    publicKeySpki,
    privateKeyPkcs8,
  }
}

export function privateKeyFromPkcs8(value: Buffer): KeyObject {
  return createPrivateKey({ key: value, type: 'pkcs8', format: 'der' })
}

export function signPayload(payload: string, privateKey: KeyObject): string {
  return sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function randomBearer(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url')
}

export function randomNonce(): string {
  return randomBytes(18).toString('base64url')
}

const USER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateUserCode(): string {
  const bytes = randomBytes(12)
  const value = Array.from(bytes, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join('')
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`
}

export function normalizeUserCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[O]/g, '0')
    .replace(/[IL]/g, '1')
}

export function secureStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest()
  const rightDigest = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(leftDigest, rightDigest)
}
