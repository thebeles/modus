import { expect, test, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const profileNames = { employee: 'Сотрудник', handler: 'Обработчик', manager: 'Руководитель', admin: 'Администратор', other: 'Другой сотрудник' } as const;

async function login(page: Page, role: keyof typeof profileNames) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: profileNames[role], exact: true }).click();
  await expect(page.getByRole('button', { name: 'Выйти из аккаунта', exact: true })).toBeVisible();
}

async function session(browser: Browser, role: keyof typeof profileNames) {
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:4180' });
  const page = await context.newPage();
  await login(page, role);
  return { page, close: () => context.close() };
}

async function post<T>(page: Page, path: string, body: object, key?: string): Promise<T> {
  const origin = new URL(page.url()).origin;
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'modus_csrf')!.value;
  const response = await page.request.post('/api/v1' + path, { data: body, headers: { Origin: origin, 'X-CSRF-Token': csrf, ...(key ? { 'Idempotency-Key': key } : {}) } });
  const json = await response.json();
  expect(response.ok(), JSON.stringify(json.error)).toBeTruthy();
  return json.data as T;
}

async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get('/api/v1' + path);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).data as T;
}

async function create(page: Page, title: string, visibility = 'NORMAL_INTERNAL') {
  return post<{ id: string; number: string }>(page, '/appeals', {
    type: 'PROPOSAL', title, description: 'Демонстрационная запись для проверки рабочих сценариев.', visibility,
  }, randomUUID());
}

