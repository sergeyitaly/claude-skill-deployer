/* Assembles index.html from the parts in src/.

   There is no bundler and no transform: the output is the input files
   concatenated, which keeps "what you edit is what ships" true while still
   allowing the page to be edited in pieces small enough to reason about.

     node tools/build.mjs            write index.html
     node tools/build.mjs --check    fail if index.html is out of date

   Expects:

     src/head.html    everything up to and including <style>
     src/style.css    the one inline stylesheet
     src/body.html    </style> ... <body> ... <script>
     src/app/*.js     the script, in filename order (00-core.js, 10-net.js, ...)

   Script parts are discovered, not listed, so adding src/app/35-thing.js needs
   no edit here. Number the prefixes in tens and leave gaps.

   Run tools/csp.mjs afterwards - the inline script hash changes with every
   edit. Wire both as `npm run build` so it cannot be half-done.
*/
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');
const APP = path.join(SRC, 'app');
const OUT = path.join(ROOT, 'index.html');
const CSP_TAG = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function scriptParts() {
  if (!fs.existsSync(APP)) return [];
  return fs.readdirSync(APP).filter(name => name.endsWith('.js')).sort();
}

function assemble() {
  const parts = scriptParts();
  if (!parts.length) {
    console.error('No script parts found in ' + APP);
    process.exit(1);
  }
  const head = read(path.join(SRC, 'head.html'));
  const style = read(path.join(SRC, 'style.css'));
  const body = read(path.join(SRC, 'body.html'));
  const script = parts.map(name => read(path.join(APP, name))).join('\n');
  return {
    text: head + style + body + script + '</script>\n</body>\n</html>\n',
    count: parts.length + 3
  };
}

const built = assemble();

/* The CSP meta tag is rewritten in index.html after assembly, so it is the one
   thing that legitimately differs from the parts. */
const strip = text => text.replace(CSP_TAG, '');

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? read(OUT) : '';
  if (strip(current) !== strip(built.text)) {
    console.error('index.html is out of date. Run: npm run build');
    process.exit(1);
  }
  console.log('index.html matches the parts in src/.');
  process.exit(0);
}

const previous = fs.existsSync(OUT) ? read(OUT) : '';
const keep = CSP_TAG.exec(previous);
const output = keep ? built.text.replace(CSP_TAG, keep[0]) : built.text;

fs.writeFileSync(OUT, output);
const kb = (Buffer.byteLength(output, 'utf8') / 1024).toFixed(1);
console.log(`index.html written: ${kb} KB from ${built.count} parts.`);
