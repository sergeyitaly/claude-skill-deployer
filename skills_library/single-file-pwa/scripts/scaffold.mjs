/* Writes a working skeleton for a single-file offline app: a page that already
   installs, caches itself, fills the screen and passes its own checks. Replace
   the body of the page with the real thing; leave the plumbing alone.

     node scaffold.mjs <target-dir> [App Name]

   Refuses to overwrite files that already exist. After it runs:
     cd <target-dir> && npm test && node tools/csp.mjs --check
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const dir = process.argv[2];
const NAME = process.argv[3] || 'App';
if (!dir) {
  console.error('usage: node scaffold.mjs <target-dir> [App Name]');
  process.exit(1);
}
const SLUG = NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
const here = path.dirname(fileURLToPath(import.meta.url));

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${NAME}</title>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="description" content="${NAME}. Works offline.">
<meta name="theme-color" content="#14171c">
<meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./icons/icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="./icons/icon-180.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="${NAME}">
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;overflow:hidden;background:#0c0e11;color:#e9edf2;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
#safeprobe{position:fixed;visibility:hidden;pointer-events:none;z-index:-1;
  top:env(safe-area-inset-top);bottom:env(safe-area-inset-bottom);
  left:env(safe-area-inset-left);right:env(safe-area-inset-right)}
#app{width:100%;max-width:520px;flex:1;display:flex;flex-direction:column;
  justify-content:center;gap:18px;padding:20px}
h1{font-size:22px;margin:0}
p{margin:0;line-height:1.5;color:#aeb6c2}
.btn{border:0;border-radius:12px;padding:14px 18px;font-size:16px;font-weight:600;
  background:#1f6feb;color:#fff;cursor:pointer;width:100%}
.btn.ghost{background:#1b1f26;color:#cfd6e0}
.foot{width:100%;max-width:520px;padding:0 20px 20px;display:flex;gap:10px}
body.standalone .foot{display:none}
</style>
</head>
<body>
<div id="app">
  <h1>${NAME}</h1>
  <p id="msg">Replace this with the app. Everything around it - installing,
  working offline, filling the screen on a phone - is already wired up.</p>
  <button class="btn ghost" id="tapBtn" type="button">Tap me</button>
</div>
<div class="foot">
  <button class="btn" id="installBtn" type="button">Add to home screen</button>
</div>
<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var swReady = false, deferredPrompt = null, taps = 0;

  /* ---- the app ---- */
  function onTap() {
    taps++;
    $('msg').textContent = 'Tapped ' + taps + (taps === 1 ? ' time.' : ' times.');
  }

  /* ---- installing ---- */
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      navigator.standalone === true;
  }
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function updateInstallButton() {
    var b = $('installBtn');
    if (!b) return;
    if (isStandalone()) b.textContent = swReady ? 'Installed - works offline' : 'Installed';
    else if (deferredPrompt) b.textContent = 'Install on phone';
    else b.textContent = 'Add to home screen';
  }
  function onInstallClick() {
    if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; return; }
    if (isIOS()) {
      $('msg').textContent = 'In Safari: tap Share, scroll down, tap Add to Home Screen.';
    } else {
      $('msg').textContent = 'Use the browser menu: Install app, or Add to Home screen.';
    }
  }

  /* ---- filling the screen once installed ---- */
  function usableBox() {
    var w = window.innerWidth, h = window.innerHeight;
    var p = $('safeprobe');
    if (!p && document.body && document.body.appendChild) {
      p = document.createElement('div'); p.id = 'safeprobe'; document.body.appendChild(p);
    }
    if (p && p.getBoundingClientRect) {
      var r = p.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { w = r.width; h = r.height; }
    }
    return { w: w, h: h };
  }
  function fit() {
    document.body.classList.toggle('standalone', isStandalone());
    var box = usableBox();
    var app = $('app');
    if (app) app.style.minHeight = box.h + 'px';
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js').then(function () {
      navigator.serviceWorker.ready.then(function () { swReady = true; updateInstallButton(); });
    }).catch(function () { });
  }

  function boot() {
    $('tapBtn').addEventListener('click', onTap);
    $('installBtn').addEventListener('click', onInstallClick);
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault(); deferredPrompt = e; updateInstallButton();
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null; updateInstallButton();
    });
    fit();
    updateInstallButton();
    registerSW();
  }

  /* exported for the offline test harness */
  window.APP = { onTap: onTap, isStandalone: isStandalone, fit: fit,
    taps: function () { return taps; } };

  if (typeof document !== 'undefined' && document.getElementById &&
      document.getElementById('app')) boot();
})();
</script>
</body>
</html>
`;

const SW = `/* Everything the app needs is precached on install, so once the page has been
   opened one time it starts with no network at all. Responses are served from
   the cache first and refreshed in the background, so a new deploy is picked up
   the next time the app is launched. Bump CACHE on every release. */
