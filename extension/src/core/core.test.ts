import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { parseBacklog, parseSolution, yamlBlocks } from './backlog.ts';
import { prepareTask, inside } from './workspace.ts';
import { runChecks, passed } from './checks.ts';
import { statusOf, nextTask, completedMilestone } from './progress.ts';

const examples = join(import.meta.dirname, '../../../examples');
const read = (p: string) => readFileSync(join(examples, p), 'utf8');
const javaText = read('registro-presenze/.mocoder/backlog.yaml');
const java = parseBacklog(javaText).value!;

/** Il backlog d'esempio con una modifica: deve diventare invalido. */
function broken(change: (b: any) => void): string[] {
  const b = structuredClone(java);
  change(b);
  return parseBacklog(stringify(b)).errors;
}

test('gli esempi sono validi', () => {
  for (const name of ['registro-presenze', 'analisi-spese']) {
    const b = parseBacklog(read(`${name}/.mocoder/backlog.yaml`));
    assert.deepEqual(b.errors, [], name);
    assert.deepEqual(parseSolution(read(`${name}/.mocoder/solution.yaml`), b.value!).errors, [], name);
  }
});

test('il backlog rifiuta errori strutturali e percorsi pericolosi', () => {
  assert.match(broken(b => b.tasks[1].depends_on = ['T99']).join(), /T99/);
  assert.match(broken(b => b.tasks[1].depends_on = ['T08']).join(), /T08/);           // dipendenza in avanti
  assert.match(broken(b => b.tasks.push(structuredClone(b.tasks[0]))).join(), /duplicato/);
  assert.match(broken(b => b.tasks[0].milestone = 'M9').join(), /M9/);
  assert.match(broken(b => b.tasks[0].done_when = 'x').join(), /done_when/);            // campo inventato
  assert.match(broken(b => b.tasks[0].checks[1].expect = '(').join(), /regex/);
  assert.ok(broken(b => b.tasks[0].files[0].path = '../evil.txt').length);
  assert.ok(broken(b => b.tasks[0].files[0].path = '/etc/passwd').length);
  assert.ok(broken(b => b.tasks[0].files[0].path = 'C:/x.txt').length);
  assert.ok(broken(b => delete b.tasks[0].files[0].content).length);                    // given senza contenuto
  assert.ok(broken(b => b.tasks[0].hints = ['solo uno']).length);
  assert.ok(broken(b => b.tasks[0].search = ['a', 'b', 'c', 'd']).length);           // al massimo 3 ricerche
  assert.ok(java.tasks.every(t => t.search?.length), 'ogni task d\'esempio indica cosa cercare');
  // fondamenta non negoziabili
  assert.match(broken(b => b.tasks[0].files = b.tasks[0].files.filter((f: any) => f.path !== '.gitignore')).join(), /\.gitignore/);
  assert.match(broken(b => b.tasks[0].files = b.tasks[0].files.filter((f: any) => f.path !== 'README.md')).join(), /README/);
  const pom = (b: any) => b.tasks[0].files.find((f: any) => f.path === 'pom.xml');
  assert.match(broken(b => { pom(b).content = pom(b).content.replace('<version>3.5.5</version>', ''); }).join(), /maven-surefire-plugin non ha una <version>/);
  assert.match(broken(b => { pom(b).content = pom(b).content.replace('<version>5.12.2</version>', ''); }).join(), /junit-jupiter non ha una <version>/);
  assert.match(broken(b => b.tasks[1].theory += '\nUsiamo CREATE TABLE books (...)').join(), /schema non è in un file \.sql/);
  assert.match(broken(b => b.tasks[0].files = b.tasks[0].files.filter((f: any) => f.path !== 'pom.xml')).join(), /usano mvn ma nessun task crea il pom\.xml/);
  assert.ok(broken(b => b.conventions = ['solo una']).length);                         // almeno 3 regole
  assert.ok((java.conventions?.length ?? 0) >= 5, 'l\'esempio dichiara le regole del progetto');
  // un testo diventato struttura che non si può ricostruire: l'errore dice come correggerlo
  assert.match(broken(b => b.tasks[0].theory = { a: 1, b: 2 }).join(), /tra virgolette/);
  // errori di logica visti nei backlog generati
  assert.match(broken(b => b.tasks[0].checks[1].expect = 'FAILED').join(), /cerca un fallimento/);
  assert.match(broken(b => { b.tasks[0].files[0].path = 't.py'; b.tasks[0].files[0].content = 'def test():\n    assert False\n'; }).join(), /assert False/);
});

