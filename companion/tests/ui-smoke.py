"""One-browser companion smoke check. Uses fixture APIs for all write actions.

Run against an already-running companion with Python Playwright installed:
    python3 tests/ui-smoke.py
Optional BOREALIS_ADMIN_TOKEN enables a read-only login check against the real API.
"""
import json
import os
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
    context = browser.new_context(viewport={'width': 1360, 'height': 900}, color_scheme='light', reduced_motion='reduce')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(BASE)
        page.wait_for_load_state('networkidle')
        expect(page.get_by_role('heading', name='Log in to your companion.')).to_be_visible()
        check_brand(page, 'rgb(0, 0, 0)')
        expect(page.locator('link[rel="icon"]')).to_have_attribute('href', '/assets/borealis.svg')
        favicon = context.request.get(BASE + '/assets/borealis.svg')
        assert favicon.ok and 'image/svg+xml' in favicon.headers['content-type']
        capture(page, '/tmp/borealis-login.png')
        if os.environ.get('BOREALIS_ADMIN_TOKEN'):
            page.get_by_label('Admin token', exact=True).fill(os.environ['BOREALIS_ADMIN_TOKEN'])
            page.get_by_role('button', name='Log in', exact=True).click()
            expect(page.get_by_role('heading', name='Your connected phones')).to_be_visible()
            expect(page.get_by_text('Loading your companion…')).to_have_count(0)
            capture(page, '/tmp/borealis-home.png')
            page.get_by_role('navigation', name='Companion navigation').get_by_role('link', name='Apps', exact=True).click()
            expect(page.get_by_role('heading', name='Find the app you need.')).to_be_visible()
            no_overflow(page)
        assert not errors, errors
        print('PASS: real page, assets, login and read-only navigation')
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

    def mock(route):
        request = route.request
        path = urlparse(request.url).path.removeprefix(API)
        method = request.method
        body = request.post_data_json if request.post_data else None
        if method != 'GET':
            writes.append((method, path, body))
        status = 200
        if path == '/admin/allowlist' and method == 'GET':
            result = {'items': apps}
        elif path == '/admin/allowlist' and method == 'POST':
            item = {**body, 'createdAt': STAMP, 'updatedAt': STAMP}
            apps.append(item)
            result, status = {'item': item}, 201
        elif path.startswith('/admin/allowlist/') and method == 'DELETE':
            apps[:] = [item for item in apps if item['packageName'] != path.split('/')[-1]]
            result = {'ok': True}
        elif path.startswith('/admin/allowlist/') and method == 'PUT':
            item = next(item for item in apps if item['packageName'] == path.split('/')[-1])
            item.update(body)
            result = {'item': item}
        elif path == '/admin/devices' and method == 'GET':
            result = {'devices': phones}
        elif path == '/admin/pairings' and method == 'GET':
            result = {'pairings': [pending]}
        elif path == '/admin/pairings/approve' and method == 'POST':
            assert body['userCode'] == pending['userCode']
            pending['state'] = 'approved'
            phone = {**phones[0], 'id': 'phone-second', 'label': pending['deviceLabel'], 'activatedAt': None, 'assignments': []}
            phones.append(phone)
            result = {'device': phone}
        elif path.endswith('/assignments') and method == 'POST':
            phones[0]['assignments'].append(body['packageName'])
            app = next(item for item in apps if item['packageName'] == body['packageName'])
            jobs.append({'id': 'job-' + body['packageName'], 'deviceId': phones[0]['id'], 'packageName': body['packageName'],
                         'displayName': app['displayName'], 'action': 'install_or_update', 'status': 'queued',
                         'createdAt': STAMP, 'deliveredAt': None, 'completedAt': None, 'installedVersionCode': None,
                         'observedSignerSha256': [], 'message': None})
            result = {'created': True}
        elif path.endswith('/jobs') and method == 'GET':
            result = {'jobs': jobs}
        elif path.endswith('/jobs') and method == 'POST':
            result = {'job': jobs[0]}
        elif path.startswith('/admin/devices/') and method == 'DELETE':
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

    context = browser.new_context(viewport={'width': 1360, 'height': 900}, color_scheme='light', reduced_motion='reduce')
    context.route('**/api/borealis/v1/**', mock)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(BASE)
        page.wait_for_load_state('networkidle')
        page.get_by_label('Admin token', exact=True).fill('isolated-ui-fixture-token')
        page.get_by_role('button', name='Log in', exact=True).click()
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
        results.get_by_role('button', name='Add to your apps').click()
        library = page.get_by_role('region', name='Only what you’ve chosen.')
        expect(library.get_by_role('checkbox')).to_have_count(2)
        expect(results.get_by_role('button', name='Add to your apps')).to_have_count(0)
        library.get_by_role('button', name='Select all', exact=True).click()
        expect(library.get_by_text('2 selected')).to_be_visible()
        capture(page, '/tmp/borealis-apps-light.png')
        no_overflow(page)
        library.get_by_role('button', name='Send to phone', exact=True).click()
        expect(page.get_by_role('status').filter(has_text='available to Test Light Phone')).to_be_visible()
        assert len(phones[0]['assignments']) == 2
        print('PASS: search, bulk selection, add apps, send to selected phone')

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
        library.get_by_role('button', name='Remove', exact=True).click()
        before = len(writes)
        library.get_by_role('button', name='Cancel', exact=True).click()
        assert len(writes) == before
        library.get_by_role('button', name='Remove', exact=True).click()
        library.get_by_role('button', name='Remove from apps', exact=True).click()
        expect(library.get_by_role('checkbox')).to_have_count(1)
        print('PASS: explicit removal confirmation and cancellation')

        # Publisher review is intentionally disclosed before trust is changed.
        jobs[0]['status'] = 'review_required'
        jobs[0]['observedSignerSha256'] = ['a' * 64]
        nav.get_by_role('link', name='Home', exact=True).click()
        page.get_by_role('button', name='Refresh', exact=True).click()
        page.get_by_text('Review publisher', exact=True).click()
        page.get_by_role('button', name='Approve publisher and continue').click()
        expect(page.get_by_role('status').filter(has_text='publisher approved')).to_be_visible()
        assert apps[0]['signerSha256'] == 'a' * 64

        # Code -> preview -> approval; no approval request on preview alone.
        page.get_by_role('link', name='Pair a phone', exact=True).click()
        page.get_by_label('Pairing code', exact=True).fill('ABCD-EFGH-JKMN')
        before = len(writes)
        page.get_by_role('button', name='Continue', exact=True).click()
        expect(page.get_by_role('heading', name='Is this your phone?')).to_be_visible()
        expect(page.get_by_text('Second test phone', exact=True)).to_be_visible()
        assert len(writes) == before
        capture(page, '/tmp/borealis-pair.png')
        page.get_by_role('button', name='Approve phone', exact=True).click()
        expect(page.get_by_role('status').filter(has_text='Confirm pairing on your phone')).to_be_visible()
        expect(page.get_by_role('heading', name='Second test phone', exact=True)).to_be_visible()
        print('PASS: publisher approval and two-step phone pairing')

        nav.get_by_role('link', name='Apps', exact=True).click()
        search.get_by_role('searchbox', name='Search apps').fill('nothing')
        search.get_by_role('button', name='Search', exact=True).click()
        expect(page.get_by_text('No apps found. Try another name or publisher.')).to_be_visible()
        search.get_by_role('searchbox', name='Search apps').fill('failure')
        search.get_by_role('button', name='Search', exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('Search unavailable')
        nav.get_by_role('button', name='Log out', exact=True).click()
        expect(page.get_by_role('heading', name='Log in to your companion.')).to_be_visible()
        assert not errors, errors
        assert not unexpected, unexpected
        print('PASS: empty/error search states, logout, no JavaScript errors')
    finally:
        context.close()


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--disable-dev-shm-usage', '--renderer-process-limit=1'])
        try:
            smoke(browser)
        finally:
            browser.close()
