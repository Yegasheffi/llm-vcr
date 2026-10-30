import crypto from "node:crypto";
import zlib from "node:zlib";

/** True for plain JSON-like objects (not arrays, dates, buffers). */
export function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value)
  );
}

/** Recursively sort object keys so hashes do not depend on property order. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function deepClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function isJsonType(contentType = "") {
  const type = String(contentType).split(";")[0].trim().toLowerCase();
  return (
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/x-ndjson" ||
    type === "application/jsonl"
  );
}

export function isTextType(contentType = "") {
  const type = String(contentType).split(";")[0].trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    isJsonType(type) ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === "application/javascript" ||
    type === "application/x-javascript" ||
    type === "application/graphql" ||
    type === "application/x-www-form-urlencoded" ||
    type === "application/sse"
  );
}

export function isStreamType(contentType = "") {
  const type = String(contentType).split(";")[0].trim().toLowerCase();
  return (
    type === "text/event-stream" ||
    type === "application/x-ndjson" ||
    type === "application/jsonl" ||
    type === "application/json-seq"
  );
}

/**
 * Convert a raw response body into a cassette-friendly representation.
 * JSON is stored parsed so cassette diffs stay readable; other text is stored
 * as UTF-8, and binary payloads are base64 encoded.
 */
export function encodeBody(buffer, contentType = "") {
  if (!buffer || buffer.length === 0) return { body: null, bodyType: "empty" };
  if (isJsonType(contentType)) {
    try {
      return { body: JSON.parse(buffer.toString("utf8")), bodyType: "json" };
    } catch {
      // Fall through to text.
    }
  }
  if (isTextType(contentType)) {
    return { body: buffer.toString("utf8"), bodyType: "text" };
  }
  return { body: buffer.toString("base64"), bodyType: "base64" };
}

export function decodeBody(response) {
  if (!response || response.body === null || response.body === undefined) {
    return Buffer.alloc(0);
  }
  switch (response.bodyType) {
    case "json":
      return Buffer.from(JSON.stringify(response.body), "utf8");
    case "base64":
      return Buffer.from(response.body, "base64");
    case "text":
    default:
      return Buffer.from(String(response.body), "utf8");
  }
}

/** Decompress a buffered body. Node's HTTP client never decompresses by itself. */
export function decompressBuffer(buffer, encoding) {
  const enc = String(encoding || "").trim().toLowerCase();
  if (!enc || enc === "identity") return buffer;
  if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buffer);
  if (enc === "br") return zlib.brotliDecompressSync(buffer);
  if (enc === "zstd" && typeof zlib.zstdDecompressSync === "function") {
    return zlib.zstdDecompressSync(buffer);
  }
  if (enc === "deflate") {
    try {
      return zlib.inflateSync(buffer);
    } catch {
      return zlib.inflateRawSync(buffer);
    }
  }
  return buffer;
}

export function headerString(value) {
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined || value === null ? "" : String(value);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function timeAgo(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "?";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function truncate(value, length = 80) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1))}…`;
}

export function sanitizeSlug(value, maxLength = 42) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "request";
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sleepUntil(targetEpochMs) {
  const delay = targetEpochMs - Date.now();
  return delay <= 0 ? Promise.resolve() : sleep(delay);
}

/** Resolve once the stream asks for more data, or immediately if it is done. */
export function onceDrainOrClose(stream) {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      stream.off("drain", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };
    stream.once("drain", done);
    stream.once("close", done);
    stream.once("error", done);
  });
}

export function envFlag(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  return !/^(0|false|no|off)$/i.test(value);
}