test('autofix: gli errori di formato tipici dei chatbot si correggono da soli', () => {
  const b = structuredClone(java);
  (b.tasks[0].hints as unknown[])[2] = { Soluzione: 'return x' };     // "- Soluzione: return x" senza virgolette
  b.tasks[0].checks[0].run = 'pytest -q tests';
  const r = parseBacklog(stringify(b));
  assert.deepEqual(r.errors, []);
  assert.equal(r.value!.tasks[0].hints[2], 'Soluzione: return x');
  assert.equal(r.value!.tasks[0].checks[0].run, 'python -m pytest -q tests');
  assert.equal(r.fixes?.length, 2);
  assert.deepEqual(parseBacklog(javaText).fixes, []);                // un backlog corretto non viene toccato
  assert.match(parseBacklog('a: [').errors.join(), /YAML/);
});

test('la soluzione deve coprire ogni task e solo i file dell\'utente', () => {
  const sol = (tasks: object) => parseSolution(stringify({ schema: 1, tasks }), java).errors.join();
  assert.match(sol({ T01: [{ path: 'pom.xml', content: '' }] }), /pom\.xml/);
  assert.match(sol({ T01: [{ path: 'src/main/java/it/presenze/App.java', content: '' }] }), /T02: manca/);
});

test('yamlBlocks prende i blocchi della risposta LLM senza spezzare i ``` interni', () => {
  const answer = '## Fattibilità\nSì.\n\n```yaml\na: 1\nhints:\n  - |\n    ```java\n    x();\n    ```\n```\n\n```yaml\nb: 2\n```\n';
  const blocks = yamlBlocks(answer);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /x\(\);/);
  assert.equal(blocks[1], 'b: 2\n');
  assert.deepEqual(yamlBlocks('c: 3'), ['c: 3']);
});

test('prepareTask scrive i file forniti e non sovrascrive il lavoro dell\'utente', () => {
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
  prepareTask(empty, t02, false);                                                       // modalità autonoma
  assert.equal(readFileSync(join(empty, files[0]), 'utf8'), '');
  assert.throws(() => inside(root, '../fuori.txt'));
});

test('runChecks: exit code, expect e stop al primo errore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocoder-test-'));
  const node = `"${process.execPath}"`;
  const ok = await runChecks(root, [{ run: `${node} -e "console.log('ciao mondo')"`, expect: 'ciao' }]);
  assert.ok(passed(ok));
  const noMatch = await runChecks(root, [{ run: `${node} -e "console.log('ciao')"`, expect: 'addio' }]);
  assert.ok(!passed(noMatch));
  assert.match(noMatch[0].output, /manca: addio/);
  const stops = await runChecks(root, [{ run: `${node} -e "process.exit(3)"` }, { run: `${node} -e ""` }]);
  assert.equal(stops.length, 1);
  assert.ok(!passed(stops));
});

test('runChecks: output non UTF-8 (Python su Windows) letto senza caratteri rovinati', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocoder-test-'));
  // 0xE8 è "è" in Windows-1252 e Latin-1: è quello che Python scrive su una pipe di Windows
  const [r] = await runChecks(root, [{ run: `"${process.execPath}" -e "process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0x66, 0xe8]))"` }]);
  assert.equal(r.output, 'caffè');
});

test('runChecks: un ciclo infinito viene fermato con tutti i processi figli', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocoder-test-'));
  const t0 = Date.now();
  // la shell lancia node, che non termina mai: prima della correzione la verifica restava appesa per sempre
  const [r] = await runChecks(root, [{ run: `"${process.execPath}" -e "setInterval(() => {}, 1000)"` }], 1500);
  assert.ok(!r.ok);
  assert.match(r.output, /interrotto dopo 1.5s/);
  assert.ok(Date.now() - t0 < 10_000, 'la verifica deve tornare poco dopo il timeout');
});

test('progressi: sblocco per dipendenze e milestone completata', () => {
  const p = { done: [] as string[], hints: {} };
  assert.equal(nextTask(java, p)?.id, 'T01');
  assert.equal(statusOf(java.tasks[1], p), 'locked');
  p.done.push('T01', 'T02', 'T03', 'T04');
  assert.equal(completedMilestone(java, p, java.tasks[3]), undefined);
  p.done.push('T05');
  assert.equal(completedMilestone(java, p, java.tasks[4])?.id, 'M1');
  assert.equal(nextTask(java, p)?.id, 'T06');
});
