import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { anthropic, openaiCompatible, withBudget, AiError, type ChatRequest, type Complete, type Usage } from './providers.ts';
import { plan, taskContext, mentorMessages, reviewMessages, promptBody, fill, fixUntilGreen, fixRequest, MAX_FIX_ROUNDS } from './roles.ts';
import { parseBacklog, parsePlannerAnswer } from '../core/backlog.ts';

/** Server finto: registra la richiesta e risponde con l'handler dato. */
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

test('anthropic: streaming, effort, fallback e usage', async () => {
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

test('anthropic: errore di autenticazione spiegato in italiano', async () => {
  const s = await fakeServer((_b, _r, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  });
  try {
    await assert.rejects(anthropic({ model: 'claude-opus-5-5', apiKey: 'x', baseURL: s.url })(req), (e: Error) => e instanceof AiError && /Chiave API/.test(e.message));
  } finally {
    s.close();
  }
});

test('openai-compatibile: streaming, usage, troncamento ed errori', async () => {
  const chunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
  let finish = 'stop';
  const s = await fakeServer((body, _r, res) => {
    if (body.model === 'nessuno') { res.writeHead(404); res.end('not found'); return; }
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
    await assert.rejects(openaiCompatible({ baseUrl: s.url, model: 'gemma' })(req), /troncata/);
    await assert.rejects(openaiCompatible({ baseUrl: s.url, model: 'nessuno' })(req), /non trovato/);
  } finally {
    s.close();
  }
});

test('budget: conta per mese e blocca oltre il limite', async () => {
  let usage: Usage | undefined;
  const store = { get: () => usage, set: (u: Usage) => (usage = u) };
  const fake: Complete = async () => ({ text: '', inputTokens: 60, outputTokens: 40 });
  let month = '2026-11-07T10:00:00Z';
  const c = withBudget(fake, store, () => 150, () => new Date(month));
  await c(req);
  assert.deepEqual(usage, { month: '2026-11', tokens: 100 });
  await c(req);                                     // 100 < 150: passa, arriva a 200
  await assert.rejects(c(req), /Budget mensile/);
  month = '2026-12-01T10:00:00Z';                   // mese nuovo: si riparte
  await c(req);
  assert.deepEqual(usage, { month: '2026-12', tokens: 100 });
});

const examples = join(import.meta.dirname, '../../../examples/analisi-spese/.mocoder');
const backlogText = readFileSync(join(examples, 'backlog.yaml'), 'utf8');
const solutionText = readFileSync(join(examples, 'solution.yaml'), 'utf8');
const good = `## Fattibilità\nSì.\n\n\`\`\`yaml\n${backlogText}\`\`\`\n\n\`\`\`yaml\n${solutionText}\`\`\`\n`;

test('parsePlannerAnswer separa fattibilità, backlog e soluzione', () => {
  const a = parsePlannerAnswer(good);
  assert.deepEqual(a.errors, []);
  assert.equal(a.feasibility, '## Fattibilità\nSì.');
  assert.equal(a.backlog?.project, 'analisi-spese');
  assert.ok(a.solution?.tasks.T01);
});

test('plan: corregge un backlog invalido e si ferma se non è fattibile', async () => {
  const answers = ['```yaml\nproject: x\n```', good];
  const seen: ChatRequest[] = [];
  const fake: Complete = async r => { seen.push(structuredClone({ ...r, onText: undefined })); return { text: answers.shift()!, inputTokens: 0, outputTokens: 0 }; };
  const out = await plan(fake, 'idea');
  assert.equal(out.attempts, 2);
  assert.deepEqual(out.errors, []);
  assert.equal(seen[1].messages.length, 3);
  assert.match(seen[1].messages[2].content, /Correggi/);

  const no: Complete = async () => ({ text: '## Fattibilità\nNo: troppo grande. Alternative: ...', inputTokens: 0, outputTokens: 0 });
  const stop = await plan(no, 'idea');
  assert.equal(stop.attempts, 1);
  assert.equal(stop.backlog, undefined);

  let calls = 0;
  const bad: Complete = async () => { calls++; return { text: '```yaml\nproject: x\n```', inputTokens: 0, outputTokens: 0 }; };
  assert.ok((await plan(bad, 'idea')).errors.length);
  assert.equal(calls, 3);                           // 1 + 2 correzioni, poi si arrende
});

test('fixUntilGreen: rimanda al Planner il task che fallisce la verifica, poi si ferma', async () => {
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
  assert.equal(prompts.length, MAX_FIX_ROUNDS);   // non insiste all'infinito sullo stesso task

  // ogni correzione sistema un task e la verifica si sposta sul successivo: il limite è per task
  const moving = [failure, failure, { ...failure, taskId: 'T02' }, { ...failure, taskId: 'T03' }, null];
  const walked = await fixUntilGreen(fixer, start, async () => moving.shift()!);
  assert.equal(walked.failure, null);
  assert.equal(walked.rounds, 4);
  assert.match(fixRequest(backlogText, solutionText, { ...failure, kind: 'red' }), /PRIMA del lavoro/);
});

test('il Mentor non riceve la soluzione finché lo studente non l\'ha aperta', () => {
  const task = parseBacklog(backlogText).value!.tasks[0];
  const solution = task.hints.at(-1)!;
  assert.ok(!taskContext(task, 'guidato', 0, []).includes(solution));
  assert.ok(taskContext(task, 'guidato', task.hints.length, []).includes(solution));
  assert.ok(!taskContext(task, 'autonomo', task.hints.length, []).includes(task.hints[0]));
  const m = mentorMessages('CTX', [{ role: 'student', text: 'perché?' }, { role: 'tutor', text: 'pensa a X' }], 'e ora?');
  assert.equal(m.length, 1);
  assert.match(m[0].content, /CTX[\s\S]*perché\?[\s\S]*pensa a X[\s\S]*e ora\?/);
});

test('il Reviewer riceve le regole del progetto', () => {
  const b = parseBacklog(backlogText).value!;
  const [m] = reviewMessages([b.tasks[0]], [{ path: 'spese/load.py', content: 'x = 1' }], 'T01', b.conventions);
  assert.match(m.content, /### Regole del progetto[\s\S]*Decimal, mai float[\s\S]*### Task[\s\S]*### Codice/);
});

test('il prompt del Planner copre fondamenta, sicurezza e convenzioni', () => {
  const md = readFileSync(join(import.meta.dirname, '../../../prompts/planner.md'), 'utf8');
  for (const must of ['.gitignore', 'pom.xml', 'migrazioni', 'parametrizzate', 'segreti', '.env.example', 'hash', 'Conventional Commits', 'conventions', 'README'])
    assert.ok(md.includes(must), `manca: ${must}`);
});

test('prompt del Planner: corpo dopo --- e segnaposto riempiti', () => {
  const md = readFileSync(join(import.meta.dirname, '../../../prompts/planner.md'), 'utf8');
  const body = fill(promptBody(md), { idea: 'IDEA-X', schema: 'SCHEMA-Y' });
  assert.ok(!body.includes('Nell\'estensione'));
  assert.match(body, /IDEA-X/);
  assert.match(body, /SCHEMA-Y/);
  assert.ok(!/\{\{idea\}\}|\{\{schema\}\}/.test(body));
});
