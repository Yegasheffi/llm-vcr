/**
 * Known LLM API endpoints. A route maps a local path prefix to an upstream
 * base URL, e.g. /openai/v1/chat/completions -> https://api.openai.com/v1/...
 *
 * `env` describes variables to inject for `llm-vcr run`. The value is the
 * path suffix appended to the proxy URL for that route.
 */
export const PROVIDERS = {
  openai: {
    label: "OpenAI",
    target: "https://api.openai.com",
    env: { OPENAI_BASE_URL: "/v1", OPENAI_API_BASE: "/v1" },
  },
  anthropic: {
    label: "Anthropic",
    target: "https://api.anthropic.com",
    env: { ANTHROPIC_BASE_URL: "" },
  },
  google: {
    label: "Google Gemini",
    target: "https://generativelanguage.googleapis.com",
    env: {
      GOOGLE_GEMINI_BASE_URL: "",
      GOOGLE_GENAI_BASE_URL: "",
    },
  },
  ollama: {
    label: "Ollama",
    target: "http://127.0.0.1:11434",
    env: { OLLAMA_HOST: "" },
  },
  groq: {
    label: "Groq",
    target: "https://api.groq.com/openai",
  },
  mistral: {
    label: "Mistral",
    target: "https://api.mistral.ai",
  },
  deepseek: {
    label: "DeepSeek",
    target: "https://api.deepseek.com",
  },
  openrouter: {
    label: "OpenRouter",
    target: "https://openrouter.ai/api",
  },
  together: {
    label: "Together AI",
    target: "https://api.together.xyz",
  },
  xai: {
    label: "xAI",
    target: "https://api.x.ai",
  },
  cohere: {
    label: "Cohere",
    target: "https://api.cohere.com",
  },
  fireworks: {
    label: "Fireworks",
    target: "https://api.fireworks.ai/inference",
  },
  perplexity: {
    label: "Perplexity",
    target: "https://api.perplexity.ai",
  },
};

/** Routes installed by default. You can override any of them via config. */
export const DEFAULT_ROUTE_PREFIXES = [
  "/openai",
  "/anthropic",
  "/google",
  "/ollama",
  "/groq",
  "/mistral",
  "/deepseek",
  "/openrouter",
  "/together",
  "/xai",
  "/cohere",
  "/fireworks",
  "/perplexity",
];

export function defaultRoutes() {
  return DEFAULT_ROUTE_PREFIXES.map((prefix) => {
    const provider = prefix.slice(1);
    const preset = PROVIDERS[provider];
    return {
      prefix,
      target: preset.target,
      provider,
      label: preset.label,
      env: preset.env,
    };
  });
}

export function getProvider(name) {
  const key = String(name || "").toLowerCase();
  if (!PROVIDERS[key]) {
    throw new Error(
      `Unknown provider "${name}". Known providers: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return { name: key, ...PROVIDERS[key] };
}
