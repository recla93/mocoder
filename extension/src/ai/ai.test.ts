import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { anthropic, openaiCompatible, withBudget, isFreeModel, AiError, type ChatRequest, type Complete, type Usage } from './providers.ts';
import { plan, taskContext, mentorMessages, reviewMessages, promptBody, fill, fixUntilGreen, fixRequest, capFiles, MAX_FIX_ROUNDS, MAX_CONTEXT_CHARS } from './roles.ts';
import { parseBacklog, parsePlannerAnswer } from '../core/backlog.ts';

/** Fake server: records the request and replies with the given handler. */
async function fakeServer(handler: (body: any, req: IncomingMessage, res: ServerResponse) => void) {
  const seen: { body?: any; headers?: IncomingMessage['headers'] } = {};
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', d => (raw += d));
    req.on('end', () => {
      seen.body = JSON.parse(raw);
      seen.headers = req.headers;
      handler(seen.body, req, res);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => server.close() };
}

const sse = (res: ServerResponse, events: string[]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(e);
  res.end();
};

const req: ChatRequest = { system: 'sys', messages: [{ role: 'user', content: 'ciao' }], maxTokens: 1000, effort: 'low' };

test('anthropic: streaming, effort, fallback and usage', async () => {
  const s = await fakeServer((_body, _req, res) => {
    const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    sse(res, [
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Ciao ' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'studente' } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
      ev('message_stop', {}),
    ]);
  });
  try {
    const deltas: string[] = [];
    const r = await anthropic({ model: 'claude-opus-5-5', apiKey: 'test', baseURL: s.url })({ ...req, onText: d => deltas.push(d) });
    assert.equal(r.text, 'Ciao studente');
    assert.deepEqual(deltas, ['Ciao ', 'studente']);
    assert.equal(r.inputTokens, 10);
    assert.equal(r.outputTokens, 5);
    assert.equal(s.seen.body.model, 'claude-opus-5-5');
    assert.deepEqual(s.seen.body.output_config, { effort: 'low' });
    assert.equal(s.seen.body.fallbacks, 'default');
    assert.match(String(s.seen.headers!['anthropic-beta']), /server-side-fallback-2026-07-01/);
  } finally {
    s.close();
  }
});

test('anthropic: authentication error explained in English', async () => {
  const s = await fakeServer((_b, _r, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  });
  try {
    await assert.rejects(anthropic({ model: 'claude-opus-5-5', apiKey: 'x', baseURL: s.url })(req), (e: Error) => e instanceof AiError && /Invalid Anthropic API key/.test(e.message));
  } finally {
    s.close();
  }
});

test('openai-compatible: streaming, usage, truncation and errors', async () => {
  const chunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
  let finish = 'stop';
  const s = await fakeServer((body, _r, res) => {
    if (body.model === 'nessuno') { res.writeHead(404); res.end('not found'); return; }
    if (body.model === 'quota') { res.writeHead(429); res.end('rate limited'); return; }
    if (body.model === 'daily') { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Rate limit exceeded: free-models-per-day"}}'); return; }
    if (body.model === 'credito') { res.writeHead(402); res.end('payment required'); return; }
    if (body.model === 'muto') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(chunk({ choices: [{ delta: { content: 'Ri' } }] })); setTimeout(() => res.end(), 2000); return; }
    if (body.model === 'vuoto') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}'); return; }
    sse(res, [
      chunk({ choices: [{ delta: { content: 'Ri' } }] }),
      chunk({ choices: [{ delta: { content: 'sposta' }, finish_reason: finish }] }),
      chunk({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      'data: [DONE]\n\n',
    ]);
  });
  try {
    const ok = await openaiCompatible({ baseUrl: s.url + '/', model: 'gemma', apiKey: 'k' })(req);
    assert.deepEqual(ok, { text: 'Risposta', inputTokens: 7, outputTokens: 3 });
    assert.equal(s.seen.body.messages[0].role, 'system');
    assert.equal(s.seen.headers!.authorization, 'Bearer k');
    finish = 'length';
    await assert.rejects(openaiCompatible({ baseUrl: s.url, model: 'gemma' })(req), /truncated/);
    await assert.rejects(openaiCompatible({ baseUrl: s.url, model: 'nessuno' })(req), /not found/);
    // every provider failure must say what to do, not just that it happened
    await assert.rejects(openaiCompatible({ baseUrl: s.url, model: 'quota' })(req), /free plan/);
    // the provider's reason is shown: waiting a minute does not help with a daily cap
    await assert.rejects(openaiCompatible({ baseUrl: s.url, model: 'daily' })(req), /free plan.*Provider says: "Rate limit exceeded: free-models-per-day"/);
    await assert.rejects(openaiCompatible({ baseUrl: s.url, model: 'credito' })(req), /Credit exhausted/);
    await assert.rejects(openaiCompatible({ baseUrl: s.url, model: 'vuoto' })(req), /no text/);
    // a provider that goes silent mid-stream must not freeze the panel
    await assert.rejects(openaiCompatible({ baseUrl: s.url, model: 'muto', idleMs: 200 })(req),
      (e: Error) => e instanceof AiError && e.unavailable && /stopped answering/.test(e.message));
  } finally {
    s.close();
  }
});

test('free or local models recognized', () => {
  const free = (provider: string, baseUrl: string, model: string) => isFreeModel({ provider, baseUrl, model });
  assert.ok(free('openai', 'http://localhost:11434/v1', 'gemma4:latest'));
  assert.ok(free('openai', 'http://localhost:11434/v1', 'gemma4:31b-cloud'));
  assert.ok(free('openai', 'https://openrouter.ai/api/v1', 'google/gemma-4-31b-it:free'));
  assert.ok(!free('openai', 'https://api.openai.com/v1', 'gpt-5.5'));
  assert.ok(!free('anthropic', '', 'claude-opus-5-5'));
});

test('budget: counts per month and blocks over the limit', async () => {
  let usage: Usage | undefined;
  const store = { get: () => usage, set: (u: Usage) => (usage = u) };
  const fake: Complete = async () => ({ text: '', inputTokens: 60, outputTokens: 40 });
  let month = '2026-11-07T10:00:00Z';
  const c = withBudget(fake, store, () => 150, () => new Date(month));
  await c(req);
  assert.deepEqual(usage, { month: '2026-11', tokens: 100 });
  await c(req);                                     // 100 < 150: passes, reaches 200
  await assert.rejects(c(req), /Monthly token budget/);
  month = '2026-12-01T10:00:00Z';                   // new month: starts over
  await c(req);
  assert.deepEqual(usage, { month: '2026-12', tokens: 100 });
});

const examples = join(import.meta.dirname, '../../../examples/analisi-spese/.mocoder');
const backlogText = readFileSync(join(examples, 'backlog.yaml'), 'utf8');
const solutionText = readFileSync(join(examples, 'solution.yaml'), 'utf8');
const good = `## Fattibilità\nSì.\n\n\`\`\`yaml\n${backlogText}\`\`\`\n\n\`\`\`yaml\n${solutionText}\`\`\`\n`;

test('parsePlannerAnswer separates feasibility, backlog and solution', () => {
  const a = parsePlannerAnswer(good);
  assert.deepEqual(a.errors, []);
  assert.equal(a.feasibility, '## Fattibilità\nSì.');
  assert.equal(a.backlog?.project, 'analisi-spese');
  assert.ok(a.solution?.tasks.T01);
});

test('plan: fixes an invalid backlog and stops if not feasible', async () => {
  const answers = ['```yaml\nproject: x\n```', good];
  const seen: ChatRequest[] = [];
  const fake: Complete = async r => { seen.push(structuredClone({ ...r, onText: undefined })); return { text: answers.shift()!, inputTokens: 0, outputTokens: 0 }; };
  const out = await plan(fake, 'idea');
  assert.equal(out.attempts, 2);
  assert.deepEqual(out.errors, []);
  assert.equal(seen[1].messages.length, 3);
  assert.match(seen[1].messages[2].content, /Fix/);

  // the repair answer is YAML only: the feasibility of the first answer is kept
  const repaired = ['## Fattibilità\nSì, ridotta.\n\n```yaml\nproject: x\n```', good.slice(good.indexOf('```yaml'))];
  const kept = await plan(async () => ({ text: repaired.shift()!, inputTokens: 0, outputTokens: 0 }), 'idea');
  assert.equal(kept.attempts, 2);
  assert.equal(kept.feasibility, '## Fattibilità\nSì, ridotta.');

  const no: Complete = async () => ({ text: '## Fattibilità\nNo: troppo grande. Alternative: ...', inputTokens: 0, outputTokens: 0 });
  const stop = await plan(no, 'idea');
  assert.equal(stop.attempts, 1);
  assert.equal(stop.backlog, undefined);

  let calls = 0;
  const bad: Complete = async () => { calls++; return { text: '```yaml\nproject: x\n```', inputTokens: 0, outputTokens: 0 }; };
  assert.ok((await plan(bad, 'idea')).errors.length);
  assert.equal(calls, 3);                           // 1 + 2 fixes, then it gives up
});

test('fixUntilGreen: sends the failing task back to the Planner, then stops', async () => {
  const start = { backlogText, solutionText };
  const failure = { taskId: 'T01', kind: 'green' as const, output: 'E   assert False' };
  const prompts: string[] = [];
  const fixer: Complete = async r => { prompts.push(r.messages[0].content); return { text: good, inputTokens: 0, outputTokens: 0 }; };

  const verdicts = [failure, null];
  const ok = await fixUntilGreen(fixer, start, async () => verdicts.shift()!);
  assert.equal(ok.failure, null);
  assert.equal(ok.rounds, 1);
  assert.match(prompts[0], /Task T01[\s\S]*assert False[\s\S]*project: analisi-spese[\s\S]*tasks:/);

  prompts.length = 0;
  const stuck = await fixUntilGreen(fixer, start, async () => failure);
  assert.deepEqual(stuck.failure, failure);
  assert.equal(stuck.rounds, MAX_FIX_ROUNDS);
  assert.equal(prompts.length, MAX_FIX_ROUNDS);   // does not insist forever on the same task

  // each fix resolves one task and verification moves to the next: the limit is per task
  const moving = [failure, failure, { ...failure, taskId: 'T02' }, { ...failure, taskId: 'T03' }, null];
  const walked = await fixUntilGreen(fixer, start, async () => moving.shift()!);
  assert.equal(walked.failure, null);
  assert.equal(walked.rounds, 4);
  assert.match(fixRequest(backlogText, solutionText, { ...failure, kind: 'red' }), /BEFORE the student's work/);
});

test('capFiles: the context has a cap, truncates and says what it did not send', () => {
  const files = [{ path: 'a.py', content: 'x'.repeat(40) }, { path: 'b.py', content: 'y'.repeat(40) }];
  assert.deepEqual(capFiles(files, 100), files);            // they all fit

  const cut = capFiles([...files, { path: 'c.py', content: 'z'.repeat(40) }], 60);
  assert.equal(cut[0].content, 'x'.repeat(40));             // the first fits whole
  assert.equal(cut[1].content, 'y'.repeat(20) + '\n\n[…truncated: 20 of 40 characters]');
  assert.equal(cut[2].content, undefined);                  // the third does not fit: visible from the missing content

  const big = capFiles([{ path: 'a.py', content: 'x'.repeat(MAX_CONTEXT_CHARS + 1) }]);
  assert.match(big[0].content!, /truncated: 1 of \d+ characters/);
});

test('the Mentor does not receive the solution until the student opens it', () => {
  const task = parseBacklog(backlogText).value!.tasks[0];
  const solution = task.hints.at(-1)!;
  assert.ok(!taskContext(task, 'guided', 0, []).includes(solution));
  assert.ok(taskContext(task, 'guided', task.hints.length, []).includes(solution));
  assert.ok(!taskContext(task, 'autonomous', task.hints.length, []).includes(task.hints[0]));
  const m = mentorMessages('CTX', [{ role: 'student', text: 'perché?' }, { role: 'tutor', text: 'pensa a X' }], 'e ora?');
  assert.equal(m.length, 1);
  assert.match(m[0].content, /CTX[\s\S]*perché\?[\s\S]*pensa a X[\s\S]*e ora\?/);
});

test('the Reviewer receives the project rules', () => {
  const b = parseBacklog(backlogText).value!;
  const [m] = reviewMessages([b.tasks[0]], [{ path: 'spese/load.py', content: 'x = 1' }], 'T01', b.conventions);
  assert.match(m.content, /### Project rules[\s\S]*Decimal, mai float[\s\S]*### Task[\s\S]*### Code/);
});

test('the Planner prompt covers foundations, security and conventions', () => {
  const md = readFileSync(join(import.meta.dirname, '../../../prompts/planner.md'), 'utf8');
  for (const must of ['.gitignore', 'pom.xml', 'migrations', 'parameterized', 'secrets', '.env.example', 'hash', 'Conventional Commits', 'conventions', 'README', 'archetype:generate', 'One of its hints', 'never depend on what a generator produces'])
    assert.ok(md.includes(must), `missing: ${must}`);
});

test('Planner prompt: body after --- and placeholders filled', () => {
  const md = readFileSync(join(import.meta.dirname, '../../../prompts/planner.md'), 'utf8');
  const body = fill(promptBody(md), { idea: 'IDEA-X', schema: 'SCHEMA-Y' });
  assert.ok(!body.includes('In the extension'));
  assert.match(body, /IDEA-X/);
  assert.match(body, /SCHEMA-Y/);
  assert.ok(!/\{\{idea\}\}|\{\{schema\}\}/.test(body));
  // weak models forget what came before the long schema: idea and stack are repeated after it
  const tail = body.slice(body.lastIndexOf('SCHEMA-Y'));
  assert.match(tail, /IDEA-X/);
  assert.match(tail, /Technologies:/);
});
