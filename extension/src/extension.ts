import * as vscode from 'vscode';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import schema from '../../schema/backlog.schema.json' with { type: 'json' };
import plannerPrompt from '../../prompts/planner.md';
import mentorPrompt from '../../prompts/mentor.md';
import reviewerPrompt from '../../prompts/reviewer.md';
import { parseBacklog, parseSolution, parsePlannerAnswer, repairRequest, type Backlog, type Solution, type Task } from './core/backlog.ts';
import { BACKLOG, DIR, SOLUTION, inside, prepareTask, readProgress, writeProgress, type Progress } from './core/workspace.ts';
import { passed, runChecks, type CheckResult } from './core/checks.ts';
import { completedMilestone, nextTask, statusOf } from './core/progress.ts';
import { redGreen, type VerifyFailure } from './core/verify.ts';
import { commandsHash, commandsOf, suspicious } from './core/trust.ts';
import { anthropic, openaiCompatible, withBudget, isFreeModel, AiError, type Complete, type Usage } from './ai/providers.ts';
import { fill, fixRequest, fixUntilGreen, plan, promptBody, taskContext, mentorMessages, reviewMessages, type Exchange, type Guidance, type StudentFile } from './ai/roles.ts';
import { renderPage } from './view.ts';

const git = promisify(execFile);
const rootDir = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const config = () => vscode.workspace.getConfiguration('mocoder');
const guidance = () => config().get<Guidance>('guidance', 'guidato');
const escapeHtml = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const MAX_FILE = 200_000;

