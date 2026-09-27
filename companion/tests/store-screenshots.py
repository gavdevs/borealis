"""Capture the built companion UI with fictional, fully intercepted demo APIs.

No sign-in is submitted and no request reaches a Borealis API or Google Play.
Run through with_server.py against a static server for companion/dist/client.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


API = '/api/borealis/v1'
STAMP = '2026-09-27T18:00:00.000Z'
ACCOUNT = {'id': 'demo-account', 'username': 'demo_library', 'role': 'member', 'createdAt': STAMP}


def app(package, name, publisher):
    return {'packageName': package, 'displayName': name, 'publisher': publisher,
            'reason': 'Screenshot demo only', 'signerSha256': None,
            'createdAt': STAMP, 'updatedAt': STAMP,
            'detailUrl': 'https://play.google.com/store/apps/details?id=' + package}


LIBRARY = [
    app('example.bank', 'Everyday Bank', 'Everyday Banking'),
    app('example.transit', 'City Transit', 'City Transport'),
]
SEARCH = [
    LIBRARY[1],
    app('example.metro', 'Metro Tickets', 'Metro Transport'),
]
PHONE = {'id': 'demo-phone', 'label': 'Light Phone III', 'revision': 1,
         'createdAt': STAMP, 'activatedAt': STAMP, 'lastSeenAt': STAMP,
         'revokedAt': None, 'assignments': []}


def capture(browser, base, output, name, *, mobile=False, theme='light', signed_in=True, search=False, signup=False):
    viewport = {'width': 390, 'height': 844} if mobile else {'width': 1600, 'height': 1100}
    if search:
        viewport['height'] = 1010
    context = browser.new_context(viewport=viewport, device_scale_factor=2 if mobile else 1,
                                  color_scheme=theme, reduced_motion='reduce', service_workers='block',
                                  locale='en-US', timezone_id='America/Denver')
    failures = []
    api_reads = []
    origin = urlparse(base)

    def intercept(route):
        request = route.request
        parsed = urlparse(request.url)
        if (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc) or request.method != 'GET':
            failures.append('Unexpected outbound request: ' + request.method + ' ' + parsed.path)
            route.abort()
            return
        if not parsed.path.startswith(API + '/'):
            route.continue_()
            return
        path = parsed.path.removeprefix(API)
        api_reads.append(path)
        if path == '/auth/session':
            result = {'account': ACCOUNT if signed_in else None}
        elif path == '/me/apps':
            result = {'items': LIBRARY}
        elif path == '/me/devices':
            result = {'devices': [PHONE]}
        elif path == '/me/devices/demo-phone/jobs':
            result = {'jobs': []}
        elif path == '/catalog/search':
            result = {'results': SEARCH}
        else:
            failures.append('Unexpected fixture API: ' + path)
            route.abort()
            return
        route.fulfill(status=200, content_type='application/json', body=json.dumps(result))

    context.route('**/*', intercept)
    page = context.new_page()
    page.on('pageerror', lambda error: failures.append(str(error)))
    try:
        page.goto(base + ('/#/apps' if signed_in else '/'))
        page.wait_for_load_state('networkidle')
        # Inspect the real rendered UI before manipulating it or capturing it.
        expect(page.get_by_role('link', name='Borealis companion home')).to_be_visible()
        if signed_in:
            library = page.get_by_role('region', name='Only what you’ve chosen.', exact=True)
            expect(library.get_by_role('checkbox')).to_have_count(2)
            expect(page.get_by_role('heading', name='Find the app you need.')).to_be_visible()
        else:
            expect(page.get_by_role('heading', name='Sign in to your companion.')).to_be_visible()
        if search:
            page.get_by_role('searchbox', name='Search apps').fill('transit')
            page.get_by_role('button', name='Search', exact=True).click()
            results = page.get_by_role('region', name='transit', exact=True)
            expect(results.get_by_role('checkbox')).to_have_count(2)
            results.get_by_role('checkbox', name='Select Metro Tickets', exact=True).check()
            expect(results.get_by_role('button', name='Add to library', exact=True)).to_be_enabled()
        if signup:
            page.get_by_role('button', name='Create an account', exact=True).click()
            expect(page.get_by_role('heading', name='Create your account.')).to_be_visible()
        page.evaluate('document.activeElement?.blur()')
        if mobile:
            page.evaluate("document.getElementById('your-apps').scrollIntoView({block: 'start', behavior: 'instant'})")
        else:
            page.evaluate('window.scrollTo({top: 0, behavior: "instant"})')
        page.evaluate('document.fonts.ready')
        expect(page.get_by_role('alert')).to_have_count(0)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'
        assert not failures, failures
        path = output / name
        page.screenshot(path=str(path), full_page=False, animations='disabled')
        assert not failures, failures
        print(json.dumps({'file': str(path), 'width': viewport['width'] * (2 if mobile else 1),
                          'height': viewport['height'] * (2 if mobile else 1), 'theme': theme,
                          'fixture_api_reads': api_reads}))
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8891')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[2] / 'docs/screenshots')
    args = parser.parse_args()
    base = args.base_url.rstrip('/')
    parsed = urlparse(base)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost'):
        parser.error('Use a local static HTTP server; production URLs are not allowed.')
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--disable-dev-shm-usage', '--renderer-process-limit=1'])
        try:
            capture(browser, base, args.output, '04-web-library.png')
            capture(browser, base, args.output, '05-web-search.png', search=True)
            capture(browser, base, args.output, '06-web-library-mobile.png', mobile=True, theme='dark')
            capture(browser, base, args.output, '07-web-signup.png', signed_in=False, signup=True)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
