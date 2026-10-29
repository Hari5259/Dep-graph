# Tool Dependency Graph Generator

Reads a Composio toolkit catalog and writes `dependency_graph.json`: which actions must run first to supply the inputs of another action.

```
npm install
node --import tsx src/generate.ts github_catalog.json   # writes dependency_graph.json + graph.html
npm run selfcheck                                   # template shape check
node --import tsx scripts/eval.ts dependency_graph.json github_catalog.json   # gold edges + structure
```

Edge `A -> B` labelled `p` = B requires `p`, and A returns it. Example:
`GITHUB_LIST_PULL_REQUESTS -> GITHUB_MERGE_A_PULL_REQUEST : pull_number`.

## Output

```json
{
  "nodes": [{ "id": "GITHUB_MERGE_A_PULL_REQUEST", "service": "pull_requests", "verb": "merge", "entity": "pull_request",
              "requires_from_actions": { "pull_number": ["GITHUB_LIST_PULL_REQUESTS"] },
              "requires_from_user": [] }],
  "edges": [{ "from": "GITHUB_LIST_PULL_REQUESTS", "to": "GITHUB_MERGE_A_PULL_REQUEST", "label": "pull_number",
              "score": 1, "evidence": "name|list:pull_request", "required": true }]
}
```

Per node, `requires_from_actions` and `requires_from_user` answer the agent's question directly: what to fetch first vs. what to ask the user.

## How it works

Nothing toolkit-specific is hardcoded; every step is derived from the catalog.

1. **Normalise.** Tolerant loader for Composio shapes (`input_parameters` / `parameters`, arrays or slug maps). Toolkit prefix (`GITHUB_`) is detected from the slugs.
2. **Parse slugs.** `verb + head [preposition scope]`. Compound nouns (`pull_request`, `workflow_run`) are learned from adjacent-token statistics across the catalog.
3. **Classify inputs.** A required input is a *reference* if its name looks like an identifier (`*_id`, `*_number`, `sha`, `slug`, `name` ...), names a catalog entity, or its description says so. Free text, pagination and enums go to `requires_from_user`.
4. **Resolve entity.** `issue_number -> issue`, `pull_number -> pull_request`, `org -> organization`; otherwise from the description (`head`: "name of the branch" -> `branch`; `owner`: "owner of the repository" -> `repository`).
5. **Score producers.** Tools about that entity with a producing verb (list > search > create > get), boosted when the output schema exposes the field, penalised for extra prerequisites the consumer lacks, for narrower variants, and for scope mismatch. A producer may not require the value it produces. Top 3 per (tool, param), top 2 for context params used by >20% of tools (`owner`, `repo`).
6. **LLM fallback (optional).** References with no heuristic producer go to an OpenAI-compatible model with a lexical shortlist; answers are restricted to real slugs and cached in `llm_cache.json` (commit it for reproducible runs). Uses the Litmus proxy (`LITMUS_API_URL`, `LITMUS_ASSESSMENT_TOKEN`) when set, else `LLM_BASE_URL`, `LLM_API_KEY`, optional `LLM_MODEL` (default `openai/gpt-4o`), `LLM_MAX_CALLS` (default 40). `--no-llm` disables it; without credentials it is skipped.
7. **Emit.** `dependency_graph.json` and `graph.html`.

## Visualisation

Open `graph.html`. Filter by service, search a tool, click a node to see its upstream chain, what to ask the user, and what it unlocks. Context edges (`owner`, `repo`) are hidden by default to keep the graph readable.

## Evaluation

`scripts/eval.ts` checks structure (no dangling edges, self loops, or nodes outside the catalog), gold edges (including both README examples), known-wrong edges, and producer-verb distribution.
