## Searching your memory (`memory_search`)

Your durable memory under `/workspace/agent/memory/` can grow large over time.
Instead of reading every file, pull just the facts relevant to what you're
doing right now.

- **`memory_search({ query, limit? })`** — searches your own
  `/workspace/agent/memory/*.md` files and returns the top matches (default 5,
  max 20), ranked by relevance to `query` plus recency, importance, and
  confidence. Strictly **read-only** — it never writes, edits, or deletes a
  memory file.
- A memory file MAY optionally carry `confidence`/`importance` (0–1) under a
  `metadata:` frontmatter block at the top of the file. Absent fields fall
  back to sensible defaults — you do not need to tag every memory you write.
- If fewer than `limit` facts actually match your query, the tool fills the
  rest with your other memories (ranked by recency/importance) so you still
  get useful context — but a real match always ranks above filler.

Use this before diving into a task that depends on something you might have
already learned, instead of loading your whole `/workspace/agent/memory/`
folder into context.
