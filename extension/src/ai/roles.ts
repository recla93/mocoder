import { parsePlannerAnswer, repairRequest, type Backlog, type PlannerAnswer, type Solution, type Task } from '../core/backlog.ts';
import type { CheckResult } from '../core/checks.ts';
import type { VerifyFailure } from '../core/verify.ts';
import type { ChatMessage, Complete } from './providers.ts';

export type Guidance = 'guidato' | 'suggerimenti' | 'autonomo';

export const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '');

/** I file prompt hanno note d'uso in testa: il prompt vero inizia dopo la linea `---`. */
export const promptBody = (md: string) => (md.includes('\n---\n') ? md.slice(md.indexOf('\n---\n') + 5) : md);

// ---------------------------------------------------------------- Planner

export const MAX_REPAIRS = 2;
const PLANNER_SYSTEM = 'Segui esattamente il formato richiesto. Rispondi in italiano.';

export interface PlanOutcome extends PlannerAnswer { answer: string; attempts: number }

/**
 * Chiede il backlog e, se non è valido, rimanda gli errori al modello fino a MAX_REPAIRS volte.
 * Se il modello giudica l'idea non fattibile (nessun YAML), si ferma subito: è una risposta legittima.
 */
export async function plan(complete: Complete, prompt: string, onText?: (delta: string) => void): Promise<PlanOutcome> {
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  for (let attempt = 1; ; attempt++) {
    const { text } = await complete({ system: PLANNER_SYSTEM, messages, maxTokens: 64000, effort: 'high', onText });
    const parsed = parsePlannerAnswer(text);
    const errors = [...parsed.errors];
    if (parsed.backlog && !parsed.solutionText) errors.push('Manca il secondo blocco YAML con la soluzione di riferimento ($defs/solution).');
    const notFeasible = !/^```ya?ml/m.test(text);
    if (!errors.length || notFeasible || attempt > MAX_REPAIRS) return { ...parsed, errors, answer: text, attempts: attempt };
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: repairRequest(errors) });
  }
}

// ---------------------------------------------------------------- Correzione guidata dalla verifica

/** Richiesta autosufficiente: funziona anche per backlog importati da un LLM esterno. */
export function fixRequest(backlogText: string, solutionText: string, f: VerifyFailure): string {
  const problem = f.kind === 'red'
    ? 'i controlli passano già PRIMA del lavoro dello studente, quindi non verificano niente. Rendi i test più severi oppure fai in modo che lo scheletro iniziale non li soddisfi.'
    : 'i controlli falliscono anche con la soluzione di riferimento. O il test o la soluzione è sbagliato: correggi quello sbagliato (un test che non può mai passare, come `assert False`, è sbagliato).';
  return [
    'La verifica automatica del backlog mocoder è fallita: per ogni task i controlli devono fallire prima del lavoro e passare con la soluzione di riferimento.',
    // tieni allineate con "Regole tecniche sui controlli" in prompts/planner.md
    'Regole dei controlli: un check passa solo se il comando termina con exit code 0 e, se c\'è `expect`, l\'output lo contiene. ' +
    'Un task non può avere come obiettivo "un test che fallisce". I comandi partono dalla radice del progetto; ' +
    'per Python usa `python -m pytest`, non `pytest`, altrimenti i moduli nella radice non sono importabili.',
    `Task ${f.taskId}: ${problem}`,
    `Output dei controlli:\n\`\`\`\n${f.output}\n\`\`\``,
    'Restituisci di nuovo entrambi i blocchi YAML completi (backlog e soluzione), corretti, senza altro testo. Non cambiare i task che già funzionano.',
    `Backlog attuale:\n\`\`\`yaml\n${backlogText}\n\`\`\``,
    `Soluzione attuale:\n\`\`\`yaml\n${solutionText}\n\`\`\``,
  ].join('\n\n');
}

export const MAX_FIX_ROUNDS = 2;     // tentativi per lo stesso task: ogni correzione di solito ne sistema uno
export const MAX_TOTAL_FIXES = 10;   // tetto di sicurezza per backlog lunghi o modelli che cambiano gli id

export interface FixOutcome { backlogText: string; solutionText: string; failure: VerifyFailure | null; rounds: number }

/**
 * Verifica, e finché fallisce chiede al Planner di correggere il task che non va
 * (al massimo MAX_FIX_ROUNDS volte per task, MAX_TOTAL_FIXES in tutto).
 * Ogni risposta passa prima dal controllo dello schema di `plan`, poi di nuovo dalla verifica.
 */
