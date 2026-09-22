# One app, many home-screen icons

## Start with what is not possible

**A web page cannot create a folder on a phone home screen.** Not with a
manifest, not with a script, not on Android and not on iOS. Folders are made by
the person dragging one icon onto another, and only the OS may do it.

Say this the first time a folder is mentioned, in one sentence, and immediately
say what is possible instead. It is the single most common request for a
toolkit app, and the closest real capability is good enough - but only if it is
offered honestly rather than discovered later.

Put the same sentence in the install sheet, where the person is standing when
they expect the folder:

> A web page cannot make a folder - only your phone can, by dragging one icon
> onto another. Each tool below installs with its own icon and name, so the
> folder you make looks like a set of real apps.

## What does work

### 1. An icon and a name per tool (iOS, and the general case)

iOS reads these from the **live DOM at the moment** Share > Add to Home Screen
is tapped - not from the document as first served. Swap them when a tool opens
and each tool lands as its own app:

```html
<link rel="apple-touch-icon" id="touchicon" href="./icons/icon-180.png">
<meta name="apple-mobile-web-app-title" id="apptitle" content="My Toolkit">
```

```js
function setHomeScreenIdentity(id) {
  var link = document.getElementById('touchicon');
  var meta = document.getElementById('apptitle');
  var known = isKnownTool(id);
  if (link) link.setAttribute('href', known ? './icons/tools/' + id + '.png' : './icons/icon-180.png');
  if (meta) meta.setAttribute('content', known ? TOOL_BY_ID[id].name : 'My Toolkit');
  document.title = known ? TOOL_BY_ID[id].name + ' - My Toolkit' : 'My Toolkit';
}
```

Call it on every route change, including back to the home grid, or the last
tool opened keeps its identity and the next add gets the wrong icon.

Each added tool opens at `#/<id>`, so it launches straight into that tool. They
all share one origin, one service worker and one cache - twelve icons, one
download.

### 2. Manifest shortcuts (Android)

Long-pressing the installed icon opens a menu. Generate it from the registry so
it cannot fall behind:

```json
{
  "shortcuts": [
    {
      "name": "CIDR Calculator",
      "short_name": "CIDR",
      "description": "Network, broadcast, mask and host range",
      "url": "./#/cidr",
      "icons": [{ "src": "./icons/tools/cidr.png", "sizes": "192x192", "type": "image/png" }]
    }
  ]
}
```

Android shows a limited number - commonly four or five - and picks from the
front of the array, so order it by what people use most. Relative `url` values
matter: a project page lives under a subpath.

### 3. A guided add

Selection is useless without a route from "these six" to six icons. There is no
API for that, so walk them:

```
Add CIDR Calculator                     (1 of 6)
1. Tap Open below - the icon and name are already set to this tool.
2. Tap Share, then Add to Home Screen.
3. Come back here and tap Added.

[ Open CIDR Calculator ] [ Added - next ] [ Skip ]
```

Keep those three on one row, with the droppable halves of the labels in
`.wideword` spans. The platform text differs and matters:

- **iOS**: only Safari can add to the home screen. Chrome or Firefox on iOS
  cannot - detect and say "open this page in Safari" rather than showing steps
  that lead nowhere.
- **Android**: the browser menu's "Add to Home screen"; Chromium may also fire
  `beforeinstallprompt`, which installs the *whole app*, not one tool.
- **Desktop**: the install icon in the address bar.

### 4. The whole toolkit as one icon

Keep it, as the header's Install button. Most people want one icon first and
individual tools later. `beforeinstallprompt` is Chromium-only, so capture the
event and fall back to per-platform instructions when it never arrives.

## Icons, generated from the registry

Twelve hand-drawn icons is twelve chances to forget one. Generate them: an SVG
per tool from a table of `{ id, label, colour }`, rasterised by the headless
browser that is already on the machine. `scripts/tool-icons.mjs` does this and
writes the manifest shortcuts in the same run.

What the SVG needs:

- **Colour to the edges.** Android may crop a shortcut icon to a circle; a
  glyph inside the middle 60% survives that, a full-bleed background survives
  any mask.
- **A short glyph, not a picture.** `/22`, `B64`, `JWT`, `{ }` read at 48px on
  a home screen where a drawing does not.
- **`textLength` with `lengthAdjust="spacingAndGlyphs"`** so a one-character
  label and a three-character label end up optically the same size.
- **Distinct colours.** The colour is what the eye finds on a crowded home
  screen; the glyph only confirms it.

192px is the working size: it is the manifest shortcut size and scales down
cleanly for the 180px `apple-touch-icon`.

## Test what a test can reach

```js
/* every registered tool has an icon on disk */
TOOLS.forEach(tool => {
  t.ok('icon exists for ' + tool.id, fs.existsSync('icons/tools/' + tool.id + '.png'));
});
/* the manifest shortcuts and the registry agree */
t.ok('one shortcut per tool', manifest.shortcuts.length === TOOLS.length);
manifest.shortcuts.forEach(s => {
  t.ok('shortcut url is relative: ' + s.url, s.url.startsWith('./#/'));
});
```

Adding a tool then fails CI until its icon and shortcut exist, which is the
only reliable way to keep a set of twelve complete.
