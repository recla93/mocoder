import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backlog, Solution } from './backlog.ts';
import { applySolution, prepareTask } from './workspace.ts';
import { passed, runChecks, type CheckResult } from './checks.ts';

export type Log = (line: string) => void;

/** red: the checks already pass without work. green: they fail even with the solution. */
export interface VerifyFailure { taskId: string; kind: 'red' | 'green'; output: string }

const tail = (rs: CheckResult[]) => rs.map(r => `$ ${r.check.run}\n${r.output}`).join('\n').slice(-3000);

/** Simulates the user task by task in a temporary folder. null if everything is consistent. */
export async function redGreen(backlog: Backlog, solution: Solution, log: Log): Promise<VerifyFailure | null> {
  const root = mkdtempSync(join(tmpdir(), 'mocoder-verify-'));
  try {
    for (const t of backlog.tasks) {
      prepareTask(root, t, true);
      const red = await runChecks(root, t.checks);
      if (passed(red)) {
        log(`FAIL ${t.id}  the checks already pass before the work: they verify nothing`);
        return { taskId: t.id, kind: 'red', output: tail(red) };
      }
      applySolution(root, solution.tasks[t.id]);
      const green = await runChecks(root, t.checks);
      if (!passed(green)) {
        log(`FAIL ${t.id}  the checks fail even with the solution\n${tail(green)}`);
        return { taskId: t.id, kind: 'green', output: tail(green) };
      }
      log(`OK   ${t.id}  red → green  (${t.title})`);
    }
    return null;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
