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
  milestones: Milestone[];
  tasks: Task[];
}
export interface SolutionFile { path: string; content: string }
export interface Solution { schema: 1; tasks: Record<string, SolutionFile[]> }

const ajv = new Ajv2020({ allErrors: true });
ajv.addSchema(schema, 'backlog');
const backlogShape = ajv.compile<Backlog>({ $ref: 'backlog' });
const solutionShape = ajv.compile<Solution>({ $ref: 'backlog#/$defs/solution' });

export type Parsed<T> = { value: T; errors: [] } | { value?: undefined; errors: string[] };

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
  if (!backlogShape(data)) return { errors: describe(backlogShape.errors) };

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
    }
    seen.add(t.id);
  }
  return problems.length ? { errors: problems } : { value: data, errors: [] };
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
}

/** Risposta di un LLM (interno o incollata): fattibilità + backlog + soluzione opzionale. */
export function parsePlannerAnswer(text: string): PlannerAnswer {
  const fence = text.search(/^```ya?ml/m);
  const feasibility = (fence >= 0 ? text.slice(0, fence) : '').trim();
  const blocks = yamlBlocks(text);
  const backlogText = blocks.find(b => /^project:/m.test(b));
  const solutionText = blocks.find(b => b !== backlogText && /^tasks:/m.test(b));
  if (!backlogText) return { feasibility, errors: ['Nessun backlog trovato (manca "project:").'] };
  const b = parseBacklog(backlogText);
  if (!b.value) return { feasibility, backlogText, solutionText, errors: b.errors };
  if (!solutionText) return { feasibility, backlogText, backlog: b.value, errors: [] };
  const s = parseSolution(solutionText, b.value);
  return { feasibility, backlogText, solutionText, backlog: b.value, solution: s.value, errors: s.errors.map(e => `soluzione: ${e}`) };
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
