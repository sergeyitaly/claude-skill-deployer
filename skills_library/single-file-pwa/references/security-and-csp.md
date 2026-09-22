# Security for a page with no backend

A static single file has no server to attack, which removes most of the usual
list and leaves a small, checkable one. The value of writing it down is that
"there is nothing to attack" becomes something CI proves on every push rather
than something you assert.

## The policy

GitHub Pages cannot send response headers, so the policy goes in a meta tag.
`'unsafe-inline'` would defeat the point, so pin the inline script and style by
hash:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'sha256-...'; style-src 'sha256-...'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'">
```

The hash covers the exact bytes between `<script>` and `</script>`, so every
edit to the page invalidates it. `scripts/csp.mjs` recomputes it; run it after
every change and run `--check` in CI. Getting this wrong fails loudly - the page
refuses to run its own script - but only in a browser, never in Node tests, so
always load the built page in a browser before shipping.

`frame-ancestors` in a meta tag is honoured by current browsers for framing.
`X-Frame-Options` and HSTS need headers and are simply unavailable on Pages;
note that in SECURITY.md rather than pretending otherwise. Pages does serve
HTTPS and sends HSTS for `*.github.io`.

**Line endings.** `* text=auto eol=lf` in `.gitattributes`, committed early. A
Windows checkout otherwise rewrites the file to CRLF, the hash no longer
matches, and the page is broken on that machine only - an hour of confusion,
every time.

## What to enforce, and how it is checked

| Risk | What prevents it | Checked by |
|---|---|---|
| Injected code running | Hash-pinned CSP, no `unsafe-inline`/`unsafe-eval` | test + `csp.mjs --check` |
| Dynamic code execution | No `eval`, `new Function`, `document.write`, string timers | regex test |
| HTML injection via a DOM sink | User input rendered with `textContent`; `innerHTML` only from a known list of sources | regex test |
| Third-party code | No `<script src>`, no CDN, no fonts, no `fetch`/XHR | regex test |
| Inline handlers | No `on*=` attributes in markup; listeners attached in code | regex test |
| Over-broad caching | Worker ignores non-GET and cross-origin | regex test |
| Clickjacking | `frame-ancestors 'none'` | regex test |
| Supply chain | No dependencies at all | n/a |
| Unknown issues | CodeQL `security-extended`, push and weekly | workflow |

The tests are regexes over the built file. That is cruder than a parser and
entirely adequate: they are guarding against a careless edit, not a determined
attacker with commit access.

Two details worth copying:

- Take the markup for the "no inline handlers" test by slicing at the known
  script boundaries rather than stripping tags with a regex. CodeQL flags
  tag-stripping regexes (`js/bad-tag-filter`,
  `js/incomplete-multi-character-sanitization`) in test helpers as readily as in
  product code, and it is right to.
- Assert an allow-list of `innerHTML` sources by name rather than counting
  occurrences, so adding a new sink is a deliberate act that fails the test.

## Storage discipline

Prefer keeping nothing. When a preference genuinely needs to survive a relaunch,
keep exactly one entry and be able to say so:

- One key, a fixed literal name, prefixed with the project - every project page
  on `user.github.io` shares one origin, so the namespace is shared with the
  user's other repos.
- Pack several settings into that one entry rather than spreading keys.
- **Validate on the way back in.** A stored value is the one input an attacker
  with the device (or an old buggy version) controls. If it reaches an
  attribute, a class name or a template, check it against a fixed list first.
- Write the narrow test rather than a blanket ban: match every `localStorage`
  call in the file and fail if there is one you did not intend, or if the key is
  not the constant. That is a stronger guarantee than "no storage anywhere" and
  survives the feature that needs it.
- Say in the README exactly what is kept. "Nothing stored about you" stops being
  true the moment a preference is saved, and someone will check.

## Wrap every optional platform call

`localStorage` throws in private modes, `AudioContext` does not exist
everywhere, `navigator.vibrate` is absent on iOS. Guard with `typeof` and
`try/catch` so a missing capability degrades instead of taking the page down:

```js
function savePrefs() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(PREF_KEY, value);
  } catch (e) { }
}
```

This also keeps the page runnable under a stub DOM in tests, which is what makes
the logic testable at all.

## Workflows

`.github/workflows/ci.yml` - tests plus `csp.mjs --check` plus an existence
check for every file referenced by the page and the worker:

```yaml
name: CI
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
      - run: node test/engine.test.js
      - run: node test/ui.test.js
      - run: node test/security.test.js
      - run: node tools/csp.js --check
```

`.github/workflows/codeql.yml` - `github/codeql-action` with
`languages: javascript-typescript` and `queries: security-extended`, on push,
pull request and a weekly schedule. It is free on public repos and it does find
things, including in test helpers.

Keep YAML files ending in exactly one newline, and keep emoji out of every file
that is not Markdown.
