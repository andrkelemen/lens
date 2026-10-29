#!/usr/bin/env node
/*
  lens — terse views of your own data, for feeding an LLM without lying to it.

  THE RULE: never paraphrase, only project.

    * select and count — never rewrite, never summarise, no model in the path
    * every truncation is DECLARED: "showing 20 of 233", never a silent cut
    * every view prints the exact command for the full thing
    * deterministic: same input, same bytes, every time

  A view that hides its own incompleteness is the bug this exists to avoid. A view that
  says "here are 20 of 233, run this for all of them" costs forty bytes and lies about
  nothing. The alternative — a tool that summarises output before it reaches the model —
  puts a paraphrase between the reader and the truth and decides, on the reader's behalf,
  what mattered. That decision is exactly the one you cannot audit afterwards.

  THE NO-EATING CONTRACT. A capped view is only safe if the way back to the rest is real.
  The failure it prevents is specific and it is not the cap — it is the loop. A model reads
  an incomplete view, finds no working route to the remainder, runs the same command again
  expecting a fuller answer, gets the same thing, and fills the gap from its prior. The
  fabrication is the last step; the first is hope. So:

    * the exact bytes are TEED to disk before anything is counted or capped (0600, in
      $LENS_TEE, default ~/.cache/lens). The projection is never the only copy.
    * the cut states how many were withheld, and names the FILE — not a hash, not a
      subcommand to learn — plus `lens more <path>`, which is tested to reach the last line.
    * it says that re-running will not help.
    * an identical lens call inside 30 minutes announces itself BEFORE the output is read.
    * when nothing was cut, that is asserted out loud: "complete: 7 of 7. Nothing was cut."
      A short answer and a truncated one must not look alike.
    * `lens sec <file> <heading>` never caps. A section's whole job is the full text.

  SECRETS are redacted by default and the redaction is DECLARED, because a silent redaction
  is a silent cut and that is the thing this tool refuses.

  ON TRANSPARENT INTERCEPTORS — the other design, and why this is not it. Tools in this
  space often install shell hooks and rewrite `cat`, `grep` or `git` underneath the agent.
  Their compression work is good and some of their mechanisms are better than this file's
  first version was: teeing full output behind a handle, scrubbing credentials, asserting
  exact overflow counts in tests. All three are adopted here. What is deliberately not
  adopted is the interception: when the agent believes it ran `cat`, it attributes the
  projection to the real tool and reasons as though it had seen the file. lens is opt-in and
  named. Typing `lens sec` is itself the admission that this is a projection, and that
  admission is the feature. For the same reason there is no config file: a checked-out
  repository does not get to configure how you read it.

  usage:
    lens db "<sql>"               read-only SQL against $LENS_DB
    lens grep <pat> [path...]     match counts per file, then capped lines
    lens sec <file> [heading]     a markdown file's headings, or ONE section in full
    lens http <url>               status + top-level shape of a JSON response, not the body
    lens run <command…>           run it, project the output, tee the exact bytes
    lens more <file> [from] [n]   page the rest of a capped view — never re-run
*/
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { relative } from 'path';

const DB = process.env.LENS_DB || '';
const CAP = Number(process.env.LENS_CAP || 20);
const TEE_DIR = process.env.LENS_TEE || `${homedir()}/.cache/lens`;
const [cmd, ...rest] = process.argv.slice(2);

// EPIPE: `lens ... | head` closes stdout mid-write. On runtimes that surface that as an
// unhandled 'error' event it is a crash with a stack trace, in a tool whose entire purpose
// is to be piped. A closed reader is not an error; it is the reader having had enough.
// Defensive: Node 22 exits 0 on its own, so the smoke test asserts the OUTCOME (no stack
// trace) rather than pretending to exercise this line.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
const out = (s) => { try { process.stdout.write(s + '\n'); } catch (e) { if (e.code !== 'EPIPE') throw e; } };
let CUT = false;
const note = (shown, total, how, teePath) => {
  if (total > shown) {
    CUT = true;
    out(`\n… showing ${shown} of ${total} — ${total - shown} NOT shown.`);
    if (teePath) {
      out(`   all ${total}, exact bytes, already written: ${teePath}`);
      out(`   read the rest:  lens more ${teePath}`);
      out(`   re-running this lens call will print the same ${shown}. It is not a flake.`);
    }
    // The command for the whole thing is printed EITHER WAY. The first version of the tee
    // replaced it, which a test caught: for a deterministic source the command is still an
    // honest route, and removing a working route to add a better one is a net loss.
    out(`   full: ${how}`);
  } else {
    out(`\ncomplete: ${total} of ${total}. Nothing was cut.`);
  }
};

