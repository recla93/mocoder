import * as vscode from 'vscode';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import schema from '../../schema/backlog.schema.json' with { type: 'json' };
import plannerPrompt from '../../prompts/planner.md';
import { parseBacklog, parseSolution, yamlBlocks, type Backlog } from './core/backlog.ts';
import { BACKLOG, DIR, SOLUTION, inside, prepareTask, readProgress, writeProgress, type Progress } from './core/workspace.ts';
import { passed, runChecks, type CheckResult } from './core/checks.ts';
import { completedMilestone, nextTask, statusOf } from './core/progress.ts';
import { redGreen } from './core/verify.ts';
import { renderPage, type Guidance } from './view.ts';

const git = promisify(execFile);
const rootDir = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const guidance = () => vscode.workspace.getConfiguration('mocoder').get<Guidance>('guidance', 'guidato');
const escapeHtml = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Markdown con il renderer di VS Code: nessuna libreria in più. */
async function markdown(md: string): Promise<string> {
  try {
    return (await vscode.commands.executeCommand<string>('markdown.api.render', md)) ?? `<pre>${escapeHtml(md)}</pre>`;
  } catch {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
}

class Tutor implements vscode.WebviewViewProvider {
  out: vscode.OutputChannel;
  view?: vscode.WebviewView;
  backlog?: Backlog;
  errors: string[] = [];
  progress: Progress = { done: [], hints: {} };
  selected?: string;
  results?: { taskId: string; list: CheckResult[] };
  busy = false;

  constructor(out: vscode.OutputChannel) {
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
    });
  }

  async onMessage(m: { type: string; id?: string; path?: string; value?: string }) {
    const root = rootDir();
    switch (m.type) {
      case 'prompt': return vscode.commands.executeCommand('mocoder.copyPlannerPrompt');
      case 'import': return vscode.commands.executeCommand('mocoder.import');
      case 'guidance': return vscode.workspace.getConfiguration('mocoder').update('guidance', m.value, vscode.ConfigurationTarget.Global);
      case 'select': this.selected = m.id; return this.render();
      case 'open': if (root && m.path) await vscode.window.showTextDocument(vscode.Uri.file(inside(root, m.path)), { preview: false }); return;
      case 'start': return this.start();
      case 'hint': return this.hint();
      case 'verify': return this.verify();
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
        void vscode.window.showInformationMessage(m
          ? `Milestone "${m.title}" completata! Prima di andare avanti rileggi i criteri di review dei suoi task: cosa rifaresti diversamente?`
          : `${task.id} completato.`);
      }
    } finally {
      this.busy = false;
      await this.render();
    }
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

