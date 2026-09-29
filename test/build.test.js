// Build and bridge-orchestration tests.
//
// There is no Go toolchain in this sandbox, so the build path is verified
// against a stub `go` placed on PATH: the same `buildBridge()` code runs, the
// same arguments are passed, the same failures are surfaced — only the
// compiler itself is fake. That is enough to prove zeke's orchestration, which
// is the part zeke is responsible for.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { sandbox } from "./helpers.js";
import { buildBridge, ensureVendored, findGo, hasGoSource, run, sourceFingerprint, writeBuildInfo, readBuildInfo } from "../src/bridge/build.js";
import { bridgeEnv, health as bridgeHealth, startBridge, stopBridge, swapTokenDb, readPid } from "../src/bridge/bridge.js";
import { paths } from "../src/lib/paths.js";
import { startMockBridge } from "../src/mock-bridge/server.js";

/** Write a fake `go` that records its invocations and produces a binary. */
async function stubGo(dir, { failOn = null, exitCode = 0 } = {}) {
  await mkdir(path.join(dir, "bin"), { recursive: true });
  const log = path.join(dir, "go-calls.log");
  const script = `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
${failOn ? `  "${failOn}") exit ${exitCode || 1} ;;` : ""}
esac
if [ "$1" = "build" ]; then
  # -o <path> is the third-to-last pair; find the output path.
  out=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "-o" ]; then out="$arg"; fi
    prev="$arg"
  done
  [ -n "$out" ] && printf '#!/bin/sh\\necho stub-bridge\\n' > "$out" && chmod +x "$out"
fi
exit 0
`;
  const binary = path.join(dir, "bin", "go");
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  return { binary, log, root: dir, calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean) };
}

/** Create the minimal vendored layout buildBridge() requires. */
async function fakeVendoredSource(dir) {
  await mkdir(path.join(dir, "internal", "zbridge"), { recursive: true });
  await writeFile(path.join(dir, "main.go"), 'package main\n\nimport "zai-api/internal/zbridge"\n\nfunc main() { zbridge.Run() }\n');
  await writeFile(path.join(dir, "internal", "zbridge", "run.go"), "package zbridge\n\nfunc Run() {}\n");
  await mkdir(path.join(dir, "cmd", "token-collector"), { recursive: true });
  await writeFile(path.join(dir, "cmd", "token-collector", "main.go"), "package main\n\nfunc main() {}\n");
}

describe("vendoring", () => {
  test("recognises the bridge source layout", async () => {
    const box = await sandbox();
    try {
      // An explicit directory, not paths.vendoredBridge(): the vendored bridge
      // lives in the repo (one copy shared by every sandbox), and a test must
      // not mutate it or depend on what a previous test left there.
      const dir = path.join(box.root, "src-copy");
      assert.equal(await hasGoSource(dir), false);
      await fakeVendoredSource(dir);
      assert.equal(await hasGoSource(dir), true);
    } finally {
      await box.cleanup();
    }
  });

  test("extracts the committed upstream zip", async () => {
    const box = await sandbox();
    try {
      const { readdir } = await import("node:fs/promises");
      const zips = (await readdir(paths.root)).filter((f) => /^GLM-Free-API.*\.zip$/i.test(f));
      if (!zips.length) return; // nothing to extract from in this checkout
      const result = await ensureVendored({ zip: path.join(paths.root, zips[0]), dest: path.join(box.root, "vendored"), refresh: true });
      assert.equal(result.source, "zip");
      assert.equal(await hasGoSource(result.dir), true);
      const { access } = await import("node:fs/promises");
      await access(path.join(result.dir, "internal", "zbridge", "handlers.go"));
    } finally {
      await box.cleanup();
    }
  });

  test("a cached checkout is reused rather than re-extracted", async () => {
    const box = await sandbox();
    try {
      const dest = path.join(box.root, "vendored");
      await fakeVendoredSource(dest);
      const result = await ensureVendored({ zip: "/nonexistent.zip", dest });
      assert.equal(result.source, "cached");
    } finally {
      await box.cleanup();
    }
  });

  test("sourceFingerprint is stable and changes with the source", async () => {
    const box = await sandbox();
    try {
      const dir = path.join(box.root, "src-copy");
      await fakeVendoredSource(dir);
      const first = await sourceFingerprint(dir);
      assert.equal(first, await sourceFingerprint(dir));
      await writeFile(path.join(dir, "main.go"), "package main\n// changed\n");
      assert.notEqual(first, await sourceFingerprint(dir));
    } finally {
      await box.cleanup();
    }
  });

  test("sourceFingerprint is null for a missing directory", async () => {
    const box = await sandbox();
    try {
      assert.equal(await sourceFingerprint(path.join(box.root, "nothing-here")), null);
    } finally {
      await box.cleanup();
    }
  });
});

