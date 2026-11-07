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
  theoryHtml: string;       // markdown già renderizzato da VS Code
  hintsHtml: string[];
  guidance: Guidance;
  results?: CheckResult[];
  busy: boolean;
  ai?: string;              // modello e consumo, se l'IA è configurata
  canVerifyBacklog: boolean; // c'è una soluzione di riferimento: i controlli si possono verificare
  chat: { role: 'student' | 'tutor' | 'review'; html: string }[];
  thinking: boolean;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Testo sicuro con i `frammenti` resi come codice. */
const inlineCode = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const button = (type: string, label: string, attrs = '') => `<button data-type="${type}" ${attrs}>${esc(label)}</button>`;

const ICON = { done: '✓', available: '●', locked: '○' };

function welcome(p: Page) {
  if (!p.hasFolder) return '<p>Apri una cartella (anche vuota) per iniziare un progetto.</p>';
  const errors = p.errors.length
    ? `<div class="error"><b>Il backlog non è valido:</b><ul>${p.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  return `${errors}
    <h2>Nuovo progetto</h2>
    <ol>
      <li>Descrivi la tua idea: mocoder prepara il prompt per il tuo LLM.</li>
      <li>Incolla il prompt nel tuo LLM (Claude, ChatGPT, locale…) e copia tutta la risposta.</li>
      <li>Importala: mocoder la valida e ti guida task dopo task.</li>
    </ol>
    ${button('prompt', '1. Crea il prompt', 'class="secondary"')} ${button('import', '3. Importa la risposta', 'class="secondary"')}
    <h3>Oppure con l'IA configurata in mocoder</h3>
    ${p.ai ? button('plan', "Crea il percorso con l'IA") : button('configure', "Configura l'IA", 'class="secondary"')}`;
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
  if (p.busy) return '<p class="muted">Verifica in corso…</p>';
  if (!p.results) return '';
  const rows = p.results.map(r => {
    const d = diagnose(r.output);
    const count = d.tests ? `<span class="muted"> · ${d.tests.passed} test su ${d.tests.passed + d.tests.failed} passano</span>` : '';
    // consigli offline ricavati dall'output: niente IA, niente rete
    const tips = !r.ok && d.tips.length
      ? `<div class="tips"><b>Cosa dice l'errore</b><ul>${d.tips.map(t => `<li><b>${esc(t.title)}</b>: ${inlineCode(t.text)}</li>`).join('')}</ul></div>`
      : '';
    return `
    ${tips}
    <details class="check ${r.ok ? 'ok' : 'ko'}" ${r.ok || tips ? '' : 'open'}>
      <summary>${r.ok ? '✓' : '✗'} <code>${esc(r.check.run)}</code>${count}</summary>
      <pre>${esc(r.output.trim() || '(nessun output)')}</pre>
    </details>`;
  }).join('');
  const allOk = p.results.every(r => r.ok);
  const next = allOk ? nextTask(b, p.progress) : undefined;
  const footer = allOk
    ? `<p class="ok">Task completato e salvato in git.</p>${next ? button('select', `Vai a ${next.id} · ${next.title}`, `data-id="${next.id}"`) : '<p>Percorso finito. Complimenti!</p>'}`
    : '<p class="ko">Non ancora. Leggi l\'errore qui sopra: dice cosa manca.</p>';
  return `<h3>Verifica</h3>${rows}${footer}`;
}

function tutorSection(t: Task, p: Page) {
  if (!p.ai) return `<h3>Tutor IA</h3><p class="muted">Collega Claude, Ollama o un altro provider per fare domande e ricevere review.</p>${button('configure', "Configura l'IA", 'class="secondary"')}`;
  const who = { student: 'Tu', tutor: 'Tutor', review: 'Review' };
  const failed = p.results?.some(r => !r.ok);
  const done = statusOf(t, p.progress) === 'done';
  return `
    <h3>Tutor IA</h3>
    ${p.chat.map(m => `<div class="msg ${m.role}"><b>${who[m.role]}</b>${m.html}</div>`).join('')}
    ${p.thinking ? '<p class="muted">Il tutor sta pensando…</p>' : ''}
    <textarea id="question" rows="3" placeholder="Fai una domanda sul task (Ctrl+Invio per inviare)"></textarea>
    <div class="actions">
      ${button('ask', 'Chiedi', p.thinking ? 'disabled' : '')}
      ${failed ? button('explain', "Spiegami l'errore", `class="secondary" ${p.thinking ? 'disabled' : ''}`) : ''}
      ${done ? button('review', 'Chiedi una review', `class="secondary" ${p.thinking ? 'disabled' : ''}`) : ''}
    </div>`;
}

