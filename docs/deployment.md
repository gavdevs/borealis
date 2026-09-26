# Hosted companion

Production origin: **https://borealis.loosewire.dev**. One Cloudflare Worker,
`borealis-companion`, serves the existing React/Vite assets and Hono API.
Turso remains the database; this deployment does not introduce D1 or proxy APKs.

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

## Validate and deploy

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

Authenticate with `pnpm exec wrangler login`. Supply credentials through private
environment variables, an ignored `.env`, or your secret manager—never shell
arguments or source control. Run `pnpm worker:migrate` with the matching Turso
credentials before deploying. This deliberately initializes schema/signing
identity outside request handling; it reuses an existing signer.

Deploy with `pnpm exec wrangler deploy --secrets-file /absolute/private/secrets.json`
after building the frontend. The JSON file must contain only the three required
Worker secrets. Restrict it to mode 0600, never commit it, and remove an ephemeral
copy after uploading. Inspect any custom-domain conflict rather than replacing
an existing DNS target automatically.

## Verification and owner setup

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

## Optional GitHub deployment

The chosen initial workflow is a direct Wrangler deployment using local
Cloudflare login. A separate API token is **not** needed to host this Worker;
it is only needed if GitHub should deploy future companion updates unattended.
The following pipeline remains optional and automatic deployment stays disabled.

`.github/workflows/deploy.yml` runs tests, builds, checks the Worker, migrates,
deploys, then performs read-only HTTPS checks. It is manual initially. Enable
automatic `main` deployment only after initial live verification by setting
repository variable `BOREALIS_AUTO_DEPLOY=true`. The workflow is restricted to
`gavdevs/borealis` and `main`, with serialized deployments.

Configure repository variable `CLOUDFLARE_ACCOUNT_ID` and encrypted Actions
secrets `CLOUDFLARE_API_TOKEN`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and
`BOREALIS_ADMIN_TOKEN`. Exporting local secrets to GitHub requires the owner's
explicit approval. Do not put a temporary Wrangler OAuth session in GitHub.
Use a scoped Cloudflare deployment API token, limited to the target account
and `loosewire.dev` zone; consult Cloudflare's current deployment-token guidance.
Set tokens using `gh secret set NAME --repo gavdevs/borealis` and its hidden
interactive prompt, or pipe from a private file. Never paste them into chat.

## Operational boundaries

- Back up Turso independently of code and retain the existing signing-key row.
  Changing that identity breaks the trust established during phone pairing.
- The initial local database credential expires on **2026-12-25**. Renew the
  database-scoped credential and update every configured deployment secret before
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
[GitHub deployment](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
