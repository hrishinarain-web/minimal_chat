// Offline tests for the deterministic half of the agent (no API keys needed): `npm test`.
process.env.DB_PATH = ":memory:";
import test from "node:test";
import assert from "node:assert/strict";

const { resolveDates, assembleContext } = await import("../src/context.js");
const { addMessage } = await import("../src/memory.js");
const { isoDay } = await import("../src/time.js");
const { isOfficial } = await import("../src/search.js");

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-11-10T09:00:00+05:30"); // Tuesday
const day = (s: string) => isoDay(resolveDates(s, NOW, TZ)[0].from, TZ);

test("relative dates resolve against the clock, in the user's timezone", () => {
  assert.equal(day("Last Tuesday I asked about Postgres hosting"), "2026-11-03");
  assert.equal(day("On Monday we shortlisted 5 CRM tools"), "2026-11-09");
  assert.equal(day("What did I ask you on 3 November?"), "2026-11-03");
  assert.equal(day("what did we discuss yesterday"), "2026-11-09");
});

test("a yearless date that would land in the future means the past one", () => {
  assert.equal(day("what did I ask on 3 December"), "2025-12-03");
});

test("day range covers the whole local day", () => {
  const [r] = resolveDates("on 3 November", NOW, TZ);
  assert.equal(r.to.getTime() - r.from.getTime(), 86400_000 - 1);
});

test("memory: exchanges from the referenced day are retrieved with timestamps", () => {
  const at = (iso: string) => new Date(iso).getTime();
  addMessage({ userId: "u", convId: "c1", role: "user", content: "Compare Postgres hosting prices", ts: at("2026-11-03T11:00:00+05:30") });
  addMessage({ userId: "u", convId: "c1", role: "assistant", content: "Neon free tier is $0; Supabase Pro is $25/mo.", ts: at("2026-11-03T11:00:20+05:30"), meta: { queries: ["postgres hosting pricing"] } });
  const ctx = assembleContext({ userId: "u", message: "What did I ask you on 3 November? Is it still correct?", now: NOW, tz: TZ, liveIds: new Set() });
  assert.match(ctx.memoryBlock, /Compare Postgres hosting prices/);
  assert.match(ctx.memoryBlock, /Supabase Pro is \$25/);
  assert.match(ctx.memoryBlock, /Tue 3 Nov 2026, 11:00/);
  assert.match(ctx.memoryBlock, /postgres hosting pricing/);
});

test("memory: no record is stated explicitly, never invented", () => {
  const ctx = assembleContext({ userId: "u", message: "What did I ask you on 5 November?", now: NOW, tz: TZ, liveIds: new Set() });
  assert.match(ctx.memoryBlock, /NONE FOUND/);
});

test("memory: other users' history never leaks", () => {
  const ctx = assembleContext({ userId: "someone-else", message: "What did I ask you on 3 November?", now: NOW, tz: TZ, liveIds: new Set() });
  assert.match(ctx.memoryBlock, /NONE FOUND/);
});

test("no recall cue and no date: nothing is retrieved (no wasted tokens)", () => {
  const ctx = assembleContext({ userId: "u", message: "What's the capital of France?", now: NOW, tz: TZ, liveIds: new Set() });
  assert.equal(ctx.memoryBlock, "");
});

test("official-site heuristic: subject's own domain yes, listicles and look-alikes no", () => {
  assert.equal(isOfficial("https://supabase.com/pricing", "Supabase Pro plan pricing"), true);
  assert.equal(isOfficial("https://docs.supabase.com/x", "supabase pricing"), true);
  assert.equal(isOfficial("https://www.hubspot.com/pricing/sales", "HubSpot Sales Hub pricing"), true);
  assert.equal(isOfficial("https://neon.com/pricing", "Neon Postgres pricing plans"), true);
  assert.equal(isOfficial("https://uibakery.io/blog/supabase-pricing", "Supabase pricing"), false);
  assert.equal(isOfficial("https://checkthat.ai/brands/render/pricing", "Render Postgres pricing"), false);
  assert.equal(isOfficial("https://www.salesforce.com/pricing", "HubSpot Sales Hub pricing"), false);
});
