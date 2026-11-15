/**
 * Deterministic tips from the output of tests, compilers and interpreters: they work offline, without AI.
 * Each rule recognizes a typical error and explains it in simple words, without giving the solution.
 */

export interface Tip { title: string; text: string }
export interface Diagnosis { tests?: { passed: number; failed: number }; tips: Tip[] }

const code = (s: string) => `\`${s.trim()}\``;

/** A program that does not exist (Windows in Italian and English, Unix). Also used by the backlog verification. */
// cmd uses double quotes, and the "è" arrives mangled by the OEM encoding: the rule accepts both
export const MISSING_PROGRAM = /["']([\w.-]+)["'] non \S{0,2}\s?riconosciuto|["']([\w.-]+)["'] is not recognized|([\w.-]+): command not found|Termine '([\w.-]+)' non riconosciuto/;
/** Maven cannot download plugins or libraries. Also used by the backlog verification. */
export const MAVEN_DOWNLOAD = /Cannot access central[^\n]*offline mode|Could not resolve dependencies|Could not transfer artifact|or one of its dependencies could not be resolved/;
/** An npm package (a bare name, not a path) that Node cannot find. Also used by the backlog verification. */
export const NPM_PACKAGE = /Cannot find (?:module|package) '((?:@[\w.-]+\/)?[A-Za-z][\w.-]*)(?:\/[^']*)?'/;
/** The JDK is older than the Java version the project compiles for. Also used by the backlog verification. */
export const JDK_TOO_OLD = /release version (\d+) not supported|invalid target release: (\d+)/;

