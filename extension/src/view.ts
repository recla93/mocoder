import type { Backlog, Task } from './core/backlog.ts';
import type { CheckResult } from './core/checks.ts';
import type { Progress } from './core/workspace.ts';
import { statusOf, nextTask } from './core/progress.ts';
import { diagnose } from './core/diagnose.ts';
import type { Guidance } from './ai/roles.ts';

export interface Page {
  cspSource: string;
  nonce: string;
  hasFolder: boolean;
  backlog?: Backlog;
  errors: string[];
  progress: Progress;
  task?: Task;
  theoryHtml: string;       // markdown already rendered by VS Code
  hintsHtml: string[];
  guidance: Guidance;
  results?: CheckResult[];
  committed?: boolean;      // false = the checks passed but the git commit failed
  milestoneDone?: string;   // title of the milestone this task completed: its review stays one click away
  busy: boolean;
  ai?: string;              // model and usage, if AI is configured
  canVerifyBacklog: boolean; // there is a reference solution: the checks can be verified
  chat: { role: 'student' | 'tutor' | 'review'; html: string }[];
  thinking: boolean;
  draft?: string;           // a question whose AI call failed: back in the box
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Safe text with `fragments` rendered as code. */
const inlineCode = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const button = (type: string, label: string, attrs = '') => `<button data-type="${type}" ${attrs}>${esc(label)}</button>`;

const ICON = { done: '✓', available: '●', locked: '○' };

function welcome(p: Page) {
  if (!p.hasFolder) return '<p>Open a folder (even an empty one) to start a project.</p>';
  const errors = p.errors.length
    ? `<div class="error"><b>The backlog is not valid:</b><ul>${p.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  if (p.ai) {
    return `${errors}
    <h2>New project</h2>
    <p class="ok">AI ready: ${esc(p.ai)}</p>
    ${button('plan', 'Create the path with AI')}
    <p class="muted">If calls fail (quota exhausted, credit, model not found) <a href="#" data-type="configure">change AI</a>
    or <a href="#" data-type="fallback">add a backup key</a>.
    Without AI you can always use the external prompt: “Copy the prompt to create a backlog” and “Import backlog” in the command palette.</p>`;
  }
  // the choice is made once: three paths, from cheapest to most convenient
  return `${errors}
    <h2>How do you create the path?</h2>
    <div class="mode">
      <h3>1 · Free, no account</h3>
      <p>The web chatbot you already use generates the backlog: no key, no cost.</p>
      <ol>
        <li>Describe the idea: mocoder prepares the prompt.</li>
        <li>Paste it into the chatbot and copy <b>the whole</b> answer.</li>
        <li>Come back here and import it: it is validated and fixed into the format.</li>
      </ol>
      ${button('prompt', 'Copy the prompt', 'class="secondary"')} ${button('import', 'Import the answer', 'class="secondary"')}
      <p class="muted">Only the in-editor tutor is missing: path, verification, checks and “What the error says” still work.</p>
    </div>
    <div class="mode">
      <h3>2 · Free API, one account</h3>
      <p>Gemini (AI Studio, free key without a card): tutor and review right here. Reduced context, because the free plan has a token quota.</p>
      ${button('configure', 'Connect Gemini (free)', 'class="secondary" data-preset="gemini"')}
    </div>
    <div class="mode">
      <h3>3 · Paid API, one account</h3>
      <p>DeepSeek: tutor, review and test fixing for a few cents a month. The key stays in the system keychain.</p>
      ${button('configure', 'Connect DeepSeek (paid)', 'class="secondary" data-preset="deepseek"')}
    </div>
    <p class="muted">You choose once: to change path, redo the configuration.</p>`;
}

function taskList(b: Backlog, p: Page) {
  return b.milestones.map(m => {
    const items = b.tasks.filter(t => t.milestone === m.id).map(t => {
      const s = statusOf(t, p.progress);
      const current = t.id === p.task?.id ? ' current' : '';
      return `<li><button class="task ${s}${current}" data-type="select" data-id="${t.id}" ${s === 'locked' ? 'disabled' : ''}>
        <span class="icon">${ICON[s]}</span> ${esc(t.id)} · ${esc(t.title)}</button></li>`;
    }).join('');
    return `<h3 title="${esc(m.goal)}">${esc(m.title)}</h3><ul class="tasks">${items}</ul>`;
  }).join('');
}

function results(p: Page, b: Backlog) {
  if (p.busy) return '<p class="muted">Verification in progress…</p>';
  if (!p.results) return '';
  const rows = p.results.map(r => {
    const d = diagnose(r.output);
    const count = d.tests ? `<span class="muted"> · ${d.tests.passed} of ${d.tests.passed + d.tests.failed} tests pass</span>` : '';
    // offline tips derived from the output: no AI, no network
    const tips = !r.ok && d.tips.length
      ? `<div class="tips"><b>What the error says</b><ul>${d.tips.map(t => `<li><b>${esc(t.title)}</b>: ${inlineCode(t.text)}</li>`).join('')}</ul></div>`
      : '';
    return `
    ${tips}
    <details class="check ${r.ok ? 'ok' : 'ko'}" ${r.ok || tips ? '' : 'open'}>
      <summary>${r.ok ? '✓' : '✗'} <code>${esc(r.check.run)}</code>${count}</summary>
      <pre>${esc(r.output.trim() || '(no output)')}</pre>
    </details>`;
  }).join('');
  const allOk = p.results.every(r => r.ok);
  const next = allOk ? nextTask(b, p.progress) : undefined;
  const footer = allOk
    ? `${p.committed === false
        ? '<p class="ok">Task completed.</p><p class="ko">The git commit failed: see the notification or the Output panel.</p>'
        : '<p class="ok">Task completed and saved to git.</p>'}${next ? button('select', `Go to ${next.id} · ${next.title}`, `data-id="${next.id}"`) : '<p>Path finished. Congratulations!</p>'}`
    : '<p class="ko">Not yet. Read the error above: it says what\'s missing.</p>';
  return `<h3>Verification</h3>${rows}${footer}`;
}

function tutorSection(t: Task, p: Page) {
  if (!p.ai) return `<h3>AI tutor</h3><p class="muted">Connect Claude, Ollama or another provider to ask questions and get reviews.</p>${button('configure', 'Configure AI', 'class="secondary"')}`;
  const who = { student: 'You', tutor: 'Tutor', review: 'Review' };
  const failed = p.results?.some(r => !r.ok);
  const done = statusOf(t, p.progress) === 'done';
  return `
    <h3>AI tutor</h3>
    ${p.chat.map(m => `<div class="msg ${m.role}"><b>${who[m.role]}</b>${m.html}</div>`).join('')}
    ${p.thinking ? '<p class="muted">The tutor is thinking…</p>' : ''}
    <textarea id="question" rows="3" placeholder="Ask a question about the task (Ctrl+Enter to send)">${esc(p.draft ?? '')}</textarea>
    <div class="actions">
      ${button('ask', 'Ask', p.thinking ? 'disabled' : '')}
      ${failed ? button('explain', 'Explain the error', `class="secondary" ${p.thinking ? 'disabled' : ''}`) : ''}
      ${done ? button('review', 'Ask for a review', `class="secondary" ${p.thinking ? 'disabled' : ''}`) : ''}
      ${p.milestoneDone ? button('reviewMilestone', `Review the milestone "${p.milestoneDone}"`, `class="secondary" ${p.thinking ? 'disabled' : ''}`) : ''}
    </div>`;
}

function taskDetail(t: Task, p: Page, b: Backlog) {
  const status = statusOf(t, p.progress);
  const shown = p.hintsHtml.length;
  const theory = p.guidance === 'guided'
    ? `<div class="theory">${p.theoryHtml}</div>`
    : `<details><summary>Theory</summary><div class="theory">${p.theoryHtml}</div></details>`;
  const files = (t.files ?? []).filter(f => !f.given)
    .map(f => `<li><a href="#" data-type="open" data-path="${esc(f.path)}">${esc(f.path)}</a></li>`).join('');
  const hints = p.guidance === 'autonomous' ? '' : `
    <h3>Hints</h3>
    ${p.hintsHtml.map((h, i) => `<div class="hint"><b>${i + 1}.</b> ${h}</div>`).join('')}
    ${shown < t.hints.length ? button('hint', `Hint ${shown + 1} of ${t.hints.length}${shown === t.hints.length - 1 ? ' (solution)' : ''}`, 'class="secondary"') : ''}`;
  const review = t.review?.length
    ? `<h3>What the review will look at</h3><ul>${t.review.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
  // at every guidance level: searching on your own is exactly the skill to train
  const search = t.search?.length
    ? `<p class="search"><b>To dig deeper:</b> ${t.search.map(q => `<a href="#" data-type="search" data-q="${esc(q)}" title="Search the web">${esc(q)}</a>`).join(' · ')}</p>` : '';
  return `
    <h2>${esc(t.id)} · ${esc(t.title)} ${status === 'done' ? '<span class="ok">✓</span>' : ''}</h2>
    <p class="goal"><b>Goal:</b> ${esc(t.goal)}</p>
    ${theory}
    ${search}
    ${files ? `<h3>Your files</h3><ul class="files">${files}</ul>` : ''}
    <div class="actions">${button('start', 'Prepare and open the files', 'class="secondary"')} ${button('verify', 'Verify', p.busy ? 'disabled' : '')}</div>
    ${results(p, b)}
    ${hints}
    ${tutorSection(t, p)}
    ${review}`;
}

export function renderPage(p: Page): string {
  const b = p.backlog;
  const body = !b ? welcome(p) : `
    <header>
      <h1>${esc(b.title)}</h1>
      <progress max="${b.tasks.length}" value="${p.progress.done.length}"></progress>
      <span class="muted">${p.progress.done.length}/${b.tasks.length} task</span>
      <div class="muted">${p.ai ? `<a href="#" data-type="configure" title="Change provider, model or key">AI: ${esc(p.ai)}</a>` : `<a href="#" data-type="configure">Configure AI</a>`}</div>
      ${p.canVerifyBacklog ? '<div class="muted"><a href="#" data-type="verifyBacklog" title="Every check must fail before the work and pass with the solution">Verify the path checks</a></div>' : ''}
      <label class="muted">Guidance
        <select data-type="guidance">
          ${(['guided', 'hints', 'autonomous'] as const).map(g => `<option ${g === p.guidance ? 'selected' : ''}>${g}</option>`).join('')}
        </select>
      </label>
    </header>
    ${b.conventions?.length ? `<details class="list"><summary>Project rules (${b.conventions.length})</summary><ul>${b.conventions.map(c => `<li>${esc(c)}</li>`).join('')}</ul></details>` : ''}
    <details class="list" id="path"><summary>Path</summary>${taskList(b, p)}</details>
    ${p.task ? taskDetail(p.task, p, b) : '<p>No task available.</p>'}`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${p.cspSource} https: data:; style-src ${p.cspSource} 'unsafe-inline'; script-src 'nonce-${p.nonce}';">
<style>
  body { color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 0 12px 24px; line-height: 1.5; }
  h1 { font-size: 1.2em; margin: 12px 0 4px; } h2 { font-size: 1.1em; margin: 16px 0 4px; } h3 { font-size: 1em; margin: 14px 0 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; font: inherit; margin: 2px 0; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, var(--vscode-focusBorder))); }
  button:disabled { opacity: .5; cursor: default; }
  ul.tasks { list-style: none; padding: 0; margin: 0; }
  button.task { background: none; color: inherit; width: 100%; text-align: left; padding: 2px 4px; }
  button.task.current { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .done .icon, .ok { color: var(--vscode-testing-iconPassed); } .ko { color: var(--vscode-testing-iconFailed); }
  .muted { color: var(--vscode-descriptionForeground); }
  .goal, .hint { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); padding: 6px 8px; }
  .mode { border-left: 3px solid var(--vscode-textBlockQuote-border); padding: 2px 10px 6px; margin: 12px 0; }
  .hint { margin: 6px 0; } .hint > p:first-of-type { display: inline; }
  .tips { border-left: 3px solid var(--vscode-editorWarning-foreground); padding: 4px 8px; margin: 6px 0; } .tips ul { margin: 4px 0; padding-left: 18px; }
  .error { border-left: 3px solid var(--vscode-inputValidation-errorBorder); padding: 4px 8px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 6px; overflow-x: auto; white-space: pre-wrap; font-size: .9em; }
  .check pre { max-height: 220px; overflow-y: auto; }
  code { font-family: var(--vscode-editor-font-family); }
  .actions { margin: 12px 0; }
  progress { width: 100%; } select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); }
  a { color: var(--vscode-textLink-foreground); }
  .files a { overflow-wrap: anywhere; }   /* long Java paths have no spaces to wrap at */
  textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font: inherit; padding: 4px; }
  .msg { margin: 6px 0; padding: 4px 8px; border-left: 3px solid var(--vscode-textBlockQuote-border); }
  .msg.student { border-color: var(--vscode-button-background); } .msg.review { border-color: var(--vscode-testing-iconPassed); }
  .msg > b { display: block; font-size: .85em; color: var(--vscode-descriptionForeground); }
