# Testing a single-file app without dependencies

The page has no modules and no exports, so there is nothing to `require`. Run
its script inside `vm.runInContext` against a stub DOM instead. That gives real
tests over the real shipped file - not a copy, not a rebuilt module - with zero
dependencies, which is what keeps the project cheap to keep alive.

## The harness

```js
const fs = require('fs');
const vm = require('vm');
const { makeDom } = require('./dom');

const src = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
const js = src.slice(src.indexOf('<script>') + 8, src.lastIndexOf('</script>'));

const dom = makeDom();
const ctx = {
  document: dom.document,
  navigator: { userAgent: 'node' },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, Math, Number, String, Array, JSON, Date, RegExp, Object
};
ctx.window = Object.assign(ctx, dom.window);
vm.createContext(ctx);
vm.runInContext(js, ctx, { filename: 'app.js' });
const APP = ctx.APP;                     /* whatever the page exported */
```

The page ends with `window.APP = { ...internals }` for exactly this. Export the
dispatcher and the state, not every function - tests that reach into private
helpers ossify the code.

## The stub DOM

Forty lines, only what the page touches: `createElement`, `appendChild`,
`textContent`, `classList`, `dataset`, `getElementById`, `querySelector`,
`addEventListener`, `getBoundingClientRect` returning zeros.

Two details that cost an hour each:

- Reset the cached text when a child is appended (`e._text = null`), or
  `textContent` reads back empty and half the assertions pass for the wrong
  reason.
- Return `null` from `getElementById` for elements the page creates on demand,
  so the real create path is exercised.

Add a `nodeText()` helper that renders the element tree to a compact string, so
assertions read `'(1/3)'` rather than walking children.

## Three test files

- **engine** - the logic, called directly. Pure input to output, the cheapest
  and most valuable tests.
- **ui** - drive the real dispatcher: `APP.press('shift'); APP.press('8')`, then
  assert on state and on the rendered text. This is the layer that catches
  wiring bugs, which is where the real bugs are. Every user-visible bug becomes
  a test here.
- **security** - regexes over the built file, per
  `references/security-and-csp.md`, plus `csp.mjs --check`, plus that every file
  referenced by the page and the worker exists.

A minimal assertion helper is enough; a framework would be the only dependency
in the project:

```js
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++; console.log('FAIL ' + name + (extra ? ' - ' + extra : ''));
}
function check(name, got, want) { ok(name + ' (' + got + ')', got === want, 'wanted ' + want); }
process.on('exit', () => process.exit(fail ? 1 : 0));
```

## What Node tests cannot see

They run the script, not the browser, so they cannot see layout, CSS, the CSP,
the service worker or whether a key is readable on the case colour you just
added. Use a headless browser for those:

```sh
msedge --headless=new --disable-gpu --virtual-time-budget=3000 \
  --screenshot=out.png --window-size=434,755 "file:///abs/path/index.html"

msedge --headless=new --disable-gpu --virtual-time-budget=3000 \
  --dump-dom "file:///abs/path/probe.html"
```

`--dump-dom` is the more useful of the two: write measurements into
`document.title` from an injected script and read them out of the dumped HTML.
That turns "does it fill the screen" into a number.

Caveats, all of which have wasted time:

- `--window-size` is not the viewport; browser chrome is subtracted.
- An injected probe script has no CSP hash, so strip the meta tag in the temp
  copy. (That it is refused otherwise confirms the policy works.)
- The page's own boot code runs, so a value you inject into the markup may be
  overwritten. Patch the source default instead of the rendered DOM.
- Each headless run gets a fresh profile, so `localStorage` starts empty. To
  test that a setting survives a relaunch, pass the same `--user-data-dir` to
  two runs: one that sets it, one that reads it back.

## Shape of a run

```
node test/engine.test.js && node test/ui.test.js && node test/security.test.js
node tools/csp.js --check
```

Put that in `package.json` as `test` even though there are no dependencies -
`npm test` is what a visitor will try. Keep the assertion count in the README;
it is a cheap signal that the tests are real, and updating it is a reminder to
add tests with each feature.
