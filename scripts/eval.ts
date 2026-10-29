/**
 * Sanity + gold-edge evaluation of dependency_graph.json.
 *   npx tsx scripts/eval.ts [dependency_graph.json] [catalog.json]
 * Gold edges whose tools are absent from the catalog are skipped, so this works on any toolkit
 * (add gold edges for other toolkits to GOLD below).
 */
import * as fs from "node:fs";

const GOLD: [string, string, string][] = [
  ["GITHUB_LIST_REPOSITORY_ISSUES", "GITHUB_CREATE_AN_ISSUE_COMMENT", "issue_number"],
  ["GITHUB_LIST_PULL_REQUESTS", "GITHUB_MERGE_A_PULL_REQUEST", "pull_number"],
  ["GITHUB_LIST_PULL_REQUESTS", "GITHUB_GET_A_PULL_REQUEST", "pull_number"],
  ["GITHUB_LIST_PULL_REQUESTS", "GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST", "pull_number"],
  ["GITHUB_LIST_REPOSITORY_ISSUES", "GITHUB_GET_AN_ISSUE", "issue_number"],
  ["GITHUB_LIST_REPOSITORY_ISSUES", "GITHUB_UPDATE_AN_ISSUE", "issue_number"],
  ["GITHUB_LIST_BRANCHES", "GITHUB_GET_A_BRANCH", "branch"],
  ["GITHUB_LIST_RELEASES", "GITHUB_UPDATE_A_RELEASE", "release_id"],
  ["GITHUB_LIST_REPOSITORY_WORKFLOWS", "GITHUB_CREATE_A_WORKFLOW_DISPATCH_EVENT", "workflow_id"],
  ["GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY", "GITHUB_RE_RUN_A_WORKFLOW", "run_id"],
  ["GITHUB_LIST_ISSUE_COMMENTS", "GITHUB_UPDATE_AN_ISSUE_COMMENT", "comment_id"],
  ["GITHUB_LIST_GISTS_FOR_THE_AUTHENTICATED_USER", "GITHUB_GET_A_GIST", "gist_id"],
];
// edges that would be wrong (producer cannot supply the field)
const ANTI: [string, string, string][] = [
  ["GITHUB_CREATE_AN_ISSUE_COMMENT", "GITHUB_UPDATE_AN_ISSUE", "issue_number"],
  ["GITHUB_MERGE_A_PULL_REQUEST", "GITHUB_GET_A_PULL_REQUEST", "pull_number"],
];

const g = JSON.parse(fs.readFileSync(process.argv[2] || "dependency_graph.json", "utf8"));
const ids = new Set<string>(g.nodes.map((n: any) => n.id));
const snake = (s: string) => String(s).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const has = new Set<string>(g.edges.map((e: any) => `${e.from}>${e.to}>${snake(e.label)}`));
const problems: string[] = [];

if (process.argv[3]) {
  const raw = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const arr = Array.isArray(raw) ? raw : raw.tools || raw.items || Object.values(raw);
  const slugs = new Set(arr.map((t: any) => t.slug || t.enum || t.name));
  ids.forEach((id) => { if (!slugs.has(id)) problems.push(`node not in catalog: ${id}`); });
}
for (const e of g.edges) {
  if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`dangling edge ${e.from}->${e.to}`);
  if (e.from === e.to) problems.push(`self loop ${e.from}`);
  if (!e.label) problems.push(`unlabelled edge ${e.from}->${e.to}`);
}
const applicable = GOLD.filter(([f, t]) => ids.has(f) && ids.has(t));
const hit = applicable.filter((x) => has.has(x.join(">")));
const anti = ANTI.filter((x) => has.has(x.join(">")));

const verbs: Record<string, number> = {};
const byId = Object.fromEntries(g.nodes.map((n: any) => [n.id, n]));
g.edges.forEach((e: any) => { const v = byId[e.from]?.verb || "?"; verbs[v] = (verbs[v] || 0) + 1; });
const withRefs = g.nodes.filter((n: any) => Object.keys(n.requires_from_actions).length).length;

console.log(`nodes ${g.nodes.length}  edges ${g.edges.length}  services ${new Set(g.nodes.map((n: any) => n.service)).size}`);
console.log(`tools with >=1 resolved prerequisite: ${withRefs}`);
console.log(`producer verbs: ${JSON.stringify(verbs)}`);
console.log(`gold recall: ${hit.length}/${applicable.length}`);
applicable.filter((x) => !hit.includes(x)).forEach((x) => console.log(`  missing ${x.join(" > ")}`));
console.log(`known-wrong edges present: ${anti.length}`);
console.log(problems.length ? `structural problems:\n  ${problems.slice(0, 20).join("\n  ")}` : "structure: ok");
process.exit(problems.length || anti.length ? 1 : 0);
