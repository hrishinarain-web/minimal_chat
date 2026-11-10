import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { type AgentEvent, runTurn } from "./agent.js";
import { addMessage, listConversation } from "./memory.js";
import { isValidTz, systemTz } from "./time.js";

const app = new Hono();
const INDEX = () => readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

app.get("/", (c) => c.html(INDEX()));

app.get("/api/conversation/:id", (c) =>
  c.json(listConversation(c.req.param("id")).map((m) => ({ role: m.role, content: m.content, ts: m.ts, meta: m.meta }))),
);

/**
 * POST /api/chat  { message, conversationId?, userId?, tz?, now? }  -> SSE of AgentEvent
 *  - userId defaults to "default": memory spans conversations for the same user.
 *  - tz is an IANA zone; defaults to DEFAULT_TZ / system tz. Drives all date resolution.
 *  - now (ISO) overrides the clock; used by evals and for testing "what changed since" offline.
 */
app.post("/api/chat", async (c) => {
  const body = await c.req.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return c.json({ error: "message is required" }, 400);

  const tz = typeof body.tz === "string" && isValidTz(body.tz) ? body.tz : systemTz();
  const now = body.now ? new Date(body.now) : new Date();
  if (Number.isNaN(now.getTime())) return c.json({ error: "invalid now" }, 400);
  const userId = typeof body.userId === "string" && body.userId ? body.userId : "default";
  const convId = typeof body.conversationId === "string" && body.conversationId ? body.conversationId : randomUUID();

  return streamSSE(c, async (stream) => {
    const send = (e: AgentEvent | { type: "meta"; conversationId: string }) =>
      stream.writeSSE({ data: JSON.stringify(e) });
    await send({ type: "meta", conversationId: convId });
    const ctl = new AbortController();
    stream.onAbort(() => ctl.abort()); // user closed the tab / pressed stop: cancel model + searches
    try {
      await runTurn({ userId, convId, message, tz, now, signal: ctl.signal }, (e) => void send(e));
    } catch {
      // runTurn already emitted the error event to the client
    }
  });
});

/**
 * POST /api/seed  { userId?, messages: [{ role, content, ts (ISO|ms), conversationId? }] }
 * Import earlier conversation history with real timestamps (for testing and for hosts that
 * replay prior sessions). Consecutive messages sharing a conversationId form one exchange.
 */
app.post("/api/seed", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.messages)) return c.json({ error: "messages[] is required" }, 400);
  const userId = typeof body.userId === "string" && body.userId ? body.userId : "default";
  let n = 0;
  for (const m of body.messages) {
    const ts = typeof m.ts === "number" ? m.ts : Date.parse(m.ts);
    if (!["user", "assistant"].includes(m.role) || typeof m.content !== "string" || Number.isNaN(ts)) {
      return c.json({ error: `bad message at index ${n}` }, 400);
    }
    addMessage({ userId, convId: m.conversationId || "seed", role: m.role, content: m.content, ts, meta: m.meta });
    n++;
  }
  return c.json({ imported: n });
});

const port = Number(process.env.PORT) || 3000;
for (const k of ["OPENAI_API_KEY", "TAVILY_API_KEY"]) {
  if (!process.env[k]) console.warn(`⚠  ${k} is not set. Copy .env.example to .env and fill it in.`);
}
serve({ fetch: app.fetch, port }, () => console.log(`Chat agent on http://localhost:${port}`));
