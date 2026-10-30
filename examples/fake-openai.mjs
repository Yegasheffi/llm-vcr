import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKENS = ["Hello", " from", " a", " fake", " LLM", " 👋"];
const DELAY_MS = 45;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A dependency-free fake OpenAI endpoint. It streams real SSE chunks so you can
 * try llm-vcr without an API key or network access.
 */
export async function startFakeOpenAI({ port = 11435, host = "127.0.0.1" } = {}) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      // Empty or non-JSON body.
    }

    if (req.url === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model" }] }));
      return;
    }

    if (req.url?.endsWith("/chat/completions") && req.method === "POST") {
      const model = body.model || "fake-model";
      if (body.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const base = {
          id: "chatcmpl-demo",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
        };
        res.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
          })}\n\n`,
        );
        await sleep(20);
        for (const token of TOKENS) {
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [
                { index: 0, delta: { content: token }, finish_reason: null },
              ],
            })}\n\n`,
          );
          await sleep(DELAY_MS);
        }
        res.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-demo",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: TOKENS.join("") },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no fake route for ${req.url}` } }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startFakeOpenAI({
    port: Number(process.env.FAKE_OPENAI_PORT) || 11435,
  });
  process.stdout.write(
    `fake OpenAI listening on ${server.url}\n` +
      `  curl -N ${server.url}/v1/chat/completions \\\n` +
      `    -H 'content-type: application/json' \\\n` +
      `    -d '{"model":"fake-model","stream":true,"messages":[{"role":"user","content":"hi"}]}'\n`,
  );
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
