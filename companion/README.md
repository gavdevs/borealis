# Borealis companion

Borealis is a positive-allowlist control plane for the Borealis Light
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

This is a React/TypeScript interface with Vite and plain CSS, a Hono API, and
SQLite-compatible storage through libSQL. It supports either a local database
or a hosted libSQL database on Turso. The signed-job protocol is unchanged.
Accounts use usernames and passwords, without email. Each account has its own
app collection and paired phones. A shared, curator-managed positive allowlist
controls which packages can enter those collections; a public signup cannot
approve arbitrary packages or edit publisher signing pins.

This is the foundation for one shared hosted service. The Cloudflare Worker
adapter and deployment pipeline target `https://borealis.loosewire.dev` with
edge throttling and persistent account limits. See the [deployment runbook](../docs/deployment.md)
for setup and verification; the full app-admission workflow remains unfinished.

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
The browser stores only an HttpOnly account-session cookie; no password or
admin token goes into browser storage. The session survives a browser restart
for up to 30 days unless signed out or invalidated by a password change.

For a production-style build:

```sh
pnpm build
pnpm start
```

The Hono server serves the built React client from `dist/client`. Keep
the default `BOREALIS_HOST=127.0.0.1` for local testing; only change the bind
address when deliberately configuring a protected deployment. Keep
`BOREALIS_DATABASE_PATH` on persistent storage: the SQLite database contains
the allowlist, device credential hashes, jobs, and the generated Ed25519
signing key. Back it up as one unit. No plaintext phone bearer or poll secret is
stored.

## Accounts

- **Create account:** choose a username (3–32 letters, digits, or underscores,
  case-insensitive) and a 15–128-character password/passphrase. No email,
  confirmation email, recovery code, or third-party identity service is required.
- **Sign in:** use that username and password. Better Auth 1.7.6 owns password
  hashing, verification, and browser sessions. New passwords use its maintained
  scrypt implementation; spaces and Unicode are accepted.
- **Profile:** shows the username, password change, and sign out. Changing a
  password requires the current password. Updating the verifier, revoking old
  sessions, and creating the replacement session are one database transaction;
  a failure rolls them back together. This does not revoke paired phones.
- **Recovery:** there is no self-service forgotten-password reset. Save the
  password in a password manager; having a session alone does not bypass the
  current-password requirement. Recovery needs a separately designed mechanism.
- **Server owner:** use the one-time owner setup on the sign-in screen with the
  existing `BOREALIS_ADMIN_TOKEN`, plus a new username/password. Better Auth
  identity and domain member creation happen first; the subsequent owner claim
  atomically promotes that account to curator and claims legacy unowned phones
  and existing app selections.
  Ordinary signup never claims legacy data, even if it is the first account.
  After setup, the token cannot be used as an API bearer or to create another
  curator. Do not delete the `bootstrap_claimed` metadata record.

Better Auth's required email-shaped field uses the internal, non-deliverable
alias `username@users.borealis.invalid`. The UI never asks for an email, no email
is sent, and email-based login, recovery, and account linking are not exposed.
Existing scrypt verifiers (`N=32768, r=8, p=3`) are copied unchanged and verified
with their original encoding until a password change. Account IDs, roles, phone
ownership, and signing keys are preserved; legacy browser sessions are not
migrated, so existing users must sign in again.

Better Auth stores opaque session tokens in `ba_session`, not SHA-256 digests,
and signs the browser cookies. Cookies are `HttpOnly; SameSite=Strict; Path=/`,
with `Secure` and a `__Host-` prefix on HTTPS. HTTP is permitted only for loopback development.
Mutating browser requests require the `X-Borealis-Request: 1` header and an
allowed Origin when supplied; POST/PUT bodies must be JSON. There is no CORS
allowlist that permits arbitrary sites to send authenticated requests.

The cookie-signing secret is a domain-separated HMAC derived from the stable
`BOREALIS_ADMIN_TOKEN`; no additional secret is needed. Rotating that token
invalidates browser cookies and changes rate-limit bucket keys, but leaves
password hashes, account ownership, phone credentials, and signing keys intact.
Keep the database backups and owner-setup token private.

Signup, login, setup, password changes, and pairing-code attempts have persistent
database-backed limits; login is also limited by normalized username. The Node
adapter uses the actual socket peer, not caller-supplied forwarding headers.
The Cloudflare adapter uses the platform's `CF-Connecting-IP` and an edge limiter
before database access. Better Auth handles new password hashing; the legacy
verifier remains only for compatibility with pre-migration accounts.

