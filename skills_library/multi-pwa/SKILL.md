---
name: multi-pwa
description: Build one offline web app that holds many tools at once - a toolkit, a launcher, a suite - rather than a single-purpose page. Covers the tool registry that drives everything, hash routing, a shared UI kit so twenty screens look like one app, an icon and a home-screen name per tool, long-press selection and a guided per-tool install, light and dark themes that cannot drift, assembling one index.html from parts, and testing every tool from the registry. Use when the user wants several calculators, converters or utilities in one installable app, a "pocket toolkit", an app whose home screen is a grid of tools, per-tool icons on a phone home screen, or a folder of tool icons - and read it before promising that folder, because no web page can create one.
---

# Many tools in one offline app

The single-tool shape is in `single-file-pwa`: one `index.html`, a service
worker, a manifest, GitHub Pages, no dependencies. Everything there still
applies. This skill is what changes when the page holds twelve tools instead
of one - which is most of the work, and almost none of it is the tools.

Read `single-file-pwa` first if the project does not exist yet. Come here the
moment the answer to "how many tools" is more than one.

## Decide this before writing any code

**One app, or one app per tool?** One app wins when the tools share a UI kit, a
mental model and an audience, and when the person wants one thing to install.
Separate apps win when two tools share nothing, because a shared page costs
every tool the weight of all the others - it is one download, one cache entry
and one CSP hash.

**Say the folder thing out loud, early.** People ask for "a folder of tool
icons on the phone". No web page can create a home-screen folder; only the OS
can, and only when a person drags one icon onto another. If that ask slides,
everything built on top of it is wasted. What *is* possible is in
`references/home-screen-identity.md`, and it satisfies the ask when it is
offered honestly and early.

## The registry is the app

Every list in the app comes from one array. Not a list in the HTML, not a
switch in the router, not a second table in the icon script - one array, and
everything else derived from it.

```js
TOOLS.push({
  id: 'cidr',                              // hash route, icon filename, stored value
  name: 'CIDR Calculator',                 // home tile, header, home-screen name
  blurb: 'Network, broadcast, mask and host range',
  keywords: 'cidr netmask subnet prefix',  // the search box
  render: function (root) { /* builds its own panel into root */ }
});
```

That buys: the home grid, the search filter, `#/<id>` routing, the stored "last
tool open" validated against real ids, the install picker, the manifest
shortcuts, the icon set, and a test loop that opens all of them. Adding a tool
becomes one object plus one entry in the icon table - and a test that fails
until the icon exists.

Details and the routing code: `references/tool-registry-and-routing.md`.

## A shared UI kit, or twelve tools that look like twelve apps

Write the kit before the second tool, not after the fifth. A tool file should
never touch the DOM directly; it calls helpers:

```
card(root, title)             a titled section
field(card, label, opts)      label + input, returns the input
selectField / optionRow       a select, a row of checkboxes
buttonRow / button            the action row
outRow(card, key, value)      a labelled output line, tap to copy
outArea(card)                 a large monospace output block
messageBox(root, kind, text)  the err / warn / ok boxes
examples(root, values, fn)    one-tap sample inputs
helpBlock(root, items)        the collapsed "what this does" panel
copyText / pasteInto          clipboard both ways, with fallbacks
toast(text)                   the only feedback channel
```

Three rules that pay off at tool number eight:

- **Every user value goes in with `textContent`.** Never `innerHTML`, not once,
  so the security test can assert the string never appears in the file.
- **Every tool gets examples, help and paste.** A tool with no sample input is
  a tool nobody tries. Uniformity here is what makes twelve screens feel like
  one app.
- **Outputs are buttons.** Tap any value to copy it; one helper, and it removes
  every "select the text on a phone" complaint.

## One page, assembled from parts

Past roughly 1500 lines, editing the single file by string replacement starts
failing silently. Split the source and concatenate it:

```
src/head.html      head tags, the CSP meta tag
src/style.css      the one inline stylesheet
src/body.html      the shell markup
src/app/00-core.js ... 80-app.js   the script, in numbered parts
tools/build.mjs    concatenates them into index.html, --check for CI
```

Non-negotiable: **CI runs `build.mjs --check`**. Without it someone edits the
generated `index.html`, the parts go stale, and the next build silently reverts
their fix. The check compares everything except the CSP meta line, which is
rewritten after assembly.

Order of operations after any edit: `build.mjs`, then `csp.mjs`, then the
tests. Wire it as `npm run build` so it cannot be half-done.

## Per-tool home-screen identity

The whole reason a toolkit beats twelve bookmarks. Four things work, and they
are worth all four:

1. **An icon and a name per tool.** iOS reads `apple-touch-icon` and
   `apple-mobile-web-app-title` from the *live DOM* at the moment Share > Add
   to Home Screen is tapped, so swapping them when a tool opens makes each tool
   land as its own app, with its own icon.
2. **Manifest `shortcuts`.** Android's long-press menu on the installed icon,
   one entry per tool, generated from the registry.
