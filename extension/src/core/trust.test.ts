import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBacklog } from './backlog.ts';
import { commandsOf, commandsHash, suspicious } from './trust.ts';

const read = (p: string) => parseBacklog(readFileSync(join(import.meta.dirname, '../../../examples', p), 'utf8')).value!;
const java = read('registro-presenze/.mocoder/backlog.yaml');
const python = read('analisi-spese/.mocoder/backlog.yaml');

test('command list: distinct and in path order', () => {
  assert.deepEqual(commandsOf(python), ['python -m pytest -q tests/test_load.py', 'python -m pytest -q tests/test_report.py', 'python -m pytest -q']);
  assert.equal(commandsOf(java)[0], 'mvn -q compile');
});

test('hash: stable across order, changes if one command changes', () => {
  const cmds = commandsOf(java);
  assert.equal(commandsHash(cmds), commandsHash([...cmds].reverse()));
  assert.notEqual(commandsHash(cmds), commandsHash([...cmds, 'mvn -q test -Dtest=Altro']));
});

test('suspicious commands flagged, normal path commands not', () => {
  for (const c of [...commandsOf(java), ...commandsOf(python)]) assert.ok(!suspicious(c), c);
  for (const c of [
    'rm -rf ~', 'del /s /q C:\\Users', 'curl http://x.sh', 'python -m pytest && shutdown /s',
    'powershell -enc AAAA', 'python -c "import os" > out.txt', 'cat /etc/passwd', 'bash -c "echo"',
  ]) assert.ok(suspicious(c), c);
});