const CACHE = '${SLUG}-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then(hit => {
      const fresh = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => hit || caches.match('./index.html'));
      return hit || fresh;
    })
  );
});
`;

const MANIFEST = JSON.stringify({
  name: NAME,
  short_name: NAME,
  description: NAME + '. Works offline.',
  id: SLUG,
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0c0e11',
  theme_color: '#14171c',
  icons: [
    { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}, null, 2) + '\n';

/* Full bleed, artwork inside the middle 80%: Android crops a maskable icon to
   a circle or a squircle, and iOS applies its own rounded mask. Rounding the
   corners here would show through as transparent notches. */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#14171c"/>
  <rect x="120" y="120" width="272" height="272" rx="40" fill="#1f6feb"/>
  <text x="256" y="300" font-family="Arial, sans-serif" font-size="150" font-weight="700"
        fill="#ffffff" text-anchor="middle">${NAME.slice(0, 2).toUpperCase()}</text>
</svg>
`;

const SECTEST = `/* Guards the promises the README makes. Regexes over the shipped file are
   crude on purpose: they catch a careless edit, which is the actual risk. */
const fs = require('fs');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); return; }
  fail++; console.log('FAIL  ' + name + (extra ? ' - ' + extra : ''));
}

const html = fs.readFileSync('index.html', 'utf8');
const scriptOpen = html.indexOf('<script>');
const scriptClose = html.lastIndexOf('</script>');
const markup = html.slice(0, scriptOpen) + html.slice(scriptClose + '</script>'.length);

ok('no eval or new Function', !/\\beval\\s*\\(|new\\s+Function\\s*\\(/.test(html));
ok('no document.write', !/document\\.write/.test(html));
ok('no inline on* handlers in the markup', !/<[^>]+\\son[a-z]+\\s*=/i.test(markup));
ok('no javascript: urls', !/javascript:/i.test(html));
ok('no external script tags', !/<script[^>]+src=/i.test(html));
ok('no external stylesheets', !/<link[^>]+rel=["']?stylesheet/i.test(html));
ok('no third-party origins',
  (html.match(/https?:\\/\\/[^\\s"')]+/g) || []).every(u => u === 'http://www.w3.org/2000/svg'));
ok('no cookies or storage', !/document\\.cookie|localStorage|sessionStorage|indexedDB/.test(html));

const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
ok('a Content-Security-Policy is present', !!csp);
if (csp) {
  ok('the inline script is pinned by hash', /script-src 'sha256-/.test(csp[1]));
  ok('no unsafe-inline or unsafe-eval', !/unsafe-(inline|eval)/.test(csp[1]));
  ok('framing is refused', /frame-ancestors 'none'/.test(csp[1]));
}

const sw = fs.readFileSync('sw.js', 'utf8');
ok('the worker ignores non-GET', /req\\.method !== 'GET'/.test(sw));
ok('the worker ignores other origins', /origin !== self\\.location\\.origin/.test(sw));

ok('the manifest is valid JSON', (() => {
  try { JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8')); return true; }
  catch (e) { return false; }
})());

/* every file the page and the worker name must exist */
const refs = new Set();
(html.match(/(?:href|src)="\\.\\/([^"]+)"/g) || []).forEach(m => refs.add(m.split('"')[1].slice(2)));
(sw.match(/'\\.\\/([^']+)'/g) || []).forEach(m => refs.add(m.slice(3, -1)));
refs.forEach(f => ok('referenced file exists: ' + f, fs.existsSync(f)));

try {
  execFileSync(process.execPath, ['tools/csp.mjs', 'index.html', '--check'], { stdio: 'pipe' });
  ok('the CSP hashes match the page', true);
} catch (e) {
  ok('the CSP hashes match the page', false, 'run: node tools/csp.mjs index.html');
}

console.log('\\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
`;

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: node test/security.test.js
      - run: node tools/csp.mjs index.html --check
