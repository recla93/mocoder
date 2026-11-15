import * as vscode from 'vscode';
import { existsSync, readFileSync, writeFileSync, copyFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
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
import { diagnose } from './core/diagnose.ts';
import { commandsHash, commandsOf, suspicious } from './core/trust.ts';
import { anthropic, openaiCompatible, withBudget, isFreeModel, AiError, type Complete, type Usage } from './ai/providers.ts';
import { fill, fixRequest, fixUntilGreen, plan, promptBody, taskContext, mentorMessages, reviewMessages, capFiles, MAX_CONTEXT_CHARS, type Exchange, type Guidance, type StudentFile } from './ai/roles.ts';
import { renderPage } from './view.ts';

const git = promisify(execFile);
const rootDir = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const config = () => vscode.workspace.getConfiguration('mocoder');
const guidance = () => config().get<Guidance>('guidance', 'guided');
const escapeHtml = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const MAX_FILE = 200_000;

/** Markdown with VS Code's renderer: no extra library. */
async function markdown(md: string): Promise<string> {
  try {
    return (await vscode.commands.executeCommand<string>('markdown.api.render', md)) ?? `<pre>${escapeHtml(md)}</pre>`;
  } catch {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
}

// ---------------------------------------------------------------- AI

type Provider = 'anthropic' | 'openai';
type Slot = 'main' | 'fallback';
const USAGE_KEY = 'mocoder.usage';
const secretKey = (p: Provider, slot: Slot) => (slot === 'fallback' ? `mocoder.apiKey.fallback.${p}` : `mocoder.apiKey.${p}`);

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai';

interface Choice {
  label: string;
  detail?: string;
  provider: Provider;
  baseUrl: string;
  model?: string;
  preset?: 'gemini' | 'deepseek';
  ollama?: boolean;
}

/** The three ways proposed before the others: free without an account, free with one, pay as you go. */
const CHOICES: Choice[] = [
  { preset: 'gemini', label: 'Gemini · free API (one account)', detail: 'Free key from AI Studio, no card · reduced context', provider: 'openai', baseUrl: GEMINI, model: 'gemini-flash-latest' },
  { preset: 'deepseek', label: 'DeepSeek · pay as you go (cents)', detail: 'Tutor, review and test fixing · about $0.30 per million input tokens', provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  { label: 'Ollama (on this PC)', detail: 'Local models, or Ollama\'s own ":cloud" models · no key', provider: 'openai', baseUrl: 'http://localhost:11434/v1', ollama: true },
  { label: 'Other OpenAI-compatible provider', detail: 'OpenRouter, OpenAI, Groq, LM Studio… · asks for the API address', provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { label: 'Anthropic (Claude)', detail: 'The quality benchmark, the most expensive', provider: 'anthropic', baseUrl: '' },
];

/** Without AI the task files go to the web chatbot: there the full context is wasted, and free plans have a quota. */
const FREE_CONTEXT_CHARS = 15_000;

/** Context cap for the current configuration: a free plan cannot take 60k characters per question. */
function contextLimit(): number {
  const s = aiSettings();
  return isFreeModel(s) || s.baseUrl.includes('generativelanguage.googleapis.com') ? FREE_CONTEXT_CHARS : MAX_CONTEXT_CHARS;
}

/** Exchanges sent to the tutor: the whole chat stays in the panel, but the context does not grow with every question. */
const MAX_HISTORY = 8;

function aiSettings(slot: Slot = 'main') {
  const c = config();
  const p = slot === 'fallback' ? 'ai.fallback.' : 'ai.';
  return {
    provider: c.get<Provider>(p + 'provider', slot === 'fallback' ? 'openai' : 'anthropic'),
    baseUrl: c.get<string>(p + 'baseUrl', ''),
    model: c.get<string>(p + 'model', slot === 'fallback' ? '' : 'claude-opus-5-5'),
    mentorModel: slot === 'fallback' ? '' : c.get<string>('ai.mentorModel', ''),
  };
}

/** The model that answers a role, already with budget counting. undefined if AI is not configured. */
async function getComplete(ctx: vscode.ExtensionContext, role: 'main' | 'mentor', slot: Slot = 'main'): Promise<Complete | undefined> {
  const s = aiSettings(slot);
  const model = (role === 'mentor' && s.mentorModel) || s.model;
  if (!model) return undefined;
  const apiKey = await ctx.secrets.get(secretKey(s.provider, slot));
  let complete: Complete;
  if (s.provider === 'anthropic') {
    if (!apiKey && !process.env.ANTHROPIC_API_KEY) return undefined;
    complete = anthropic({ model, apiKey, baseURL: s.baseUrl });
  } else {
    if (!s.baseUrl) return undefined;
    complete = openaiCompatible({ baseUrl: s.baseUrl, model, apiKey });
  }
  return withBudget(
    complete,
    { get: () => ctx.globalState.get<Usage>(USAGE_KEY), set: u => ctx.globalState.update(USAGE_KEY, u) },
    () => config().get<number>('ai.monthlyTokenBudget', 0),
  );
}

const errorText = (e: unknown) => (e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`);

/**
 * Runs an AI call. If the provider is down and a backup key exists, asks before switching to it:
 * mocoder never changes provider on its own. Any other failure is rethrown to the caller.
 */
async function withBackup<T>(ctx: vscode.ExtensionContext, role: 'main' | 'mentor', complete: Complete, run: (c: Complete) => PromiseLike<T>): Promise<T> {
  try {
    return await run(complete);
  } catch (e) {
    if (!(e instanceof AiError && e.unavailable)) throw e;
    const backup = await getComplete(ctx, role, 'fallback');
    if (!backup) throw e;
    const go = await vscode.window.showWarningMessage(
      `Your primary provider isn't responding. Switch to your backup API key?\n\n${e.message}`, 'Use backup key');
    if (!go) throw e;
    return run(backup);
  }
}

async function aiLabel(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  if (!(await getComplete(ctx, 'main'))) return undefined;
  const s = aiSettings();
  const u = ctx.globalState.get<Usage>(USAGE_KEY);
  const tokens = u?.month === new Date().toISOString().slice(0, 7) ? u.tokens : 0;
  return `${s.model} · ${(tokens / 1000).toFixed(1)}k tokens this month`;
}

async function configureAI(ctx: vscode.ExtensionContext, preset?: string, slot: Slot = 'main') {
  const backup = slot === 'fallback';
  // from the panel the chosen way arrives already: the same question is not asked twice
  // without a preset, find() would match the first entry with no preset (Ollama) and skip the menu
  const choice = (preset ? CHOICES.find(c => c.preset === preset) : undefined)
    // matchOnDetail: typing "openrouter" must find the entry that names it only in the detail
    ?? await vscode.window.showQuickPick(CHOICES, { title: backup ? 'mocoder · Backup API key: which provider?' : 'mocoder · Which way for AI?', matchOnDetail: true });
  if (!choice) return;

  let baseUrl = choice.baseUrl;
  if (choice.label.startsWith('Other')) {
    const url = await vscode.window.showInputBox({
      title: 'API address', value: baseUrl, ignoreFocusOut: true,
      prompt: 'E.g. https://openrouter.ai/api/v1 for OpenRouter, http://localhost:1234/v1 for LM Studio',
    });
    if (!url) return;
    baseUrl = url;
  }

  let models: string[] = [];
  if (choice.ollama) {
    try {
      const tags = await (await fetch('http://localhost:11434/api/tags')).json() as { models?: { name: string }[] };
      models = (tags.models ?? []).map(m => m.name);
    } catch {
      void vscode.window.showWarningMessage('Ollama is not answering on localhost:11434: start it, then choose the model.');
    }
  }
  const current = aiSettings(slot);
  const ollama = !!choice.ollama;
  const OTHER = 'Other model… (e.g. gemma4:31b-cloud)';
  let model = models.length
    ? await vscode.window.showQuickPick([...models, OTHER], { title: 'Ollama model: the ":cloud" ones run on Ollama servers, not on your PC' })
    : undefined;
  if (models.length && !model) return;
  if (!models.length || model === OTHER) model = await vscode.window.showInputBox({
      title: 'Model',
      value: choice.model ?? (choice.provider === 'anthropic' ? (current.provider === 'anthropic' ? current.model : 'claude-opus-5-5') : ollama ? 'gemma4:31b-cloud' : ''),
      prompt: choice.model
        ? `Default: ${choice.model}. If the provider says "model not found", take the current name from its website.`
        : choice.provider === 'anthropic' ? 'E.g. claude-opus-5-5 (recommended) or claude-haiku-5-5 (cheap)' : 'Model name on the provider',
      ignoreFocusOut: true,
    });
  if (!model) return;

  if (!ollama) {
    const key = await vscode.window.showInputBox({
      title: backup ? 'Backup API key' : 'API key', password: true, ignoreFocusOut: true,
      prompt: choice.provider === 'anthropic' ? 'Leave empty to use ANTHROPIC_API_KEY. The key stays in the system keychain.' : 'The key stays in the system keychain.',
    });
    if (key === undefined) return;
    if (key) await ctx.secrets.store(secretKey(choice.provider, slot), key);
  }

  const c = config();
  const p = backup ? 'ai.fallback.' : 'ai.';
  // a mentorModel chosen for another provider does not exist here: better fall back to the main model
  if (!backup && current.mentorModel && (current.provider !== choice.provider || current.baseUrl !== baseUrl)) {
    await c.update('ai.mentorModel', '', vscode.ConfigurationTarget.Global);
  }
  await c.update(p + 'provider', choice.provider, vscode.ConfigurationTarget.Global);
  await c.update(p + 'baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  await c.update(p + 'model', model, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    backup
      ? `Backup API ready: ${model}. mocoder will ask before switching to it.`
      : `AI configured: ${model}. The code of the task files is sent to this provider when you ask for help or a review.`);
}

// ---------------------------------------------------------------- Panel

class Tutor implements vscode.WebviewViewProvider {
  ctx: vscode.ExtensionContext;
  out: vscode.OutputChannel;
  view?: vscode.WebviewView;
  backlog?: Backlog;
  errors: string[] = [];
  progress: Progress = { done: [], hints: {} };
  selected?: string;
  results?: { taskId: string; list: CheckResult[]; committed?: boolean };
  chats = new Map<string, Exchange[]>();   // per task, in memory only
  busy = false;
  thinking = false;
  draft?: string;   // a question whose call failed, given back to the student once

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
    const shown = task && guidance() !== 'autonomous' ? task.hints.slice(0, this.progress.hints[task.id] ?? 0) : [];
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
      committed: this.results?.taskId === task?.id ? this.results?.committed : undefined,
      busy: this.busy,
      ai: await aiLabel(this.ctx),
      canVerifyBacklog: !!rootDir() && existsSync(join(rootDir()!, SOLUTION)),
      chat: await Promise.all(chat.map(async e => ({ role: e.role, html: e.role === 'student' ? `<p>${escapeHtml(e.text)}</p>` : await markdown(e.text) }))),
      thinking: this.thinking,
      draft: this.draft,
    });
    this.draft = undefined;
  }

  async onMessage(m: { type: string; id?: string; path?: string; value?: string; text?: string; q?: string; preset?: string }) {
    const root = rootDir();
    switch (m.type) {
      case 'prompt': return vscode.commands.executeCommand('mocoder.copyPlannerPrompt');
      case 'import': return vscode.commands.executeCommand('mocoder.import');
      case 'plan': return vscode.commands.executeCommand('mocoder.plan');
      case 'configure': return vscode.commands.executeCommand('mocoder.configureAI', m.preset);
      case 'fallback': return vscode.commands.executeCommand('mocoder.addFallbackKey');
      case 'guidance': return config().update('guidance', m.value, vscode.ConfigurationTarget.Global);
      case 'select': this.selected = m.id; return this.render();
      case 'open': if (root && m.path) await vscode.window.showTextDocument(vscode.Uri.file(inside(root, m.path)), { preview: false }); return;
      case 'start': return this.start();
      case 'hint': return this.hint();
      case 'verify': return this.verify();
      case 'ask': return m.text?.trim() ? this.ask(m.text.trim()) : undefined;
      case 'explain': return this.ask('The verification is failing. Help me understand the error without giving me the solution.');
      case 'review': return this.review('task');
      case 'verifyBacklog': return vscode.commands.executeCommand('mocoder.verifyBacklog');
      case 'search':
        // only the task's searches, always to a search engine: the page cannot open arbitrary URLs
        if (m.q && this.task?.search?.includes(m.q)) await vscode.env.openExternal(vscode.Uri.parse(`https://www.google.com/search?q=${encodeURIComponent(m.q)}`));
        return;
    }
  }

  async start() {
    const root = rootDir();
    const task = this.task;
    if (!root || !task) return;
    const files = prepareTask(root, task, guidance() !== 'autonomous');
    for (const [i, f] of files.entries()) {
      await vscode.window.showTextDocument(vscode.Uri.file(inside(root, f)), { preview: false, preserveFocus: i < files.length - 1 });
    }
  }

  async hint() {
    const root = rootDir();
    const task = this.task;
    if (!root || !task || guidance() === 'autonomous') return;
    const shown = this.progress.hints[task.id] ?? 0;
    if (shown >= task.hints.length) return;
    if (guidance() === 'hints' && shown === task.hints.length - 1) {
      const ok = await vscode.window.showWarningMessage(
        'The next hint is the full solution. Try a bit longer first?', { modal: true }, 'Show the solution');
      if (!ok) return;
    }
    this.progress.hints[task.id] = shown + 1;
    writeProgress(root, this.progress);
    await this.render();
  }

  async verify() {
    const root = rootDir();
    const task = this.task;
    if (!root) return void vscode.window.showInformationMessage('Open the project folder first.');
    if (!task || !this.backlog) return void vscode.window.showInformationMessage('No task selected: pick one from the path.');
    if (this.busy) return;
    if (statusOf(task, this.progress) === 'locked') return void vscode.window.showInformationMessage('The task is locked: complete the tasks it depends on first.');
    if (!(await approveCommands(this.ctx, this.out, this.backlog))) {
      return void vscode.window.showInformationMessage('Verification cancelled: the backlog commands were not allowed.');
    }
    await vscode.workspace.saveAll(false);
    this.busy = true;
    await this.render();
    try {
      const list = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `mocoder: checking ${task.id}` },
        () => runChecks(root, task.checks));
      this.results = { taskId: task.id, list };
      // failures with no matching rule are kept: they are where the next offline tips come from
      for (const r of list) {
        if (r.ok || diagnose(r.output).tips.length) continue;
        mkdirSync(join(root, DIR), { recursive: true });
        appendFileSync(join(root, DIR, 'diagnose-missed.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), task: task.id, run: r.check.run, output: r.output.slice(-2000) }) + '\n', 'utf8');
      }
      this.out.appendLine(`--- ${task.id} ${new Date().toLocaleString()}`);
      for (const r of list) this.out.appendLine(`${r.ok ? 'OK ' : 'KO '} $ ${r.check.run}\n${r.output}`);
      if (passed(list)) {
        if (!this.progress.done.includes(task.id)) this.progress.done.push(task.id);
        writeProgress(root, this.progress);
        this.results.committed = await this.commit(root, `feat(${task.id}): ${task.title}`);
        const m = completedMilestone(this.backlog, this.progress, task);
        if (m) {
          void vscode.window.showInformationMessage(
            `Milestone "${m.title}" complete! Before moving on, have the work reviewed, as in a pull request.`,
            'Ask for the milestone review',
          ).then(go => go && this.review('milestone', task));
        } else if (this.results.committed) {
          // when the commit failed, its warning already says the task is done
          void vscode.window.showInformationMessage(`${task.id} done.`);
        }
      }
    } finally {
      this.busy = false;
      await this.render();
    }
  }

  /** The user's files for the given tasks, read from disk as they are now and within the context budget. */
  studentFiles(tasks: Task[]): StudentFile[] {
    const root = rootDir()!;
    const paths = [...new Set(tasks.flatMap(t => (t.files ?? []).filter(f => !f.given).map(f => f.path)))];
    const files = paths.map(path => {
      const abs = inside(root, path);
      return existsSync(abs) && statSync(abs).size <= MAX_FILE ? { path, content: readFileSync(abs, 'utf8') } : { path };
    });
    // a free plan has a token quota: with the full context a few questions would exhaust it
    return capFiles(files, contextLimit());
  }

  /** Runs an AI call showing the state in the panel; errors become clear messages. */
  async withAI(task: Task, entry: Exchange | undefined, run: (c: Complete) => Promise<string>, role: Exchange['role'], model: 'main' | 'mentor') {
    const complete = await getComplete(this.ctx, model);
    if (!complete) {
      const go = await vscode.window.showWarningMessage('Configure an AI first (Claude, Ollama or another provider).', 'Configure');
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
      const text = await withBackup(this.ctx, model, complete, c => run(this.track(c, role)));
      chat.push({ role, text });
    } catch (e) {
      // the unanswered question goes back into the box: it must not stay in the history the tutor receives
      if (entry) { chat.splice(chat.indexOf(entry), 1); this.draft = entry.text; }
      const msg = errorText(e);
      this.out.appendLine(`AI: ${msg}`);
      if (e instanceof AiError && e.unavailable && !(await getComplete(this.ctx, model, 'fallback'))) {
        void vscode.window.showErrorMessage(
          `${msg}\n\nAdd a backup API key to switch provider without losing this session.`, 'Add backup key')
          .then(go => go && vscode.commands.executeCommand('mocoder.addFallbackKey'));
      } else {
        void vscode.window.showErrorMessage(msg);
      }
    } finally {
      this.thinking = false;
      await this.render();
    }
  }

  /** Every call reports its weight: it tells whether the mentor model is worth it. */
  track(complete: Complete, role: Exchange['role']): Complete {
    return async r => {
      const res = await complete(r);
      this.out.appendLine(`AI ${role}: ${res.inputTokens} in / ${res.outputTokens} out`);
      return res;
    };
  }

  async ask(question: string) {
    const task = this.task;
    if (!task) return;
    await vscode.workspace.saveAll(false);
    const history = [...(this.chats.get(task.id) ?? [])].slice(-MAX_HISTORY);
    const results = this.results?.taskId === task.id ? this.results.list : undefined;
    const context = taskContext(task, guidance(), this.progress.hints[task.id] ?? 0, this.studentFiles([task]), results);
    await this.withAI(task, { role: 'student', text: question }, async complete =>
      (await complete({ system: mentorPrompt, messages: mentorMessages(context, history, question), maxTokens: 16000, effort: 'low' })).text,
    'tutor', 'mentor');
  }

  async review(scope: 'task' | 'milestone', of = this.task) {
    if (!of || !this.backlog) return void vscode.window.showInformationMessage('No task selected: pick one from the path.');
    await vscode.workspace.saveAll(false);
    const tasks = scope === 'task' ? [of] : this.backlog.tasks.filter(t => t.milestone === of.milestone);
    const label = scope === 'task' ? `${of.id} · ${of.title}` : `milestone ${of.milestone}`;
    this.selected = of.id;
    await this.withAI(of, undefined, async complete =>
      (await complete({ system: reviewerPrompt, messages: reviewMessages(tasks, this.studentFiles(tasks), label, this.backlog?.conventions), maxTokens: 16000, effort: 'medium' })).text,
    'review', 'main');
  }

  /** One task = one commit, as in a real team. If git is missing, the tutor still works. */
  async commit(root: string, message: string): Promise<boolean> {
    try {
      // the reference solution (and its backups) must not end up in the student's repository, nor the diagnostic outputs
      const ignore = join(root, DIR, '.gitignore');
      const have = existsSync(ignore) ? readFileSync(ignore, 'utf8').split(/\r?\n/) : [];
      const missing = ['solution.yaml', '*.bak', 'diagnose-missed.jsonl'].filter(l => !have.includes(l));
      if (missing.length) appendFileSync(ignore, (have.length && have.at(-1) !== '' ? '\n' : '') + missing.join('\n') + '\n', 'utf8');
      if (!existsSync(join(root, '.git'))) await git('git', ['init'], { cwd: root });
      await git('git', ['add', '-A'], { cwd: root });
      await git('git', ['commit', '-m', message], { cwd: root });
      this.out.appendLine(`git commit -m "${message}"`);
      return true;
    } catch (e) {
      const err = e as Error & { stderr?: string; stdout?: string };
      const why = `${err.stderr ?? ''}${err.stdout ?? ''}${err.message}`;
      this.out.appendLine(`git: commit failed (${why.trim().split('\n')[0]})`);
      if (/nothing to commit/.test(why)) return true;
      const identity = /tell me who you are|user\.email|user\.name/i.test(why);
      void vscode.window.showWarningMessage(identity
        ? 'Task done, but git could not commit: it does not know who you are. Run in a terminal: git config --global user.name "Your Name" and git config --global user.email "you@example.com", then verify again.'
        : `Task done, but the git commit failed (details in the Output panel). ${/ENOENT/.test(why) ? 'Is git installed?' : ''}`);
      return false;
    }
  }
}

