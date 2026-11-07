import { createHash } from 'node:crypto';
import type { Backlog } from './backlog.ts';

/**
 * I controlli di un backlog sono comandi eseguiti sul computer dello studente, e il backlog può
 * arrivare da un chatbot. Prima di eseguirli serve un'approvazione esplicita della persona.
 */

/** Tutti i comandi distinti del backlog, nell'ordine in cui compaiono. */
export const commandsOf = (b: Backlog) => [...new Set(b.tasks.flatMap(t => t.checks.map(c => c.run)))];

/** Impronta dell'insieme di comandi: se ne cambia anche uno solo, serve una nuova approvazione. */
export const commandsHash = (commands: string[]) =>
  createHash('sha256').update(JSON.stringify([...commands].sort())).digest('hex');

// Solo un aiuto per l'occhio, non una barriera: la protezione vera è l'approvazione.
const SUSPICIOUS = [
  /\b(rm|rmdir|del|erase|rd|format|mkfs|dd|shutdown|reboot|reg|sudo|su|chmod|chown|kill|taskkill)\b/i,
  /\b(curl|wget|iwr|invoke-webrequest|invoke-expression|iex|certutil|bitsadmin|scp|ssh|nc|netcat|ftp)\b/i,
  /\b(powershell|pwsh)\b|\bcmd(\.exe)?\s+\/c\b|\b(ba)?sh\s+-c\b/i,
  /https?:\/\//i,
  /[|;&`<>]|\$\(/,               // catene, pipe e redirezioni: lo schema chiede un solo comando semplice
  /(^|\s)(~|\/|[a-z]:\\)/i,      // percorsi assoluti o della home: i controlli lavorano nel progetto
];

export const suspicious = (command: string) => SUSPICIOUS.some(r => r.test(command));