describe("Go toolchain discovery", () => {
  test("finds go on PATH", async () => {
    const box = await sandbox();
    try {
      const stub = await stubGo(path.join(box.root, "go"));
      process.env.PATH = `${path.join(stub.root, "bin")}${path.delimiter}${process.env.PATH}`;
      const found = await findGo();
      assert.ok(found);
      assert.equal(found.origin, "PATH");
      assert.equal(found.go, stub.binary);
    } finally {
      await box.cleanup();
    }
  });

  test("returns null when there is no toolchain", async () => {
    const box = await sandbox();
    try {
      const saved = process.env.PATH;
      process.env.PATH = "/nonexistent-bin";
      assert.equal(await findGo(), null);
      process.env.PATH = saved;
    } finally {
      await box.cleanup();
    }
  });
});

describe("buildBridge", () => {
  test("runs init, tidy and build in order with the right module name", async () => {
    const box = await sandbox();
    try {
      const stub = await stubGo(path.join(box.root, "go"));
      process.env.PATH = `${path.join(stub.root, "bin")}${path.delimiter}${process.env.PATH}`;
      const sourceDir = path.join(box.root, "src-copy");
      await fakeVendoredSource(sourceDir);

      const result = await buildBridge({ collector: false, sourceDir });
      const calls = await stub.calls();

      assert.equal(calls[0], "mod init zai-api", "the module must be named zai-api for the import path to resolve");
      assert.match(calls[1], /^mod tidy$/);
      assert.match(calls[2], /^build -trimpath -ldflags -s -w -o .*zai-api \.$/);
      assert.deepEqual(result.steps.map((s) => s.name), ["go mod init", "go mod tidy", "go build"]);
      assert.ok(result.steps.every((s) => s.code === 0));

      const info = await stat(result.binary);
      assert.equal(info.isFile(), true);
      // The binary must be executable.
      assert.equal((info.mode & 0o111) !== 0, true);
    } finally {
      await box.cleanup();
    }
  });

  test("an existing go.mod is left alone", async () => {
    const box = await sandbox();
    try {
      const stub = await stubGo(path.join(box.root, "go"));
      process.env.PATH = `${path.join(stub.root, "bin")}${path.delimiter}${process.env.PATH}`;
      const sourceDir = path.join(box.root, "src-copy");
      await fakeVendoredSource(sourceDir);
      await writeFile(path.join(sourceDir, "go.mod"), "module zai-api\n\ngo 1.21\n");

      await buildBridge({ collector: false, sourceDir });
      const calls = await stub.calls();
      assert.equal(calls.some((c) => c.startsWith("mod init")), false);
      assert.match(calls[0], /^mod tidy$/);
    } finally {
      await box.cleanup();
    }
  });

  test("a failing tidy is reported with the likely cause", async () => {
    const box = await sandbox();
    try {
      const stub = await stubGo(path.join(box.root, "go"), { failOn: "mod tidy", exitCode: 1 });
      process.env.PATH = `${path.join(stub.root, "bin")}${path.delimiter}${process.env.PATH}`;
      const sourceDir = path.join(box.root, "src-copy");
      await fakeVendoredSource(sourceDir);
      await assert.rejects(() => buildBridge({ collector: false, sourceDir }), /go mod tidy failed/);
    } finally {
      await box.cleanup();
    }
  });

  test("a failing build is reported", async () => {
    const box = await sandbox();
    try {
      const stub = await stubGo(path.join(box.root, "go"), { failOn: "build -trimpath", exitCode: 2 });
      process.env.PATH = `${path.join(stub.root, "bin")}${path.delimiter}${process.env.PATH}`;
      const sourceDir = path.join(box.root, "src-copy");
      await fakeVendoredSource(sourceDir);
      await assert.rejects(() => buildBridge({ collector: false, sourceDir }), /go build failed/);
    } finally {
      await box.cleanup();
    }
  });

  test("a missing toolchain says exactly what to do", async () => {
    const box = await sandbox();
    try {
      const saved = process.env.PATH;
      process.env.PATH = "/nonexistent-bin";
      const sourceDir = path.join(box.root, "src-copy");
      await fakeVendoredSource(sourceDir);
      await assert.rejects(() => buildBridge({ collector: false, sourceDir }), /no Go toolchain found/);
      process.env.PATH = saved;
    } finally {
      await box.cleanup();
    }
  });

  test("a missing source points at zeke setup", async () => {
    const box = await sandbox();
    try {
      // An explicit empty directory: the real vendor/ is shared repo state and
      // may legitimately be populated, so it cannot be assumed absent.
      await assert.rejects(
        () => buildBridge({ collector: false, sourceDir: path.join(box.root, "empty-source") }),
        /no bridge source/,
      );
    } finally {
      await box.cleanup();
    }
  });

  test("an explicit sourceDir is honoured over the vendored copy", async () => {
    const box = await sandbox();
    try {
      const stub = await stubGo(path.join(box.root, "go"));
      process.env.PATH = `${path.join(stub.root, "bin")}${path.delimiter}${process.env.PATH}`;
      const sourceDir = path.join(box.root, "my-clone");
      await fakeVendoredSource(sourceDir);
      await buildBridge({ collector: false, sourceDir });
      const calls = await stub.calls();
      // A fresh clone has no go.mod, so `mod init` must run — proving the build
      // happened in the caller's directory and not in the shared vendor copy.
      assert.equal(calls[0], "mod init zai-api");
      assert.match(calls[2], /^build .*-o .*zai-api \.$/);
    } finally {
      await box.cleanup();
    }
  });

  test("build info is written and read back", async () => {
    const box = await sandbox();
    try {
      await writeBuildInfo({ builtAt: "2026-01-01T00:00:00.000Z", binary: "/x/zai-api", fingerprint: "abc123" });
      const info = await readBuildInfo();
      assert.equal(info.fingerprint, "abc123");
      assert.equal(info.binary, "/x/zai-api");
      assert.equal(await readBuildInfo.call(null) !== null, true);
    } finally {
      await box.cleanup();
    }
  });
});

