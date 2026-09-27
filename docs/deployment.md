# Hosted companion

Operator runbook for Gav's centrally hosted Borealis service. Members only sign
up, sign in, and pair their phones; they do not deploy or administer a server.

Production origin: **https://borealis.loosewire.dev**. One Cloudflare Worker,
`borealis-companion`, serves the existing React/Vite assets and Hono API.
Turso remains the database; this deployment does not introduce D1 or proxy APKs.

Setup status (2026-09-26): the Better Auth 1.7.6 migration has been applied to
production after creating a private database backup. Comparison against that
backup verified unchanged domain records, legacy sessions, bootstrap metadata,
and exact public/private signing-key bytes. Wrangler deployment to Workers Free
and real HTTPS verification **passed**; no billing change or CPU override was used.
Hosted checks covered signup/signin, password changes and session revocation,
secure cookies, CSRF, account isolation, pairing, the original signing identity,
signed install jobs, and signout. Temporary fixtures were removed.

Legacy-password signin has been tested locally, not against production. Physical
LP3 installation/update and the native GitHub build connection remain unverified.

## Prerequisites

- A Cloudflare account managing the active `loosewire.dev` zone.
- Workers **Free** is the target, with its 10 ms CPU budget and no explicit CPU
  override. Paid billing and weaker password hashing are not part of this setup.
- The three private Worker secrets: `BOREALIS_ADMIN_TOKEN`, `TURSO_DATABASE_URL`,
  and `TURSO_AUTH_TOKEN`. Preserve the existing database and its signing identity.
- A database backup before migrations. Current migrations are additive; rolling
  back Worker code does not undo database migrations.

`companion/wrangler.jsonc` defines the custom domain, generated bindings, edge
rate limiter, production origin, and static assets. `workers.dev` and version
preview URLs are disabled. Only `/api` and `/api/*` invoke the Worker; static navigation
does not open a database connection. API responses must not be cached.

## Connect Cloudflare to GitHub