async function copyPlannerPrompt() {
  const idea = await vscode.window.showInputBox({ title: 'mocoder · 1/3', prompt: 'Descrivi la tua idea di progetto', ignoreFocusOut: true });
  if (!idea) return;
  const livello = await vscode.window.showQuickPick(['principiante', 'intermedio', 'avanzato'], { title: 'mocoder · 2/3', placeHolder: 'Il tuo livello' });
  if (!livello) return;
  const obiettivo = await vscode.window.showInputBox({ title: 'mocoder · 3/3', prompt: 'Cosa vuoi imparare? (opzionale)', ignoreFocusOut: true });
  if (obiettivo === undefined) return;
  const values: Record<string, string> = {
    idea, livello, obiettivo: obiettivo || 'non specificato', stack: 'a tua scelta', ore_settimana: 'non specificato',
    schema: JSON.stringify(schema, null, 2),
  };
  const body = plannerPrompt.slice(plannerPrompt.indexOf('\n---\n') + 5);
  await vscode.env.clipboard.writeText(body.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? ''));
  void vscode.window.showInformationMessage(
    'Prompt copiato. Incollalo nel tuo LLM, copia tutta la risposta e poi usa "mocoder: Importa backlog".');
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
    const [file] = await vscode.window.showOpenDialog({ filters: { 'YAML o Markdown': ['yaml', 'yml', 'md', 'txt'] } }) ?? [];
    if (!file) return;
    text = readFileSync(file.fsPath, 'utf8');
  }

  const blocks = yamlBlocks(text);
  const backlogText = blocks.find(b => /^project:/m.test(b));
  const solutionText = blocks.find(b => b !== backlogText && /^tasks:/m.test(b));
  const b = backlogText ? parseBacklog(backlogText) : { errors: ['Nessun backlog trovato (manca "project:").'] };
  const s = b.value && solutionText ? parseSolution(solutionText, b.value) : undefined;
  const errors = [...b.errors, ...(s?.errors ?? [])];
  if (errors.length) {
    out.appendLine('--- import: errori');
    errors.forEach(e => out.appendLine(e));
    out.show(true);
    const fix = await vscode.window.showErrorMessage(`Il backlog non è valido (${errors.length} errori).`, 'Copia la richiesta di correzione per il LLM');
    if (fix) {
      await vscode.env.clipboard.writeText(
        `Il backlog non è valido per lo schema mocoder. Correggi questi errori e restituisci di nuovo i blocchi YAML completi, senza altro testo:\n${errors.map(e => `- ${e}`).join('\n')}`);
    }
    return;
  }

  if (existsSync(join(root, BACKLOG))) {
    const ok = await vscode.window.showWarningMessage('Sostituire il backlog esistente? I progressi ripartono da zero.', { modal: true }, 'Sostituisci');
    if (!ok) return;
  }
  mkdirSync(join(root, DIR), { recursive: true });
  writeFileSync(join(root, BACKLOG), backlogText!, 'utf8');
  if (s?.value) writeFileSync(join(root, SOLUTION), solutionText!, 'utf8');
  writeProgress(root, { done: [], hints: {} });
  tutor.selected = undefined;
  tutor.load();
  await vscode.commands.executeCommand('mocoder.tutor.focus');
  if (s?.value) {
    const go = await vscode.window.showInformationMessage(
      'Backlog importato. Vuoi verificare che i controlli siano corretti prima di iniziare? (servono gli strumenti del progetto installati)', 'Verifica il backlog');
    if (go) await vscode.commands.executeCommand('mocoder.verifyBacklog');
  } else {
    void vscode.window.showInformationMessage('Backlog importato. Senza soluzione di riferimento non posso verificare i controlli in anticipo.');
  }
}

async function verifyBacklog(out: vscode.OutputChannel) {
  const root = rootDir();
  if (!root || !existsSync(join(root, BACKLOG)) || !existsSync(join(root, SOLUTION))) {
    return void vscode.window.showErrorMessage(`Servono ${BACKLOG} e ${SOLUTION}.`);
  }
  const b = parseBacklog(readFileSync(join(root, BACKLOG), 'utf8'));
  const s = b.value && parseSolution(readFileSync(join(root, SOLUTION), 'utf8'), b.value);
  if (!b.value || !s?.value) return void vscode.window.showErrorMessage('Backlog o soluzione non validi: reimportali.');
  out.show(true);
  out.appendLine('--- verifica del backlog: ogni task deve fallire prima del lavoro e passare con la soluzione');
  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'mocoder: verifico il backlog…' },
    () => redGreen(b.value!, s.value!, line => out.appendLine(line)));
  void (ok
    ? vscode.window.showInformationMessage('Backlog verificato: tutti i controlli funzionano. Puoi iniziare.')
    : vscode.window.showErrorMessage('Alcuni controlli non funzionano: vedi il pannello Output "mocoder".'));
}

export function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('mocoder');
  const tutor = new Tutor(out);
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
    vscode.window.registerWebviewViewProvider('mocoder.tutor', tutor),
    vscode.commands.registerCommand('mocoder.copyPlannerPrompt', copyPlannerPrompt),
    vscode.commands.registerCommand('mocoder.import', () => importBacklog(tutor, out)),
    vscode.commands.registerCommand('mocoder.verify', () => tutor.verify()),
    vscode.commands.registerCommand('mocoder.verifyBacklog', () => verifyBacklog(out)),
  );
}

export function deactivate() {}
