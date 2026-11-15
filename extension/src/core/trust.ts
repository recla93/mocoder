import { createHash } from 'node:crypto';
import type { Backlog } from './backlog.ts';

/**
 * A backlog's checks are commands run on the student's computer, and the backlog may
 * come from a chatbot. Running them requires the person's explicit approval.
 */

/** All distinct commands of the backlog, in the order they appear. */
export const commandsOf = (b: Backlog) => [...new Set(b.tasks.flatMap(t => t.checks.map(c => c.run)))];

/** Fingerprint of the set of commands: if even one changes, a new approval is needed. */
export const commandsHash = (commands: string[]) =>
  createHash('sha256').update(JSON.stringify([...commands].sort())).digest('hex');

// Just a visual aid, not a barrier: the real protection is the approval.
const SUSPICIOUS = [
  /\b(rm|rmdir|del|erase|rd|format|mkfs|dd|shutdown|reboot|reg|sudo|su|chmod|chown|kill|taskkill)\b/i,
  /\b(curl|wget|iwr|invoke-webrequest|invoke-expression|iex|certutil|bitsadmin|scp|ssh|nc|netcat|ftp)\b/i,
  /\b(powershell|pwsh)\b|\bcmd(\.exe)?\s+\/c\b|\b(ba)?sh\s+-c\b/i,
  /https?:\/\//i,
  /[|;&`<>]|\$\(/,               // chains, pipes and redirections: the schema asks for a single simple command
  /(^|\s)(~|\/|[a-z]:\\)/i,      // absolute or home paths: the checks work inside the project
];

export const suspicious = (command: string) => SUSPICIOUS.some(r => r.test(command));