// ---------------------------------------------------------------- Create and import a backlog

async function askIdea(): Promise<string | undefined> {
  const idea = await vscode.window.showInputBox({ title: 'mocoder · 1/3', prompt: 'Describe your project idea', ignoreFocusOut: true });
  if (!idea) return;
  const level = await vscode.window.showQuickPick(['beginner', 'intermediate', 'advanced'], { title: 'mocoder · 2/3', placeHolder: 'Your level' });
  if (!level) return;
  const goal = await vscode.window.showInputBox({ title: 'mocoder · 3/3', prompt: 'What do you want to learn? (optional)', ignoreFocusOut: true });
  if (goal === undefined) return;
  return fill(promptBody(plannerPrompt), {
    // "your choice" alone made weak models ignore a stack named in the idea (Java request → Python path)
    idea, livello: level, obiettivo: goal || 'not specified', stack: 'the ones named in the idea; if none, your choice', ore_settimana: 'not specified',
    schema: JSON.stringify(schema, null, 2),
  });
}

async function copyPlannerPrompt() {
  const prompt = await askIdea();
  if (!prompt) return;
  await vscode.env.clipboard.writeText(prompt);
  void vscode.window.showInformationMessage(
    'Prompt copied. Paste it into your LLM, copy the whole answer, then run "mocoder: Import backlog".');
}

