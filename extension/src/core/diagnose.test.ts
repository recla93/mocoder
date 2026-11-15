import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from './diagnose.ts';
import { decodeOutput } from './checks.ts';

// Real output excerpts captured by running the examples ("red" phase)
const PYTEST_SKELETON = `>       raise NotImplementedError
E       NotImplementedError

spese\\load.py:16: NotImplementedError
=========================== short test summary info ===========================
FAILED tests/test_load.py::test_reads_rows - NotImplementedError
7 failed in 0.34s`;

const PYTEST_IMPORT = `ImportError while importing test module 'C:\\tmp\\tests\\test_report.py'.
E   ImportError: cannot import name 'totals_by_category' from 'spese.report' (C:\\tmp\\spese\\report.py)
=========================== short test summary info ===========================
ERROR tests/test_report.py
1 error in 0.20s`;

const PYTEST_MODULE = `tests\\test_converter.py:1: in <module>
    from converter import meters_to_km
E   ModuleNotFoundError: No module named 'converter'
!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
============================== 1 error in 0.43s ===============================`;

const PYTEST_ASSERT = `>       assert totals_by_month(expenses) == {"2026-11": Decimal("15")}
E       assert {'2026-11': Decimal('10')} == {'2026-11': Decimal('15')}
========================= 1 failed, 3 passed in 0.12s =========================`;

const JUNIT_THROWN = `[ERROR] Tests run: 5, Failures: 3, Errors: 0, Skipped: 0, Time elapsed: 0.126 s <<< FAILURE! -- in it.presenze.model.StudentTest
org.opentest4j.AssertionFailedError: Expected java.lang.IllegalArgumentException to be thrown, but nothing was thrown.
[ERROR] Tests run: 5, Failures: 3, Errors: 0, Skipped: 0`;

const JAVAC_SYMBOL = `[ERROR] /C:/tmp/src/test/java/it/presenze/store/CsvStoreTest.java:[25,27] cannot find symbol
  symbol:   variable CsvStore
  location: class it.presenze.store.CsvStoreTest`;

const JAVAC_METHOD = `[ERROR] /C:/tmp/src/test/java/it/presenze/AppTest.java:[22,12] cannot find symbol
  symbol:   method run(java.io.ByteArrayInputStream,java.io.PrintStream,java.nio.file.Path)`;

const MAVEN_OFFLINE = `[ERROR] Plugin org.apache.maven.plugins:maven-resources-plugin:3.4.0 or one of its dependencies could not be resolved:
[ERROR] 	Cannot access central (https://repo.maven.apache.org/maven2) in offline mode and the artifact org.apache.maven.plugins:maven-resources-plugin:jar:3.4.0 has not been downloaded from it before.`;

const titles = (out: string) => diagnose(out).tips.map(t => t.title);

test('pytest: skeleton, import, missing module, different values and test count', () => {
  assert.deepEqual(titles(PYTEST_SKELETON), ['There is still a skeleton']);
  assert.deepEqual(diagnose(PYTEST_SKELETON).tests, { passed: 0, failed: 7 });
  assert.deepEqual(titles(PYTEST_IMPORT), ['spese.report does not contain totals_by_category']);
  assert.deepEqual(diagnose(PYTEST_IMPORT).tests, { passed: 0, failed: 1 });
  assert.match(diagnose(PYTEST_MODULE).tips[0].text, /python -m pytest/);
  assert.deepEqual(titles(PYTEST_ASSERT), ['Result different from expected']);
  assert.deepEqual(diagnose(PYTEST_ASSERT).tests, { passed: 3, failed: 1 });
});

test('Java: expected exception, missing symbols and Surefire test total', () => {
  assert.deepEqual(titles(JUNIT_THROWN), ['Missing an error']);
  assert.match(diagnose(JUNIT_THROWN).tips[0].text, /IllegalArgumentException/);
  assert.deepEqual(diagnose(JUNIT_THROWN).tests, { passed: 2, failed: 3 });
  assert.deepEqual(titles(JAVAC_SYMBOL), ['Java cannot find the class CsvStore']);   // "variable" but it is a class
  assert.deepEqual(titles(JAVAC_METHOD), ['Java cannot find the method run']);
});

test('environment: Maven offline, missing tool, no invented tips', () => {
  assert.deepEqual(titles(MAVEN_OFFLINE), ['Maven cannot download what it needs']);
  // real cmd.exe bytes in Italian ("è" = 0x8A in OEM), decoded as runChecks does
  const cmdBytes = Buffer.concat([Buffer.from('"mvn" non '), Buffer.from([0x8a]), Buffer.from(' riconosciuto come comando interno o esterno,')]);
  assert.deepEqual(titles(decodeOutput(cmdBytes)), ['Missing program mvn']);
  assert.deepEqual(titles("'mvn' non è riconosciuto come comando interno o esterno,"), ['Missing program mvn']);
  assert.deepEqual(titles("'mvn' is not recognized as an internal or external command,"), ['Missing program mvn']);
  assert.deepEqual(titles('bash: mvn: command not found'), ['Missing program mvn']);
  assert.deepEqual(diagnose('qualcosa di mai visto').tips, []);
  assert.equal(diagnose('qualcosa di mai visto').tests, undefined);
});

test('Java: assertTrue without a message names the failing tests and lines', () => {
  // real Surefire output from a generated path (assertTrue without a message)
  const out = `org.opentest4j.AssertionFailedError: expected: <true> but was: <false>
[ERROR] Failures: 
[ERROR]   ProjectStructureTest.gitignoreCoversGeneratedFolders:21 expected: <true> but was: <false>
[ERROR]   ProjectStructureTest.pomHasExpectedCoordinates:15 expected: <true> but was: <false>
[ERROR] Tests run: 3, Failures: 3, Errors: 0, Skipped: 0`;
  const d = diagnose(out);
  assert.equal(d.tips.length, 1);                       // not also "the code produced false"
  assert.match(d.tips[0].text, /ProjectStructureTest\.gitignoreCoversGeneratedFolders \(line 21\)/);
  assert.match(d.tips[0].text, /pomHasExpectedCoordinates \(line 15\)/);
  // values that are not booleans keep the classic comparison
  assert.match(diagnose('expected: <3> but was: <2>').tips[0].text, /expected `3` but the code produced `2`/);
});

test('Java: a JDK older than the project gets its own tip', () => {
  // real output from CI: JDK 17 compiling a project with maven.compiler.release 21
  const out = '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.14.1:compile (default-compile) on project registro-presenze: Fatal error compiling: error: release version 21 not supported -> [Help 1]';
  const d = diagnose(out);
  assert.match(d.tips[0].title, /older than the project needs/);
  assert.match(d.tips[0].text, /JDK 21 or newer/);
  assert.match(diagnose('error: invalid target release: 17').tips[0].text, /Java 17/);
});
