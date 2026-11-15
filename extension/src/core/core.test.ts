import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { parseBacklog, parseSolution, yamlBlocks } from './backlog.ts';
import { prepareTask, inside } from './workspace.ts';
import { runChecks, passed } from './checks.ts';
import { diagnose } from './diagnose.ts';
import { statusOf, nextTask, completedMilestone } from './progress.ts';
import { missingOnThisComputer, redGreen } from './verify.ts';

const examples = join(import.meta.dirname, '../../../examples');
const read = (p: string) => readFileSync(join(examples, p), 'utf8');
const javaText = read('registro-presenze/.mocoder/backlog.yaml');
const java = parseBacklog(javaText).value!;

/** The example backlog with a change: it must become invalid. */
function broken(change: (b: any) => void): string[] {
  const b = structuredClone(java);
  change(b);
  return parseBacklog(stringify(b)).errors;
}

test('the examples are valid', () => {
  for (const name of ['registro-presenze', 'analisi-spese']) {
    const b = parseBacklog(read(`${name}/.mocoder/backlog.yaml`));
    assert.deepEqual(b.errors, [], name);
    assert.deepEqual(parseSolution(read(`${name}/.mocoder/solution.yaml`), b.value!).errors, [], name);
  }
});

test('the backlog rejects structural errors and dangerous paths', () => {
  assert.match(broken(b => b.tasks[1].depends_on = ['T99']).join(), /T99/);
  assert.match(broken(b => b.tasks[1].depends_on = ['T08']).join(), /T08/);           // forward dependency
  assert.match(broken(b => b.tasks.push(structuredClone(b.tasks[0]))).join(), /duplicate/);
  assert.match(broken(b => b.tasks[0].milestone = 'M9').join(), /M9/);
  assert.match(broken(b => b.tasks[0].done_when = 'x').join(), /done_when/);            // invented field
  assert.match(broken(b => b.tasks[0].checks[1].expect = '(').join(), /regex/);
  assert.ok(broken(b => b.tasks[0].files[0].path = '../evil.txt').length);
  assert.ok(broken(b => b.tasks[0].files[0].path = '/etc/passwd').length);
  assert.ok(broken(b => b.tasks[0].files[0].path = 'C:/x.txt').length);
  assert.ok(broken(b => delete b.tasks[0].files[0].content).length);                    // given without content
  assert.ok(broken(b => b.tasks[0].hints = ['solo uno']).length);
  assert.ok(broken(b => b.tasks[0].search = ['a', 'b', 'c', 'd']).length);           // at most 3 searches
  assert.ok(java.tasks.every(t => t.search?.length), 'every example task says what to search for');
  // non-negotiable foundations
  assert.match(broken(b => b.tasks[0].files = b.tasks[0].files.filter((f: any) => f.path !== '.gitignore')).join(), /\.gitignore/);
  assert.match(broken(b => b.tasks[0].files = b.tasks[0].files.filter((f: any) => f.path !== 'README.md')).join(), /README/);
  const pom = (b: any) => b.tasks[0].files.find((f: any) => f.path === 'pom.xml');
  assert.match(broken(b => { pom(b).content = pom(b).content.replace('<version>3.5.5</version>', ''); }).join(), /maven-surefire-plugin has no pinned <version>/);
  assert.match(broken(b => { pom(b).content = pom(b).content.replace('<version>5.12.2</version>', ''); }).join(), /junit-jupiter has no <version>/);
  assert.match(broken(b => b.tasks[1].theory += '\nUsiamo CREATE TABLE books (...)').join(), /schema is not in a versioned \.sql file/);
  assert.match(broken(b => b.tasks[0].files = b.tasks[0].files.filter((f: any) => f.path !== 'pom.xml')).join(), /use mvn but no task creates pom\.xml/);
  assert.ok(broken(b => b.conventions = ['solo una']).length);                         // at least 3 rules
  assert.ok((java.conventions?.length ?? 0) >= 5, 'the example declares the project rules');
  // a text that became a structure and cannot be rebuilt: the error says how to fix it
  assert.match(broken(b => b.tasks[0].theory = { a: 1, b: 2 }).join(), /double quotes/);
  // logic errors seen in generated backlogs
  assert.match(broken(b => b.tasks[0].checks[1].expect = 'FAILED').join(), /looks for a failure/);
  assert.match(broken(b => { b.tasks[0].files[0].path = 't.py'; b.tasks[0].files[0].content = 'def test():\n    assert False\n'; }).join(), /assert False/);
});

