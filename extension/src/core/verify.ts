import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backlog, Solution } from './backlog.ts';
import { applySolution, prepareTask } from './workspace.ts';
import { passed, runChecks, type CheckResult } from './checks.ts';

export type Log = (line: string) => void;

/** red: i controlli passano già senza lavoro. green: falliscono anche con la soluzione. */
export interface VerifyFailure { taskId: string; kind: 'red' | 'green'; output: string }

const tail = (rs: CheckResult[]) => rs.map(r => `$ ${r.check.run}\n${r.output}`).join('\n').slice(-3000);

/** Simula l'utente task dopo task in una cartella temporanea. null se tutto è coerente. */
export async function redGreen(backlog: Backlog, solution: Solution, log: Log): Promise<VerifyFailure | null> {
  const root = mkdtempSync(join(tmpdir(), 'mocoder-verify-'));
  try {
    for (const t of backlog.tasks) {
      prepareTask(root, t, true);
      const red = await runChecks(root, t.checks);
      if (passed(red)) {
        log(`FAIL ${t.id}  i check passano già prima del lavoro: non verificano niente`);
        return { taskId: t.id, kind: 'red', output: tail(red) };
      }
      applySolution(root, solution.tasks[t.id]);
      const green = await runChecks(root, t.checks);
      if (!passed(green)) {
        log(`FAIL ${t.id}  i check falliscono anche con la soluzione\n${tail(green)}`);
        return { taskId: t.id, kind: 'green', output: tail(green) };
      }
      log(`OK   ${t.id}  rosso → verde  (${t.title})`);
    }
    return null;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
