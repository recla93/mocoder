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
  level: 'principiante' | 'intermedio' | 'avanzato';
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
 * Errori di formato tipici dei chatbot che si correggono senza ambiguità, prima della validazione.
 * Il testo salvato resta quello originale: la correzione si riapplica a ogni lettura, sempre uguale.
 */
function autofix(data: any): string[] {
  const fixes: string[] = [];
  if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) return fixes;
  const toText = (list: unknown, where: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((v, i) => {
      // "- Soluzione: return x" senza virgolette: YAML lo legge come { Soluzione: "return x" }
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1) return;
      const [[k, val]] = Object.entries(v);
      if (typeof val !== 'string' && typeof val !== 'number') return;
      list[i] = `${k}: ${val}`;
      fixes.push(`${where}[${i}]: frase con ": " riportata a testo`);
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
        fixes.push(`${t.id}: "pytest" → "python -m pytest", così i moduli del progetto sono importabili`);
      }
    }
  }
  return fixes;
}

function describe(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(e => {
    const where = e.instancePath || '(radice)';
    const extra = e.keyword === 'additionalProperties' ? ` ('${e.params.additionalProperty}')`
      // l'errore YAML più comune degli LLM: una frase con ": " senza virgolette diventa una mappa
      : e.keyword === 'type' && e.params.type === 'string'
        ? ' (se è una frase che contiene ": ", mettila tra virgolette doppie o in un blocco |)' : '';
    return `${where}: ${e.message}${extra}`;
  });
}

function parseYaml(text: string): { data?: unknown; errors: string[] } {
  try {
    return { data: parse(text), errors: [] };
  } catch (e) {
    return { errors: [`YAML non leggibile: ${(e as Error).message}`] };
  }
}

/** Forma (schema) + coerenza tra parti, che lo schema non può esprimere. */
export function parseBacklog(text: string): Parsed<Backlog> {
  const { data, errors } = parseYaml(text);
  if (errors.length) return { errors };
  const fixes = autofix(data);
  if (!backlogShape(data)) return { errors: describe(backlogShape.errors), fixes };

  const problems: string[] = [];
  const milestones = data.milestones.map(m => m.id);
  milestones.filter((id, i) => milestones.indexOf(id) !== i).forEach(id => problems.push(`milestone ${id}: id duplicato`));
  const seen = new Set<string>();
  for (const t of data.tasks) {
    if (seen.has(t.id)) problems.push(`${t.id}: id duplicato`);
    if (!milestones.includes(t.milestone)) problems.push(`${t.id}: milestone ${t.milestone} inesistente`);
    // shortcut: "solo task precedenti" esclude i cicli senza bisogno di un ordinamento topologico
    for (const d of t.depends_on ?? []) if (!seen.has(d)) problems.push(`${t.id}: dipende da ${d}, che non è un task precedente`);
    for (const c of t.checks) {
      try { if (c.expect) new RegExp(c.expect); } catch { problems.push(`${t.id}: expect non è una regex valida: ${c.expect}`); }
      // errori di logica visti davvero nei backlog generati dagli LLM
      if (c.expect && /fail|error|errore|fallit/i.test(c.expect)) {
        problems.push(`${t.id}: expect "${c.expect}" cerca un fallimento, ma un controllo passa solo se il comando termina con successo`);
      }
    }
    for (const f of t.files ?? []) {
      if (f.given && /^\s*assert\s+False\b/m.test(f.content ?? '')) {
        problems.push(`${t.id}: il file fornito ${f.path} contiene "assert False" e non potrà mai passare`);
      }
    }
    seen.add(t.id);
  }
  problems.push(...foundations(data));
  return problems.length ? { errors: problems, fixes } : { value: data, errors: [], fixes };
}

/**
 * Fondamenta che un modello tende a saltare anche quando il prompt le chiede: qui sono controlli,
 * così il ciclo di correzione lo costringe a rimediare. Solo regole certe, niente euristiche vaghe.
 */
