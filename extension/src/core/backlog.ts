import { parse } from 'yaml';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import schema from '../../../schema/backlog.schema.json' with { type: 'json' };

export interface Check { run: string; expect?: string }
export interface TaskFile { path: string; content?: string; given?: boolean }
export interface Milestone { id: string; title: string; goal: string }
export interface Task {
  id: string;
  milestone: string;
  title: string;
  depends_on?: string[];
  goal: string;
  learn: string[];
  theory: string;
  search?: string[];
  files?: TaskFile[];
  hints: string[];
  checks: Check[];
  review?: string[];
}
export interface Backlog {
  schema: 1;
  project: string;
  title: string;
  summary: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  estimate_hours: number;
  stack: string[];
  env?: string;
  conventions?: string[];
  milestones: Milestone[];
  tasks: Task[];
}
export interface SolutionFile { path: string; content: string }
export interface Solution { schema: 1; tasks: Record<string, SolutionFile[]> }

const ajv = new Ajv2020({ allErrors: true });
ajv.addSchema(schema, 'backlog');
const backlogShape = ajv.compile<Backlog>({ $ref: 'backlog' });
const solutionShape = ajv.compile<Solution>({ $ref: 'backlog#/$defs/solution' });

export type Parsed<T> = { value: T; errors: []; fixes?: string[] } | { value?: undefined; errors: string[]; fixes?: string[] };

/**
 * Typical chatbot format errors that can be fixed unambiguously, before validation.
 * The saved text stays the original: the fix is reapplied on every read, always the same.
 */
function autofix(data: any): string[] {
  const fixes: string[] = [];
  if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) return fixes;
  const toText = (list: unknown, where: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((v, i) => {
      // "- Soluzione: return x" without quotes: YAML reads it as { Soluzione: "return x" }
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1) return;
      const [[k, val]] = Object.entries(v);
      if (typeof val !== 'string' && typeof val !== 'number') return;
      list[i] = `${k}: ${val}`;
      fixes.push(`${where}[${i}]: sentence with ": " turned back into text`);
    });
  };
  toText(data.stack, 'stack');
  toText(data.conventions, 'conventions');
  for (const t of data.tasks) {
    if (!t || typeof t !== 'object') continue;
    toText(t.hints, `${t.id}.hints`);
    toText(t.review, `${t.id}.review`);
    toText(t.search, `${t.id}.search`);
    for (const c of Array.isArray(t.checks) ? t.checks : []) {
      if (typeof c?.run === 'string' && /^pytest(\s|$)/.test(c.run)) {
        c.run = `python -m ${c.run}`;
        fixes.push(`${t.id}: "pytest" → "python -m pytest", so the project modules are importable`);
      }
      // exec:java runs the classes already in target/: a class added in this task is not there yet
      if (typeof c?.run === 'string' && /^mvn\s/.test(c.run) && /\sexec:java\b/.test(c.run)
          && !/\s(compile|test|package|verify|install)(\s|$)/.test(c.run)) {
        c.run = c.run.replace(/\sexec:java\b/, ' compile exec:java');
        fixes.push(`${t.id}: "mvn exec:java" → "mvn compile exec:java", otherwise the new classes are not compiled`);
      }
      // project-local tools live in node_modules/.bin, which is not on the PATH: npx finds them
      if (typeof c?.run === 'string' && /^(jest|vitest|tsc)\b/.test(c.run)) {
        fixes.push(`${t.id}: "${c.run.split(' ')[0]}" → "npx ${c.run.split(' ')[0]}", the tool is not on the PATH`);
        c.run = `npx ${c.run}`;
      }
      // without "run" vitest may stay in watch mode and the check never ends
      if (typeof c?.run === 'string' && /^npx\s+vitest\b/.test(c.run) && !/\s(run|--run)(\s|$)/.test(c.run)) {
        c.run = c.run.replace(/^npx\s+vitest\b/, 'npx vitest run');
        fixes.push(`${t.id}: "npx vitest" → "npx vitest run", so the check ends instead of watching`);
      }
    }
  }
  return fixes;
}

function describe(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(e => {
    const where = e.instancePath || '(root)';
    const extra = e.keyword === 'additionalProperties' ? ` ('${e.params.additionalProperty}')`
      // the most common YAML error from LLMs: a sentence with ": " without quotes becomes a map
      : e.keyword === 'type' && e.params.type === 'string'
        ? ' (if it is a sentence containing ": ", put it in double quotes or a | block)' : '';
    return `${where}: ${e.message}${extra}`;
  });
}

