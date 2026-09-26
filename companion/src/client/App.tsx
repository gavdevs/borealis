import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { AccountSummary, AllowlistItem, DeviceSummary, JobSummary, PairingSummary, PlaySearchResult } from '../shared/api.js'
import { ApiError, apiRequest } from './api.js'

const LEGACY_TOKEN_KEY = 'borealis.admin-token.v1'
const THEME_KEY = 'borealis.theme.v1'
type Page = 'home' | 'apps' | 'pair' | 'profile'
type Theme = 'system' | 'light' | 'dark'
type CompanionData = { allowlist: AllowlistItem[]; devices: DeviceSummary[] }
type AccountResponse = { account: AccountSummary }

const borealisMark = (
  <svg className="borealis-mark" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d="M6.8 5.9A8 8 0 1 0 18.1 17.2" />
    <path d="M12 12L19.8 4.2M14.8 4.2H19.8V9.2" />
  </svg>
)

function readStorage(kind: 'sessionStorage' | 'localStorage', key: string): string {
  try { return window[kind].getItem(key) ?? '' } catch { return '' }
}

function saveStorage(kind: 'sessionStorage' | 'localStorage', key: string, value: string) {
  try {
    if (value) window[kind].setItem(key, value)
    else window[kind].removeItem(key)
  } catch { /* The current page still works when browser storage is disabled. */ }
}

export function App() {
  const [account, setAccount] = useState<AccountSummary | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [sessionError, setSessionError] = useState('')
  const [sessionCheck, setSessionCheck] = useState(0)
  const [bootstrapAvailable, setBootstrapAvailable] = useState(false)
  const [authNotice, setAuthNotice] = useState('')
  const [hash, setHash] = useState(() => window.location.hash)
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = readStorage('localStorage', THEME_KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  })
  const [, route, section] = hash.split('/')
  const page: Page = route === 'apps' || route === 'pair' || route === 'profile' ? route : 'home'
  useEffect(() => {
    let current = true
    saveStorage('sessionStorage', LEGACY_TOKEN_KEY, '')
    setCheckingSession(true); setSessionError('')
    void apiRequest<{ account: AccountSummary | null; bootstrapAvailable: boolean }>('/auth/session')
      .then((response) => {
        if (!current) return
        setAccount(response.account); setBootstrapAvailable(response.bootstrapAvailable)
      })
      .catch((caught) => { if (current) setSessionError(messageFor(caught)) })
      .finally(() => { if (current) setCheckingSession(false) })
    return () => { current = false }
  }, [sessionCheck])
  useEffect(() => {
    const changed = () => setHash(window.location.hash)
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    saveStorage('localStorage', THEME_KEY, theme)
  }, [theme])
  useEffect(() => {
    document.title = `${account ? ({ home: 'Home', apps: 'Apps', pair: 'Pair a phone', profile: 'Profile' }[page]) : 'Sign in'} · Borealis`
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(section || 'main')
      target?.focus({ preventScroll: true })
      if (section) target?.scrollIntoView({ block: 'start' })
      else window.scrollTo({ top: 0 })
    })
    return () => cancelAnimationFrame(frame)
  }, [page, section, account])
  const signedIn = useCallback((response: AccountResponse) => {
    setAccount(response.account); setAuthNotice(''); window.location.hash = '/home'
    if (response.account.role === 'curator') setBootstrapAvailable(false)
  }, [])
  const lock = useCallback(() => {
    setAccount(null); setAuthNotice('Your session ended. Sign in again to continue.')
  }, [])
  async function signOut() {
    await apiRequest('/auth/signout', { method: 'POST', body: {} })
    setAccount(null); setAuthNotice('You’re signed out.'); window.location.hash = '/home'
  }
  function toggleTheme() {
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    setTheme(dark ? 'light' : 'dark')
  }
  return (
    <div className="companion">
      <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById('main')?.focus(); document.getElementById('main')?.scrollIntoView() }}>Skip to content</a>
      <header className="topbar">
        <a className="wordmark" href="#/home" aria-label="Borealis companion home">{borealisMark}Borealis</a>
        <nav className="nav" aria-label="Companion navigation">
          {account ? <><a href="#/home" aria-current={page === 'home' || page === 'pair' ? 'page' : undefined}>Home</a><a href="#/apps" aria-current={page === 'apps' ? 'page' : undefined}>Apps</a><a href="#/profile" aria-current={page === 'profile' ? 'page' : undefined}>Profile</a></> : null}
          <button className="theme-toggle" onClick={toggleTheme} aria-label="Switch light or dark theme" title="Switch light or dark theme"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" /></svg></button>
        </nav>
      </header>
      <main className="main" id="main" tabIndex={-1}>
        {checkingSession ? <div className="layout"><p className="status-line" role="status">Opening your companion…</p></div>
          : sessionError ? <div className="auth-layout"><div><h1>Could not open Borealis.</h1><p className="error" role="alert">{sessionError}</p><button className="action" onClick={() => setSessionCheck((current) => current + 1)}>Try again</button></div></div>
            : account ? page === 'profile' ? <Profile account={account} onSignOut={signOut} onLock={lock} /> : <Companion key={account.id} account={account} onLock={lock} page={page} />
              : <AccountGate onSignIn={signedIn} bootstrapAvailable={bootstrapAvailable} notice={authNotice} />}
      </main>
      <footer className="footer"><span>Companion for a more intentional phone.</span><span>Borealis · Light Phone III</span></footer>
    </div>
  )
}

