import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountGate } from './App.js'

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
