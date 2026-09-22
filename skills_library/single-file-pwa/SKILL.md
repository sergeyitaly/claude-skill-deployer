---
name: single-file-pwa
description: Build and ship a single-file offline web app - one index.html, no dependencies, no build step, no backend - that installs to a phone home screen from free GitHub Pages hosting and keeps working with no network. Use this whenever the user wants a small tool, calculator, converter, timer, tracker, checklist, reference card or game that should be free to host, installable on Android and iPhone without an app store or developer account, usable offline, or shipped as a single HTML file. Use it too when they ask how to add a web page to a phone home screen, make a PWA installable on both platforms, publish a static page on GitHub Pages, fill the screen on an installed iPhone web app, or prove that a static page has no security holes.
---

# Single-file offline web app

One `index.html` that carries its own markup, style and script; a service worker
so it runs with no network; a manifest so a phone will install it to the home
screen; and GitHub Pages to host it for nothing. No framework, no bundler, no
npm install, no store review, no developer account, no server to keep alive.

The whole point is that the result stays alive with no effort: a static file in
a git repo has no dependencies to rot, no certificates to renew and no bill to
forget.

## When this shape fits

Good: calculators, unit and currency converters, timers, trackers, checklists,
scoreboards, flashcards, reference tables, small games, a dashboard over data
small enough to embed in the file, anything a person wants on their phone and
would rather not install from a store.

Bad, and say so early rather than half-building it: anything that shares state
between people, needs authentication, holds a secret, talks to a paid API
(the key would be readable by everyone), or ships large media. A single public
file has no private side. If the user needs one, propose a backend instead of
hiding a key in the page.

## Layout

```
index.html              everything: markup, <style>, <script>
sw.js                   service worker - precache, cache-first, refresh behind
manifest.webmanifest    name, icons, standalone display
icons/                  icon-180.png (iOS), icon-192.png, icon-512.png
tools/csp.js            recomputes the CSP hashes after every edit to the page
test/                   plain Node tests, no dependencies
.github/workflows/      tests + CodeQL on every push
.gitattributes          * text=auto eol=lf
LICENSE  README.md  SECURITY.md
```

## Build order

Work in this order; each step depends on the one before it.

1. **Write the page first.** Plain HTML, one `<style>`, one `<script>`. No
   build step means what you edit is what ships, which is also what makes the
   tests and the CSP hashes simple. Open it with `file://` while building.
2. **Once it passes ~1500 lines, assemble it.** Keep parts in a scratch
   directory (`p1.html`, `p2.js`, ...) and `cat` them into `index.html`. Editing
   a 90 KB single file with string replacement gets error-prone; editing a part
   and reassembling does not. Never hand-edit the assembled file, or the parts
   silently go stale.
3. **Icons.** `scripts/svg-to-icons.mjs` rasterises one SVG into the three PNG
   sizes with a headless browser - no ImageMagick, no design tool.
4. **Head tags and manifest.** Exact set in `references/offline-and-install.md`.
   `start_url` and `scope` must be `"./"` for a project page under a subpath.
5. **Service worker.** Precache the handful of files, serve cache-first, refresh
   behind. Same reference.
6. **CSP.** Run `node tools/csp.js` after every edit to the page, and
   `--check` in CI. See `references/security-and-csp.md`.
7. **Tests.** A stub DOM plus `vm.runInContext` runs the page's own script in
   Node with no dependencies, so the real logic is testable in CI. See
   `references/testing-and-ci.md`.
8. **Publish.** `gh api -X POST repos/OWNER/REPO/pages -f "source[branch]=main"
   -f "source[path]=/"`, then verify the live URL, not just the workflow.

## Traps that cost real time

Each of these has already cost a day somewhere. The references hold the fix.

- **The installed app leaves a gap top and bottom.** Scaling to *fit* leaves
  slack on any phone taller than the design. Scale to width, stretch the body to
  the measured height, and measure the usable box from a hidden element inset by
  `env(safe-area-inset-*)` rather than computing it from `innerHeight` - whether
  the status bar is already excluded depends on the status-bar style, and
  computing it double-subtracts. `references/fullscreen-on-phones.md`.
- **CRLF invalidates the CSP hashes.** A Windows checkout rewrites line endings,
  the inline script no longer hashes to what the meta tag says, and the page
  refuses to run its own script - on that machine only. Commit
  `.gitattributes` with `* text=auto eol=lf` before anything else.
- **Users see the old version after a deploy.** Cache-first means the new page
  lands on the *second* launch. Tell them to open it twice, and bump the cache
  name on each release so the new worker precaches fresh.
- **iOS has no install prompt.** `beforeinstallprompt` is Chromium only. On iOS
  the only route is Safari's Share sheet, so the in-page button must detect the
  platform and show the steps instead of promising a prompt. Chrome on iOS
  cannot do it at all - say "open in Safari".
- **iOS has no vibration.** `navigator.vibrate` does not exist in Safari. Any
  haptic feedback silently does nothing there; sound still works, but only if
  the AudioContext is created inside a real user gesture.
- **All project pages on `USER.github.io` share one origin.** `localStorage`,
  IndexedDB and cookies are shared across every repo the user publishes. Prefix
  storage keys with the project name, and never assume a key is yours alone.
- **`window-size` is not the viewport.** Headless Chrome and Edge subtract
  browser chrome, so a screenshot is not the size you asked for. Measure the
  real viewport with `--dump-dom` before trusting a screenshot's geometry.
- **Anything read back from storage is untrusted input.** It is the one value an
  attacker with the device, or a buggy earlier version, can control. Validate it
  against a fixed list before it reaches the DOM.

## Scripts in this skill

Copy them into the project's `tools/` (they are dependency-free, Node 18+):

- `scripts/csp.mjs` - hashes every inline `<script>` and `<style>` and rewrites
  or checks the policy meta tag. `--check` for CI.
- `scripts/svg-to-icons.mjs` - one SVG to `icon-180/192/512.png` via headless
  Chrome or Edge.
- `scripts/scaffold.mjs` - writes a working skeleton (page, worker, manifest,
  workflow, .gitattributes) into an empty directory. Start here for a new
  project, then replace the page body.

## Before sharing it publicly

Run through this; a public link gets looked at by people who enjoy finding
holes.

- `node tools/csp.js --check` passes, and the page still runs from the live URL
  (a broken hash only shows up in a browser, never in the tests).
- No third-party origin anywhere in the file: no CDN, no font, no analytics.
- Install it on a real Android phone and a real iPhone. Emulators do not
  reproduce the safe-area behaviour.
- Aeroplane mode: launch from the home screen icon and use it.
- CodeQL and the test workflow are green on the commit that is live.
- `README` says what it does, how to install it, and what it stores.
- A licence file, and it is detected by GitHub (extra prose after the licence
  text stops the detector; put that in a `NOTICE` file instead).

## Talking about it honestly

Do not write "no vulnerabilities" in a README or a post. Nobody can promise
that, and it invites someone to prove otherwise. Claim what is checkable, in
the user's own words if they will post it:

> No backend, no accounts, no analytics, no cookies, no third-party code. The
> inline script is pinned by SHA-256 in a Content-Security-Policy, and every
> push runs the tests plus CodeQL analysis. The only thing stored on the device
> is <the one setting>.

Same for hosting: GitHub Pages is free and durable, not guaranteed forever. The
repo is the thing that lasts, which is a better line anyway.