function parseYaml(text: string): { data?: unknown; errors: string[] } {
  try {
    return { data: parse(text), errors: [] };
  } catch (e) {
    return { errors: [`Unreadable YAML: ${(e as Error).message}`] };
  }
}

/** Shape (schema) + consistency between parts, which the schema cannot express. */
export function parseBacklog(text: string): Parsed<Backlog> {
  const { data, errors } = parseYaml(text);
  if (errors.length) return { errors };
  const fixes = autofix(data);
  if (!backlogShape(data)) return { errors: describe(backlogShape.errors), fixes };

  const problems: string[] = [];
  const milestones = data.milestones.map(m => m.id);
  milestones.filter((id, i) => milestones.indexOf(id) !== i).forEach(id => problems.push(`milestone ${id}: duplicate id`));
  const seen = new Set<string>();
  for (const t of data.tasks) {
    if (seen.has(t.id)) problems.push(`${t.id}: duplicate id`);
    if (!milestones.includes(t.milestone)) problems.push(`${t.id}: milestone ${t.milestone} does not exist`);
    // shortcut: "previous tasks only" rules out cycles without needing a topological sort
    for (const d of t.depends_on ?? []) if (!seen.has(d)) problems.push(`${t.id}: depends on ${d}, which is not a previous task`);
    for (const c of t.checks) {
      try { if (c.expect) new RegExp(c.expect); } catch { problems.push(`${t.id}: expect is not a valid regex: ${c.expect}`); }
      // logic errors actually seen in LLM-generated backlogs
      if (c.expect && /fail|error|errore|fallit/i.test(c.expect)) {
        problems.push(`${t.id}: expect "${c.expect}" looks for a failure, but a check passes only if the command exits successfully`);
      }
    }
    for (const f of t.files ?? []) {
      if (f.given && /^\s*assert\s+False\b/m.test(f.content ?? '')) {
        problems.push(`${t.id}: the provided file ${f.path} contains "assert False" and can never pass`);
      }
    }
    seen.add(t.id);
  }
  problems.push(...foundations(data));
  return problems.length ? { errors: problems, fixes } : { value: data, errors: [], fixes };
}

/**
 * Foundations a model tends to skip even when the prompt asks for them: here they are checks,
 * so the repair loop forces it to fix them. Only certain rules, no vague heuristics.
 */
function foundations(b: Backlog): string[] {
  const files = b.tasks.flatMap(t => t.files ?? []);
  const has = (name: string) => files.some(f => f.path === name || f.path.endsWith(`/${name}`));
  const problems: string[] = [];
  if (!has('.gitignore')) problems.push('missing a .gitignore: it must be created in the first task, so build output, dependencies and secrets do not end up in git');
  if (!has('README.md')) problems.push('missing a README.md: in the first task, with what the project is, how to start it and how to run the tests');

  // the tool used by the checks needs its project file
  const runs = b.tasks.flatMap(t => t.checks.map(c => c.run));
  const buildFiles: [RegExp, string[], string][] = [
    [/^mvn(w)?\b/, ['pom.xml'], 'pom.xml'],
    [/^(gradle|gradlew)\b/, ['build.gradle', 'build.gradle.kts'], 'build.gradle'],
    [/^(npm|npx|yarn|pnpm)\b/, ['package.json'], 'package.json'],
  ];
  for (const [tool, names, label] of buildFiles) {
    if (runs.some(r => tool.test(r)) && !names.some(has)) problems.push(`the checks use ${runs.find(r => tool.test(r))!.split(' ')[0]} but no task creates ${label}`);
  }

  // Database: the schema is code to version, not a string hidden in a class
  const text = [...files.map(f => f.content ?? ''), ...b.tasks.flatMap(t => [t.theory, ...t.hints])].join('\n');
  if (/\bCREATE\s+TABLE\b/i.test(text) && !files.some(f => f.path.endsWith('.sql'))) {
    problems.push('the project creates tables but the schema is not in a versioned .sql file (e.g. src/main/resources/db/schema.sql or a Flyway migration V1__init.sql)');
  }

  // Maven: reproducible build only with pinned versions
  for (const pom of files.filter(f => f.path.endsWith('pom.xml') && f.content)) {
    const xml = pom.content!.replace(/<!--[\s\S]*?-->/g, '');
    const blocks = (tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => m[1]);
    const name = (block: string) => block.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1] ?? '?';
    const managed = /<dependencyManagement>|<parent>/.test(xml);   // versions from a BOM or parent: legitimate
    for (const p of blocks('plugin').filter(p => !/<version>/.test(p))) problems.push(`${pom.path}: plugin ${name(p)} has no pinned <version>`);
    if (!managed) for (const d of blocks('dependency').filter(d => !/<version>/.test(d))) problems.push(`${pom.path}: dependency ${name(d)} has no <version>`);
    for (const p of ['maven-compiler-plugin', 'maven-surefire-plugin']) {
      if (!xml.includes(`<artifactId>${p}</artifactId>`)) problems.push(`${pom.path}: declare ${p} with a pinned version (reproducible build and JUnit 5 tests run)`);
    }
  }
  // npm: "latest" or "*" make the build change from one day to the next
  for (const pkg of files.filter(f => f.path.endsWith('package.json') && f.content)) {
    let json: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try { json = JSON.parse(pkg.content!); } catch { problems.push(`${pkg.path}: not valid JSON`); continue; }
    for (const [name, version] of Object.entries({ ...json.dependencies, ...json.devDependencies })) {
      if (/^\s*(latest|\*|x)?\s*$/i.test(String(version))) problems.push(`${pkg.path}: dependency ${name} has no pinned version ("${version}")`);
    }
  }
  return problems;
}

