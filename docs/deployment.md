# Hosted companion

Production origin: **https://borealis.loosewire.dev**. One Cloudflare Worker,
`borealis-companion`, will serve the existing React/Vite assets and Hono API.
Turso remains the database; this deployment does not introduce D1 or proxy APKs.

Setup status (2026-09-25): the repository is prepared and the current Turso schema
is migrated, but the Worker is **not yet live or connected to GitHub**. The remaining
one-time authorization is in Cloudflare's dashboard. The current CLI OAuth session
received HTTP 403 from the Builds APIs; that does not mean a new user-created API
token is required for native Workers Builds.

## Prerequisites

- A Cloudflare account managing the active `loosewire.dev` zone.
- Workers Paid CPU capacity: the existing strong scrypt password hashing is not
  suitable for the free plan's 10 ms CPU budget. Do not weaken hashing to fit it.
  The Worker sets a 2-second CPU ceiling per request.
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

- `BOREALIS_ADMIN_TOKEN`: preserve the existing private owner-setup token.
- `TURSO_DATABASE_URL`: the existing Borealis database URL.
- `TURSO_AUTH_TOKEN`: its database-scoped credential.

These are runtime secrets, **not** GitHub Actions secrets or Cloudflare build
environment variables. Never paste their values into source control, chat, logs,
or build commands. Build-only values are not automatically runtime bindings.
See [build/runtime separation](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

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
run. It does **not** prove Cloudflare accepts scrypt's platform-specific cost.
The production authentication smoke test below is also required.

The current production schema is already migrated. Migrations are **not** part of
the native build or deploy commands. Before merging code that requires a new schema,
back up Turso and deliberately run `pnpm worker:migrate` from `companion/` with the
matching credentials in an ignored `.env`, private environment, or secret manager.
The migration initializes schema/signing identity outside request handling and
reuses an existing signer. Never put Turso credentials in build settings just to
automate this step.

Prefer additive, backward-compatible migrations that both old and new Worker
versions can use. An incompatible change requires a coordinated deployment and
rollback plan before merging to automatically deployed `main`.

## Verification and owner setup

After the first successful native deployment, run these from `companion/`:

```sh
# Read-only checks: real HTML/assets, health, anonymous session, private API denial.
node ../scripts/ci-smoke.mjs

# Explicit temporary writes: use credentials for this exact service's database.
node --env-file=.env scripts/hosted-smoke.mjs --allow-test-writes
```

The second command creates two random member accounts and a synthetic phone,
then checks secure cookies, CSRF rejection, isolation, pairing, signed jobs,
password changes, and session revocation through the real HTTPS endpoint.
Its `finally` cleanup targets only its random fixture usernames and bearer
digest. It never claims owner setup or edits the shared catalog. A cleanup
failure is reported separately. It is not an Android installation test.

On the production sign-in screen, use **Set up this server** once with the
existing private setup token and your chosen username/password. Public signup
creates members, never the curator. Without email, forgotten-password recovery
is not currently self-service. Existing catalog entries still need reviewed
publisher pins before automatic approval of their signers.

## Operational boundaries

- Back up Turso independently of code and retain the existing signing-key row.
  Changing that identity breaks the trust established during phone pairing.
- The initial local database credential expires on **2026-12-25**. Renew the
  database-scoped credential and update the Worker runtime secret before
  expiry. Do not revoke a still-used credential prematurely.
- Preserve the owner-setup secret: it also salts rate-limit bucket identifiers.
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
