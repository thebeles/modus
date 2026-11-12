import 'dotenv/config';
import { Appeal, AppealStatus, AppealType, Prisma, PrismaClient, Priority, Resolution, Role, Visibility } from '@prisma/client';
import { hash } from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import { assessEffect } from '../src/effect';
import { permissions } from '../src/contracts';

const db = new PrismaClient();
const demoPassword = 'Modus-Demo-2026!';
const titles = [
  'Обязательные поля в заявке на закупку', 'Статус проекта для поставщиков', 'Единые обозначения оборудования',
  'Короткие занятия по новым линейкам', 'Статус пакета документов', 'Памятка для межотдельных операций',
  'Повторный ввод данных в системах', 'Памятка для новых сотрудников', 'Ответственность за версии договора',
  'Подтверждение результата рабочей задачи', 'Срок ответа смежных подразделений', 'Единое место для итоговых решений',
  'История изменений спецификации', 'Планирование загрузки проектировщиков', 'Минимум данных при постановке задач',
  'Практическое обучение на оборудовании', 'Место для коротких перерывов', 'Спасибо за учебные встречи',
  'Актуальные версии инструкций', 'Обзор завершённых улучшений',
];
const departments = ['Закупки', 'Бухгалтерия', 'Продажи', 'Проектирование', 'Проекты', 'IT', 'Административное', 'HR / Обучение'];
const processNames = ['Закупка оборудования', 'Сопровождение проектов', 'Работа со спецификациями', 'Внутреннее обучение',
  'Документооборот', 'Управление задачами', 'Информационные системы', 'Договорная работа', 'Внутренние коммуникации'];
const sourceProcesses = [0, 1, 2, 3, 4, 5, 6, 3, 7, 5, 1, 8, 2, 1, 5, 3, 8, 3, 4, 8];
const typeMap: Record<string, AppealType> = { Проблема: 'PROBLEM', Предложение: 'PROPOSAL', 'Положительный отзыв': 'POSITIVE_FEEDBACK' };
const priorityMap: Record<string, Priority> = { Низкий: 'LOW', Средний: 'MEDIUM', Высокий: 'HIGH' };
const statusMap: Record<string, AppealStatus> = { Новое: 'NEW', 'На рассмотрении': 'REVIEW', 'В работе': 'IN_PROGRESS',
  'Ожидает уточнения': 'WAITING_AUTHOR', Реализовано: 'CLOSED', Отклонено: 'CLOSED', Закрыто: 'CLOSED' };
interface Source {
  sourceId: string; rawType: string; rawCategory: string; rawAuthorRole: string; rawPriority: string; rawStatus: string;
  rawDescription: string; rawAssigneeRole: string; rawSuggestedNextAction: string; seedOrigin: 'ORIGINAL_DOCX'; isSynthetic: true;
}
const date = (day: number, hour = 8) => new Date(Date.UTC(2026, 9, day, hour));

