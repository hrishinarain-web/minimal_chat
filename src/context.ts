import * as chrono from "chrono-node";
import {
  type StoredMessage,
  messagesInRange,
  promptOf,
  replyTo,
  searchMessages,
} from "./memory.js";
import { endOfDay, fmt, fmtDay, startOfDay, tzOffsetMinutes } from "./time.js";

/**
 * Context assembly: runs BEFORE the model, in plain code.
 *   1. Resolve date phrases ("last Tuesday", "3 November") to exact local-day ranges.
 *   2. Pull the matching past exchanges from the store.
 *   3. Render them as a timestamped block the model can quote and re-verify.
 * Memory is deliberately not a model tool: it is faster, cannot be skipped by the model,
 * and keeps the agent's tool surface at exactly one (web search).
 */

export interface DateRef {
  text: string;
  from: Date;
  to: Date;
}

export function resolveDates(message: string, now: Date, tz: string): DateRef[] {
  const ref = { instant: now, timezone: tzOffsetMinutes(now, tz) };
  const out: DateRef[] = [];
  for (const r of chrono.parse(message, ref, { forwardDate: false })) {
    let start = r.start.date();
    // People talk about the past here: a bare weekday / yearless date that lands in the
    // future means the previous occurrence ("on Monday we shortlisted..." said on Wednesday
    // is fine, but said on Sunday must mean last Monday, not tomorrow).
    if (start.getTime() > now.getTime() + 3600_000 && !r.start.isCertain("year")) {
      const weekdayOnly = r.start.isCertain("weekday") && !r.start.isCertain("day");
      start = weekdayOnly
        ? new Date(start.getTime() - 7 * 86400_000)
        : new Date(start.setFullYear(start.getFullYear() - 1));
    }
    if (start.getTime() > now.getTime() + 3600_000) continue; // still future: not a memory ref
    let end = r.end ? r.end.date() : start;
    if (end < start) end = start;
    out.push({ text: r.text, from: startOfDay(start, tz), to: endOfDay(end, tz) });
  }
  return out;
}

const RECALL_CUE =
  /\b(did i (ask|say|mention)|i (asked|told|said|mentioned)|you (said|told|answered|recommended|suggested|gave)|we (shortlisted|discussed|talked|looked|chose|picked|decided)|earlier|before|last time|previous(ly)?|still (correct|true|right|valid|accurate|hold)|since (then|we|i|you)|changed since|as i (said|mentioned))\b/i;

const STOP = new Set(
  "the and for are but not you your yours this that with have has had was were what when where which who how why did does can could would should will just about from into over than then them they there their been being any all some more most other our out has its it's i'm do is of to in on at a an or if me my we us as be by so no yes ask asked tell told said say monday tuesday wednesday thursday friday saturday sunday last week yesterday today still correct today changed since answer question".split(
    " ",
  ),
);

function keywords(message: string): string[] {
  return [...new Set(message.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 8);
}

interface Exchange {
  user: StoredMessage | null;
  assistant: StoredMessage | null;
  ts: number;
}

function toExchanges(msgs: StoredMessage[], exclude: Set<number>): Exchange[] {
  const byKey = new Map<number, Exchange>();
  for (const m of msgs) {
    if (exclude.has(m.id)) continue;
    const user = m.role === "user" ? m : promptOf(m);
    const assistant = m.role === "assistant" ? m : replyTo(m);
    const key = user?.id ?? -m.id;
    if (!byKey.has(key)) byKey.set(key, { user, assistant, ts: (user ?? assistant)!.ts });
  }
  return [...byKey.values()].sort((a, b) => a.ts - b.ts);
}

function renderExchange(e: Exchange, tz: string): string {
  const lines: string[] = [];
  if (e.user) lines.push(`[${fmt(e.user.ts, tz)}] USER: ${e.user.content}`);
  if (e.assistant) {
    lines.push(`[${fmt(e.assistant.ts, tz)}] YOU ANSWERED: ${truncate(e.assistant.content, 3500)}`);
    const q = e.assistant.meta?.queries;
    if (q?.length) lines.push(`  (searches you ran then: ${q.join(" | ")})`);
    const s = e.assistant.meta?.sources;
    if (s?.length) lines.push(`  (sources you used then: ${s.slice(0, 8).map((x) => x.url).join(", ")})`);
  } else if (e.user) {
    lines.push("  (no answer was stored for this message)");
  }
  return lines.join("\n");
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …[truncated]" : s);

export interface AssembledContext {
  /** Text to place in the system prompt; empty string when nothing relevant. */
  memoryBlock: string;
  dateRefs: DateRef[];
  retrieved: number;
}

export function assembleContext(opts: {
  userId: string;
  message: string;
  now: Date;
  tz: string;
  liveIds: Set<number>; // messages already sent to the model verbatim; do not duplicate
}): AssembledContext {
  const { userId, message, now, tz, liveIds } = opts;
  const dateRefs = resolveDates(message, now, tz);
  const cue = RECALL_CUE.test(message);
  const sections: string[] = [];
  let retrieved = 0;

  // 1) Exact date lookups.
  for (const d of dateRefs) {
    const ex = toExchanges(messagesInRange(userId, d.from.getTime(), d.to.getTime()), liveIds);
    const label =
      d.from.getTime() === startOfDay(d.to, tz).getTime()
        ? fmtDay(d.from, tz)
        : `${fmtDay(d.from, tz)} to ${fmtDay(d.to, tz)}`;
    if (ex.length) {
      retrieved += ex.length;
      sections.push(`Stored conversation on "${d.text}" (${label}):\n\n${ex.map((e) => renderExchange(e, tz)).join("\n\n")}`);
    } else {
      sections.push(`Stored conversation on "${d.text}" (${label}): NONE FOUND. You have no record of any exchange on that date.`);
    }
  }

  // 2) Topic recall, if the user is clearly referring back and dates did not already hit.
  const dateHit = sections.some((s) => !s.includes("NONE FOUND"));
  if ((cue || dateRefs.length) && !dateHit) {
    const hits = searchMessages(userId, keywords(message), 6);
    const ex = toExchanges(hits, liveIds).slice(-3);
    if (ex.length) {
      retrieved += ex.length;
      sections.push(
        `Possibly related earlier exchanges (matched by topic keywords, so they may NOT be what the user means; check before relying on them):\n\n${ex.map((e) => renderExchange(e, tz)).join("\n\n")}`,
      );
    }
  }

  return {
    memoryBlock: sections.length ? sections.join("\n\n---\n\n") : "",
    dateRefs,
    retrieved,
  };
}
