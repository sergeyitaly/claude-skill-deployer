/* Turns one SVG into the three PNG icons a phone install needs, using the
   headless browser that is already on the machine. No ImageMagick, no sharp,
   no design tool, nothing to install.

     node tools/svg-to-icons.mjs icon.svg [outdir]

   Writes icon-180.png (iOS home screen), icon-192.png and icon-512.png
   (manifest, and the maskable entry). The SVG should be square and should
   paint its own background - a transparent icon turns into a black square on
   an iOS home screen. Keep the artwork inside the middle 80% so a maskable
   crop on Android does not cut it.
*/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SIZES = [180, 192, 512];

const svgPath = process.argv[2];
const outDir = process.argv[3] || 'icons';
if (!svgPath) {
  console.error('usage: node tools/svg-to-icons.mjs icon.svg [outdir]');
  process.exit(1);
}

const CANDIDATES = process.platform === 'win32'
  ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
     'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
     'C:/Program Files/Google/Chrome/Application/chrome.exe',
     'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
       '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
       '/usr/bin/microsoft-edge', '/snap/bin/chromium'];

const browser = (process.env.CHROME || '').trim() || CANDIDATES.find(p => fs.existsSync(p));
if (!browser) {
  console.error('No Chrome, Chromium or Edge found. Set CHROME=/path/to/browser.');
  process.exit(1);
}

const svg = fs.readFileSync(svgPath, 'utf8');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icons-'));

for (const size of SIZES) {
  /* an exact-size page holding the SVG, so the screenshot is the icon */
  const page = `<!DOCTYPE html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}
svg{display:block;width:${size}px;height:${size}px}</style>
${svg}`;
  const file = path.join(tmp, 'icon-' + size + '.html');
  fs.writeFileSync(file, page);

  const out = path.resolve(outDir, 'icon-' + size + '.png');
  /* a headless browser occasionally stalls on start-up; fail with a message
     rather than hanging a build or a scaffold forever */
  try {
    execFileSync(browser, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      '--force-device-scale-factor=1',
      '--virtual-time-budget=2000',
      '--window-size=' + size + ',' + size,
      '--screenshot=' + out,
      'file:///' + file.replaceAll('\\', '/')
    ], { stdio: 'ignore', timeout: 60000 });
  } catch (e) {
    console.error('the browser did not render the ' + size + 'px icon' +
      (e.signal ? ' (timed out)' : '') + ': ' + browser);
    process.exit(1);
  }

  if (!fs.existsSync(out)) {
    console.error('the browser produced no file for ' + size + 'px');
    process.exit(1);
  }
  console.log(out + '  ' + fs.statSync(out).size + ' bytes');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nReference them from the page and the manifest:');
console.log('  <link rel="apple-touch-icon" href="./icons/icon-180.png">');
console.log('  <link rel="icon" href="./icons/icon-192.png" sizes="192x192" type="image/png">');