async function seed() {
  if (process.env.NODE_ENV === 'production' || process.env.DEMO_MODE !== 'true' || process.env.SEED_DEMO_USERS !== 'true') {
    console.info('Demo seed disabled');
    return;
  }
  const original = JSON.parse(await readFile('prisma/fixtures/original.json', 'utf8')) as Source[];
  if (original.length !== 20 || original.some((row, index) => row.sourceId !== `A-${String(index + 1).padStart(3, '0')}`)) {
    throw new Error('Unexpected original dataset');
  }
  const passwordHash = await hash(process.env.DEMO_PASSWORD || demoPassword, 12);
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(640211)`;
    const root = await tx.organizationUnit.upsert({ where: { name: 'Модус Трейд (ДЕМО)' }, update: {}, create: { name: 'Модус Трейд (ДЕМО)' } });
    const units = await Promise.all(departments.map(name => tx.organizationUnit.upsert({ where: { name }, update: {}, create: { name, parentId: root.id } })));
    const processes = await Promise.all(processNames.map(name => tx.businessProcess.upsert({ where: { name }, update: {}, create: { name } })));
    const user = (username: string, name: string, role: Role, unit = 0, permissions: string[] = []) => {
      const email = `${username}@demo.local`;
      return tx.user.upsert({ where: { email }, update: {}, create: { email, name, role, permissions, passwordHash, demo: true, departmentId: units[unit].id } });
    };
    const staffRights = ['ROUTING_COORDINATOR', 'PROBLEM_OWNER', 'IMPROVEMENT_OWNER'];
    const [employee, handler, manager, , other, sensitive, accounting, sales, design, projects, lead, office] = await Promise.all([
      user('employee', 'Анна Соколова', 'EMPLOYEE'),
      user('handler', 'Илья Орлов', 'HANDLER', 0, staffRights),
      user('manager', 'Мария Волкова', 'MANAGER', 0, permissions.filter(value => value !== 'SENSITIVE_CASE_HANDLER')),
      user('admin', 'Алексей Мельников', 'ADMIN', 5),
      user('other-employee', 'Павел Ким', 'EMPLOYEE', 2),
      user('sensitive-handler', 'Ольга Сафина', 'HANDLER', 6, [...staffRights, 'SENSITIVE_CASE_HANDLER']),
      user('accounting', 'Сотрудник бухгалтерии', 'EMPLOYEE', 1), user('sales', 'Менеджер по продажам', 'EMPLOYEE', 2),
      user('design', 'Сотрудник проектирования', 'EMPLOYEE', 3), user('projects', 'Координатор проекта', 'EMPLOYEE', 4),
      user('project-lead', 'Руководитель проекта', 'EMPLOYEE', 4), user('office', 'Сотрудник офиса', 'EMPLOYEE', 6),
    ]);
    const ownersByRole = new Map([
      ['Сотрудник закупок', employee], ['Сотрудник бухгалтерии', accounting], ['Менеджер по продажам', sales],
      ['Сотрудник проектирования', design], ['Координатор проекта', projects], ['Руководитель проекта', lead], ['Сотрудник офиса', office],
    ]);
    const queue = async (name: string, visibility: Visibility, coordinatorId: string, memberIds: string[], fallback = false) => {
      const row = await tx.workQueue.upsert({ where: { name }, update: {}, create: { name, visibility, coordinatorId, fallback,
        members: { createMany: { data: memberIds.map(userId => ({ userId })) } } } });
      return row;
    };
    const baseQueue = await queue('Первичная обработка', 'NORMAL_INTERNAL', handler.id, [handler.id, manager.id], true);
    const categoryQueue = await queue('Рабочие процессы', 'NORMAL_INTERNAL', handler.id, [handler.id, manager.id]);
    const privateQueue = await queue('Ограниченные обращения', 'RESTRICTED', sensitive.id, [sensitive.id], true);
    await queue('Специальная очередь', 'SPECIAL', sensitive.id, [sensitive.id], true);
    const categories = new Map<string, string>();
    for (const name of new Set(original.map(row => row.rawCategory))) {
      const category = await tx.category.upsert({ where: { name }, update: {}, create: { name } });
      categories.set(name, category.id);
      await tx.routingRule.upsert({ where: { name: `Обработка · ${name}` }, update: {}, create: { name: `Обработка · ${name}`,
        categoryId: category.id, queueId: categoryQueue.id, assigneeId: handler.id } });
    }
    await tx.category.upsert({ where: { name: 'Конфиденциальное обращение' }, update: {}, create: { name: 'Конфиденциальное обращение', sensitive: true } });
    for (const [priority, firstResponseHours, nextActionHours] of [['LOW', 16, 40], ['MEDIUM', 8, 24], ['HIGH', 4, 12]] as const) {
      await tx.slaPolicy.upsert({ where: { priority }, update: {}, create: { priority, firstResponseHours, nextActionHours } });
    }

    const appeals: Appeal[] = [];
    for (const [index, row] of original.entries()) {
      const author = ownersByRole.get(row.rawAuthorRole) ?? employee;
      const status = statusMap[row.rawStatus];
      const priority = priorityMap[row.rawPriority];
      const createdAt = date(27 - index);
      const closedAt = status === 'CLOSED' ? date(29 - index, 11) : null;
      const waitingSince = status === 'WAITING_AUTHOR' ? date(28 - index) : null;
      const resolutionType: Resolution | undefined = closedAt ?
        row.rawStatus === 'Отклонено' ? 'REJECTED' : row.rawStatus === 'Закрыто' ? 'POSITIVE_FEEDBACK_RECORDED' : 'RESOLVED' : undefined;
      const resolutionText = closedAt ? `Синтетический результат. ${row.rawSuggestedNextAction}` +
        (row.rawStatus === 'Реализовано' ? ' Исходная отметка перенесена для демонстрации. Подтверждённых данных о внедрении нет.' : '') : undefined;
      const resolutionBy = closedAt ? (resolutionType === 'REJECTED' ? manager.id : handler.id) : null;
      const record = await tx.appeal.upsert({ where: { sourceId: row.sourceId }, update: {}, create: {
        sourceId: row.sourceId, number: row.sourceId, title: titles[index], description: row.rawDescription, descriptionOriginal: row.rawDescription,
        sourceSnapshot: { ...row }, type: typeMap[row.rawType], status, priority, authorId: author.id, departmentId: author.departmentId,
        assigneeId: handler.id, queueId: categoryQueue.id, categoryId: categories.get(row.rawCategory), processId: processes[sourceProcesses[index]].id,
        resolutionType, resolutionText, resolutionBy, resolutionOrigin: closedAt ? 'DEMO_FIXTURE' : null,
        closedAt, waitingSince, resumeState: waitingSince ? 'REVIEW' : null, createdAt, lastMeaningfulActionAt: closedAt ?? waitingSince ?? createdAt, updatedAt: date(28 - index),
        seedOrigin: 'ORIGINAL_DOCX', isSynthetic: true,
      } });
      appeals.push(record);
      await tx.auditEvent.upsert({ where: { id: `seed-created-${row.sourceId}` }, update: {}, create: {
        id: `seed-created-${row.sourceId}`, entity: 'appeal', entityId: record.id, actorId: author.id,
        action: 'CREATED', origin: 'DEMO_FIXTURE', authorVisible: true, createdAt, details: { seedOrigin: 'DEMO_SYNTHETIC' },
      } });
      if (closedAt) await tx.auditEvent.upsert({ where: { id: `seed-result-${row.sourceId}` }, update: {}, create: {
        id: `seed-result-${row.sourceId}`, entity: 'appeal', entityId: record.id, actorId: resolutionBy, action: 'RESOLVED_EVENT', origin: 'DEMO_FIXTURE', authorVisible: true, createdAt: closedAt,
        details: { seedOrigin: 'DEMO_SYNTHETIC' },
      } });
      if (waitingSince) {
        const question = row.sourceId === 'A-005' ? 'Какие виды документов и этапы согласования нужно отобразить?' : 'Какие форматы спецификаций и версии файлов нужно сравнивать?';
        for (const [event, authorId, body, at] of [
          ['CLARIFICATION', handler.id, question, date(28 - index, 8)],
          ['AUTHOR_RESPONSE', author.id, 'Подготовлю обезличенный пример и уточню у коллег.', date(28 - index, 9)],
          ['CLARIFICATION', handler.id, 'Пришлите пример, когда он будет готов. Какие поля следует сравнить в первую очередь?', date(28 - index, 10)],
        ] as const) {
          const commentId = `seed-${row.sourceId}-${at.getUTCHours()}`;
          await tx.comment.upsert({ where: { id: commentId }, update: {}, create: { id: commentId, appealId: record.id, authorId, body, kind: event, origin: 'DEMO_FIXTURE', createdAt: at } });
          await tx.auditEvent.upsert({ where: { id: commentId }, update: {}, create: { id: commentId, entity: 'appeal', entityId: record.id,
            action: event, origin: 'DEMO_FIXTURE', authorVisible: true, actorId: authorId, createdAt: at, details: { seedOrigin: 'DEMO_SYNTHETIC' } } });
        }
      }
    }
    for (const [number, title, description, author, q, visibility, overdue] of [
      ['DEMO-A-01', 'Доступ к учебным материалам', 'Подскажите, где хранится актуальная подборка учебных материалов.', employee, baseQueue, 'NORMAL_INTERNAL', false],
      ['DEMO-A-02', 'Обновить сроки в шаблоне заявки', 'В тестовом шаблоне требуется актуализировать срок проверки заявки.', other, baseQueue, 'NORMAL_INTERNAL', true],
      ['DEMO-A-03', 'Запрос с ограниченным доступом', 'Синтетический пример сообщения, доступного автору и специальной очереди.', employee, privateQueue, 'RESTRICTED', false],
    ] as const) {
      const record = await tx.appeal.upsert({ where: { number }, update: {}, create: { number, title, description, descriptionOriginal: description,
        authorId: author.id, departmentId: author.departmentId, queueId: q.id, visibility, type: 'PROPOSAL',
        dueAt: overdue ? date(22) : null, slaVersion: overdue ? 1 : null, createdAt: date(22), lastMeaningfulActionAt: date(22), updatedAt: date(23),
        seedOrigin: 'DEMO_SYNTHETIC', isSynthetic: true } });
      const eventId = `seed-created-${number}`;
      await tx.auditEvent.upsert({ where: { id: eventId }, update: {}, create: { id: eventId, entity: 'appeal', entityId: record.id,
        action: visibility === 'NORMAL_INTERNAL' ? 'ROUTING_FALLBACK' : 'CREATED', origin: 'DEMO_FIXTURE', authorVisible: true, createdAt: date(22) } });
    }
    for (const [first, second, explanation] of [
      [1, 15, 'В обоих обращениях не хватает исходных данных при постановке задачи. Причины могут отличаться.'],
      [2, 5, 'Общая тема — прозрачность этапов и сроков. Контексты разные.'],
      [2, 11, 'Авторы хотят заранее видеть статус и сроки смежных работ.'],
      [5, 11, 'Похожие ожидания по информированию о ходе работ.'],
      [4, 16, 'Обе идеи относятся к практическому обучению, но рассчитаны на разные форматы.'],
    ] as const) {
      const [fromId, toId] = [appeals[first - 1].id, appeals[second - 1].id].sort();
      const relation = 'SIMILAR_TOPIC';
      await tx.appealLink.upsert({ where: { fromId_toId_relation: { fromId, toId, relation } }, update: {},
        create: { fromId, toId, relation, explanation, proposedBy: 'SYSTEM_RULE' } });
    }
    const problem = await tx.problem.upsert({ where: { number: 'DEMO-P-01' }, update: {}, create: {
      number: 'DEMO-P-01', title: 'Прозрачность этапов и сроков', symptoms: 'В синтетических обращениях повторяется вопрос о видимости текущего этапа.',
      hypothesis: 'Нужно выяснить, согласованы ли источники статусов и сроки передачи между подразделениями.',
      ownerId: handler.id, departmentId: units[0].id, status: 'INVESTIGATING', isSynthetic: true,
      appeals: { create: [2, 5, 11].map(index => ({ appealId: appeals[index - 1].id, explanation: 'Общая тема для проверки.' })) },
      findings: { create: { body: 'У сигналов разные контексты. Общая причина пока не установлена.', source: 'Синтетические обращения', recordedBy: handler.id } },
    } });
    for (const [index, title, status, goal] of [
      [1, 'Дополнить шаблон закупочной заявки', 'COMPLETED', 'Сократить долю заявок, по которым требуется уточнение.'],
      [2, 'Согласовать единый канал решений', 'COMPLETED', 'Проверить полноту итоговых решений по задачам.'],
      [3, 'Пилот практического обучения', 'DEFERRED', 'Выбрать учебные образцы и согласовать программу пилота.'],
      [4, 'Показывать этапы согласования', 'VERIFYING', 'Проверить видимость этапов на синтетических пакетах документов.'],
    ] as const) {
      const number = `DEMO-I-0${index}`;
      const measured = index === 1;
      const outcome = measured ? 'VERIFIED' : 'INCONCLUSIVE';
      const limitations = measured ? 'Синтетические данные, малая выборка. Причинная связь не проверялась.' :
        'Синтетический сценарий. Наблюдения до и после внедрения отсутствуют.';
      const effect = {
        ...assessEffect({ direction: 'DECREASE', targetValue: 25, targetMaximum: null }, measured ? 50 : null, measured ? 20 : null),
        method: 'QUANTITATIVE', unit: '%', hasBothObservations: measured, evaluatedAsDeterminate: measured,
      };
      const improvement = await tx.improvement.upsert({ where: { number }, update: {}, create: {
        number, title, status, goal, rationale: 'Синтетический сценарий проверки работы системы.', scope: 'Демонстрационный контур',
        departmentId: units[0].id, ownerId: handler.id, processId: processes[index === 1 ? 0 : index === 3 ? 3 : 1].id,
        problemId: index === 4 ? problem.id : null, isSynthetic: true, createdAt: date(1 + index), updatedAt: date(24 - index),
        implementedAt: status === 'DEFERRED' ? null : date(15), completedAt: status === 'COMPLETED' ? date(24) : null,
        implementationNotes: status === 'DEFERRED' ? null : 'Изменение проведено в синтетической среде.',
        appeals: { create: { appealId: appeals[[0, 11, 15, 4][index - 1]].id, explanation: 'Демонстрационная связь с источником.' } },
        actions: { create: { ownerId: handler.id, title: index === 1 ? 'Проверить обязательные поля и выпустить шаблон' : 'Провести тестовое внедрение',
          status: status === 'DEFERRED' ? 'TODO' : 'DONE', result: status === 'DEFERRED' ? null : 'Тестовый сценарий выполнен.' } },
        approvals: { create: { status: status === 'DEFERRED' ? 'DEFERRED' : 'APPROVED', decidedBy: manager.id,
          reason: status === 'DEFERRED' ? 'Пилот отложен до появления учебных образцов.' : 'Согласован синтетический пилот.', createdAt: date(12) } },
        ...(index !== 3 ? { plan: { create: { method: 'QUANTITATIVE', hypothesis: goal, criterion: 'Сопоставить две выборки с одинаковым определением показателя.',
          metricName: index === 1 ? 'Заявки с уточнениями' : 'Пакеты с дополнительными вопросами', unit: '%', direction: 'DECREASE', targetValue: 25,
          observations: { create: index === 1 ? [
            { phase: 'BEFORE', value: 50, periodStart: date(6), periodEnd: date(12), sampleSize: 20, source: 'Синтетическая выборка. 10 заявок из 20.', recordedBy: handler.id, origin: 'DEMO_FIXTURE', isSynthetic: true },
            { phase: 'AFTER', value: 20, periodStart: date(16), periodEnd: date(23), sampleSize: 20, source: 'Синтетическая выборка. 4 заявки из 20.', recordedBy: handler.id, origin: 'DEMO_FIXTURE', isSynthetic: true },
          ] : [] } } } } : {}),
        ...(status === 'COMPLETED' ? { verification: { create: { outcome,
          summary: measured ? 'В тестовой выборке наблюдалось снижение с 50% до 20%.' : 'Данных для вывода об эффекте недостаточно.',
          limitations, effect, verifierId: manager.id, origin: 'DEMO_FIXTURE', isSynthetic: true, verifiedAt: date(24) } } } : {}),
      } });
      if (status === 'COMPLETED') {
        const baseline = { improvementId: improvement.id, outcome, origin: 'DEMO_FIXTURE', isSynthetic: true, revision: 1,
          verifiedAt: date(24) } satisfies Prisma.VerificationWhereInput;
        if (measured) {
          const observations = await tx.measurement.findMany({
            where: { improvementId: improvement.id, origin: 'DEMO_FIXTURE', isSynthetic: true, planVersion: 1 },
            orderBy: { periodStart: 'asc' }, select: { id: true, phase: true },
          });
          if (observations.length === 2 && observations[0].phase === 'BEFORE' && observations[1].phase === 'AFTER') {
            await tx.verification.updateMany({ where: { ...baseline, measurementIds: { isEmpty: true } },
              data: { measurementIds: observations.map(row => row.id) } });
          }
        } else {
          await tx.verification.updateMany({ where: { ...baseline, effect: { path: ['hasBothObservations'], equals: true } }, data: { effect, limitations } });
        }
      }
      await tx.auditEvent.upsert({ where: { id: `seed-${number}` }, update: {}, create: {
        id: `seed-${number}`, entity: 'improvement', entityId: improvement.id, actorId: handler.id, origin: 'DEMO_FIXTURE', action: status, createdAt: date(24), details: { seedOrigin: 'DEMO_SYNTHETIC' },
      } });
      if (index === 1) {
        const publication = await tx.publication.upsert({ where: { id: 'a0200000-1aaa-4ccc-8aaa-000000000001' }, update: {}, create: {
          id: 'a0200000-1aaa-4ccc-8aaa-000000000001', improvementId: improvement.id, state: 'PUBLISHED',
          title: 'Новый шаблон заявки на закупку', problem: 'В тестовых заявках часто требовались уточнения по характеристикам оборудования.',
          change: 'В шаблон добавили обязательные поля для назначения изделия и требуемых параметров.',
          method: 'Сравнили по 20 синтетических заявок до и после изменения шаблона.',
          result: 'В синтетической выборке уточнения понадобились для 4 из 20 заявок вместо 10 из 20.',
          limitations: 'Это демонстрационный пример. Причинность и реальный эффект компании не оценивались.',
          authorId: handler.id, approvedBy: manager.id, publishedAt: date(24), isSynthetic: true,
        } });
        await tx.publicationRevision.createMany({ data: [{ publicationId: publication.id, version: publication.version,
          action: 'BASELINE', snapshot: { ...publication, publishedAt: publication.publishedAt?.toISOString() ?? null } }], skipDuplicates: true });
        const invite = await tx.feedback.upsert({ where: { improvementId_userId: { improvementId: improvement.id, userId: employee.id } },
          update: {}, create: { improvementId: improvement.id, userId: employee.id } });
        await tx.notification.upsert({ where: { key: 'seed-feedback' }, update: {}, create: {
          key: 'seed-feedback', kind: 'FEEDBACK_INVITED', userId: employee.id, href: `/feedback/${invite.id}`, createdAt: date(27),
        } });
      }
    }
    await tx.sequence.upsert({ where: { name: 'A' }, update: {}, create: { name: 'A', value: 20 } });
  }, { timeout: 45000 });
  console.info('Seed complete: 20 original synthetic appeals and separate demo scenarios');
}

void seed().catch(error => { console.error('Seed failed', error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => db.$disconnect());