export function parseSolution(text: string, backlog: Backlog): Parsed<Solution> {
  const { data, errors } = parseYaml(text);
  if (errors.length) return { errors };
  if (!solutionShape(data)) return { errors: describe(solutionShape.errors) };

  const problems: string[] = [];
  for (const t of backlog.tasks) {
    const files = data.tasks[t.id];
    if (!files) { problems.push(`${t.id}: missing the solution`); continue; }
    const editable = new Set((t.files ?? []).filter(f => !f.given).map(f => f.path));
    for (const f of files) {
      if (!editable.has(f.path)) problems.push(`${t.id}: the solution touches ${f.path}, which the task does not declare as a user file`);
    }
  }
  for (const id of Object.keys(data.tasks)) {
    if (!backlog.tasks.some(t => t.id === id)) problems.push(`${id}: solution for a task that does not exist`);
  }
  return problems.length ? { errors: problems } : { value: data, errors: [] };
}

export interface PlannerAnswer {
  feasibility: string;          // the text before the YAML blocks
  backlogText?: string;
  solutionText?: string;
  backlog?: Backlog;
  solution?: Solution;
  errors: string[];
  fixes: string[];              // format errors fixed automatically
}

/** Answer from an LLM (internal or pasted): feasibility + backlog + optional solution. */
export function parsePlannerAnswer(text: string): PlannerAnswer {
  const fence = text.search(/^```ya?ml/m);
  const feasibility = (fence >= 0 ? text.slice(0, fence) : '').trim();
  const blocks = yamlBlocks(text);
  const backlogText = blocks.find(b => /^project:/m.test(b));
  const solutionText = blocks.find(b => b !== backlogText && /^tasks:/m.test(b));
  if (!backlogText) return { feasibility, errors: ['No backlog found (missing "project:").'], fixes: [] };
  const b = parseBacklog(backlogText);
  const fixes = b.fixes ?? [];
  if (!b.value) return { feasibility, backlogText, solutionText, errors: b.errors, fixes };
  if (!solutionText) return { feasibility, backlogText, backlog: b.value, errors: [], fixes };
  const s = parseSolution(solutionText, b.value);
  return { feasibility, backlogText, solutionText, backlog: b.value, solution: s.value, errors: s.errors.map(e => `solution: ${e}`), fixes };
}

export const repairRequest = (errors: string[]) =>
  'The backlog is not valid for the mocoder schema. Fix these errors and return both complete YAML blocks (backlog and solution) again, with no other text:\n' +
  `${errors.map(e => `- ${e}`).join('\n')}`;

/**
 * ```yaml blocks of an LLM answer; if there are none, the whole text.
 * The closing fence must be at the start of a line: the ``` of hints are indented inside the YAML.
 */
export function yamlBlocks(text: string): string[] {
  const blocks = [...text.matchAll(/^```ya?ml[^\n]*\n([\s\S]*?)^ {0,3}```[ \t]*$/gm)].map(m => m[1]);
  return blocks.length ? blocks : [text];
}
