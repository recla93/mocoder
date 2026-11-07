import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBacklog } from './backlog.ts';
import { commandsOf, commandsHash, suspicious } from './trust.ts';

const read = (p: string) => parseBacklog(readFileSync(join(import.meta.dirname, '../../../examples', p), 'utf8')).value!;
const java = read('registro-presenze/.mocoder/backlog.yaml');
const python = read('analisi-spese/.mocoder/backlog.yaml');

test('elenco dei comandi: distinti e nell\'ordine del percorso', () => {
  assert.deepEqual(commandsOf(python), ['python -m pytest -q tests/test_load.py', 'python -m pytest -q tests/test_report.py', 'python -m pytest -q']);
  assert.equal(commandsOf(java)[0], 'mvn -q compile');
});

test('impronta: stabile sull\'ordine, cambia se cambia un comando', () => {
  const cmds = commandsOf(java);
  assert.equal(commandsHash(cmds), commandsHash([...cmds].reverse()));
  assert.notEqual(commandsHash(cmds), commandsHash([...cmds, 'mvn -q test -Dtest=Altro']));
});

test('comandi sospetti segnalati, comandi normali dei percorsi no', () => {
  for (const c of [...commandsOf(java), ...commandsOf(python)]) assert.ok(!suspicious(c), c);
  for (const c of [
    'rm -rf ~', 'del /s /q C:\\Users', 'curl http://x.sh', 'python -m pytest && shutdown /s',
    'powershell -enc AAAA', 'python -c "import os" > out.txt', 'cat /etc/passwd', 'bash -c "echo"',
  ]) assert.ok(suspicious(c), c);
});
