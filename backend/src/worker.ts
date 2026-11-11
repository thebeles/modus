import 'dotenv/config';
import { Appeal, OutboxJob, PrismaClient } from '@prisma/client';
import { atomic, audit, notify, Tx } from './common';
import { LocalStorage, purgeUploads } from './files';
import { Policy, Principal, principalSelect } from './policy';
import { activeAppeal, clarificationKey } from './workflow';

const policy = new Policy();
const storage = new LocalStorage();
const hour = 3600000;

function slaDeadline(item: Appeal, kind: string) {
  if (!activeAppeal(item.status) || item.status === 'WAITING_AUTHOR' || item.slaVersion === null) return null;
  if (kind.startsWith('FIRST_RESPONSE_')) return item.firstHumanResponseAt ? null : item.firstResponseDueAt;
  return item.dueAt;
}

async function canDeliver(tx: Tx, job: OutboxJob, user: Principal, now: Date) {
  if (!job.href) return true;
  const [, resource, id] = job.href.split('/');
  if (!id) return false;
  switch (resource) {
    case 'appeals': {
      const item = await tx.appeal.findFirst({
        where: { AND: [{ id }, { OR: [{ authorId: user.id }, policy.staffAppeals(user, true)] }] },
        include: { queue: { select: { coordinatorId: true } } },
      });
      if (!item) return false;
      if (job.kind === 'CLARIFICATION_REMINDER') {
        return item.authorId === user.id && item.status === 'WAITING_AUTHOR' &&
          !!item.waitingSince && job.key === clarificationKey(item.id, item.waitingSince);
      }
      if (/^(SLA|FIRST_RESPONSE)_(DUE|OVERDUE)$/.test(job.kind)) {
        const dueAt = slaDeadline(item, job.kind);
        return item.authorId !== user.id && (item.assigneeId ?? item.queue.coordinatorId) === user.id &&
          !!dueAt && dueAt.getTime() <= now.getTime() + hour &&
          job.key === `${item.id}:${job.kind}:${dueAt.toISOString()}:${user.id}`;
      }
      if (['ASSIGNED', 'CREATED', 'REROUTED', 'TRANSFER_RECEIVED'].includes(job.kind)) {
        return item.authorId === user.id || (activeAppeal(item.status) && (item.assigneeId ?? item.queue.coordinatorId) === user.id);
      }
      return true;
    }
    case 'improvements':
      return !!await tx.improvement.findFirst({ where: { AND: [{ id }, policy.improvements(user)] }, select: { id: true } });
    case 'changes':
      return !!await tx.publication.findFirst({ where: { AND: [{ id }, policy.publications(user)] }, select: { id: true } });
    case 'feedback':
      return !!await tx.feedback.findFirst({ where: { id, userId: user.id, improvement: { implementedAt: { not: null } } }, select: { id: true } });
    default:
      return false;
  }
}

const db = new PrismaClient();
let running = true;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { running = false; });

export async function deliver(client: PrismaClient, now = new Date()) {
  const jobs = await client.outboxJob.findMany({
    where: { deliveredAt: null, deadAt: null, discardedAt: null, availableAt: { lte: now } }, orderBy: { availableAt: 'asc' }, take: 50,
  });
  for (const job of jobs) {
    try {
      await atomic(client, async tx => {
        const claimed = await tx.outboxJob.updateMany({ where: { id: job.id, deliveredAt: null, deadAt: null, discardedAt: null, attempts: job.attempts },
          data: { deliveredAt: now } });
        if (!claimed.count) return;
        const recipient = await tx.user.findUnique({ where: { id: job.userId }, select: { ...principalSelect, active: true, notifyRegistration: true } });
        if (!recipient?.active || (job.kind === 'REGISTRATION_CONFIRMED' && !recipient.notifyRegistration) || !await canDeliver(tx, job, recipient, now)) {
          await tx.outboxJob.update({ where: { id: job.id }, data: { deliveredAt: null, discardedAt: now } });
          return;
        }
        await tx.notification.upsert({
          where: { key: job.key }, update: {},
          create: { key: job.key, userId: job.userId, kind: job.kind, href: job.href },
        });
      });
    } catch {
      const attempts = job.attempts + 1;
      await client.outboxJob.updateMany({ where: { id: job.id, deliveredAt: null, deadAt: null, discardedAt: null, attempts: job.attempts },
        data: { attempts, availableAt: new Date(now.getTime() + 1000 * 2 ** attempts), ...(attempts >= 6 ? { deadAt: now } : {}) } });
    }
  }
}

export async function deadlines(client: PrismaClient, now = new Date()) {
  const soon = new Date(now.getTime() + hour);
  const waitingCutoff = new Date(now.getTime() - 24 * hour);
  const records = await client.appeal.findMany({
    where: { status: { notIn: ['CLOSED', 'WITHDRAWN'] }, OR: [
      { status: 'WAITING_AUTHOR', waitingSince: { lte: waitingCutoff } },
      { status: { not: 'WAITING_AUTHOR' }, slaVersion: { not: null }, OR: [
        { dueAt: { lte: soon } }, { firstResponseDueAt: { lte: soon }, firstHumanResponseAt: null },
      ] },
    ] }, select: { id: true },
  });
  for (const { id } of records) {
    await atomic(client, async tx => {
      const item = await tx.appeal.findUnique({ where: { id }, include: { queue: { select: { coordinatorId: true } } } });
      if (!item || !activeAppeal(item.status)) return;
      const href = `/appeals/${item.id}`;
      if (item.status === 'WAITING_AUTHOR' && item.waitingSince && item.waitingSince <= waitingCutoff) {
        const key = clarificationKey(item.id, item.waitingSince);
        const inserted = await tx.outboxJob.createMany({ data: { key, userId: item.authorId, kind: 'CLARIFICATION_REMINDER', href }, skipDuplicates: true });
        if (inserted.count) await audit(tx, 'appeal', item.id, 'CLARIFICATION_REMINDER', undefined, true);
        return;
      }
      const owner = item.assigneeId ?? item.queue.coordinatorId;
      const recipient = await tx.user.findFirst({ where: { id: owner, active: true }, select: principalSelect });
      if (!recipient || !await policy.handles(tx, recipient, id)) return;
      for (const name of ['SLA', 'FIRST_RESPONSE']) {
        const dueAt = slaDeadline(item, name + '_DUE');
        if (!dueAt || dueAt > soon) continue;
        const kind = `${name}_${dueAt < now ? 'OVERDUE' : 'DUE'}`;
        await notify(tx, `${item.id}:${kind}:${dueAt.toISOString()}`, [owner], kind, href);
      }
    });
  }
}

async function main() {
  let ticks = 0;
  console.info('Worker started');
  while (running) {
    try {
      if (ticks % 15 === 0) await deadlines(db);
      if (ticks % 30 === 0) await purgeUploads(db, storage);
      if (ticks % 180 === 0) {
        await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        await db.rateBucket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      }
      await deliver(db);
      if (ticks % 5 === 0) {
        const checkedAt = new Date();
        await db.workerHeartbeat.upsert({ where: { id: 'outbox' }, create: { id: 'outbox', checkedAt }, update: { checkedAt } });
      }
    } catch (error) {
      console.error(JSON.stringify({ message: 'Worker cycle failed', errorType: error instanceof Error ? error.name : typeof error }));
    }
    ticks++;
    if (running) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  await db.$disconnect();
}

if (require.main === module) void main();
