import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { Task, SolutionFile } from './backlog.ts';

export const DIR = '.mocoder';
export const BACKLOG = `${DIR}/backlog.yaml`;
export const SOLUTION = `${DIR}/solution.yaml`;
export const PROGRESS = `${DIR}/progress.json`;

/** Percorso assoluto dentro root; lancia se esce dal progetto (difesa oltre allo schema). */
export function inside(root: string, rel: string): string {
  const abs = resolve(root, rel);
  const r = relative(resolve(root), abs);
  if (!r || r.startsWith('..') || isAbsolute(r)) throw new Error(`percorso fuori dal progetto: ${rel}`);
  return abs;
}

function write(root: string, rel: string, content: string) {
  const abs = inside(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/**
 * Prepara i file del task: quelli forniti vengono (ri)scritti, quelli dell'utente
 * creati solo se mancano (con lo scheletro se withSkeleton). Restituisce i file dell'utente.
 */
export function prepareTask(root: string, task: Task, withSkeleton: boolean): string[] {
  const editable: string[] = [];
  for (const f of task.files ?? []) {
    if (f.given) {
      write(root, f.path, f.content!);
    } else {
      if (!existsSync(inside(root, f.path))) write(root, f.path, withSkeleton ? f.content ?? '' : '');
      editable.push(f.path);
    }
  }
  return editable;
}

export function applySolution(root: string, files: SolutionFile[]) {
  for (const f of files) write(root, f.path, f.content);
}

export interface Progress { done: string[]; hints: Record<string, number> }

export function readProgress(root: string): Progress {
  try {
    const p = JSON.parse(readFileSync(join(root, PROGRESS), 'utf8'));
    return { done: Array.isArray(p.done) ? p.done : [], hints: p.hints ?? {} };
  } catch {
    return { done: [], hints: {} };
  }
}

export function writeProgress(root: string, p: Progress) {
  write(root, PROGRESS, JSON.stringify(p, null, 2) + '\n');
}