function taskDetail(t: Task, p: Page, b: Backlog) {
  const status = statusOf(t, p.progress);
  const shown = p.hintsHtml.length;
  const theory = p.guidance === 'guidato'
    ? `<div class="theory">${p.theoryHtml}</div>`
    : `<details><summary>Teoria</summary><div class="theory">${p.theoryHtml}</div></details>`;
  const files = (t.files ?? []).filter(f => !f.given)
    .map(f => `<li><a href="#" data-type="open" data-path="${esc(f.path)}">${esc(f.path)}</a></li>`).join('');
  const hints = p.guidance === 'autonomo' ? '' : `
    <h3>Suggerimenti</h3>
    ${p.hintsHtml.map((h, i) => `<div class="hint"><b>${i + 1}.</b> ${h}</div>`).join('')}
    ${shown < t.hints.length ? button('hint', `Suggerimento ${shown + 1} di ${t.hints.length}${shown === t.hints.length - 1 ? ' (soluzione)' : ''}`, 'class="secondary"') : ''}`;
  const review = t.review?.length
    ? `<h3>Cosa guarderà la review</h3><ul>${t.review.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
  // a ogni livello di guida: cercare da soli è proprio la competenza da allenare
  const search = t.search?.length
    ? `<p class="search"><b>Per approfondire:</b> ${t.search.map(q => `<a href="#" data-type="search" data-q="${esc(q)}" title="Cerca sul web">${esc(q)}</a>`).join(' · ')}</p>` : '';
  return `
    <h2>${esc(t.id)} · ${esc(t.title)} ${status === 'done' ? '<span class="ok">✓</span>' : ''}</h2>
    <p class="goal"><b>Obiettivo:</b> ${esc(t.goal)}</p>
    ${theory}
    ${search}
    ${files ? `<h3>I tuoi file</h3><ul>${files}</ul>` : ''}
    <div class="actions">${button('start', 'Prepara e apri i file', 'class="secondary"')} ${button('verify', 'Verifica', p.busy ? 'disabled' : '')}</div>
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
      <div class="muted">${p.ai ? `IA: ${esc(p.ai)}` : `<a href="#" data-type="configure">Configura l'IA</a>`}</div>
      ${p.canVerifyBacklog ? '<div class="muted"><a href="#" data-type="verifyBacklog" title="Ogni controllo deve fallire prima del lavoro e passare con la soluzione">Verifica i controlli del percorso</a></div>' : ''}
      <label class="muted">Guida
        <select data-type="guidance">
          ${(['guidato', 'suggerimenti', 'autonomo'] as const).map(g => `<option ${g === p.guidance ? 'selected' : ''}>${g}</option>`).join('')}
        </select>
      </label>
    </header>
    ${b.conventions?.length ? `<details class="list"><summary>Regole del progetto (${b.conventions.length})</summary><ul>${b.conventions.map(c => `<li>${esc(c)}</li>`).join('')}</ul></details>` : ''}
    <details class="list"><summary>Percorso</summary>${taskList(b, p)}</details>
    ${p.task ? taskDetail(p.task, p, b) : '<p>Nessun task disponibile.</p>'}`;

  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8">
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
  .hint { margin: 6px 0; } .hint > p:first-of-type { display: inline; }
  .tips { border-left: 3px solid var(--vscode-editorWarning-foreground); padding: 4px 8px; margin: 6px 0; } .tips ul { margin: 4px 0; padding-left: 18px; }
  .error { border-left: 3px solid var(--vscode-inputValidation-errorBorder); padding: 4px 8px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 6px; overflow-x: auto; white-space: pre-wrap; font-size: .9em; }
  .check pre { max-height: 220px; overflow-y: auto; }
  code { font-family: var(--vscode-editor-font-family); }
  .actions { margin: 12px 0; }
  progress { width: 100%; } select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); }
  a { color: var(--vscode-textLink-foreground); }
  textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font: inherit; padding: 4px; }
  .msg { margin: 6px 0; padding: 4px 8px; border-left: 3px solid var(--vscode-textBlockQuote-border); }
  .msg.student { border-color: var(--vscode-button-background); } .msg.review { border-color: var(--vscode-testing-iconPassed); }
  .msg > b { display: block; font-size: .85em; color: var(--vscode-descriptionForeground); }
</style></head>
<body>${body}
<script nonce="${p.nonce}">
  const vscode = acquireVsCodeApi();
  // il riassunto dei test sta in fondo all'output
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
    if (type === 'ask') { if (!text || !text.trim()) return; vscode.setState({ ...vscode.getState(), draft: '' }); }
    vscode.postMessage({ type, id: data.id, path: data.path, q: data.q, text });
  }
  // la bozza della domanda sopravvive agli aggiornamenti del pannello
  if (question) {
    question.value = (vscode.getState() || {}).draft || '';
    question.addEventListener('input', () => vscode.setState({ ...vscode.getState(), draft: question.value }));
    question.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) send('ask'); });
  }
  document.addEventListener('change', e => {
    if (e.target.dataset.type === 'guidance') vscode.postMessage({ type: 'guidance', value: e.target.value });
  });
  // ricorda lo scroll tra un aggiornamento e l'altro della pagina
  const state = vscode.getState() || {};
  if (state.scroll) window.scrollTo(0, state.scroll);
  window.addEventListener('scroll', () => vscode.setState({ ...vscode.getState(), scroll: window.scrollY }));
</script>
</body></html>`;
}
