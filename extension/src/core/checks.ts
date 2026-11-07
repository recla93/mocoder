import { spawn } from 'node:child_process';
import type { Check } from './backlog.ts';

export interface CheckResult { check: Check; ok: boolean; output: string }

const MAX_OUTPUT = 20_000;

function runOne(root: string, check: Check, timeoutMs: number): Promise<CheckResult> {
  return new Promise(done => {
    // shortcut: su Windows il timeout ferma la shell, non sempre i processi figli (es. la JVM di mvn)
    const child = spawn(check.run, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let stdout = '';
    let all = '';
    child.stdout.on('data', d => { stdout += d; all += d; });
    child.stderr.on('data', d => { all += d; });
    child.on('error', e => done({ check, ok: false, output: e.message }));
    child.on('close', (code, signal) => {
      const timedOut = signal ? `\n[interrotto dopo ${timeoutMs / 1000}s]` : '';
      const expected = !check.expect || new RegExp(check.expect).test(stdout);
      const missing = code === 0 && !expected ? `\n[nell'output manca: ${check.expect}]` : '';
      done({ check, ok: code === 0 && expected, output: (all + timedOut + missing).slice(-MAX_OUTPUT) });
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
