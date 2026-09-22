# Light and dark, in one stylesheet, without drift

A twelve-tool app has dozens of colour decisions spread over a thousand lines
of CSS. One literal `#0d1219` left behind is invisible until somebody opens the
other theme - usually a reviewer, on their phone, in public.

The rule that makes it safe: **a colour literal may appear in exactly two
places in the file**, and nowhere else names a colour.

## The shape

```css
/* Every colour lives here twice: once for dark, once for light below. The
   rest of the file only ever names a token, so the two themes cannot drift. */
:root {
  color-scheme: dark;
  --bg: #0b0e13;
  --panel: #141a23;
  --panel-2: #1b2330;
  --well: #0d1219;          /* inputs and output blocks */
  --line: #263041;
  --line-2: #35506a;        /* hover and active borders */
  --ink: #e6edf3;
  --dim: #94a3b8;
  --accent: #5eead4;
  --accent-ink: #06231f;    /* text on the accent */
  --accent-2: #38bdf8;
  --good: #4ade80;
  --warn: #fbbf24;
  --bad: #f87171;
  --sel: #16232c;           /* a selected tile */
  --hit: rgba(94, 234, 212, 0.22);
  --veil: rgba(3, 6, 10, 0.72);     /* behind a sheet */
  --bar: rgba(11, 14, 19, 0.92);    /* sticky header */
  --bar-2: rgba(20, 26, 35, 0.97);  /* bottom bar */
  --err-line: #5b2a2a;  --err-bg: #2a1414;  --err-ink: #fecaca;
  --warn-line: #5b4a1e; --warn-bg: #26200f; --warn-ink: #fde68a;
  --ok-line: #1e5b46;   --ok-bg: #0f261d;   --ok-ink: #bbf7d0;
}

@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #f1f4f9;
    --panel: #ffffff;
    --panel-2: #e9eef6;
    --well: #ffffff;
    --line: #cfd8e4;
    --line-2: #8aa0ba;
    --ink: #10141b;
    --dim: #51607a;
    --accent: #0f6f68;
    --accent-ink: #ffffff;
    --accent-2: #0369a1;
    --good: #15803d;
    --warn: #92600a;
    --bad: #b4232c;
    --sel: #ddf1ee;
    --hit: rgba(15, 111, 104, 0.28);
    --veil: rgba(15, 23, 42, 0.42);
    --bar: rgba(241, 244, 249, 0.92);
    --bar-2: rgba(255, 255, 255, 0.97);
    --err-line: #e7a3a3;  --err-bg: #fdecec;  --err-ink: #8a1c1c;
    --warn-line: #dcb964; --warn-bg: #fbf1da; --warn-ink: #75500a;
    --ok-line: #80cfab;   --ok-bg: #e6f6ee;   --ok-ink: #0b5a3a;
  }
}
```

`color-scheme` in both blocks is what makes native form controls, scrollbars
and the default caret follow. Without it the inputs stay dark in light mode on
some browsers, which looks like a rendering bug.

Translucent surfaces (`--veil`, `--bar`) need their own tokens; a single
`rgba()` cannot be theme-neutral because what shows through changes.

## Tell the browser chrome

```html
<meta name="theme-color" content="#0b0e13" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f1f4f9" media="(prefers-color-scheme: light)">
<meta name="color-scheme" content="dark light">
```

Put the dark tag first: a browser that ignores `media` takes the first one, so
the fallback stays whatever the app looked like before.

## Two places a static page cannot follow the setting

Write these down rather than letting someone file them as bugs:

- **The installed app's splash screen** comes from `theme_color` and
  `background_color` in the manifest. Those are single values with no media
  variant, so a light-mode install flashes the dark colour for a moment on
  launch.
- **The iOS status bar** in a home-screen app comes from
  `apple-mobile-web-app-status-bar-style`, which also has no light variant and
  is read at launch. Changing it at runtime does nothing.

## Check contrast with arithmetic, not taste

Both palettes, every text-on-background pair, WCAG AA is 4.5:1:

```js
const rgb = v => v[0] === '#'
  ? [0, 2, 4].map(i => parseInt(v.slice(1).substr(i, 2), 16))
  : v.match(/[\d.]+/g).map(Number);
const lum = c => {
  const [r, g, b] = c.slice(0, 3).map(x => {
    x /= 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
```

Run it over the token pairs that actually meet: ink on bg, ink on panel, dim on
panel, accent-ink on accent, good/warn/bad on panel, and each message box's ink
on its own background. Light palettes are where this bites - a teal that reads
beautifully on near-black is 2:1 on white.

## The test that keeps them together

```js
const style = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
const rootDecls = /:root\s*\{([^}]*)\}/.exec(style);
const lightDecls = /@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(style);

const colourNames = decls => {
  const names = new Set();
  String(decls || '').split(';').forEach(decl => {
    const found = /(--[a-z0-9-]+)\s*:\s*(\S.*)/.exec(decl);
    if (found && /^(#|rgba?\()/.test(found[2].trim())) names.add(found[1]);
  });
  return names;
};

const dark = colourNames(rootDecls[1]);
const light = colourNames(lightDecls[1]);
dark.forEach(n => t.ok('light redefines ' + n, light.has(n)));
light.forEach(n => t.ok('dark defines ' + n, dark.has(n)));

/* nothing outside the two palettes names a colour */
const outside = style.replace(rootDecls[0], '').replace(lightDecls[0], '');
const strays = outside.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [];
t.ok('no colour hardcoded outside the palettes: ' + strays.join(' '), strays.length === 0);
```

The stray check is the valuable one, and it prints what it found so the failure
names the offending colour. ID selectors do not trip it: `#home` and `#sheet`
are not three hex digits.

## Look at it

Headless Chrome and Edge take the scheme from a Blink setting:

```sh
msedge --headless=new --disable-gpu --hide-scrollbars \
  --window-size=500,820 --blink-settings=preferredColorScheme=1 \
  --screenshot=light.png file:///.../index.html     # 1 light, 0 dark
```

Screenshot the home grid, one dense tool panel, and a page with the error,
warning and ok boxes on it - those three are hard to reach by clicking in
headless, so it is worth assembling a scratch page that includes the real
stylesheet and just those elements.
