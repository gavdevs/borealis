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
  "keyId": "sha256 fingerprint",
  "payload": "exact serialized JSON string",
  "signature": "base64url Ed25519 signature over payload UTF-8 bytes"
}
```

The v1 payload names the schema version, job and device IDs, `install_or_update` action, package and display names, accepted signer SHA-256 values, issue and expiry times, and nonce.

`POST /device/jobs/:jobId/report` records `downloading`, `review_required`, `awaiting_user_action`, `installed`, or `failed`, plus observed version/signer details where relevant.
