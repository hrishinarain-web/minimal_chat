# Chat agent with web search

Streaming chat agent with one tool (web search) plus deterministic time and memory handling. Architecture is in [DESIGN.md](DESIGN.md).

```bash
npm install
cp .env.example .env   # add OPENAI_API_KEY and TAVILY_API_KEY
npm run dev            # http://localhost:3000
```

- `npm test`: offline tests (no keys needed)
- `npm run eval`: live scenarios (needs keys)
- `npm run typecheck`

Chat history persists in `data/memory.db`, so you can ask about earlier conversations ("what did I ask last Tuesday?"). To test with synthetic history, `POST /api/seed` (see `src/server.ts`) and pass `now` to `/api/chat` to pin the clock.
