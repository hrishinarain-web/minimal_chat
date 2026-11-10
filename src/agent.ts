import OpenAI from "openai";
import { assembleContext } from "./context.js";
import { addMessage, conversationWindow } from "./memory.js";
import { dynamicPrompt, STATIC_PROMPT } from "./prompt.js";
import { type SearchArgs, evidenceNote, formatHits, searchWithBaseline } from "./search.js";
import { fmtDay, isoDay } from "./time.js";

const MODEL = () => process.env.MODEL || "gpt-4.1";
const MAX_ROUNDS = 5; // search rounds before we force a final answer

const client = new OpenAI({ maxRetries: 4 }); // reads OPENAI_API_KEY / OPENAI_BASE_URL; retries 429/5xx with backoff

const SEARCH_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current information. Returns ranked results with page excerpts and (when known) publish dates. Call it several times in parallel for independent questions (one entity or sub-question per call). Use specific queries; include product/company names.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Specific search query." },
        since: {
          type: "string",
          description:
            "Optional YYYY-MM-DD. Only return pages published on/after this date. Use for 'what changed/new since X'.",
        },
        news: { type: "boolean", description: "Set true for announcements/launches/news-style questions." },
        thorough: {
          type: "boolean",
          description: "Set true for hard-to-find specifics like exact pricing tables (slower).",
        },
      },
      required: ["query"],
    },
  },
};

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "status"; message: string }
  | { type: "search"; query: string; since?: string }
  | { type: "sources"; sources: { title: string; url: string; date?: string }[] }
  | { type: "error"; message: string }
  | { type: "done" };

export interface TurnInput {
  userId: string;
  convId: string;
  message: string;
  tz: string;
  now: Date;
  signal?: AbortSignal;
}

export async function runTurn(input: TurnInput, emit: (e: AgentEvent) => void): Promise<string> {
  const { userId, convId, message, tz, now, signal } = input;
  const startedAt = Date.now();

  // Window first (before adding this message) so context assembly can dedupe against it.
  const window = conversationWindow(convId, 12);
  const liveIds = new Set(window.map((m) => m.id));
  addMessage({ userId, convId, role: "user", content: message, ts: now.getTime() });

  const ctx = assembleContext({ userId, message, now, tz, liveIds });
  if (ctx.dateRefs.length) emit({ type: "status", message: `Looking up ${ctx.dateRefs.map((d) => d.text).join(", ")}…` });

  const dateNotes = ctx.dateRefs.length
    ? `Date phrases in the user's message resolve to: ${ctx.dateRefs
        .map((d) => `"${d.text}" = ${fmtDay(d.from, tz)}${d.from.toDateString() === d.to.toDateString() ? "" : " to " + fmtDay(d.to, tz)}`)
        .join("; ")}. (ISO: ${ctx.dateRefs.map((d) => isoDay(d.from, tz)).join(", ")})`
    : "";

  // Static prefix first: OpenAI caches identical prompt prefixes automatically.
  const system = STATIC_PROMPT + "\n\n" + dynamicPrompt(now, tz, ctx.memoryBlock, dateNotes);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...window.map((m) => ({ role: m.role, content: m.content }) as OpenAI.Chat.ChatCompletionMessageParam),
    { role: "user", content: message },
  ];

  const queries: string[] = [];
  const sources = new Map<string, { title: string; url: string; date?: string }>();
  let answer = "";

  try {
    for (let round = 0; ; round++) {
      const stream = await client.chat.completions.create(
        {
          model: MODEL(),
          stream: true,
          messages,
          tools: [SEARCH_TOOL],
          tool_choice: round >= MAX_ROUNDS ? "none" : "auto", // last round: force an answer
          // Optional: cuts latency on reasoning models (low|minimal|none). Unset = provider default.
          ...(process.env.REASONING_EFFORT ? ({ reasoning_effort: process.env.REASONING_EFFORT } as object) : {}),
        },
        { signal },
      );

      let roundText = "";
      const calls: { id: string; name: string; args: string; extra?: unknown }[] = [];
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          roundText += delta.content;
          emit({ type: "text", delta: delta.content });
        }
        for (const tc of delta.tool_calls ?? []) {
          // Some OpenAI-compatible providers (e.g. Gemini) omit `index` or send whole calls per chunk:
          // fall back to matching by id, else treat it as a new call.
          const idx = tc.index ?? (tc.id ? calls.findIndex((x) => x?.id === tc.id) : calls.length - 1);
          const c = (calls[idx >= 0 ? idx : calls.length] ??= { id: "", name: "", args: "" });
          if (tc.id) c.id = tc.id;
          // Gemini 3 "thought signatures" arrive here and must be echoed back with the tool call.
          const extra = (tc as { extra_content?: unknown }).extra_content;
          if (extra) c.extra = extra;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
        }
      }
      answer += roundText;
      calls.forEach((c, i) => (c.id ||= `call_${round}_${i}`)); // some providers send no ids
      if (!calls.length) break;

      // If the model narrated before calling tools, keep paragraphs apart in the final text.
      if (roundText.trim()) {
        answer += "\n\n";
        emit({ type: "text", delta: "\n\n" });
      }

      messages.push({
        role: "assistant",
        content: roundText || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.args },
          ...(c.extra ? { extra_content: c.extra } : {}),
        })),
      });

      // Parallel tool execution: independent searches run concurrently.
      const results = await Promise.all(
        calls.map(async (call): Promise<OpenAI.Chat.ChatCompletionToolMessageParam> => {
          let args: SearchArgs;
          try {
            args = JSON.parse(call.args || "{}");
            if (typeof args.query !== "string" || !args.query) throw new Error("missing query");
          } catch {
            return { role: "tool", tool_call_id: call.id, content: "Error: invalid arguments; query (string) is required." };
          }
          queries.push(args.query);
          emit({ type: "search", query: args.query, since: args.since });
          try {
            const hits = await searchWithBaseline(args);
            for (const h of hits) if (!sources.has(h.url)) sources.set(h.url, { title: h.title, url: h.url, date: h.date });
            return { role: "tool", tool_call_id: call.id, content: formatHits(hits) + evidenceNote(hits, args) };
          } catch (err) {
            return {
              role: "tool",
              tool_call_id: call.id,
              content: `Search error: ${(err as Error).message}. You may retry once with a different query, or answer and say the search failed.`,
            };
          }
        }),
      );
      messages.push(...results);
    }
  } catch (err) {
    if (signal?.aborted) return answer;
    emit({ type: "error", message: (err as Error).message });
    throw err;
  }

  // Persist the answer with the evidence it used: a later "is that still right?" needs it as baseline.
  const srcList = [...sources.values()];
  const cited = srcList.filter((s) => answer.includes(s.url));
  addMessage({
    userId,
    convId,
    role: "assistant",
    content: answer.trim(),
    ts: now.getTime() + Math.max(1, Date.now() - startedAt), // stays on the (possibly overridden) clock
    meta: { queries, sources: cited.length ? cited : srcList.slice(0, 8) },
  });
  if (cited.length) emit({ type: "sources", sources: cited });
  emit({ type: "done" });
  return answer;
}