function AccountGate({ onSignIn, bootstrapAvailable, notice }: { onSignIn: (response: AccountResponse) => void; bootstrapAvailable: boolean; notice: string }) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'bootstrap'>('signin')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [adminToken, setAdminToken] = useState('')
  const [error, setError] = useState('')
  const [working, setWorking] = useState('')
  const workingRef = useRef(false)
  async function run(name: string, action: () => Promise<void>) {
    if (workingRef.current) return
    workingRef.current = true
    setError(''); setWorking(name)
    try { await action() } catch (caught) { setError(messageFor(caught)) } finally { workingRef.current = false; setWorking('') }
  }
  function changeMode(next: typeof mode) {
    setMode(next); setPassword(''); setConfirmation(''); setAdminToken(''); setError('')
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (mode !== 'signin' && password !== confirmation) { setError('The passwords don’t match. Enter the same password in both fields.'); return }
    await run(mode, async () => {
      const response = await apiRequest<AccountResponse>(`/auth/${mode}`, { method: 'POST', body: { username: username.trim(), password, ...(mode === 'bootstrap' ? { adminToken } : {}) } })
      setPassword(''); setConfirmation(''); setAdminToken(''); onSignIn(response)
    })
  }
  const creating = mode !== 'signin'
  return <div className="auth-layout">
    <aside className="intro"><p className="kicker">Borealis companion</p><h1>A little more. Only what you need.</h1><p className="lede">Choose the essential apps for your Light Phone. Search and selection stay here.</p></aside>
    <section className="auth-panel" aria-labelledby="login-title"><p className="label">{mode === 'bootstrap' ? 'Server owner' : 'Welcome'}</p><h2 id="login-title">{mode === 'bootstrap' ? 'Set up your curator account.' : creating ? 'Create your account.' : 'Sign in to your companion.'}</h2><p className="section-copy">{mode === 'bootstrap' ? 'Keep your existing apps and phones. Choose a username and password to replace your admin token.' : creating ? 'Choose a username and password. No email address needed.' : 'Your apps and connected phones, right where you left them.'}</p>
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <form onSubmit={submit}>
        <label className="field" htmlFor="username"><span>Username</span><input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={32} pattern="[A-Za-z0-9_]{3,32}" required disabled={Boolean(working)} aria-describedby={creating ? 'username-hint' : undefined} /></label>
        {creating ? <p className="field-hint" id="username-hint">3–32 letters, numbers, or underscores. Capitalization doesn’t matter.</p> : null}
        <label className="field" htmlFor="password"><span>Password</span><input id="password" name="password" type="password" autoComplete={creating ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={creating ? 15 : undefined} maxLength={128} required disabled={Boolean(working)} aria-describedby={creating ? 'password-hint' : undefined} /></label>
        {creating ? <><p className="field-hint" id="password-hint">At least 15 characters. A few memorable words work well.</p><label className="field" htmlFor="confirm-password"><span>Confirm password</span><input id="confirm-password" name="confirm-password" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={15} maxLength={128} required disabled={Boolean(working)} /></label></> : null}
        {mode === 'bootstrap' ? <label className="field" htmlFor="admin-token"><span>Existing admin token</span><input id="admin-token" type="password" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} autoComplete="off" required disabled={Boolean(working)} /></label> : null}
        {creating ? <p className="account-warning">Save your username and password somewhere safe. Without an email address, there’s no email password reset.</p> : null}
        <div className="actions"><button className="action" disabled={Boolean(working) || !username.trim() || !password}>{working ? (creating ? 'Creating account…' : 'Signing in…') : mode === 'bootstrap' ? 'Create curator account' : creating ? 'Create account' : 'Sign in'}</button></div>
      </form>
      <div className="auth-create"><p>{creating ? 'Already have an account?' : 'New to Borealis?'}</p><button className="action secondary" disabled={Boolean(working)} onClick={() => changeMode(creating ? 'signin' : 'signup')}>{creating ? 'Back to sign in' : 'Create an account'}</button></div>
      {bootstrapAvailable && mode !== 'bootstrap' ? <details className="details"><summary>Set up this server</summary><p className="field-hint">For the server owner only. Convert existing admin access to a curator account.</p><div className="actions"><button className="action secondary" disabled={Boolean(working)} onClick={() => changeMode('bootstrap')}>Set up curator account</button></div></details> : null}
    </section>
  </div>
}

