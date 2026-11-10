// Live end-to-end scenarios (needs both API keys): `npm run eval`.
// Seeds timestamped history, asks the three brief-style questions with a fixed clock,
// and prints answers + checks cheap invariants. Read the output; it is a smoke test, not a judge.
process.env.DB_PATH = ":memory:";
const { runTurn } = await import("../src/agent.js");
const { addMessage } = await import("../src/memory.js");

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-11-10T10:00:00+05:30"); // Tuesday
const at = (iso: string) => new Date(iso).getTime();

const seed = (convId: string, user: string, userTs: string, answer: string) => {
  addMessage({ userId: "eval", convId, role: "user", content: user, ts: at(userTs) });
  addMessage({ userId: "eval", convId, role: "assistant", content: answer, ts: at(userTs) + 30_000, meta: { queries: [] } });
};

seed("crm", "Shortlist CRM tools for a 20-person sales team", "2026-11-09T10:00:00+05:30",
  "Shortlist: HubSpot Sales Hub (Starter $20/seat/mo), Pipedrive (Advanced $44/seat/mo), Zoho CRM (Standard $14/user/mo), Salesforce Starter ($25/user/mo), Freshsales (Growth $11/user/mo).");
seed("pg", "Compare managed Postgres hosting prices", "2026-11-03T15:30:00+05:30",
  "Neon: free tier, Launch $19/mo. Supabase: Pro $25/mo. Render Postgres starts at $7/mo.");

const cases: { name: string; msg: string; expect: RegExp[] }[] = [
  { name: "changes since shortlist", msg: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", expect: [/HubSpot/i, /Pipedrive/i, /Zoho/i] },
  { name: "recall + still correct", msg: "What did I ask you on 3 November? Is your answer still correct today?", expect: [/postgres/i, /neon|supabase|render/i] },
  { name: "last Tuesday", msg: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", expect: [/neon|supabase|render/i] },
  { name: "no record: must not fabricate", msg: "What did I ask you on 1 November?", expect: [/no record|don't have|do not have|not.*(find|see)/i] },
];

const only = process.env.EVAL_ONLY; // e.g. EVAL_ONLY=0 or 0,2 : run a subset (saves free-tier quota)
const selected = only ? cases.filter((_, i) => only.split(",").includes(String(i))) : cases;
let failed = 0;
const PAUSE = Number(process.env.EVAL_PAUSE_MS ?? 25000); // free API tiers allow ~5 req/min
for (const [i, c] of selected.entries()) {
  if (i && PAUSE) await new Promise((r) => setTimeout(r, PAUSE));
  console.log(`\n=== ${c.name}\n> ${c.msg}`);
  const t0 = Date.now();
  let firstToken = 0;
  const searches: string[] = [];
  const answer = await runTurn(
    { userId: "eval", convId: `eval-${c.name}`, message: c.msg, tz: TZ, now: NOW },
    (e) => {
      if (e.type === "text" && !firstToken) firstToken = Date.now() - t0;
      if (e.type === "search") searches.push(e.query + (e.since ? ` [since ${e.since}]` : ""));
    },
  );
  console.log(`\nsearches: ${searches.length ? searches.join(" | ") : "(none)"}\nfirst token: ${firstToken}ms, total: ${Date.now() - t0}ms\n\n${answer}`);
  const miss = c.expect.filter((r) => !r.test(answer));
  if (miss.length) { failed++; console.log(`\n✗ missing: ${miss.join(", ")}`); } else console.log("\n✓ ok");
}
process.exit(failed ? 1 : 0);
