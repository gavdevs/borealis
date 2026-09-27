"""One-browser companion smoke check. Uses fixture APIs for all write actions.

Run against an already-running companion with Python Playwright installed:
    python3 tests/ui-smoke.py
Account creation and every write action are isolated fixtures; no real accounts.
"""
import json
import os
import re
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('BOREALIS_TEST_BASE_URL', 'http://127.0.0.1:8787')
API = '/api/borealis/v1'
STAMP = '2026-09-25T18:00:00.000Z'


def no_overflow(page):
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Horizontal overflow'


def check_brand(page, color):
    mark = page.get_by_role('link', name='Borealis companion home').locator('svg')
    expect(mark).to_be_visible()
    expect(mark).to_have_attribute('aria-hidden', 'true')
    expect(mark).to_have_attribute('focusable', 'false')
    expect(mark).to_have_css('stroke', color)


def capture(page, path):
    page.evaluate('window.scrollTo({top: 0, behavior: "instant"})')
    page.screenshot(path=path, full_page=True)


def smoke(browser):
    context = browser.new_context(viewport={'width': 1360, 'height': 900}, color_scheme='light', reduced_motion='reduce', service_workers='block')
    context.route('**/api/borealis/v1/**', lambda route: route.fulfill(status=200, content_type='application/json', body='{"account":null}'))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(BASE)
        page.wait_for_load_state('networkidle')
        expect(page.get_by_role('heading', name='Sign in to your companion.')).to_be_visible()
        check_brand(page, 'rgb(0, 0, 0)')
        expect(page.locator('link[rel="icon"]')).to_have_attribute('href', '/assets/borealis.svg')
        favicon = context.request.get(BASE + '/assets/borealis.svg')
        assert favicon.ok and 'image/svg+xml' in favicon.headers['content-type']
        capture(page, '/tmp/borealis-login.png')
        expect(page.get_by_label('Username', exact=True)).to_be_visible()
        expect(page.get_by_label('Password', exact=True)).to_be_visible()
        expect(page.locator('input[type="email"]')).to_have_count(0)
        no_overflow(page)
        assert not errors, errors
        print('PASS: real page, assets, username/password gate, no email field')
    finally:
        context.close()

    apps = []
    phones = [{'id': 'phone-test', 'label': 'Test Light Phone', 'revision': 1, 'createdAt': STAMP,
               'activatedAt': STAMP, 'lastSeenAt': STAMP, 'revokedAt': None, 'assignments': []}]
    jobs = []
    pending = {'id': 'pair-test', 'userCode': 'ABCD-EFGH-JKMN', 'deviceLabel': 'Second test phone',
               'state': 'pending', 'expiresAt': '2099-01-01T00:00:00Z', 'createdAt': STAMP}
    catalog = [
        {'packageName': 'example.transit', 'displayName': 'City Transit', 'publisher': 'Transit Authority', 'detailUrl': 'https://play.google.com/store/apps/details?id=example.transit'},
        {'packageName': 'example.bank', 'displayName': 'Daily Banking', 'publisher': 'Example Bank', 'detailUrl': 'https://play.google.com/store/apps/details?id=example.bank'},
    ]
    writes = []
    unexpected = []
    account = {'id': 'account-member', 'username': 'library_fixture', 'role': 'member', 'createdAt': STAMP}
    auth = {'account': None}

    def mock(route):
        request = route.request
        path = urlparse(request.url).path.removeprefix(API)
        method = request.method
        body = request.post_data_json if request.post_data else None
        if method != 'GET':
            assert request.headers.get('x-borealis-request') == '1', 'Missing CSRF request header'
            writes.append((method, path, body))
        status = 200
        if path == '/auth/session' and method == 'GET':
            result = auth
        elif path == '/auth/signin' and method == 'POST':
            assert body == {'username': 'library_fixture', 'password': 'isolated fixture password'}
            auth['account'] = account
            result = {'account': account}
        elif path == '/auth/signout' and method == 'POST':
            auth['account'] = None
            result = {'ok': True}
        elif path == '/me/apps' and method == 'GET':
            result = {'items': apps}
        elif path == '/me/apps' and method == 'POST':
            assert list(body) == ['packageName'], 'Library selection sends only the package name'
            item = {**next(item for item in catalog if item['packageName'] == body['packageName']),
                    'reason': 'Personal library', 'signerSha256': None, 'createdAt': STAMP, 'updatedAt': STAMP}
            apps.append(item)
            for phone in phones:
                phone['assignments'].append(item['packageName'])
            result, status = {'item': item}, 201
        elif path.startswith('/me/apps/') and method == 'DELETE':
            apps[:] = [item for item in apps if item['packageName'] != path.split('/')[-1]]
            for phone in phones:
                phone['assignments'][:] = [name for name in phone['assignments'] if name != path.split('/')[-1]]
            result = {'ok': True}
        elif path == '/me/devices' and method == 'GET':
            result = {'devices': phones}
        elif path == '/me/pairings/preview' and method == 'POST':
            assert body['userCode'] == pending['userCode'].replace('-', '')
            result = {'pairing': pending}
        elif path == '/me/pairings/approve' and method == 'POST':
            assert body['userCode'] == pending['userCode']
            pending['state'] = 'approved'
            phone = {**phones[0], 'id': 'phone-second', 'label': pending['deviceLabel'], 'activatedAt': None,
                     'assignments': [item['packageName'] for item in apps]}
            phones.append(phone)
            result = {'device': phone}
        elif path.endswith('/jobs') and method == 'GET':
            result = {'jobs': jobs}
        elif path.startswith('/me/devices/') and method == 'DELETE':
            phone = next(phone for phone in phones if phone['id'] == path.split('/')[-1])
            phone['revokedAt'] = STAMP
            result = {'ok': True}
        elif path == '/catalog/search' and method == 'GET':
            term = parse_qs(urlparse(request.url).query).get('q', [''])[0]
            if term == 'failure':
                result, status = {'error': 'Search unavailable. Try again.'}, 503
            else:
                result = {'results': [] if term == 'nothing' else catalog}
        else:
            unexpected.append((method, path))
            result, status = {'error': 'Unexpected fixture request'}, 500
        route.fulfill(status=status, content_type='application/json', body=json.dumps(result))

    context = browser.new_context(viewport={'width': 1360, 'height': 900}, color_scheme='light', reduced_motion='reduce', service_workers='block')
    context.route('**/api/borealis/v1/**', mock)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(BASE)
        page.wait_for_load_state('networkidle')
        page.get_by_label('Username', exact=True).fill('library_fixture')
        page.get_by_label('Password', exact=True).fill('isolated fixture password')
        page.get_by_role('button', name='Sign in', exact=True).click()
        expect(page.get_by_role('heading', name='Test Light Phone', exact=True)).to_be_visible()
        nav = page.get_by_role('navigation', name='Companion navigation')
        nav.get_by_role('link', name='Apps', exact=True).click()
        search = page.get_by_role('search')
        search.get_by_role('searchbox', name='Search apps').fill('transit')
        search.get_by_role('button', name='Search', exact=True).click()
        results = page.get_by_role('region', name='transit', exact=True)
        expect(results.get_by_role('checkbox')).to_have_count(2)
        results.get_by_role('button', name='Select all', exact=True).click()
        expect(results.get_by_text('2 selected')).to_be_visible()
        results.get_by_role('button', name='Add to library', exact=True).click()
        library = page.get_by_role('region', name='Only what you’ve chosen.')
        expect(library.get_by_role('checkbox')).to_have_count(2)
        expect(results.get_by_role('button', name='Add to library', exact=True)).to_have_count(0)
        expect(page.get_by_role('status').filter(has_text='added to your library')).to_be_visible()
        expect(library.get_by_role('combobox')).to_have_count(0)
        expect(page.get_by_role('button', name='Send to phone', exact=True)).to_have_count(0)
        expect(page.get_by_text(re.compile('curator|publisher approval|shared catalog', re.I))).to_have_count(0)
        library.get_by_role('button', name='Select all', exact=True).click()
        expect(library.get_by_text('2 selected')).to_be_visible()
        capture(page, '/tmp/borealis-apps-light.png')
        no_overflow(page)
        assert len(phones[0]['assignments']) == 2
        assert [(method, path) for method, path, _ in writes] == [('POST', '/auth/signin'), ('POST', '/me/apps'), ('POST', '/me/apps')]
        print('PASS: member search, bulk add to library, no approval or manual phone assignment')

        # Skip-to-content preserves the active hash route.
        page.get_by_role('link', name='Skip to content').focus()
        page.keyboard.press('Enter')
        expect(page).to_have_url(BASE + '/#/apps')
        expect(page.get_by_role('main')).to_be_focused()

        # Both themes and a narrow viewport, including a selected-app action rail.
        nav.get_by_role('button', name='Switch light or dark theme').click()
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        check_brand(page, 'rgb(255, 255, 255)')
        library.get_by_role('checkbox', name='Select City Transit', exact=True).check()
        capture(page, '/tmp/borealis-apps-dark.png')
        page.set_viewport_size({'width': 390, 'height': 844})
        check_brand(page, 'rgb(255, 255, 255)')
        no_overflow(page)
        capture(page, '/tmp/borealis-apps-mobile.png')
        page.set_viewport_size({'width': 320, 'height': 740})
        check_brand(page, 'rgb(255, 255, 255)')
        no_overflow(page)
        page.set_viewport_size({'width': 1360, 'height': 900})
        nav.get_by_role('button', name='Switch light or dark theme').click()
        page.reload()
        expect(page.locator('html')).to_have_attribute('data-theme', 'light')
        expect(page.get_by_role('heading', name='Find the app you need.')).to_be_visible()
        print('PASS: route-safe skip link, persisted themes, 390px and 320px layouts')

        # Removal requires confirmation; cancelling never writes.
        library = page.get_by_role('region', name='Only what you’ve chosen.')
        library.get_by_role('checkbox', name='Select Daily Banking', exact=True).check()
        library.get_by_role('button', name='Remove from library', exact=True).click()
        before = len(writes)
        library.get_by_role('button', name='Cancel', exact=True).click()
        assert len(writes) == before
        library.get_by_role('button', name='Remove from library', exact=True).click()
        library.get_by_role('group', name='Confirm app removal').get_by_role('button', name='Remove from library', exact=True).click()
        expect(library.get_by_role('checkbox')).to_have_count(1)
        print('PASS: explicit removal confirmation and cancellation')

        # Only the latest attempt is prominent; obsolete requests stay closed in history.
        base_job = {'id': 'latest', 'deviceId': phones[0]['id'], 'packageName': 'example.transit',
                    'displayName': 'City Transit', 'action': 'install_or_update', 'status': 'succeeded',
                    'createdAt': '2026-09-27T12:00:00.000Z', 'deliveredAt': STAMP, 'completedAt': STAMP,
                    'installedVersionCode': 42, 'observedSignerSha256': [], 'message': None}
        jobs.extend([base_job,
                     {**base_job, 'id': 'old-review', 'createdAt': '2026-09-26T12:00:00.000Z', 'status': 'review_required',
                      'installedVersionCode': None, 'observedSignerSha256': ['a' * 64], 'message': 'Approve the observed publisher signer before installation.'},
                     {**base_job, 'id': 'old-failure', 'createdAt': STAMP, 'status': 'failed', 'installedVersionCode': None,
                      'message': 'Anonymous login failed (HTTP 403).'}])
        nav.get_by_role('link', name='Home', exact=True).click()
        page.get_by_role('button', name='Refresh', exact=True).click()
        activity = page.get_by_role('region', name='Latest installation attempts', exact=True)
        expect(activity.get_by_text('Installation completed · version 42')).to_be_visible()
        expect(activity.get_by_text('Anonymous login failed (HTTP 403).', exact=True)).to_be_hidden()
        expect(activity.get_by_role('button', name=re.compile('approve|try again|check for update', re.I))).to_have_count(0)
        activity.get_by_text('Earlier attempts', exact=True).click()
        expect(activity.get_by_text('Anonymous login failed (HTTP 403).', exact=True)).to_be_visible()
        expect(activity.get_by_text('Previous request ended', exact=True)).to_be_visible()
        expect(activity.get_by_text(re.compile('curator|approve.*publisher', re.I))).to_have_count(0)
        capture(page, '/tmp/borealis-history.png')
        print('PASS: newest request only, collapsed previous failures, obsolete review has no approval flow')

        # Code -> preview -> approval; no approval request on preview alone.
        page.get_by_role('link', name='Pair a phone', exact=True).click()
        page.get_by_label('Pairing code', exact=True).fill('ABCD-EFGH-JKMN')
        before = len(writes)
        page.get_by_role('button', name='Continue', exact=True).click()
        expect(page.get_by_role('heading', name='Is this your phone?')).to_be_visible()
        expect(page.get_by_text('Second test phone', exact=True)).to_be_visible()
        assert writes[before:] == [('POST', '/me/pairings/preview', {'userCode': 'ABCDEFGHJKMN'})]
        capture(page, '/tmp/borealis-pair.png')
        page.get_by_role('button', name='Approve phone', exact=True).click()
        expect(page.get_by_role('status').filter(has_text='Confirm pairing on your phone')).to_be_visible()
        expect(page.get_by_role('heading', name='Second test phone', exact=True)).to_be_visible()
        print('PASS: two-step phone pairing')

        nav.get_by_role('link', name='Apps', exact=True).click()
        search.get_by_role('searchbox', name='Search apps').fill('nothing')
        search.get_by_role('button', name='Search', exact=True).click()
        expect(page.get_by_text('No eligible apps found. Try another name or publisher.')).to_be_visible()
        search.get_by_role('searchbox', name='Search apps').fill('failure')
        search.get_by_role('button', name='Search', exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('Search unavailable')
        nav.get_by_role('link', name='Profile', exact=True).click()
        page.get_by_role('button', name='Sign out', exact=True).click()
        expect(page.get_by_role('heading', name='Sign in to your companion.')).to_be_visible()
        assert not errors, errors
        assert not unexpected, unexpected
        assert not any(path.startswith('/admin/') or path.endswith('/assignments') or path.endswith('/jobs') for _, path, _ in writes)
        print('PASS: empty/error search states, logout, no JavaScript errors')
    finally:
        context.close()


def account_smoke(browser):
    """Isolated account fixtures; credentials never reach the running service."""
    password = '  cedar paper lantern  '
    replacement = '  river stone orchard  '
    account = {'id': 'member-fixture', 'username': 'quiet_user', 'role': 'member', 'createdAt': STAMP}
    auth = {'account': None, 'password': password}
    calls = []
    unexpected = []
    apps = []
    bank = {'packageName': 'example.bank', 'displayName': 'Daily Banking', 'publisher': 'Example Bank',
            'reason': 'Personal library', 'signerSha256': None, 'createdAt': STAMP, 'updatedAt': STAMP}

    def mock(route):
        request = route.request
        path = urlparse(request.url).path.removeprefix(API)
        method = request.method
        body = request.post_data_json if request.post_data else None
        calls.append((method, path, body))
        if method != 'GET':
            assert request.headers.get('x-borealis-request') == '1'
            assert 'authorization' not in request.headers
        status = 200
        if path == '/auth/session' and method == 'GET':
            result = {'account': auth['account']}
        elif path == '/auth/signup' and method == 'POST':
            assert body == {'username': 'quiet_user', 'password': password}
            auth['account'] = account
            result, status = {'account': account}, 201
        elif path == '/auth/signin' and method == 'POST':
            if body['username'].lower() != account['username'] or body['password'] != auth['password']:
                result, status = {'error': 'Username or password is incorrect.'}, 401
            else:
                auth['account'] = account
                result = {'account': account}
        elif path == '/auth/signout' and method == 'POST':
            auth['account'] = None
            result = {'ok': True}
        elif path == '/auth/change-password' and method == 'POST':
            if body['currentPassword'] != auth['password']:
                result, status = {'error': 'Current password is incorrect.'}, 400
            else:
                assert body['newPassword'] == replacement
                auth['password'] = replacement
                result = {'account': account}
        elif path == '/me/apps' and method == 'GET':
            result = {'items': apps}
        elif path == '/me/apps' and method == 'POST':
            assert body == {'packageName': bank['packageName']}
            apps.append(bank)
            result, status = {'item': bank}, 201
        elif path == '/me/devices' and method == 'GET':
            result = {'devices': []}
        elif path == '/catalog/search' and method == 'GET':
            result = {'results': [{**bank, 'detailUrl': 'https://play.google.com/store/apps/details?id=example.bank'}]}
        else:
            unexpected.append((method, path))
            result, status = {'error': 'Unexpected fixture request'}, 500
        route.fulfill(status=status, content_type='application/json', body=json.dumps(result))

    context = browser.new_context(viewport={'width': 1360, 'height': 900}, color_scheme='light', reduced_motion='reduce', service_workers='block')
    context.route('**/api/borealis/v1/**', mock)
    context.add_init_script("sessionStorage.setItem('borealis.admin-token.v1', 'retired-fixture-token')")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(BASE)
        page.wait_for_load_state('networkidle')
        expect(page.get_by_role('heading', name='Sign in to your companion.')).to_be_visible()
        assert page.evaluate("sessionStorage.getItem('borealis.admin-token.v1')") is None
        page.get_by_label('Username', exact=True).fill('quiet_user')
        page.get_by_label('Password', exact=True).fill('invalid fixture password')
        page.get_by_role('button', name='Sign in', exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('Username or password is incorrect.')
        expect(page.get_by_text(re.compile('set up this server|curator|bootstrap', re.I))).to_have_count(0)
        page.get_by_role('button', name='Create an account', exact=True).click()
        expect(page.get_by_role('heading', name='Create your account.')).to_be_visible()
        expect(page.locator('input[type="email"]')).to_have_count(0)
        expect(page.get_by_label('Password', exact=True)).to_have_attribute('autocomplete', 'new-password')
        page.get_by_label('Username', exact=True).fill('quiet_user')
        page.get_by_label('Password', exact=True).fill(password)
        page.get_by_label('Confirm password', exact=True).fill('different fixture password')
        before = len(calls)
        page.get_by_role('button', name='Create account', exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('passwords don’t match')
        assert len(calls) == before, 'Mismatched confirmation must not create an account'
        page.get_by_label('Confirm password', exact=True).fill(password)
        page.set_viewport_size({'width': 320, 'height': 740})
        no_overflow(page)
        capture(page, '/tmp/borealis-signup-mobile.png')
        page.get_by_role('button', name='Create account', exact=True).click()
        expect(page.get_by_role('heading', name='Your connected phones')).to_be_visible()
        nav = page.get_by_role('navigation', name='Companion navigation')
        nav.get_by_role('link', name='Apps', exact=True).click()
        expect(page.get_by_text('Search Google Play for essential apps.', exact=False)).to_be_visible()
        page.get_by_role('searchbox', name='Search apps').fill('bank')
        page.get_by_role('button', name='Search', exact=True).click()
        page.get_by_role('checkbox', name='Select Daily Banking', exact=True).check()
        page.get_by_role('button', name='Add to library', exact=True).click()
        expect(page.get_by_role('status').filter(has_text='Daily Banking added')).to_be_visible()
        assert not any(path.startswith('/admin/') for _, path, _ in calls)
        nav.get_by_role('link', name='Profile', exact=True).click()
        expect(page.get_by_role('heading', name='quiet_user', exact=True)).to_be_visible()
        page.get_by_role('button', name='Change password', exact=True).click()
        page.get_by_label('Current password', exact=True).fill('incorrect fixture password')
        page.get_by_label('New password', exact=True).fill(replacement)
        page.get_by_label('Confirm new password', exact=True).fill(replacement)
        page.get_by_role('button', name='Save new password', exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('Current password is incorrect.')
        expect(page.get_by_role('heading', name='quiet_user', exact=True)).to_be_visible()
        page.get_by_label('Current password', exact=True).fill(password)
        no_overflow(page)
        page.set_viewport_size({'width': 1360, 'height': 900})
        capture(page, '/tmp/borealis-profile.png')
        page.get_by_role('button', name='Save new password', exact=True).click()
        expect(page.get_by_role('status')).to_contain_text('Password changed.')
        expect(page.get_by_label('Current password', exact=True)).to_have_count(0)
        page.get_by_role('button', name='Sign out', exact=True).click()
        expect(page.get_by_role('heading', name='Sign in to your companion.')).to_be_visible()
        page.get_by_label('Username', exact=True).fill('QUIET_USER')
        page.get_by_label('Password', exact=True).fill(replacement)
        page.get_by_role('button', name='Sign in', exact=True).click()
        expect(page.get_by_role('heading', name='Your connected phones')).to_be_visible()
        page.reload()
        expect(page.get_by_role('heading', name='Your connected phones')).to_be_visible()
        assert page.evaluate("Object.keys(localStorage).every(key => key === 'borealis.theme.v1')")
        assert page.evaluate('sessionStorage.length') == 0
        assert not errors, errors
        assert not unexpected, unexpected
        print('PASS: signup, confirmation, no email, personal library, Profile, password change, signout/signin, session restore, no browser-stored credentials')
    finally:
        context.close()


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--disable-dev-shm-usage', '--renderer-process-limit=1'])
        try:
            smoke(browser)
            account_smoke(browser)
        finally:
            browser.close()
