# Offline, and installing to a home screen

Everything here is copy-paste ready. Paths are relative (`./`) throughout,
because a GitHub project page is served from `https://user.github.io/repo/`,
and an absolute `/` would point at the user's root site instead.

## Head tags

```html
<meta charset="utf-8">
<title>Name</title>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="description" content="One sentence.">
<meta name="theme-color" content="#0b0b0c">
<meta name="color-scheme" content="dark">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./icons/icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="./icons/icon-180.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="Name">
```

`viewport-fit=cover` is what makes `env(safe-area-inset-*)` non-zero on a
notched phone; without it the page is letterboxed and the insets read 0.

`apple-touch-icon` must be a real 180x180 PNG file. iOS does not read the
manifest for the home-screen icon, so a manifest-only setup installs with a
screenshot of the page as its icon.

`apple-mobile-web-app-status-bar-style`: `black` keeps the status bar out of the
page, `black-translucent` puts the page under it. Pick `black` unless the design
wants to paint under the clock, because translucent changes what `innerHeight`
means and is the usual cause of a mysterious top gap.

## manifest.webmanifest

```json
{
  "name": "Name",
  "short_name": "Name",
  "description": "One sentence.",
  "id": "unique-app-id",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0c0e11",
  "theme_color": "#14171c",
  "icons": [
    { "src": "./icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "./icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "./icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`id` is what keeps the install identified across deploys; without it the
`start_url` is the identity and a path change installs a second copy. GitHub
Pages serves `.webmanifest` as `application/manifest+json` already - no config
needed.

Android's install prompt needs, at minimum: served over HTTPS, a manifest with
`name`, `icons` (192 and 512), `start_url` and `display: standalone`, plus a
registered service worker with a fetch handler. Miss one and
`beforeinstallprompt` never fires, with no error anywhere.

## sw.js

```js
/* Everything the app needs is precached on install, so once the page has been
   opened one time it starts with no network at all. Responses are served from
   the cache first and refreshed in the background, so a new deploy is picked up
   the next time the app is launched. */
const CACHE = 'appname-v1';
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
```

Register it from the page, and treat failure as normal - `file://` and private
modes refuse:

```js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(function () {
    navigator.serviceWorker.ready.then(function () { swReady = true; updateInstallButton(); });
  }).catch(function () { });
}
```

### What the user actually experiences on a deploy

Cache-first means launch N shows the old page and fetches the new one; launch
N+1 shows the new one. This reads as "my fix did not deploy" unless you say
"open it once, then reopen it". Bump `CACHE` on each release so the new worker
precaches the new files rather than inheriting stale entries.

If instant updates matter more than instant starts, swap to network-first with a
cache fallback - but on a phone with a weak signal that trades a 40 ms start for
a two-second one, which is usually the wrong trade for a small tool.

## The install button

Three different worlds, so detect and say the right thing. Never show "Install"
on iOS, where no API can trigger it.

```js
function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone === true;        /* iOS uses its own flag */
}
function isIOS() {
  var ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);  /* iPad pretends to be a Mac */
}

var deferredPrompt = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();                     /* keep it, fire it from your own button */
  deferredPrompt = e;
  updateInstallButton();
});
window.addEventListener('appinstalled', function () { deferredPrompt = null; updateInstallButton(); });

function onInstallClick() {
  if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; return; }
  openSheet(installSheetHtml());          /* the platform's manual steps */
}
```

The iOS sheet spells out: open in **Safari** (not Chrome), tap **Share**, scroll
to **Add to Home Screen**, tap **Add**. Draw the share glyph inline as SVG
rather than describing it - people look for the shape.

Tell the user whether the offline copy is ready (`swReady`), because "add to
home screen" before the worker has finished is the one way to install something
that then fails on a plane.

## Anything hidden by the installed app needs a second route

The footer, the address bar and any browser menu disappear in standalone mode.
Whatever lived there - help, settings, an about box - needs a key, a gesture or
a long-press inside the app itself, or it becomes unreachable exactly for the
people who liked the app enough to install it.
