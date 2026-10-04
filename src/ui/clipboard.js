// The clipboard.
//
// Two transports, in the order omp tries them: OSC 52 (works over ssh, tmux and
// mosh, because the *terminal* owns the pasteboard), then a native tool for
// local sessions where the terminal silently ignores OSC 52 writes. Both are
// best effort — a copy that cannot be delivered must never break the UI that
// asked for it.

import { spawn } from "node:child_process";

const ESC = "\u001b";
const BEL = "\u0007";
const NATIVE_TIMEOUT_MS = 2000;

/**
 * The OSC 52 write that sets the system clipboard (`c`).
 *
 * @param {string} text
 * @returns {string}
 */
export function osc52Sequence(text) {
  return `${ESC}]52;c;${Buffer.from(String(text ?? ""), "utf8").toString("base64")}${BEL}`;
}

/** The clipboard tool for this platform, chosen from what the session exposes. */
export function nativeClipboardCommand(env = process.env, platform = process.platform) {
  if (env.TERMUX_VERSION) return ["termux-clipboard-set"];
  if (platform === "darwin") return ["pbcopy"];
  if (platform === "win32") return ["clip.exe"];
  if (env.WAYLAND_DISPLAY) return ["wl-copy"];
  if (env.DISPLAY || env.XDG_SESSION_TYPE === "x11") return ["xclip", "-selection", "clipboard"];
  return null;
}

/**
 * Copy text to the system clipboard.
 *
 * @param {string} text
 * @param {{stream?: {write: Function, isTTY?: boolean}, osc?: boolean, spawn?: boolean, env?: NodeJS.ProcessEnv, platform?: string}} [options]
 * @returns {Promise<{ok: boolean, via: string|null}>} `via` names the transport that took it
 */
export async function copyToClipboard(text, options = {}) {
  const value = String(text ?? "");
  if (!value) return { ok: false, via: null };
  const stream = options.stream ?? process.stdout;

  let via = null;
  // OSC 52 is a message to the terminal; on a pipe there is no terminal to
  // take it, and claiming a copy that never happened is worse than admitting it.
  if (options.osc !== false && stream?.isTTY !== false) {
    try {
      if (stream?.write) stream.write(osc52Sequence(value));
      via = "osc52";
    } catch {
      // A closed or piped stdout must not fail the copy: fall through.
    }
  }

  if (options.spawn !== false) {
    const command = nativeClipboardCommand(options.env ?? process.env, options.platform ?? process.platform);
    if (command) {
      const delivered = await pipeTo(command, value, options.env);
      if (delivered) via = command[0];
    }
  }

  return { ok: Boolean(via), via };
}

/**
 * Pipe `text` through a clipboard tool. Errors are swallowed: a missing
 * `xclip` is a fact about the machine, not a failure the user can act on while
 * dragging a selection, and the OSC 52 write has already been attempted.
 *
 * @param {string[]} command
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env] overrides on top of the inherited environment
 * @returns {Promise<boolean>}
 */
function pipeTo(command, text, env) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), NATIVE_TIMEOUT_MS);
    timer.unref?.();
    try {
      const child = spawn(command[0], command.slice(1), {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, ...(env ?? {}) },
      });
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
      child.stdin.on("error", () => finish(false));
      child.stdin.end(text);
    } catch {
      finish(false);
    }
  });
}