`;

const CODEQL = `name: CodeQL
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '0 6 * * 1'
jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
          queries: security-extended
      - uses: github/codeql-action/analyze@v3
`;

const PKG = JSON.stringify({
  name: SLUG,
  version: '1.0.0',
  private: true,
  description: NAME + '. A single-file offline web app.',
  scripts: {
    test: 'node test/security.test.js',
    csp: 'node tools/csp.mjs index.html',
    'csp:check': 'node tools/csp.mjs index.html --check',
    icons: 'node tools/svg-to-icons.mjs icon.svg icons'
  },
  license: 'MIT'
}, null, 2) + '\n';

const README = `# ${NAME}

One HTML file. Installs to a phone home screen, works with no network, hosted
free on GitHub Pages.

## Install it

Open the page on the phone, then **Add to home screen** (Android: the browser
menu or the in-page button; iPhone: Safari's **Share** menu).

## Develop

\`\`\`sh
npm test            # the checks that guard what the README promises
npm run csp         # after every edit to index.html
npm run icons       # rebuild the PNG icons from icon.svg
\`\`\`

Edit \`index.html\` and run \`npm run csp\`, or the page will refuse to run its
own script - the policy pins the inline script by hash.

## Publish

\`\`\`sh
gh api -X POST repos/OWNER/REPO/pages -f "source[branch]=main" -f "source[path]=/"
\`\`\`

A deploy reaches an installed app on the *second* launch: the service worker
serves the cached copy first and fetches the new one behind it.
`;

const files = {
  'index.html': PAGE,
  'sw.js': SW,
  'manifest.webmanifest': MANIFEST,
  'icon.svg': ICON_SVG,
  'test/security.test.js': SECTEST,
  '.github/workflows/ci.yml': CI,
  '.github/workflows/codeql.yml': CODEQL,
  '.gitattributes': '* text=auto eol=lf\n',
  '.gitignore': 'node_modules/\n.DS_Store\n',
  'package.json': PKG,
  'README.md': README
};

fs.mkdirSync(dir, { recursive: true });
const written = [], skipped = [];
for (const [rel, body] of Object.entries(files)) {
  const p = path.join(dir, rel);
  if (fs.existsSync(p)) { skipped.push(rel); continue; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  written.push(rel);
}

/* the tools travel with the project, so it stays self-contained */
fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
for (const tool of ['csp.mjs', 'svg-to-icons.mjs']) {
  const dest = path.join(dir, 'tools', tool);
  if (fs.existsSync(dest)) { skipped.push('tools/' + tool); continue; }
  fs.copyFileSync(path.join(here, tool), dest);
  written.push('tools/' + tool);
}

/* icons and the real CSP hashes, so the skeleton passes its own tests */
let note = '';
try {
  execFileSync(process.execPath, [path.join(dir, 'tools', 'svg-to-icons.mjs'), 'icon.svg', 'icons'],
    { cwd: dir, stdio: 'pipe', timeout: 120000 });
} catch (e) {
  note = 'Icons were not generated (no browser found, or it did not respond).\n' +
         'Run: node tools/svg-to-icons.mjs icon.svg icons';
}
execFileSync(process.execPath, [path.join(dir, 'tools', 'csp.mjs'), 'index.html'],
  { cwd: dir, stdio: 'pipe' });

console.log('Wrote into ' + path.resolve(dir) + ':');
written.forEach(f => console.log('  ' + f));
if (skipped.length) {
  console.log('Left alone (already there):');
  skipped.forEach(f => console.log('  ' + f));
}
if (note) console.log('\n' + note);
console.log('\nNext:\n  cd ' + dir + ' && npm test');
