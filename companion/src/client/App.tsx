import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { AllowlistItem, DeviceSummary, JobSummary, PairingSummary, PlaySearchResult } from '../shared/api.js'
import { ApiError, apiRequest } from './api.js'

const SESSION_TOKEN_KEY = 'borealis.admin-token.v1'
const THEME_KEY = 'borealis.theme.v1'
type Page = 'home' | 'apps' | 'pair'
type Theme = 'system' | 'light' | 'dark'
type CompanionData = { allowlist: AllowlistItem[]; devices: DeviceSummary[]; pairings: PairingSummary[] }

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
  const [token, setToken] = useState(() => readStorage('sessionStorage', SESSION_TOKEN_KEY))
  const [hash, setHash] = useState(() => window.location.hash)
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = readStorage('localStorage', THEME_KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  })
  const [, route, section] = hash.split('/')
  const page: Page = route === 'apps' || route === 'pair' ? route : 'home'
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
    document.title = `${token ? ({ home: 'Home', apps: 'Apps', pair: 'Pair a phone' }[page]) : 'Log in'} · Borealis`
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(section || 'main')
      target?.focus({ preventScroll: true })
      if (section) target?.scrollIntoView({ block: 'start' })
      else window.scrollTo({ top: 0 })
    })
    return () => cancelAnimationFrame(frame)
  }, [page, section, token])
  const unlock = useCallback(async (candidate: string) => {
    await apiRequest('/admin/allowlist', { token: candidate })
    saveStorage('sessionStorage', SESSION_TOKEN_KEY, candidate)
    setToken(candidate)
  }, [])
  const lock = useCallback(() => {
    saveStorage('sessionStorage', SESSION_TOKEN_KEY, '')
    setToken('')
  }, [])
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
          {token ? <><a href="#/home" aria-current={page !== 'apps' ? 'page' : undefined}>Home</a><a href="#/apps" aria-current={page === 'apps' ? 'page' : undefined}>Apps</a></> : null}
          <button className="theme-toggle" onClick={toggleTheme} aria-label="Switch light or dark theme" title="Switch light or dark theme"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" /></svg></button>
          {token ? <button onClick={lock}>Log out</button> : null}
        </nav>
      </header>
      <main className="main" id="main" tabIndex={-1}>{token ? <Companion token={token} onLock={lock} page={page} /> : <TokenGate onUnlock={unlock} />}</main>
      <footer className="footer"><span>Companion for a more intentional phone.</span><span>Borealis · Light Phone III</span></footer>
    </div>
  )
}

function TokenGate({ onUnlock }: { onUnlock: (token: string) => Promise<void> }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(''); setWorking(true)
    try { await onUnlock(value.trim()) } catch (caught) { setError(messageFor(caught)) } finally { setWorking(false) }
  }
  return <div className="auth-layout">
    <aside className="intro"><p className="kicker">Borealis companion</p><h1>A little more. Only what you need.</h1><p className="lede">Choose the essential apps for your Light Phone. Search and selection stay here.</p></aside>
    <section className="auth-panel" aria-labelledby="login-title"><p className="label">Welcome</p><h2 id="login-title">Log in to your companion.</h2><p className="section-copy">Use the admin token for this Borealis server.</p>
      <form onSubmit={submit}><label className="field" htmlFor="admin-token"><span className="label">Admin token</span><input id="admin-token" type="password" autoComplete="current-password" value={value} onChange={(event) => setValue(event.target.value)} required aria-describedby="token-hint" /></label><p className="field-hint" id="token-hint">Kept only for this browser session.</p>{error ? <p className="error" role="alert">{error}</p> : null}<div className="actions"><button className="action" disabled={working || !value.trim()}>{working ? 'Logging in…' : 'Log in'}</button></div></form>
    </section>
  </div>
}