3. **A guided add.** Walk the chosen tools one at a time: open it, say exactly
   what to tap, next.
4. **The honest sentence about folders**, in the install sheet itself.

All of it, including the iOS timing trap: `references/home-screen-identity.md`.

## Long-press to choose tools

Phones already teach the gesture: hold an icon to start selecting. Copy it
rather than adding a second screen of checkboxes. Three details make or break
it, and each one is a bug that shipped first:

- **Suppress the click that follows.** The press that started select mode also
  fires `click` on release, which opens the tool just selected. Time-bound it:
  `suppressClickUntil = Date.now() + 700`.
- **Movement cancels.** More than ~10px of drag is a scroll, not a press.
- **`contextmenu` is the desktop and iOS path.** Right-click and an iOS hold
  both raise it; prevent the default and start selecting.

Code, with the pointer/touch/mouse fallback:
`references/tool-registry-and-routing.md`.

## Light and dark that cannot drift

Twelve tools means dozens of colour decisions, and one hardcoded hex is
invisible until somebody opens the other theme. Define every colour twice -
`:root` and `@media (prefers-color-scheme: light)` - name colours nowhere else,
and let a test prove it: both palettes define the same names, and no rule
outside them contains a `#hex` or an `rgb(`. Set `color-scheme` in both so
native controls follow. `references/theming.md` has the token set, the contrast
check, and the two places a static page genuinely cannot follow the setting.

## Testing twelve tools without twelve test files

The tests run the shipped page's own inline script in a Node `vm` against a
stub DOM - no dependencies, and no parallel copy of the logic to drift.

The multiplier is the registry: one loop opens every tool, renders its panel
and asserts it produced something, so a tool that throws on load cannot reach a
commit. Then unit-test the engines (the pure functions) hard and the UI thinly.
`references/testing-many-tools.md` has the loop, the CSS-structure guards that
catch what a Node test normally cannot, and the browser checks worth doing by
hand.

## Size, honestly

Real numbers from a twelve-tool build, as a yardstick:

| | |
|---|---|
| `index.html`, twelve tools, all markup, style and script | 162 KB |
| twelve 192px tool icons plus three app icons | ~105 KB |
| whole app, everything a browser fetches | 270 KB |

The page grows roughly 10-13 KB per tool including its help text. **Icons are
the surprise**: a gradient in a 512px PNG can cost more than two tools. If a
size claim is going in a post, measure the *whole app*, not just the page, and
say which one is being quoted.

## Traps that cost real time

Beyond the ones in `single-file-pwa`, which all still apply:

- **A bare `.tile span` rule styles the selection dot too.** Any decorative
  span inside a tile gets caught by a descendant selector written for the
  label. Give each its own class, and add a test.
- **`localStorage` is the one attacker-controlled input.** Validate the stored
  tool id against the registry on every read - `isKnownTool(id)` - before it
  reaches the DOM or a route.
- **Headless Chrome on Windows will not render below ~496px wide.** Narrow-
  phone layout cannot be measured there; measure at 500 and reason about the
  rest, or use a real device.
- **Measure the viewport with `--dump-dom`, not the screenshot size.** Browser
  chrome is subtracted from `--window-size`, so a "360px" screenshot is not one.
- **A button row that wraps eats a whole row of screen.** On a phone, put the
  droppable half of a label in its own span and hide it under a breakpoint
  (`Add 3` / `Add 3 to home screen`) rather than letting three buttons wrap.
- **WebCrypto is async and absent on `file://`.** A hash tool that must work
  from a local file needs pure-JS implementations, not `crypto.subtle`.
- **Twelve parts, one CSP hash.** Any edit to any part changes the script hash;
  re-pin after every build, or the live page refuses to run its own script -
  which the tests never catch, only a browser does.

## Scripts in this skill

Dependency-free, Node 18+. Copy into the project's `tools/`:

- `scripts/build.mjs` - concatenates `src/` into `index.html`; `--check` for
  CI. Script parts are discovered in filename order, so adding `35-thing.js`
  needs no edit here.
- `scripts/tool-icons.mjs` - renders one PNG per tool from a generated SVG and
  rewrites the manifest `shortcuts`, reading the tool table from
  `tools/tools.json`. Resumes and retries, because headless browsers stall for
  no reason anyone can reproduce.
- `scripts/csp.mjs` - re-pins the inline script and style hashes; `--check` for
  CI. The same script as in `single-file-pwa`.

## Before calling it done

- `npm test` green, including `build --check`, `csp --check` and the icon check.
- Open the **live URL** in a browser and confirm the tools render - a broken
  CSP hash only shows up there, never in the tests.
- Open one tool from a cold cache with the network off.
- Both themes on a real phone, not only in a headless screenshot.
- Add two tools to a real home screen and confirm they arrive with different
  icons and different names.
- Say what it stores, what it does not verify, and which size figure is being
  quoted.