test('autofix: typical chatbot format errors fix themselves', () => {
  const b = structuredClone(java);
  (b.tasks[0].hints as unknown[])[2] = { Soluzione: 'return x' };     // "- Soluzione: return x" without quotes
  b.tasks[0].checks[0].run = 'pytest -q tests';
  // seen with a free model: the class added in the task was never compiled → ClassNotFoundException
  b.tasks[1].checks[0].run = 'mvn -q exec:java -Dexec.mainClass=x.Main -Dexec.args=help';
  b.tasks[2].checks[0].run = 'mvn -q compile exec:java -Dexec.mainClass=x.Main';   // already right: untouched
  const r = parseBacklog(stringify(b));
  assert.deepEqual(r.errors, []);
  assert.equal(r.value!.tasks[0].hints[2], 'Soluzione: return x');
  assert.equal(r.value!.tasks[0].checks[0].run, 'python -m pytest -q tests');
  assert.equal(r.value!.tasks[1].checks[0].run, 'mvn -q compile exec:java -Dexec.mainClass=x.Main -Dexec.args=help');
  assert.equal(r.value!.tasks[2].checks[0].run, 'mvn -q compile exec:java -Dexec.mainClass=x.Main');
  assert.equal(r.fixes?.length, 3);
  assert.deepEqual(parseBacklog(javaText).fixes, []);                // a correct backlog is not touched
  assert.match(parseBacklog('a: [').errors.join(), /YAML/);
});

test('the test path is valid and its errors have an offline tip', async () => {
  const b = parseBacklog(read('broken/.mocoder/backlog.yaml'));
  assert.deepEqual(b.errors, []);
  const root = mkdtempSync(join(tmpdir(), 'mocoder-broken-'));
  prepareTask(root, b.value!.tasks[0], true);
  const rs = await runChecks(root, b.value!.tasks[0].checks);
  assert.ok(!passed(rs), 'the missing module must make the check fail');
  const d = diagnose(rs[0].output);
  assert.ok(d.tips.length, 'a missing module must have an offline tip');
  assert.match(d.tips[0].title, /spese/);
});

test('the solution must cover every task and only the user files', () => {
  const sol = (tasks: object) => parseSolution(stringify({ schema: 1, tasks }), java).errors.join();
  assert.match(sol({ T01: [{ path: 'pom.xml', content: '' }] }), /pom\.xml/);
  assert.match(sol({ T01: [{ path: 'src/main/java/it/presenze/App.java', content: '' }] }), /T02: missing/);
});

test('yamlBlocks takes the blocks of the LLM answer without breaking the inner ```', () => {
  const answer = '## Fattibilità\nSì.\n\n```yaml\na: 1\nhints:\n  - |\n    ```java\n    x();\n    ```\n```\n\n```yaml\nb: 2\n```\n';
  const blocks = yamlBlocks(answer);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /x\(\);/);
  assert.equal(blocks[1], 'b: 2\n');
  assert.deepEqual(yamlBlocks('c: 3'), ['c: 3']);
});

test('prepareTask writes the provided files and does not overwrite the user\'s work', () => {
  const root = mkdtempSync(join(tmpdir(), 'mocoder-test-'));
  const t02 = java.tasks[1];
  const files = prepareTask(root, t02, true);
  assert.deepEqual(files, ['src/main/java/it/presenze/model/Student.java']);
  const student = join(root, files[0]);
  assert.match(readFileSync(student, 'utf8'), /TODO/);
  writeFileSync(student, 'mio codice');
  prepareTask(root, t02, true);
  assert.equal(readFileSync(student, 'utf8'), 'mio codice');
  assert.ok(existsSync(join(root, 'src/test/java/it/presenze/model/StudentTest.java')));

  const empty = mkdtempSync(join(tmpdir(), 'mocoder-test-'));
  prepareTask(empty, t02, false);                                                       // autonomous mode
  assert.equal(readFileSync(join(empty, files[0]), 'utf8'), '');
  assert.throws(() => inside(root, '../fuori.txt'));
});

test('runChecks: exit code, expect and stop at the first error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocoder-test-'));
  const node = `"${process.execPath}"`;
  const ok = await runChecks(root, [{ run: `${node} -e "console.log('ciao mondo')"`, expect: 'ciao' }]);
  assert.ok(passed(ok));
  const noMatch = await runChecks(root, [{ run: `${node} -e "console.log('ciao')"`, expect: 'addio' }]);
  assert.ok(!passed(noMatch));
  assert.match(noMatch[0].output, /missing: addio/);
  const stops = await runChecks(root, [{ run: `${node} -e "process.exit(3)"` }, { run: `${node} -e ""` }]);
  assert.equal(stops.length, 1);
  assert.ok(!passed(stops));
});

