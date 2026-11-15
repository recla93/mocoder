import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backlog, Solution } from './backlog.ts';
import { applySolution, prepareTask } from './workspace.ts';
import { passed, runChecks, type CheckResult } from './checks.ts';
import { MAVEN_DOWNLOAD, MISSING_PROGRAM } from './diagnose.ts';

export type Log = (line: string) => void;

/**
 * red: the checks already pass without work. green: they fail even with the solution.
 * missing: they fail with the solution because this computer lacks a tool or a declared dependency:
 * the backlog is not necessarily wrong, and an AI "fix" would only damage it.
 */
export interface VerifyFailure { taskId: string; kind: 'red' | 'green' | 'missing'; output: string; missing?: string }

const tail = (rs: CheckResult[]) => rs.map(r => `$ ${r.check.run}\n${r.output}`).join('\n').slice(-3000);

const read = (root: string, file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '');
/** A dependency name as written in requirements/pyproject/package.json: case and -/_ do not matter. */
const declared = (text: string, name: string) =>
  new RegExp(`(^|[\\s"'\\[,])${name.replace(/[-_.]/g, '[-_.]')}([\\s"'<>=~!;\\[,]|$)`, 'im').test(text);

/**
 * What this computer lacks, if the output says so for certain; undefined if the failure may be the check's fault.
 * shortcut: a Python import name that differs from its package name (yaml/PyYAML) is not recognized,
 * and the failure stays "green"; upgrade with a map of the common ones if it shows up.
 */
export function missingOnThisComputer(root: string, output: string): string | undefined {
  const program = output.match(MISSING_PROGRAM);
  if (program) return `the program ${program.slice(1).find(Boolean)} is not installed (or not on the PATH): install it, then reopen VS Code`;
  if (MAVEN_DOWNLOAD.test(output)) {
    return 'Maven could not download the project dependencies: check the internet connection (or the proxy)';
  }
  const py = output.match(/ModuleNotFoundError: No module named '([\w]+)/)?.[1];
  if (py && !existsSync(join(root, py)) && !existsSync(join(root, `${py}.py`))) {
    const reqs = read(root, 'requirements.txt');
    // the requirements.txt here comes from the solution: the student's project may not have it yet, so the command lists them
    const specs = reqs.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('-'));
    if (declared(reqs, py)) return `the Python package ${py} is not installed: run \`python -m pip install ${specs.map(s => `"${s}"`).join(' ')}\``;
    if (declared(read(root, 'pyproject.toml'), py)) return `the Python package ${py} is not installed: run \`python -m pip install ${py}\``;
  }
  const node = output.match(/Cannot find (?:module|package) '([^'./][^']*)'/)?.[1];
  const pkg = node && (node.startsWith('@') ? node.split('/').slice(0, 2).join('/') : node.split('/')[0]);
  if (pkg && !existsSync(join(root, 'node_modules', pkg)) && read(root, 'package.json').includes(`"${pkg}"`)) {
    // npm installs into the project folder, never into the verification's temporary one
    return `the npm package ${pkg} is needed, and the backlog verification does not install npm packages: this task can only be checked in your project, after \`npm install\``;
  }
  return undefined;
}

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
        const missing = missingOnThisComputer(root, green.map(r => r.output).join('\n'));
        if (missing) {
          log(`STOP ${t.id}  cannot be verified on this computer: ${missing}`);
          return { taskId: t.id, kind: 'missing', output: tail(green), missing };
        }
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