function foundations(b: Backlog): string[] {
  const files = b.tasks.flatMap(t => t.files ?? []);
  const has = (name: string) => files.some(f => f.path === name || f.path.endsWith(`/${name}`));
  const problems: string[] = [];
  if (!has('.gitignore')) problems.push('manca un .gitignore: va creato nel primo task, così output di build, dipendenze e segreti non finiscono in git');
  if (!has('README.md')) problems.push('manca un README.md: nel primo task, con cos\'è il progetto, come si avvia e come si lanciano i test');

  // lo strumento usato dai controlli ha bisogno del suo file di progetto
  const runs = b.tasks.flatMap(t => t.checks.map(c => c.run));
  const buildFiles: [RegExp, string[], string][] = [
    [/^mvn(w)?\b/, ['pom.xml'], 'pom.xml'],
    [/^(gradle|gradlew)\b/, ['build.gradle', 'build.gradle.kts'], 'build.gradle'],
    [/^(npm|npx|yarn|pnpm)\b/, ['package.json'], 'package.json'],
  ];
  for (const [tool, names, label] of buildFiles) {
    if (runs.some(r => tool.test(r)) && !names.some(has)) problems.push(`i controlli usano ${runs.find(r => tool.test(r))!.split(' ')[0]} ma nessun task crea il ${label}`);
  }

  // Database: lo schema è codice da versionare, non una stringa nascosta in una classe
  const text = [...files.map(f => f.content ?? ''), ...b.tasks.flatMap(t => [t.theory, ...t.hints])].join('\n');
  if (/\bCREATE\s+TABLE\b/i.test(text) && !files.some(f => f.path.endsWith('.sql'))) {
    problems.push('il progetto crea tabelle ma lo schema non è in un file .sql versionato (es. src/main/resources/db/schema.sql o una migrazione Flyway V1__init.sql)');
  }

  // Maven: build riproducibile solo con versioni fissate
  for (const pom of files.filter(f => f.path.endsWith('pom.xml') && f.content)) {
    const xml = pom.content!.replace(/<!--[\s\S]*?-->/g, '');
    const blocks = (tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => m[1]);
    const name = (block: string) => block.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1] ?? '?';
    const managed = /<dependencyManagement>|<parent>/.test(xml);   // versioni da BOM o parent: legittimo
    for (const p of blocks('plugin').filter(p => !/<version>/.test(p))) problems.push(`${pom.path}: il plugin ${name(p)} non ha una <version> fissata`);
    if (!managed) for (const d of blocks('dependency').filter(d => !/<version>/.test(d))) problems.push(`${pom.path}: la dipendenza ${name(d)} non ha una <version>`);
    for (const p of ['maven-compiler-plugin', 'maven-surefire-plugin']) {
      if (!xml.includes(`<artifactId>${p}</artifactId>`)) problems.push(`${pom.path}: dichiara ${p} con una versione fissata (build riproducibile e test JUnit 5 eseguiti)`);
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
    if (!files) { problems.push(`${t.id}: manca la soluzione`); continue; }
    const editable = new Set((t.files ?? []).filter(f => !f.given).map(f => f.path));
    for (const f of files) {
      if (!editable.has(f.path)) problems.push(`${t.id}: la soluzione tocca ${f.path}, che il task non dichiara come file dell'utente`);
    }
  }
  for (const id of Object.keys(data.tasks)) {
    if (!backlog.tasks.some(t => t.id === id)) problems.push(`${id}: soluzione per un task inesistente`);
  }
  return problems.length ? { errors: problems } : { value: data, errors: [] };
}

export interface PlannerAnswer {
  feasibility: string;          // il testo prima dei blocchi YAML
  backlogText?: string;
  solutionText?: string;
  backlog?: Backlog;
  solution?: Solution;
  errors: string[];
  fixes: string[];              // errori di formato corretti automaticamente
}

/** Risposta di un LLM (interno o incollata): fattibilità + backlog + soluzione opzionale. */
export function parsePlannerAnswer(text: string): PlannerAnswer {
  const fence = text.search(/^```ya?ml/m);
  const feasibility = (fence >= 0 ? text.slice(0, fence) : '').trim();
  const blocks = yamlBlocks(text);
  const backlogText = blocks.find(b => /^project:/m.test(b));
  const solutionText = blocks.find(b => b !== backlogText && /^tasks:/m.test(b));
  if (!backlogText) return { feasibility, errors: ['Nessun backlog trovato (manca "project:").'], fixes: [] };
  const b = parseBacklog(backlogText);
  const fixes = b.fixes ?? [];
  if (!b.value) return { feasibility, backlogText, solutionText, errors: b.errors, fixes };
  if (!solutionText) return { feasibility, backlogText, backlog: b.value, errors: [], fixes };
  const s = parseSolution(solutionText, b.value);
  return { feasibility, backlogText, solutionText, backlog: b.value, solution: s.value, errors: s.errors.map(e => `soluzione: ${e}`), fixes };
}

export const repairRequest = (errors: string[]) =>
  'Il backlog non è valido per lo schema mocoder. Correggi questi errori e restituisci di nuovo ' +
  `entrambi i blocchi YAML completi (backlog e soluzione), senza altro testo:\n${errors.map(e => `- ${e}`).join('\n')}`;

/**
 * Blocchi ```yaml di una risposta LLM; se non ce ne sono, tutto il testo.
 * La chiusura deve stare a inizio riga: i ``` dei suggerimenti sono indentati dentro lo YAML.
 */
export function yamlBlocks(text: string): string[] {
  const blocks = [...text.matchAll(/^```ya?ml[^\n]*\n([\s\S]*?)^ {0,3}```[ \t]*$/gm)].map(m => m[1]);
  return blocks.length ? blocks : [text];
}
