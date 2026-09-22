# Filling the screen on an installed phone app

The complaint is always the same: "I added it to my iPhone but it is not the
whole screen, there are gaps at the top and bottom." Two separate causes, and
they need different fixes.

## Cause 1: scaling to fit instead of to fill

A fixed-size design scaled with `Math.min(w / DESIGN_W, h / DESIGN_H)` fits
inside the screen, so any phone whose aspect ratio is taller than the design
gets the surplus split evenly above and below. That is correct for a preview in
a desktop browser and wrong for an installed app.

Fill instead: scale to the width, then stretch the body to the full height and
hand the surplus to whichever parts should grow (a display area, the gaps
between rows), with a cap so it does not look stretched on a tall screen.

```js
var DESIGN_W = 360, DESIGN_H = 662, LCD_H = 104, FOOT_H = 54;

function fit() {
  var st = document.getElementById('stage');
  var app = isStandalone();
  document.body.classList.toggle('standalone', app);

  var box = usableBox();
  var s, bodyH = DESIGN_H, lcdH = LCD_H;

  if (app) {
    s = box.w / DESIGN_W;                 /* width first */
    var want = box.h / s;                 /* height available in design units */
    if (want < DESIGN_H) s = box.h / DESIGN_H;   /* very short screen: fit after all */
    else {
      bodyH = Math.min(want, 900);               /* stretch, with a limit */
      var extra = bodyH - DESIGN_H;
      lcdH = LCD_H + Math.min(extra * 0.4, 64);  /* give part of it to the display */
    }
    st.style.height = bodyH + 'px';
  } else {
    s = Math.min((box.w - 16) / DESIGN_W, (box.h - 16) / (DESIGN_H + FOOT_H), 1.4);
    st.style.height = (DESIGN_H + FOOT_H) + 'px';
  }
  st.style.transform = 'scale(' + s + ')';
}

window.addEventListener('resize', fit);
window.addEventListener('orientationchange', fit);
if (window.matchMedia) {
  var mq = window.matchMedia('(display-mode: standalone)');
  if (mq.addEventListener) mq.addEventListener('change', fit);
}
```

Some margin on the short side is unavoidable when the screen is proportionally
wider than the design (an iPhone SE, for instance). Leave it rather than
distorting the layout, and say so.

## Cause 2: computing the usable height instead of measuring it

Whether `innerHeight` already excludes the status bar depends on the
`apple-mobile-web-app-status-bar-style` value and on iOS version. Subtracting
the safe-area insets from it therefore double-subtracts on some devices, which
reintroduces exactly the gap you were trying to remove.

Let the browser answer instead. Put a hidden element inset by the safe areas
and measure it:

```css
#safeprobe {
  position: fixed; visibility: hidden; pointer-events: none; z-index: -1;
  top: env(safe-area-inset-top); bottom: env(safe-area-inset-bottom);
  left: env(safe-area-inset-left); right: env(safe-area-inset-right);
}
```

```js
function usableBox() {
  var w = window.innerWidth, h = window.innerHeight;
  var p = document.getElementById('safeprobe');
  if (!p && document.body && document.body.appendChild) {
    p = document.createElement('div'); p.id = 'safeprobe'; document.body.appendChild(p);
  }
  if (p && p.getBoundingClientRect) {
    var r = p.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) { w = r.width; h = r.height; }
  }
  return { w: w, h: h };
}
```

This is right on every combination without branching on user agent or version,
and it degrades to `innerWidth/innerHeight` where the probe cannot be measured
(including a stub DOM in tests).

## Supporting CSS

```css
html, body { margin: 0; height: 100%; overflow: hidden; }
body {
  display: flex; align-items: center; justify-content: center;
  padding: env(safe-area-inset-top) env(safe-area-inset-right)
           env(safe-area-inset-bottom) env(safe-area-inset-left);
}
#stage { width: 360px; transform-origin: 50% 50%; flex: none; }
body.standalone { background: #0c0c0d; }         /* the sliver beside the app */
body.standalone .frame { border-radius: 0; }     /* no device frame once installed */
```

`overflow: hidden` on `html, body` stops the rubber-band scroll that otherwise
exposes a white strip under the layout on iOS.

## Verifying without a phone

Headless Chrome or Edge, measuring rather than eyeballing. Note that
`--window-size` is not the viewport: browser chrome is subtracted, so compute
the offset once and check the numbers with `--dump-dom` instead of trusting a
screenshot.

```js
/* inject before rendering, then read document.title from --dump-dom output */
var r = document.querySelector('.frame').getBoundingClientRect();
document.title = window.innerWidth + 'x' + window.innerHeight +
  ' -> ' + Math.round(r.width) + 'x' + Math.round(r.height) +
  ' gaps v=' + Math.round(window.innerHeight - r.height) +
  ' h=' + Math.round(window.innerWidth - r.width);
```

Check iPhone SE (375x667), iPhone 14 (390x844), 15 Pro Max (430x932) and a
Pixel (412x915). A vertical gap of 0 on all four means the fill works; a
horizontal gap on the SE alone is the aspect-ratio margin described above.

The page under test needs its CSP meta stripped in the temp copy, because an
injected script has no hash. That the injection is refused otherwise is a useful
confirmation the policy is live.