test('runChecks: non-UTF-8 output (Python on Windows) read without mangled characters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocoder-test-'));
  // 0xE8 is "è" in Windows-1252 and Latin-1: it is what Python writes to a Windows pipe
  const [r] = await runChecks(root, [{ run: `"${process.execPath}" -e "process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0x66, 0xe8]))"` }]);
  assert.equal(r.output, 'caffè');
});

test('runChecks: an infinite loop is stopped with all its child processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocoder-test-'));
  const t0 = Date.now();
  // the shell launches node, which never terminates: before the fix the verification hung forever
  const [r] = await runChecks(root, [{ run: `"${process.execPath}" -e "setInterval(() => {}, 1000)"` }], 1500);
  assert.ok(!r.ok);
  assert.match(r.output, /stopped after 1.5s/);
  assert.ok(Date.now() - t0 < 10_000, 'the verification must return shortly after the timeout');
});

test('progress: unlock by dependencies and completed milestone', () => {
  const p = { done: [] as string[], hints: {} };
  assert.equal(nextTask(java, p)?.id, 'T01');
  assert.equal(statusOf(java.tasks[1], p), 'locked');
  p.done.push('T01', 'T02', 'T03', 'T04');
  assert.equal(completedMilestone(java, p, java.tasks[3]), undefined);
  p.done.push('T05');
  assert.equal(completedMilestone(java, p, java.tasks[4])?.id, 'M1');
  assert.equal(nextTask(java, p)?.id, 'T06');
});

test('missing on this computer: a tool or a declared dependency, never the check fault', () => {
  const root = mkdtempSync(join(tmpdir(), 'mocoder-missing-'));
  writeFileSync(join(root, 'requirements.txt'), 'FastAPI==0.115.0\nhttpx==0.27.2\n');
  writeFileSync(join(root, 'package.json'), '{ "dependencies": { "@scope/lib": "1.0.0", "left-pad": "1.3.0" } }');
  const py = (m: string) => `E   ModuleNotFoundError: No module named '${m}'`;
  assert.match(missingOnThisComputer(root, py('fastapi'))!, /fastapi is not installed.*pip install "FastAPI==0.115.0" "httpx==0.27.2"/);
  assert.match(missingOnThisComputer(root, py('fastapi.testclient'))!, /fastapi/);              // top-level name counts
  // not declared, or part of the project: the check (or the solution) is what is wrong
  assert.equal(missingOnThisComputer(root, py('requests')), undefined);
  mkdirSync(join(root, 'httpx'));
  assert.equal(missingOnThisComputer(root, py('httpx')), undefined);
  assert.match(missingOnThisComputer(root, "Error: Cannot find module 'left-pad'")!, /does not install npm packages.*npm install/);
  assert.match(missingOnThisComputer(root, "Cannot find package '@scope/lib/sub'")!, /@scope\/lib/);
  assert.equal(missingOnThisComputer(root, "Cannot find module './util'"), undefined);
  assert.match(missingOnThisComputer(root, "'mvn' is not recognized as an internal or external command")!, /program mvn/);
  assert.match(missingOnThisComputer(root, 'mvn: command not found')!, /program mvn/);
  assert.match(missingOnThisComputer(root, '[ERROR] Could not resolve dependencies for project x')!, /Maven could not download/);
  assert.equal(missingOnThisComputer(root, 'E   assert 1 == 2'), undefined);
});

test('red/green: an uninstalled declared dependency stops as "missing", not as a wrong check', async () => {
  const check = { run: 'python -c "import mocoder_never_installed_pkg"' };
  const task = { id: 'T01', milestone: 'M1', title: 'T', goal: 'g', theory: '', hints: [], checks: [check], files: [] };
  const backlog = { tasks: [task] } as unknown as Parameters<typeof redGreen>[0];
  const solution = { tasks: { T01: [{ path: 'requirements.txt', content: 'mocoder-never-installed-pkg==1.0\n' }] } } as unknown as Parameters<typeof redGreen>[1];
  const f = await redGreen(backlog, solution, () => {});
  assert.equal(f?.kind, 'missing');
  assert.match(f!.missing!, /mocoder_never_installed_pkg is not installed/);
  // without the declaration it is the check's fault, as before
  const undeclared = { tasks: { T01: [{ path: 'README.md', content: 'x\n' }] } } as unknown as Parameters<typeof redGreen>[1];
  assert.equal((await redGreen(backlog, undeclared, () => {}))?.kind, 'green');
});