/** Writes the backlog (and solution) into the project and resets progress, asking for confirmation if one exists. */
async function installBacklog(tutor: Tutor, root: string, backlogText: string, solutionText?: string): Promise<boolean> {
  if (existsSync(join(root, BACKLOG))) {
    const ok = await vscode.window.showWarningMessage('Replace the existing backlog? Progress restarts from zero.', { modal: true }, 'Replace');
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
      'Backlog ready. Do you want to check that the checks are correct before you start? (the project tools must be installed)', 'Verify the backlog');
    if (go) await vscode.commands.executeCommand('mocoder.verifyBacklog');
  } else {
    void vscode.window.showInformationMessage('Backlog ready. Without a reference solution I cannot check the checks in advance.');
  }
  return true;
}

async function importBacklog(tutor: Tutor, out: vscode.OutputChannel) {
  const root = rootDir();
  if (!root) return void vscode.window.showErrorMessage('Open the project folder (even empty) first.');
  const source = await vscode.window.showQuickPick(['From the clipboard (LLM answer)', 'From a file…'], { placeHolder: 'Where do I import the backlog from?' });
  if (!source) return;
  let text: string;
  if (source.startsWith('From the')) {
    text = await vscode.env.clipboard.readText();
  } else {
    const [file] = await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.file(root),   // the chatbot answer is usually saved in the project
      filters: { 'YAML or Markdown': ['yaml', 'yml', 'md', 'txt'] },
    }) ?? [];
    if (!file) return;
    text = readFileSync(file.fsPath, 'utf8');
  }
  if (!text.trim()) {
    return void vscode.window.showErrorMessage(source.startsWith('From the')
      ? 'The clipboard is empty: in the chatbot copy the whole answer, then try again.'
      : 'The file is empty.');
  }

  const a = parsePlannerAnswer(text);
  if (a.fixes.length) {
    out.appendLine('--- import: automatic format fixes');
    a.fixes.forEach(f => out.appendLine(f));
  }
  if (!a.backlog || a.errors.length) {
    out.appendLine('--- import: errors');
    a.errors.forEach(e => out.appendLine(e));
    out.show(true);
    const fix = await vscode.window.showErrorMessage(`The backlog is not valid (${a.errors.length} errors).`, 'Copy the repair request for the LLM');
    if (fix) await vscode.env.clipboard.writeText(repairRequest(a.errors));
    return;
  }
  if (a.fixes.length) void vscode.window.showInformationMessage(`I fixed ${a.fixes.length === 1 ? '1 chatbot format error' : `${a.fixes.length} chatbot format errors`} on my own (details in the Output panel).`);
  await installBacklog(tutor, root, a.backlogText!, a.solution ? a.solutionText : undefined);
}

