# Testing twelve tools with no dependencies

The setup is the one in `single-file-pwa`: a stub DOM plus `vm.runInContext`
runs the **shipped page's own inline script** in Node. Nothing is installed,
and there is no parallel copy of the logic to drift out of sync. This file is
what to do with that once there are a dozen tools.

## Three files, three jobs

```
test/engine.test.js     the pure functions - where the bugs actually are
test/ui.test.js         the shell: routing, select mode, install flow, panels
test/security.test.js   regexes over the shipped file, plus structure guards
```

Split by what fails, not by tool. A CIDR bug is an engine bug; a tile that
renders twice is a UI bug. Twelve files named after tools would duplicate the
harness twelve times and still not cover the shell.

## The loop that scales

One assertion per tool, from the registry, so a new tool is covered the moment
it is registered:

```js
APP.tools.forEach(tool => {
  const panel = doc.getElementById('panel');
  APP.open(tool.id);
  t.ok(tool.id + ' renders a panel', panel.children.length > 0);
  t.ok(tool.id + ' has a help block', nodeText(panel).includes('What this does'));
  t.ok(tool.id + ' offers examples', nodeText(panel).includes('Examples'));
  t.ok(tool.id + ' sets the home-screen icon',
    doc.getElementById('touchicon').getAttribute('href').includes(tool.id));
});
```

That is four assertions x twelve tools for ten lines, and it catches the two
failures that matter most: a tool that throws on open, and a tool that quietly
skipped the house rules.

Also loop the registry for consistency itself:

```js
const ids = APP.tools.map(t2 => t2.id);
t.ok('ids are unique', new Set(ids).size === ids.length);
t.ok('ids are url-safe', ids.every(id => /^[a-z0-9-]+$/.test(id)));
t.ok('every tool has a blurb and keywords',
  APP.tools.every(t2 => t2.blurb && t2.keywords));
```

## Expose the shell for testing

Give the script one export object. Without it the tests can only poke the DOM,
and every assertion becomes a string match:

```js
window.APP = {
  tools: TOOLS, byId: TOOL_BY_ID, open: openTool, home: goHome, route: routeFromHash,
  renderHome: renderHome, enterSelectMode: enterSelectMode, exitSelectMode: exitSelectMode,
  toggleSelect: toggleSelect, selected: selected, longPressMs: LONG_PRESS_MS,
  loadPrefs: loadPrefs, savePrefs: savePrefs, boot: boot
};
```

It is also the honest interface to the app: if something is awkward to test
through `APP`, it is usually awkward to reason about.

## Timing tests for the gesture

Long-press is the one piece of UI with real time in it. The stub DOM can fire
events; `APP.longPressMs` tells the test how long to wait:

```js
const tile = grid.children[0];
tile.dispatch('pointerdown', { clientX: 10, clientY: 10 });
await wait(APP.longPressMs + 40);
t.ok('the hold entered select mode', grid.className.includes('picking'));

tile.dispatch('click');                       // the click that follows the press
t.ok('the click after a long press is swallowed', APP.current() === '');
```

And the negative case, which is the one that regresses: a short press followed
by a click must still open the tool, and a press that moves must not select.

## Guards a Node test can still make about CSS

The stylesheet ships inside the file, so regexes over it are cheap and catch
real bugs that unit tests structurally cannot:

```js
t.ok('the tile description has its own class', /\.tileblurb\s*\{/.test(html));
t.ok('no bare .tile span rule', !/\.tile\s+span\s*\{/.test(html));
t.ok('the selection dot is hidden unless picking',
  /\.pickdot\s*\{[^}]*display:\s*none/.test(html) &&
  /\.grid\.picking\s+\.pickdot\s*\{[^}]*display:\s*block/.test(html));
t.ok('the home grid is three columns',
  /\.grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/.test(html));
```

Each of those started as a bug found in a screenshot. That is the pattern
worth copying: when a visual bug is fixed, leave behind the cheapest regex that
would have caught it.

## Security checks, narrowed

The obvious regexes match your own prose and fail for the wrong reason. Narrow
them:

- `innerHTML` matches a comment explaining why you never use it - test for
  `.innerHTML` instead.
- `Math.random` matches "no `Math.random` fallback" in a comment - test for
  `Math\s*\.\s*random\s*\(`.
- "no external origins" matches the SVG namespace URL and `example.com` in a
  sample input - allowlist those two and assert every *referenced resource* is
  relative:

```js
const refs = html.match(/(?:src|href)="([^"]+)"/g) || [];
refs.forEach(ref => {
  t.ok('relative resource: ' + ref, !/https?:\/\//.test(ref) || ALLOWED.test(ref));
});
```

## What tests cannot tell you

Run these by hand before claiming anything:

- **The live URL in a real browser.** A broken CSP hash never fails a Node
  test; the page just refuses to run its own script. Load it and count the
  tiles - if they render, the hashes are right.
- **`--dump-dom` for geometry.** Ask the page, not the screenshot:

```sh
msedge --headless=new --window-size=500,900 --dump-dom file:///.../index.html
```

  Then measure `innerWidth` vs `document.body.scrollWidth` at each breakpoint;
  any difference is a horizontal scrollbar on somebody's phone. Note that
  headless Chrome on Windows will not go below about 496px wide, so the
  narrowest phone layout has to be reasoned about or checked on a device.
- **Aeroplane mode, launched from the home-screen icon**, after a cold start.
- **Both themes on a real phone.**

## CI

Run exactly what `npm test` runs, plus the generated-file checks, or the
generated files go stale:

```yaml
      - run: node test/engine.test.js
      - run: node test/ui.test.js
      - run: node test/security.test.js
      - run: node tools/build.mjs --check       # index.html matches src/
      - run: node tools/csp.mjs --check         # hashes match the inline script
      - run: node tools/tool-icons.mjs --check  # icons and shortcuts match the registry
```

If the repo has a `.gitignore` that excludes `.github/` - some editor and agent
tooling adds one - the workflows never reach the remote and every claim about
CI is false. Check before saying "CI runs on every push":

```
.github/*
!.github/workflows/
```
