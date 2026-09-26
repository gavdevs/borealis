#!/usr/bin/env python3
"""Optional UI regression using an existing Python Playwright/Chromium install.

From the repository root:
    python3 companion/scripts/check-auth-form.py http://127.0.0.1:8787/

Optionally add --browser-executable /path/to/chromium. All /api requests are
intercepted; only the page and its static assets load from the supplied site.
No accounts are created, and no browser installation or build is performed.
"""

import argparse
from pathlib import Path
from urllib.parse import urlsplit


API = "/api/borealis/v1"
FIXTURE_ERROR = "Intercepted fixture submission; no account created."


def http_url(value):
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise argparse.ArgumentTypeError("Use an absolute HTTP or HTTPS URL.")
    if parsed.username is not None or parsed.password is not None:
        raise argparse.ArgumentTypeError("Do not include credentials in the URL.")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", type=http_url, help="Running Borealis companion URL")
    parser.add_argument(
        "--browser-executable",
        type=Path,
        help="Existing Chromium executable; defaults to Playwright's installed Chromium",
    )
    args = parser.parse_args()

    # Keep --help usable without the optional browser-testing dependency.
    try:
        from playwright.sync_api import expect, sync_playwright
    except ImportError as error:
        raise SystemExit("This optional check requires an existing Python Playwright installation.") from error

    captured = []
    unexpected_api = []

    def intercept(route):
        request = route.request
        path = urlsplit(request.url).path
        if path == "/api" or path.startswith("/api/"):
            if request.method == "GET" and path == f"{API}/auth/session":
                # Even an unclaimed server must not expose setup controls.
                route.fulfill(json={"account": None, "bootstrapAvailable": True})
            elif request.method == "POST" and path == f"{API}/auth/signup":
                captured.append(request.post_data_json)
                route.fulfill(status=400, json={"error": FIXTURE_ERROR})
            else:
                unexpected_api.append((request.method, path))
                route.fulfill(status=404, json={"error": "Unexpected fixture API request."})
        elif request.method in ("GET", "HEAD"):
            route.continue_()
        else:
            # Also fail closed if a future form posts outside the API prefix.
            route.abort()

    with sync_playwright() as playwright:
        launch_options = {"headless": True}
        if args.browser_executable is not None:
            launch_options["executable_path"] = str(args.browser_executable.expanduser())
        browser = playwright.chromium.launch(**launch_options)
        try:
            context = browser.new_context(
                viewport={"width": 390, "height": 844}, service_workers="block"
            )
            context.route("**/*", intercept)
            page = context.new_page()
            page.set_default_timeout(10_000)
            page.goto(args.base_url, wait_until="domcontentloaded")
            expect(page.get_by_role("heading", name="Sign in to your companion.")).to_be_visible(timeout=15_000)
            expect(page.get_by_text("Set up this server", exact=True)).to_have_count(0)

            page.get_by_role("button", name="Create an account", exact=True).click()
            expect(page.get_by_role("heading", name="Create your account.")).to_be_visible()
            expect(page.get_by_text("Set up this server", exact=True)).to_have_count(0)
            expect(page.get_by_label("Existing admin token", exact=True)).to_have_count(0)
            password = page.get_by_label("Password", exact=True)
            confirmation = page.get_by_label("Confirm password", exact=True)
            submit = page.get_by_role("button", name="Create account", exact=True)
            expect(password).to_have_attribute("minlength", "12")
            expect(confirmation).to_have_attribute("minlength", "12")
            page.get_by_label("Username", exact=True).fill("fixture_user")

            # Establish stale React state, then imitate password-manager autofill
            # without input/change events. These are throwaway fixture values.
            password.fill("short123")
            confirmation.fill("short123")
            visible_password = "abcdefghijklmnop"
            page.evaluate("""value => {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              for (const name of ['password', 'confirm-password']) {
                setter.call(document.querySelector(`[name="${name}"]`), value);
              }
            }""", visible_password)
            expect(password).to_have_value(visible_password)
            expect(confirmation).to_have_value(visible_password)
            with page.expect_response(f"**{API}/auth/signup"):
                # Avoid blur events that could independently synchronize state.
                page.locator("form").evaluate("form => form.requestSubmit()")
            expect(submit).to_be_enabled()
            expect(page.get_by_role("alert")).to_have_text(FIXTURE_ERROR)
            assert len(captured) == 1, "Expected one intercepted autofill submission."
            assert captured[-1]["password"] == visible_password, "Autofill submitted stale state instead of the visible 16 characters."

            for length in (12, 16):
                fixture_password = "a" * length
                password.fill(fixture_password)
                confirmation.fill(fixture_password)
                count_before = len(captured)
                with page.expect_response(f"**{API}/auth/signup"):
                    submit.click()
                expect(submit).to_be_enabled()
                expect(page.get_by_role("alert")).to_have_text(FIXTURE_ERROR)
                assert len(captured) == count_before + 1, "Expected exactly one intercepted signup submission."
                assert captured[-1]["password"] == fixture_password, f"The {length}-character fixture was not submitted unchanged."

            assert not unexpected_api, f"Unexpected intercepted API requests: {unexpected_api}"
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "The signup page overflows the mobile viewport horizontally."
            print("Passed: 12/16-character signup, silent autofill, no setup panel, and mobile overflow checks. No account writes.")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
