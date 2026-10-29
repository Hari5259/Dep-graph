/**
 * Tool dependency graph generator.
 *
 *   npx tsx src/generate.ts path/to/catalog.json [--out dependency_graph.json] [--no-llm] [--viz graph.html]
 *
 * Reads any Composio toolkit catalog and emits producer -> consumer edges:
 * an edge A -> B labelled `p` means "B needs parameter p, and A is an action
 * that can supply it" (e.g. GITHUB_LIST_REPOSITORY_ISSUES -> GITHUB_CREATE_AN_ISSUE_COMMENT : issue_number).
 *
 * Pipeline (all toolkit-agnostic, nothing about GitHub is hardcoded):
 *   1. normalise   tolerant loader for Composio catalog shapes (v1/v3, arrays, maps)
 *   2. parse slugs verb + resource phrase, compound nouns (pull_request) learned from the catalog
 *   3. classify    which inputs are references to an entity (ids, numbers, names, shas ...)
 *   4. resolve     map each reference param to a catalog entity (by name, then by description)
 *   5. match       score producers: tools that list/search/create that entity, or whose
 *                  output schema exposes the field; prune to the best few per (tool, param)
 *   6. llm (opt)   for references the heuristics could not resolve, ask an LLM to pick
 *                  producers from a shortlist; answers are cached in llm_cache.json
 *   7. emit        dependency_graph.json + self-contained HTML visualisation
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- types
type Json = any;
interface Param { name: string; required: boolean; type: string; description: string }
interface Tool {
  id: string;
  description: string;
  params: Param[];
  outputFields: Set<string>;        // flattened lowercase keys of the response schema
  tokens: string[];                 // slug tokens minus toolkit prefix, compounds merged
  verb: string;
  head: string[];                   // resource tokens before the first preposition
  scope: string[];                  // resource tokens after it (for a repository ...)
  primaries: string[];              // entities this tool is "about"
  service: string;
  quals: string[];                  // qualifiers of its entity: "gist" in LIST_GIST_COMMENTS
}
interface Edge { from: string; to: string; label: string; score: number; evidence: string; required: boolean }
interface Ref { param: Param; entity: string | null; via: string }

// ---------------------------------------------------------------- vocab (generic English, not toolkit specific)
const STOP = new Set(["a", "an", "the", "all", "any", "new", "specific", "given", "single", "my", "your", "its", "own"]);
const PREP = new Set(["for", "of", "in", "on", "by", "from", "to", "with", "into", "via", "at", "under", "within", "as", "using", "across", "between"]);
const VERBS = new Set([
  "list", "get", "create", "update", "delete", "remove", "add", "search", "find", "fetch", "retrieve", "read",
  "check", "set", "merge", "close", "open", "star", "unstar", "follow", "unfollow", "lock", "unlock", "enable",
  "disable", "cancel", "rerun", "re", "run", "approve", "reject", "submit", "dismiss", "request", "review",
  "replace", "rename", "transfer", "upload", "download", "trigger", "dispatch", "send", "post", "patch", "put",
  "edit", "make", "start", "stop", "archive", "unarchive", "move", "copy", "sync", "test", "ping", "render",
  "compare", "export", "import", "generate", "accept", "decline", "block", "unblock", "pin", "unpin", "mark",
  "convert", "revoke", "redeliver", "deliver", "invite", "assign", "unassign", "reopen", "resolve", "upsert",
  "verify", "validate", "query", "count", "describe", "lookup", "browse", "execute", "configure", "reset",
  "restore", "suspend", "unsuspend", "publish", "unpublish", "subscribe", "unsubscribe", "watch", "unwatch",
  "fork", "clone", "map", "link", "unlink", "attach", "detach", "share", "batch", "bulk", "or", "and",
]);
const PRODUCER_VERB_WEIGHT: Record<string, number> = {
  list: 1.0, search: 0.95, find: 0.95, query: 0.9, browse: 0.85, lookup: 0.9,
  create: 0.7, upsert: 0.65, add: 0.5, generate: 0.5, fork: 0.5,
  get: 0.55, fetch: 0.55, retrieve: 0.55, read: 0.5, describe: 0.5,
};
// params that are never prerequisites produced by other actions
const NON_REF = new Set([
  "page", "per_page", "page_size", "pagesize", "limit", "offset", "cursor", "next_cursor", "page_token", "sort",
  "order", "order_by", "direction", "since", "until", "before", "after", "q", "query", "search", "body", "title",
  "message", "content", "description", "text", "state", "status", "event", "merge_method", "format", "mode",
  "visibility", "type", "filter", "fields", "include", "expand", "draft", "private", "permission", "role",
  "color", "encoding", "timezone", "locale", "commit_message", "commit_title", "note", "summary", "reason",
  "start_date", "end_date", "date", "time", "email", "subject", "url", "homepage",
]);
const REF_SUFFIX = /(^|_)(ids?|numbers?|num|shas?|uuids?|keys?|slugs?|names?|refs?|logins?|handles?|codes?|tags?|gids?)$/;
const REF_DESC = /\b(id|ids|identifier|number that identifies|unique (?:id|identifier|number)|slug|sha|handle|name of the|key of the)\b/i;

// ---------------------------------------------------------------- utils
const singular = (w: string): string => {
  if (w.length <= 3) return w;
  if (/(ss|us|is|sis)$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(xes|ches|shes|sses|uses)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
};
const plural = (w: string): string =>
  /y$/.test(w) && !/[aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : /(s|x|ch|sh)$/.test(w) ? w + "es" : w + "s";
const words = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------- 1. load + normalise
function findToolArray(raw: Json): Json[] {
  if (Array.isArray(raw)) return raw;
  for (const k of ["tools", "items", "actions", "data", "results", "catalog"]) {
    if (raw && Array.isArray(raw[k])) return raw[k];
    if (raw && raw[k] && typeof raw[k] === "object") { const inner = findToolArray(raw[k]); if (inner.length) return inner; }
  }
  // map of slug -> tool
  if (raw && typeof raw === "object") {
    const vals = Object.entries(raw).filter(([, v]) => v && typeof v === "object") as [string, Json][];
    if (vals.length && vals.every(([, v]) => v.input_parameters || v.parameters || v.inputParameters || v.description))
      return vals.map(([k, v]) => ({ slug: v.slug || k, ...v }));
  }
  return [];
}
function schemaOf(t: Json, keys: string[]): Json {
  for (const k of keys) if (t[k]) return typeof t[k] === "string" ? safeParse(t[k]) : t[k];
  return null;
}
function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();

function flattenKeys(schema: Json, root: Json, out = new Set<string>(), depth = 0, seen = new Set<Json>()): Set<string> {
  if (!schema || typeof schema !== "object" || depth > 10 || seen.has(schema)) return out;
  seen.add(schema);
  if (typeof schema.$ref === "string") {
    const m = schema.$ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
    const target = m && root?.[m[1]]?.[m[2]];
    if (target) flattenKeys(target, root, out, depth + 1, seen);
  }
  for (const comb of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(schema[comb])) schema[comb].forEach((s: Json) => flattenKeys(s, root, out, depth + 1, seen));
  if (schema.items) flattenKeys(schema.items, root, out, depth + 1, seen);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") flattenKeys(schema.additionalProperties, root, out, depth + 1, seen);
  if (schema.properties && typeof schema.properties === "object") {
    for (const [k, v] of Object.entries(schema.properties)) {
      out.add(snake(k));
      flattenKeys(v, root, out, depth + 1, seen);
    }
  }
  return out;
}

function normalise(raw: Json): { tools: Tool[]; prefix: string } {
  const arr = findToolArray(raw);
  if (!arr.length) throw new Error("No tools found in catalog");
  const slugs = arr.map((t) => String(t.slug || t.enum || t.name || t.key || t.id || ""));
  // toolkit prefix: most common first token (GITHUB_, SLACK_ ...)
  const firstTok = new Map<string, number>();
  slugs.forEach((s) => { const f = s.split("_")[0]; firstTok.set(f, (firstTok.get(f) || 0) + 1); });
  const [prefix, cnt] = [...firstTok.entries()].sort((a, b) => b[1] - a[1])[0];
  const usePrefix = cnt / slugs.length > 0.6 ? prefix : "";

  const tools: Tool[] = arr.map((t, i) => {
    const inSchema = schemaOf(t, ["input_parameters", "inputParameters", "parameters", "input_schema", "inputSchema", "args", "input"]) || {};
    const props = inSchema.properties || (inSchema.type ? {} : inSchema) || {};
    const req = new Set<string>(Array.isArray(inSchema.required) ? inSchema.required : []);
    const params: Param[] = Object.entries(props).map(([name, p]: [string, Json]) => ({
      name,
      required: req.has(name) || p?.required === true,
      type: String(p?.type || (p?.anyOf ? "union" : "")),
      description: String(p?.description || p?.title || ""),
    }));
    const outSchema = schemaOf(t, ["output_parameters", "outputParameters", "response", "response_schema", "output_schema", "outputSchema", "output"]);
    // only the success payload counts (skip error / GraphQLError defs)
    const payload = outSchema?.properties?.data ?? outSchema?.properties?.response_data ?? outSchema;
    const outputFields = flattenKeys(payload, outSchema);
    ["data", "successful", "error", "success", "response_data"].forEach((k) => outputFields.delete(k));
    return {
      id: slugs[i], description: String(t.description || t.display_name || t.name || ""),
      params, outputFields, tokens: [], verb: "", head: [], scope: [], primaries: [], service: "", quals: [],
    };
  }).filter((t) => t.id);
  return { tools, prefix: usePrefix };
}

// ---------------------------------------------------------------- 2. slug parsing with learned compounds
function parseSlugs(tools: Tool[], prefix: string) {
  const strip = (id: string) => {
    let s = id.toLowerCase();
    if (prefix && s.startsWith(prefix.toLowerCase() + "_")) s = s.slice(prefix.length + 1);
    return s.split("_").filter(Boolean).map(singular);
  };
  const raw = tools.map((t) => strip(t.id));

  // learn compounds: adjacent noun pairs that strongly predict each other (pull+request, workflow+run)
  const uni = new Map<string, number>(), bi = new Map<string, number>();
  for (const toks of raw) {
    const ns = toks.slice(1).filter((w) => !STOP.has(w) && !PREP.has(w));
    ns.forEach((w) => uni.set(w, (uni.get(w) || 0) + 1));
    for (let i = 0; i + 1 < toks.length; i++) {
      const a = toks[i], b = toks[i + 1];
      if (i === 0 || VERBS.has(a) || [a, b].some((w) => STOP.has(w) || PREP.has(w))) continue;
      bi.set(a + " " + b, (bi.get(a + " " + b) || 0) + 1);
    }
  }
  const compounds = new Set<string>();
  for (const [k, c] of bi) {
    const [a, b] = k.split(" ");
    if (c >= 3 && (c / (uni.get(a) || 1) >= 0.75 || c / (uni.get(b) || 1) >= 0.75)) compounds.add(k);
  }

  const compoundHead = (w: string) => w.includes("_");
  tools.forEach((t, idx) => {
    const toks: string[] = [];
    const r = raw[idx];
    for (let i = 0; i < r.length; i++) {
      if (i + 1 < r.length && compounds.has(r[i] + " " + r[i + 1])) { toks.push(r[i] + "_" + r[i + 1]); i++; }
      else toks.push(r[i]);
    }
    t.tokens = toks;
    let i = 0;
    const verbs: string[] = [];
    if (i < toks.length && VERBS.has(toks[i])) { verbs.push(toks[i]); i++; }
    while (i < toks.length) {
      if (verbs[verbs.length - 1] === "re" && VERBS.has(toks[i])) { verbs.push(toks[i]); i++; continue; }
      if ((toks[i] === "or" || toks[i] === "and") && i + 1 < toks.length && VERBS.has(toks[i + 1]) && !compoundHead(toks[i + 1])) { verbs.push(toks[i + 1]); i += 2; continue; }
      if (STOP.has(toks[i])) { i++; continue; }
      break;
    }
    t.verb = verbs.find((v) => v !== "re") || verbs[0] || "other";
    const rest = toks.slice(i).filter((w) => !STOP.has(w));
    const p = rest.findIndex((w) => PREP.has(w));
    const head = (p === -1 ? rest : rest.slice(0, p)).filter((w) => !/ed$/.test(w) || w.length <= 4);
    t.head = head.length ? head : rest.filter((w) => !PREP.has(w)).slice(0, 1);
    t.scope = p === -1 ? [] : rest.slice(p + 1).filter((w) => !PREP.has(w) && !VERBS.has(w));
    // "issues and pull requests" -> two primaries
    const chunks: string[][] = [[]];
    t.head.forEach((w) => (w === "and" || w === "or" ? chunks.push([]) : chunks[chunks.length - 1].push(w)));
    t.primaries = chunks.filter((c) => c.length).map((c) => c[c.length - 1]);
  });

  // service grouping. A "container" is a noun that qualifies many different entities
  // (repository -> issues, workflows, labels ...). A tool belongs to the first head noun
  // that is not a container: LIST_REPOSITORY_ISSUES -> issues, CREATE_AN_ISSUE_COMMENT -> issues.
  const coOcc = new Map<string, Set<string>>();
  const allPrim = new Set<string>();
  tools.forEach((t) => {
    t.primaries.forEach((p) => allPrim.add(p));
    const ctx = [...t.head.slice(0, -1), ...t.scope];
    ctx.forEach((w) => { if (!coOcc.has(w)) coOcc.set(w, new Set()); t.primaries.forEach((p) => p !== w && coOcc.get(w)!.add(p)); });
  });
  const cThresh = Math.max(3, Math.min(8, Math.round(allPrim.size * 0.15)));
  const isContainer = (w: string) => (coOcc.get(w)?.size || 0) >= cThresh;
  // for qualifiers, a container is a noun used mostly as scope ("for a repository", "for the authenticated user")
  const hc = new Map<string, number>(), sc = new Map<string, number>();
  tools.forEach((t) => { t.head.forEach((w) => hc.set(w, (hc.get(w) || 0) + 1)); t.scope.forEach((w) => sc.set(w, (sc.get(w) || 0) + 1)); });
  const scopeNoun = (w: string) => { const a = sc.get(w) || 0, b = hc.get(w) || 0; return a >= 3 && a / (a + b) >= 0.5; };
  tools.forEach((t) => {
    const primTok = new Set(t.primaries.flatMap((p) => p.split("_")));
    t.quals = [...new Set([...t.head, ...t.scope].filter((w) => !scopeNoun(w) && w !== "and" && w !== "or")
      .flatMap((w) => w.split("_")).filter((w) => !primTok.has(w) && w.length > 2))];
  });
  tools.forEach((t) => {
    const cands = t.head.filter((w) => w !== "and" && w !== "or");
    const pick = cands.find((w) => !isContainer(w)) || cands[cands.length - 1] || t.scope[0] || "misc";
    t.service = plural(pick);
  });
  // fold services with fewer than 3 tools into the parent named in the slug, if that one is a real group
  const svcCnt = new Map<string, number>();
  tools.forEach((t) => svcCnt.set(t.service, (svcCnt.get(t.service) || 0) + 1));
  tools.forEach((t) => {
    if ((svcCnt.get(t.service) || 0) < 3) {
      const alt = [...t.scope, ...t.head].map(plural).find((s) => s !== t.service && (svcCnt.get(s) || 0) >= 3);
      if (alt) t.service = alt;
    }
  });
  return compounds;
}

// ---------------------------------------------------------------- 3+4. reference params and entity resolution
function buildEntityIndex(tools: Tool[]) {
  const ent = new Map<string, Tool[]>();
  tools.forEach((t) => t.primaries.forEach((e) => { if (!ent.has(e)) ent.set(e, []); ent.get(e)!.push(t); }));
  return ent;
}

// generic identifier nouns used across SaaS APIs (scoping / parent references)
const REF_NOUNS = new Set(["owner", "org", "organization", "workspace", "account", "project", "team", "channel", "board", "folder",
  "space", "site", "tenant", "repo", "repository", "branch", "base", "head", "ref", "sha", "user", "username", "group", "list", "drive", "calendar", "database", "table", "parent"]);
let entityNames: Set<string> | null = null;
function isRefParam(p: Param): boolean {
  const n = snake(p.name);
  if (NON_REF.has(n)) return false;
  if (/^(is_|has_|include_|allow_|enable_|show_)/.test(n)) return false;
  if (p.type === "boolean") return false;
  if (REF_SUFFIX.test(n)) return true;
  if (REF_DESC.test(p.description)) return true;
  if (REF_NOUNS.has(n)) return true;
  if (entityNames && (entityNames.has(singular(n)) || [...entityNames].some((e) => n.length >= 3 && e.startsWith(n) && e.length - n.length <= 8))) return true;
  return false;
}

function matchEntity(base: string, entities: Map<string, Tool[]>): string | null {
  if (!base) return null;
  const b = singular(base);
  if (entities.has(b)) return b;
  const keys = [...entities.keys()];
  const score = (k: string) => entities.get(k)!.length;
  const starts = keys.filter((k) => k.startsWith(b + "_") || (b.length >= 3 && k.startsWith(b) && !k.includes("_")));
  if (starts.length) return starts.sort((x, y) => score(y) - score(x))[0];
  const ends = keys.filter((k) => k.endsWith("_" + b));
  if (ends.length) return ends.sort((x, y) => score(y) - score(x))[0];
  return null;
}

function resolveRefs(p: Param, entities: Map<string, Tool[]>): Ref[] {
  const n = snake(p.name);
  const base = n.replace(REF_SUFFIX, "").replace(/_+$/, "");
  const out: Ref[] = [];
  const push = (e: string | null, via: string) => { if (e && !out.some((r) => r.entity === e)) out.push({ param: p, entity: e, via }); };
  push(matchEntity(base, entities), "name");
  push(matchEntity(n, entities), "name");
  // the parameter description names the entity ("The name of the branch ...", "The account owner of the repository")
  const ws = words(p.description).map(singular);
  for (let i = 0; i < ws.length && out.length < 4; i++) {
    const two = i + 1 < ws.length ? ws[i] + "_" + ws[i + 1] : "";
    if (two && entities.has(two)) { push(two, "description"); i++; continue; }
    if (ws[i].length > 2 && entities.has(ws[i])) push(ws[i], "description");
  }
  if (!out.length) out.push({ param: p, entity: null, via: "none" });
  return out;
}

// ---------------------------------------------------------------- 5. producer scoring
function candidateProducers(consumer: Tool, ref: Ref, tools: Tool[], entities: Map<string, Tool[]>): { tool: Tool; score: number; evidence: string }[] {
  const pname = snake(ref.param.name);
  const consumerParams = new Set(consumer.params.map((x) => snake(x.name)));
  const out = new Map<string, { tool: Tool; score: number; evidence: string }>();

  const consider = (t: Tool, base: number, evidence: string) => {
    if (t.id === consumer.id) return;
    // a producer may not itself require the value it is supposed to produce
    if (t.params.some((x) => x.required && snake(x.name) === pname)) return;
    const vw = PRODUCER_VERB_WEIGHT[t.verb];
    if (vw === undefined && !evidence.startsWith("output")) return;
    let s = base * (vw ?? 0.6);
    if (t.outputFields.has(pname)) s += 0.35;
    else if (t.outputFields.size && ["id", "number", "name", "sha", "slug", "key", "login"].some((f) => pname.endsWith(f) && t.outputFields.has(f))) s += 0.15;
    // prefer producers whose own prerequisites the consumer already has (same scope, e.g. owner+repo)
    const extra = t.params.filter((x) => x.required && !consumerParams.has(snake(x.name))).length;
    s -= 0.12 * extra;
    // the head should be exactly the entity; extra qualifiers ("assigned", "starred") make it narrower
    s -= 0.04 * Math.max(0, t.head.length - 1);
    if (t.scope.length && !t.scope.every((w) => consumer.tokens.includes(w) || consumerParams.has(w))) s -= 0.08;
    // a qualified producer ("gist comments", "review comments") whose qualifiers the consumer never mentions
    // lists a different kind of that entity
    if (t.quals.length) {
      const ctoks = new Set([...consumer.tokens.flatMap((w) => w.split("_")), ...[...consumerParams].flatMap((w) => w.split("_"))]);
      // abbreviations count: param "repo" covers qualifier "repository", "org" covers "organization"
      const covered = (q: string) => [...ctoks].some((c) => c === q || (c.length >= 3 && (q.startsWith(c) || c.startsWith(q))));
      if (!t.quals.every(covered)) s -= 0.45;
    }
    const prev = out.get(t.id);
    if (!prev || prev.score < s) out.set(t.id, { tool: t, score: +s.toFixed(3), evidence });
  };

  if (ref.entity) for (const t of entities.get(ref.entity) || []) consider(t, 1.0, `${t.verb}:${ref.entity}`);
  // output-schema evidence from tools not named after the entity, only for specific field names
  // (workflow_id, check_run_id) - generic ones (id, name, owner) appear in almost every response
  const GENERIC = new Set(["id", "name", "number", "sha", "key", "slug", "url", "type", "login", "path", "ref", "owner", "repo", "node_id", "title", "state", "body", "head", "base", "user"]);
  if (!GENERIC.has(pname) && pname.includes("_"))
    for (const t of tools) if (t.outputFields.has(pname) && PRODUCER_VERB_WEIGHT[t.verb] !== undefined) consider(t, 0.6, `output:${pname}`);
  return [...out.values()].sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- 6. optional LLM resolution
async function llmResolve(
  pending: { key: string; consumer: Tool; param: Param; shortlist: Tool[] }[],
  cachePath: string,
): Promise<Map<string, string[]>> {
  const res = new Map<string, string[]>();
  const cache: Record<string, string[]> = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};
  // Litmus proxy (provided at grading time), else any OpenAI-compatible endpoint
  const base = process.env.LLM_BASE_URL || (process.env.LITMUS_API_URL ? process.env.LITMUS_API_URL.replace(/\/$/, "") + "/proxy/openai/v1" : "") || process.env.OPENAI_BASE_URL;
  const key = process.env.LLM_API_KEY || process.env.LITMUS_ASSESSMENT_TOKEN || process.env.OPENAI_API_KEY;
  const model = process.env.LLM_MODEL || "openai/gpt-4o";
  const maxCalls = +(process.env.LLM_MAX_CALLS || 40);
  let calls = 0;

  const BATCH = 12;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const todo = batch.filter((b) => !(hash(b) in cache));
    if (todo.length && base && key && calls < maxCalls) {
      calls++;
      const prompt = todo.map((b, j) => [
        `#${j} consumer=${b.consumer.id} param=${b.param.name} (${b.param.description.slice(0, 160)})`,
        `candidates: ${b.shortlist.map((t) => t.id).join(", ")}`,
      ].join("\n")).join("\n\n");
      try {
        const r = await fetch(base.replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model, temperature: 0, response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "You map API action parameters to the actions that produce them. For each item, choose up to 3 candidate actions whose RESPONSE contains a value that can be passed as that parameter (typically list/search/create actions for that entity). If the value normally comes from the user (free text, a name they know) and no candidate genuinely returns it, return []. Never invent slugs. Reply as JSON: {\"answers\": {\"0\": [\"SLUG\", ...], ...}}" },
              { role: "user", content: prompt },
            ],
          }),
        });
        const j: Json = await r.json();
        const ans = JSON.parse(j.choices?.[0]?.message?.content || "{}").answers || {};
        todo.forEach((b, k) => {
          const allowed = new Set(b.shortlist.map((t) => t.id));
          cache[hash(b)] = (ans[String(k)] || []).filter((s: string) => allowed.has(s));
        });
      } catch (e) {
        console.warn("llm call failed:", (e as Error).message);
      }
    }
    batch.forEach((b) => { if (hash(b) in cache) res.set(b.key, cache[hash(b)]); });
  }
  if (Object.keys(cache).length) fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1));
  if (calls) console.log(`llm: ${calls} call(s), ${model}`);
  return res;

  function hash(b: { consumer: Tool; param: Param; shortlist: Tool[] }) {
    return crypto.createHash("sha1").update(b.consumer.id + "|" + b.param.name + "|" + b.shortlist.map((t) => t.id).join(",")).digest("hex").slice(0, 16);
  }
}

function lexicalShortlist(p: Param, tools: Tool[], consumer: Tool, n = 20): Tool[] {
  const q = new Set([...words(snake(p.name)), ...words(p.description)].map(singular).filter((w) => w.length > 2 && !STOP.has(w)));
  return tools
    .filter((t) => t.id !== consumer.id && PRODUCER_VERB_WEIGHT[t.verb] !== undefined && !t.params.some((x) => x.required && x.name === p.name))
    .map((t) => ({ t, s: t.tokens.flatMap((w) => w.split("_")).filter((w) => q.has(w)).length + (t.verb === "list" ? 0.5 : 0) }))
    .filter((x) => x.s > 0.5).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.t);
}

// ---------------------------------------------------------------- main
async function main() {
  const args = process.argv.slice(2);
  // the grader appends the catalog path as the LAST argument
  const flagVals = new Set(["--out", "--viz"].map((f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : "")).filter(Boolean));
  const positional = args.filter((a) => !a.startsWith("--") && !flagVals.has(a));
  const catalogPath = positional[positional.length - 1];
  if (!catalogPath) { console.error("usage: tsx src/generate.ts <catalog.json> [--out file] [--no-llm]"); process.exit(1); }
  const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const root = process.cwd();
  const outPath = path.resolve(opt("--out", path.join(root, "dependency_graph.json")));
  const vizPath = path.resolve(opt("--viz", path.join(root, "graph.html")));
  const useLLM = !args.includes("--no-llm");

  const { tools, prefix } = normalise(JSON.parse(fs.readFileSync(catalogPath, "utf8")));
  parseSlugs(tools, prefix);
  const entities = buildEntityIndex(tools);
  entityNames = new Set(entities.keys());

  // params used by a large share of the toolkit are "context" (owner, repo, workspace_id ...)
  const paramFreq = new Map<string, number>();
  tools.forEach((t) => t.params.forEach((p) => p.required && paramFreq.set(p.name, (paramFreq.get(p.name) || 0) + 1)));
  const isContext = (n: string) => (paramFreq.get(n) || 0) / tools.length > 0.2;

  const edges: Edge[] = [];
  const pending: { key: string; consumer: Tool; param: Param; shortlist: Tool[] }[] = [];
  const nodeInfo = new Map<string, { needs: Record<string, string[]>; user_inputs: string[] }>();
  tools.forEach((t) => nodeInfo.set(t.id, { needs: {}, user_inputs: [] }));

  for (const c of tools) {
    for (const p of c.params) {
      if (!p.required) continue;
      if (!isRefParam(p)) { nodeInfo.get(c.id)!.user_inputs.push(p.name); continue; }
      // try candidate entities in priority order; first one that yields producers wins
      let ref: Ref = { param: p, entity: null, via: "none" };
      let cands: ReturnType<typeof candidateProducers> = [];
      for (const r of resolveRefs(p, entities)) {
        const cs = candidateProducers(c, r, tools, entities);
        if (cs.length && cs[0].score >= 0.45) { ref = r; cands = cs; break; }
        if (!cands.length) { ref = r; cands = cs; }
      }
      const best = cands[0]?.score ?? 0;
      const k = isContext(p.name) ? 2 : 3;
      const kept = cands.filter((x) => x.score >= 0.45 && x.score >= best - 0.4).slice(0, k);
      if (kept.length) {
        kept.forEach((x) => edges.push({ from: x.tool.id, to: c.id, label: p.name, score: x.score, evidence: `${ref.via}|${x.evidence}`, required: true }));
        nodeInfo.get(c.id)!.needs[p.name] = kept.map((x) => x.tool.id);
      } else {
        const shortlist = lexicalShortlist(p, tools, c);
        if (useLLM && shortlist.length) pending.push({ key: c.id + "|" + p.name, consumer: c, param: p, shortlist });
        else nodeInfo.get(c.id)!.user_inputs.push(p.name);
      }
    }
  }

  if (pending.length) {
    const answers = await llmResolve(pending, path.join(root, "llm_cache.json"));
    for (const pd of pending) {
      const picks = answers.get(pd.key) || [];
      if (picks.length) {
        picks.forEach((s) => edges.push({ from: s, to: pd.consumer.id, label: pd.param.name, score: 0.5, evidence: "llm", required: true }));
        nodeInfo.get(pd.consumer.id)!.needs[pd.param.name] = picks;
      } else nodeInfo.get(pd.consumer.id)!.user_inputs.push(pd.param.name);
    }
  }

  // de-duplicate (from,to,label)
  const seen = new Set<string>();
  const finalEdges = edges.filter((e) => { const k = `${e.from}>${e.to}>${e.label}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.to.localeCompare(b.to) || a.label.localeCompare(b.label) || b.score - a.score);

  const graph = {
    toolkit: prefix || "unknown",
    generated_from: path.basename(catalogPath),
    nodes: tools.map((t) => ({
      id: t.id, service: t.service, verb: t.verb, entity: t.primaries.join("+"),
      requires_from_actions: nodeInfo.get(t.id)!.needs,
      requires_from_user: nodeInfo.get(t.id)!.user_inputs,
    })).sort((a, b) => a.service.localeCompare(b.service) || a.id.localeCompare(b.id)),
    edges: finalEdges,
    stats: {
      tools: tools.length, edges: finalEdges.length,
      tools_with_dependencies: new Set(finalEdges.map((e) => e.to)).size,
      producers: new Set(finalEdges.map((e) => e.from)).size,
      services: new Set(tools.map((t) => t.service)).size,
      llm_edges: finalEdges.filter((e) => e.evidence === "llm").length,
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(graph, null, 2));
  writeViz(graph, vizPath);
  console.log(`wrote ${path.relative(process.cwd(), outPath)}: ${graph.stats.tools} nodes, ${graph.stats.edges} edges, ${graph.stats.services} services`);
  console.log(`wrote ${path.relative(process.cwd(), vizPath)}`);
}

// ---------------------------------------------------------------- 7. visualisation (self-contained HTML, vis-network from CDN)
function writeViz(graph: Json, file: string) {
  const tpl = fs.readFileSync(path.join(HERE, "viz_template.html"), "utf8");
  fs.writeFileSync(file, tpl.replace("/*__GRAPH__*/null", JSON.stringify(graph)));
}

main().catch((e) => { console.error(e); process.exit(1); });
