# zeke

A terminal coding agent built for **GLM-Free-API**.

zeke takes the harness design proven by [oh-my-pi](https://github.com/oh-my-pi/oh-my-pi) — an
agent loop, real file tools, session history, approvals — and rebuilds it as a lean,
standalone CLI whose brain is a self-hosted GLM bridge. No bun, no Rust, no ~150 MB of native
builds. **Node 20+ and nothing else.**

```
zeke setup          # build the bridge, configure tokens, verify
zeke                # start a session in this directory
zeke -p "why is this test failing?"
```

---

## Why this exists

GLM-Free-API turns a chat.z.ai session into an OpenAI-compatible endpoint. That gives you
GLM-4.7 / GLM-5.x for coding, but the hosted demo instance is unreliable, and the bridge only
exposes tool calling when **agent mode** is on — otherwise it silently ignores your `tools`
array and you get prose where you expected a file edit.

zeke assumes you run the bridge yourself, with your own tokens, and it manages that bridge for
you: building it, starting it with the right flags, harvesting device tokens, hot-swapping them
without a restart, and diagnosing the whole chain when something is off. After `zeke setup` it
also **maintains itself** — see [The keeper](#the-keeper) below: the bridge is started on demand,
restarted when it dies, and the token pool is topped up before it runs dry.

One thing about that chain is easy to miss, and zeke goes out of its way to say it loudly: the
bridge signs **every** request with an Aliyun `captcha_verify_param`, and each captcha spends one
harvested device token. A `ZAI_TOKEN` JWT does *not* remove that requirement — it only decides
which identity and which models the session gets. An empty device-token pool therefore means
nothing completes at all, with the bridge still reporting itself `healthy`.

---

## Install

```sh
git clone <this repo> && cd zeke
node bin/zeke.mjs setup   # no install step: zeke is the checkout
npm link                  # optional, so plain `zeke setup` works anywhere
```

If `zeke` on your `PATH` is something else (a Python package, another tool), the
shell reports that instead — run `node bin/zeke.mjs …` from the checkout, or link
it with `npm link`.

`zeke setup` does six things and tells you what it is doing at each step:

1. checks Node ≥ 20.11
2. vendors the GLM-Free-API source into `vendor/glm-free-api/` (from the committed zip)
3. builds `zai-api` into `$ZEKE_HOME/bin` with the Go toolchain on your `PATH` (or one you
   dropped in `$ZEKE_HOME/go`) — no Go means a clear error and a `bridge.binary` escape hatch
4. configures credentials — the bridge `AUTH_TOKEN`, an optional `ZAI_TOKEN` JWT, and a check
   for the device-token pool every request needs
5. starts the bridge with agent mode on
6. verifies end to end: `/health`, a real completion, then a tool call

Nothing in that chain is hidden. If a step fails, the message says which one and what to run —
and a completion that fails because the device-token pool is empty says exactly that, rather than
pointing at agent mode or the model.

**Runtime dependencies: zero.** `package.json` has an empty `dependencies` block. Tests use
`node:test`.

---

## Tokens

The hosted site does not work, so zeke is built around tokens you control. There are two kinds,
and they are not interchangeable — one is required, the other is an upgrade:

**Harvested device tokens — required.** The bridge mints an Aliyun `captcha_verify_param` for
every completion, and each captcha consumes one device token from the pool. Nothing completes
while that pool is empty, whatever else is configured: zeke's own probe on a fresh install
reports `healthy, no device tokens but completion failed — server_error: captcha generation
returned empty payload`. The collector drives real browsers to mint tokens into a SQLite pool:

```sh
zeke tokens collect              # build the collector if needed, harvest, hot-swap
zeke tokens status               # how many are left
zeke tokens swap ./tokens.sqlite # hot-swap a pool you harvested elsewhere
```

You rarely need any of that by hand: after setup, [the keeper](#the-keeper) harvests on its own
whenever the pool drops below `bridge.minTokens`. Manual `collect` remains for the moments you
want a batch right now (it and the keeper share a lock, so they never run on top of each other).

`collect` builds `token-collector` from the vendored source on demand, runs it from `$ZEKE_HOME`
(the collector writes `./tokens.sqlite` into its working directory — there is no `--db-path` flag
upstream), and hot-swaps the result in. The collector downloads its own Playwright driver and
Chromium on first run (~150 MB, needs network); on Linux the browser also needs system libraries,
which `npx playwright install-deps chromium` installs. Tokens are consumed FIFO and deleted after
use, so a busy session drains the pool and refills it the same way. Hot-swap posts to the bridge's
`/sqlite` endpoint, so a drained pool can be refilled mid-session without losing context.

`zeke tokens collect --dry-run` prints what harvesting needs before anything runs — including whether
`chat.z.ai` resolves, the one prerequisite that is not local.

**A personal JWT — optional, recommended.** `chat.z.ai` → DevTools → Local Storage → key
`token`:

```sh
zeke setup --token <jwt>          # or later: zeke tokens token <jwt>
```

A JWT unlocks every model, including the vision models. Without one you are a guest, and guests
get only `glm-5.3-flash` and `glm-4.7`. It does **not** replace the device-token pool: the
captcha is minted per request either way, so zeke defaults to `glm-4.7` for guest sessions and
still expects a harvested pool behind it.

---

## The keeper

After `zeke setup` (and on every `zeke` run that finds it missing), a small detached process —
the *keeper* — takes over the two chores that used to make zeke tedious:

* **The bridge stays up.** If it is down when you run zeke, it starts first and the session
  follows. If it crashes mid-day, the keeper restarts it within `bridge.checkSeconds`. It keeps
  this up until you stop it — not until your terminal closes.
* **The pool never runs dry.** Every few seconds the keeper reads the pool level off `/health`;
  when it drops below `bridge.minTokens` it runs the token collector headlessly (`--no-tui`),
  hot-swaps the result into the live bridge, and backs off exponentially (1 min doubling to a
  30 min cap) if harvesting fails, so it never hammers chat.z.ai. Before it launches anything it
  resolves `chat.z.ai`: a network outage costs a DNS lookup, not a browser start, and it recovers
  by itself once the host answers again.

```sh
zeke bridge status    # shows the bridge, the pool, and what the keeper has been doing
zeke tokens status    # same keeper line, from the tokens' point of view
zeke bridge stop      # the one off-switch: stops keeper and bridge until you start them again
```

That `stop` is deliberate: the keeper goes first, so it cannot read your stop as a crash and
undo it. The next `zeke` run brings everything back.

Config (all under `bridge` in `$ZEKE_HOME/config.json`):

```jsonc
{
  "bridge": {
    "keepAlive": true,       // the keeper supervises at all
    "autoStart": true,       // zeke may start the bridge when it is down
    "minTokens": 5,          // harvest when the pool drops below this
    "checkSeconds": 20,      // how often the keeper looks
    "harvest": { "tokens": 500, "batch": 2, "parallel": 1 }  // flags for the collector
  }
}
```

Pointing `ZEKE_BASE_URL` at a remote bridge disables all of it automatically: zeke supervises
only bridges on loopback that it could have started itself.

---

## Using it

**Interactive** — `zeke` starts a keyboard-driven, full-screen session when stdin and stdout
are terminals. `zeke "fix the failing test"` seeds it with a request. The interface keeps model
output, tool activity, approvals and context status together; it restores the terminal when you
leave. Use `--no-tui` to force the scrolling, line-oriented REPL, or when working through a
terminal wrapper that does not support alternate screens.

The transcript and composer follow OMP's minimal terminal layout: unboxed conversation, padded
user-message surfaces, full-width composer rules, and a compact status bar at the bottom. Rows are
drawn differentially (only changes are rewritten), colour depth is negotiated from the environment
(24-bit → 256 → 16, `NO_COLOR` respected), and markdown keeps its decoration as it streams. A live
working indicator appears above the composer while a turn is in flight.

| Key | Action |
|---|---|
| `Enter` | Send the current prompt |
| `Ctrl+J` | Insert a newline in a multi-line prompt |
| `Ctrl+A` / `Ctrl+E` | Move to the start/end of the prompt |
| `Ctrl+←` / `Ctrl+→` (or `Alt+B` / `Alt+F`) | Move by word |
| `Ctrl+W` / `Alt+Backspace` | Delete the previous word |
| `Ctrl+U` / `Ctrl+K` | Delete to the start/end of the current line |
| `↑` / `↓` | Browse prompt history (or move within a multi-line prompt) |
| `PageUp` / `PageDown`, mouse wheel | Scroll the transcript (works during a turn too) |
| `Shift+↑` / `Shift+↓` | Scroll half a screen |
| `Esc` | Clear a text selection, or jump back to the live output after scrolling up |
| `Ctrl+R` | Search and resume a saved session |
| `Ctrl+N` | Start a distinct session without losing the current one |
| `Ctrl+L` | Repaint after the terminal has been disturbed |
| `Ctrl+C` | Copy the highlighted text; interrupt a running turn when nothing is selected |
| `Ctrl+Y` | Copy the model's last turn |
| `Ctrl+T` | Expand or collapse the todo tree above the composer |
| `Tab` | Accept the highlighted slash command (still completes paths and names) |

**Copying out.** Drag across the transcript to select it — the run is highlighted as you go, and
releasing the button copies it. Double-click takes a word, triple-click a line. `Ctrl+Y` copies the
model's last turn, and `/copy [n|last]` copies any turn by number (bare `/copy` asks which one).
Copies go out as OSC 52 first, which is the transport that survives ssh, tmux and mosh because the
terminal owns the pasteboard, then fall back to `pbcopy`, `wl-copy`, `xclip` or `clip.exe` in a
local session. If neither can take it, zeke says so instead of claiming a copy that never happened.

The active composer rule is accented, and the bottom status bar shows context tokens, percent,
and budget. Bracketed paste is enabled only while the TUI is active: multi-line clipboard content
lands intact in the composer instead of submitting at the first newline, even when the terminal
splits the paste across input chunks.

`/resume` opens the session picker; `/resume <id>` still works. `/new` starts a separate saved
session without discarding the previous transcript. `/clear` resets only the in-memory conversation;
the saved transcript remains available to resume. Piped/scripted sessions keep the line-oriented
REPL so existing automation remains usable.

**Headless** — for scripts and CI:

```sh
zeke -p "what does this module do?"
cat error.log | zeke -p "explain this failure"
zeke -p --yolo "run the tests and fix what fails"
zeke -p -o json "list the exports"      # machine-readable
```

Exit codes are meaningful: `0` ok, `1` error, `3` hit `--max-turns`, `130` interrupted.

**Slash commands** inside a session:

| | | |
|---|---|---|
| `/help` | `/model` | `/profile` |
| `/think` | `/verbose` | `/approvals` |
| `/tools` | `/todo` | `/usage` |
| `/compact` | `/clear` | `/copy` |
| `/session` | `/sessions` | `/resume` |
| `/export` | `/bridge` | `/doctor` |
| `/plugins` | `/prompt` | `/exit` |

Typing `/` previews every command with its one-line description, `↑`/`↓` move the highlight and
`Tab` accepts it — so the list is discoverable without `/help`. `/todo` prints the todo tree and
pins it open; `/copy` copies a transcript turn (`/copy last`, or `/copy 3`).

`/bridge` is the same lifecycle tool as `zeke bridge …`, reachable from where the failure
appears: `/bridge start`, `/bridge restart`, `/bridge stop`, `/bridge logs`, `/bridge models`. When
a turn fails because nothing is listening, the hint points at `/bridge start` — no need to leave
the session to fix it. (If there is no bridge binary yet, the hint says so instead of naming a
command that cannot work.)

**Project context.** Zeke loads applicable `ZEKE.md` / `AGENTS.md` files from the repository root
through the current directory (`ZEKE.md` wins at a given level; more-local rules refine parent
rules). It reads package scripts for test, lint, type-check and build commands, plus conventional test
commands for Go, Cargo, configured pytest, Make, Maven and Gradle, and shows those hints in the
system prompt. Zeke never executes project scripts during startup. Before editing a subdirectory, it
is instructed to check for more-local rules.

---

## Tools

Eight built in, each with a contract small enough that GLM's agent shim can restate it inside a
single user message:

| Tool | Class | Contract |
|---|---|---|
| `read` | read-only | `read {"path": string}` — files, directories, line selectors (`file:50-200`, `file:-60`) |
| `write` | writes | `write {"path", "content", "overwrite"?}` |
| `edit` | writes | `edit {"path", "operations"[]}` — replace / insert_before / insert_after / delete / create |
| `glob` | read-only | `glob {"pattern", "path"?}` |
| `grep` | read-only | `grep {"pattern", "glob"?}` |
| `bash` | writes, exclusive | `bash {"command", "timeout"?}` — 120 s default; POSIX timeout/interruption kills the command process group; blocks `vim`, `less`, `top`, `ssh`, `sudo` |
| `todo` | read-only, exclusive | `todo {"op", "list"?, "task"?, "phase"?, "items"?, "reason"?}` — phased task list, same contract as omp: `init`/`start`/`done`/`drop`/`block`/`unblock`/`append`/`rm`/`view`; tasks addressed by verbatim content; one task `in_progress` at a time; `/todo` shows it |
| `ask` | writes | asks *you* a question mid-run |

### Session-level todo reminders

The `todo` tool owns the list; the session owns the nudging. Ported from oh-my-pi's agent-session
layer (`session/todo-tracker.ts`), four reminders keep the list honest. Each is injected as a
`<system-reminder>` the model sees — never written to the transcript, so a session you resume next
week does not replay "you stopped with 3 items open" back at itself.

| Nudge | Fires when | What the model is told |
|---|---|---|
| `eager-todo` | first turn of a session, list still empty | lay out a phased plan with one `init` before substantive work |
| `mid-run` | 12 successful mutating tool calls since the list was last touched | "N todo items still open" — mark what you finished; at most twice a turn |
| `todo-error` | a `todo` call failed | the failure, and to fix the payload and call again before continuing |
| `completion` | the model stopped talking with items still open | what is left, and to continue or mark it done — at most `remindersMax` times |

Guards worth knowing: nothing is injected when the model's last line is a question *for you* (it is
waiting, not finished), when the previous nudge has not yet produced a single tool call, or when
the run ended on an interrupt, an error, the turn cap, or still mid-tool-use. The eager prelude also
skips prompts that end in `?` or `!` — a question is not a work list. The mid-run nudge counts only
successful `bash`/`edit`/`write` calls (a plugin tool joins that set by declaring `mutating: true`):
exploration is not progress you can tick off.

```jsonc
"todo": {
  "enabled": true,       // false: zeke stops nudging (the tool stays; drop it with tools.exclude)
  "reminders": true,     // false: no injected todo text at all
  "remindersMax": 3,     // completion nudges per user turn
  "eager": "preferred"   // default (off) | preferred (suggest) | always (insist)
}
```

**The todo tree.** The list is drawn as a tree and pinned above the composer, where it cannot be
scrolled away: phases in roman numerals, one checkbox per task (`☐` pending, `◐` running, `✔` done,
`✗` abandoned, `!` blocked), `done/total` per phase, the active phase first. Collapsed it takes five
rows; `Ctrl+T` opens it up to twelve, and it never takes more than a third of the screen. The footer
keeps a `☑ done/total` counter even once the panel is gone, and `/todo` prints the same tree into
the transcript and pins it open. In the line REPL (`--no-tui`) and in headless runs there is no
panel to pin, so the tree is printed after each `todo` call instead — a piped run still shows the
plan.

```
  ▸ Todos  1/5          4 open · 1 blocked · Ctrl+T expand
  ☐ I. Research                                        1/3
    ├─ ✔ read the parser
    ├─ ◐ map the call sites
    └─ ☐ write a failing test
    … II. Fix · 2 more tasks
```

`eager: "always"` is the same prelude with imperative wording. omp pairs it with a forced
`tool_choice: todo`; the GLM-Free-API agent shim offers no `tool_choice`, so zeke does what omp
itself does on a model without one — send the reminder and let the model comply. zeke's default is
`preferred` where omp's is `default` (off): the system prompt here already asks for a plan before
substantive work, so the nudge reinforces it rather than introducing it.

Approvals are policy, not a prompt you have to fight. `auto` (default) approves reads and
writes and asks before `bash`; `--yolo` approves everything; `--ask` asks about everything.
Read-only bash commands are recognised and let through; destructive ones are flagged.

When a call does need a decision, the gate is one keystroke — no Enter:

```
? Allow bash?
  $ npm test -- --runInBand
  why: shell command
   y  yes (once)   n  no   a  always (npm test)   e  explain
```

`a` remembers a *command shape*, never the `bash` tool: approving `npm test` covers
`npm test -- --watch`, and still asks about `npm install left-pad` or `rm -rf build`.
`e` shows the arguments, the tool description and what `always` would remember, then asks again.
The line-oriented REPL (`--no-tui`) offers the same four answers typed as a line, and asks the
question on the session's own readline so a single reader owns stdin.

Restrict the set per run with `--tools read,grep` or `--no-tools` for chat only.

---

## Commands

```
zeke setup       build the bridge, configure tokens, start the keeper (start here)
zeke doctor      diagnose the whole toolchain
zeke bridge      start | stop | restart | status | models | logs — stop ends the keeper too
zeke tokens      collect | status | swap | teleport — collect is the manual override
zeke config      get | set | unset | profiles
zeke models      what the bridge offers
zeke tools       zeke's tools and their contracts
zeke sessions    saved sessions (resume with zeke --resume <id>)
zeke plugins     discovered plugins
zeke selftest    run zeke's own test suite
zeke completions bash | zsh | fish
```

### `zeke doctor`

The bridge's `/status` endpoint does **not** report whether agent mode is on — so "the tools
are being ignored" is invisible from the outside. `zeke doctor` works around that by probing
for real:

1. `GET /health` — is anything listening? (and how many device tokens are left in the pool?)
2. a trivial completion — do auth, the z.ai session and the captcha path work?
3. **a single tool call** — is agent mode actually on?

A `healthy` bridge with an empty device-token pool is reported as a *failure*, not a warning, because it
cannot answer anything: the captcha has nothing left to spend. The tool probe is skipped when the
completion probe already failed — running it on a dead bridge used to end in a misleading
`--agent-mode` verdict, and the streaming errors that caused that are now surfaced instead (the
bridge reports upstream failures inside a 200 stream as `data: {"error": …}`; zeke reads them).

`zeke doctor --json` prints a machine-readable report and nothing else, for CI. A bridge zeke
did not build is reported as a warning, not a failure: pointing at someone else's instance is
supported.

---

## Configuration

`$ZEKE_HOME/config.json` (JSONC — comments and trailing commas allowed), merged over built-in
defaults, then a project `.zeke/config.json`, then environment variables.

```jsonc
{
  "profile": "default",          // default | fast | deep
  "approval": { "mode": "auto" },// ask | auto | yolo
  "bridge":   { "port": 3001, "agentMode": true },
  "compaction": { "enabled": true, "targetRatio": 0.6 },
  "tools":    { "exclude": ["bash"] },
  "todo":     { "eager": "preferred", "reminders": true, "remindersMax": 3 }
}
```

| Profile | Model | Notes |
|---|---|---|
| `default` | `glm-4.7` | works as a guest — no Z.AI token |
| `fast` | `glm-5.3-flash` | cheap, quick |
| `deep` | `glm-5.3` | thinking on, `high` effort, 16k output |

(Guest models need no *Z.AI* token. Every model still needs the device-token pool above.)

Environment: `ZEKE_BASE_URL`, `ZEKE_AUTH_TOKEN`, `ZEKE_MODEL`, `ZEKE_HOME`, `ZAI_TOKEN`,
`NO_COLOR`. `ZEKE_BASE_URL` also drives where bridge-management commands look, so pointing at a
remote bridge works without touching config.

Long conversations compact automatically at 60% of the context budget, keeping the last 6
messages and never splitting a tool call from its result.

---

## Plugins

Drop a file in `~/.zeke/plugins/` (user) or `.zeke/plugins/` (project):

```js
// ~/.zeke/plugins/deploy.js
export default function (zeke) {
  zeke.registerTool({
    name: "deploy",
    description: "Deploy to staging.",
    parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    execute: async (args) => ({ content: `deployed to ${args.target}` }),
  });

  zeke.registerCommand({ name: "ship", description: "Deploy to staging", run: () => "shipping" });
  zeke.on("tool.call.end", (data) => console.error(`${data.toolCall.name} took ${data.durationMs}ms`));
  zeke.hook("beforeRequest", (req) => ({ ...req, maxTokens: 4096 }));
}
```

Also available without a function — just export the shape:

```js
export const tools = [/* … */];
export const systemPrompt = "Always answer in haiku.";
```

Plugins can register tools, slash commands, event subscribers, request hooks, and whole new
providers. A plugin that throws is reported by `zeke plugins` and skipped — it never takes
zeke down with it.

**Programmatic use:** everything the CLI is built from is exported.

```js
import { ZekeRuntime, loadConfig } from "zeke";

const config = await loadConfig();
const zeke = new ZekeRuntime({ config, cwd: process.cwd() });
await zeke.init();
const { finalText } = await zeke.run("explain this repo");
```

Subpath exports: `zeke/tools`, `zeke/providers`, `zeke/plugins`, `zeke/mock-bridge`.

---

## Architecture

Layered, with no layer reaching past the one below it:

```
lib/        primitives — jsonc, args, paths, events, json-repair
core/       types, agent loop, approval policy, ZekeRuntime
providers/  SSE decoding, OpenAI wire format, GLM specifics
tools/      the eight built-ins + registry
session/    JSONL store, compaction, export, session-level todo reminders
ui/         ANSI + width-aware text, theme, streaming renderer, approval prompt, full-screen TUI
cli/        argument routing, REPL, headless, setup, doctor
plugins/    the plugin API surface
bridge/     process management, vendoring, Go build
```

The agent core does no rendering and no I/O. It emits events on an `EventBus`, and the TUI, the
headless printer, the JSONL writer and any plugins all subscribe. That is why headless output
never drifts from what an interactive session showed, and why a plugin can observe a run
without touching the loop.

The bridge integration lives in `src/bridge/` and speaks the real GLM-Free-API surface:
OpenAI-compatible SSE with 5 s keep-alives, `POST /sqlite` for token hot-swap, and the WAF
breaker's `503` + `Retry-After` backoff.

---

## Tests

```sh
npm test          # 560 tests in 19 files
npm run selftest  # end-to-end: real CLI against a mock bridge
zeke selftest     # same suite, from an installed checkout
```

The suite uses `node:test` and needs no network. Integration tests run the real CLI as a
subprocess against `src/mock-bridge/server.js`, which speaks the bridge's protocol including
streamed tool-call argument fragments — so the SSE client, the tool-call parser and the JSON
repair path are all exercised for real. Two files guard the paths that fail *quietly*:
`test/launcher.test.js` runs the CLI through an `npm link`-style symlink (a bin that decides it is
an import exits 0 and prints nothing), and `test/repl.test.js` drives a real session through pipes
to check the recovery advice — one failure, one line, and a fix that works from inside the
session. The mock also reproduces the bridge's *streaming-branch
failure shape* (HTTP 200 + `data: {"error": …}` + `[DONE]`) and its empty-pool captcha failure,
which is how `zeke setup` and `zeke doctor` are tested against the exact confusion this repo was
born from.

The suite does one thing that touches the network: `zeke tokens collect --dry-run` resolves
`chat.z.ai`, and the CLI test accepts either answer (resolved, or the failure with its blocker) — the
resolver logic itself is unit-tested with injected lookups, so an offline machine stays green.

Two things are honestly **not** covered, because this sandbox cannot reach them:

- **No live Z.AI verification.** `chat.z.ai` is unreachable from here, so every test runs
  against the mock. The wire format was read out of the bridge's own Go source, not guessed.
- **The Go bridge is never actually compiled.** There is no Go toolchain and no way to fetch
  one. `buildBridge` is tested against a stub `go` on PATH — the same code runs, the same
  arguments are passed, the same failures surface — but that proves zeke's orchestration, not
  that upstream compiles. Run `zeke setup` on a machine with Go to close that gap.

---

## Troubleshooting

**Every prompt fails with `cannot reach http://127.0.0.1:3001/v1: connection refused`.** Nothing is
listening on the bridge port. Inside a session, `/bridge start` brings it up (and `/bridge logs`
says why it stopped); from a shell, `zeke bridge start`. If it refuses to start, `/doctor` — or
`zeke doctor --json` in CI — names the missing piece, usually a device-token pool or the Go
toolchain that builds the bridge.

**An old build prints nothing at all.** Before the symlink fix, a `zeke` launched through
`npm link` (which installs a symlink) hit the "am I the program being run?" guard with a *link*
path on one side and the *resolved* path on the other, decided it was an import, and exited 0
without running anything. `node bin/zeke.mjs …` from the checkout always worked. Update the
checkout and re-`npm link` if you still see it.

**`health` says `healthy` but every completion fails with
`server_error: captcha generation returned empty payload`.** The device-token pool is empty —
the bridge had nothing to mint the request's captcha from. Fill it:

```sh
zeke tokens collect   # builds the collector when missing, harvests, hot-swaps
zeke tokens status    # how many are left afterwards
```

A `ZAI_TOKEN` does not change this; the captcha is per request regardless.

**`zeke tokens collect` finishes and the pool is still empty.** The collector writes
`./tokens.sqlite` in its working directory and takes no `--db-path` flag, so it must run from
`$ZEKE_HOME` — zeke does that for you, and reports the path it harvested into. If it stopped
early, the browser is the usual cause: run it once with `--no-tui` to see the error, and install
the system libraries with `npx playwright install-deps chromium`.

**Harvesting dies with `net::ERR_NAME_NOT_RESOLVED` (or `ERR_PROXY_CONNECTION_FAILED`,
`ERR_CERT_…`).** That is the collector's browser failing to reach `chat.z.ai` — not a token, auth or
login problem, however much the retry lines look like one. Because the browser resolves the host
itself, a DNS or proxy failure used to surface after a browser launch, an install check and three
attempts. zeke now resolves `chat.z.ai` before it launches anything: `zeke tokens collect` refuses to
start a harvest that cannot work and names the cause, the keeper logs the same reason and backs off
without spending a browser, and `zeke tokens collect --dry-run` shows the check up front. If your
lookup is the only thing failing (Secure DNS, split tunnels) and the browser can still get out, use
`ZEKE_SKIP_NETWORK_CHECK=1 zeke tokens collect`.

**Harvesting fails before it starts.** `zeke tokens collect --dry-run` shows the whole path:
whether the collector is built (it is built on demand from `vendor/glm-free-api`), whether the
vendored source and a Go toolchain are there to build it with, whether the Playwright browser
cache exists, and anything that will be downloaded on first run.

**A reply comes back empty — no text, no tool call, no error.** Upstream failures reach
streaming clients *inside* the 200 stream (`data: {"error": …}` + `[DONE]`), because the
bridge has already committed its headers. zeke reads those payloads and turns them into real
errors; if you are on an older build, `zeke bridge logs` shows what the bridge actually said.

**Doctor blames agent mode.** It does not any more: the tool-call probe only runs when a
completion works and is only read as "agent mode is off" when the model answered in prose.
Restart the bridge with `zeke bridge restart` if it really was started without it — zeke passes
`AGENT_MODE=true` itself.

---

## Reference sources

`refs/` holds the extracted upstream code — GLM-Free-API's Go source and oh-my-pi's packages —
for reading alongside zeke's. It is gitignored and regenerated:

```sh
scripts/extract-refs.sh
```

Both zips stay committed as build inputs. `scripts/vendor-bridge.sh` does programmatically what
`zeke setup` does, if you would rather vendor by hand.

---

## License

MIT.