/** Markdown con il renderer di VS Code: nessuna libreria in più. */
async function markdown(md: string): Promise<string> {
  try {
    return (await vscode.commands.executeCommand<string>('markdown.api.render', md)) ?? `<pre>${escapeHtml(md)}</pre>`;
  } catch {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
}

// ---------------------------------------------------------------- IA

type Provider = 'anthropic' | 'openai';
const USAGE_KEY = 'mocoder.usage';
const secretKey = (p: Provider) => `mocoder.apiKey.${p}`;

function aiSettings() {
  const c = config();
  return {
    provider: c.get<Provider>('ai.provider', 'anthropic'),
    baseUrl: c.get<string>('ai.baseUrl', ''),
    model: c.get<string>('ai.model', 'claude-opus-5-5'),
    mentorModel: c.get<string>('ai.mentorModel', ''),
  };
}

/** Il modello che risponde a un ruolo, già con il conteggio del budget. undefined se l'IA non è configurata. */
async function getComplete(ctx: vscode.ExtensionContext, role: 'main' | 'mentor'): Promise<Complete | undefined> {
  const s = aiSettings();
  const model = (role === 'mentor' && s.mentorModel) || s.model;
  const apiKey = await ctx.secrets.get(secretKey(s.provider));
  let complete: Complete;
  if (s.provider === 'anthropic') {
    if (!apiKey && !process.env.ANTHROPIC_API_KEY) return undefined;
    complete = anthropic({ model, apiKey, baseURL: s.baseUrl });
  } else {
    if (!s.baseUrl || !model) return undefined;
    complete = openaiCompatible({ baseUrl: s.baseUrl, model, apiKey });
  }
  return withBudget(
    complete,
    { get: () => ctx.globalState.get<Usage>(USAGE_KEY), set: u => ctx.globalState.update(USAGE_KEY, u) },
    () => config().get<number>('ai.monthlyTokenBudget', 0),
  );
}

async function aiLabel(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  if (!(await getComplete(ctx, 'main'))) return undefined;
  const s = aiSettings();
  const u = ctx.globalState.get<Usage>(USAGE_KEY);
  const tokens = u?.month === new Date().toISOString().slice(0, 7) ? u.tokens : 0;
  return `${s.model} · ${(tokens / 1000).toFixed(1)}k token questo mese`;
}

async function configureAI(ctx: vscode.ExtensionContext) {
  const choice = await vscode.window.showQuickPick([
    { label: 'Anthropic (Claude)', provider: 'anthropic' as const, baseUrl: '' },
    { label: 'Ollama (modelli locali o cloud gratuiti)', provider: 'openai' as const, baseUrl: 'http://localhost:11434/v1' },
    { label: 'Altro provider OpenAI-compatibile', description: 'OpenAI, OpenRouter, Groq, LM Studio…', provider: 'openai' as const, baseUrl: 'https://api.openai.com/v1' },
  ], { title: 'mocoder · Quale IA usi?' });
  if (!choice) return;

  let baseUrl = choice.baseUrl;
  if (choice.label.startsWith('Altro')) {
    const url = await vscode.window.showInputBox({ title: 'Indirizzo dell\'API', value: baseUrl, ignoreFocusOut: true });
    if (!url) return;
    baseUrl = url;
  }

  let models: string[] = [];
  if (choice.label.startsWith('Ollama')) {
    try {
      const tags = await (await fetch('http://localhost:11434/api/tags')).json() as { models?: { name: string }[] };
      models = (tags.models ?? []).map(m => m.name);
    } catch {
      void vscode.window.showWarningMessage('Ollama non risponde su localhost:11434: avvialo, poi scegli il modello.');
    }
  }
  const current = aiSettings();
  const ollama = choice.label.startsWith('Ollama');
  const OTHER = 'Altro modello… (es. gemma4:31b-cloud)';
  let model = models.length
    ? await vscode.window.showQuickPick([...models, OTHER], { title: 'Modello Ollama: quelli ":cloud" girano sui server di Ollama, non sul tuo PC' })
    : undefined;
  if (models.length && !model) return;
  if (!models.length || model === OTHER) model = await vscode.window.showInputBox({
      title: 'Modello',
      value: choice.provider === 'anthropic' ? (current.provider === 'anthropic' ? current.model : 'claude-opus-5-5') : ollama ? 'gemma4:31b-cloud' : '',
      prompt: choice.provider === 'anthropic' ? 'Es. claude-opus-5-5 (consigliato) o claude-haiku-5-5 (economico)' : 'Nome del modello sul provider',
      ignoreFocusOut: true,
    });
  if (!model) return;

  if (!choice.label.startsWith('Ollama')) {
    const key = await vscode.window.showInputBox({
      title: 'Chiave API', password: true, ignoreFocusOut: true,
      prompt: choice.provider === 'anthropic' ? 'Lascia vuoto per usare ANTHROPIC_API_KEY. La chiave resta nel portachiavi del sistema.' : 'La chiave resta nel portachiavi del sistema.',
    });
    if (key === undefined) return;
    if (key) await ctx.secrets.store(secretKey(choice.provider), key);
  }

  const c = config();
  await c.update('ai.provider', choice.provider, vscode.ConfigurationTarget.Global);
  await c.update('ai.baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  await c.update('ai.model', model, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    `IA configurata: ${model}. Il codice dei file del task viene inviato a questo provider quando chiedi aiuto o una review.`);
}

// ---------------------------------------------------------------- Pannello

class Tutor implements vscode.WebviewViewProvider {
  ctx: vscode.ExtensionContext;
  out: vscode.OutputChannel;
  view?: vscode.WebviewView;
  backlog?: Backlog;
  errors: string[] = [];
  progress: Progress = { done: [], hints: {} };
  selected?: string;
  results?: { taskId: string; list: CheckResult[] };
  chats = new Map<string, Exchange[]>();   // per task, solo in memoria
  busy = false;
  thinking = false;

  constructor(ctx: vscode.ExtensionContext, out: vscode.OutputChannel) {
    this.ctx = ctx;
    this.out = out;
  }

  get task() {
    return this.backlog?.tasks.find(t => t.id === this.selected);
  }

  load() {
    const root = rootDir();
    this.backlog = undefined;
    this.errors = [];
    if (root && existsSync(join(root, BACKLOG))) {
      const r = parseBacklog(readFileSync(join(root, BACKLOG), 'utf8'));
      this.backlog = r.value;
      this.errors = r.errors;
      this.progress = readProgress(root);
      if (this.backlog && !this.task) this.selected = nextTask(this.backlog, this.progress)?.id ?? this.backlog.tasks.at(-1)?.id;
    }
    void this.render();
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(m => this.onMessage(m));
    this.load();
  }

  async render() {
    if (!this.view) return;
    const task = this.task;
    const shown = task && guidance() !== 'autonomo' ? task.hints.slice(0, this.progress.hints[task.id] ?? 0) : [];
    const chat = task ? this.chats.get(task.id) ?? [] : [];
    this.view.webview.html = renderPage({
      cspSource: this.view.webview.cspSource,
      nonce: randomBytes(16).toString('hex'),
      hasFolder: !!rootDir(),
      backlog: this.backlog,
      errors: this.errors,
      progress: this.progress,
      task,
      theoryHtml: task ? await markdown(task.theory) : '',
      hintsHtml: await Promise.all(shown.map(markdown)),
      guidance: guidance(),
      results: this.results?.taskId === task?.id ? this.results?.list : undefined,
      busy: this.busy,
      ai: await aiLabel(this.ctx),
      canVerifyBacklog: !!rootDir() && existsSync(join(rootDir()!, SOLUTION)),
      chat: await Promise.all(chat.map(async e => ({ role: e.role, html: e.role === 'student' ? `<p>${escapeHtml(e.text)}</p>` : await markdown(e.text) }))),
      thinking: this.thinking,
    });
  }

  async onMessage(m: { type: string; id?: string; path?: string; value?: string; text?: string; q?: string }) {
    const root = rootDir();
    switch (m.type) {
      case 'prompt': return vscode.commands.executeCommand('mocoder.copyPlannerPrompt');
      case 'import': return vscode.commands.executeCommand('mocoder.import');
      case 'plan': return vscode.commands.executeCommand('mocoder.plan');
      case 'configure': return vscode.commands.executeCommand('mocoder.configureAI');
      case 'guidance': return config().update('guidance', m.value, vscode.ConfigurationTarget.Global);
      case 'select': this.selected = m.id; return this.render();
      case 'open': if (root && m.path) await vscode.window.showTextDocument(vscode.Uri.file(inside(root, m.path)), { preview: false }); return;
      case 'start': return this.start();
      case 'hint': return this.hint();
      case 'verify': return this.verify();
      case 'ask': return m.text?.trim() ? this.ask(m.text.trim()) : undefined;
      case 'explain': return this.ask('La verifica non passa. Aiutami a capire l\'errore senza darmi la soluzione.');
      case 'review': return this.review('task');
      case 'verifyBacklog': return vscode.commands.executeCommand('mocoder.verifyBacklog');
      case 'search':
        // solo le ricerche del task, sempre verso un motore di ricerca: la pagina non può aprire URL arbitrari
        if (m.q && this.task?.search?.includes(m.q)) await vscode.env.openExternal(vscode.Uri.parse(`https://www.google.com/search?q=${encodeURIComponent(m.q)}`));
        return;
    }
  }

  async start() {
    const root = rootDir();
    const task = this.task;
    if (!root || !task) return;
    const files = prepareTask(root, task, guidance() !== 'autonomo');
    for (const [i, f] of files.entries()) {
      await vscode.window.showTextDocument(vscode.Uri.file(inside(root, f)), { preview: false, preserveFocus: i < files.length - 1 });
    }
  }

  async hint() {
    const root = rootDir();
    const task = this.task;
    if (!root || !task || guidance() === 'autonomo') return;
    const shown = this.progress.hints[task.id] ?? 0;
    if (shown >= task.hints.length) return;
    if (guidance() === 'suggerimenti' && shown === task.hints.length - 1) {
      const ok = await vscode.window.showWarningMessage(
        'Il prossimo suggerimento è la soluzione completa. Prova ancora un po\' prima?', { modal: true }, 'Mostra la soluzione');
      if (!ok) return;
    }
    this.progress.hints[task.id] = shown + 1;
    writeProgress(root, this.progress);
    await this.render();
  }

  async verify() {
    const root = rootDir();
    const task = this.task;
    if (!root || !task || !this.backlog || this.busy || statusOf(task, this.progress) === 'locked') return;
    if (!(await approveCommands(this.ctx, this.out, this.backlog))) {
      return void vscode.window.showInformationMessage('Verifica annullata: i comandi del backlog non sono stati consentiti.');
    }
    await vscode.workspace.saveAll(false);
    this.busy = true;
    await this.render();
    try {
      const list = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `mocoder: verifico ${task.id}` },
        () => runChecks(root, task.checks));
      this.results = { taskId: task.id, list };
      this.out.appendLine(`--- ${task.id} ${new Date().toLocaleString()}`);
      for (const r of list) this.out.appendLine(`${r.ok ? 'OK ' : 'KO '} $ ${r.check.run}\n${r.output}`);
      if (passed(list)) {
        if (!this.progress.done.includes(task.id)) this.progress.done.push(task.id);
        writeProgress(root, this.progress);
        await this.commit(root, `feat(${task.id}): ${task.title}`);
        const m = completedMilestone(this.backlog, this.progress, task);
        if (m) {
          void vscode.window.showInformationMessage(
            `Milestone "${m.title}" completata! Prima di andare avanti fai rivedere il lavoro, come in una pull request.`,
            'Chiedi la review della milestone',
          ).then(go => go && this.review('milestone', task));
        } else {
          void vscode.window.showInformationMessage(`${task.id} completato.`);
        }
      }
    } finally {
      this.busy = false;
      await this.render();
    }
  }

  /** File dell'utente dei task dati, letti dal disco così come sono ora. */
  studentFiles(tasks: Task[]): StudentFile[] {
    const root = rootDir()!;
    const paths = [...new Set(tasks.flatMap(t => (t.files ?? []).filter(f => !f.given).map(f => f.path)))];
    return paths.map(path => {
      const abs = inside(root, path);
      return existsSync(abs) && statSync(abs).size <= MAX_FILE ? { path, content: readFileSync(abs, 'utf8') } : { path };
    });
  }

  /** Esegue una chiamata IA mostrando lo stato nel pannello; gli errori diventano messaggi chiari. */
  async withAI(task: Task, entry: Exchange | undefined, run: (c: Complete) => Promise<string>, role: Exchange['role'], model: 'main' | 'mentor') {
    const complete = await getComplete(this.ctx, model);
    if (!complete) {
      const go = await vscode.window.showWarningMessage('Configura prima un\'IA (Claude, Ollama o un altro provider).', 'Configura');
      if (go) await vscode.commands.executeCommand('mocoder.configureAI');
      return;
    }
    if (this.thinking) return;
    const chat = this.chats.get(task.id) ?? [];
    this.chats.set(task.id, chat);
    if (entry) chat.push(entry);
    this.thinking = true;
    await this.render();
    try {
      chat.push({ role, text: await run(complete) });
    } catch (e) {
      const msg = e instanceof AiError ? e.message : `Errore inatteso: ${(e as Error).message}`;
      this.out.appendLine(`IA: ${msg}`);
      void vscode.window.showErrorMessage(msg);
    } finally {
      this.thinking = false;
      await this.render();
    }
  }

  async ask(question: string) {
    const task = this.task;
    if (!task) return;
    await vscode.workspace.saveAll(false);
    const history = [...(this.chats.get(task.id) ?? [])];
    const results = this.results?.taskId === task.id ? this.results.list : undefined;
    const context = taskContext(task, guidance(), this.progress.hints[task.id] ?? 0, this.studentFiles([task]), results);
    await this.withAI(task, { role: 'student', text: question }, async complete =>
      (await complete({ system: mentorPrompt, messages: mentorMessages(context, history, question), maxTokens: 16000, effort: 'low' })).text,
    'tutor', 'mentor');
  }

  async review(scope: 'task' | 'milestone', of = this.task) {
    if (!of || !this.backlog) return;
    await vscode.workspace.saveAll(false);
    const tasks = scope === 'task' ? [of] : this.backlog.tasks.filter(t => t.milestone === of.milestone);
    const label = scope === 'task' ? `${of.id} · ${of.title}` : `milestone ${of.milestone}`;
    this.selected = of.id;
    await this.withAI(of, undefined, async complete =>
      (await complete({ system: reviewerPrompt, messages: reviewMessages(tasks, this.studentFiles(tasks), label, this.backlog?.conventions), maxTokens: 16000, effort: 'medium' })).text,
    'review', 'main');
  }

  /** Un task = un commit, come in un team vero. Se git manca, il tutor funziona lo stesso. */
  async commit(root: string, message: string) {
    try {
      // la soluzione di riferimento non deve finire nel repository dello studente
      const ignore = join(root, DIR, '.gitignore');
      if (!existsSync(ignore)) writeFileSync(ignore, 'solution.yaml\n', 'utf8');
      if (!existsSync(join(root, '.git'))) await git('git', ['init'], { cwd: root });
      await git('git', ['add', '-A'], { cwd: root });
      await git('git', ['commit', '-m', message], { cwd: root });
      this.out.appendLine(`git commit -m "${message}"`);
    } catch (e) {
      this.out.appendLine(`git: commit non riuscito (${(e as Error).message.split('\n')[0]})`);
    }
  }
}

