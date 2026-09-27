import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AllowlistItem, JobSummary } from '../shared/api.js'
import { AccountGate, groupJobHistory, JobActivity, LibrarySection } from './App.js'

describe('hosted-service account entry', () => {
  it('offers sign in and account creation without server administration', () => {
    const html = renderToStaticMarkup(createElement(AccountGate, { onSignIn() {}, notice: '' }))
    expect(html).toContain('Sign in to your companion.')
    expect(html).toContain('Create an account')
    expect(html).toContain('name="username"')
    expect(html).toContain('name="password"')
    expect(html).not.toMatch(/set up this server|server owner|curator account|admin.token|bootstrap/i)
  })

  it('preserves signout and expired-session notices', () => {
    const notice = 'Your session ended. Sign in again to continue.'
    const html = renderToStaticMarkup(createElement(AccountGate, { onSignIn() {}, notice }))
    expect(html).toContain(notice)
    expect(html).toContain('role="status"')
  })
})

const app: AllowlistItem = {
  packageName: 'example.banking', displayName: 'My Bank', publisher: 'My Bank', reason: 'Personal library',
  signerSha256: null, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
}

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'request-new', deviceId: 'phone', packageName: app.packageName, displayName: app.displayName,
    action: 'install_or_update', status: 'queued', createdAt: '2026-09-27T00:00:00.000Z',
    deliveredAt: null, completedAt: null, installedVersionCode: null, observedSignerSha256: [], message: null,
    ...overrides,
  }
}

describe('personal library', () => {
  const props = { items: [app], selected: [] as string[], busy: '', confirmRemoval: false, onSelect() {}, onConfirmRemoval() {}, async onRemove() {} }

  it('makes an app available without publisher approval or sending it to a particular phone', () => {
    const html = renderToStaticMarkup(createElement(LibrarySection, props))
    expect(html).toContain('My Bank')
    expect(html).toContain('These apps appear on every paired phone after its next sync.')
    expect(html).toContain('In your library')
    expect(html).not.toMatch(/curator|approve|signature|send to phone|sent to phone/i)
    expect(html).not.toContain('<select')
  })

  it('offers removal without an extra assignment or install action', () => {
    const html = renderToStaticMarkup(createElement(LibrarySection, { ...props, selected: [app.packageName], confirmRemoval: true }))
    expect(html).toContain('Remove from library')
    expect(html).toContain('Installed apps stay on your phone.')
    expect(html).not.toMatch(/send to phone|approve publisher/i)
    expect(html).not.toContain('<select')
  })

  it('explains how to start an empty library', () => {
    const html = renderToStaticMarkup(createElement(LibrarySection, { ...props, items: [] }))
    expect(html).toContain('Your library is empty. Search above to add your first app.')
  })
})

describe('phone request history', () => {
  it('chooses the newest request for each package without mutating the API result', () => {
    const old = job({ id: 'old', status: 'failed', createdAt: '2026-09-26T00:00:00.000Z' })
    const fresh = job()
    const other = job({ id: 'other', packageName: 'example.other' })
    const jobs = [old, fresh, other]
    const grouped = groupJobHistory(jobs)
    expect(grouped.latest).toEqual([fresh, other])
    expect(grouped.earlier).toEqual([old])
    expect(jobs).toEqual([old, fresh, other])
  })

  it('keeps a superseded anonymous login failure out of the latest attempts', () => {
    const html = renderToStaticMarkup(createElement(JobActivity, { jobs: [
      job({ status: 'succeeded', installedVersionCode: 42 }),
      job({ id: 'old', status: 'failed', createdAt: '2026-09-26T00:00:00.000Z', message: 'Anonymous login failed (HTTP 403).' }),
    ] }))
    const [latest, history] = html.split('<summary>Earlier attempts</summary>')
    expect(latest).toContain('Installation completed · version 42')
    expect(latest).not.toContain('Anonymous login failed')
    expect(history).toContain('Anonymous login failed (HTTP 403).')
    expect(history).toContain('Past requests, not the current state of your phone.')
    expect(html).not.toMatch(/<details[^>]*open/)
    expect(html).not.toContain('Up to date')
  })

  it('treats legacy publisher review as an obsolete request without exposing an approval flow', () => {
    const html = renderToStaticMarkup(createElement(JobActivity, { jobs: [job({
      status: 'review_required', observedSignerSha256: ['a'.repeat(64)],
      message: 'A Borealis curator needs to approve this app’s publisher.',
    })] }))
    expect(html).toContain('Previous request ended')
    expect(html).toContain('This request used an older installation flow.')
    expect(html).not.toMatch(/curator|approve|review publisher/i)
    expect(html).not.toContain('a'.repeat(64))
    expect(html).not.toContain('<button')
  })

  it('shows a current failure rather than hiding every failure as history', () => {
    const html = renderToStaticMarkup(createElement(JobActivity, { jobs: [job({ status: 'failed', message: 'Download interrupted.' })] }))
    expect(html).toContain('Installation failed')
    expect(html).toContain('Download interrupted.')
    expect(html).toContain('Open Borealis on your phone to try again.')
    expect(html).not.toContain('Earlier attempts')
  })
})
