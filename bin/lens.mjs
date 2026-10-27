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

  usage:
    lens db "<sql>"               read-only SQL against $LENS_DB
    lens grep <pat> [path...]     match counts per file, then capped lines
    lens sec <file> [heading]     a markdown file's headings, or ONE section in full
    lens http <url>               status + top-level shape of a JSON response, not the body
*/
import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

const DB = process.env.LENS_DB || '';
const CAP = Number(process.env.LENS_CAP || 20);
const [cmd, ...rest] = process.argv.slice(2);

// EPIPE: `lens ... | head` closes stdout mid-write. On runtimes that surface that as an
// unhandled 'error' event it is a crash with a stack trace, in a tool whose entire purpose
// is to be piped. A closed reader is not an error; it is the reader having had enough.
// Defensive: Node 22 exits 0 on its own, so the smoke test asserts the OUTCOME (no stack
// trace) rather than pretending to exercise this line.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
const out = (s) => { try { process.stdout.write(s + '\n'); } catch (e) { if (e.code !== 'EPIPE') throw e; } };
const note = (shown, total, how) => {
  if (total > shown) out(`\n… showing ${shown} of ${total}. full: ${how}`);
};

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
    const rows = d.prepare(sql).all();
    if (!rows.length) return out('(0 rows)');
    const cols = Object.keys(rows[0]);
    const shown = rows.slice(0, CAP);
    const w = {};
    for (const c of cols) w[c] = Math.min(46, Math.max(c.length, ...shown.map(r => String(r[c] ?? '').replace(/\s+/g, ' ').length)));
    out(cols.map(c => c.padEnd(w[c])).join('  '));
    for (const r of shown) {
      out(cols.map(c => {
        const v = String(r[c] ?? '').replace(/\s+/g, ' ');
        return (v.length > w[c] ? v.slice(0, w[c] - 1) + '…' : v).padEnd(w[c]);
      }).join('  '));
    }
    note(shown.length, rows.length, `LENS_CAP=${rows.length} lens db "…"`);
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
    throw e;
  }
  // Count per file FIRST — the shape of the answer is where the matches live, which is
  // exactly what a capped list of lines destroys.
  const byFile = {};
  for (const l of lines) { const f = l.slice(0, l.indexOf(':')); byFile[f] = (byFile[f] || 0) + 1; }
  const files = Object.entries(byFile).sort((a, b) => b[1] - a[1]);
  out(`${lines.length} matches in ${files.length} files`);
  for (const [f, n] of files.slice(0, CAP)) out(`  ${String(n).padStart(4)}  ${f}`);
  note(Math.min(CAP, files.length), files.length, `grep -rnc "${pat}" ${targets.join(' ')}`);
  out('');
  for (const l of lines.slice(0, CAP)) out('  ' + l.replace(/\s+/g, ' ').slice(0, 160));
  note(Math.min(CAP, lines.length), lines.length, `grep -rn "${pat}" ${targets.join(' ')}`);
}

function sec(file, heading) {
  if (!file || !existsSync(file)) return out(`usage: lens sec <file> [heading]   (no such file: ${file})`);
  const src = readFileSync(file, 'utf8').split('\n');
  const heads = src.map((l, i) => ({ l, i })).filter(x => /^#{1,6}\s/.test(x.l));
  if (!heading) {
    out(`${file}: ${src.length} lines, ${heads.length} headings`);
    for (const h of heads) out(`  ${String(h.i + 1).padStart(5)}  ${h.l.slice(0, 110)}`);
    note(heads.length, heads.length, `cat ${file}`);
    return;
  }
  const needle = heading.toLowerCase();
  const start = heads.find(h => h.l.toLowerCase().includes(needle));
  if (!start) return out(`no heading matching "${heading}". run: lens sec ${file}`);
  const depth = (start.l.match(/^#+/) || ['#'])[0].length;
  const after = heads.find(h => h.i > start.i && (h.l.match(/^#+/) || ['#'])[0].length <= depth);
  const end = after ? after.i : src.length;
  out(`${file}:${start.i + 1}-${end}  (${end - start.i} lines of ${src.length})`);
  out(src.slice(start.i, end).join('\n'));
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
    if (Array.isArray(j)) out(`array[${j.length}]` + (j.length ? `, keys: ${Object.keys(j[0]).join(', ')}` : ''));
    else for (const [k, v] of Object.entries(j).slice(0, 40)) out(`  ${k}: ${shape(v)}`);
    out(`\nfull: curl -s ${url}`);
  } catch { out('  (not JSON)\n  ' + body.slice(0, 200).replace(/\s+/g, ' ')); }
}

switch (cmd) {
  case 'db': await db(rest.join(' ')); break;
  case 'grep': grep(rest[0], rest.slice(1)); break;
  case 'sec': sec(rest[0], rest.slice(1).join(' ')); break;
  case 'http': await http(rest[0]); break;
  default:
    out('lens — terse views that never paraphrase. LENS_CAP=n to widen (default 20).');
    out('  lens db "<sql>"            read-only SQL against $LENS_DB');
    out('  lens grep <pat> [path...]  match counts per file, then capped lines');
    out('  lens sec <file> [heading]  headings index, or one section in full');
    out('  lens http <url>            status + JSON shape, never the body');
}
