import fs from "node:fs";
import { formatDuration, truncate } from "./util.js";

export const VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const COLORS = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
};

function paint(enabled, color, text) {
  return enabled ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

function statusColor(status) {
  if (status >= 500) return "red";
  if (status >= 400) return "yellow";
  if (status >= 300) return "cyan";
  return "green";
}

export function createLogger({
  quiet = false,
  verbose = false,
  color = false,
  version = VERSION,
} = {}) {
  const stdout = process.stdout;
  const stderr = process.stderr;
  const c = (name, text) => paint(color, name, text);

  const logger = {
    quiet,
    verbose,
    color,
    version,

    info(message = "") {
      if (quiet) return;
      stdout.write(`${message}\n`);
    },

    debug(message) {
      if (!verbose) return;
      stdout.write(`${c("gray", `llm-vcr: ${message}`)}\n`);
    },

    warn(message) {
      stderr.write(`${c("yellow", "llm-vcr: warning:")} ${message}\n`);
    },

    error(message) {
      stderr.write(`${c("red", "llm-vcr: error:")} ${message}\n`);
    },

    request(info) {
      if (quiet) return;
      const {
        method,
        path: requestPath,
        status,
        mode,
        durationMs,
        chunks,
        id,
        route,
        error,
      } = info;
      const label = {
        record: c("green", "● REC "),
        replay: c("cyan", "○ PLAY"),
        passthrough: c("gray", "→ PASS"),
        miss: c("red", "✗ MISS"),
        error: c("red", "✗ ERR "),
      }[mode] || mode;
      const statusText = status
        ? c(statusColor(status), String(status))
        : c("red", "---");
      const parts = [
        c("bold", String(method).padEnd(6)),
        truncate(requestPath, 54).padEnd(56),
        statusText.padEnd(4),
      ];
      if (chunks !== undefined && chunks > 0) {
        parts.push(c("gray", `${chunks} chunks`.padEnd(10)));
      }
      if (durationMs !== undefined) {
        parts.push(c("gray", formatDuration(durationMs).padStart(7)));
      }
      parts.push(label);
      if (id) parts.push(c("gray", id.slice(0, 18)));
      if (error) parts.push(c("red", `— ${error}`));
      if (verbose && route) parts.push(c("gray", `→ ${route}`));
      stdout.write(`${parts.join("  ")}\n`);
    },

    banner(config, { url, store, command = null, env = null } = {}) {
      if (quiet) return;
      const stats = store?.stats?.() || { interactions: 0 };
      const lines = [];
      lines.push("");
      lines.push(
        `${c("bold", "llm-vcr")} ${c("gray", `v${version}`)}  ${c(
          "dim",
          "record & replay for any LLM SDK — streaming included",
        )}`,
      );
      lines.push("");
      lines.push(`  ${c("gray", "proxy     ")} ${c("cyan", url)}`);
      lines.push(
        `  ${c("gray", "mode      ")} ${modeLabel(config.mode)}${c("gray", `  ·  replay speed ${config.speed === 0 ? "instant" : `${config.speed}×`}`)}`,
      );
      lines.push(
        `  ${c("gray", "cassettes ")} ${config.cassetteDir} ${c("gray", `(${stats.interactions} interaction${stats.interactions === 1 ? "" : "s"})`)}`,
      );
      if (config.configFile) {
        lines.push(`  ${c("gray", "config    ")} ${config.configFile}`);
      }
      lines.push("");

      const priority = ["/openai", "/anthropic", "/google", "/ollama"];
      const shown = config.routes
        .filter((route) => route.prefix !== "/")
        .sort((a, b) => {
          const ai = priority.indexOf(a.prefix);
          const bi = priority.indexOf(b.prefix);
          if (ai !== -1 || bi !== -1) {
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          }
          return a.prefix.localeCompare(b.prefix);
        });
      const defaultRoute = config.routes.find((route) => route.prefix === "/");
      const visible = verbose ? shown : shown.slice(0, 6);
      lines.push(`  ${c("gray", "routes")}`);
      for (const route of visible) {
        const target = route.target.replace(/^https?:\/\//, "");
        lines.push(
          `    ${c("magenta", route.prefix.padEnd(12))} ${c("gray", "→")} ${target}`,
        );
      }
      if (!verbose && shown.length > visible.length) {
        lines.push(
          `    ${c("gray", `… ${shown.length - visible.length} more  (re-run with --verbose to list all)`)}`,
        );
      }
      if (defaultRoute) {
        const target = defaultRoute.target.replace(/^https?:\/\//, "");
        lines.push(`    ${c("gray", "(no prefix)")} ${c("gray", "→")} ${target}`);
      }
      lines.push("");

      if (env && Object.keys(env).length > 0) {
        lines.push(`  ${c("gray", "point your SDK at the proxy")}`);
        const preferred = [
          ["OPENAI_BASE_URL", "OpenAI"],
          ["ANTHROPIC_BASE_URL", "Anthropic"],
          ["GOOGLE_GEMINI_BASE_URL", "Gemini"],
          ["OLLAMA_HOST", "Ollama"],
        ];
        for (const [name, label] of preferred) {
          if (env[name]) {
            lines.push(
              `    ${c("gray", label.padEnd(10))} ${name}=${c("cyan", env[name])}`,
            );
          }
        }
        lines.push("");
      }

      if (command) {
        lines.push(`  ${c("gray", "$")} ${command.join(" ")}`);
        lines.push("");
      } else {
        lines.push(`  ${c("green", "ready")}${c("gray", " — waiting for requests (ctrl-c to stop)")}`);
        lines.push("");
      }
      stdout.write(`${lines.join("\n")}\n`);
    },

    summary(counters) {
      if (quiet) return;
      const bits = [
        `${counters.recorded} recorded`,
        `${counters.replayed} replayed`,
      ];
      if (counters.passthrough) bits.push(`${counters.passthrough} passed through`);
      if (counters.misses) bits.push(c("red", `${counters.misses} missed`));
      if (counters.errors) bits.push(c("red", `${counters.errors} errors`));
      stdout.write(`\n  ${c("gray", "done")} · ${bits.join(c("gray", " · "))}\n\n`);
    },
  };

  return logger;
}

function modeLabel(mode) {
  const descriptions = {
    auto: "auto      (replay when possible, record misses)",
    record: "record    (always hit upstream, update cassettes)",
    replay: "replay    (offline, fail on missing interactions)",
    passthrough: "passthrough (proxy only, no cassettes)",
  };
  return descriptions[mode] || mode;
}

export const nullLogger = {
  info() {},
  debug() {},
  warn() {},
  error() {},
  request() {},
  banner() {},
  summary() {},
};
