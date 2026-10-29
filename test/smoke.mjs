#!/usr/bin/env node
// Smoke test for lens. Each case asserts a behaviour that has actually broken before,
// not merely that the program exits 0. Break any one line of bin/lens.mjs that these
// cover and this goes red — which is the only reason to trust it when it goes green.
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const LENS = join(here, '..', 'bin', 'lens.mjs');
const FIXTURE = join(here, 'fixtures', 'sample.md');
const FIXTURE_ABS = resolve(FIXTURE);

let failed = 0;
// Every run is pointed at a throwaway tee store. Without this the loop guard and the tee
// files land in the developer's real ~/.cache/lens, which both pollutes their machine and
// makes the suite's own repeated calls trip the guard — a test that contaminates the thing
// it measures.
const SANDBOX = mkdtempSync(join(tmpdir(), 'lens-sandbox-'));
const run = (args, env = {}) => {
  try {
    return execFileSync('node', [LENS, ...args], { encoding: 'utf8', env: { ...process.env, LENS_TEE: SANDBOX, ...env } });
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

// grep — a path that actually CONTAINS a drive-letter colon. The absolute-path check
// below cannot go red on Linux, because a Linux absolute path has no colon in it: run on
// this platform it asserts nothing about the bug it was written for. So build the shape
// directly, in a temp directory, from a filename that begins `C:` — which is what grep
// prints on Windows and what the old first-colon split turned into a file called "C".
//
// The fixture is created at runtime rather than committed: a colon is legal in a POSIX
// filename and illegal in a Windows one, so committing it would break the checkout on the
// platform the bug belongs to. Skipped there, where the real path form occurs anyway.
if (process.platform !== 'win32') {
  const tmp = mkdtempSync(join(tmpdir(), 'lens-drive-'));
  const drive = join(tmp, 'C:sample.md');
  writeFileSync(drive, 'one needle\ntwo needle\n');
  const o2 = execFileSync('node', [LENS, 'grep', 'needle', 'C:sample.md'], { encoding: 'utf8', cwd: tmp });
  check('grep keeps a drive-letter path whole, not just "C"', /2 matches in 1 files/.test(o2) && /C:sample\.md/.test(o2), o2);
  check('grep does not report the drive as the file', !/^\s+\d+\s+C$/m.test(o2), o2);
  rmSync(tmp, { recursive: true, force: true });
}

// grep — an ABSOLUTE path. On Windows it carries a drive colon; on Linux this is just a
// plain absolute path, so it guards the parse without exercising the drive case above.
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

// ── THE NO-EATING CONTRACT ────────────────────────────────────────────────
// Each of these is a specific way a projecting tool lies to its reader. The one they
// exist for: a capped view, no working route to the rest, so the reader runs it again,
// gets the same thing, and invents the remainder.
const TEE = mkdtempSync(join(tmpdir(), 'lens-tee-'));
const E = { LENS_TEE: TEE };
const BIG = join(TEE, 'big.txt');
writeFileSync(BIG, Array.from({ length: 50 }, (_, i) => `needle line ${i}`).join('\n') + '\n');
const SMALL = join(TEE, 'small.txt');
writeFileSync(SMALL, 'alpha\nbeta\nalpha\n');

// A view that cut nothing must SAY it cut nothing — otherwise a short answer and a
// truncated one are indistinguishable, which is how a reader stops checking.
o = run(['grep', 'alpha', SMALL], E);
check('completeness is asserted out loud', /complete: \d+ of \d+\. Nothing was cut\./.test(o), o);

o = run(['grep', 'needle', BIG], { ...E, LENS_CAP: '5' });
check('a cut states how many were withheld', /NOT shown/.test(o), o);
check('a cut names the tee file', /exact bytes, already written: \S+/.test(o), o);
check('a cut hands over a working route', /lens more \S+/.test(o), o);
check('a cut says re-running will not help', /It is not a flake\./.test(o), o);

const teePath = (o.match(/already written: (\S+)/) || [])[1];
check('the tee file is owner-only', teePath && (statSync(teePath).mode & 0o777) === 0o600,
  teePath ? '0' + (statSync(teePath).mode & 0o777).toString(8) : 'no tee path');
check('the tee holds EVERY line, not the capped set',
  teePath && readFileSync(teePath, 'utf8').split('\n').filter(Boolean).length === 50, teePath);

// The promised route must actually reach the end. A route that stops short is the
// original bug with extra steps.
o = run(['more', teePath, '1', '9999'], E);
check('lens more reaches the last line', /needle line 49/.test(o) && /complete: reached the end/.test(o), o);
o = run(['more', teePath, '1', '10'], E);
check('a page that is not the last points at the next', /next:  lens more \S+ 11/.test(o), o);

// Secrets must never reach the reader's context, and the redaction must be announced:
// a silent redaction is a silent cut.
const ENVF = join(TEE, 'env.txt');
writeFileSync(ENVF, 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\nGITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n');
o = run(['grep', 'KEY|TOKEN', ENVF], E);
check('secret values are redacted', !o.includes('abcdefghijklmnopqrstuvwxyz123456') && !o.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), o);
check('the redaction is declared', /secret-shaped value/.test(o), o);
o = run(['grep', 'KEY', ENVF], { ...E, LENS_NO_REDACT: '1' });
check('LENS_NO_REDACT=1 is the escape hatch', o.includes('abcdefghijklmnopqrstuvwxyz123456'), o);

// lens run must not swallow anything. The stderr case is here because the first
// implementation used execFileSync, which discards stderr when the command exits 0.
o = run(['run', 'echo out-line; echo err-line >&2'], E);
check('lens run shows stderr even on success', /err-line/.test(o), o);
check('lens run puts stderr before stdout', o.indexOf('--- stderr ---') < o.indexOf('--- stdout ---'), o);
const rt = (o.match(/exact bytes: (\S+)/) || [])[1];
check('lens run tees stdout AND stderr',
  rt && readFileSync(rt, 'utf8').includes('out-line') && readFileSync(rt, 'utf8').includes('err-line'), rt);

o = run(['run', 'for i in $(seq 1 30); do echo "error number $i"; done'], { ...E, LENS_CAP: '3' });
check('tallies are computed before capping', /30 error/.test(o) && /27 NOT shown/.test(o), o);

// A section is the one view whose job is the whole text.
o = run(['sec', FIXTURE, 'Alpha'], { ...E, LENS_CAP: '2' });
check('lens sec never caps a section', /complete: section printed in full/.test(o), o);

// The loop guard. Hope is the first step; say it is unfounded.
run(['grep', 'beta', SMALL], E);
o = run(['grep', 'beta', SMALL], E);
check('an identical call announces itself', /identical lens call/.test(o) && /NOT hiding behind another run/.test(o), o);
o = run(['grep', 'zeta-unused-pattern', SMALL], E);
check('a different call does not trip the guard', !/identical lens call/.test(o), o);

rmSync(TEE, { recursive: true, force: true });
rmSync(SANDBOX, { recursive: true, force: true });

// No arguments prints the usage rather than failing.
o = run([]);
check('bare lens prints usage', /never paraphrase/.test(o), o);

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