async function planWithAI(ctx: vscode.ExtensionContext, tutor: Tutor, out: vscode.OutputChannel) {
  const root = rootDir();
  if (!root) return void vscode.window.showErrorMessage('Open the project folder (even empty) first.');
  const complete = await getComplete(ctx, 'main');
  if (!complete) {
    const go = await vscode.window.showWarningMessage('Configure an AI first, or use the prompt to paste into your LLM.', 'Configure');
    if (go) await vscode.commands.executeCommand('mocoder.configureAI');
    return;
  }
  const prompt = await askIdea();
  if (!prompt) return;

  let chars = 0;
  const runPlan = (c: Complete) => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'mocoder: the Planner is building the path', cancellable: false },
    async progress => {
      let shown = 0;
      return plan(c, prompt, delta => {
        chars += delta.length;
        if (chars - shown > 2000) {
          shown = chars;
          progress.report({ message: `${Math.round(chars / 1000)}k characters written…` });
        }
      });
    });

  let result: Awaited<ReturnType<typeof plan>>;
  try {
    result = await withBackup(ctx, 'main', complete, runPlan);
  } catch (e) {
    // if the AI is not answering, the idea must not be lost: the no-account path stays open with the same prompt
    const go = await vscode.window.showErrorMessage(errorText(e), 'Copy the prompt for an external LLM');
    if (go) await copyForExternal(prompt);
    return;
  }

  out.appendLine(`--- planner: ${result.attempts} attempts, ${result.errors.length} leftover errors`);
  result.errors.forEach(e => out.appendLine(e));

  // the feasibility assessment is the first thing the student must read
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: result.feasibility || result.answer });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });

  if (!result.backlog) {
    return void vscode.window.showWarningMessage(result.errors.length && /^```ya?ml/m.test(result.answer)
      ? `The Planner could not produce a valid backlog after ${result.attempts} attempts (details in the Output panel).`
      : 'The Planner thinks the idea is not feasible as it is: read the proposed alternatives.');
  }
  if (result.errors.length) void vscode.window.showWarningMessage('The reference solution is not valid: I will install the backlog without the pre-check.');
  await installBacklog(tutor, root, result.backlogText!, result.solution ? result.solutionText : undefined);
}

// ---------------------------------------------------------------- Command approval

// In VS Code's private state for the folder, not in the project: a backlog cannot approve itself.
const APPROVED_KEY = 'mocoder.approvedCommands';
const MAX_SHOWN = 30;

/** Asks to approve the backlog commands, once for every different set of commands. */
async function approveCommands(ctx: vscode.ExtensionContext, out: vscode.OutputChannel, backlog: Backlog): Promise<boolean> {
  const commands = commandsOf(backlog);
  const hash = commandsHash(commands);
  if (ctx.workspaceState.get(APPROVED_KEY) === hash) return true;
  const lines = commands.map(c => `${suspicious(c) ? '⚠' : '•'} ${c}`);
  out.appendLine('--- check commands to approve');
  lines.forEach(l => out.appendLine(l));
  const shown = lines.slice(0, MAX_SHOWN).join('\n')
    + (lines.length > MAX_SHOWN ? `\n… and ${lines.length - MAX_SHOWN} more (full list in the Output panel)` : '');
  const warning = commands.some(suspicious) ? '\n\n⚠ = unusual command for a check: read it carefully before allowing it.' : '';
  out.show(true);   // the full list is here: the dialog would show at most MAX_SHOWN
  const ok = await vscode.window.showWarningMessage(
    'This backlog runs commands on your computer. Do you allow them?',
    {
      modal: true,
      detail: `To verify the tasks, mocoder will run:\n\n${shown}${warning}\n\n`
        + 'Allow only if you trust the source of the backlog. If the commands change, I will ask again.',
    },
    'Allow these commands',
  );
  if (!ok) return false;
  await ctx.workspaceState.update(APPROVED_KEY, hash);
  out.appendLine('commands approved');
  return true;
}

const describeFailure = (f: VerifyFailure) =>
  `${f.taskId}: ${f.kind === 'red' ? 'the checks already pass before the work, so they verify nothing' : 'the checks fail even with the reference solution'}.`;

/** Nothing for the AI to fix: the user installs what is missing and verifies again. */
async function showMissing(f: VerifyFailure) {
  const go = await vscode.window.showWarningMessage(
    `${f.taskId} cannot be verified on this computer: ${f.missing}. The backlog is not necessarily wrong: the tasks before ${f.taskId} passed. Verify again afterwards.`,
    'Verify again');
  if (go) await vscode.commands.executeCommand('mocoder.verifyBacklog');
}

async function verifyBacklog(ctx: vscode.ExtensionContext, out: vscode.OutputChannel) {
  const root = rootDir();
  if (!root || !existsSync(join(root, BACKLOG)) || !existsSync(join(root, SOLUTION))) {
    return void vscode.window.showErrorMessage(`${BACKLOG} and ${SOLUTION} are required.`);
  }
  const backlogText = readFileSync(join(root, BACKLOG), 'utf8');
  const solutionText = readFileSync(join(root, SOLUTION), 'utf8');
  const b = parseBacklog(backlogText);
  const s = b.value && parseSolution(solutionText, b.value);
  if (!b.value || !s?.value) return void vscode.window.showErrorMessage('Invalid backlog or solution: import them again.');
  const log = (line: string) => out.appendLine(line);
  const check = async (bk: Backlog, sol: Solution) => {
    if (!(await approveCommands(ctx, out, bk))) throw new AiError('Verification stopped: the backlog commands were not allowed.');
    return redGreen(bk, sol, log);
  };
  out.show(true);
  out.appendLine('--- backlog verification: every task must fail before the work and pass with the solution');
  if (!(await approveCommands(ctx, out, b.value))) {
    return void vscode.window.showInformationMessage('Verification cancelled: the backlog commands were not allowed.');
  }
  const failure = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'mocoder: verifying the backlog…' },
    () => check(b.value!, s.value!));
  if (!failure) return void vscode.window.showInformationMessage('Backlog verified: all checks work. You can start.');
  if (failure.kind === 'missing') return showMissing(failure);

  const complete = await getComplete(ctx, 'main');
  // with a free or local model, fixing the tests rarely works: the recommended path is an external LLM
  const free = !!complete && isFreeModel(aiSettings());
  const FIX = free ? 'Try with the free model' : 'Have the Planner fix it';
  const actions = !complete ? [COPY_REQUEST] : free ? [COPY_REQUEST, FIX] : [FIX, COPY_REQUEST];
  const advice = free ? ' With a free model an external LLM works better (Claude, ChatGPT, Gemini…): copy the request, paste it there and import the answer.' : '';
  const pick = await vscode.window.showErrorMessage(describeFailure(failure) + advice, ...actions);
  if (pick === COPY_REQUEST) return copyForExternal(fixRequest(backlogText, solutionText, failure));
  if (pick !== FIX || !complete) return;

  let result: Awaited<ReturnType<typeof fixUntilGreen>>;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'mocoder: the Planner is fixing the checks…' },
      () => fixUntilGreen(complete, { backlogText, solutionText }, check, log, failure));
  } catch (e) {
    return void vscode.window.showErrorMessage(errorText(e));
  }
  if (result.rounds > 0) {
    // even a partial fix beats the original: the tasks that were fixed stay fixed.
    // the original is kept though: a fix can make things worse, and there is no other way back.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const rel of [BACKLOG, SOLUTION]) {
      const abs = join(root, rel);
      if (existsSync(abs)) copyFileSync(abs, `${abs}.${stamp}.bak`);
    }
    writeFileSync(join(root, BACKLOG), result.backlogText, 'utf8');
    writeFileSync(join(root, SOLUTION), result.solutionText, 'utf8');
    out.appendLine(`backups in ${DIR}: *.${stamp}.bak`);
  }
  if (!result.failure) {
    return void vscode.window.showInformationMessage(`Backlog fixed in ${result.rounds === 1 ? '1 pass' : `${result.rounds} passes`} and verified: you can start.`);
  }
  if (result.failure.kind === 'missing') return showMissing(result.failure);
  const again = await vscode.window.showWarningMessage(
    `The Planner could not fix everything. ${describeFailure(result.failure)} Try a more capable model or an external LLM.`, COPY_REQUEST);
  if (again) await copyForExternal(fixRequest(result.backlogText, result.solutionText, result.failure));
}

const COPY_REQUEST = 'Copy the request for an external LLM';

/** Puts the request on the clipboard and takes you straight to importing the answer. */
async function copyForExternal(request: string) {
  await vscode.env.clipboard.writeText(request);
  const next = await vscode.window.showInformationMessage(
    'Request copied to the clipboard. Paste it into Claude, ChatGPT or Gemini, copy the whole answer, then import it.',
    'Import the answer',
  );
  if (next) await vscode.commands.executeCommand('mocoder.import');
}

export function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('mocoder');
  const tutor = new Tutor(ctx, out);
  tutor.load(); // even with the panel closed, the commands must know the backlog
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
    vscode.commands.registerCommand('mocoder.configureAI', (preset?: string) => configureAI(ctx, preset)),
    vscode.commands.registerCommand('mocoder.addFallbackKey', () => configureAI(ctx, undefined, 'fallback')),
    vscode.commands.registerCommand('mocoder.plan', () => planWithAI(ctx, tutor, out)),
    vscode.commands.registerCommand('mocoder.copyPlannerPrompt', copyPlannerPrompt),
    vscode.commands.registerCommand('mocoder.import', () => importBacklog(tutor, out)),
    vscode.commands.registerCommand('mocoder.verify', () => tutor.verify()),
    vscode.commands.registerCommand('mocoder.review', () => tutor.review('task')),
    vscode.commands.registerCommand('mocoder.verifyBacklog', () => verifyBacklog(ctx, out)),
  );
}

export function deactivate() {}