function Profile({ account, onSignOut, onLock }: { account: AccountSummary; onSignOut: () => Promise<void>; onLock: () => void }) {
  const [changingPassword, setChangingPassword] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  async function run(name: string, action: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true; setBusy(name); setError(''); setNotice('')
    try { await action() }
    catch (caught) { if (caught instanceof ApiError && caught.status === 401) onLock(); else setError(messageFor(caught)) }
    finally { busyRef.current = false; setBusy('') }
  }
  function closePasswordForm() {
    setChangingPassword(false); setCurrentPassword(''); setNewPassword(''); setConfirmation(''); setError('')
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault()
    if (newPassword !== confirmation) { setError('The new passwords don’t match. Enter the same password in both fields.'); return }
    await run('password', async () => {
      await apiRequest<AccountResponse>('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } })
      closePasswordForm(); setNotice('Password changed. Other browser sessions are signed out. Your phones are still connected.')
    })
  }
  return <div className="layout">
    <aside className="intro"><p className="kicker">Profile</p><h1>A place of your own.</h1><p className="lede">Your account keeps your apps and phones together. No email address needed.</p></aside>
    <div className="workspace">{error ? <p className="error" role="alert">{error}</p> : null}{notice ? <p className="notice" role="status">{notice}</p> : null}
      <Section id="account" label="Account" title={account.username}><p className="section-copy">Created {formatTime(account.createdAt)}.{account.role === 'curator' ? ' You curate the apps available through this server.' : ' Your apps and phones belong to this account.'}</p></Section>
      <Section id="account-access" label="Access" title="Your password"><p className="section-copy">Keep your username and password somewhere safe. There’s no email password reset.</p>
        {changingPassword ? <form className="password-form" onSubmit={changePassword}>
          <input type="hidden" name="username" autoComplete="username" value={account.username} />
          <label className="field"><span>Current password</span><input name="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} maxLength={128} required disabled={Boolean(busy)} /></label>
          <label className="field"><span>New password</span><input name="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={15} maxLength={128} required disabled={Boolean(busy)} aria-describedby="new-password-hint" /></label><p className="field-hint" id="new-password-hint">15–128 characters. Spaces are welcome.</p>
          <label className="field"><span>Confirm new password</span><input name="confirm-new-password" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={15} maxLength={128} required disabled={Boolean(busy)} /></label>
          <p className="account-warning">Changing your password signs out other browsers. Your paired phones stay connected.</p>
          <div className="actions"><button className="action secondary" type="button" disabled={Boolean(busy)} onClick={closePasswordForm}>Cancel</button><button className="action" disabled={Boolean(busy)}>{busy === 'password' ? 'Changing password…' : 'Save new password'}</button></div>
        </form> : <button className="action" disabled={Boolean(busy)} onClick={() => setChangingPassword(true)}>Change password</button>}
      </Section>
      <Section id="session" label="This browser" title="Sign out"><p className="section-copy">Signing out here doesn’t disconnect your phones.</p><button className="action" disabled={Boolean(busy)} onClick={() => void run('signout', onSignOut)}>{busy === 'signout' ? 'Signing out…' : 'Sign out'}</button></Section>
    </div>
  </div>
}

function Companion({ account, onLock, page }: { account: AccountSummary; onLock: () => void; page: Exclude<Page, 'profile'> }) {
  const [data, setData] = useState<CompanionData>({ allowlist: [], devices: [] })
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [jobsLoading, setJobsLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const busyRef = useRef(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null)
  const [results, setResults] = useState<PlaySearchResult[]>([])
  const [selectedResults, setSelectedResults] = useState<string[]>([])
  const [selectedApps, setSelectedApps] = useState<string[]>([])
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  const [revokeId, setRevokeId] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [pairingPreview, setPairingPreview] = useState<PairingSummary | null>(null)
  const selectedDevice = data.devices.find((device) => device.id === selectedDeviceId && !device.revokedAt && device.activatedAt) ?? null
  const readyPhones = data.devices.filter((device) => !device.revokedAt && device.activatedAt)
  const activePhones = data.devices.filter((device) => !device.revokedAt)
  const approvedPackages = new Set(data.allowlist.map((item) => item.packageName))
  const availableResults = results.filter((item) => !approvedPackages.has(item.packageName))
  const curator = account.role === 'curator'

  const handleError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) onLock()
    else setError(messageFor(caught))
  }, [onLock])
  const refresh = useCallback(async () => {
    const [apps, phones] = await Promise.all([
      apiRequest<{ items: AllowlistItem[] }>('/me/apps'),
      apiRequest<{ devices: DeviceSummary[] }>('/me/devices'),
    ])
    setData({ allowlist: apps.items, devices: phones.devices })
    setSelectedDeviceId((current) => phones.devices.some((phone) => phone.id === current && !phone.revokedAt && phone.activatedAt) ? current : phones.devices.find((phone) => !phone.revokedAt && phone.activatedAt)?.id ?? '')
    setSelectedApps((current) => current.filter((name) => apps.items.some((item) => item.packageName === name)))
    setSelectedResults((current) => current.filter((name) => !apps.items.some((item) => item.packageName === name)))
    setRevision((current) => current + 1)
  }, [])
  useEffect(() => { void refresh().catch(handleError).finally(() => setLoading(false)) }, [refresh, handleError])
  useEffect(() => {
    let current = true
    setJobs([]); setJobsLoading(Boolean(selectedDeviceId))
    if (selectedDeviceId) void apiRequest<{ jobs: JobSummary[] }>(`/me/devices/${selectedDeviceId}/jobs`)
      .then((response) => { if (current) setJobs(response.jobs) })
      .catch((caught) => { if (current) handleError(caught) })
      .finally(() => { if (current) setJobsLoading(false) })
    return () => { current = false }
  }, [selectedDeviceId, revision, handleError])

  async function runAction(name: string, action: () => Promise<void>, reload = true): Promise<boolean> {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(name); setError(''); setNotice('')
    try {
      await action()
      if (reload) await refresh()
      return true
    } catch (caught) {
      handleError(caught)
      // Reconcile completed requests after a partial bulk failure.
      if (reload) await refresh().catch(() => undefined)
      return false
    } finally { busyRef.current = false; setBusy('') }
  }

  async function search(event: FormEvent) {
    event.preventDefault()
    const term = query.trim()
    if (term.length < 2) return
    await runAction('search', async () => {
      const response = await apiRequest<{ results: PlaySearchResult[] }>(`/catalog/search?q=${encodeURIComponent(term)}&limit=20`)
      setResults(response.results); setSelectedResults([]); setSearchedQuery(term)
    }, false)
  }
  async function addSelected() {
    const selected = availableResults.filter((item) => selectedResults.includes(item.packageName))
    if (!selected.length) return
    await runAction('add', async () => {
      for (const item of selected) {
        if (curator) {
          try {
            await apiRequest('/admin/allowlist', { method: 'POST', body: {
              packageName: item.packageName, displayName: item.displayName, publisher: item.publisher || 'Publisher not listed', reason: 'Selected by the curator for essential use.', signerSha256: null,
            } })
          } catch (caught) { if (!(caught instanceof ApiError) || caught.status !== 409) throw caught }
        }
        const response = await apiRequest<{ item: AllowlistItem }>('/me/apps', { method: 'POST', body: { packageName: item.packageName } })
        setData((current) => ({ ...current, allowlist: [...current.allowlist.filter((existing) => existing.packageName !== item.packageName), response.item] }))
        setSelectedResults((current) => current.filter((name) => name !== item.packageName))
      }
      setNotice(`${selected.length === 1 ? selected[0].displayName : `${selected.length} apps`} added to your apps. Select below to send to a phone.`)
    })
  }
  async function sendSelected() {
    if (!selectedDevice || !selectedApps.length) return
    const phone = selectedDevice
    const chosen = [...selectedApps]
    await runAction('send', async () => {
      for (const packageName of chosen) {
        if (!phone.assignments.includes(packageName)) await apiRequest(`/me/devices/${phone.id}/assignments`, { method: 'POST', body: { packageName } })
        setSelectedApps((current) => current.filter((name) => name !== packageName))
      }
      setConfirmRemoval(false)
      setNotice(`Your selection is available to ${phone.label}. Open Borealis on the phone to continue.`)
    })
  }
  async function removeSelected() {
    const chosen = [...selectedApps]
    const ok = await runAction('remove', async () => {
      for (const packageName of chosen) {
        await apiRequest(`/me/apps/${encodeURIComponent(packageName)}`, { method: 'DELETE' })
        setSelectedApps((current) => current.filter((name) => name !== packageName))
      }
      setNotice('Apps removed from Borealis. Apps already installed on a phone have not been uninstalled.')
    })
    if (ok) setConfirmRemoval(false)
  }
  async function previewPairing(event: FormEvent) {
    event.preventDefault()
    const code = pairingCode.toUpperCase().replace(/[\s-]/g, '')
    await runAction('pair-preview', async () => {
      const response = await apiRequest<{ pairing: PairingSummary }>('/me/pairings/preview', { method: 'POST', body: { userCode: code } })
      setPairingPreview(response.pairing)
    }, false)
  }
  async function approvePairing() {
    if (!pairingPreview) return
    const ok = await runAction('pair', async () => {
      const response = await apiRequest<{ device: DeviceSummary }>('/me/pairings/approve', { method: 'POST', body: { userCode: pairingPreview.userCode } })
      setNotice(`${response.device.label} approved. Confirm pairing on your phone, then refresh here.`)
    })
    if (ok) { setPairingPreview(null); setPairingCode(''); window.location.hash = '/home' }
  }
  async function revokePhone(device: DeviceSummary) {
    const ok = await runAction('revoke', async () => {
      await apiRequest(`/me/devices/${device.id}`, { method: 'DELETE' })
      setNotice(`${device.label} disconnected. Apps already installed on it have not been uninstalled.`)
    })
    if (ok) setRevokeId('')
  }
  async function queue(packageName: string) {
    if (!selectedDevice) return
    await runAction('queue', async () => {
      await apiRequest(`/me/devices/${selectedDevice.id}/jobs`, { method: 'POST', body: { packageName } })
      setNotice('An install or update check is waiting for your phone to sync.')
    })
  }
  async function approvePublisher(job: JobSummary, signer: string) {
    const app = data.allowlist.find((item) => item.packageName === job.packageName)
    if (!app || !selectedDevice || !curator) return
    await runAction('publisher', async () => {
      await apiRequest(`/admin/allowlist/${encodeURIComponent(app.packageName)}`, { method: 'PUT', body: { displayName: app.displayName, publisher: app.publisher, reason: app.reason, signerSha256: signer } })
      await apiRequest(`/me/devices/${selectedDevice.id}/jobs`, { method: 'POST', body: { packageName: app.packageName } })
      setNotice(`${app.displayName}'s publisher approved. Installation can continue after the next phone sync.`)
    })
  }

  const messages = <>{error ? <div className="error" role="alert">{error}</div> : null}{notice ? <div className="notice" role="status">{notice}</div> : null}{loading ? <p className="status-line" role="status">Loading your companion…</p> : null}</>
  const refreshButton = <button className="action secondary" disabled={Boolean(busy)} onClick={() => void runAction('refresh', async () => { setNotice('Companion refreshed.') })}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh'}</button>

  if (page === 'pair') return <div className="layout">
    <aside className="intro"><p className="kicker">Pairing</p><h1>Bring your phone along.</h1><p className="lede">Open Borealis on your Light Phone and start pairing. Enter the code shown on its screen here.</p></aside>
    <div className="workspace">{messages}<section className="pair-panel" aria-labelledby="pair-title">
      {pairingPreview ? <><p className="label">Confirm phone</p><h2 id="pair-title">Is this your phone?</h2><p className="row-title">{pairingPreview.deviceLabel}</p><p className="section-copy">Approve this phone to let it receive the apps you choose. You can disconnect it at any time.</p><p className="technical">{pairingPreview.userCode}</p><div className="actions"><button className="action secondary" disabled={Boolean(busy)} onClick={() => setPairingPreview(null)}>Back</button><button className="action" disabled={Boolean(busy)} onClick={() => void approvePairing()}>{busy === 'pair' ? 'Approving…' : 'Approve phone'}</button></div></> : <>
        <p className="label">Enter code</p><h2 id="pair-title">Pair a phone</h2><p className="section-copy">Pairing codes expire quickly and can only be used once.</p>
        <form onSubmit={previewPairing}><label className="field"><span className="label">Pairing code</span><input className="code-input" value={pairingCode} onChange={(event) => setPairingCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH-JKMN" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} maxLength={14} required /></label><div className="actions"><a className="action secondary" href="#/home">Back</a><button className="action" disabled={Boolean(busy) || pairingCode.replace(/[\s-]/g, '').length !== 12}>{busy === 'pair-preview' ? 'Checking…' : 'Continue'}</button></div></form>
      </>}
    </section></div>
  </div>

  if (page === 'home') return <div className="layout">
    <aside className="intro"><p className="kicker">Home</p><h1>Keep your phone simple.</h1><p className="lede">A place for the few apps you need. Choose them here. Leave the browsing behind.</p><dl className="stats"><div><dt>Phones</dt><dd>{readyPhones.length} paired</dd></div><div><dt>Your apps</dt><dd>{data.allowlist.length} chosen</dd></div></dl><nav className="section-index" aria-label="Home sections"><a href="#/home/phones">Phones</a><a href="#/home/activity">Activity</a><a href="#/apps">Choose apps <span aria-hidden="true">↗</span></a></nav></aside>
    <div className="workspace">{messages}
      <Section id="phones" label="Phones" title="Your connected phones" action={<a className="action" href="#/pair">Pair a phone</a>}>
        <p className="section-copy">Each phone receives only the apps you send to it.</p>
        {!data.devices.length ? <p className="empty">No phones paired yet. Open Borealis on your phone to get started.</p> : <div className="list">{data.devices.map((device) => <article className="list-row" key={device.id}>
          <div className="row-copy"><h3 className="row-title">{device.label}</h3><p className="row-meta">{device.revokedAt ? 'Disconnected' : !device.activatedAt ? 'Confirm pairing on your phone' : device.lastSeenAt ? `Last synced ${formatTime(device.lastSeenAt)}` : 'Paired · waiting for first sync'}</p>{!device.revokedAt && device.activatedAt ? <p className="row-meta">{device.assignments.length} {device.assignments.length === 1 ? 'app' : 'apps'} selected</p> : null}
            {revokeId === device.id ? <div className="confirm-panel"><p>Disconnect this phone? It will stop receiving apps and updates from Borealis. Installed apps will remain.</p><div className="actions"><button className="action secondary" disabled={Boolean(busy)} onClick={() => setRevokeId('')}>Cancel</button><button className="action" disabled={Boolean(busy)} onClick={() => void revokePhone(device)}>Disconnect phone</button></div></div> : null}
          </div>{!device.revokedAt && revokeId !== device.id ? <button className="action secondary" disabled={Boolean(busy)} onClick={() => setRevokeId(device.id)} aria-label={`Disconnect ${device.label}`}>Disconnect</button> : null}
        </article>)}</div>}
      </Section>
      <Section id="activity" label="Activity" title="What’s reaching your phone" action={refreshButton}>
        {readyPhones.length ? <PhoneSelect phones={readyPhones} selected={selectedDeviceId} onSelect={setSelectedDeviceId} disabled={Boolean(busy)} /> : <p className="empty">Pair a phone to see install and update activity here.</p>}
        {jobsLoading ? <p className="status-line" role="status">Loading phone activity…</p> : selectedDevice ? <>{!jobs.length ? <p className="empty">Nothing waiting. <a className="inline-link" href="#/apps">Choose an app</a> to send to your phone.</p> : <div className="list">{jobs.map((job) => <JobRow key={job.id} job={job} busy={Boolean(busy)} canAct={approvedPackages.has(job.packageName) && selectedDevice.assignments.includes(job.packageName)} canApprove={curator} onQueue={queue} onApprove={approvePublisher} />)}</div>}</> : null}
      </Section>
    </div>
  </div>

  return <div className="layout">
    <aside className="intro"><p className="kicker">Apps</p><h1>Choose what reaches your phone.</h1><p className="lede">{curator ? 'Choose essential apps for the shared catalog, then select what reaches your own phones.' : 'Find an app in the approved catalog, add it to your collection, then choose which phone receives it.'}</p><dl className="stats"><div><dt>Your apps</dt><dd>{data.allowlist.length} chosen</dd></div><div><dt>Phones</dt><dd>{readyPhones.length} paired</dd></div></dl><nav className="section-index" aria-label="App sections"><a href="#/apps/find">Find</a><a href="#/apps/your-apps">Your apps</a><a href="#/home/activity">Phone activity <span aria-hidden="true">↗</span></a></nav></aside>
    <div className="workspace">{messages}
      <Section id="find" label="Find" title="Find the app you need."><p className="section-copy">{curator ? 'You’re searching Google Play as a curator. Adding an app also approves it for everyone on this server. Choose only essential apps that belong on a Light Phone.' : 'Search the apps approved for this Borealis server. Your selections stay private, and there’s no store to browse on your phone.'}</p><form onSubmit={search} role="search"><label className="field" htmlFor="catalog-search"><span className="label">Search apps</span><input id="catalog-search" type="search" placeholder="App or publisher name" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" minLength={2} maxLength={120} required /></label><div className="actions"><button className="action" disabled={Boolean(busy) || query.trim().length < 2}>{busy === 'search' ? 'Searching…' : 'Search'}</button></div></form></Section>
      {searchedQuery !== null ? <Section id="results" label="Results" title={searchedQuery} action={<span className="label">{results.length} found</span>}>
        {!results.length ? <p className="empty">No apps found. Try another name or publisher.</p> : <>
          <div className="actions"><button className="action secondary" disabled={Boolean(busy) || !availableResults.length} onClick={() => setSelectedResults(selectedResults.length === availableResults.length ? [] : availableResults.map((item) => item.packageName))}>{availableResults.length > 0 && selectedResults.length === availableResults.length ? 'Clear selection' : 'Select all'}</button></div>
          <div className="list">{results.map((item) => {
            const added = approvedPackages.has(item.packageName)
            return <label className="list-row selection-row" key={item.packageName}><input type="checkbox" checked={selectedResults.includes(item.packageName)} onChange={() => toggleSelection(setSelectedResults, item.packageName)} disabled={added || Boolean(busy)} aria-label={`Select ${item.displayName}`} /><span className="row-copy"><strong className="row-title">{item.displayName}</strong><span className="row-meta">{item.publisher}</span><span className="technical">{item.packageName}</span></span>{added ? <span className="row-status">Added</span> : null}</label>
          })}</div>
          {selectedResults.length ? <div className="selection-rail"><span className="selection-count" aria-live="polite">{selectedResults.length} selected</span><button className="action" disabled={Boolean(busy)} onClick={() => void addSelected()}>{busy === 'add' ? 'Adding…' : 'Add to your apps'}</button></div> : null}
        </>}
      </Section> : null}
      <Section id="your-apps" label="Your apps" title="Only what you’ve chosen." action={refreshButton}>
        <p className="section-copy">Select apps to send to a paired phone. Removing an app here stops future access through Borealis; it does not uninstall it.</p>
        {!data.allowlist.length ? <p className="empty">No apps chosen yet. Search above to add your first.</p> : <>
          <div className="actions"><button className="action secondary" disabled={Boolean(busy)} onClick={() => { setSelectedApps(selectedApps.length === data.allowlist.length ? [] : data.allowlist.map((item) => item.packageName)); setConfirmRemoval(false) }}>{selectedApps.length === data.allowlist.length ? 'Clear selection' : 'Select all'}</button></div>
          <div className="list">{data.allowlist.map((item) => <article className="list-row selection-row" key={item.packageName} onClick={(event) => {
            if (busy || (event.target as HTMLElement).closest('input, label, button, a, select, details')) return
            toggleSelection(setSelectedApps, item.packageName)
            setConfirmRemoval(false)
          }}>
            <input id={`app-${item.packageName}`} type="checkbox" checked={selectedApps.includes(item.packageName)} onChange={() => { toggleSelection(setSelectedApps, item.packageName); setConfirmRemoval(false) }} disabled={Boolean(busy)} aria-label={`Select ${item.displayName}`} />
            <div className="row-copy"><label htmlFor={`app-${item.packageName}`}><strong className="row-title">{item.displayName}</strong><span className="row-meta">{item.publisher}</span></label><details className="details"><summary>App details</summary><p className="technical">{item.packageName}</p><p className="row-meta">{item.signerSha256 ? 'Publisher signature approved.' : 'Publisher signature will need review before the first installation.'}</p>{item.signerSha256 ? <code className="technical">{item.signerSha256}</code> : null}</details></div>
            {selectedDevice?.assignments.includes(item.packageName) ? <span className="row-status">Sent to phone</span> : null}
          </article>)}</div>
          {selectedApps.length ? <>
            <div className="selection-rail"><span className="selection-count" aria-live="polite">{selectedApps.length} selected</span>{readyPhones.length ? <PhoneSelect phones={readyPhones} selected={selectedDeviceId} onSelect={setSelectedDeviceId} disabled={Boolean(busy)} /> : <a className="action" href="#/pair">Pair a phone</a>}<button className="action" disabled={Boolean(busy) || !selectedDevice} onClick={() => void sendSelected()}>{busy === 'send' ? 'Sending…' : 'Send to phone'}</button><button className="action secondary" disabled={Boolean(busy)} onClick={() => setConfirmRemoval(true)}>Remove</button></div>
            {confirmRemoval ? <div className="confirm-panel" role="group" aria-label="Confirm app removal"><h3>Remove {selectedApps.length === 1 ? 'this app' : 'these apps'} from your apps?</h3><p>This stops access for your connected phones and cancels your outstanding requests. Installed apps and other people’s selections stay unchanged.</p><div className="actions"><button className="action secondary" disabled={Boolean(busy)} onClick={() => setConfirmRemoval(false)}>Cancel</button><button className="action" disabled={Boolean(busy)} onClick={() => void removeSelected()}>{busy === 'remove' ? 'Removing…' : 'Remove from apps'}</button></div></div> : null}
          </> : null}
        </>}
        {!readyPhones.length && !loading ? <p className="field-hint">{activePhones.length ? 'Finish pairing on your phone, then refresh to send apps.' : 'You can choose apps now and pair a phone later.'}</p> : null}
      </Section>
    </div>
  </div>
}

