# Borealis companion

Borealis is Gav's centrally hosted companion for the Borealis Light Phone
installer. Members create an account, sign in, and pair their own phones; they
do not configure a server or need an admin token. Search and policy live here;
the phone receives the user's library and short-lived install jobs for its packages.

This service never proxies APK bytes and never accepts or stores Google account
credentials. Catalog search reads public Google Play web metadata over a
Workers-compatible `fetch`: `redirect: 'manual'` with an explicit redirect
rejection, because the Workers runtime does not implement `redirect: 'error'`.
The phone is responsible for obtaining the device-appropriate base and split
APKs directly, verifying Play-provided hashes, package identity, and
installed-signature continuity, and invoking Android's installer.

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
- **Apps:** search Play apps and add to your library; it appears on every paired phone.
- **Pairing:** enter a code, preview the requesting phone, explicitly approve it.
- Package identifiers, signing fingerprints, and request diagnostics belong in
  expandable details, not the default workflow.

This is a React/TypeScript interface with Vite and plain CSS, a Hono API, and
SQLite-compatible storage through libSQL. It supports either a local database
or a hosted libSQL database on Turso. The signed-job protocol is unchanged.
Accounts use usernames and passwords, without email. Each account has its own
library and paired phones, and chooses its own apps without server-side
filtering or approval.
Borealis collects no telemetry. The only usage signal is the running count of
accounts ever created, visible only to the operator role.

The shared service is hosted at `https://borealis.loosewire.dev`. Its Cloudflare
Worker adapter and deployment pipeline provide
edge throttling and persistent account limits. See the [deployment runbook](../docs/deployment.md)
for operator deployment and verification.

## Run locally

These instructions are for repository contributors running a local development
instance, not a setup step for people using the hosted companion.

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
  case-insensitive) and a 12–128-character password/passphrase. No email,
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
- **Pair a phone:** sign in, enter the short-lived code shown by the phone app,
  review the requesting phone, and approve it. Its library matches the account's,
  including apps selected before this phone was paired.

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
Keep the database backups and operator token private.

Signup, login, password changes, and pairing-code attempts have persistent
database-backed limits; login is also limited by normalized username. The Node
adapter uses the actual socket peer, not caller-supplied forwarding headers.
The Cloudflare adapter uses the platform's `CF-Connecting-IP` and an edge limiter
before database access. Better Auth handles new password hashing; the legacy
verifier remains only for compatibility with pre-migration accounts.

See [Better Auth security](https://better-auth.com/docs/reference/security),
[OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
and [session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
A production security audit has not been completed.

## Compatibility storage

Legacy role, allowlist, assignment, and bootstrap records are retained without
destructive data migration. They are not a public approval workflow. The old
admin and bootstrap routes are unavailable; nobody needs promotion to use their
library. Keep `BOREALIS_ADMIN_TOKEN` private and stable because it still derives
cookie-signing and rate-limit secrets, despite its historical name.

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

- New library additions resolve canonical Play metadata and apply the server's
  automatic category policy. Client-supplied names/categories never grant admission.
  Installation authority is limited to the paired owner's current library.
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
- First installs trust authenticated Play delivery plus native Android APK checks;
  there is no manually approved publisher pin. Updates check installed signing
  continuity in addition to package identity and artifact size/checksum validation.
- Removing an app from the library cancels its outstanding jobs on this account's phones.
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
the device revision, current library, and outstanding signed jobs:

```json
{
  "library": [{ "packageName": "example.bank", "displayName": "Daily Banking" }],
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

`action` is currently `install_or_update`. `acceptedSignerSha256` remains for
wire compatibility and is empty on new library jobs; it is not an approval gate.
`POST /device/library/:packageName/job` uses the device bearer and returns
`{job: SignedJobEnvelope}` only for a package in this phone owner's library.
The phone requests it on Install/Update, then verifies the signed envelope.

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

`review_required` is retained for legacy history. New phones proceed without a
publisher-review step, and unpinned jobs can report installation or success.

## Companion API

Paths below are relative to `/api/borealis/v1`. Browser authentication uses the
session cookie, not the old admin bearer. Mutation requests also send
`X-Borealis-Request: 1` and `Content-Type: application/json` for JSON bodies.

- `GET /auth/session` → account summary or `null`.
- `POST /auth/signup` and `/auth/signin` → `{username,password}`.
- `POST /auth/signout` → `{}`; revokes the current session.
- `POST /auth/change-password` → `{currentPassword,newPassword}`.
- `GET|POST /me/apps`; POST selects `{packageName}` after canonical metadata/policy validation.
- `DELETE /me/apps/:packageName`; affects only this account and its phones.
- `GET /me/pairings`; lists only this account's claimed, non-activated pairings.
- `POST /me/pairings/preview` and `/me/pairings/approve` → `{userCode}`.
  Unclaimed pairing codes cannot be enumerated.
- `GET /me/devices`
- `DELETE /me/devices/:deviceId`
- `GET|POST /me/devices/:deviceId/jobs`
- `GET /me/stats` → aggregate account count for the operator (curator) role. Members
  receive an ordinary 404; there is no per-person tracking anywhere in the app.

Legacy assignment routes are unavailable; library membership replaces that step.
`GET /catalog/search` requires sign-in and returns public Play apps for every
account. All phone operations are restricted to the account's own phones;
another account's device identifiers are treated as not found. The former admin
and bootstrap endpoints are unavailable. APK URLs and bytes are deliberately
absent from every companion endpoint.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
```

Tests cover passwords, cookie/session lifecycle, origin checks, rate limits,
legacy migration compatibility, cross-account denial, library admission policy,
pairing, exact-byte Ed25519 signatures, and device-bound library jobs.

For the browser UI, `python3 tests/ui-smoke.py` checks the already-running
companion with one headless Chromium instance (requires Python Playwright).
All write actions are intercepted with isolated fixture data. It never changes
real accounts, app collections, or phone pairings. Run it after, not alongside,
the web build.
