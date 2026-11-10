# DESIGN

## Problem
The sample questions ("on Monday we shortlisted 5 CRMs, anything changed since?", "what did I ask on 3 November, still correct?") look like search problems but are really **time + memory + verification** problems. A plain "LLM + search" loop can't resolve "last Tuesday", doesn't remember what it said, and doesn't know what to re-check. So time, memory and verdict rules are **code**; the model does what it's good at: choosing searches, reading sources, writing.

## How it works
```
user msg ─► 1. CONTEXT (code, ms)       ─► 2. AGENT LOOP (1 model, streaming) ─► 3. PERSIST
            now + user tz                   system prompt + now + Memory block      answer + queries +
            chrono-node: phrases → days     tool: web_search (parallel calls)       sources, timestamped
            SQLite range query / FTS5       tool result = hits + EVIDENCE STATUS
```
- **Dates resolved in code** (`chrono-node` + IANA timezone). A yearless date that would land in the future means the previous occurrence. The model is told the resolved dates and the real "now".
- **Memory is not a tool.** The brief allows one tool. Retrieving before the model call is faster, can't be skipped, and keeps the surface honest. Exact days come from an indexed query; fuzzy recall ("the CRMs we shortlisted") uses FTS5 and is labelled a *guess*. Memory spans conversations. Each stored answer keeps its queries and sources as the baseline for "is it still correct?".
- **No record → say so.** The prompt and Memory block make "NONE FOUND" explicit; the agent never reconstructs a past conversation (tested live).
- **Verdicts are computed, not trusted.** Early live runs had a fast model write "UNCHANGED" from blog listicles. Two fixes: (1) any `since` search also runs a parallel *current-state* lookup (no added latency), since "no news" doesn't prove a value is unchanged; (2) each tool result ends with a tool-written EVIDENCE STATUS (official-site hit? dated developments after `since`?) stating what may be claimed. The same rules in the system prompt were ignored; beside the evidence they were followed. Official-site detection is a unit-tested domain-vs-query heuristic.
- **Speed**: first token streams immediately; no routing LLM call on the hot path; searches run in parallel; 10-min search cache; stable prompt prefix first (provider caching); timeouts and retries; client disconnect aborts model and searches.

## Choices
| Choice | Why |
|---|---|
| Raw OpenAI SDK, ~100-line loop, any compatible provider via `OPENAI_BASE_URL` | Every step visible and explainable; no framework hiding the judged part. |
| Tavily | Returns extracted page text (so no fetch tool; "web search only" holds), date filters, one key. |
| SQLite + FTS5 | Lookups are by date or keyword; exact beats semantic; zero infra. |
| Hono + SSE + one HTML file | Live "searching…" status, streamed answer, source chips. |
| `/api/seed`, `now` override | Replay timestamped history and pin the clock for evals. |

## Rejected
Vector DB for memory (overkill for date/keyword lookups); memory as a model tool (extra round trip, skippable, breaks one-tool rule); planner/researcher/critic agents (latency, more failure modes); model-computed dates (unreliable); a separate fetch tool (out of spec).

## Testing and limits
`npm test`: offline tests for dates/timezones, retrieval, no-record, per-user isolation, official-site heuristic. `npm run eval`: live scenarios from the brief with seeded history and a pinned clock; checks keywords only, I read the outputs. Built on Gemini's free tier via the compatible endpoint (default model `gpt-4.1`), which is slow (3-60s/call) and capped (~20 requests/day/model), so latency numbers are pessimistic. Single-user, no auth. Official-site detection misses subjects whose domain differs from their name. Answers can still vary run to run.

## With another week
1. LLM-judge eval harness over a larger seeded set (DST, adversarial "you said X" when it didn't, conflicting sources).
2. Structured claim snapshots per answer (entity → claim → source) so "what changed" is a real diff.
3. Per-domain fetching of official pricing/changelog pages; better source ranking.
4. Small fast model to classify recall intent when heuristics are unsure; summarise long threads.
5. Proactive "watch this" re-checks; auth and multi-user storage.