async function mutation(page: Page, name: string, fill?: (dialog: ReturnType<Page['getByRole']>) => Promise<void>, submit = 'Сохранить') {
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (fill) await fill(dialog);
  await dialog.getByRole('button', { name: submit, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('opens an appeal when the API omits review timing', async ({ page }) => {
  await login(page, 'employee');
  await page.goto('/my/appeals');
  const appeal = page.locator('.table-title').first();
  const title = await appeal.locator('strong').innerText();
  const href = (await appeal.getAttribute('href'))!;
  await page.route(`**/api/v1${href}`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.data.timing;
    await route.fulfill({ response, json: body });
  });
  await appeal.click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'История' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Время рассмотрения' })).toHaveCount(0);
});

test('E2E-01 creates a real appeal and shows it to its author and the queue', async ({ page, browser }) => {
  await login(page, 'employee');
  const title = 'Проверка подачи ' + randomUUID().slice(0, 8);
  await page.getByRole('link', { name: /Сообщить о проблеме/ }).click();
  await page.getByLabel('Что вы хотите сообщить?').fill('Не хватает данных в тестовом шаблоне заявки.');
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await page.getByLabel('Заголовок').fill(title);
  await page.getByLabel('Категория', { exact: true }).selectOption({ label: 'Межотдельное взаимодействие' });
  await page.getByRole('button', { name: 'Проверить и отправить' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText(/A-\d+ · Проблема/)).toBeVisible();
  await page.goto('/my/appeals');
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  const handler = await session(browser, 'handler');
  await handler.page.getByRole('textbox', { name: 'Поиск по обращениям' }).fill(title);
  await expect(handler.page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  await handler.close();
});

test('E2E-02 author receives clarification, replies, and restores the previous state', async ({ page, browser }) => {
  await login(page, 'employee');
  const title = 'Уточнение ' + randomUUID().slice(0, 8);
  const item = await create(page, title);
  const handler = await session(browser, 'handler');
  await handler.page.goto('/work-queue/appeals/' + item.id);
  await mutation(handler.page, 'Взять на рассмотрение', undefined, 'Подтвердить');
  await mutation(handler.page, 'В работу', undefined, 'Подтвердить');
  await mutation(handler.page, 'Запросить уточнение', async dialog => dialog.getByLabel('Вопрос автору').fill('Какой образец заявки вы заполняли?'));
  await page.goto('/notifications');
  await page.getByRole('link', { name: 'Запрошено уточнение', exact: true }).and(page.locator(`a[href="/appeals/${item.id}"]`)).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await mutation(page, 'Ответить на уточнение', async dialog => dialog.getByLabel('Ваш ответ').fill('Использовали тестовый образец заявки на оборудование.'));
  await handler.page.reload();
  await expect(handler.page.getByText('Использовали тестовый образец заявки на оборудование.', { exact: true })).toBeVisible();
  await expect(handler.page.locator('.heading-line').getByText('В работе', { exact: true })).toBeVisible();
  await handler.page.getByText('Последние периоды', { exact: true }).click();
  await expect(handler.page.getByText(/^Ожидание автора ·/)).toBeVisible();
  await handler.close();
});

test('a handler closes a fallback appeal with an explanation after the author replies', async ({ page, browser }) => {
  await login(page, 'employee');
  const item = await create(page, 'Характеристики оборудования ' + randomUUID().slice(0, 8));
  const handler = await session(browser, 'handler');
  await handler.page.goto('/work-queue/appeals/' + item.id);
  await expect(handler.page.getByText('Направлено в резервную очередь')).toBeVisible();
  await mutation(handler.page, 'Взять на рассмотрение', undefined, 'Подтвердить');
  await mutation(handler.page, 'Запросить уточнение', async dialog => {
    await dialog.getByLabel('Вопрос автору').fill('Какие характеристики приходится уточнять чаще всего?');
  });
  const close = handler.page.getByRole('button', { name: 'Закрыть с решением', exact: true });
  await expect(close).toHaveCount(0);

  await page.goto('/appeals/' + item.id);
  await page.getByLabel('Сообщение в общий диалог').fill('Подготовили пример заявки для уточнения.');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.getByText('Подготовили пример заявки для уточнения.', { exact: true })).toBeVisible();
  await expect(page.locator('.heading-line').getByText('Ожидает уточнения', { exact: true })).toBeVisible();
  const conversation = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Диалог', exact: true }) });
  await expect(conversation.getByRole('button', { name: 'Ответить на уточнение', exact: true })).toBeVisible();
  await mutation(page, 'Ответить на уточнение', async dialog => {
    await dialog.getByLabel('Ваш ответ').fill('Чаще всего не хватает точной модели и срока поставки.');
  });

  await handler.page.reload();
  await expect(handler.page.locator('.heading-line').getByText('На рассмотрении', { exact: true })).toBeVisible();
  await expect(close).toBeVisible();
  const explanation = 'Указывайте модель оборудования и желаемый срок поставки.';
  await mutation(handler.page, 'Закрыть с решением', async dialog => {
    await dialog.getByLabel('Тип решения').selectOption({ label: 'Дано пояснение' });
    await dialog.getByLabel('Обоснование').fill(explanation);
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Итог рассмотрения' })).toBeVisible();
  await expect(page.getByText('Дано пояснение', { exact: true })).toBeVisible();
  await expect(page.getByText(explanation, { exact: true })).toBeVisible();
  await handler.close();
});

test('E2E-03 a manager must enter a reason for rejection and the author sees it', async ({ page, browser }) => {
  await login(page, 'employee');
  const item = await create(page, 'Мотивированное решение ' + randomUUID().slice(0, 8));
  const manager = await session(browser, 'manager');
  await manager.page.goto('/work-queue/appeals/' + item.id);
  await mutation(manager.page, 'Взять на рассмотрение', undefined, 'Подтвердить');
  await manager.page.getByRole('button', { name: 'Закрыть с решением' }).click();
  const dialog = manager.page.getByRole('dialog');
  await dialog.getByLabel('Тип решения').selectOption('REJECTED');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Обоснование').fill('Для тестового пилота нет подходящего помещения.');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog).toBeHidden();
  await page.goto('/appeals/' + item.id);
  await expect(page.getByRole('heading', { name: 'Итог рассмотрения' })).toBeVisible();
  await expect(page.getByText('Для тестового пилота нет подходящего помещения.', { exact: true })).toBeVisible();
  await manager.close();
});

test('E2E-04 fallback is visible and coordinator can assign the appeal', async ({ page, browser }) => {
  await login(page, 'employee');
  const item = await create(page, 'Резервный маршрут ' + randomUUID().slice(0, 8));
  const handler = await session(browser, 'handler');
  await handler.page.goto('/work-queue/appeals/' + item.id);
  await expect(handler.page.getByText('Направлено в резервную очередь')).toBeVisible();
  await mutation(handler.page, 'Назначить ответственного', async dialog => {
    await expect(dialog.getByRole('option', { name: 'Илья Орлов' })).toBeAttached();
    await dialog.getByLabel('Ответственный').selectOption({ label: 'Илья Орлов' });
    await dialog.getByLabel('Обоснование').fill('Уточнение по резервному маршруту.');
  });
  await expect(handler.page.getByText('Илья Орлов', { exact: true }).last()).toBeVisible();
  await handler.close();
});

test('E2E-05 independent approval, implementation and verification through the improvement card', async ({ page, browser }) => {
  await login(page, 'handler');
  const original = await get<{ items: { id: string }[] }>(page, '/work-queue?q=A-001');
  await page.goto('/work-queue/appeals/' + original.items[0].id);
  await page.getByRole('link', { name: 'Создать улучшение' }).click();
  const title = 'Изменение шаблона ' + randomUUID().slice(0, 8);
  await page.getByLabel('Название', { exact: true }).fill(title);
  await page.getByLabel('Основание', { exact: true }).fill('В тестовом шаблоне не хватает полей.');
  await page.getByLabel('Цель изменения').fill('Уточнить состав данных в заявке.');
  await page.getByLabel('Область изменения').fill('Демонстрационная закупка');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const url = page.url();
  const id = new URL(url).pathname.split('/').pop()!;
  await page.getByRole('tab', { name: 'План' }).click();
  await mutation(page, 'Задача', dialog => dialog.getByLabel('Название').fill('Согласовать новые поля шаблона'));
  await mutation(page, 'Добавить план', async dialog => {
    await dialog.getByLabel('Гипотеза').fill('Станет меньше уточнений.');
    await dialog.getByLabel('Критерий успеха').fill('Доля уточнений ниже 25 процентов.');
    await dialog.getByLabel('Показатель', { exact: true }).fill('Доля уточнений');
    await dialog.getByLabel('Единица измерения').fill('%');
    await dialog.getByLabel('Целевое значение').fill('25');
  });
  await mutation(page, 'Отправить на согласование');
  const manager = await session(browser, 'manager');
  await manager.page.goto(url);
  await mutation(manager.page, 'Согласовать', dialog => dialog.getByLabel('Обоснование').fill('Одобрен синтетический пилот.'));
  await page.reload();
  await mutation(page, 'Начать работу');
  await page.getByRole('tab', { name: 'План' }).click();
  await mutation(page, 'Статус', async dialog => {
    await dialog.getByLabel('Новый статус').selectOption('DONE');
    await dialog.getByLabel('Результат или причина').fill('Дополненный шаблон проверен.');
  });
  await page.getByRole('tab', { name: 'Результат' }).click();
  const iso = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 19);
  await mutation(page, 'Измерение', async dialog => {
    await dialog.getByLabel('Начало периода (UTC)').fill(iso(2));
    await dialog.getByLabel('Конец периода (UTC)').fill(iso(1));
    await dialog.getByLabel('Значение', { exact: true }).fill('50');
    await dialog.getByLabel('Размер выборки').fill('20');
    await dialog.getByLabel('Источник и способ сбора').fill('Тестовая выборка до изменения.');
  });
  await mutation(page, 'Зафиксировать внедрение', dialog => dialog.getByLabel('Что внедрено').fill('Подготовлена новая редакция шаблона.'));
  await mutation(page, 'Начать проверку');
  const record = await get<{ version: number; implementedAt: string }>(page, `/improvements/${id}`);
  await post(page, `/improvements/${id}/measurements`, { expectedVersion: record.version, phase: 'AFTER', value: 20,
    periodStart: record.implementedAt, periodEnd: new Date().toISOString(), sampleSize: 20, source: 'Тестовая выборка после изменения.' });
  await manager.page.reload();
  await manager.page.getByRole('tab', { name: 'Результат' }).click();
  await mutation(manager.page, 'Зафиксировать результат', async dialog => {
    await dialog.getByLabel('Вывод').fill('В тестовой выборке достигнут целевой показатель.');
    await dialog.getByLabel('Ограничения и доказательства').fill('Малая синтетическая выборка, причинность не проверялась.');
  });
  await page.reload();
  await mutation(page, 'Завершить улучшение');
  await expect(page.locator('.heading-line').getByText('Завершено', { exact: true })).toBeVisible();
  await manager.close();
});

test('E2E-06 radar uses live database counts and supports human review of a thematic link', async ({ page, browser }) => {
  await login(page, 'manager');
  const before = await get<{ total: number }>(page, '/radar/overview');
  const employee = await session(browser, 'employee');
  await create(employee.page, 'Обращение для радара ' + randomUUID().slice(0, 8));
  await page.reload();
  await expect(page.getByRole('link', { name: /Обращения.*Созданы в выбранном периоде/ })).toContainText(String(before.total + 1));
  await page.getByRole('tab', { name: 'Темы' }).click();
  const card = page.locator('.link-card').filter({ hasText: 'A-001' }).filter({ hasText: 'A-015' });
  await expect(card.getByText('Похожая тема', { exact: true })).toBeVisible();
  const state = card.getByText('Предложено', { exact: true });
  if (await state.isVisible()) {
    await card.getByRole('button', { name: 'Подтвердить связь' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
  }
  await expect(card.getByText('Подтверждено', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Просрочено/ }).click();
  await expect(page).toHaveURL(/tab=overdue/);
  await employee.close();
});

test('E2E-07 draft is private until approval and publishing, and employee reads edited content', async ({ page, browser }) => {
  await login(page, 'handler');
  const seeded = await get<{ items: { id: string; number: string }[] }>(page, '/improvements?q=DEMO-I-01');
  const path = '/improvements/' + seeded.items[0].id;
  await page.goto(path);
  await page.getByRole('tab', { name: 'Результат' }).click();
  const title = 'Обновлённая форма ' + randomUUID().slice(0, 8);
  await mutation(page, 'Подготовить публикацию', async dialog => {
    await dialog.getByLabel('Название').fill(title);
    await dialog.getByLabel('Что решали').fill('В учебном примере не хватало данных.');
    await dialog.getByLabel('Что изменили').fill('Уточнили требования к форме.');
    await dialog.getByLabel('Как проверили').fill('Сравнили две тестовые выборки.');
    await dialog.getByLabel('Результат', { exact: true }).fill('В тестовом примере уточнений стало меньше.');
    await dialog.getByLabel('Ограничения').fill('Использовались синтетические данные.');
    await dialog.getByLabel('Аудитория').selectOption('INTERNAL');
  });
  const employee = await session(browser, 'employee');
  await employee.page.goto('/changes');
  await employee.page.getByRole('textbox', { name: 'Поиск публикаций' }).fill(title);
  await expect(employee.page.getByText('Публикации не найдены')).toBeVisible();
  await employee.page.goto(path);
  await expect(employee.page.getByRole('heading', { name: 'Страница недоступна' })).toBeVisible();
  const manager = await session(browser, 'manager');
  await manager.page.goto(path);
  await manager.page.getByRole('tab', { name: 'Результат' }).click();
  const publication = manager.page.getByRole('button', { name: title, exact: true });
  const publicationRow = manager.page.locator('.task-row').filter({ has: publication });
  for (const [operation, status] of [['Согласовать публикацию', 'Согласовано'], ['Опубликовать', 'Опубликовано']]) {
    await publication.click();
    await manager.page.getByRole('dialog').getByRole('button', { name: operation, exact: true }).click();
    await expect(manager.page.getByRole('dialog')).toBeHidden();
    await expect(publicationRow.getByText(status, { exact: true })).toBeVisible();
  }
  await publication.click();
  await manager.page.getByText('Редакции публикации', { exact: true }).click();
  await expect(manager.page.getByText(/^Версия 3 ·/)).toBeVisible();
  await expect(manager.page.getByText(/^Версия 1 ·/)).toBeVisible();
  await employee.page.goto('/changes');
  await employee.page.getByRole('textbox', { name: 'Поиск публикаций' }).fill(title);
  await employee.page.getByRole('link', { name: title, exact: true }).click();
  await expect(employee.page.getByText('В тестовом примере уточнений стало меньше.', { exact: true })).toBeVisible();
  await manager.close();
  await employee.close();
});

test('E2E-08 private appeal is hidden from unrelated employee, manager and admin', async ({ page, browser }) => {
  await login(page, 'employee');
  const title = 'Чувствительная запись ' + randomUUID().slice(0, 8);
  const item = await create(page, title, 'RESTRICTED');
  for (const role of ['other', 'manager', 'admin'] as const) {
    const other = await session(browser, role);
    await other.page.goto('/appeals/' + item.id);
    await expect(other.page.getByRole('alert')).toContainText('недоступно');
    await expect(other.page.getByText(title)).toHaveCount(0);
    const found = await get<{ total: number }>(other.page, '/search?q=' + encodeURIComponent(title));
    expect(found.total).toBe(0);
    await other.close();
  }
});

test('E2E-09 inconclusive verification is presented as insufficient data', async ({ page }) => {
  await login(page, 'manager');
  const seeded = await get<{ items: { id: string }[] }>(page, '/improvements?q=DEMO-I-02');
  await page.goto('/improvements/' + seeded.items[0].id);
  await page.getByRole('tab', { name: 'Результат' }).click();
  await expect(page.getByText('Недостаточно данных', { exact: true })).toBeVisible();
  await expect(page.getByText('Данных для вывода об эффекте недостаточно.')).toBeVisible();
});

test('E2E-10 no Groq key leaves a working manual form', async ({ page }) => {
  await login(page, 'employee');
  await page.goto('/appeals/new?type=PROPOSAL');
  await page.getByLabel('Что вы хотите сообщить?').fill('Предлагаю улучшить учебный пример без подсказок.');
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page.getByText('Заполните детали вручную.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Подсказать заголовок' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Проверить и отправить' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page.locator('.heading-line').getByText('Новое', { exact: true })).toBeVisible();
});

test('E2E-11 second editor can reload after a version conflict', async ({ page, browser }) => {
  await login(page, 'employee');
  const item = await create(page, 'Проверка версий ' + randomUUID().slice(0, 8));
  const a = await session(browser, 'handler');
  const b = await session(browser, 'manager');
  await Promise.all([a.page.goto('/work-queue/appeals/' + item.id), b.page.goto('/work-queue/appeals/' + item.id)]);
  for (const editor of [a.page, b.page]) {
    await editor.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await expect(editor.getByRole('dialog')).toBeVisible();
    await editor.getByRole('dialog').getByLabel('Заголовок').fill('Заголовок из разных сессий');
  }
  await a.page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
  await expect(a.page.getByRole('dialog')).toBeHidden();
  await b.page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
  await expect(b.page.getByRole('alert')).toContainText('Данные изменились');
  await b.page.getByRole('button', { name: 'Обновить карточку' }).click();
  await expect(b.page.getByRole('alert')).toHaveCount(0);
  await b.page.getByRole('dialog').getByLabel('Заголовок').fill('Заголовок после обновления');
  await b.page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
  await expect(b.page.getByRole('heading', { name: 'Заголовок после обновления' })).toBeVisible();
  await Promise.all([a.close(), b.close()]);
});

test('E2E-12 responsive home and keyboard-operable submission at 360 px', async ({ page }, info) => {
  await login(page, 'employee');
  for (const width of [360, 768, 1280, 1600]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Сделаем работу удобнее' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Мои последние обращения' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 1280 || width === 360) await page.screenshot({ path: info.outputPath(`dashboard-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/appeals/new?type=PROBLEM');
  await page.getByRole('button', { name: 'Продолжить' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Опишите ситуацию');
  await page.getByLabel('Что вы хотите сообщить?').fill('Проверка мобильной формы с клавиатуры.');
  await page.getByRole('button', { name: 'Продолжить' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Проверить и отправить' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page.getByRole('heading', { name: /Проверка мобильной формы/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('a draft survives reload and reuses the submission after a lost response', async ({ page }) => {
  await login(page, 'employee');
  page.on('dialog', dialog => void dialog.accept());
  await page.goto('/appeals/new');
  const description = page.getByLabel('Что вы хотите сообщить?');
  await description.fill('Три');
  await page.reload();
  await expect(description).toHaveValue('Три');
  await description.fill('Проверка повторной подачи после потери ответа.');
  await page.getByRole('button', { name: 'Продолжить' }).click();
  const title = 'Повторная подача ' + randomUUID().slice(0, 8);
  await page.getByLabel('Заголовок').fill(title);
  await page.getByLabel('Вложения').setInputFiles({ name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('Контрольное вложение.') });
  await expect(page.getByText('sample.txt', { exact: true })).toBeVisible();
  let createdId: string | undefined;
  await page.route('**/api/v1/appeals', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    createdId = (await response.json()).data.id;
    await route.abort();
  }, { times: 1 });
  const submit = async () => {
    await page.getByRole('button', { name: 'Проверить и отправить' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Отправить обращение' }).click();
  };
  await submit();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  expect(createdId).toBeTruthy();
  await page.reload();
  await expect(page.getByLabel('Заголовок')).toHaveValue(title);
  await expect(page.getByText('sample.txt', { exact: true })).toBeVisible();
  await submit();
  await expect(page).toHaveURL(new RegExp('/appeals/' + createdId + '$'));
  const rows = await get<{ total: number }>(page, '/appeals?own=true&q=' + encodeURIComponent(title));
  expect(rows.total).toBe(1);
});
