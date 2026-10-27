#!/usr/bin/env node
// Smoke test for lens. Each case asserts a behaviour that has actually broken before,
// not merely that the program exits 0. Break any one line of bin/lens.mjs that these
// cover and this goes red — which is the only reason to trust it when it goes green.
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const LENS = join(here, '..', 'bin', 'lens.mjs');
const FIXTURE = join(here, 'fixtures', 'sample.md');
const FIXTURE_ABS = resolve(FIXTURE);

let failed = 0;
const run = (args, env = {}) => {
  try {
    return execFileSync('node', [LENS, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
};
const check = (name, cond, got) => {
  if (cond) return console.log(`  ok    ${name}`);
  failed++;
  console.log(`  FAIL  ${name}\n        got: ${JSON.stringify(String(got).slice(0, 300))}`);
};

// db — an unset or wrong database is REPORTED, never silently empty.
let o = run(['db', 'select 1'], { LENS_DB: '' });
check('db without LENS_DB says so', /LENS_DB is not set/.test(o), o);

o = run(['db', 'select 1'], { LENS_DB: '/nonexistent/nope.db' });
check('db with a missing file says so', /no such database/.test(o), o);

// grep — counts FILES, not line numbers. With a single file argument, grep omits the
// filename prefix unless -H is passed, and the per-file tally then reads the line
// numbers as filenames and reports "3 matches in 3 files".
o = run(['grep', 'needle', FIXTURE]);
check('grep counts 3 matches', /^3 matches in /m.test(o), o);
check('grep counts 1 file, not 3', /3 matches in 1 files/.test(o), o);
check('grep names the file', o.includes('sample.md'), o);

// grep — an ABSOLUTE path. On Windows it carries a drive colon (`C:/...`), and splitting
// the grep line at the first colon reported every file as "C". On Linux this is the same
// check with a plain absolute path, so it can only go red where the bug lives.
o = run(['grep', 'needle', FIXTURE_ABS]);
check('grep with an absolute path counts 1 file', /3 matches in 1 files/.test(o), o);
check('grep with an absolute path names the file, not the drive', /^\s+3\s+\S*sample\.md$/m.test(o), o);
check('grep sample lines carry the match text', /sample\.md:\d+:.*needle/.test(o), o);

// Every truncation declares itself, and prints the command for the rest.
o = run(['grep', 'needle', FIXTURE], { LENS_CAP: '1' });
check('grep declares its truncation', /showing 1 of 3/.test(o), o);
check('truncation prints the full command', /full: grep -rn/.test(o), o);

// sec — headings index, then one section bounded by the next heading of equal depth.
o = run(['sec', FIXTURE]);
check('sec lists every heading', (o.match(/^\s+\d+\s+#/gm) || []).length === 4, o);

o = run(['sec', FIXTURE, 'Alpha']);
check('sec declares the line range', /sample\.md:5-12\s+\(8 lines of \d+\)/.test(o), o);
check('sec includes the nested child', o.includes('### Alpha child'), o);
check('sec stops at the next sibling', !o.includes('## Beta'), o);

o = run(['sec', FIXTURE, 'nosuchheading']);
check('sec reports a missing heading', /no heading matching/.test(o), o);

// The headings index is capped and DECLARES it, like every other view.
o = run(['sec', FIXTURE], { LENS_CAP: '2' });
check('sec caps the headings index and says so', /showing 2 of 4/.test(o), o);

// http — JSON shape, with no server: Node 18+ fetches data: URLs. An array whose first
// element is null used to throw inside the parse and come out as "(not JSON)".
o = run(['http', 'data:application/json,{"ok":true,"items":[1,2],"meta":null}']);
check('http prints the top-level shape', /ok: boolean/.test(o) && /items: array\[2\]/.test(o) && /meta: null/.test(o), o);
o = run(['http', 'data:application/json,[null,1]']);
check('http array with a null first element is still JSON', /array\[2\], first: null/.test(o) && !/not JSON/.test(o), o);

// http — an unreachable host is REPORTED, not thrown. Nothing about a health check
// should be able to take down the thing running the health check.
o = run(['http', 'http://127.0.0.1:1/nope']);
check('http reports unreachable', /^UNREACHABLE /.test(o), o);

// Piping. Node 22 exits 0 on a closed stdout by itself, so this asserts the outcome
// rather than claiming to exercise the EPIPE guard in bin/lens.mjs — on this runtime
// that guard cannot be made to fire, and a check that cannot go red proves nothing.
let piped = '';
try {
  piped = execFileSync('bash', ['-c', `node ${LENS} sec ${FIXTURE} 2>&1 | head -1`], { encoding: 'utf8' });
} catch (e) { piped = (e.stdout || '') + (e.stderr || ''); }
check('piping to head prints no stack trace', !/Error|at Object/.test(piped), piped);

// No arguments prints the usage rather than failing.
o = run([]);
check('bare lens prints usage', /never paraphrase/.test(o), o);

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