// ---------------------------------------------------------------- Creare e importare un backlog

async function askIdea(): Promise<string | undefined> {
  const idea = await vscode.window.showInputBox({ title: 'mocoder · 1/3', prompt: 'Descrivi la tua idea di progetto', ignoreFocusOut: true });
  if (!idea) return;
  const livello = await vscode.window.showQuickPick(['principiante', 'intermedio', 'avanzato'], { title: 'mocoder · 2/3', placeHolder: 'Il tuo livello' });
  if (!livello) return;
  const obiettivo = await vscode.window.showInputBox({ title: 'mocoder · 3/3', prompt: 'Cosa vuoi imparare? (opzionale)', ignoreFocusOut: true });
  if (obiettivo === undefined) return;
  return fill(promptBody(plannerPrompt), {
    idea, livello, obiettivo: obiettivo || 'non specificato', stack: 'a tua scelta', ore_settimana: 'non specificato',
    schema: JSON.stringify(schema, null, 2),
  });
}

async function copyPlannerPrompt() {
  const prompt = await askIdea();
  if (!prompt) return;
  await vscode.env.clipboard.writeText(prompt);
  void vscode.window.showInformationMessage(
    'Prompt copiato. Incollalo nel tuo LLM, copia tutta la risposta e poi usa "mocoder: Importa backlog".');
}

