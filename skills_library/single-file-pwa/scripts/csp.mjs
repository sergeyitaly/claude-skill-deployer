/* Pins every inline <script> and <style> in a single-file page by SHA-256, so
   the Content-Security-Policy can refuse everything else without resorting to
   'unsafe-inline'.

     node tools/csp.mjs [page.html]            rewrite the policy
     node tools/csp.mjs [page.html] --check    fail if it no longer matches

   The hash covers the exact bytes between the tags, so any edit to the page
   invalidates it - run this after every edit, and --check in CI. A CRLF
   checkout breaks it too: commit .gitattributes with `* text=auto eol=lf`.
*/
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const check = args.includes('--check');
const FILE = args.find(a => !a.startsWith('--')) || 'index.html';

const TAG = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/;

/* inline blocks only - one carrying src= or href= is not inline and needs no hash */
function inlineBlocks(html, tag) {
  const out = [];
  const open = new RegExp('<' + tag + '([^>]*)>', 'gi');
  let m;
  while ((m = open.exec(html)) !== null) {
    if (/\b(src|href)\s*=/i.test(m[1])) continue;
    const start = m.index + m[0].length;
    const end = html.indexOf('</' + tag + '>', start);
    if (end < 0) throw new Error('unterminated <' + tag + '> in ' + FILE);
    out.push(html.slice(start, end));
    open.lastIndex = end;
  }
  return out;
}

function sha(src) {
  return "'sha256-" + crypto.createHash('sha256').update(src, 'utf8').digest('base64') + "'";
}

function sourceList(html, tag) {
  const blocks = inlineBlocks(html, tag);
  return blocks.length ? blocks.map(sha).join(' ') : "'none'";
}

function policy(html) {
  return [
    "default-src 'self'",
    'script-src ' + sourceList(html, 'script'),
    'style-src ' + sourceList(html, 'style'),
    "img-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}

const html = fs.readFileSync(FILE, 'utf8');
const want = policy(html);
const found = TAG.exec(html);

if (!found) {
  console.error(FILE + ' has no Content-Security-Policy meta tag. Add:');
  console.error('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">');
  process.exit(1);
}

if (check) {
  if (found[1] !== want) {
    console.error('The CSP hashes are stale. Run: node tools/csp.mjs ' + FILE);
    console.error('  expected: ' + want);
    console.error('  found:    ' + found[1]);
    process.exit(1);
  }
  console.log('CSP matches the inline script and style.');
  process.exit(0);
}

fs.writeFileSync(FILE, html.replace(TAG,
  '<meta http-equiv="Content-Security-Policy" content="' + want + '">'));
console.log('CSP updated:\n' + want);
