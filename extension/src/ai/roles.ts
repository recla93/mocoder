import { parsePlannerAnswer, repairRequest, type PlannerAnswer, type Task } from '../core/backlog.ts';
import type { CheckResult } from '../core/checks.ts';
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
