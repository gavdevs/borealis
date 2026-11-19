import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  composeIssueBody,
  createGitHubIssueReporter,
  issueTitle,
  redactReportText,
  ReportDeliveryError,
} from './reports.js'

const submission = {
  title: 'Library did not update',
  description: 'I paired my phone and the app never appeared.',
  diagnostics: 'Opened Borealis, tapped Sync, saw no change.',
  source: 'web',
} as const

function github(fetcher: Mock, options: { token?: string; repository?: string } = {}) {
  return createGitHubIssueReporter({
    token: options.token ?? 'ghp_fixture_server_secret_value',
    repository: options.repository ?? 'gavdevs/borealis',
    fetcher: fetcher as unknown as typeof fetch,
  })
}

describe('report issue composition', () => {
  it('labels the issue and includes the described problem and bounded diagnostics', () => {
    const body = composeIssueBody(submission)
    expect(issueTitle(submission.title)).toBe('Report: Library did not update')
    expect(body).toContain(submission.description)
    expect(body).toContain(submission.diagnostics)
    expect(body).toContain('Borealis web companion')
    expect(body).toContain('<details><summary>Diagnostics from the reporter</summary>')
  })

  it('omits the diagnostics block when the reporter supplied none', () => {
    const body = composeIssueBody({ title: submission.title, description: submission.description, source: 'web' })
    expect(body).not.toContain('<details>')
    expect(body).toContain('Borealis web companion')
  })

  it('identifies a phone-originated report as such', () => {
    expect(composeIssueBody({ ...submission, source: 'phone' })).toContain('Borealis on the phone')
  })

  it('redacts credentials, cookies, and authorization headers pasted by mistake', () => {
    const redacted = redactReportText([
      `bearer ${'brl_device_' + 'a'.repeat(43)}`,
      'Cookie: borealis_session=super-secret-session-value',
      'Authorization: Bearer abcdefghijklmnop',
      `token github_pat_${'B'.repeat(30)}`,
      'Screen looked frozen.',
    ].join('\n'))
    expect(redacted).not.toContain('a'.repeat(43))
    expect(redacted).not.toContain('super-secret-session-value')
    expect(redacted).not.toContain('abcdefghijklmnop')
    expect(redacted).not.toContain('B'.repeat(30))
    expect(redacted).toContain('Screen looked frozen.')
  })

  it('never lets reporter text grow the issue beyond GitHub limits', () => {
    const body = composeIssueBody({
      title: 'x'.repeat(400),
      description: 'y'.repeat(20_000),
      diagnostics: 'z'.repeat(20_000),
      source: 'web',
    })
    expect(body.length).toBeLessThanOrEqual(60_000)
    expect(issueTitle('x'.repeat(400)).length).toBeLessThanOrEqual(256)
  })
})

describe('GitHub issue reporter', () => {
  it('is absent when the service is not configured', () => {
    expect(createGitHubIssueReporter({})).toBeNull()
    expect(createGitHubIssueReporter({ token: 'ghp_fixture_server_secret_value' })).toBeNull()
    expect(createGitHubIssueReporter({ repository: 'gavdevs/borealis' })).toBeNull()
  })

  it('files the issue server-side with the secret kept in the authorization header', async () => {
    const fetcher = vi.fn(async () => Response.json(
      { number: 42, html_url: 'https://github.com/gavdevs/borealis/issues/42' }, { status: 201 },
    ))
    const issue = await github(fetcher)!.create(submission)

    expect(issue).toEqual({ number: 42, url: 'https://github.com/gavdevs/borealis/issues/42' })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/gavdevs/borealis/issues')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer ghp_fixture_server_secret_value')
    expect(headers.get('Accept')).toBe('application/vnd.github+json')
    const body = JSON.parse(String(init.body)) as { title: string; body: string }
    expect(body.title).toBe('Report: Library did not update')
    expect(body.body).toContain(submission.description)
    // The secret never travels in the issue itself.
    expect(String(init.body)).not.toContain('ghp_fixture_server_secret_value')
  })

  it('reports a sanitized delivery error when GitHub rejects the issue', async () => {
    const fetcher = vi.fn(async () => Response.json(
      { message: 'Bad credentials for ghp_fixture_server_secret_value' }, { status: 401 },
    ))
    const error = await github(fetcher)!.create(submission).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ReportDeliveryError)
    expect((error as Error).message).toContain('401')
    expect((error as Error).message).not.toContain('ghp_fixture_server_secret_value')
  })

  it('treats a redirect as a failed delivery instead of following it', async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302, headers: { Location: 'https://example.test/' },
    }))
    await expect(github(fetcher)!.create(submission)).rejects.toBeInstanceOf(ReportDeliveryError)
  })

  it('fails clearly when GitHub cannot be reached', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('network down') })
    const error = await github(fetcher)!.create(submission).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ReportDeliveryError)
    expect((error as Error).message).toBe('GitHub could not be reached.')
  })

  it('rejects an unexpected success payload', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }, { status: 201 }))
    await expect(github(fetcher)!.create(submission)).rejects.toBeInstanceOf(ReportDeliveryError)
  })
})