The companion uses **Cloudflare Workers Builds**, not a GitHub Actions deployment
workflow. In Cloudflare's **Workers & Pages**, choose **Create application → Import
a repository**. Authorize the **Cloudflare Workers & Pages** GitHub app for only
the private `gavdevs/borealis` repository. If `borealis-companion` already exists,
connect its repository under **Settings → Builds** instead of creating a second
Worker. Keep its name identical to `companion/wrangler.jsonc`.
See [native setup](https://developers.cloudflare.com/workers/ci-cd/builds/) and
[GitHub access](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/).

Use these settings:

| Setting | Value |
| --- | --- |
| Worker name | `borealis-companion` |
| Repository | `gavdevs/borealis` (private) |
| Production branch | `main` |
| Root directory | `companion` |
| Build command | `pnpm test && pnpm build && pnpm worker:check` |
| Deploy command | `pnpm exec wrangler deploy` |
| Build variable `NODE_VERSION` | `22.22.2` |
| Build variable `PNPM_VERSION` | `11.10.0` |
| Preview builds | Disabled |

Keep automatic dependency installation enabled; the companion contains the pnpm
lockfile and package-manager version. Cloudflare supports the two explicit version
overrides in **Settings → Build → Build Variables and Secrets**.
See the [build image documentation](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/).

Under **Settings → Build → Branch control**, choose `main` and leave **Enable
Preview Builds** unchecked. The Wrangler `workers_dev: false` and
`preview_urls: false` flags do not replace this branch setting. Do not deploy
nonproduction branches with production Turso credentials; separate preview
databases and signing identities would need their own deliberate setup.
See [branch controls](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/).

Use Cloudflare's automatically generated build token. No manually created
`CLOUDFLARE_API_TOKEN`, GitHub deployment secret, or local OAuth session is needed
for this native integration. Cloudflare runs the checked-in Wrangler version from
`companion/package.json`.
See [build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

## Configure runtime secrets

In the Worker's **Settings → Variables & Secrets**, add these values as **secrets**:

- `BOREALIS_ADMIN_TOKEN`: preserve the existing private operator-provisioning token. A
  domain-separated HMAC of it supplies Better Auth's cookie-signing secret;
  there is no additional auth secret to configure.
- `TURSO_DATABASE_URL`: the existing Borealis database URL.
- `TURSO_AUTH_TOKEN`: its database-scoped credential.

These are runtime secrets, **not** GitHub Actions secrets or Cloudflare build
environment variables. Never paste their values into source control, chat, logs,
or build commands. Build-only values are not automatically runtime bindings.
See [build/runtime separation](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

Keep `BOREALIS_ADMIN_TOKEN` stable. Rotating it invalidates existing browser
cookies and changes rate-limit bucket keys, but does not rewrite password hashes,
account ownership, phone credentials, or the job-signing key. Users must sign in
again after rotation.

The Wrangler configuration declares all three required secrets. If initial import
attempts a build before they are configured, finish the Worker settings and retry
the build; do not remove the required-secret check. Inspect any custom-domain
conflict rather than replacing an existing DNS target automatically. Once connected,
pushes to `main` run the checks and deployment on Cloudflare's infrastructure.

## Validation and database migrations

From `companion/`, run commands sequentially:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm worker:check
```

`worker:check` checks generated types, typechecks the Worker, and bundles a dry
run. The hosted authentication smoke test passed on 2026-09-26. A controlled
existing-account production signin remains to be checked; continue monitoring
Worker CPU and errors after changes.

The Better Auth migration was applied on **2026-09-26** with a retained private
backup and preservation checks. Migrations are **not** part of the native build
or deploy commands. Before merging code that requires a new schema,
back up Turso and deliberately run `pnpm worker:migrate` from `companion/` with the
matching credentials in an ignored `.env`, private environment, or secret manager.
The migration initializes schema/signing identity outside request handling and
reuses an existing signer. Never put Turso credentials in build settings just to
automate this step.

The additive migration creates `ba_user`, `ba_account`, `ba_session`, and
`ba_verification`. Existing Borealis account IDs, usernames, roles, app/phone
ownership, password hashes, and the signing identity are preserved. Legacy hashes
are copied unchanged into Better Auth credential records; a compatibility verifier
reads them until a password change uses Better Auth's maintained hashing format.
Migration markers prevent later runs from restoring removed auth records.

Better Auth requires an email-shaped identifier internally. Borealis supplies
`username@users.borealis.invalid`, a non-deliverable alias: users provide no email,
and no email is sent. Email login, recovery, and account linking are not exposed.
Old browser session digests are not converted; everyone must sign in again.
New opaque session tokens live in `ba_session` and are carried in signed,
HttpOnly/SameSite=Strict cookies (Secure on HTTPS), not stored as token digests.
Protect database backups accordingly.

Prefer additive, backward-compatible migrations that both old and new Worker
versions can use. An incompatible change requires a coordinated deployment and
rollback plan before merging to automatically deployed `main`.
In particular, retained legacy password rows do not track later Better Auth
password changes, and new domain rows contain only `better-auth-managed` instead
of a password hash. Do not treat switching back to the old auth code as a safe
password/session rollback; coordinate recovery before doing so.

## Verification

After deployment or a relevant authentication change, run these from `companion/`:

```sh
# Read-only checks: real HTML/assets, health, anonymous session, private API denial.
node ../scripts/ci-smoke.mjs

# Explicit temporary writes: use credentials for this exact service's database.
node --env-file=.env scripts/hosted-smoke.mjs --allow-test-writes
```

The second command creates two random member accounts and a synthetic phone,
then checks secure cookies, CSRF rejection, isolation, pairing, signed jobs,
password changes, and session revocation through the real HTTPS endpoint.
Its `finally` cleanup resolves only its random fixture usernames and bearer
digest, then explicitly removes their Better Auth users, sessions, credentials,
and domain child rows without relying on foreign-key cascades. It never claims
legacy ownership or changes real users' libraries. A cleanup failure is reported separately.
This verifies newly created accounts, not legacy-password compatibility or Android
installation; verify those paths separately.

The signup form also has an optional, API-intercepted browser regression check.
With Python Playwright and its Chromium browser already installed, run:

```sh
python scripts/check-auth-form.py https://borealis.loosewire.dev
```

This verifies the 12-character minimum, ordinary 12/16-character submissions,
silent password-manager autofill, and hosted-only account UI without creating
accounts. New passwords use a shared 12–128 Unicode-code-point policy; existing
shorter passwords still work for signin. The live read-only checks and browser
check passed after this update. The complete hosted write-smoke rerun hit the
production signup cooldown; its temporary records were cleaned, and no rate limit
was disabled. Run it again after the cooldown before treating the new 12-character
policy as fully verified through production signup.

The public companion offers signup, signin, pairing, and personal libraries,
not server setup or a curator role. The old admin/bootstrap endpoints are
unavailable. Do not promote accounts or delete legacy ownership records.
`BOREALIS_ADMIN_TOKEN` retains its existing secret-derivation purpose despite
the historical name; removing it or rotating it unnecessarily breaks sessions.

Without email, forgotten-password recovery is not currently self-service.
First installs use verified Play artifacts and Android signature checks; there
is no publisher-approval provisioning step. Updates retain installed-signature checks.

## Operational boundaries

- Back up Turso independently of code and retain the existing signing-key row.
  Changing that identity breaks the trust established during phone pairing.
- The initial local database credential expires on **2026-12-25**. Renew the
  database-scoped credential and update the Worker runtime secret before
  expiry. Do not revoke a still-used credential prematurely.
- Preserve the private operator secret: it also derives Better Auth's signing secret
  and salts rate-limit bucket identifiers. Do not store it in the browser.
- Cloudflare supplies client identity at the trusted Worker boundary. The Node
  preview uses socket peers; arbitrary forwarded headers are not trusted there.
- Edge rate limiting happens before database access; persistent account/IP
  limits still gate expensive authentication. Neither is a promise of complete
  protection against distributed abuse or usage charges.
- Observe Worker errors and CPU usage after deployment. Logs intentionally avoid
  passwords, cookies, bearer credentials, SQL parameter values, and secret URLs.
- Roll back a bad Worker revision using Wrangler deployments/rollback after
  checking which version is safe against the current database schema. A failed
  post-deploy smoke test is not automatically rolled back.
- Android releases are separate; see [releases.md](releases.md). Keep the source
  repository private unless the owner explicitly chooses public distribution.

References: [Worker static assets](https://developers.cloudflare.com/workers/static-assets/),
[CPU limits](https://developers.cloudflare.com/workers/platform/limits/),
[pricing](https://developers.cloudflare.com/workers/platform/pricing/), and
[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).
