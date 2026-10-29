# lens

Terse views of your own data, for feeding a model without lying to it.

**Never paraphrase. Only project.**

```
lens db "<sql>"               read-only SQL against $LENS_DB
lens grep <pat> [path...]     match counts per file, then capped lines
lens sec <file> [heading]     a markdown file's headings, or ONE section in full
lens http <url>               status + top-level shape of a JSON response, not the body
```

## Why

The common fix for "my tool output blew up the context window" is a wrapper that
*summarises* the output before the model sees it. That puts a paraphrase between the
reader and the truth, and it decides on the reader's behalf what mattered. When it drops
the one row you needed, nothing reports an error — the answer just quietly becomes wrong,
and you cannot audit it afterwards, because the evidence is the thing that got dropped.

lens does the other thing. It **selects and counts**. It never rewrites, never summarises,
and has no model anywhere in the path. When it shows you less than everything, it says so
on the line below and prints the exact command for the rest:

```
… showing 20 of 233. full: grep -rn "handler" src/
```

A view that hides its own incompleteness is the bug. A view that admits it costs forty
bytes and lies about nothing.

## Install

```bash
git clone https://github.com/andrkelemen/lens.git
cd lens
npm install          # optional — only `lens db` needs the native sqlite module
npm link             # puts `lens` on PATH on every platform (a symlink on Unix, a shim on Windows)
```

Node 18+. `lens grep` spawns `grep`, so it must be on PATH: on Windows that means running
from Git Bash or adding `C:\Program Files\Git\usr\bin` to PATH. `grep`, `sec` and `http` have **zero dependencies** and work without `npm install`
at all; `lens db` loads `better-sqlite3` lazily and tells you how to install it if it is
missing. One of four views should not tax the other three.

## The four views

### `lens db "<sql>"`

Read-only SQL against the database at `$LENS_DB`, printed as aligned columns with the row
count declared. The connection is opened `readonly`, so the driver refuses writes — that
is the driver's guarantee, not a promise from this script.

```bash
export LENS_DB=~/app/data.db
lens db "select status, count(*) n from jobs group by status"
```

Most real questions are a three-line aggregate. A general-purpose "fetch the records" tool
answers the same question with tens of kilobytes of rows you then have to count by eye.

### `lens grep <pattern> [path...]`

**Counts per file first, then a capped sample of lines.** Ordinary `grep -rn` prints
everything, but the first thing you usually want is not the matches — it is *where the
matches live*, which is exactly what a truncated list of lines destroys.

```
47 matches in 6 files
    21  src/router.mjs
    11  src/handlers/user.mjs
     ...
```

Excludes `node_modules` and `.git`. Binary files are skipped.

### `lens sec <file> [heading]`

With no heading: the file's headings with line numbers. With one: that section in full and
nothing else, with the line range stated.

```bash
lens sec ARCHITECTURE.md                 # 940 lines, 50 headings
lens sec ARCHITECTURE.md "Error handling"  # 31 of them
```

Matching is case-insensitive substring. The section ends at the next heading of the same
depth or shallower, so asking for an `##` gives you its `###` children too.

### `lens http <url>`

Status, latency, size, and the **shape** of a JSON response — not the body.

```
HTTP 200 http://localhost:3000/api/status  12ms  394B
  ok: boolean
  printers: array[2]
  updated: string
```

`printers: array[2]` is usually the whole answer. The 394 bytes are not.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `LENS_DB` | *(unset)* | sqlite file for `lens db` |
| `LENS_CAP` | `20` | rows / files / lines shown before truncation is declared |

`LENS_CAP` widens any cap, including to the full count that `lens` just told you about:

```bash
LENS_CAP=233 lens grep handler src/
```

## What it does not do

- **No writes.** `lens db` opens the file read-only and there is no second mode.
- **No summarising, ever.** If you want a paraphrase, that is a job for the model reading
  the output, which can then be checked against the original. This tool refuses to be the
  thing that decided before you got there.
- **No shell-injection laundering.** `lens grep` passes its pattern to `grep` as an
  argument vector, not through a shell, but `lens db` runs the SQL you give it. Do not
  hand it a string you built out of someone else's input.
- **No network beyond the one URL you ask for**, and no telemetry.

## Tests

```bash
npm test
```

The smoke test asserts the behaviour that matters — that truncation is declared, that a
missing database is reported rather than swallowed, that an unreachable URL is reported
rather than thrown, and that `grep` counts files and not line numbers.

Each case has been proven to fail against a deliberately broken build before being
trusted green; a check that cannot go red proves nothing. Where a behaviour could not be
made to fail on the current runtime, the test says so in a comment instead of claiming
coverage it does not have.

## License

MIT

## The no-eating contract

A capped view is only safe if the way back to the rest is real. The failure this prevents is
not the cap — it is the loop:

> an incomplete view → no working route to the remainder → the same command run again in the
> hope of a fuller answer → the same incomplete thing → the gap filled from the model's prior.

The fabrication is the last step. The first is hope. So every capped view:

1. **tees the exact bytes to disk first**, before anything is counted or capped — mode `0600`,
   in `$LENS_TEE` (default `~/.cache/lens`). The projection is never the only copy.
2. **names that file**, not a hash and not a subcommand to learn, and hands over
   `lens more <path>` — which is tested to reach the last line.
3. **still prints the command** for the whole thing, so a deterministic source has two routes.
4. **says re-running will not help**: *"It is not a flake."*
5. **announces an identical lens call** made in the last 30 minutes, before the output is read.
6. **asserts completeness when nothing was cut** — `complete: 7 of 7. Nothing was cut.` A short
   answer and a truncated one must not look alike.

`lens sec <file> <heading>` never caps. A section's whole job is the full text, and capping it
is exactly how a reader ends up inventing the rest.

## Secrets

Redaction is on by default, and **declared**: `⚠ 2 secret-shaped values redacted`. Token shapes
(`ghp_…`, `sk-…`, `AKIA…`, PEM headers) and credential-named assignments (`GITHUB_TOKEN=`,
`DATABASE_URL=`, `AWS_SECRET_ACCESS_KEY=`, `Authorization: Bearer …`) are replaced in place.
Nothing else is dropped. `LENS_NO_REDACT=1` to see them.

A silent redaction is a silent cut, which is the thing this tool exists to refuse.

## `lens run`

```
lens run "npm test"
```

Runs it, tees the exact combined bytes, then projects: exit code, line counts, an
error/warning tally computed over the **whole** output, **stderr first and whole**, stdout
capped with the path to the rest. The real exit code propagates, so your own check can still
go red.

It does not do "failures only, passing collapsed to a count". That shape reads well and then
cannot answer a question about a test that passed.

## On transparent interceptors

The other design in this space installs shell hooks and rewrites `cat`, `grep` or `git`
underneath the agent. Those tools do good compression work, and three of their mechanisms were
better than this file's first version: teeing full output behind a handle, scrubbing
credentials, and asserting exact overflow counts in tests. All three are adopted here.

The interception is not. When the agent believes it ran `cat`, it attributes the projection to
the real tool and reasons as though it had seen the file. lens is opt-in and named: typing
`lens sec` is itself the admission that this is a projection, and that admission is the point.

For the same reason there is no config file. A checked-out repository does not get to
configure how you read it.