describe("bridge environment", () => {
  test("always enables agent mode, because tool calling needs it", () => {
    const env = bridgeEnv({ port: 3001, authToken: "tok" });
    assert.equal(env.AGENT_MODE, "true");
    assert.equal(env.AGENT_MODE_VARIANT, "modern");
    assert.equal(env.AUTH_TOKEN, "tok");
    assert.equal(env.PORT, "3001");
  });

  test("agent mode can be explicitly turned off", () => {
    assert.equal(bridgeEnv({ agentMode: false }).AGENT_MODE, "false");
  });

  test("a ZAI_TOKEN is passed through when present and omitted when not", () => {
    assert.equal(bridgeEnv({ zaiToken: "jwt" }).ZAI_TOKEN, "jwt");
    assert.equal(bridgeEnv({}).ZAI_TOKEN, undefined);
  });

  test("a bundled Go root is prepended to PATH", () => {
    const env = bridgeEnv({ goRoot: "/opt/go" });
    assert.equal(env.GOROOT, "/opt/go");
    assert.ok(env.PATH.startsWith(`/opt/go/bin${path.delimiter}`));
  });

  test("extraEnv entries are applied", () => {
    const env = bridgeEnv({ extraEnv: ["LOG_LEVEL=debug", "SESSION_POOL_SIZE=9"] });
    assert.equal(env.LOG_LEVEL, "debug");
    assert.equal(env.SESSION_POOL_SIZE, "9");
  });

  test("CI is forced on so child tools do not prompt", async () => {
    const box = await sandbox();
    try {
      const { bashTool } = await import("../src/tools/bash.js");
      const { toolContext } = await import("./helpers.js");
      const result = await bashTool.execute({ command: "echo $CI" }, toolContext(box.cwd));
      assert.match(result.content, /^1$/m);
    } finally {
      await box.cleanup();
    }
  });
});