const RULES: { re: RegExp; tip: (m: RegExpMatchArray, out: string) => Tip }[] = [
  {
    re: MISSING_PROGRAM,
    tip: m => ({
      title: `Missing program ${m[1] ?? m[2] ?? m[3] ?? m[4]}`,
      text: 'The check command does not exist on this computer. Install the tool named in the first task\'s theory, then reopen VS Code.',
    }),
  },
  {
    re: JDK_TOO_OLD,
    tip: m => ({
      title: 'Your Java is older than the project needs',
      text: `The project compiles for Java ${m[1] ?? m[2]}, but the JDK in use is older. Install JDK ${m[1] ?? m[2]} or newer and make ${code('JAVA_HOME')} point to it, then reopen VS Code.`,
    }),
  },
  {
    re: MAVEN_DOWNLOAD,
    tip: () => ({ title: 'Maven cannot download what it needs', text: 'The first build downloads plugins and libraries from the internet: check the connection (or the proxy) and try again. After the first time Maven works offline too.' }),
  },
  { re: /\[stopped after (\d+)s\]/, tip: m => ({ title: 'The program does not terminate', text: `It stopped after ${m[1]} seconds: perhaps an infinite loop, or the program is waiting for keyboard input that nobody provides.` }) },
  { re: /\[output is missing: (.+)\]/, tip: m => ({ title: 'Output different from expected', text: `The command works, but ${code(m[1])} does not appear in the output.` }) },

  // Python
  {
    re: /ModuleNotFoundError: No module named '([\w.]+)'/,
    tip: m => ({
      title: `Python cannot find module ${m[1]}`,
      text: `Check that the file ${code(m[1].replace(/\./g, '/') + '.py')} exists with the exact name. If it is your module, run the tests from the project root with ${code('python -m pytest')}; if it is a library, install it with pip.`,
    }),
  },
  { re: /ImportError: cannot import name '(\w+)' from '([\w.]+)'/, tip: m => ({ title: `${m[2]} does not contain ${m[1]}`, text: `The file exists but does not define ${code(m[1])}: check the name, including capitalization, and that it is not inside another function.` }) },
  { re: /NotImplementedError/, tip: () => ({ title: 'There is still a skeleton', text: `A function still contains ${code('raise NotImplementedError')}: replace it with your code.` }) },
  {
    // only Python's own format (File "x", line N): JavaScript has a SyntaxError too, with different advice
    re: /File "[^"]+", line \d+[\s\S]*?(SyntaxError|IndentationError): ([^\n]+)/,
    tip: (m, out) => {
      const at = out.match(/File "([^"]+)", line (\d+)/);
      return { title: 'Python cannot read the file', text: `${at ? `In ${code(at[1])} at line ${at[2]}: ` : ''}${m[2]}. Check parentheses, the colon at the end of the line and the indentation.` };
    },
  },
  { re: /NameError: name '(\w+)' is not defined/, tip: m => ({ title: `${m[1]} does not exist`, text: `You use ${code(m[1])} before defining or importing it, or there is a typo.` }) },
  {
    re: /TypeError: ([\w.]+)\(\) (missing \d+ required positional arguments?[^\n]*|takes \d+ positional arguments? but \d+ (?:was|were) given)/,
    tip: m => ({ title: 'Wrong number of arguments', text: `${code(m[1] + '()')}: ${m[2]}. Compare the function signature with the one given in the theory.` }),
  },
  { re: /AttributeError: '?(\w+)'? object has no attribute '(\w+)'/, tip: m => ({ title: `${m[1]} has no ${m[2]}`, text: `Check the name of ${code(m[2])} and that it is defined in the right class or module.` }) },
  { re: /Failed: DID NOT RAISE <class '(\w+)'>/, tip: m => ({ title: 'Missing an error', text: `The test expects the code to raise ${code(m[1])} with this data, but that does not happen.` }) },
  // the order of the two sides depends on how the test is written: we phrase it neutrally
  { re: /E\s+assert (.+?) == ([^\n]+)/, tip: m => ({ title: 'Result different from expected', text: `The test compares ${code(m[1])} with ${code(m[2])} and the two values differ. Compute the expected result by hand and compare it with your code's.` }) },

  // Java / Maven / JUnit
  { re: /class (\w+) is public, should be declared in a file named (\w+\.java)/, tip: m => ({ title: 'Wrong file name', text: `The public class ${code(m[1])} must be in the file ${code(m[2])}.` }) },
  { re: /package ([\w.]+) does not exist/, tip: m => ({ title: 'Package does not exist', text: `The package ${code(m[1])} does not exist: check the ${code('package')}/${code('import')} lines and the file's folder.` }) },
  {
    re: /cannot find symbol[\s\S]*?symbol:\s+(class|method|variable)\s+([^\s(]+)/,
    tip: m => {
      // javac calls a class used statically (CsvStore.load) "variable" too: the uppercase name gives it away
      const kind = m[1] === 'method' ? 'the method' : m[1] === 'class' || /^[A-Z]/.test(m[2]) ? 'the class' : 'the variable';
      return { title: `Java cannot find ${kind} ${m[2]}`, text: 'Check the name (including capitalization), the imports and that the file is in the right package. If it must be created in this task, the theory gives its exact signature.' };
    },
  },
  { re: /incompatible types: ([^\n]+)/, tip: m => ({ title: 'Incompatible types', text: `${m[1]}. Check the type you return or assign.` }) },
  { re: /missing return statement/, tip: () => ({ title: 'Missing return', text: 'A method that declares a return type must return a value in every branch, including inside ifs.' }) },
  { re: /';' expected/, tip: () => ({ title: 'Missing semicolon', text: 'In Java every statement ends with `;`: look at the line indicated by the compiler and the one before it.' }) },
  {
    // assertTrue/assertFalse without a message: the only clue is which test fails, and at which line
    re: /expected: <(?:true|false)> but was: <(?:true|false)>/,
    tip: (_m, out) => {
      const failed = [...new Set([...out.matchAll(/^\[ERROR\]\s+(\w+\.\w+):(\d+) expected: <(?:true|false)>/gm)].map(f => `${f[1]} (line ${f[2]})`))];
      return {
        title: 'A condition checked by the test is still false',
        text: `${failed.length ? `Failing: ${failed.slice(0, 3).map(code).join(', ')}. ` : ''}Open the test at that line: the test name and the condition say what your code is still missing.`,
      };
    },
  },
  { re: /expected: <(?!(?:true|false)> but was: <(?:true|false)>)(.+?)> but was: <(.+?)>/, tip: m => ({ title: 'Result different from expected', text: `The test expected ${code(m[1])} but the code produced ${code(m[2])}.` }) },
  { re: /Expected ([\w.]+) to be thrown, but nothing was thrown/, tip: m => ({ title: 'Missing an error', text: `The test expects the code to throw ${code(m[1].split('.').pop()!)} with this data, but that does not happen.` }) },
  { re: /UnsupportedOperationException: TODO/, tip: () => ({ title: 'There is still a skeleton', text: `A method still throws ${code('UnsupportedOperationException("TODO")')}: replace it with your code.` }) },
  { re: /NullPointerException/, tip: () => ({ title: 'Null value', text: 'The code uses an object that is null: check that you created or assigned it before using it.' }) },

  // JavaScript / TypeScript (Node test runner, Jest, Vitest, tsc)
  {
    re: NPM_PACKAGE,
    tip: m => ({ title: `Package ${m[1]} is not installed`, text: `Run ${code('npm install')} in the project: it installs the packages listed in ${code('package.json')}. If ${code(m[1])} is not listed there, add it with a pinned version.` }),
  },
  {
    // a path (relative, absolute Windows or Unix), not a package: "imported from" is ESM, CommonJS has no importer
    re: /Cannot find module '((?:\.|[A-Za-z]:\\|\/)[^']*)'(?: imported from ([^\s']+))?/,
    tip: m => {
      const name = (p: string) => p.split(/[\\/]/).pop()!;
      return { title: `Node cannot find the file ${name(m[1])}`, text: `${m[2] ? `${code(name(m[2]))} imports ${code(name(m[1]))}, which` : `${code(name(m[1]))}`} does not exist at that path. Check the file name, the folder and the extension in the import (${code('.ts')} or ${code('.js')}).` };
    },
  },
  {
    re: /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|is not supported in strip-only mode/,
    tip: () => ({ title: 'TypeScript syntax that Node cannot run', text: `Node runs TypeScript by removing the types only: ${code('enum')}, ${code('namespace')} and constructor parameter properties are not supported. Use a union of strings or a ${code('const')} object instead.` }),
  },
  {
    re: /([\w./\\-]+\.tsx?)\((\d+),\d+\): error (TS\d+): ([^\n]+)/,
    tip: m => ({ title: 'TypeScript type error', text: `In ${code(m[1])} at line ${m[2]}: ${m[4]}` }),
  },
  { re: /does not provide an export named '(\w+)'/, tip: m => ({ title: `${m[1]} is not exported`, text: `The test imports ${code(m[1])}, but the module does not export it: create it, or add ${code('export')} in front of its declaration, with the exact name.` }) },
  { re: /^(?![\s\S]*(?:File "|does not provide an export named))[\s\S]*?SyntaxError: ([^\n]+)/, tip: m => ({ title: 'JavaScript cannot read the file', text: `${m[1]}. Check brackets, quotes and commas near the line shown in the output.` }) },
  { re: /ReferenceError: (\w+) is not defined/, tip: m => ({ title: `${m[1]} does not exist`, text: `You use ${code(m[1])} before defining or importing it, or there is a typo.` }) },
  { re: /TypeError: ([\w.]+) is not a function/, tip: m => ({ title: `${m[1]} is not a function`, text: `Check the name of ${code(m[1])}, that it is exported by its module and imported with the same name.` }) },
  { re: /Error: TODO\b/, tip: () => ({ title: 'There is still a skeleton', text: `A function still throws ${code("new Error('TODO')")}: replace it with your code.` }) },
  { re: /Missing expected exception/, tip: () => ({ title: 'Missing an error', text: 'The test expects the code to throw an error with this data, but that does not happen.' }) },
  // node:assert prints both values; Jest and Vitest have their own wording
  { re: /actual: ([^\n]+),\n\s*expected: ([^\n]+),\n\s*operator: '(?:strict|deepStrict|deep)?[eE]qual'/, tip: m => ({ title: 'Result different from expected', text: `The test expected ${code(m[2])} but the code produced ${code(m[1])}.` }) },
  { re: /Expected: ([^\n]+)\n\s*Received: ([^\n]+)/, tip: m => ({ title: 'Result different from expected', text: `The test expected ${code(m[1])} but the code produced ${code(m[2])}.` }) },
  { re: /AssertionError: expected (.+?) to (?:be|equal|deeply equal|strictly equal) (.+?)(?: \/\/|\n|$)/, tip: m => ({ title: 'Result different from expected', text: `The test expected ${code(m[2])} but the code produced ${code(m[1])}.` }) },
];

const MAX_TIPS = 3;

function testCounts(out: string): Diagnosis['tests'] {
  // Maven/Surefire: the last "Tests run" line is the total
  const mvn = [...out.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+)(?:, Skipped: (\d+))?/g)].at(-1);
  if (mvn) {
    const [run, failures, errors, skipped] = [mvn[1], mvn[2], mvn[3], mvn[4] ?? '0'].map(Number);
    return { passed: run - failures - errors - skipped, failed: failures + errors };
  }
  // pytest: final line "2 failed, 3 passed, 1 error in 0.12s"
  const summary = out.match(/^[=\s]*((?:\d+ (?:failed|passed|errors?)(?:, )?)+)[^\n]* in [\d.]+s/m)?.[1];
  if (summary) {
    const n = (k: RegExp) => Number(summary.match(k)?.[1] ?? 0);
    return { passed: n(/(\d+) passed/), failed: n(/(\d+) failed/) + n(/(\d+) errors?/) };
  }
  // Node test runner: "ℹ pass 2 / ℹ fail 1" (spec reporter) or "# pass 2 / # fail 1" (TAP)
  const node = out.match(/^[ℹ#] pass (\d+)\s*\n[ℹ#] fail (\d+)/m);
  if (node) return { passed: Number(node[1]), failed: Number(node[2]) };
  // Jest "Tests:       1 failed, 2 passed, 3 total"; Vitest "      Tests  1 failed | 2 passed (3)"
  const js = out.match(/^\s*Tests:?\s+([^\n]*(?:\d+ total|\(\d+\)))/m)?.[1];
  if (js) {
    const n = (k: RegExp) => Number(js.match(k)?.[1] ?? 0);
    return { passed: n(/(\d+) passed/), failed: n(/(\d+) failed/) };
  }
  return undefined;
}

export function diagnose(output: string): Diagnosis {
  const tips: Tip[] = [];
  for (const r of RULES) {
    const m = output.match(r.re);
    if (!m) continue;
    const tip = r.tip(m, output);
    if (!tips.some(t => t.title === tip.title)) tips.push(tip);
    if (tips.length === MAX_TIPS) break;
  }
  return { tests: testCounts(output), tips };
}
