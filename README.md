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
without a restart, and diagnosing the whole chain when something is off.

---

## Install

```sh
git clone <this repo> && cd zeke
zeke setup        # or: node bin/zeke.mjs setup
```

`zeke setup` does six things and tells you what it is doing at each step:

1. checks Node ≥ 20.11
2. vendors the GLM-Free-API source into `vendor/glm-free-api/` (from the committed zip)
3. fetches a Go toolchain if you do not have one, then builds `zai-api` into `$ZEKE_HOME/bin`
4. configures credentials — a `ZAI_TOKEN` JWT, a harvested device-token pool, or neither
5. starts the bridge with agent mode on
6. verifies end to end: `/health`, a real completion, then a tool call

Nothing in that chain is hidden. If a step fails, the message says which one and what to run.

**Runtime dependencies: zero.** `package.json` has an empty `dependencies` block. Tests use
`node:test`.

---

## Tokens

The hosted site does not work, so zeke is built around tokens you control. Two kinds, and you
can use either or both:

**A personal JWT** — `chat.z.ai` → DevTools → Local Storage → key `token`:

```sh
zeke setup --token <jwt>
```

A JWT unlocks every model, including the vision models. Without one you are a guest, and
guests get only `glm-5.3-flash` and `glm-4.7`. That is enough to work; zeke defaults to
`glm-4.7` precisely so a tokenless install still functions.

**Harvested device tokens** — the collector drives real browsers to mint session tokens into a
SQLite pool the bridge rotates through:

```sh
zeke tokens collect              # harvest into $ZEKE_HOME/tokens.sqlite
zeke tokens status               # how many are left
zeke tokens swap ./tokens.sqlite # hot-swap without restarting the bridge
```

Hot-swap posts to the bridge's `/sqlite` endpoint, so a drained pool can be refilled mid-session
without losing context.

---

## Using it

**Interactive** — `zeke` starts a session in the current directory. `zeke "fix the failing
test"` seeds it with a request.

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
| `/tools` | `/usage` | `/compact` |
| `/clear` | `/session` | `/sessions` |
| `/resume` | `/export` | `/bridge` |
| `/doctor` | `/plugins` | `/prompt` |
| `/exit` | | |

**Context memory.** Drop a `ZEKE.md` (or `AGENTS.md`) in your project root and zeke reads it as
project instructions. `ZEKE.md` wins if both exist.

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
| `bash` | writes, exclusive | `bash {"command", "timeout"?}` — 120 s default; blocks `vim`, `less`, `top`, `ssh`, `sudo` |
| `todo` | writes | task list the model maintains across turns |
| `ask` | writes | asks *you* a question mid-run |

Approvals are policy, not a prompt you have to fight. `auto` (default) approves reads and
writes and asks before `bash`; `--yolo` approves everything; `--ask` asks about everything.
Read-only bash commands are recognised and let through; destructive ones are flagged.

Restrict the set per run with `--tools read,grep` or `--no-tools` for chat only.

---

## Commands

```
zeke setup       build the bridge and configure tokens (start here)
zeke doctor      diagnose the whole toolchain
zeke bridge      start | stop | restart | status | models | logs
zeke tokens      collect | status | swap | teleport
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

1. `GET /health` — is anything listening?
2. a trivial completion — do auth and the z.ai session work?
3. **a single tool call** — is agent mode actually on?

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
  "tools":    { "exclude": ["bash"] }
}
```

| Profile | Model | Notes |
|---|---|---|
| `default` | `glm-4.7` | works without a token |
| `fast` | `glm-5.3-flash` | cheap, quick |
| `deep` | `glm-5.3` | thinking on, `high` effort, 16k output |

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
session/    JSONL store, compaction, export
ui/         ANSI, renderer, approval prompt
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
npm test          # 335 tests in 10 files
npm run selftest  # end-to-end: real CLI against a mock bridge
zeke selftest     # same suite, from an installed checkout
```

The suite uses `node:test` and needs no network. Integration tests run the real CLI as a
subprocess against `src/mock-bridge/server.js`, which speaks the bridge's protocol including
streamed tool-call argument fragments — so the SSE client, the tool-call parser and the JSON
repair path are all exercised for real.

Two things are honestly **not** covered, because this sandbox cannot reach them:

- **No live Z.AI verification.** `chat.z.ai` is unreachable from here, so every test runs
  against the mock. The wire format was read out of the bridge's own Go source, not guessed.
- **The Go bridge is never actually compiled.** There is no Go toolchain and no way to fetch
  one. `buildBridge` is tested against a stub `go` on PATH — the same code runs, the same
  arguments are passed, the same failures surface — but that proves zeke's orchestration, not
  that upstream compiles. Run `zeke setup` on a machine with Go to close that gap.

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
