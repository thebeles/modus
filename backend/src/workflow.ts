import { AppealStatus, ImprovementStatus, ProblemStatus } from '@prisma/client';

export const appealTransitions: Record<AppealStatus, readonly AppealStatus[]> = {
  NEW: ['REVIEW', 'WITHDRAWN'], REVIEW: ['WAITING_AUTHOR', 'IN_PROGRESS', 'CLOSED', 'WITHDRAWN'],
  WAITING_AUTHOR: ['REVIEW', 'IN_PROGRESS', 'CLOSED', 'WITHDRAWN'],
  IN_PROGRESS: ['WAITING_AUTHOR', 'REVIEW', 'CLOSED', 'WITHDRAWN'], CLOSED: ['REVIEW'], WITHDRAWN: ['REVIEW'],
};
export const problemTransitions: Record<ProblemStatus, readonly ProblemStatus[]> = {
  CANDIDATE: ['INVESTIGATING'], INVESTIGATING: ['CONFIRMED', 'DISPROVED', 'CLOSED'],
  CONFIRMED: ['CLOSED'], DISPROVED: ['CLOSED'], CLOSED: ['INVESTIGATING'],
};
export const improvementTransitions: Record<ImprovementStatus, readonly ImprovementStatus[]> = {
  DRAFT: ['UNDER_REVIEW', 'CANCELED'], UNDER_REVIEW: ['APPROVED', 'DEFERRED', 'REJECTED', 'DRAFT'],
  APPROVED: ['IN_PROGRESS', 'DEFERRED', 'CANCELED'], DEFERRED: ['UNDER_REVIEW', 'CANCELED'],
  IN_PROGRESS: ['IMPLEMENTED', 'DEFERRED', 'CANCELED'], IMPLEMENTED: ['VERIFYING', 'IN_PROGRESS'],
  VERIFYING: ['COMPLETED', 'IN_PROGRESS'], COMPLETED: [], REJECTED: [], CANCELED: [],
};
export const activeAppeal = (status: AppealStatus) => status !== 'CLOSED' && status !== 'WITHDRAWN';

export function businessDeadline(start: Date, hours: number, timeZone = process.env.APP_TIMEZONE || 'Asia/Almaty') {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  let current = start.getTime();
  let remaining = hours * 3600000;
  while (remaining > 0) {
    const fields = Object.fromEntries(formatter.formatToParts(current).map(part => [part.type, part.value]));
    const hour = Number(fields.hour);
    const minute = Number(fields.minute);
    const working = fields.weekday !== 'Sat' && fields.weekday !== 'Sun' && hour >= 9 && hour < 18;
    const untilNextHour = (60 - minute) * 60000 - ((current % 60000) + 60000) % 60000;
    const step = working ? Math.min(remaining, untilNextHour) : untilNextHour;
    current += step;
    if (working) remaining -= step;
  }
  return new Date(current);
}