// ── TEE ─────────────────────────────────────────────────────────────────────
// The exact bytes, owner-only, so a capped view can point at the whole thing instead of
// promising that re-running the command produces the same answer. For a test run, a build
// or an HTTP call, it does not.
function tee(label, content) {
  try {
    mkdirSync(TEE_DIR, { recursive: true, mode: 0o700 });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `${TEE_DIR}/${ts}-${label.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40)}.txt`;
    // 0600 at creation, not chmod afterwards: a reader racing the chmod sees 0644.
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  } catch { return null; }   // a tee that fails must never take the view down with it
}

// ── REDACTION ───────────────────────────────────────────────────────────────
const SECRET_NAMES = [
  'GITHUB_TOKEN', 'GITHUB_PAT', 'GH_TOKEN', 'GITLAB_TOKEN', 'API_TOKEN', 'AUTH_TOKEN',
  'ACCESS_TOKEN', 'BEARER_TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PRIVATE_KEY',
  'API_KEY', 'APIKEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET', 'NPM_TOKEN', 'NUGET_API_KEY', 'CONNECTION_STRING', 'DATABASE_URL',
  'KUBECONFIG', 'DOCKER_CONFIG', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
];
const SECRET_PATTERNS = [
  [new RegExp(`\\b(${SECRET_NAMES.join('|')})(\\s*[=:]\\s*"?)([^\\s"',}]{6,})`, 'gi'), (m, n, sep) => `${n}${sep}[REDACTED]`],
  [/\b(Authorization\s*:\s*)(token|Bearer)\s+\S+/gi, (m, a, k) => `${a}${k} [REDACTED]`],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, () => '[REDACTED gh token]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, () => '[REDACTED sk key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => '[REDACTED aws key id]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, () => '[REDACTED private key]'],
];
let REDACTED = 0;
function redact(text) {
  if (process.env.LENS_NO_REDACT === '1' || typeof text !== 'string') return text;
  let t = text;
  for (const [re, fn] of SECRET_PATTERNS) t = t.replace(re, (...a) => { REDACTED++; return fn(...a); });
  return t;
}

// ── THE LOOP GUARD ──────────────────────────────────────────────────────────
// The loop begins with hope: the same call again, in the expectation of a fuller answer.
// So say up front that the expectation is unfounded. Best-effort — a guard that can break
// the tool is worse than no guard.
function loopGuard(key) {
  try {
    mkdirSync(`${TEE_DIR}/.calls`, { recursive: true, mode: 0o700 });
    const f = `${TEE_DIR}/.calls/${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`;
    let prev = null;
    if (existsSync(f)) { try { prev = JSON.parse(readFileSync(f, 'utf8')); } catch {} }
    const now = Date.now();
    if (prev && now - prev.at < 30 * 60 * 1000) {
      const mins = Math.round((now - prev.at) / 60000);
      out(`⟳ identical lens call ${mins === 0 ? 'under a minute' : mins + ' min'} ago. The output below is produced`);
      out(`  the same way, deterministically, from the same source. If it was incomplete then it is`);
      out(`  incomplete now — the remainder is NOT hiding behind another run.${prev.tee ? ` Last exact bytes: ${prev.tee}` : ''}`);
      out('');
    }
    return (teePath) => { try { writeFileSync(f, JSON.stringify({ at: now, key, tee: teePath || prev?.tee || null }), { mode: 0o600 }); } catch {} };
  } catch { return () => {}; }
}

async function db(sql) {
  if (!sql) return out('usage: lens db "<sql>"   (set LENS_DB to the sqlite file)');
  if (!DB) return out('LENS_DB is not set. export LENS_DB=/path/to/your.db');
  if (!existsSync(DB)) return out(`no such database: ${DB}`);
  let Database;
  try {
    // Loaded lazily and by name, so `grep`, `sec` and `http` work with no native module
    // installed at all. A hard dependency for one of four views is a tax on the other three.
    ({ default: Database } = await import('better-sqlite3'));
  } catch {
    return out('lens db needs better-sqlite3:  npm i better-sqlite3');
  }
  // Read-only connection, not a promise of good behaviour: the driver refuses writes.
  const d = new Database(DB, { readonly: true });
  try {
    const stmt = d.prepare(sql);
    // A statement that returns no result set (PRAGMA with no output, DDL) is reported,
    // not thrown: the driver refuses writes on this connection anyway.
    if (!stmt.reader) return out('(statement returns no rows — lens db is read-only and shows result sets only)');
    // `stmt.reader` is TRUE for statements the read-only connection still refuses to run —
    // `PRAGMA optimize` is one: it reads AND writes, so it claims a result set and then
    // throws "attempt to write a readonly database". The tool's own rule applies to its own
    // failures: report it, never hand the reader a stack trace. Found 2026-10-29 by a test
    // written for the backport; the public copy had the same hole, untested.
    let rows;
    try { rows = stmt.all(); }
    catch (e) { return out(`sqlite refused the statement: ${e.message}`); }
    if (!rows.length) return out('(0 rows)');
    const cols = Object.keys(rows[0]);
    const shown = rows.slice(0, CAP);
    const w = {};
    for (const c of cols) w[c] = Math.min(46, Math.max(c.length, ...shown.map(r => String(r[c] ?? '').replace(/\s+/g, ' ').length)));
    // Tee every row BEFORE capping, as TSV, so the capped table is never the only copy.
    const teePath = rows.length > shown.length
      ? tee('db', cols.join('\t') + '\n' + rows.map(r => cols.map(c => String(r[c] ?? '').replace(/\t/g, ' ')).join('\t')).join('\n'))
      : null;
    out(redact(cols.map(c => c.padEnd(w[c])).join('  ')));
    for (const r of shown) {
      out(redact(cols.map(c => {
        const v = String(r[c] ?? '').replace(/\s+/g, ' ');
        return (v.length > w[c] ? v.slice(0, w[c] - 1) + '…' : v).padEnd(w[c]);
      }).join('  ')));
    }
    note(shown.length, rows.length, `LENS_CAP=${rows.length} lens db "…"`, teePath);
    SAVE(teePath);
  } finally { d.close(); }
}

function grep(pat, paths) {
  if (!pat) return out('usage: lens grep <pattern> [path...]');
  const targets = paths.length ? paths : ['.'];
  let lines = [];
  try {
    // -H forces the filename prefix. Without it, grep omits the name when given a SINGLE
    // file, so the per-file counting below reads line NUMBERS as filenames and reports
    // "3 matches in 3 files: 2089, 2629, 2708". Found within an hour of shipping, by use.
    lines = execFileSync('grep', ['-rnIHE', '--exclude-dir=node_modules', '--exclude-dir=.git', pat, ...targets],
      { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return out('(no matches)');
    // Over the 64 MB buffer. The tool's own rule applies to its failures: say it, do not
    // throw a stack trace at a reader who only wanted counts.
    if (e.code === 'ENOBUFS') return out(`output over 64 MB for "${pat}" in ${targets.join(' ')} — narrow the path or the pattern`);
    throw e;
  }
  // grep prints `file:line:text`. The filename is everything before the LAST colon that
  // precedes the line number, not the first colon: on Windows the first colon is the drive
  // letter (`C:/repo/a.md:3:text`), and splitting there reported every file as "C" —
  // "47 matches in 1 files". Built on Linux, where a path never contains a colon, and found
  // by the smoke test the first time it ran on Windows. Anchor on the `:<digits>:` grep
  // always emits; a path with a colon elsewhere still parses.
  const split = (l) => {
    const m = /^((?:[A-Za-z]:)?[^:]*):(\d+):(.*)$/.exec(l);
    return m ? { f: m[1], n: m[2], t: m[3] } : { f: l, n: '', t: '' };
  };
  // Paths are shown relative to the working directory so the capped sample line carries the
  // match, not 120 characters of directory. Absolute inputs stay absolute when relative
  // would climb out of the tree.
  const show = (f) => { const r = relative(process.cwd(), f); return r && !r.startsWith('..') ? r : f; };
  // Count per file FIRST — the shape of the answer is where the matches live, which is
  // exactly what a capped list of lines destroys.
  const byFile = {};
  for (const l of lines) { const { f } = split(l); byFile[f] = (byFile[f] || 0) + 1; }
  const files = Object.entries(byFile).sort((a, b) => b[1] - a[1]);
  const teePath = (files.length > CAP || lines.length > CAP) ? tee(`grep-${pat}`, lines.join('\n')) : null;
  out(`${lines.length} matches in ${files.length} files`);
  for (const [f, n] of files.slice(0, CAP)) out(`  ${String(n).padStart(4)}  ${show(f)}`);
  note(Math.min(CAP, files.length), files.length, `grep -rnc "${pat}" ${targets.join(' ')}`, teePath);
  out('');
  for (const l of lines.slice(0, CAP)) {
    const { f, n, t } = split(l);
    out('  ' + redact(`${show(f)}:${n}:${t}`.replace(/\s+/g, ' ').slice(0, 160)));
  }
  note(Math.min(CAP, lines.length), lines.length, `grep -rn "${pat}" ${targets.join(' ')}`, teePath);
  SAVE(teePath);
}

function sec(file, heading) {
  if (!file || !existsSync(file)) return out(`usage: lens sec <file> [heading]   (no such file: ${file})`);
  // CRLF files (Windows checkouts) are read as if LF: the view's bytes must not depend on
  // which machine checked the file out.
  const src = readFileSync(file, 'utf8').split('\n').map(l => l.replace(/\r$/, ''));
  const heads = src.map((l, i) => ({ l, i })).filter(x => /^#{1,6}\s/.test(x.l));
  if (!heading) {
    out(`${file}: ${src.length} lines, ${heads.length} headings`);
    // The index is capped like every other view; a 900-heading file is not a terse view.
    for (const h of heads.slice(0, CAP)) out(`  ${String(h.i + 1).padStart(5)}  ${h.l.slice(0, 110)}`);
    note(Math.min(CAP, heads.length), heads.length, `LENS_CAP=${heads.length} lens sec ${file}`);
    return;
  }
  const needle = heading.toLowerCase();
  const start = heads.find(h => h.l.toLowerCase().includes(needle));
  if (!start) return out(`no heading matching "${heading}". run: lens sec ${file}`);
  const depth = (start.l.match(/^#+/) || ['#'])[0].length;
  const after = heads.find(h => h.i > start.i && (h.l.match(/^#+/) || ['#'])[0].length <= depth);
  const end = after ? after.i : src.length;
  out(`${file}:${start.i + 1}-${end}  (${end - start.i} lines of ${src.length})`);
  // A section prints WHOLE — no cap, ever. This is the one view whose job is the full text,
  // and capping it is precisely how a reader ends up inventing the rest.
  out(redact(src.slice(start.i, end).join('\n')));
  out(`\ncomplete: section printed in full (${end - start.i} lines). rest of file: lens sec ${file}`);
}

// Page the remainder. The loop-breaker: the rest of a capped view is retrievable in slices,
// so there is never a reason to re-run whatever produced it.
function more(file, from, count) {
  if (!file || !existsSync(file)) return out(`usage: lens more <file> [fromLine] [count]   (no such file: ${file})`);
  const lines = readFileSync(file, 'utf8').split('\n').map(l => l.replace(/\r$/, ''));
  const start = Math.max(1, Number(from || 1));
  const n = Number(count || CAP * 5);
  out(`${file}  lines ${start}-${Math.min(start + n - 1, lines.length)} of ${lines.length}`);
  for (const l of lines.slice(start - 1, start - 1 + n)) out(redact(l));
  if (start - 1 + n < lines.length) {
    out(`\n… ${lines.length - (start - 1 + n)} lines further on.`);
    out(`   next:  lens more ${file} ${start + n}`);
  } else {
    out('\ncomplete: reached the end of the file.');
  }
}

// Run a command and PROJECT its output. The exact combined bytes are teed FIRST, before
// anything is counted or capped, so the projection can never be the only copy. stderr is
// never hidden and the exit code is never implied by a summary: "failures only, passing
// collapsed to a count" is how you end up unable to answer a question about a test that
// passed.
function run(parts) {
  if (!parts.length) return out('usage: lens run <command…>');
  const command = parts.join(' ');
  // spawnSync, NOT execFileSync. execFileSync returns stdout and DISCARDS stderr when the
  // command succeeds — it hands you both only on the throw path. A command exiting 0 while
  // writing warnings to stderr lost them silently, in the function whose whole job is not
  // to eat output. The test caught it within a minute of being written.
  const res = spawnSync(process.platform === 'win32' ? process.env.COMSPEC || 'cmd' : 'sh',
    process.platform === 'win32' ? ['/c', command] : ['-c', command],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  const code = res.error ? 1 : (typeof res.status === 'number' ? res.status : 1);
  if (res.error) out(`lens run: ${res.error.message}`);
  const combined = stdout + (stderr ? (stdout ? '\n' : '') + stderr : '');
  const teePath = tee(`run-${parts[0]}`, combined);
  const sLines = stdout ? stdout.replace(/\n$/, '').split('\n') : [];
  const eLines = stderr ? stderr.replace(/\n$/, '').split('\n') : [];

  out(`$ ${command}`);
  out(`exit ${code}  ·  stdout ${sLines.length} lines  ·  stderr ${eLines.length} lines  ·  ${combined.length}B`);

  // Tallies are computed over the WHOLE output, before any capping. A count that only
  // counts the shown part is worse than no count.
  const all = combined.split('\n');
  const hits = (re) => all.filter(l => re.test(l)).length;
  const tally = [['error', hits(/\berror\b/i)], ['warning', hits(/\bwarn(ing)?\b/i)],
                 ['fail', hits(/\bfail(ed|ure)?\b/i)], ['fatal', hits(/\b(fatal|panic)\b/i)]]
    .filter(([, n]) => n > 0);
  if (tally.length) out('matched: ' + tally.map(([k, n]) => `${n} ${k}`).join(' · '));

  // stderr first: if something went wrong, that is the answer.
  if (eLines.length) {
    out('\n--- stderr ---');
    for (const l of eLines.slice(0, CAP)) out(redact(l));
    note(Math.min(CAP, eLines.length), eLines.length, `${command} 2>&1 1>/dev/null`, teePath);
  }
  if (sLines.length) {
    out('\n--- stdout ---');
    for (const l of sLines.slice(0, CAP)) out(redact(l));
    note(Math.min(CAP, sLines.length), sLines.length, command, teePath);
  }
  if (!sLines.length && !eLines.length) out('(no output)');
  if (teePath && !CUT) out(`exact bytes: ${teePath}`);
  SAVE(teePath);
  process.exitCode = code;   // the caller's own check must still be able to go red
}

async function http(url) {
  if (!url) return out('usage: lens http <url>');
  const t = Date.now();
  let r;
  try { r = await fetch(url); } catch (e) { return out(`UNREACHABLE ${url} — ${e.message}`); }
  const ms = Date.now() - t;
  const body = await r.text();
  out(`HTTP ${r.status} ${url}  ${ms}ms  ${body.length}B`);
  try {
    const j = JSON.parse(body);
    const shape = (v) => Array.isArray(v) ? `array[${v.length}]` : (v === null ? 'null' : typeof v);
    // The first element's keys describe the array only when it IS an object; `[null, 1]`
    // used to throw inside this try and come out as "(not JSON)", which is a lie.
    const first = j[0];
    const firstDesc = first && typeof first === 'object' && !Array.isArray(first)
      ? `, keys: ${Object.keys(first).join(', ')}` : (j.length ? `, first: ${shape(first)}` : '');
    if (Array.isArray(j)) out(`array[${j.length}]${firstDesc}`);
    else for (const [k, v] of Object.entries(j).slice(0, 40)) out(`  ${k}: ${shape(v)}`);
    out(`\nfull: curl -s ${url}`);
  } catch { out('  (not JSON)\n  ' + body.slice(0, 200).replace(/\s+/g, ' ')); }
}

const SAVE = loopGuard([cmd, ...rest].join(' '));

switch (cmd) {
  case 'db': await db(rest.join(' ')); break;
  case 'grep': grep(rest[0], rest.slice(1)); break;
  case 'sec': sec(rest[0], rest.slice(1).join(' ')); break;
  case 'http': await http(rest[0]); break;
  case 'more': more(rest[0], rest[1], rest[2]); break;
  case 'run': run(rest); break;
  default:
    out('lens — terse views that never paraphrase. LENS_CAP=n to widen (default 20).');
    out('  lens db "<sql>"            read-only SQL against $LENS_DB');
    out('  lens grep <pat> [path...]  match counts per file, then capped lines');
    out('  lens sec <file> [heading]  headings index, or one section in full');
    out('  lens http <url>            status + JSON shape, never the body');
    out('  lens run <command…>        run it, project the output, tee the exact bytes');
    out('  lens more <file> [from] [n]  page the rest of a capped view — never re-run');
}

// A silent redaction is a silent truncation, which is the thing this tool exists to refuse.
if (REDACTED > 0) {
  out(`\n⚠ ${REDACTED} secret-shaped value${REDACTED === 1 ? '' : 's'} redacted from the output above.`);
  out('  The characters were replaced, nothing else was dropped. LENS_NO_REDACT=1 to see them.');
}
