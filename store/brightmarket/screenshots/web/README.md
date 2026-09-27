# Companion web screenshots

Captured on 2026-09-27 from the actual built Borealis companion UI. These are browser captures, not LP3 screen captures or redesigned mockups. All account, phone, library, and search data is fictional demo data injected through intercepted API responses. The depicted app names and publishers do not assert real Google Play availability or device compatibility.

The images are stored in the top-level `docs/screenshots/` directory so BrightMarket can discover them, after the phone screenshots in filename order.

| File | Pixels | Suggested caption |
| --- | --- | --- |
| [04-web-library.png](../../../../docs/screenshots/04-web-library.png) | 1600 × 1100 | Companion website: a personal app library, shown with demo apps. |
| [05-web-search.png](../../../../docs/screenshots/05-web-search.png) | 1600 × 1010 | Companion website: search and add to your library, shown with demo results. |
| [06-web-library-mobile.png](../../../../docs/screenshots/06-web-library-mobile.png) | 780 × 1688 | Companion website in a mobile browser, dark theme; demo library. |
| [07-web-signup.png](../../../../docs/screenshots/07-web-signup.png) | 1600 × 1100 | Create a Borealis account with a username and password, without an email address. |

## Capture conditions

- Unmodified production frontend files from `companion/dist/client`; no CSS overrides, substituted component markup, compositing, or image editing.
- Desktop captures use 1600 CSS pixels at 1×. Mobile capture uses 390 × 844 CSS pixels at 2×, scrolled to the library section through the normal page layout.
- One headless Chromium process, sequential fresh contexts, fixed locale/timezone, reduced motion, and blocked service workers.
- Every API response is intercepted. Requests outside the local static origin and every non-GET request are blocked. No production service, Google Play, account credential, or real account data is used.
- Search and checkbox selection are real UI interactions against fixture data. The add action is not submitted. Signup fields are empty and signup is not submitted.
- Checked for JavaScript errors, unexpected requests, alerts, and horizontal overflow. All four images were visually inspected, including complete app-row framing.

The fixture app names are **Everyday Bank**, **City Transit**, and **Metro Tickets**, using `example.*` package names. The displayed phone is a fictional paired **Light Phone III**. These captures are presentation assets, not evidence of a real third-party installation.

## Reproduce

With Python Playwright and Chromium already available, run from the repository root against an existing frontend build:

```sh
python3 /home/gav/.agents/skills/webapp-testing/scripts/with_server.py \
  --server 'python3 -m http.server 8891 --bind 127.0.0.1 --directory companion/dist/client' \
  --port 8891 -- python3 companion/tests/store-screenshots.py
```

Alternatively, serve `companion/dist/client` on localhost and run `python3 companion/tests/store-screenshots.py --base-url http://127.0.0.1:8891`. The capture script rejects non-local URLs.

## Build and image fingerprints

Repository HEAD at capture: `8a03f2d1a6d4bf2aa4d149847f9b00714de4d903`. The exact frontend files used were:

```text
a862d844c0759980ad1f47cfc5fcfa3da448cce1f7ca303419b4e3fe3711c0d3  assets/index-CpeLbHLP.js
e81a566dcdd0a8e22bfd338bcd67b1c9613b6826367fac7d3aaab80eae38af52  assets/index-BA3bOHPF.css
```

Final screenshot SHA-256:

```text
9c92de66a93c70cc9110f62ae3b73fff1dc462eb92473f75983f084016b3e582  04-web-library.png
d61b8187bcb3c8bce9bc23dafa57797b59a9cebfaad132aa7cda958df3e6de65  05-web-search.png
a046f8667dfa8c04e9c0c879ebf78752ee0a237505dd26eb52794bce5fd8e04a  06-web-library-mobile.png
79b16fb669ebe99ba3f76f0ce0fb5e59a2b51b77b27eb55057a8af392eacc6ea  07-web-signup.png
```
