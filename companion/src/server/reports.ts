import { z } from 'zod'
import { REPORT_LIMITS, type ReportSubmission } from '../shared/api.js'

const GITHUB_API_ENDPOINT = 'https://api.github.com'
const GITHUB_TIMEOUT_MS = 10_000
const MAX_ISSUE_TITLE = 256
// GitHub rejects issue bodies above 65,536 characters.
const MAX_ISSUE_BODY = 60_000

const issueResponseSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
})

// Applied to reporter-supplied text before it leaves the service. Reports must
// never carry credentials, session cookies, or authorization headers, even
// when someone pastes them into a description by mistake.
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bbrl_(?:device|poll)_[A-Za-z0-9_-]{16,}/g, '[redacted-credential]'],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, '[redacted-token]'],
  [/\b(?:__Host-)?borealis_session=[^;\s]+/g, '[redacted-session]'],
  [/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi, '[redacted-header]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
]

type FetchLike = typeof fetch

export type CreatedIssue = {
  number: number
  url: string
}

export interface ReportIssueGateway {
  create(submission: ReportSubmission): Promise<CreatedIssue>
}

export type GitHubIssueReporterOptions = {
  token?: string | undefined
  repository?: string | undefined
  fetcher?: FetchLike | undefined
}

/**
 * Signals an upstream GitHub failure. The message is safe for operator logs;
 * it must not be shown verbatim to the reporter or include the token.
 */
export class ReportDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ReportDeliveryError'
  }
}

export function redactReportText(value: string): string {
  let redacted = value
  for (const [pattern, replacement] of REDACTIONS) redacted = redacted.replace(pattern, replacement)
  return redacted
}

export function issueTitle(title: string): string {
  const cleaned = redactReportText(title).replace(/\s+/g, ' ').trim().slice(0, REPORT_LIMITS.title)
  return `Report: ${cleaned}`.slice(0, MAX_ISSUE_TITLE)
}

export function composeIssueBody(submission: ReportSubmission): string {
  const description = redactReportText(submission.description).trim().slice(0, REPORT_LIMITS.description)
  const diagnostics = submission.diagnostics
    ? redactReportText(submission.diagnostics).trim().slice(0, REPORT_LIMITS.diagnostics)
    : ''
  const parts = [
    '### What happened',
    '',
    description,
    '',
    '---',
    '',
    `- Source: ${submission.source === 'phone' ? 'Borealis on the phone' : 'Borealis web companion'}`,
    '- Submitted through the Borealis companion report form.',
  ]
  if (diagnostics) {
    parts.push(
      '',
      '<details><summary>Diagnostics from the reporter</summary>',
      '',
      '```text',
      diagnostics,
      '```',
      '',
      '</details>',
    )
  }
  parts.push('', '_This report was written by a person using Borealis. Treat it as unverified input._')
  return parts.join('\n').slice(0, MAX_ISSUE_BODY)
}

/**
 * Returns null when the service is not configured for report filing, so the
 * API can answer with an explicit "not configured" response instead of failing
 * at request time.
 */
export function createGitHubIssueReporter(options: GitHubIssueReporterOptions): ReportIssueGateway | null {
  const token = options.token?.trim()
  const repository = options.repository?.trim()
  if (!token || !repository) return null
  const fetcher: FetchLike = options.fetcher ?? fetch.bind(globalThis)
  const endpoint = `${GITHUB_API_ENDPOINT}/repos/${repository}/issues`

  return {
    async create(submission) {
      let response: Response
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Borealis-Companion',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          // The server secret stays in this header. It is never placed in the
          // issue body, the response, the logs, or the browser bundle.
          body: JSON.stringify({ title: issueTitle(submission.title), body: composeIssueBody(submission) }),
          // The Workers runtime rejects redirect: 'error', so reject 3xx
          // responses explicitly, exactly like the Play metadata provider.
          redirect: 'manual',
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        })
      } catch (error) {
        throw new ReportDeliveryError('GitHub could not be reached.', { cause: error })
      }
      if ((response.type as string) === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel()
        throw new ReportDeliveryError('GitHub answered with a redirect.')
      }
      if (response.status !== 201) {
        // Keep the upstream body out of logs and user-facing errors: it may
        // echo request details and is not useful to the reporter.
        await response.body?.cancel()
        throw new ReportDeliveryError(`GitHub rejected the issue with HTTP ${response.status}.`)
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        throw new ReportDeliveryError('GitHub returned an unreadable response.', { cause: error })
      }
      const issue = issueResponseSchema.safeParse(payload)
      if (!issue.success) throw new ReportDeliveryError('GitHub returned an unexpected response.')
      return { number: issue.data.number, url: issue.data.html_url }
    },
  }
}