function Companion({ token, onLock, page }: { token: string; onLock: () => void; page: Page }) {
  const [data, setData] = useState<CompanionData>({ allowlist: [], devices: [], pairings: [] })
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

  const handleError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) onLock()
    else setError(messageFor(caught))
  }, [onLock])
  const refresh = useCallback(async () => {
    const [apps, phones, pairings] = await Promise.all([
      apiRequest<{ items: AllowlistItem[] }>('/admin/allowlist', { token }),
      apiRequest<{ devices: DeviceSummary[] }>('/admin/devices', { token }),
      apiRequest<{ pairings: PairingSummary[] }>('/admin/pairings', { token }),
    ])
    setData({ allowlist: apps.items, devices: phones.devices, pairings: pairings.pairings })
    setSelectedDeviceId((current) => phones.devices.some((phone) => phone.id === current && !phone.revokedAt && phone.activatedAt) ? current : phones.devices.find((phone) => !phone.revokedAt && phone.activatedAt)?.id ?? '')
    setSelectedApps((current) => current.filter((name) => apps.items.some((item) => item.packageName === name)))
    setSelectedResults((current) => current.filter((name) => !apps.items.some((item) => item.packageName === name)))
    setRevision((current) => current + 1)
  }, [token])
  useEffect(() => { void refresh().catch(handleError).finally(() => setLoading(false)) }, [refresh, handleError])
  useEffect(() => {
    let current = true
    setJobs([]); setJobsLoading(Boolean(selectedDeviceId))
    if (selectedDeviceId) void apiRequest<{ jobs: JobSummary[] }>(`/admin/devices/${selectedDeviceId}/jobs`, { token })
      .then((response) => { if (current) setJobs(response.jobs) })
      .catch((caught) => { if (current) handleError(caught) })
      .finally(() => { if (current) setJobsLoading(false) })
    return () => { current = false }
  }, [selectedDeviceId, token, revision, handleError])

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
        const response = await apiRequest<{ item: AllowlistItem }>('/admin/allowlist', { token, method: 'POST', body: {
          packageName: item.packageName, displayName: item.displayName, publisher: item.publisher || 'Publisher not listed', reason: 'Selected in the companion for essential use.', signerSha256: null,
        } })
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
        if (!phone.assignments.includes(packageName)) await apiRequest(`/admin/devices/${phone.id}/assignments`, { token, method: 'POST', body: { packageName } })
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
        await apiRequest(`/admin/allowlist/${encodeURIComponent(packageName)}`, { token, method: 'DELETE' })
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
      const response = await apiRequest<{ pairings: PairingSummary[] }>('/admin/pairings', { token })
      const pending = response.pairings.find((item) => item.userCode.replace(/[\s-]/g, '') === code && item.state === 'pending' && Date.parse(item.expiresAt) > Date.now())
      if (!pending) throw new Error('That code is not available. Start pairing on your phone and enter the new code.')
      setPairingPreview(pending)
    }, false)
  }
  async function approvePairing() {
    if (!pairingPreview) return
    const ok = await runAction('pair', async () => {
      const response = await apiRequest<{ device: DeviceSummary }>('/admin/pairings/approve', { token, method: 'POST', body: { userCode: pairingPreview.userCode } })
      setNotice(`${response.device.label} approved. Confirm pairing on your phone, then refresh here.`)
    })
    if (ok) { setPairingPreview(null); setPairingCode(''); window.location.hash = '/home' }
  }
  async function revokePhone(device: DeviceSummary) {
    const ok = await runAction('revoke', async () => {
      await apiRequest(`/admin/devices/${device.id}`, { token, method: 'DELETE' })
      setNotice(`${device.label} disconnected. Apps already installed on it have not been uninstalled.`)
    })
    if (ok) setRevokeId('')
  }
  async function queue(packageName: string) {
    if (!selectedDevice) return
    await runAction('queue', async () => {
      await apiRequest(`/admin/devices/${selectedDevice.id}/jobs`, { token, method: 'POST', body: { packageName } })
      setNotice('An install or update check is waiting for your phone to sync.')
    })
  }
  async function approvePublisher(job: JobSummary, signer: string) {
    const app = data.allowlist.find((item) => item.packageName === job.packageName)
    if (!app || !selectedDevice) return
    await runAction('publisher', async () => {
      await apiRequest(`/admin/allowlist/${encodeURIComponent(app.packageName)}`, { token, method: 'PUT', body: { displayName: app.displayName, publisher: app.publisher, reason: app.reason, signerSha256: signer } })
      await apiRequest(`/admin/devices/${selectedDevice.id}/jobs`, { token, method: 'POST', body: { packageName: app.packageName } })
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
        {jobsLoading ? <p className="status-line" role="status">Loading phone activity…</p> : selectedDevice ? <>{!jobs.length ? <p className="empty">Nothing waiting. <a className="inline-link" href="#/apps">Choose an app</a> to send to your phone.</p> : <div className="list">{jobs.map((job) => <JobRow key={job.id} job={job} busy={Boolean(busy)} canAct={approvedPackages.has(job.packageName) && selectedDevice.assignments.includes(job.packageName)} onQueue={queue} onApprove={approvePublisher} />)}</div>}</> : null}
      </Section>
    </div>
  </div>

  return <div className="layout">
    <aside className="intro"><p className="kicker">Apps</p><h1>Choose what reaches your phone.</h1><p className="lede">Find an app, add it to your collection, then choose which phone receives it.</p><dl className="stats"><div><dt>Your apps</dt><dd>{data.allowlist.length} chosen</dd></div><div><dt>Phones</dt><dd>{readyPhones.length} paired</dd></div></dl><nav className="section-index" aria-label="App sections"><a href="#/apps/find">Find</a><a href="#/apps/your-apps">Your apps</a><a href="#/home/activity">Phone activity <span aria-hidden="true">↗</span></a></nav></aside>
    <div className="workspace">{messages}
      <Section id="find" label="Find" title="Find the app you need."><p className="section-copy">Search stays in the companion. There is no app store to browse on your phone.</p><form onSubmit={search} role="search"><label className="field" htmlFor="catalog-search"><span className="label">Search apps</span><input id="catalog-search" type="search" placeholder="App or publisher name" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" minLength={2} maxLength={120} required /></label><div className="actions"><button className="action" disabled={Boolean(busy) || query.trim().length < 2}>{busy === 'search' ? 'Searching…' : 'Search'}</button></div></form></Section>
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
            {confirmRemoval ? <div className="confirm-panel" role="group" aria-label="Confirm app removal"><h3>Remove {selectedApps.length === 1 ? 'this app' : 'these apps'} from Borealis?</h3><p>This removes access for all connected phones and cancels outstanding requests. Installed apps stay on the phone.</p><div className="actions"><button className="action secondary" disabled={Boolean(busy)} onClick={() => setConfirmRemoval(false)}>Cancel</button><button className="action" disabled={Boolean(busy)} onClick={() => void removeSelected()}>{busy === 'remove' ? 'Removing…' : 'Remove from apps'}</button></div></div> : null}
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
function JobRow({ job, busy, canAct, onQueue, onApprove }: { job: JobSummary; busy: boolean; canAct: boolean; onQueue: (name: string) => Promise<void>; onApprove: (job: JobSummary, signer: string) => Promise<void> }) {
  const signer = job.observedSignerSha256[0]
  const retry = ['failed', 'cancelled', 'succeeded'].includes(job.status)
  return <article className="list-row"><div className="row-copy"><h3 className="row-title">{job.displayName}</h3><p className="row-meta">{humanStatus(job.status)}{job.installedVersionCode !== null ? ` · version ${job.installedVersionCode}` : ''}</p>{job.message ? <p className="row-meta">{job.message}</p> : null}
    {job.status === 'review_required' && signer && canAct ? <details className="details"><summary>Review publisher</summary><p className="row-meta">Compare this signing fingerprint with a trusted copy of the app before approving it. Approval allows Borealis to install this app with that signing identity.</p><code className="technical">{signer}</code><div className="actions"><button className="action" disabled={busy} onClick={() => void onApprove(job, signer)}>Approve publisher and continue</button></div></details> : null}
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