See [Better Auth security](https://better-auth.com/docs/reference/security),
[OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
and [session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
A production security audit has not been completed.

## Turso database

Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` together in the server environment
or your ignored `.env` file. The URL must use `libsql://` or `https://`. Both values
are required: partial configuration fails rather than silently using local
storage. When neither is set, `BOREALIS_DATABASE_PATH` remains the local fallback.
The token must be scoped to this database, not an entire Turso group; never put
it in a `VITE_` variable, browser storage, phone configuration, or source control.
Use an explicit token expiry and renew it before that date. The initial local
Turso preview uses a 90-day database token; a hosted deployment should receive
its own credential rather than copying a personal CLI or organization token.

This adapter targets Turso's **libSQL** databases using `@libsql/client/web` for
remote connections. It does not use the newer `--tursodb` engine. The same async
repository API is exercised locally with the libSQL file driver. Multi-statement
writes use write transactions, including signer initialization, pairing,
assignment/job creation, revocation, and result reporting.

To move an existing instance safely:

1. Log in using `turso auth login`, confirm the intended subscription/organization,
   and select an existing compatible group or region.
2. Stop the companion to prevent writes during cutover. Make a consistent SQLite
   backup with SQLite's `.backup` command; do not copy only the main file while
   WAL writes may exist. Keep the backup private: it contains the signing key.
3. Create a **new** database, for example `turso db create borealis --from-file
   /absolute/path/to/backup.sqlite --group GROUP --wait`. Do not import over
   another application's database. Use a libSQL group, not `--tursodb`.
4. Obtain that database's URL and a database-scoped read/write token. Store both
   securely in the server environment. Keep the old local database as rollback.
5. Start the companion and verify record counts, the unchanged signing public
   key identity, authenticated reads, and a test pairing/job flow before treating
   the cutover as complete. If remote writes occur, the old local copy is no longer
   current; reconcile them before any rollback.

Startup creates missing tables/indexes idempotently and adds the device-owner
column in a serialized migration without replacing existing rows or keys.
Back up the entire database, including accounts, sessions, private collections,
and bootstrap metadata; restoring just the old six tables loses ownership.
Future schema changes need explicit migrations. The current
signing key remains persisted in the database, just as it was locally; do not
rotate it during migration or existing phones will no longer trust the server.
The Cloudflare runtime uses the fetch-based driver and Worker secrets. Run
`pnpm worker:migrate` deliberately before deployment; API requests never migrate
the schema or create a new signing identity. See [deployment](../docs/deployment.md).

References: [Turso TypeScript SDK](https://docs.turso.tech/sdk/ts/reference),
[database creation/import](https://docs.turso.tech/cli/db/create).

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

## Companion API

Paths below are relative to `/api/borealis/v1`. Browser authentication uses the
session cookie, not the old admin bearer. Mutation requests also send
`X-Borealis-Request: 1` and `Content-Type: application/json` for JSON bodies.

- `GET /auth/session` → account summary or `null`, plus setup availability.
- `POST /auth/signup` and `/auth/signin` → `{username,password}`.
- `POST /auth/signout` → `{}`; revokes the current session.
- `POST /auth/change-password` → `{currentPassword,newPassword}`.
- `POST /auth/bootstrap` → `{adminToken,username,password}`; one time only.
- `GET|POST /me/apps`; POST selects `{packageName}` from the approved catalog.
- `DELETE /me/apps/:packageName`; affects only this account and its phones.
- `GET /me/pairings`; lists only this account's claimed, non-activated pairings.
- `POST /me/pairings/preview` and `/me/pairings/approve` → `{userCode}`.
  Unclaimed pairing codes cannot be enumerated.
- `GET /me/devices`
- `DELETE /me/devices/:deviceId`
- `GET|POST /me/devices/:deviceId/assignments`
- `DELETE /me/devices/:deviceId/assignments/:packageName`
- `GET|POST /me/devices/:deviceId/jobs`
- Curators only: `GET|POST /admin/allowlist` and
  `GET|PUT|DELETE /admin/allowlist/:packageName`.

`GET /catalog/search` requires sign-in. Members search only the approved
catalog; curators can search public Play metadata to review and add packages.
All phone operations, even for curators, are restricted to the account's own
phones. Another account's device identifiers are treated as not found.

Assigning an allowlisted package creates its first job. Posting to `/jobs`
queues a later update or retry. APK URLs and bytes are deliberately absent from
every companion endpoint.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
```

Tests cover passwords, cookie/session lifecycle, origin checks, rate limits,
one-time ownership migration, cross-account denial, curated app permissions,
pairing, exact-byte Ed25519 signatures, device-bound jobs, and signer review.

For the browser UI, `python3 tests/ui-smoke.py` checks the already-running
companion with one headless Chromium instance (requires Python Playwright).
All write actions are intercepted with isolated fixture data. It never changes
real accounts, app collections, or phone pairings. Run it after, not alongside,
the web build.
