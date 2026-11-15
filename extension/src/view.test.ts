import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage, type Page } from './view.ts';

const page = (over: Partial<Page> = {}): Page => ({
  cspSource: 'vscode-resource:',
  nonce: 'n',
  hasFolder: true,
  errors: [],
  progress: { done: [], hints: {} },
  theoryHtml: '',
  hintsHtml: [],
  guidance: 'guided',
  busy: false,
  canVerifyBacklog: false,
  chat: [],
  thinking: false,
  ...over,
});

test('without AI the page offers the three paths, each with its action', () => {
  const html = renderPage(page());
  assert.match(html, /Free, no account/);
  assert.match(html, /data-type="prompt"/);
  assert.match(html, /data-type="import"/);
  assert.match(html, /data-preset="gemini"/);
  assert.match(html, /data-preset="deepseek"/);
});

test('with AI configured the page points to the path and not the three paths', () => {
  const html = renderPage(page({ ai: 'deepseek-flash · 1.2k tokens this month' }));
  assert.match(html, /AI ready: deepseek-flash/);
  assert.match(html, /data-type="plan"/);
  assert.match(html, /data-type="fallback"/);
  assert.doesNotMatch(html, /data-preset/);
});

test('the model name cannot inject HTML into the panel', () => {
  const html = renderPage(page({ ai: '<img src=x onerror=alert(1)>' }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('a failed commit is not reported as saved, and a failed question comes back escaped', () => {
  const backlog = {
    title: 'P', level: 'beginner', milestones: [{ id: 'M1', title: 'M', goal: 'g' }],
    tasks: [{ id: 'T01', milestone: 'M1', title: 'T', goal: 'g', theory: '', hints: [], checks: [{ run: 'x' }] }],
  } as unknown as NonNullable<Page['backlog']>;
  const results = [{ check: { run: 'x' }, ok: true, output: '' }];
  const base = { backlog, task: backlog.tasks[0], results, ai: 'm' };
  assert.match(renderPage(page({ ...base, committed: true })), /saved to git/);
  const failed = renderPage(page({ ...base, committed: false, draft: '</textarea><b>' }));
  assert.doesNotMatch(failed, /saved to git/);
  assert.match(failed, /git commit failed/);
  assert.match(failed, /&lt;\/textarea&gt;&lt;b&gt;<\/textarea>/);
});