/** Scrive backlog (e soluzione) nel progetto e azzera i progressi, chiedendo conferma se ne esiste già uno. */
async function installBacklog(tutor: Tutor, root: string, backlogText: string, solutionText?: string): Promise<boolean> {
  if (existsSync(join(root, BACKLOG))) {
    const ok = await vscode.window.showWarningMessage('Sostituire il backlog esistente? I progressi ripartono da zero.', { modal: true }, 'Sostituisci');
    if (!ok) return false;
  }
  mkdirSync(join(root, DIR), { recursive: true });
  writeFileSync(join(root, BACKLOG), backlogText, 'utf8');
  if (solutionText) writeFileSync(join(root, SOLUTION), solutionText, 'utf8');
  writeProgress(root, { done: [], hints: {} });
  tutor.selected = undefined;
  tutor.chats.clear();
  tutor.load();
  await vscode.commands.executeCommand('mocoder.tutor.focus');
  if (solutionText) {
    const go = await vscode.window.showInformationMessage(
      'Backlog pronto. Vuoi verificare che i controlli siano corretti prima di iniziare? (servono gli strumenti del progetto installati)', 'Verifica il backlog');
    if (go) await vscode.commands.executeCommand('mocoder.verifyBacklog');
  } else {
    void vscode.window.showInformationMessage('Backlog pronto. Senza soluzione di riferimento non posso verificare i controlli in anticipo.');
  }
  return true;
}

