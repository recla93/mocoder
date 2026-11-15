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

const RULES: { re: RegExp; tip: (m: RegExpMatchArray, out: string) => Tip }[] = [
  {
    re: MISSING_PROGRAM,
    tip: m => ({
      title: `Missing program ${m[1] ?? m[2] ?? m[3] ?? m[4]}`,
      text: 'The check command does not exist on this computer. Install the tool named in the first task\'s theory, then reopen VS Code.',
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
    re: /(SyntaxError|IndentationError): ([^\n]+)/,
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
  { re: /expected: <(.+?)> but was: <(.+?)>/, tip: m => ({ title: 'Result different from expected', text: `The test expected ${code(m[1])} but the code produced ${code(m[2])}.` }) },
  { re: /Expected ([\w.]+) to be thrown, but nothing was thrown/, tip: m => ({ title: 'Missing an error', text: `The test expects the code to throw ${code(m[1].split('.').pop()!)} with this data, but that does not happen.` }) },
  { re: /UnsupportedOperationException: TODO/, tip: () => ({ title: 'There is still a skeleton', text: `A method still throws ${code('UnsupportedOperationException("TODO")')}: replace it with your code.` }) },
  { re: /NullPointerException/, tip: () => ({ title: 'Null value', text: 'The code uses an object that is null: check that you created or assigned it before using it.' }) },
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
