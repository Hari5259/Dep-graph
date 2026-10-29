# Tool Dependency Graph Generator

When an agent executes an action, it often needs a value it doesn't have yet. `GITHUB_MERGE_A_PULL_REQUEST` needs a `pull_number`; if all you know is a branch name, you first call `GITHUB_LIST_PULL_REQUESTS` to find it.

This project is a **generator** that reads any Composio toolkit catalog and produces that dependency graph automatically: for every action, which other actions can supply its inputs, and which inputs have to come from the user. Nothing toolkit-specific is hardcoded. Give it a different catalog and it produces a different graph.

```
GITHUB_LIST_PULL_REQUESTS ──pull_number──▶ GITHUB_MERGE_A_PULL_REQUEST
GITHUB_LIST_REPOSITORY_ISSUES ──issue_number──▶ GITHUB_CREATE_AN_ISSUE_COMMENT
GITHUB_LIST_BRANCHES ──head──▶ GITHUB_CREATE_A_PULL_REQUEST
```

## Results on the GitHub catalog

| Metric | Value |
|---|---|
| Tools (nodes) | 893 |
| Dependency edges | 3,700 (all labelled) |
| Tools with at least one resolved prerequisite | 798 |
| Node ids that are real catalog slugs | 100% |
| Gold edges recovered | 11 / 11 |
| Known-wrong edges | 0 |

Most producers are `list` actions (about 92% of edges), with `search`, `create` and `get` as fallbacks. That matches how an agent actually discovers ids.

## Quick start

```bash
npm install --legacy-peer-deps
node --import tsx src/generate.ts github_catalog.json   # writes dependency_graph.json + graph.html
npm run selfcheck                                       # shape + provenance check
node --import tsx scripts/eval.ts dependency_graph.json github_catalog.json   # gold edges + structure
```

The catalog path is always read from the **last** command-line argument, so the generator works when the grader appends it after the run command declared in `generator.json`.

## Output format

`dependency_graph.json`:

```json
{
  "nodes": [
    {
      "id": "GITHUB_MERGE_A_PULL_REQUEST",
      "service": "pull_requests",
      "verb": "merge",
      "entity": "pull_request",
      "requires_from_actions": { "pull_number": ["GITHUB_LIST_PULL_REQUESTS"] },
      "requires_from_user": []
    }
  ],
  "edges": [
    {
      "from": "GITHUB_LIST_PULL_REQUESTS",
      "to": "GITHUB_MERGE_A_PULL_REQUEST",
      "label": "pull_number",
      "score": 1,
      "evidence": "name|list:pull_request",
      "required": true
    }
  ]
}
```

- Each edge is `producer -> consumer`; `label` is the field the producer supplies.
- Each node also states the agent's two options directly: `requires_from_actions` (run these first) and `requires_from_user` (ask for these, e.g. an issue `title` or comment `body`).
- `score` and `evidence` explain why each edge exists, so it can be audited.

## How it works

The generator is a deterministic pipeline, with an LLM used only where the heuristics run out.

**1. Load.** A tolerant loader accepts the common Composio shapes: `inputParameters` or `input_parameters`, arrays or slug maps, and output schemas that use `$ref` into `$defs`. Only the success payload (`data`) of the output schema is used as evidence. Error types are ignored.

**2. Parse slugs.** Each slug is split into verb, entity and scope, e.g. `LIST` / `comments` / `for a pull request review`. Multi-word entities like `pull_request` and `workflow_run` are learned from how often the words occur together in that catalog, not from a word list.

**3. Classify inputs.** A required input is treated as a *reference* if it looks like an identifier (`*_id`, `*_number`, `sha`, `slug`, `name`, camelCase variants like `migrationId`), names a catalog entity, or is described as one. Free text, pagination, flags and enums go to `requires_from_user`.

**4. Resolve the entity.**
- From the name: `issue_number` -> issue, `pull_number` -> pull_request, `org` -> organization.
- Otherwise from the description: `head` is "the name of the branch", so branch. `owner` is "the account owner of the repository", so repository.

**5. Score producers.** For each candidate producer:
- Verb weight: list > search/find > create > get.
- A bonus if its output schema exposes the field.
- A penalty for each prerequisite the consumer doesn't already have.
- A penalty for a scope mismatch or a narrower variant.
- A heavy penalty if the producer is qualified differently. `LIST_GIST_COMMENTS` lists gist comments, not issue comments, so it must not feed `UPDATE_AN_ISSUE_COMMENT`.
- A producer can never require the value it is supposed to produce.

The top 3 producers per (tool, parameter) are kept, and the top 2 for context parameters used across most of the toolkit (`owner`, `repo`).

**6. LLM fallback.** References the heuristics can't resolve go to an LLM through the OpenAI-compatible API. The model chooses from a shortlist of real slugs and can answer "user-provided". Answers outside the shortlist are discarded, so it can't invent slugs. Results are cached in `llm_cache.json`. LLM edges are marked `evidence: "llm"` and drawn dashed in the visualization.

| Variable | Purpose |
|---|---|
| `LITMUS_API_URL`, `LITMUS_ASSESSMENT_TOKEN` | Used automatically when set (via `/proxy/openai/v1`) |
| `LLM_BASE_URL`, `LLM_API_KEY` | Any other OpenAI-compatible endpoint |
| `LLM_MODEL` | Default `openai/gpt-4o` |
| `LLM_MAX_CALLS` | Default 40 |

Pass `--no-llm` to run purely deterministically.

## Visualization

Open **`graph.html`** in a browser. It is self-contained and regenerated on every run.

- Nodes are coloured by service and sized by how many tools they unlock.
- Filter by service, or search for a tool.
- Click a node to see its upstream chain, what to ask the user, and what it unlocks.
- Context edges (`owner`, `repo`) are hidden by default so the real structure is readable. One checkbox shows them.

## Evaluation

`scripts/eval.ts` checks:

- **Structure:** no dangling edges, no self-loops, every node a real catalog slug, every edge labelled.
- **Gold edges:** including both examples from the brief.
- **Known-wrong edges**, for example gist comments feeding issue comments.
- **Producer-verb distribution**, as a sanity signal.

Gold edges whose tools aren't in the given catalog are skipped, so the same script works for any toolkit.

## Repository layout

```
src/generate.ts        generator (entry point)
src/viz_template.html  visualization template
src/selfcheck.ts       provided shape/provenance check
scripts/eval.ts        gold-edge and structural evaluation
github_catalog.json    the toolkit catalog used
graph.html             visualization of the generated graph
generator.json         build/run declaration
```

## Limitations

- Values that only appear deep inside another resource (a file `sha` returned by a contents call) are matched by name and schema. Unusual naming may still need the LLM pass.
- Optional filter inputs (e.g. `head` on `LIST_PULL_REQUESTS`) are not turned into edges. Only required inputs are.
- The `service` grouping is derived from slugs, so it is finer-grained than GitHub's own API sections.
