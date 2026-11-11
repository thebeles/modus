import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { z } from 'zod';

const db = new PrismaClient();

async function main() {
  const email = z.email().max(254).parse(process.env.BOOTSTRAP_ADMIN_EMAIL).toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (email.endsWith('@demo.local') || password.length < 16 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Use a non-demo email and a password of 16–72 UTF-8 bytes.');
  }
  const passwordHash = await hash(password, 12);
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(640212)`;
    if (await tx.user.count({ where: { role: 'ADMIN', demo: false } })) throw new Error('An administrator already exists.');
    const admin = await tx.user.create({ data: { email, passwordHash, name: 'Администратор', role: 'ADMIN' }, select: { id: true } });
    await tx.auditEvent.create({ data: { entity: 'users', entityId: admin.id, action: 'CREATED' } });
  });
  console.info('Administrator created');
}

void main().catch(() => { console.error('Administrator was not created. Check configuration and existing accounts.'); process.exitCode = 1; })
  .finally(() => db.$disconnect());
