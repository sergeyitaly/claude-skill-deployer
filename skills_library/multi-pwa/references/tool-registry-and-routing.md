# The registry, routing, and long-press selection

Everything in a multi-tool app is derived from one array. This file has the
array, the router, the home grid and the long-press gesture, in the order they
depend on each other.

## The registry

Keep it in the *last* script part, after the UI kit and after the tool files
have pushed into it:

```js
/* each tool file does: TOOLS.push({ ... }) */
var TOOL_BY_ID = {};
TOOLS.forEach(function (tool) { TOOL_BY_ID[tool.id] = tool; });

function isKnownTool(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(TOOL_BY_ID, id);
}
```

`isKnownTool` is the only gate between a string and the app. Everything that
can carry a tool id from outside - the hash, `localStorage`, a shortcut URL -
goes through it. That is not ceremony: the stored value is the one input an
attacker with the device, or a buggy earlier version of the page, controls.

## Routing

Hash routing, because a static host cannot rewrite paths and the file must also
work over `file://`:

```js
function routeFromHash() {
  if (typeof location === 'undefined' || typeof location.hash !== 'string') return undefined;
  var id = location.hash.replace(/^#\/?/, '');
  if (isKnownTool(id)) return openTool(id);
  return goHome();
}

function openTool(id) {
  var tool = TOOL_BY_ID[id];
  panel.replaceChildren();
  tool.render(panel);            // the tool builds its own UI, once
  setHomeScreenIdentity(id);     // icon + name for Add to Home Screen
  savePrefs({ tool: id });
  show(toolSection); hide(homeSection);
}
```

Two things worth doing at the same time as the route change, both in
`references/home-screen-identity.md`: swap the touch icon and title, and set
`document.title`.

Render on open rather than up front. Twelve panels built at boot is twelve
times the work before the first paint, and most sessions touch one tool.

## The home grid

Three columns, four rows: twelve tools are one screenful on a phone, which is
the whole point of a launcher. Tiles carry an icon, a name and - only where
there is room for it - a one-line description.

```js
function renderHome(query) {
  grid.replaceChildren();
  var q = (query || '').trim().toLowerCase();
  TOOLS.filter(function (tool) {
    return !q || (tool.name + ' ' + tool.keywords).toLowerCase().indexOf(q) >= 0;
  }).forEach(function (tool) {
    var tile = el('button', 'tile');
    add(tile, el('span', 'pickdot'));                       // selection dot
    add(tile, img('./icons/tools/' + tool.id + '.png', 'tileicon'));
    add(tile, el('b', '', tool.name));
    add(tile, el('span', 'tileblurb', tool.blurb));         // own class, see below
    on(tile, 'click', function () { if (!swallowClick()) go(tool.id); });
    longPress(tile, function () { enterSelectMode(tool.id); });
    add(grid, tile);
  });
}
```

`.tileblurb` has its own class for a reason. A rule written as `.tile span
{ display: block }` in a wide-screen media query also matches the selection
dot, and the dots appear on desktop when nothing is selected. It is invisible
in a Node test and obvious in a screenshot. Guard it:

```js
t.ok('no bare .tile span rule', !/\.tile\s+span\s*\{/.test(html));
```

## Long-press to select

```js
var selectMode = false;
var suppressClickUntil = 0;
var LONG_PRESS_MS = 500;
var CLICK_SUPPRESS_MS = 700;

function swallowClick() {
  return Date.now() < suppressClickUntil;
}

function longPress(node, handler) {
  var timer = null, startX = 0, startY = 0;

  function point(event) {
    if (!event) return { x: 0, y: 0 };
    if (event.touches && event.touches.length) {
      return { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
    return { x: event.clientX || 0, y: event.clientY || 0 };
  }

  function stop() { if (timer) { clearTimeout(timer); timer = null; } }

  function start(event) {
    var at = point(event);
    startX = at.x; startY = at.y;
    stop();
    timer = setTimeout(function () {
      timer = null;
      suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
      handler();
    }, LONG_PRESS_MS);
  }

  function move(event) {
    var at = point(event);
    if (Math.abs(at.x - startX) > 10 || Math.abs(at.y - startY) > 10) stop();
  }

  if (typeof window !== 'undefined' && typeof window.PointerEvent !== 'undefined') {
    on(node, 'pointerdown', start); on(node, 'pointermove', move);
    on(node, 'pointerup', stop); on(node, 'pointercancel', stop);
    on(node, 'pointerleave', stop);
  } else {
    on(node, 'touchstart', start); on(node, 'touchmove', move);
    on(node, 'touchend', stop); on(node, 'touchcancel', stop);
    on(node, 'mousedown', start); on(node, 'mousemove', move);
    on(node, 'mouseup', stop); on(node, 'mouseleave', stop);
  }

  /* a desktop right-click, and what iOS raises on a long hold */
  on(node, 'contextmenu', function (event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    stop();
    suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
    handler();
  });
}
```

Why each piece:

- **Pointer events where they exist**, touch + mouse where they do not. Binding
  both sets on a pointer-capable browser fires `start` twice.
- **`suppressClickUntil`** is a timestamp, not a flag. A flag has to be cleared
  by an event that may never arrive - a press that ends outside the tile, a
  cancelled gesture - and then the next real tap is eaten.
- **`contextmenu`** covers both desktop right-click and the iOS hold, which
  raises it *instead of* completing a pointer sequence.
- **10px of movement cancels.** Without it, scrolling the grid selects tools.

Leaving select mode needs three exits: a Cancel button, the Escape key, and
opening a tool. Escape is the one people find by accident and expect to work.

## The selection bar

One row, at the bottom, over the grid. Put the count on the button rather than
on a line of its own - two rows of chrome on a phone is a tool's worth of
screen:

```
[ Add 3 to home screen ] [ Select all ] [ Cancel ]
```

and let the long half of the primary label drop below a breakpoint:

```html
<button class="btn primary">Add 3<span class="wideword"> to home screen</span></button>
```

```css
.wideword { display: none; }
@media (min-width: 400px) { .wideword { display: inline; } }
#selbar { display: flex; flex-wrap: nowrap; gap: 6px; }
#selbar .btn.primary { flex: 1 1 auto; }
```

`flex-wrap: nowrap` is the part that matters. Without it the row silently
becomes two rows on a narrow phone, which is exactly the screen where it hurts.

## What gets stored

One key, the project name plus a version, holding the last tool open:

```js
var PREF_KEY = 'my-toolkit.v1';

function loadPrefs() {
  try {
    var raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    return { tool: isKnownTool(raw.tool) ? raw.tool : '' };   // always this shape
  } catch (e) {
    return { tool: '' };
  }
}
```

Always return the same shape. A `loadPrefs` that sometimes returns `{}` pushes
an `undefined` check into every caller, and one caller always forgets.

Every project page under one `github.io` account shares an origin, so the key
must carry the project name - it is not your namespace alone.
