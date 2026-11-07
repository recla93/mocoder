import type { Backlog, Task } from './backlog.ts';
import type { Progress } from './workspace.ts';

export type TaskStatus = 'done' | 'available' | 'locked';

export function statusOf(task: Task, p: Progress): TaskStatus {
  if (p.done.includes(task.id)) return 'done';
  return (task.depends_on ?? []).every(d => p.done.includes(d)) ? 'available' : 'locked';
}

export const nextTask = (b: Backlog, p: Progress) => b.tasks.find(t => statusOf(t, p) === 'available');

/** Milestone appena completata da questo task, se c'è: momento di review e retrospettiva. */
export function completedMilestone(b: Backlog, p: Progress, task: Task) {
  const all = b.tasks.filter(t => t.milestone === task.milestone);
  return all.every(t => p.done.includes(t.id)) ? b.milestones.find(m => m.id === task.milestone) : undefined;
}