async function importBacklog(tutor: Tutor, out: vscode.OutputChannel) {
  const root = rootDir();
  if (!root) return void vscode.window.showErrorMessage('Apri prima la cartella (anche vuota) del progetto.');
  const source = await vscode.window.showQuickPick(['Dagli appunti (risposta del LLM)', 'Da un file…'], { placeHolder: 'Da dove importo il backlog?' });
  if (!source) return;
  let text: string;
  if (source.startsWith('Dagli')) {
    text = await vscode.env.clipboard.readText();
  } else {
    const [file] = await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.file(root),   // la risposta del chatbot si salva di solito nel progetto
      filters: { 'YAML o Markdown': ['yaml', 'yml', 'md', 'txt'] },
    }) ?? [];
    if (!file) return;
    text = readFileSync(file.fsPath, 'utf8');
  }
  if (!text.trim()) {
    return void vscode.window.showErrorMessage(source.startsWith('Dagli')
      ? 'Gli appunti sono vuoti: nel chatbot copia tutta la risposta, poi riprova.'
      : 'Il file è vuoto.');
  }

  const a = parsePlannerAnswer(text);
  if (a.fixes.length) {
    out.appendLine('--- import: correzioni automatiche di formato');
    a.fixes.forEach(f => out.appendLine(f));
  }
  if (!a.backlog || a.errors.length) {
    out.appendLine('--- import: errori');
    a.errors.forEach(e => out.appendLine(e));
    out.show(true);
    const fix = await vscode.window.showErrorMessage(`Il backlog non è valido (${a.errors.length} errori).`, 'Copia la richiesta di correzione per il LLM');
    if (fix) await vscode.env.clipboard.writeText(repairRequest(a.errors));
    return;
  }
  if (a.fixes.length) void vscode.window.showInformationMessage(`Ho corretto da solo ${a.fixes.length === 1 ? '1 errore' : `${a.fixes.length} errori`} di formato del chatbot (dettagli nel pannello Output).`);
  await installBacklog(tutor, root, a.backlogText!, a.solution ? a.solutionText : undefined);
}

