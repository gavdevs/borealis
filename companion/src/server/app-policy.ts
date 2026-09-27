import type { PlayAppDetails } from './play-search.js'

// Borealis offers practical tools, not a general-purpose store. Unknown and
// entertainment-led categories stay unavailable without a human approval queue.
const TOOL_CATEGORIES = new Set([
  'FINANCE', 'MEDICAL', 'HEALTH_AND_FITNESS', 'PARENTING', 'MAPS_AND_NAVIGATION',
  'TRAVEL_AND_LOCAL', 'HOUSE_AND_HOME', 'AUTO_AND_VEHICLES', 'FOOD_AND_DRINK',
  'WEATHER', 'TOOLS', 'BUSINESS', 'PRODUCTIVITY', 'LIFESTYLE',
])

const EXCLUDED_PACKAGES = new Set([
  'com.google.android.gm', 'com.microsoft.office.outlook', 'com.yahoo.mobile.client.android.mail',
  'ch.protonmail.android', 'com.fsck.k9', 'net.thunderbird.android', 'com.samsung.android.email.provider',
  'com.android.chrome', 'com.chrome.beta', 'com.chrome.dev', 'com.chrome.canary',
  'org.mozilla.firefox', 'org.mozilla.firefox_beta', 'org.mozilla.fenix', 'org.mozilla.focus',
  'com.brave.browser', 'com.opera.browser', 'com.opera.mini.native', 'com.microsoft.emmx',
  'com.sec.android.app.sbrowser', 'com.duckduckgo.mobile.android', 'com.vivaldi.browser',
  'com.google.android.googlequicksearchbox', 'com.microsoft.bing',
])

export function appIdentityPolicyReason(app: Pick<PlayAppDetails, 'packageName' | 'displayName'>): string | null {
  // Classify titles, not descriptions: a banking app mentioning emailed receipts
  // or browser help must not become an email/browser app by accident.
  if (EXCLUDED_PACKAGES.has(app.packageName.toLowerCase())
    || /\b(?:e-?mail|gmail|outlook|web\s*browser|browser|web\s*search|search\s*engine)\b/i.test(app.displayName)) {
    return 'Email, web browsers, and general web search are not available in Borealis.'
  }
  return null
}

export function appPolicyReason(app: PlayAppDetails): string | null {
  const identityReason = appIdentityPolicyReason(app)
  if (identityReason) return identityReason
  if (!TOOL_CATEGORIES.has(app.category)) {
    return 'Borealis supports practical tools. Social, entertainment, games, and other unsupported categories are not available.'
  }
  return null
}
