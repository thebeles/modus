import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { audit, notify } from './common';

const db = new PrismaClient();
let running = true;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { running = false; });

export async function deliver(client: PrismaClient, now = new Date()) {
  const jobs = await client.outboxJob.findMany({
    where: { deliveredAt: null, deadAt: null, availableAt: { lte: now } }, orderBy: { availableAt: 'asc' }, take: 50,
  });
  for (const job of jobs) {
    try {
      await client.$transaction(async tx => {
        const claimed = await tx.outboxJob.updateMany({ where: { id: job.id, deliveredAt: null, deadAt: null, attempts: job.attempts },
          data: { deliveredAt: now } });
        if (!claimed.count) return;
        const recipient = await tx.user.findUnique({ where: { id: job.userId }, select: { active: true, notifyRegistration: true } });
        if (!recipient?.active || (job.kind === 'REGISTRATION_CONFIRMED' && !recipient.notifyRegistration)) return;
        await tx.notification.upsert({
          where: { key: job.key }, update: {},
          create: { key: job.key, userId: job.userId, kind: job.kind, href: job.href },
        });
      });
    } catch {
      const attempts = job.attempts + 1;
      await client.outboxJob.updateMany({ where: { id: job.id, deliveredAt: null, deadAt: null, attempts: job.attempts },
        data: { attempts, availableAt: new Date(now.getTime() + 1000 * 2 ** attempts), ...(attempts >= 6 ? { deadAt: now } : {}) } });
    }
  }
}

export async function deadlines(client: PrismaClient, now = new Date()) {
  const soon = new Date(now.getTime() + 3600000);
  const waitingCutoff = new Date(now.getTime() - 24 * 3600000);
  const records = await client.appeal.findMany({
    where: { status: { notIn: ['CLOSED', 'WITHDRAWN'] }, OR: [
      { status: 'WAITING_AUTHOR', waitingSince: { lte: waitingCutoff } },
      { status: { not: 'WAITING_AUTHOR' }, slaVersion: { not: null }, OR: [
        { dueAt: { lte: soon } }, { firstResponseDueAt: { lte: soon }, firstHumanResponseAt: null },
      ] },
    ] }, include: { queue: { select: { coordinatorId: true } } },
  });
  for (const item of records) {
    const owner = item.assigneeId ?? item.queue.coordinatorId;
    const href = `/appeals/${item.id}`;
    await client.$transaction(async tx => {
      if (item.status === 'WAITING_AUTHOR' && item.waitingSince) {
        const key = `clarification:${item.id}:${item.waitingSince.toISOString()}`;
        const current = await tx.appeal.findFirst({ where: { id: item.id, status: 'WAITING_AUTHOR', version: item.version } });
        if (!current) return;
        const inserted = await tx.outboxJob.createMany({ data: { key, userId: item.authorId, kind: 'CLARIFICATION_REMINDER', href }, skipDuplicates: true });
        if (inserted.count) await audit(tx, 'appeal', item.id, 'CLARIFICATION_REMINDER', undefined, true);
        return;
      }
      const dueDates = [{ name: 'SLA', dueAt: item.dueAt }, { name: 'FIRST_RESPONSE', dueAt: item.firstHumanResponseAt ? null : item.firstResponseDueAt }];
      for (const { name, dueAt } of dueDates) {
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
      if (ticks % 180 === 0) {
        await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        await db.rateBucket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      }
      await deliver(db);
    } catch {
      console.error('Worker cycle failed');
    }
    ticks++;
    if (running) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  await db.$disconnect();
}

if (require.main === module) void main();