async function planWithAI(ctx: vscode.ExtensionContext, tutor: Tutor, out: vscode.OutputChannel) {
  const root = rootDir();
  if (!root) return void vscode.window.showErrorMessage('Apri prima la cartella (anche vuota) del progetto.');
  const complete = await getComplete(ctx, 'main');
  if (!complete) {
    const go = await vscode.window.showWarningMessage('Configura prima un\'IA, oppure usa il prompt da copiare nel tuo LLM.', 'Configura');
    if (go) await vscode.commands.executeCommand('mocoder.configureAI');
    return;
  }
  const prompt = await askIdea();
  if (!prompt) return;

  let chars = 0;
  let result: Awaited<ReturnType<typeof plan>>;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'mocoder: il Planner prepara il percorso', cancellable: false },
      async progress => {
        let shown = 0;
        return plan(complete, prompt, delta => {
          chars += delta.length;
          if (chars - shown > 2000) {
            shown = chars;
            progress.report({ message: `${Math.round(chars / 1000)}k caratteri scritti…` });
          }
        });
      });
  } catch (e) {
    return void vscode.window.showErrorMessage(e instanceof AiError ? e.message : `Errore inatteso: ${(e as Error).message}`);
  }
  out.appendLine(`--- planner: ${result.attempts} tentativi, ${result.errors.length} errori residui`);
  result.errors.forEach(e => out.appendLine(e));

  // la valutazione di fattibilità è la prima cosa che lo studente deve leggere
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: result.feasibility || result.answer });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });

  if (!result.backlog) {
    return void vscode.window.showWarningMessage(result.errors.length && /^```ya?ml/m.test(result.answer)
      ? `Il Planner non è riuscito a produrre un backlog valido dopo ${result.attempts} tentativi (dettagli nel pannello Output).`
      : 'Il Planner ritiene l\'idea non fattibile così com\'è: leggi le alternative proposte.');
  }
  if (result.errors.length) void vscode.window.showWarningMessage('La soluzione di riferimento non è valida: installo il backlog senza verifica preventiva.');
  await installBacklog(tutor, root, result.backlogText!, result.solution ? result.solutionText : undefined);
}

// ---------------------------------------------------------------- Approvazione dei comandi

// Nello stato privato di VS Code per la cartella, non nel progetto: un backlog non può approvarsi da solo.
const APPROVED_KEY = 'mocoder.approvedCommands';
const MAX_SHOWN = 30;

/** Chiede di approvare i comandi del backlog, una volta per ogni insieme diverso di comandi. */
async function approveCommands(ctx: vscode.ExtensionContext, out: vscode.OutputChannel, backlog: Backlog): Promise<boolean> {
  const commands = commandsOf(backlog);
  const hash = commandsHash(commands);
  if (ctx.workspaceState.get(APPROVED_KEY) === hash) return true;
  const lines = commands.map(c => `${suspicious(c) ? '⚠' : '•'} ${c}`);
  out.appendLine('--- comandi dei controlli da approvare');
  lines.forEach(l => out.appendLine(l));
  const shown = lines.slice(0, MAX_SHOWN).join('\n')
    + (lines.length > MAX_SHOWN ? `\n… e altri ${lines.length - MAX_SHOWN} (elenco completo nel pannello Output)` : '');
  const warning = commands.some(suspicious) ? '\n\n⚠ = comando insolito per un controllo: leggilo con attenzione prima di consentirlo.' : '';
  const ok = await vscode.window.showWarningMessage(
    'Questo backlog esegue dei comandi sul tuo computer. Li consenti?',
    {
      modal: true,
      detail: `Per verificare i task, mocoder lancerà:\n\n${shown}${warning}\n\n`
        + 'Consenti solo se ti fidi della fonte del backlog. Se i comandi cambiano, te lo chiederò di nuovo.',
    },
    'Consenti questi comandi',
  );
  if (!ok) return false;
  await ctx.workspaceState.update(APPROVED_KEY, hash);
  out.appendLine('comandi approvati');
  return true;
}

const describeFailure = (f: VerifyFailure) =>
  `${f.taskId}: ${f.kind === 'red' ? 'i controlli passano già prima del lavoro, quindi non verificano niente' : 'i controlli falliscono anche con la soluzione di riferimento'}.`;

async function verifyBacklog(ctx: vscode.ExtensionContext, out: vscode.OutputChannel) {
  const root = rootDir();
  if (!root || !existsSync(join(root, BACKLOG)) || !existsSync(join(root, SOLUTION))) {
    return void vscode.window.showErrorMessage(`Servono ${BACKLOG} e ${SOLUTION}.`);
  }
  const backlogText = readFileSync(join(root, BACKLOG), 'utf8');
  const solutionText = readFileSync(join(root, SOLUTION), 'utf8');
  const b = parseBacklog(backlogText);
  const s = b.value && parseSolution(solutionText, b.value);
  if (!b.value || !s?.value) return void vscode.window.showErrorMessage('Backlog o soluzione non validi: reimportali.');
  const log = (line: string) => out.appendLine(line);
  const check = async (bk: Backlog, sol: Solution) => {
    if (!(await approveCommands(ctx, out, bk))) throw new AiError('Verifica interrotta: i comandi del backlog non sono stati consentiti.');
    return redGreen(bk, sol, log);
  };
  out.show(true);
  out.appendLine('--- verifica del backlog: ogni task deve fallire prima del lavoro e passare con la soluzione');
  if (!(await approveCommands(ctx, out, b.value))) {
    return void vscode.window.showInformationMessage('Verifica annullata: i comandi del backlog non sono stati consentiti.');
  }
  const failure = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'mocoder: verifico il backlog…' },
    () => check(b.value!, s.value!));
  if (!failure) return void vscode.window.showInformationMessage('Backlog verificato: tutti i controlli funzionano. Puoi iniziare.');

  const complete = await getComplete(ctx, 'main');
  // con un modello gratuito o locale correggere i test riesce di rado: la strada consigliata è un LLM esterno
  const free = !!complete && isFreeModel(aiSettings());
  const FIX = free ? 'Prova con il modello gratuito' : 'Fai correggere al Planner';
  const actions = !complete ? [COPY_REQUEST] : free ? [COPY_REQUEST, FIX] : [FIX, COPY_REQUEST];
  const advice = free ? ' Con un modello gratuito conviene un LLM esterno (Claude, ChatGPT, Gemini…): copia la richiesta, incollala lì e importa la risposta.' : '';
  const pick = await vscode.window.showErrorMessage(describeFailure(failure) + advice, ...actions);
  if (pick === COPY_REQUEST) return copyForExternal(fixRequest(backlogText, solutionText, failure));
  if (pick !== FIX || !complete) return;

  let result: Awaited<ReturnType<typeof fixUntilGreen>>;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'mocoder: il Planner corregge i controlli…' },
      () => fixUntilGreen(complete, { backlogText, solutionText }, check, log, failure));
  } catch (e) {
    return void vscode.window.showErrorMessage(e instanceof AiError ? e.message : `Errore inatteso: ${(e as Error).message}`);
  }
  if (result.rounds > 0) {
    // anche una correzione parziale è meglio dell'originale: i task sistemati restano sistemati
    writeFileSync(join(root, BACKLOG), result.backlogText, 'utf8');
    writeFileSync(join(root, SOLUTION), result.solutionText, 'utf8');
  }
  if (!result.failure) {
    return void vscode.window.showInformationMessage(`Backlog corretto in ${result.rounds === 1 ? "1 passaggio" : `${result.rounds} passaggi`} e verificato: puoi iniziare.`);
  }
  const again = await vscode.window.showWarningMessage(
    `Il Planner non è riuscito a sistemare tutto. ${describeFailure(result.failure)} Prova con un modello più capace o con un LLM esterno.`, COPY_REQUEST);
  if (again) await copyForExternal(fixRequest(result.backlogText, result.solutionText, result.failure));
}

const COPY_REQUEST = 'Copia la richiesta per un LLM esterno';

/** Mette la richiesta negli appunti e porta dritti all'import della risposta. */
async function copyForExternal(request: string) {
  await vscode.env.clipboard.writeText(request);
  const next = await vscode.window.showInformationMessage(
    'Richiesta copiata negli appunti. Incollala in Claude, ChatGPT o Gemini, copia tutta la risposta e poi importala.',
    'Importa la risposta',
  );
  if (next) await vscode.commands.executeCommand('mocoder.import');
}

export function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('mocoder');
  const tutor = new Tutor(ctx, out);
  tutor.load(); // anche a pannello chiuso i comandi devono conoscere il backlog
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${DIR}/*`);
  const reload = () => tutor.load();
  ctx.subscriptions.push(
    out,
    watcher,
    watcher.onDidChange(reload),
    watcher.onDidCreate(reload),
    watcher.onDidDelete(reload),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('mocoder')) void tutor.render(); }),
    ctx.secrets.onDidChange(() => void tutor.render()),
    vscode.window.registerWebviewViewProvider('mocoder.tutor', tutor),
    vscode.commands.registerCommand('mocoder.configureAI', () => configureAI(ctx)),
    vscode.commands.registerCommand('mocoder.plan', () => planWithAI(ctx, tutor, out)),
    vscode.commands.registerCommand('mocoder.copyPlannerPrompt', copyPlannerPrompt),
    vscode.commands.registerCommand('mocoder.import', () => importBacklog(tutor, out)),
    vscode.commands.registerCommand('mocoder.verify', () => tutor.verify()),
    vscode.commands.registerCommand('mocoder.review', () => tutor.review('task')),
    vscode.commands.registerCommand('mocoder.verifyBacklog', () => verifyBacklog(ctx, out)),
  );
}

export function deactivate() {}
