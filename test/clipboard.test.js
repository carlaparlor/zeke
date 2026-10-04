// The clipboard.
//
// Copying is best effort by design — the TUI must not crash because a machine
// has no `xclip` — so what matters is which transport ran, that OSC 52 is
// framed correctly, and that a failure is swallowed rather than thrown.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyToClipboard, nativeClipboardCommand, osc52Sequence } from "../src/ui/clipboard.js";

const ESC = "\u001b";
const BEL = "\u0007";

/** A stream that records writes, and can be made to throw on demand. */
function fakeStream({ throws = false } = {}) {
  const chunks = [];
  return {
    chunks,
    isTTY: true,
    write(text) {
      if (throws) throw new Error("EPIPE");
      chunks.push(String(text));
      return true;
    },
  };
}

describe("clipboard", () => {
  test("OSC 52 is framed as an escape, a base64 payload, and a terminator", () => {
    assert.equal(osc52Sequence("hello world"), `${ESC}]52;c;aGVsbG8gd29ybGQ=${BEL}`);
    assert.equal(osc52Sequence(""), `${ESC}]52;c;${BEL}`);
    // Multi-byte text is encoded as utf-8 first, not as latin-1.
    assert.equal(osc52Sequence("π"), `${ESC}]52;c;z4A=${BEL}`);
  });

  test("the native command follows the session, not just the platform", () => {
    assert.deepEqual(nativeClipboardCommand({ TERMUX_VERSION: "1" }, "linux"), ["termux-clipboard-set"]);
    assert.deepEqual(nativeClipboardCommand({}, "darwin"), ["pbcopy"]);
    assert.deepEqual(nativeClipboardCommand({ WAYLAND_DISPLAY: "wayland-0" }, "darwin"), ["pbcopy"]);
    assert.deepEqual(nativeClipboardCommand({}, "win32"), ["clip.exe"]);
    assert.deepEqual(nativeClipboardCommand({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), ["wl-copy"]);
    assert.deepEqual(nativeClipboardCommand({ DISPLAY: ":0" }, "linux"), ["xclip", "-selection", "clipboard"]);
    assert.deepEqual(nativeClipboardCommand({ XDG_SESSION_TYPE: "x11" }, "linux"), ["xclip", "-selection", "clipboard"]);
    // Over ssh with no display there is nothing to spawn; OSC 52 is the answer.
    assert.equal(nativeClipboardCommand({ SSH_TTY: "/dev/pts/0" }, "linux"), null);
  });

  test("a copy writes OSC 52 to the stream", async () => {
    const stream = fakeStream();
    const result = await copyToClipboard("hello", { stream, spawn: false });
    assert.deepEqual(result, { ok: true, via: "osc52" });
    assert.equal(stream.chunks.join(""), osc52Sequence("hello"));
  });

  test("nothing is copied when there is nothing to copy", async () => {
    const stream = fakeStream();
    assert.deepEqual(await copyToClipboard("", { stream, spawn: false }), { ok: false, via: null });
    assert.deepEqual(await copyToClipboard(undefined, { stream, spawn: false }), { ok: false, via: null });
    assert.equal(stream.chunks.length, 0);
  });

  test("a stream that cannot be written to does not fail the copy", async () => {
    const stream = fakeStream({ throws: true });
    // No clipboard tool on this platform either, so nothing took it.
    const result = await copyToClipboard("hello", { stream, spawn: false, env: {}, platform: "linux" });
    assert.deepEqual(result, { ok: false, via: null });
  });

  test("the native tool receives the text on stdin", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "zeke-clip-"));
    const out = path.join(dir, "clipboard.txt");
    const bin = path.join(dir, "termux-clipboard-set");
    try {
      await writeFile(bin, `#!/bin/sh\ncat > "${out}"\n`);
      await chmod(bin, 0o755);
      const stream = fakeStream();
      const result = await copyToClipboard("copied text", {
        stream,
        env: { TERMUX_VERSION: "1", PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      assert.deepEqual(result, { ok: true, via: "termux-clipboard-set" });
      assert.equal(await readFile(out, "utf8"), "copied text");
      // OSC 52 still goes out first: it is the transport that survives ssh.
      assert.equal(stream.chunks.join(""), osc52Sequence("copied text"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a clipboard tool that is missing is a no-op, not an error", async () => {
    const stream = fakeStream();
    const result = await copyToClipboard("hello", {
      stream,
      env: { DISPLAY: ":0", PATH: "/nonexistent" },
    });
    assert.deepEqual(result, { ok: true, via: "osc52" });
  });
});
