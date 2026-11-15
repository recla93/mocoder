import { spawn } from 'node:child_process';
import type { Check } from './backlog.ts';

export interface CheckResult { check: Check; ok: boolean; output: string }

const MAX_OUTPUT = 20_000;

const WINDOWS = process.platform === 'win32';

/**
 * Stops the command and everything it launched. Stopping only the shell is not enough: the child program
 * (a student's infinite loop, Maven's JVM) would stay alive and keep the output open.
 */
function killTree(pid: number | undefined) {
  if (!pid) return;
  if (WINDOWS) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGKILL'); } catch { /* already terminated */ }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
// On Windows programs (Python, Java) write in ANSI encoding; cmd messages in OEM encoding.
// shortcut: everything is decoded as Windows-1252, so in cmd messages accented letters get
// mangled ("non Š riconosciuto"); the diagnose rules take this into account.
const fallback = new TextDecoder(WINDOWS ? 'windows-1252' : 'latin1');

/** UTF-8 if valid, otherwise the system's typical encoding: no mangled characters in the students' output. */
export function decodeOutput(buf: Buffer): string {
  try {
    return utf8.decode(buf);
  } catch {
    return fallback.decode(buf);
  }
}

function runOne(root: string, check: Check, timeoutMs: number): Promise<CheckResult> {
  return new Promise(done => {
    // detached on Unix creates a process group, so kill(-pid) stops them all
    const child = spawn(check.run, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !WINDOWS });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    const outBufs: Buffer[] = [];
    const allBufs: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => { outBufs.push(d); allBufs.push(d); });
    child.stderr.on('data', (d: Buffer) => { allBufs.push(d); });
    child.on('error', e => { clearTimeout(timer); done({ check, ok: false, output: e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      const stdout = decodeOutput(Buffer.concat(outBufs));
      const all = decodeOutput(Buffer.concat(allBufs));
      if (timedOut) return done({ check, ok: false, output: (all + `\n[stopped after ${timeoutMs / 1000}s]`).slice(-MAX_OUTPUT) });
      const expected = !check.expect || new RegExp(check.expect).test(stdout);
      const missing = code === 0 && !expected ? `\n[output is missing: ${check.expect}]` : '';
      done({ check, ok: code === 0 && expected, output: (all + missing).slice(-MAX_OUTPUT) });
    });
  });
}

/** Runs the checks in order and stops at the first one that fails. */
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
