// Session persistence: append-only JSONL, one file per session.
//
// Append-only is the right shape for an agent transcript: a crash loses at
// most the last line, and `zeke resume` can replay exactly what happened.

import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { paths, projectSlug } from "../lib/paths.js";

/**
 * @typedef {object} SessionRecord
 * @property {string} type    "meta" | "message" | "compact" | "event"
 * @property {number} ts
 * @property {any} [data]
 */

export class SessionStore {
  /** @type {string} */
  #dir;
  /** @type {string} */
  #file;
  /** @type {SessionRecord[]} */
  #records = [];
  #meta;

  /**
   * @param {{cwd?: string, id?: string, title?: string, model?: string}} [options]
   */
  constructor(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    this.slug = projectSlug(cwd);
    this.cwd = cwd;
    this.id = options.id ?? newSessionId();
    this.#dir = path.join(paths.sessions, this.slug);
    this.#file = paths.sessionFile(this.slug, this.id);
    this.#meta = {
      id: this.id,
      cwd,
      title: options.title ?? null,
      model: options.model ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  get file() {
    return this.#file;
  }

  get meta() {
    return this.#meta;
  }

  get records() {
    return this.#records;
  }

  /** Start (or re-open) the file on disk. */
  async open() {
    await mkdir(this.#dir, { recursive: true });
    let exists = false;
    try {
      await stat(this.#file);
      exists = true;
    } catch {
      // new session
    }

    if (exists) {
      this.#records = await readSessionFile(this.#file);
      // Meta is appended, not rewritten, so every meta record contributes and
      // the latest value for a field wins.
      for (const record of this.#records) {
        if (record.type === "meta" && record.data) this.#meta = { ...this.#meta, ...record.data };
      }
      this.#meta.id = this.id;
    } else {
      await this.append({ type: "meta", data: this.#meta });
    }
    return this;
  }

  /**
   * @param {SessionRecord} record
   */
  async append(record) {
    const stamped = { ...record, ts: record.ts ?? Date.now() };
    this.#records.push(stamped);
    await appendFile(this.#file, `${JSON.stringify(stamped)}\n`, "utf8");
    if (record.type !== "meta") {
      this.#meta.updatedAt = stamped.ts;
    }
    return stamped;
  }

  /** @param {import("../core/types.js").Message} message */
  appendMessage(message) {
    return this.append({ type: "message", data: message });
  }

  /** Replace the working history after a compaction. */
  appendCompaction(summary, droppedCount) {
    return this.append({ type: "compact", data: { summary, droppedCount } });
  }

  async setTitle(title) {
    this.#meta.title = title;
    return this.append({ type: "meta", data: { ...this.#meta } });
  }

  /** Messages in replay order, honouring compaction boundaries. */
  messages() {
    /** @type {import("../core/types.js").Message[]} */
    const out = [];
    for (const record of this.#records) {
      if (record.type === "compact") {
        out.length = 0;
        out.push({ role: "user", content: `<context-summary>\n${record.data.summary}\n</context-summary>` });
        continue;
      }
      if (record.type === "message") out.push(record.data);
    }
    return out;
  }

  /**
   * List sessions for this project, newest first.
   * @param {string} [cwd]
   */
  static async list(cwd = process.cwd()) {
    const dir = path.join(paths.sessions, projectSlug(cwd));
    let files;
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const sessions = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = path.join(dir, file);
      try {
        const info = await stat(full);
        const head = await readSessionMeta(full);
        sessions.push({ id: file.replace(/\.jsonl$/, ""), file: full, mtimeMs: info.mtimeMs, size: info.size, ...head });
      } catch {
        // a partially written file is not worth failing the listing for
      }
    }
    return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /** Load a session by id. */
  static async load(id, cwd = process.cwd()) {
    const store = new SessionStore({ cwd, id });
    await store.open();
    return store;
  }
}

function newSessionId() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

export async function readSessionFile(file) {
  const text = await readFile(file, "utf8");
  /** @type {SessionRecord[]} */
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn final line is the only expected corruption; skip it.
    }
  }
  return records;
}

/**
 * Merge every meta record in a session file. Meta is appended rather than
 * rewritten, so a title set after creation lives in a later record.
 */
export async function readSessionMeta(file) {
  const text = await readFile(file, "utf8");
  /** @type {Record<string, unknown>} */
  const meta = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a torn line carries no metadata
    }
    if (record.type === "meta" && record.data) Object.assign(meta, record.data);
  }
  return { title: meta.title ?? null, model: meta.model ?? null, createdAt: meta.createdAt ?? null };
}
