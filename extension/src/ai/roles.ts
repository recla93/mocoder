import { parsePlannerAnswer, repairRequest, type Backlog, type PlannerAnswer, type Solution, type Task } from '../core/backlog.ts';
import type { CheckResult } from '../core/checks.ts';
import type { VerifyFailure } from '../core/verify.ts';
import type { ChatMessage, Complete } from './providers.ts';

export type Guidance = 'guided' | 'hints' | 'autonomous';

export const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '');

/** Prompt files have usage notes at the top: the real prompt starts after the `---` line. */
export const promptBody = (md: string) => (md.includes('\n---\n') ? md.slice(md.indexOf('\n---\n') + 5) : md);

// ---------------------------------------------------------------- Planner

export const MAX_REPAIRS = 2;
const PLANNER_SYSTEM = 'Follow the requested format exactly. Write all user-facing content (titles, theory, hints, review criteria, conventions) in the language of the user\'s idea. Keep identifiers, file paths, commands and code in English.';

export interface PlanOutcome extends PlannerAnswer { answer: string; attempts: number }

/**
 * Asks for the backlog and, if invalid, sends the errors back to the model up to MAX_REPAIRS times.
 * If the model judges the idea not feasible (no YAML), it stops at once: that is a legitimate answer.
 */
export async function plan(complete: Complete, prompt: string, onText?: (delta: string) => void): Promise<PlanOutcome> {
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  let feasibility = '';
  for (let attempt = 1; ; attempt++) {
    const { text } = await complete({ system: PLANNER_SYSTEM, messages, maxTokens: 64000, effort: 'high', onText });
    // a repair answer is usually YAML only: the feasibility written in the first answer must not be lost
    const parsed = { ...parsePlannerAnswer(text) };
    feasibility ||= parsed.feasibility;
    parsed.feasibility ||= feasibility;
    const errors = [...parsed.errors];
    if (parsed.backlog && !parsed.solutionText) errors.push('The second YAML block with the reference solution ($defs/solution) is missing.');
    const notFeasible = !/^```ya?ml/m.test(text);
    if (!errors.length || notFeasible || attempt > MAX_REPAIRS) return { ...parsed, errors, answer: text, attempts: attempt };
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: repairRequest(errors) });
  }
}

// ---------------------------------------------------------------- Verification-driven fixing

/** Self-contained request: it also works for backlogs imported from an external LLM. */
export function fixRequest(backlogText: string, solutionText: string, f: VerifyFailure): string {
  const problem = f.kind === 'red'
    ? 'the checks already pass BEFORE the student\'s work, so they verify nothing. Make the tests stricter or make the initial skeleton fail them.'
    : 'the checks fail even with the reference solution. Either the test or the solution is wrong: fix the wrong one (a test that can never pass, such as `assert False`, is wrong).';
  return [
    'Automatic verification of the mocoder backlog failed: for every task the checks must fail before the work and pass with the reference solution.',
    // keep in sync with "Technical rules on checks" in prompts/planner.md
    'Check rules: a check passes only if the command exits with code 0 and, if `expect` is present, the output contains it. ' +
    'A task cannot have "a failing test" as its goal. Commands run from the project root; ' +
    'for Python use `python -m pytest`, not `pytest`, otherwise modules in the root are not importable; ' +
    'for Maven use `mvn -q compile exec:java ...` to run the program, because `exec:java` alone does not compile; ' +
    'for JavaScript/TypeScript prefer `node --test "test/**/*.test.ts"` with `node:assert/strict` and no npm dependencies, ' +
    'because the verification folder has no node_modules.',
    `Task ${f.taskId}: ${problem}`,
    `Check output:\n\`\`\`\n${f.output}\n\`\`\``,
    'Return both complete YAML blocks (backlog and solution) again, fixed, with no other text. Do not change tasks that already work.',
    `Current backlog:\n\`\`\`yaml\n${backlogText}\n\`\`\``,
    `Current solution:\n\`\`\`yaml\n${solutionText}\n\`\`\``,
  ].join('\n\n');
}

export const MAX_FIX_ROUNDS = 2;     // attempts for the same task: each fix usually resolves one
export const MAX_TOTAL_FIXES = 10;   // safety cap for long backlogs or models that change ids

export interface FixOutcome { backlogText: string; solutionText: string; failure: VerifyFailure | null; rounds: number }

/**
 * Verifies, and while it fails asks the Planner to fix the task that is wrong
 * (at most MAX_FIX_ROUNDS times per task, MAX_TOTAL_FIXES in all).
 * Every answer goes first through `plan`'s schema check, then through verification again.
 */
