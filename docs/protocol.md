# Borealis device protocol v1

All routes are rooted at `/api/borealis/v1`. JSON responses use UTF-8 and device routes require `Authorization: Bearer <device token>`.

## Pairing

- `POST /pairings` creates a short-lived code from a device label and the SHA-256 digest of a device bearer.
- `GET /pairings/:id` polls with the pairing poll secret.
- `POST /pairings/:id/activate` activates an approved pairing and returns the device ID plus the companion's Ed25519 public key and key ID.

The raw device bearer is generated and retained only by the phone.

## Sync

`GET /device/sync` returns a monotonic revision and signed jobs. A signed job envelope is:

```json
{
  "keyId": "ed25519:<first 24 lowercase hex characters of SHA-256(SPKI DER)>",
  "payload": "exact serialized JSON string",
  "signature": "base64url Ed25519 signature over payload UTF-8 bytes"
}
```

The key ID is the literal `ed25519:` prefix followed by the first 24 lowercase
hexadecimal characters of SHA-256 over the complete DER-encoded SubjectPublicKeyInfo
public key. It is not the full 64-character fingerprint. Pairing pins both this ID
and the complete public key (encoded as unpadded base64url). A phone must match the
envelope ID to that pairing, recompute the ID from the pinned SPKI bytes, and verify
the signature using the complete Ed25519 public key. The ID is a key identifier,
not a substitute for signature verification; existing key rows and pairings must
not be regenerated to correct a client-side format mismatch.

The Android verifier requires the RFC 8410 Ed25519 SPKI encoding: the exact
12-byte prefix `302a300506032b6570032100` followed by 32 public-key bytes. It uses
the pinned Tink implementation to verify the exact UTF-8 payload; it does not
depend on the phone providing an Ed25519 `KeyFactory` (the LP3 does not).

The v1 payload names the schema version, job and device IDs, `install_or_update` action, package and display names, accepted signer SHA-256 values, issue and expiry times, and nonce.

`POST /device/jobs/:jobId/report` records `downloading`, `review_required`, `awaiting_user_action`, `installed`, or `failed`, plus observed version/signer details where relevant.