</style></head>
<body>${body}
<script nonce="${p.nonce}">
  const vscode = acquireVsCodeApi();
  // the test summary is at the bottom of the output
  document.querySelectorAll('.check pre').forEach(p => { p.scrollTop = p.scrollHeight; });
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-type]');
    if (!el || el.tagName === 'SELECT') return;
    e.preventDefault();
    send(el.dataset.type, el.dataset);
  });
  const question = document.getElementById('question');
  function send(type, data = {}) {
    const text = type === 'ask' && question ? question.value : undefined;
    // Ctrl+Enter bypasses the disabled button: while the tutor thinks, the question would be lost
    if (type === 'ask') { if (!text || !text.trim() || document.querySelector('button[data-type="ask"]:disabled')) return; vscode.setState({ ...vscode.getState(), draft: '' }); }
    vscode.postMessage({ type, id: data.id, path: data.path, q: data.q, text, preset: data.preset });
  }
  // the question draft survives panel updates
  if (question) {
    question.value = (vscode.getState() || {}).draft || question.value;
    question.addEventListener('input', () => vscode.setState({ ...vscode.getState(), draft: question.value }));
    question.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) send('ask'); });
  }
  document.addEventListener('change', e => {
    if (e.target.dataset.type === 'guidance') vscode.postMessage({ type: 'guidance', value: e.target.value });
  });
  // the path list stays open or closed across panel updates, as the user left it
  const pathList = document.getElementById('path');
  if (pathList) {
    pathList.open = !!(vscode.getState() || {}).pathOpen;
    pathList.addEventListener('toggle', () => vscode.setState({ ...vscode.getState(), pathOpen: pathList.open }));
  }
  // remember the scroll between page updates
  const state = vscode.getState() || {};
  if (state.scroll) window.scrollTo(0, state.scroll);
  // a new answer arrived: show it, instead of leaving it below the fold
  const msgs = document.querySelectorAll('.msg');
  if (msgs.length > (state.msgs ?? msgs.length)) msgs[msgs.length - 1].scrollIntoView({ block: 'start' });
  vscode.setState({ ...vscode.getState(), msgs: msgs.length });
  window.addEventListener('scroll', () => vscode.setState({ ...vscode.getState(), scroll: window.scrollY }));
</script>
</body></html>`;
}