export async function fixUntilGreen(
  complete: Complete,
  start: { backlogText: string; solutionText: string },
  verify: (backlog: Backlog, solution: Solution) => Promise<VerifyFailure | null>,
  log: (line: string) => void = () => {},
  known?: VerifyFailure,   // result of a verification just done: avoids repeating it (with Maven it costs minutes)
): Promise<FixOutcome> {
  let { backlogText, solutionText } = start;
  const tries = new Map<string, number>();
  for (let round = 0; ; round++) {
    const parsed = parsePlannerAnswer(`\`\`\`yaml\n${backlogText}\n\`\`\`\n\`\`\`yaml\n${solutionText}\n\`\`\``);
    if (!parsed.backlog || !parsed.solution) throw new Error(`invalid backlog or solution: ${parsed.errors.join('; ')}`);
    const failure = round === 0 && known ? known : await verify(parsed.backlog, parsed.solution);
    const n = failure ? tries.get(failure.taskId) ?? 0 : 0;
    // "missing" is this computer's problem, not the backlog's: the Planner cannot fix it
    if (!failure || failure.kind === 'missing' || n >= MAX_FIX_ROUNDS || round >= MAX_TOTAL_FIXES) return { backlogText, solutionText, failure, rounds: round };
    tries.set(failure.taskId, n + 1);
    log(`Fixing ${failure.taskId}, attempt ${n + 1}/${MAX_FIX_ROUNDS} (${failure.kind === 'red' ? 'passes before the work' : 'fails with the solution'})`);
    const fixed = await plan(complete, fixRequest(backlogText, solutionText, failure));
    if (!fixed.backlog || !fixed.solution || fixed.errors.length) {
      log(`The Planner did not return a valid backlog: ${fixed.errors.join('; ')}`);
      return { backlogText, solutionText, failure, rounds: round + 1 };
    }
    backlogText = fixed.backlogText!;
    solutionText = fixed.solutionText!;
  }
}

// ---------------------------------------------------------------- Mentor and Reviewer

export interface StudentFile { path: string; content?: string }   // content absent = file too large or missing
export interface Exchange { role: 'student' | 'tutor' | 'review'; text: string }

/** The context has a cap: beyond it, truncate instead of making the request fail or exceed the model window. */
export const MAX_CONTEXT_CHARS = 60_000;

/** Keeps the file order and truncates the first one that overflows: the model sees code, not a provider error. */
export function capFiles(files: StudentFile[], maxChars = MAX_CONTEXT_CHARS): StudentFile[] {
  let left = maxChars;
  const out: StudentFile[] = [];
  for (const f of files) {
    if (f.content === undefined) { out.push(f); continue; }
    if (left <= 0) { out.push({ path: f.path }); continue; }
    if (f.content.length <= left) { out.push(f); left -= f.content.length; continue; }
    const head = f.content.slice(0, left);
    out.push({ path: f.path, content: `${head}\n\n[…truncated: ${f.content.length - head.length} of ${f.content.length} characters]` });
    left = 0;
  }
  return out;
}

const fence = (f: StudentFile) =>
  f.content === undefined ? `#### ${f.path}\n(file missing or too large, not sent)` : `#### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``;

/**
 * Task context for the Mentor. The hints passed to the model stop before the solution
 * until the student has opened it: so it cannot reveal it even by mistake.
 */
export function taskContext(task: Task, guidance: Guidance, hintsShown: number, files: StudentFile[], results?: CheckResult[]) {
  const visible = guidance === 'autonomous' ? [] : task.hints.slice(0, Math.max(hintsShown, task.hints.length - 1));
  const check = results?.length
    ? results.map(r => `${r.ok ? '✓' : '✗'} \`${r.check.run}\`\n\`\`\`\n${r.output.slice(-4000).trim()}\n\`\`\``).join('\n')
    : 'Not run yet.';
  return [
    `## Task ${task.id} · ${task.title}`,
    `Goal: ${task.goal}`,
    `Guidance level chosen by the student: **${guidance}**`,
    `Hints already opened by the student: ${hintsShown} of ${task.hints.length}`,
    `### Task theory\n${task.theory}`,
    visible.length ? `### Hints from the path (for you only)\n${visible.map((h, i) => `${i + 1}. ${h}`).join('\n')}` : '',
    `### Student files\n${files.map(fence).join('\n') || '(none)'}`,
    `### Last check\n${check}`,
  ].filter(Boolean).join('\n\n');
}

/** A single request with always-fresh context: files change between one question and the next. */
export function mentorMessages(context: string, history: Exchange[], question: string): ChatMessage[] {
  const past = history.filter(e => e.role !== 'review').slice(-12)
    .map(e => `**${e.role === 'student' ? 'Student' : 'Tutor'}:** ${e.text}`).join('\n\n');
  return [{
    role: 'user',
    content: `${context}\n\n${past ? `### Conversation so far\n${past}\n\n` : ''}### Student's question\n${question}`,
  }];
}

export function reviewMessages(tasks: Task[], files: StudentFile[], scope: string, conventions: string[] = []): ChatMessage[] {
  const criteria = tasks.map(t =>
    `- **${t.id} · ${t.title}**: ${t.goal}${t.review?.length ? `\n  Criteria: ${t.review.join('; ')}` : ''}`).join('\n');
  const rules = conventions.length ? `### Project rules\n${conventions.map(c => `- ${c}`).join('\n')}\n\n` : '';
  return [{
    role: 'user',
    content: `Review of ${scope}. The automatic checks are already green.\n\n${rules}### Task\n${criteria}\n\n### Code\n${files.map(fence).join('\n')}`,
  }];
}
