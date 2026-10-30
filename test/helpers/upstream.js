import http from "node:http";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A tiny fake OpenAI/Anthropic-compatible upstream used by the test suite.
 * It streams SSE chunks with configurable delays, returns JSON, binary audio,
 * and records every request it receives.
 */
export async function startUpstream({ delays = [2, 20, 20, 5] } = {}) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const bodyText = rawBody.toString("utf8");
    let body = {};
    try {
      body = JSON.parse(bodyText);
    } catch {
      // Not JSON.
    }
    hits.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
      bodyText,
    });

    const url = new URL(req.url, "http://upstream.test");

    if (url.pathname.endsWith("/chat/completions")) {
      const model = body.model || "fake-model";
      if (body.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "x-fake-upstream": "yes",
        });
        const payloads = [
          `data: ${JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: { content: " 世界 👋" }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
          "data: [DONE]\n\n",
        ];
        // Split one payload at an arbitrary point, including inside a
        // multi-byte character, to exercise UTF-8 reassembly.
        const parts = [payloads[0], payloads[1], payloads[2], payloads[3], payloads[4]];
        for (let index = 0; index < parts.length; index += 1) {
          if (index === 2) {
            const buffer = Buffer.from(parts[index], "utf8");
            const split = buffer.indexOf(Buffer.from("世"));
            res.write(buffer.subarray(0, split + 1));
            await sleep(delays[Math.min(index, delays.length - 1)]);
            res.write(buffer.subarray(split + 1));
          } else {
            res.write(parts[index]);
          }
          await sleep(delays[Math.min(index, delays.length - 1)]);
        }
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello from the fake upstream." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
        }),
      );
      return;
    }

    if (url.pathname.endsWith("/messages")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-fake-upstream": "yes",
      });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { id: "msg_fake", model: body.model || "claude-fake", usage: { input_tokens: 3 } },
        })}\n\n`,
      );
      await sleep(delays[1]);
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        })}\n\n`,
      );
      await sleep(delays[1]);
      res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      res.end();
      return;
    }

    if (url.pathname.endsWith("/audio/speech")) {
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": "8",
      });
      res.end(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]));
      return;
    }

    if (url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model" }] }));
      return;
    }

    if (url.pathname.endsWith("/echo")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          echoedAuthorization: req.headers.authorization || null,
          echoed: body,
          note: "this response intentionally echoes credentials",
        }),
      );
      return;
    }

    if (url.pathname.endsWith("/fail")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "upstream exploded", code: "boom" } }));
      return;
    }

    if (url.pathname.endsWith("/compressed")) {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      const { gzipSync } = await import("node:zlib");
      res.end(gzipSync(JSON.stringify({ compressed: true, ok: true })));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no fake route for ${url.pathname}` } }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
}