describe("bridge process management", () => {
  test("startBridge refuses when the binary is missing", async () => {
    const box = await sandbox();
    try {
      await assert.rejects(() => startBridge({ port: 0, binary: path.join(box.root, "nope") }), /bridge binary not found/);
    } finally {
      await box.cleanup();
    }
  });

  test("startBridge launches a process and waits for the port", async () => {
    const box = await sandbox();
    try {
      // A stand-in "bridge": a tiny HTTP server that answers /health.
      const fake = path.join(box.root, "fake-bridge.mjs");
      await writeFile(
        fake,
        `import { createServer } from "node:http";
createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ healthy: true, mode: "direct", tokenCount: 5 }));
}).listen(Number(process.env.PORT), process.env.HOST);
`,
      );
      const shim = path.join(box.root, "fake-bridge");
      await writeFile(shim, `#!/bin/sh\nexec ${process.execPath} ${fake}\n`);
      await chmod(shim, 0o755);

      const started = await startBridge({ host: "127.0.0.1", port: 39_117, binary: shim, authToken: "t" });
      assert.equal(started.url, "http://127.0.0.1:39117");
      assert.ok(started.pid > 0);
      assert.equal(await readPid(), started.pid);

      const state = await bridgeHealth({ host: "127.0.0.1", port: 39_117 });
      assert.equal(state.listening, true);
      assert.equal(state.healthy, true);
      assert.equal(state.tokenCount, 5);

      const log = await readFile(started.logFile, "utf8").catch(() => "");
      void log;

      const stopped = await stopBridge({ host: "127.0.0.1", port: 39_117 });
      assert.equal(stopped.stopped, true);
      assert.equal(await readPid(), null, "the pid file is removed after stopping");
    } finally {
      await box.cleanup();
    }
  });

  test("startBridge refuses to double-start", async () => {
    const box = await sandbox();
    try {
      const fake = path.join(box.root, "fake2.mjs");
      await writeFile(
        fake,
        `import { createServer } from "node:http";
createServer((req, res) => { res.writeHead(200, {"content-type":"application/json"}); res.end('{"healthy":true,"tokenCount":1}'); }).listen(Number(process.env.PORT), process.env.HOST);
`,
      );
      const shim = path.join(box.root, "fake2");
      await writeFile(shim, `#!/bin/sh\nexec ${process.execPath} ${fake}\n`);
      await chmod(shim, 0o755);

      const config = { host: "127.0.0.1", port: 39_118, binary: shim, authToken: "t" };
      await startBridge(config);
      await assert.rejects(() => startBridge(config), /already answering/);
      await stopBridge(config);
    } finally {
      await box.cleanup();
    }
  });

  test("stopBridge reports when nothing is running", async () => {
    const box = await sandbox();
    try {
      const result = await stopBridge({ host: "127.0.0.1", port: 39_119 });
      assert.equal(result.stopped, false);
      assert.match(result.reason, /no bridge pid file|did not start it/);
    } finally {
      await box.cleanup();
    }
  });

  test("a stale pid file is not treated as a running bridge", async () => {
    const box = await sandbox();
    try {
      await mkdir(paths.home, { recursive: true });
      await writeFile(paths.bridgePid(), "999999999\n");
      assert.equal(await readPid(), null);
    } finally {
      await box.cleanup();
    }
  });

  test("health on a dead port reports listening:false without throwing", async () => {
    const state = await bridgeHealth({ host: "127.0.0.1", port: 1 });
    assert.equal(state.listening, false);
    assert.equal(state.ok, false);
  });

  test("swapTokenDb validates through the bridge", async () => {
    const bridge = await startMockBridge();
    try {
      await assert.rejects(() => swapTokenDb("/no/such/file.sqlite", { port: Number(bridge.url.split(":")[2]), authToken: "Waguri" }), /does not exist/);

      const box = await sandbox();
      try {
        const db = path.join(box.cwd, "tokens.sqlite");
        await writeFile(db, "data");
        const result = await swapTokenDb(db, { port: Number(bridge.url.split(":")[2]), authToken: "Waguri" });
        assert.equal(result.success, true);
        assert.equal(bridge.state.dbPath, db);
      } finally {
        await box.cleanup();
      }
    } finally {
      await bridge.close();
    }
  });
});

describe("command runner", () => {
  test("captures stdout and the exit code", async () => {
    const result = await run("echo", ["hello"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /hello/);
  });

  test("reports a missing command instead of throwing", async () => {
    const result = await run("definitely-not-a-real-command-xyz", [], { allowMissing: true, quiet: true });
    assert.equal(result.code, 127);
    assert.match(result.stderr, /not found/);
  });

  test("captures a non-zero exit without throwing", async () => {
    const result = await run("sh", ["-c", "exit 7"], { quiet: true });
    assert.equal(result.code, 7);
  });
});
