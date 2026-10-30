import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { findClosest } from "./matcher.js";
import { sanitizeSlug } from "./util.js";

export const CASSETTE_FORMAT = "llm-vcr/1";

function padSeq(seq) {
  return String(seq).padStart(3, "0");
}

function slugFor(record) {
  const pathname = record.request?.path || "";
  const parts = pathname.split("/").filter(Boolean).slice(-2);
  return sanitizeSlug(`${record.request?.method || "get"}-${parts.join("-")}`);
}

/**
 * A directory of one JSON file per interaction. The directory is the unit you
 * commit and share; each file is readable and diffable on its own.
 */
export class CassetteStore {
  constructor({ dir, logger = null }) {
    this.dir = dir;
    this.logger = logger;
    this.buckets = new Map(); // hash -> { entries, cursor }
    this.recordCursors = new Map();
    this.recordQueues = new Map();
    this.usedFiles = new Set();
    this.bytes = 0;
    this.warnings = [];
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    const entries = await fs.readdir(this.dir, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isFile() || !dirent.name.endsWith(".json")) continue;
      const file = path.join(this.dir, dirent.name);
      let parsed;
      try {
        parsed = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) {
        this.warn(`Skipping unreadable cassette ${dirent.name}: ${error.message}`);
        continue;
      }
      if (parsed?.format !== CASSETTE_FORMAT || !parsed.meta?.hash) {
        this.warn(`Skipping ${dirent.name}: not an llm-vcr/1 cassette`);
        continue;
      }
      const stat = await fs.stat(file);
      parsed.meta.file = dirent.name;
      parsed.meta.id = parsed.meta.id || dirent.name.replace(/\.json$/, "");
      parsed.meta.size = stat.size;
      this.usedFiles.add(dirent.name);
      this.bytes += stat.size;

      let bucket = this.buckets.get(parsed.meta.hash);
      if (!bucket) {
        bucket = { entries: [], cursor: 0 };
        this.buckets.set(parsed.meta.hash, bucket);
      }
      bucket.entries.push(parsed);
    }

    for (const bucket of this.buckets.values()) {
      bucket.entries.sort((a, b) => {
        const seq = (a.meta.seq || 0) - (b.meta.seq || 0);
        if (seq !== 0) return seq;
        return String(a.meta.createdAt).localeCompare(String(b.meta.createdAt));
      });
    }
    return this;
  }

  warn(message) {
    this.warnings.push(message);
    this.logger?.warn?.(message);
  }

  get size() {
    let count = 0;
    for (const bucket of this.buckets.values()) count += bucket.entries.length;
    return count;
  }

  get hashCount() {
    return this.buckets.size;
  }

  stats() {
    return {
      interactions: this.size,
      hashes: this.hashCount,
      bytes: this.bytes,
      dir: this.dir,
    };
  }

  all() {
    const out = [];
    for (const bucket of this.buckets.values()) out.push(...bucket.entries);
    return out.sort((a, b) => {
      const left = String(a.meta.createdAt || "");
      const right = String(b.meta.createdAt || "");
      if (left === right) return 0;
      return left < right ? 1 : -1;
    });
  }

  entriesFor(hash) {
    return this.buckets.get(hash)?.entries || [];
  }

  /** Return the next unplayed recorded response for this request identity. */
  take(hash) {
    const bucket = this.buckets.get(hash);
    if (!bucket) return null;
    if (bucket.cursor >= bucket.entries.length) return null;
    const entry = bucket.entries[bucket.cursor];
    bucket.cursor += 1;
    return entry;
  }

  hasUnplayed(hash) {
    const bucket = this.buckets.get(hash);
    return Boolean(bucket && bucket.cursor < bucket.entries.length);
  }

  closest(incoming, options = {}) {
    return findClosest(this.all(), incoming, options);
  }

  /**
   * Persist an interaction. In `record` mode, the Nth identical request
   * overwrites the Nth existing cassette instead of appending a duplicate.
   * Writes for the same request hash are serialized so concurrent requests
   * cannot pick the same sequence number.
   */
  async record(hash, record, options = {}) {
    const previous = this.recordQueues.get(hash) || Promise.resolve();
    const task = previous.then(() => this._record(hash, record, options));
    const settled = task.catch(() => {});
    this.recordQueues.set(hash, settled);
    try {
      return await task;
    } finally {
      if (this.recordQueues.get(hash) === settled) this.recordQueues.delete(hash);
    }
  }

  async _record(hash, record, { overwrite = false } = {}) {
    let bucket = this.buckets.get(hash);
    if (!bucket) {
      bucket = { entries: [], cursor: 0 };
      this.buckets.set(hash, bucket);
    }

    let existing = null;
    let existingIndex = -1;
    let seq;
    if (overwrite) {
      const index = this.recordCursors.get(hash) || 0;
      existing = bucket.entries[index] || null;
      existingIndex = index;
      this.recordCursors.set(hash, index + 1);
      seq = existing?.meta.seq || this.nextSeq(bucket);
    } else {
      seq = this.nextSeq(bucket);
    }

    const id =
      existing?.meta.id ||
      `${hash.slice(0, 12)}-${padSeq(seq)}-${slugFor(record)}`;
    let filename = existing?.meta.file || `${id}.json`;
    if (!existing && this.usedFiles.has(filename)) {
      filename = `${id}-${randomBytes(2).toString("hex")}.json`;
    }

    const now = new Date().toISOString();
    const entry = {
      format: CASSETTE_FORMAT,
      meta: {
        ...record.meta,
        id,
        hash,
        seq,
        // Keep the original timestamp on re-record so cassette diffs only show
        // actual response changes.
        createdAt: existing?.meta.createdAt || now,
        file: filename,
      },
      request: record.request,
      response: record.response,
    };

    const serialized = `${JSON.stringify(entry, null, 2)}\n`;
    const file = path.join(this.dir, filename);
    const temp = path.join(
      this.dir,
      `${filename}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`,
    );
    await fs.writeFile(temp, serialized, "utf8");
    await fs.rename(temp, file);

    const size = Buffer.byteLength(serialized);
    if (existing) {
      this.bytes += size - (existing.meta.size || 0);
      entry.meta.size = size;
      bucket.entries[existingIndex] = entry;
    } else {
      this.bytes += size;
      bucket.entries.push(entry);
    }
    bucket.entries.sort((a, b) => (a.meta.seq || 0) - (b.meta.seq || 0));

    entry.meta.size = size;
    entry.meta.file = filename;
    this.usedFiles.add(filename);
    return entry;
  }

  nextSeq(bucket) {
    let max = 0;
    for (const entry of bucket.entries) {
      if ((entry.meta.seq || 0) > max) max = entry.meta.seq;
    }
    return max + 1;
  }

  /** Compute a match explanation without consuming a replay cursor. */
  explainMiss(incoming, options = {}) {
    return this.closest(incoming, options);
  }
}

export async function openStore(dir, logger) {
  const store = new CassetteStore({ dir, logger });
  await store.init();
  return store;
}
