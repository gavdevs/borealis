# Borealis companion

Borealis is a personal, positive-allowlist control plane for the Borealis Light
Phone installer. Search and policy live here; the phone receives only explicit,
short-lived install jobs for packages assigned to that device.

This service never proxies APK bytes and never accepts or stores Google account
credentials. Catalog search reads public Google Play web metadata. The phone is
responsible for obtaining the device-appropriate base and split APKs directly,
verifying the Play-provided hashes, verifying package identity and signer pins,
and invoking Android's installer.

## Interface reference

The companion follows the Lightious server's Light Phone visual language:
monochrome light/dark themes, system sans-serif typography, ruled lists,
underlined fields, and restrained text actions. Do not reintroduce decorative
colors, display-serif fonts, dashboard cards, or a three-panel admin console.

The chosen Borealis mark is **North**: an open ring with a north-east arrow,
from `../design/icon-studies/north.svg`. Keep its geometry consistent in the
inline header SVG and `public/assets/borealis.svg` favicon. It remains monochrome and
visible at mobile sizes; the adjacent wordmark supplies its accessible name.

- **Home:** connected phones and installation/update activity.
- **Apps:** search, select results, add to your apps, then select and send to a phone.
- **Pairing:** enter a code, preview the requesting phone, explicitly approve it.
- Package identifiers, signing fingerprints, and request diagnostics belong in
  expandable details, not the default workflow.

This is a React/TypeScript interface with Vite and plain CSS. The existing Hono,
Node.js, SQLite, and signed-job protocol remain unchanged. Admin-token login is
still the prototype's authentication mechanism, not a new account system.

## Run locally

Requirements: Node.js 22.12 or newer and pnpm 11.

```sh
cp .env.example .env
# Edit .env and set a long random BOREALIS_ADMIN_TOKEN.
set -a
source .env
set +a
pnpm install
pnpm dev
```

In a second terminal, run `pnpm dev:web` and open
`http://127.0.0.1:5173`. Vite forwards `/api` to the Hono service on port 8787.
The admin token is stored only in `sessionStorage`; closing the browser tab ends
that browser session.

For a production-style build:

```sh
pnpm build
pnpm start
```

The Hono server serves the built React client from `dist/client`. Keep
`BOREALIS_DATABASE_PATH` on persistent storage: the SQLite database contains
the allowlist, device credential hashes, jobs, and the generated Ed25519
signing key. Back it up as one unit. No plaintext phone bearer or poll secret is
stored.

## Trust model

- Admission is a positive allowlist. Search results, Play categories, and a
  device request never approve a package automatically.
- The phone creates its own `brl_device_…` bearer and sends only its SHA-256
  digest during pairing.
- The server generates an Ed25519 key once and persists it in SQLite. Pairing
  activation returns the public key and key ID to the phone.
- Every sync envelope contains the exact JSON payload string plus an unpadded
  base64url Ed25519 signature. The phone must verify the raw UTF-8 payload bytes
  before decoding JSON.
- Signed payloads are device-bound, nonce-bearing, and expire after
  `BOREALIS_JOB_TTL_SECONDS`. The service signs a fresh envelope when an
  outstanding job is synced, so an offline phone does not receive a stale job.
- A package without a signer pin is a review job, not permission to install.
  The phone may download and validate Play hashes, but it reports the observed
  signer with `review_required` and stops. The companion can then pin that
  signer and queue a new signed job.
- Removing an assignment or allowlist record cancels outstanding queued jobs.
  Revoking a device invalidates its bearer for future syncs.

## Device API contract

All paths are under `/api/borealis/v1` and JSON responses use `Cache-Control:
no-store`.

### Pairing

`POST /pairings`

```json
{
  "deviceLabel": "My Light Phone",
  "deviceBearerDigest": "64-lowercase-hex-characters"
}
```

The phone generates a bearer matching `brl_device_<43 base64url characters>`.
The response contains `pairingId`, a 12-character `userCode`, `pollSecret`,
`verificationUrl`, and `expiresAt`.

Poll `GET /pairings/:id` with `Authorization: Bearer <pollSecret>`. After the
user approves the displayed code in the web companion, call
`POST /pairings/:id/activate` with the same bearer. Activation returns:

```json
{
  "deviceId": "uuid",
  "keyId": "ed25519:…",
  "signingPublicKey": "base64url X.509 SubjectPublicKeyInfo DER",
  "signingPublicKeyFormat": "spki-der-base64url"
}
```

### Sync

Call `GET /device/sync` with the phone's original bearer. The response includes
the device revision and signed jobs:

```json
{
  "jobs": [
    {
      "keyId": "ed25519:…",
      "payload": "{\"schemaVersion\":1,…}",
      "signature": "unpadded-base64url"
    }
  ]
}
```

The payload property order is intentionally stable:

```text
schemaVersion, jobId, deviceId, action, packageName, displayName,
acceptedSignerSha256, issuedAt, expiresAt, nonce
```

`action` is currently `install_or_update`. `acceptedSignerSha256` contains
lowercase hexadecimal certificate SHA-256 values.

### Report

`POST /device/jobs/:jobId/report` with device bearer authentication:

```json
{
  "status": "installing | awaiting_user_action | review_required | succeeded | failed | cancelled",
  "installedVersionCode": 42,
  "observedSignerSha256": ["64-character digest"],
  "message": "optional bounded detail"
}
```

`review_required` requires at least one observed signer and is accepted only
for a job that had no signer pin. The server rejects `awaiting_user_action` and
`succeeded` for an unpinned job.

## Admin API

Send `Authorization: Bearer <BOREALIS_ADMIN_TOKEN>`.

- `GET|POST /admin/allowlist`
- `GET|PUT|DELETE /admin/allowlist/:packageName`
- `GET /admin/pairings`
- `POST /admin/pairings/approve`
- `GET /admin/devices`
- `DELETE /admin/devices/:deviceId`
- `GET|POST /admin/devices/:deviceId/assignments`
- `DELETE /admin/devices/:deviceId/assignments/:packageName`
- `GET|POST /admin/devices/:deviceId/jobs`

Assigning an allowlisted package creates its first job. Posting to `/jobs`
queues a later update or retry. APK URLs and bytes are deliberately absent from
every companion endpoint.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
```

Tests cover the fixture-backed public Play provider, admin auth, pairing,
activation, Ed25519 verification over the exact payload string, device-bound
jobs, and the signer-review gate.

For the browser UI, `python3 tests/ui-smoke.py` checks the already-running
companion with one headless Chromium instance (requires Python Playwright).
All write actions are intercepted with isolated fixture data. If
`BOREALIS_ADMIN_TOKEN` is set in the environment, the script also checks real
login and read-only navigation. It never changes the actual app collection or
phone pairings. Run it after, not alongside, the web build.
