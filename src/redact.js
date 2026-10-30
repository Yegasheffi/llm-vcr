import { isPlainObject } from "./util.js";

export const REDACTED = "[REDACTED]";

const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "api-key",
  "apikey",
  "x-api-key",
  "x-goog-api-key",
  "x-amz-security-token",
  "cookie",
  "set-cookie",
  "x-csrf-token",
]);

const SECRET_HEADER_PATTERN =
  /(^|[-_])(api[-_]?key|apikey|token|secret|password|authorization|cookie|signature|credential)s?($|[-_])/i;

export const SECRET_QUERY_KEYS = new Set([
  "key",
  "api_key",
  "api-key",
  "apikey",
  "access_token",
  "token",
  "client_secret",
  "password",
  "sig",
  "signature",
  "credential",
  "authorization",
]);

export function isSecretHeader(name) {
  const lower = String(name).toLowerCase();
  return SECRET_HEADER_NAMES.has(lower) || SECRET_HEADER_PATTERN.test(lower);
}

export function isSecretQueryKey(name) {
  return SECRET_QUERY_KEYS.has(String(name).toLowerCase());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the string scrubber used before anything is written to disk.
 *
 * By default, values of environment variables that look like credentials are
 * scrubbed too (OPENAI_API_KEY, ANTHROPIC_AUTH_TOKEN, AWS_SECRET_ACCESS_KEY,
 * ...). Extra names and regexes can be supplied from the CLI or config.
 */
export function createScrubber({
  envNames = [],
  patterns = [],
  env = process.env,
  autoScrubEnv = true,
} = {}) {
  const rules = [];
  const names = new Set(envNames);

  if (autoScrubEnv) {
    for (const [name, value] of Object.entries(env || {})) {
      if (
        typeof value === "string" &&
        value.length >= 8 &&
        /(API_?KEY|SECRET|TOKEN|PASSWORD|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(name)
      ) {
        names.add(name);
      }
    }
  }

  for (const name of names) {
    const value = env?.[name];
    if (typeof value !== "string" || value.length < 6) continue;
    rules.push({
      from: new RegExp(escapeRegExp(value), "g"),
      to: `[REDACTED:${name}]`,
    });
  }

  for (const pattern of patterns) {
    let regex;
    if (pattern instanceof RegExp) {
      regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    } else {
      try {
        regex = new RegExp(String(pattern), "g");
      } catch {
        continue;
      }
    }
    rules.push({ from: regex, to: REDACTED });
  }

  // Longest secrets first, so a short key cannot partially mask a longer one.
  rules.sort((a, b) => b.from.source.length - a.from.source.length);

  function scrubString(value) {
    let out = String(value);
    for (const rule of rules) {
      rule.from.lastIndex = 0;
      out = out.replace(rule.from, rule.to);
    }
    return out;
  }

  function scrubDeep(value) {
    if (typeof value === "string") return scrubString(value);
    if (Array.isArray(value)) return value.map(scrubDeep);
    if (isPlainObject(value)) {
      const out = {};
      for (const [key, val] of Object.entries(value)) out[key] = scrubDeep(val);
      return out;
    }
    return value;
  }

  return { scrubString, scrubDeep, rules, envNames: [...names] };
}

/** Redact credential headers while keeping header names for readability. */
export function redactHeaders(headers = {}, scrubber) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (isSecretHeader(name)) {
      out[name] = REDACTED;
      continue;
    }
    const scrubbed = Array.isArray(value)
      ? value.map((item) => scrubber.scrubString(String(item)))
      : scrubber.scrubString(String(value));
    out[name] = scrubbed;
  }
  return out;
}

/** Redact query entries while preserving duplicate keys and their order. */
export function redactQueryEntries(entries, scrubber) {
  return entries.map(([key, value]) => [
    key,
    isSecretQueryKey(key) ? REDACTED : scrubber.scrubString(String(value)),
  ]);
}

export function redactQuery(entries, scrubber) {
  const out = {};
  for (const [key, value] of redactQueryEntries(entries, scrubber)) {
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

/** Redacted URL string used in logs and cassettes. */
export function redactUrl(input, scrubber) {
  try {
    const url = new URL(input);
    const entries = redactQueryEntries([...url.searchParams.entries()], scrubber);
    const params = new URLSearchParams();
    for (const [key, value] of entries) params.append(key, value);
    const search = params.toString();
    return `${url.origin}${url.pathname}${search ? `?${search}` : ""}`;
  } catch {
    return scrubber.scrubString(String(input));
  }
}

/** Headers used in the request signature (credential headers are ignored). */
export function signatureHeaders(headers, matchHeaders) {
  const out = {};
  for (const name of matchHeaders) {
    const key = name.toLowerCase();
    if (isSecretHeader(key)) continue;
    const value = headers[key];
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}
