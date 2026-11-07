/**
 * Verifica un backlog: schema e coerenza; con la soluzione, per ogni task
 * i check devono FALLIRE prima del lavoro (rosso) e PASSARE dopo (verde).
 *
 * uso: node src/cli/verify.ts <backlog.yaml> [<solution.yaml>]
 */
import { readFileSync } from 'node:fs';
import { parseBacklog, parseSolution } from '../core/backlog.ts';
import { redGreen } from '../core/verify.ts';

async function main(args: string[]): Promise<number> {
  const [backlogPath, solutionPath] = args;
  if (!backlogPath) {
    console.error('uso: node src/cli/verify.ts <backlog.yaml> [<solution.yaml>]');
    return 2;
  }
  const b = parseBacklog(readFileSync(backlogPath, 'utf8'));
  if (!b.value) {
    b.errors.forEach(e => console.log('ERRORE', e));
    return 1;
  }
  console.log(`Backlog OK: ${b.value.milestones.length} milestone, ${b.value.tasks.length} task`);
  if (!solutionPath) return 0;

  const s = parseSolution(readFileSync(solutionPath, 'utf8'), b.value);
  if (!s.value) {
    s.errors.forEach(e => console.log('ERRORE', e));
    return 1;
  }
  return (await redGreen(b.value, s.value, console.log)) ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