export async function fixUntilGreen(
  complete: Complete,
  start: { backlogText: string; solutionText: string },
  verify: (backlog: Backlog, solution: Solution) => Promise<VerifyFailure | null>,
  log: (line: string) => void = () => {},
  known?: VerifyFailure,   // esito di una verifica appena fatta: evita di rifarla (con Maven costa minuti)
): Promise<FixOutcome> {
  let { backlogText, solutionText } = start;
  const tries = new Map<string, number>();
  for (let round = 0; ; round++) {
    const parsed = parsePlannerAnswer(`\`\`\`yaml\n${backlogText}\n\`\`\`\n\`\`\`yaml\n${solutionText}\n\`\`\``);
    if (!parsed.backlog || !parsed.solution) throw new Error(`backlog o soluzione non validi: ${parsed.errors.join('; ')}`);
    const failure = round === 0 && known ? known : await verify(parsed.backlog, parsed.solution);
    const n = failure ? tries.get(failure.taskId) ?? 0 : 0;
    if (!failure || n >= MAX_FIX_ROUNDS || round >= MAX_TOTAL_FIXES) return { backlogText, solutionText, failure, rounds: round };
    tries.set(failure.taskId, n + 1);
    log(`Correzione di ${failure.taskId}, tentativo ${n + 1}/${MAX_FIX_ROUNDS} (${failure.kind === 'red' ? 'passa già prima del lavoro' : 'fallisce con la soluzione'})`);
    const fixed = await plan(complete, fixRequest(backlogText, solutionText, failure));
    if (!fixed.backlog || !fixed.solution || fixed.errors.length) {
      log(`Il Planner non ha restituito un backlog valido: ${fixed.errors.join('; ')}`);
      return { backlogText, solutionText, failure, rounds: round + 1 };
    }
    backlogText = fixed.backlogText!;
    solutionText = fixed.solutionText!;
  }
}

// ---------------------------------------------------------------- Mentor e Reviewer

export interface StudentFile { path: string; content?: string }   // content assente = file troppo grande o mancante
export interface Exchange { role: 'student' | 'tutor' | 'review'; text: string }

const fence = (f: StudentFile) =>
  f.content === undefined ? `#### ${f.path}\n(file mancante o troppo grande, non inviato)` : `#### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``;

/**
 * Contesto del task per il Mentor. I suggerimenti passati al modello si fermano prima della soluzione
 * finché lo studente non l'ha aperta: così non può rivelarla nemmeno per sbaglio.
 */
export function taskContext(task: Task, guidance: Guidance, hintsShown: number, files: StudentFile[], results?: CheckResult[]) {
  const visible = guidance === 'autonomo' ? [] : task.hints.slice(0, Math.max(hintsShown, task.hints.length - 1));
  const check = results?.length
    ? results.map(r => `${r.ok ? '✓' : '✗'} \`${r.check.run}\`\n\`\`\`\n${r.output.slice(-4000).trim()}\n\`\`\``).join('\n')
    : 'Non ancora eseguita.';
  return [
    `## Task ${task.id} · ${task.title}`,
    `Obiettivo: ${task.goal}`,
    `Livello di guida scelto dallo studente: **${guidance}**`,
    `Suggerimenti già aperti dallo studente: ${hintsShown} di ${task.hints.length}`,
    `### Teoria del task\n${task.theory}`,
    visible.length ? `### Suggerimenti previsti dal percorso (riservati a te)\n${visible.map((h, i) => `${i + 1}. ${h}`).join('\n')}` : '',
    `### File dello studente\n${files.map(fence).join('\n') || '(nessuno)'}`,
    `### Ultima verifica\n${check}`,
  ].filter(Boolean).join('\n\n');
}

/** Una sola richiesta con contesto sempre aggiornato: i file cambiano tra una domanda e l'altra. */
export function mentorMessages(context: string, history: Exchange[], question: string): ChatMessage[] {
  const past = history.filter(e => e.role !== 'review').slice(-12)
    .map(e => `**${e.role === 'student' ? 'Studente' : 'Tutor'}:** ${e.text}`).join('\n\n');
  return [{
    role: 'user',
    content: `${context}\n\n${past ? `### Conversazione finora\n${past}\n\n` : ''}### Domanda dello studente\n${question}`,
  }];
}

export function reviewMessages(tasks: Task[], files: StudentFile[], scope: string): ChatMessage[] {
  const criteria = tasks.map(t =>
    `- **${t.id} · ${t.title}**: ${t.goal}${t.review?.length ? `\n  Criteri: ${t.review.join('; ')}` : ''}`).join('\n');
  return [{
    role: 'user',
    content: `Review di ${scope}. I controlli automatici sono già verdi.\n\n### Task\n${criteria}\n\n### Codice\n${files.map(fence).join('\n')}`,
  }];
}
