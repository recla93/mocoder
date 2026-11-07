/**
 * Consigli deterministici dall'output di test, compilatori e interpreti: funzionano offline, senza IA.
 * Ogni regola riconosce un errore tipico e lo spiega in parole semplici, senza dare la soluzione.
 */

export interface Tip { title: string; text: string }
export interface Diagnosis { tests?: { passed: number; failed: number }; tips: Tip[] }

const code = (s: string) => `\`${s.trim()}\``;

const RULES: { re: RegExp; tip: (m: RegExpMatchArray, out: string) => Tip }[] = [
  // strumenti mancanti (Windows in italiano e inglese, Unix)
  {
    re: /'([\w.-]+)' non è riconosciuto|'([\w.-]+)' is not recognized|([\w.-]+): command not found|Termine '([\w.-]+)' non riconosciuto/,
    tip: m => ({
      title: `Manca il programma ${m[1] ?? m[2] ?? m[3] ?? m[4]}`,
      text: 'Il comando del controllo non esiste su questo computer. Installa lo strumento indicato nella teoria del primo task, poi riapri VS Code.',
    }),
  },
  {
    re: /Cannot access central[^\n]*offline mode|Could not resolve dependencies|Could not transfer artifact|or one of its dependencies could not be resolved/,
    tip: () => ({ title: 'Maven non riesce a scaricare ciò che gli serve', text: 'La prima compilazione scarica plugin e librerie da internet: controlla la connessione (o il proxy) e riprova. Dopo la prima volta Maven lavora anche offline.' }),
  },
  { re: /\[interrotto dopo (\d+)s\]/, tip: m => ({ title: 'Il programma non termina', text: `Si è fermato dopo ${m[1]} secondi: forse un ciclo infinito, o il programma aspetta un input da tastiera che nessuno fornisce.` }) },
  { re: /\[nell'output manca: (.+)\]/, tip: m => ({ title: 'Output diverso dal previsto', text: `Il comando funziona, ma nell'output non compare ${code(m[1])}.` }) },

  // Python
  {
    re: /ModuleNotFoundError: No module named '([\w.]+)'/,
    tip: m => ({
      title: `Python non trova il modulo ${m[1]}`,
      text: `Controlla che esista il file ${code(m[1].replace(/\./g, '/') + '.py')} con il nome esatto. Se è un tuo modulo, i test vanno lanciati dalla radice del progetto con ${code('python -m pytest')}; se è una libreria, va installata con pip.`,
    }),
  },
  { re: /ImportError: cannot import name '(\w+)' from '([\w.]+)'/, tip: m => ({ title: `${m[2]} non contiene ${m[1]}`, text: `Il file esiste ma non definisce ${code(m[1])}: controlla il nome, maiuscole comprese, e che non sia dentro un'altra funzione.` }) },
  { re: /NotImplementedError/, tip: () => ({ title: 'C\'è ancora uno scheletro', text: `Una funzione contiene ancora ${code('raise NotImplementedError')}: sostituiscilo con il tuo codice.` }) },
  {
    re: /(SyntaxError|IndentationError): ([^\n]+)/,
    tip: (m, out) => {
      const at = out.match(/File "([^"]+)", line (\d+)/);
      return { title: 'Python non riesce a leggere il file', text: `${at ? `In ${code(at[1])} alla riga ${at[2]}: ` : ''}${m[2]}. Controlla parentesi, i due punti a fine riga e i rientri.` };
    },
  },
  { re: /NameError: name '(\w+)' is not defined/, tip: m => ({ title: `${m[1]} non esiste`, text: `Usi ${code(m[1])} prima di averlo definito o importato, oppure c'è un errore di battitura.` }) },
  {
    re: /TypeError: ([\w.]+)\(\) (missing \d+ required positional arguments?[^\n]*|takes \d+ positional arguments? but \d+ (?:was|were) given)/,
    tip: m => ({ title: 'Numero di argomenti sbagliato', text: `${code(m[1] + '()')}: ${m[2]}. Confronta la firma della funzione con quella indicata nella teoria.` }),
  },
  { re: /AttributeError: '?(\w+)'? object has no attribute '(\w+)'/, tip: m => ({ title: `${m[1]} non ha ${m[2]}`, text: `Controlla il nome di ${code(m[2])} e che sia definito nella classe o nel modulo giusto.` }) },
  { re: /Failed: DID NOT RAISE <class '(\w+)'>/, tip: m => ({ title: 'Manca un errore', text: `Il test si aspetta che il codice sollevi ${code(m[1])} con questi dati, ma non succede.` }) },
  // l'ordine dei due lati dipende da come è scritto il test: lo diciamo in modo neutro
  { re: /E\s+assert (.+?) == ([^\n]+)/, tip: m => ({ title: 'Risultato diverso dal previsto', text: `Il test confronta ${code(m[1])} con ${code(m[2])} e i due valori sono diversi. Calcola a mano il risultato atteso e confrontalo con quello del tuo codice.` }) },

  // Java / Maven / JUnit
  { re: /class (\w+) is public, should be declared in a file named (\w+\.java)/, tip: m => ({ title: 'Nome del file sbagliato', text: `La classe pubblica ${code(m[1])} deve stare nel file ${code(m[2])}.` }) },
  { re: /package ([\w.]+) does not exist/, tip: m => ({ title: 'Package inesistente', text: `Il package ${code(m[1])} non esiste: controlla le righe ${code('package')}/${code('import')} e la cartella del file.` }) },
  {
    re: /cannot find symbol[\s\S]*?symbol:\s+(class|method|variable)\s+([^\s(]+)/,
    tip: m => {
      // javac chiama "variable" anche una classe usata in modo statico (CsvStore.load): il nome maiuscolo la tradisce
      const kind = m[1] === 'method' ? 'il metodo' : m[1] === 'class' || /^[A-Z]/.test(m[2]) ? 'la classe' : 'la variabile';
      return { title: `Java non trova ${kind} ${m[2]}`, text: 'Controlla il nome (maiuscole comprese), gli import e che il file sia nel package giusto. Se va creato in questo task, la teoria ne indica la firma esatta.' };
    },
  },
  { re: /incompatible types: ([^\n]+)/, tip: m => ({ title: 'Tipi incompatibili', text: `${m[1]}. Controlla il tipo che restituisci o assegni.` }) },
  { re: /missing return statement/, tip: () => ({ title: 'Manca un return', text: 'Un metodo che dichiara un tipo di ritorno deve restituire un valore in ogni ramo, anche negli if.' }) },
  { re: /';' expected/, tip: () => ({ title: 'Manca un punto e virgola', text: 'In Java ogni istruzione finisce con `;`: guarda la riga indicata dal compilatore e quella prima.' }) },
  { re: /expected: <(.+?)> but was: <(.+?)>/, tip: m => ({ title: 'Risultato diverso dal previsto', text: `Il test si aspettava ${code(m[1])} ma il codice ha prodotto ${code(m[2])}.` }) },
  { re: /Expected ([\w.]+) to be thrown, but nothing was thrown/, tip: m => ({ title: 'Manca un errore', text: `Il test si aspetta che il codice lanci ${code(m[1].split('.').pop()!)} con questi dati, ma non succede.` }) },
  { re: /UnsupportedOperationException: TODO/, tip: () => ({ title: 'C\'è ancora uno scheletro', text: `Un metodo lancia ancora ${code('UnsupportedOperationException("TODO")')}: sostituiscilo con il tuo codice.` }) },
  { re: /NullPointerException/, tip: () => ({ title: 'Valore null', text: 'Il codice usa un oggetto che vale null: controlla di averlo creato o assegnato prima di usarlo.' }) },
];

const MAX_TIPS = 3;

function testCounts(out: string): Diagnosis['tests'] {
  // Maven/Surefire: l'ultima riga "Tests run" è il totale
  const mvn = [...out.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+)(?:, Skipped: (\d+))?/g)].at(-1);
  if (mvn) {
    const [run, failures, errors, skipped] = [mvn[1], mvn[2], mvn[3], mvn[4] ?? '0'].map(Number);
    return { passed: run - failures - errors - skipped, failed: failures + errors };
  }
  // pytest: riga finale "2 failed, 3 passed, 1 error in 0.12s"
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
