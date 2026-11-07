import { spawn } from 'node:child_process';
import type { Check } from './backlog.ts';

export interface CheckResult { check: Check; ok: boolean; output: string }

const MAX_OUTPUT = 20_000;

const WINDOWS = process.platform === 'win32';

/**
 * Ferma il comando e tutto ciò che ha lanciato. Fermare solo la shell non basta: il programma figlio
 * (un ciclo infinito dello studente, la JVM di Maven) resterebbe vivo e terrebbe aperto l'output.
 */
function killTree(pid: number | undefined) {
  if (!pid) return;
  if (WINDOWS) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGKILL'); } catch { /* già terminato */ }
}

function runOne(root: string, check: Check, timeoutMs: number): Promise<CheckResult> {
  return new Promise(done => {
    // detached su Unix crea un gruppo di processi, così kill(-pid) li ferma tutti
    const child = spawn(check.run, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !WINDOWS });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    let stdout = '';
    let all = '';
    child.stdout.on('data', d => { stdout += d; all += d; });
    child.stderr.on('data', d => { all += d; });
    child.on('error', e => { clearTimeout(timer); done({ check, ok: false, output: e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return done({ check, ok: false, output: (all + `\n[interrotto dopo ${timeoutMs / 1000}s]`).slice(-MAX_OUTPUT) });
      const expected = !check.expect || new RegExp(check.expect).test(stdout);
      const missing = code === 0 && !expected ? `\n[nell'output manca: ${check.expect}]` : '';
      done({ check, ok: code === 0 && expected, output: (all + missing).slice(-MAX_OUTPUT) });
    });
  });
}

/** Esegue i check in ordine e si ferma al primo che fallisce. */
export async function runChecks(root: string, checks: Check[], timeoutMs = 300_000): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    const r = await runOne(root, c, timeoutMs);
    results.push(r);
    if (!r.ok) break;
  }
  return results;
}

export const passed = (results: CheckResult[]) => results.length > 0 && results.every(r => r.ok);