function Section({ id, label, title, action, children }: { id: string; label: string; title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="section" id={id} tabIndex={-1} aria-labelledby={`${id}-title`}><header className="section-header"><div><p className="label">{label}</p><h2 id={`${id}-title`}>{title}</h2></div>{action}</header>{children}</section>
}
function PhoneSelect({ phones, selected, onSelect, disabled }: { phones: DeviceSummary[]; selected: string; onSelect: (id: string) => void; disabled: boolean }) {
  return <label className="field select-phone"><span className="label">Phone</span><select value={selected} onChange={(event) => onSelect(event.target.value)} disabled={disabled}>{phones.map((phone) => <option value={phone.id} key={phone.id}>{phone.label}</option>)}</select></label>
}
function JobRow({ job, busy, canAct, canApprove, onQueue, onApprove }: { job: JobSummary; busy: boolean; canAct: boolean; canApprove: boolean; onQueue: (name: string) => Promise<void>; onApprove: (job: JobSummary, signer: string) => Promise<void> }) {
  const signer = job.observedSignerSha256[0]
  const retry = ['failed', 'cancelled', 'succeeded'].includes(job.status)
  return <article className="list-row"><div className="row-copy"><h3 className="row-title">{job.displayName}</h3><p className="row-meta">{humanStatus(job.status)}{job.installedVersionCode !== null ? ` · version ${job.installedVersionCode}` : ''}</p>{job.message ? <p className="row-meta">{job.message}</p> : null}
    {job.status === 'review_required' && signer && canAct ? canApprove ? <details className="details"><summary>Review publisher</summary><p className="row-meta">Compare this signing fingerprint with a trusted copy of the app before approving it. This approves the publisher for everyone using this server, not only your phone.</p><code className="technical">{signer}</code><div className="actions"><button className="action" disabled={busy} onClick={() => void onApprove(job, signer)}>Approve publisher and continue</button></div></details> : <p className="row-meta">The server curator needs to approve this app’s publisher before installation can continue.</p> : null}
    <details className="details"><summary>Request details</summary><p className="technical">{job.packageName}</p><p className="row-meta">Requested {formatTime(job.createdAt)}</p></details>
  </div>{retry && canAct ? <button className="action secondary" disabled={busy} onClick={() => void onQueue(job.packageName)}>{job.status === 'succeeded' ? 'Check for update' : 'Try again'}</button> : null}</article>
}
function toggleSelection(set: (update: (current: string[]) => string[]) => void, name: string) {
  set((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name])
}
function humanStatus(status: JobSummary['status']): string {
  return { queued: 'Waiting for phone', delivered: 'Received by phone', installing: 'Preparing installation', awaiting_user_action: 'Confirm installation on your phone', review_required: 'Publisher review needed', succeeded: 'Installed', failed: 'Installation failed', cancelled: 'Cancelled' }[status]
}
function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Borealis could not complete that action. Try again.'
}
