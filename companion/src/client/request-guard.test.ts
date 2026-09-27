import { describe, expect, it } from 'vitest'
import { createRequestGuard } from './request-guard.js'

describe('companion refresh lifecycle', () => {
  it('supersedes an initial load when a later refresh starts', () => {
    const guard = createRequestGuard()
    guard.mount()
    const initialLoad = guard.begin()
    const afterAdd = guard.begin()
    expect(initialLoad()).toBe(false)
    expect(afterAdd()).toBe(true)
  })

  it('invalidates the old response as soon as a mutation starts, before its refresh', () => {
    const guard = createRequestGuard()
    guard.mount()
    const initialLoad = guard.begin()
    guard.invalidate()
    expect(initialLoad()).toBe(false)
    const refreshed = guard.begin()
    expect(refreshed()).toBe(true)
  })

  it('rejects late data and auth errors after unmount, even if mounted again', () => {
    const guard = createRequestGuard()
    guard.mount()
    const oldRequest = guard.begin()
    guard.unmount()
    expect(guard.isMounted).toBe(false)
    expect(oldRequest()).toBe(false)
    guard.mount()
    expect(oldRequest()).toBe(false)
    expect(guard.begin()()).toBe(true)
  })
})
