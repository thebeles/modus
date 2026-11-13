import { expect, test, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('queue stays readable at 360 px, retains the search, and keeps dialog drafts separate', async ({ page, browser }) => {
  const employee = await session(browser, 'employee');
  const title = 'Проверка очереди ' + randomUUID().slice(0, 8);
  await create(employee.page, title);
  await employee.close();
  await login(page, 'handler');
  await page.setViewportSize({ width: 360, height: 820 });
  await page.getByRole('button', { name: 'Все', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Поиск по обращениям' });
  await search.fill(title);
  const table = page.getByRole('region', { name: 'Очередь обращений' });
  await expect(table.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  expect(await table.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await table.getByRole('link', { name: new RegExp(title) }).click();
  await page.getByRole('button', { name: 'Служебные заметки' }).click();
  await page.getByLabel('Заметка только для обработчиков').fill('Черновик служебной заметки');
  await page.getByRole('button', { name: 'Переписка с автором' }).click();
  await expect(page.getByLabel('Сообщение в общий диалог')).toHaveValue('');
  await page.getByLabel('Сообщение в общий диалог').fill('Черновик сообщения автору');
  await page.getByRole('button', { name: 'Служебные заметки' }).click();
  await expect(page.getByLabel('Заметка только для обработчиков')).toHaveValue('Черновик служебной заметки');
  const menu = page.getByRole('button', { name: 'Открыть навигацию' });
  await menu.focus();
  await menu.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Навигация' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await page.getByRole('link', { name: 'Очередь', exact: true }).click();
  await expect(search).toHaveValue(title);
});

test('keeps old workspace links and routes each role to its working views', async ({ page, browser }, info) => {
  await login(page, 'manager');
  await page.goto('/radar?origin=DEMO');
  await expect(page).toHaveURL(/overview\?origin=DEMO/);
  await expect(page.getByRole('heading', { name: 'Требует внимания' })).toBeVisible();
  const overdue = page.getByRole('link', { name: /^Просроченные обращения/ });
  await expect(overdue).toBeVisible();
  await page.setViewportSize({ width: 360, height: 900 });
  await expect(page.getByRole('heading', { name: /^Ожидают проверки/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.screenshot({ path: info.outputPath('overview-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: info.outputPath('overview-desktop.png'), fullPage: true, animations: 'disabled' });
  const urgent = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Срочно/ }) });
  const mine = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Нужно моё действие/ }) });
  const reviews = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Ожидают проверки/ }) });
  const urgentCase = urgent.getByRole('link', { name: /Поставщик ждёт уточнения по комплектации/ });
  await expect(urgentCase).toHaveAccessibleName(/^Рассмотреть обращение/);
  await urgentCase.click();
  await expect(page).toHaveURL(/#appeal-actions$/);
  await expect(page.getByRole('button', { name: 'Взять на рассмотрение', exact: true })).toBeVisible();
  await page.locator('.back-link').click();
  await expect(page).toHaveURL(/overview\?origin=DEMO/);
  await expect(mine.getByRole('link', { name: /Поставщик ждёт уточнения по комплектации/ })).toHaveCount(0);
  await expect(mine.getByRole('link', { name: /^Продолжить работу с проблемой/ }).first()).toBeVisible();
  await reviews.getByRole('link', { name: /^Проверить доказательства/ }).first().click();
  await expect(page.getByRole('tab', { name: 'Результат' })).toHaveAttribute('data-state', 'active');
  await expect(page.getByRole('button', { name: 'Зафиксировать результат', exact: true })).toBeVisible();
  await page.locator('.back-link').click();
  await urgent.getByRole('link', { name: 'Показать все срочные' }).click();
  await expect(page).toHaveURL(/tab=urgent/);
  await page.locator('.back-link').click();
  await expect(page).toHaveURL(/overview\?origin=DEMO/);
  await overdue.click();
  await expect(page).toHaveURL(/tab=overdue/);
  await page.getByRole('button', { name: /^Фильтры/ }).click();
  await expect(page.getByLabel('Происхождение карточки')).toHaveValue('DEMO');

  await page.goto('/problems?q=маршрут&page=2');
  await expect(page).toHaveURL(/\/improvements\?.*view=problems/);
  await expect(page.getByRole('textbox', { name: 'Поиск', exact: true })).toHaveValue('маршрут');
  await page.getByRole('link', { name: 'На проверке', exact: true }).click();
  await expect(page).toHaveURL(/view=review/);
  const verify = page.getByRole('checkbox', { name: 'Ожидают моей проверки' });
  await verify.press('Space');
  await expect(verify).toBeChecked();
  await expect(page).toHaveURL(/actionable=true/);

  const handler = await session(browser, 'handler');
  await expect(handler.page.getByRole('button', { name: 'Мои задачи', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await handler.page.getByRole('button', { name: 'Фильтры', exact: true }).click();
  await handler.page.getByLabel('Представление очереди').selectOption('stale');
  await expect(handler.page).toHaveURL(/tab=stale/);
  await handler.close();

  const admin = await session(browser, 'admin');
  await admin.page.getByRole('textbox', { name: 'Поиск сотрудников' }).fill('manager@demo.local');
  await expect(admin.page.getByRole('button', { name: /^Изменить:/ })).toHaveCount(1);
  await admin.page.getByRole('button', { name: /^Изменить:/ }).click();
  await expect(admin.page.getByRole('dialog').getByLabel('Электронная почта')).toHaveValue('manager@demo.local');
  await admin.page.keyboard.press('Escape');
  await admin.page.getByRole('link', { name: 'Обработка обращений' }).click();
  await expect(admin.page.getByRole('heading', { name: 'Категории' })).toBeVisible();
  await admin.page.getByRole('link', { name: 'Интеграции', exact: true }).click();
  await expect(admin.page.getByText('Демонстрационный симулятор', { exact: true })).toBeVisible();
  await admin.page.getByRole('link', { name: 'Контроль системы' }).click();
  await expect(admin.page.getByRole('heading', { name: 'Мониторинг' })).toBeVisible();
  await admin.page.getByRole('link', { name: 'Аудит', exact: true }).click();
  await expect(admin.page.getByRole('heading', { name: 'Аудит' })).toBeVisible();
  await admin.close();

  const employee = await session(browser, 'employee');
  await expect(employee.page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('link')).toHaveCount(3);
  await employee.page.goto('/admin/users');
  await expect(employee.page.getByRole('heading', { name: 'Страница недоступна' })).toBeVisible();
  const denied = await employee.page.request.get('/api/v1/admin/user-directory');
  expect(denied.status()).toBe(403);
  await employee.close();
});

test('finds an old transfer target beyond the first hundred through the dialog', async ({ page, browser }) => {
  test.skip(process.env.UX_FIXTURES !== 'true', 'Requires ux-fixtures.sql on an isolated E2E database');
  const employee = await session(browser, 'employee');
  const item = await create(employee.page, 'UX transfer ' + randomUUID().slice(0, 8));
  await employee.close();
  await login(page, 'handler');
  await page.goto('/work-queue/appeals/' + item.id);
  await mutation(page, 'Взять на рассмотрение', undefined, 'Подтвердить');
  await mutation(page, 'Закрыть с решением', async dialog => {
    await dialog.getByLabel('Тип решения').selectOption('TRANSFERRED');
    const select = dialog.getByLabel('Связанная запись');
    await expect(select.locator('option', { hasText: 'UX archived transfer target' })).toHaveCount(0);
    await dialog.getByLabel('Поиск цели по номеру или заголовку').fill('UX archived transfer target');
    await expect(select.locator('option', { hasText: 'UX archived transfer target' })).toHaveCount(1);
    await select.selectOption({ label: 'UX-0 · UX archived transfer target' });
    await dialog.getByLabel('Обоснование').fill('Контрольная передача старой записи.');
  });
  await expect(page.getByRole('heading', { name: 'Итог рассмотрения' })).toBeVisible();
});

test('opens the oldest unread notification beyond the first fifty', async ({ page }) => {
  test.skip(process.env.UX_FIXTURES !== 'true', 'Requires ux-fixtures.sql on an isolated E2E database');
  await login(page, 'employee');
  await page.goto('/notifications');
  const target = await get<{ items: { id: string }[] }>(page, '/appeals?own=true&q=UX%20archived%20transfer%20target');
  const href = '/appeals/' + target.items[0].id;
  const old = page.locator('main a').and(page.locator(`a[href="${href}"]`));
  await expect(old).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Только непрочитанные' }).check();
  await expect(old).toBeVisible();
  await old.click();
  await expect(page.getByRole('heading', { name: 'UX archived transfer target' })).toBeVisible();
  await page.goto('/notifications');
  await page.getByRole('checkbox', { name: 'Только непрочитанные' }).check();
  await expect(old).toHaveCount(0);
});

const profileNames = { employee: 'Сотрудник', manager: 'Руководитель', director: 'Директор', admin: 'Администратор' } as const;
type Profile = keyof typeof profileNames | 'handler' | 'other' | 'sensitive-handler';

async function login(page: Page, role: Profile) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  if (role === 'handler' || role === 'other' || role === 'sensitive-handler') {
    const response = await page.request.post('/api/v1/auth/demo', {
      headers: { Origin: new URL(page.url()).origin }, data: { profile: role === 'other' ? 'other-employee' : role },
    });
    expect(response.ok()).toBeTruthy();
    await page.reload();
  } else {
    await page.getByRole('button', { name: profileNames[role], exact: true }).press('Enter');
  }
  const landingPath = role === 'admin' ? '/admin/users' : role === 'manager' || role === 'director' ? '/overview' :
    role === 'handler' || role === 'sensitive-handler' ? '/work-queue' : '/';
  await expect(page).toHaveURL(url => url.pathname === landingPath);
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
  await expect.poll(async () => (await page.context().cookies(page.url())).some(cookie => cookie.name === 'modus_csrf')).toBe(true);
  if (landingPath === '/') await expect(page.getByLabel('Опишите проблему или предложите улучшение')).toBeVisible();
  else await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function session(browser: Browser, role: Profile) {
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

async function openAppealActions(page: Page, action: ReturnType<Page['getByRole']>) {
  const menu = page.getByText('Другие действия', { exact: true });
  if (!await action.isVisible() && await menu.isVisible()) await menu.click();
}

async function mutation(page: Page, name: string, fill?: (dialog: ReturnType<Page['getByRole']>) => Promise<void>, submit = 'Сохранить') {
  const button = page.getByRole('button', { name, exact: true });
  await openAppealActions(page, button);
  await button.click();
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
  await expect(page.getByText('История обращения', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Время рассмотрения' })).toHaveCount(0);
});

test('E2E-01 creates a real appeal and shows it to its author and the queue', async ({ page, browser }) => {
  await login(page, 'employee');
  const title = 'Проверка подачи ' + randomUUID().slice(0, 8);
  await page.goto('/');
  await page.getByLabel('Опишите проблему или предложите улучшение').fill(title + ' — не хватает данных в шаблоне заявки.');
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(title) })).toBeVisible();
  await expect(page.getByText(/A-\d+ · Проблема/)).toBeVisible();
  await page.goto('/my/appeals');
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  const handler = await session(browser, 'handler');
  await handler.page.getByRole('button', { name: 'Все', exact: true }).click();
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
  const note = 'Служебная заметка перед запросом уточнения.';
  let releaseComment = () => {};
  const holdComment = new Promise<void>(resolve => { releaseComment = resolve; });
  await handler.page.route(`**/api/v1/appeals/${item.id}/transition`, async route => {
    if (route.request().postDataJSON().action === 'COMMENT') await holdComment;
    await route.continue();
  });
  try {
    await handler.page.getByRole('button', { name: 'Служебные заметки' }).click();
    await handler.page.getByLabel('Заметка только для обработчиков').fill(note);
    await handler.page.getByRole('button', { name: 'Сохранить служебную заметку' }).click();
    const clarify = handler.page.getByRole('button', { name: 'Запросить уточнение' });
    await openAppealActions(handler.page, clarify);
    await expect(clarify).toBeDisabled();
  } finally {
    releaseComment();
  }
  await expect(handler.page.getByText(note, { exact: true })).toBeVisible();
  await handler.page.getByRole('button', { name: 'Переписка с автором' }).click();
  await mutation(handler.page, 'Запросить уточнение', async dialog => dialog.getByLabel('Вопрос автору').fill('Какой образец заявки вы заполняли?'));
  await page.goto('/notifications');
  await page.getByRole('link', { name: 'Запрошено уточнение', exact: true }).and(page.locator(`a[href="/appeals/${item.id}"]`)).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await mutation(page, 'Ответить на уточнение', async dialog => dialog.getByLabel('Ваш ответ').fill('Использовали тестовый образец заявки на оборудование.'));
  await handler.page.reload();
  await expect(handler.page.getByText('Использовали тестовый образец заявки на оборудование.', { exact: true })).toBeVisible();
  await expect(handler.page.locator('.heading-line').getByText('В работе', { exact: true })).toBeVisible();
  await handler.close();
});

test('a handler closes a fallback appeal with an explanation after the author replies', async ({ page, browser }) => {
  await login(page, 'employee');
  const item = await create(page, 'Характеристики оборудования ' + randomUUID().slice(0, 8));
  const handler = await session(browser, 'handler');
  await handler.page.goto('/work-queue/appeals/' + item.id);
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
  const conversation = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Обсуждение', exact: true }) });
  await expect(conversation.getByRole('button', { name: 'Ответить на уточнение', exact: true })).toBeVisible();
  await mutation(page, 'Ответить на уточнение', async dialog => {
    await dialog.getByLabel('Ваш ответ').fill('Чаще всего не хватает точной модели и срока поставки.');
  });

  await handler.page.reload();
  await expect(handler.page.locator('.heading-line').getByText('На рассмотрении', { exact: true })).toBeVisible();
  await openAppealActions(handler.page, close);
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
  const closeAction = manager.page.getByRole('button', { name: 'Закрыть с решением' });
  await openAppealActions(manager.page, closeAction);
  await closeAction.click();
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
  await page.getByText('Похожие обращения и источники', { exact: true }).click();
  const relatedLinks = page.locator('.link-pair a');
  await expect(relatedLinks.first()).toBeVisible();
  expect(await relatedLinks.evaluateAll(links => links.every(link => link.getBoundingClientRect().height >= 24))).toBe(true);
  const improvementLink = page.getByRole('link', { name: 'Создать улучшение' });
  await openAppealActions(page, improvementLink);
  await improvementLink.click();
  const title = 'Изменение шаблона ' + randomUUID().slice(0, 8);
  await page.getByLabel('Название', { exact: true }).fill(title);
  await page.getByLabel('Основание', { exact: true }).fill('В тестовом шаблоне не хватает полей.');
  await page.getByLabel('Цель изменения').fill('Уточнить состав данных в заявке.');
  await page.getByLabel('Область изменения').fill('Демонстрационная закупка');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const url = page.url();
  const id = new URL(url).pathname.split('/').pop()!;
  await page.getByRole('button', { name: 'Добавить источник' }).click();
  await page.getByRole('dialog').getByLabel('Номер или заголовок').fill('A-004');
  await page.getByRole('dialog').getByRole('button', { name: /A-004/ }).click();
  await page.getByRole('dialog').getByLabel('Основание связи').fill('Дополнительный синтетический сигнал.');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('link', { name: /A-004/ })).toBeVisible();
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
    await dialog.getByLabel('Значение', { exact: true }).fill('19');
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
  await manager.page.getByRole('button', { name: 'Зафиксировать результат', exact: true }).click();
  const invalidVerification = manager.page.getByRole('dialog');
  await invalidVerification.getByLabel('Вывод').fill('Порог достигнут, показатель вырос.');
  await invalidVerification.getByLabel('Ограничения и доказательства').fill('Учебный контрпример для проверки направления.');
  await invalidVerification.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(invalidVerification.getByText(/порог сам по себе не подтверждает улучшение/)).toBeVisible();
  await manager.page.keyboard.press('Escape');
  const current = await get<{ version: number }>(page, '/improvements/' + id);
  const day = 86400000;
  await post(page, `/improvements/${id}/measurements`, { expectedVersion: current.version, phase: 'BEFORE', value: 50,
    periodStart: new Date(Date.now() - 2 * day).toISOString(), periodEnd: new Date(Date.now() - day / 2).toISOString(),
    sampleSize: 20, source: 'Уточнённая учебная выборка до изменения.' });
  await manager.page.reload();
  await manager.page.getByRole('tab', { name: 'Результат' }).click();
  await mutation(manager.page, 'Зафиксировать результат', async dialog => {
    await dialog.getByLabel('Вывод').fill('В тестовой выборке достигнут целевой показатель.');
    await dialog.getByLabel('Ограничения и доказательства').fill('Малая синтетическая выборка, причинность не проверялась.');
  });
  await page.reload();
  await mutation(page, 'Завершить улучшение');
  await expect(page.locator('.heading-line').getByText('Завершено', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Обзор' }).click();
  const summary = page.locator('.initiative-summary');
  await expect(summary).toContainText('1 из 1');
  await expect(summary).toContainText('Внедрение');
  await expect(summary).toContainText('Владелец');
  await manager.close();
});

test('E2E-06 radar uses live database counts and supports human review of a thematic link', async ({ page, browser }) => {
  await login(page, 'manager');
  const before = await get<{ total: number }>(page, '/radar/overview');
  const employee = await session(browser, 'employee');
  await create(employee.page, 'Обращение для радара ' + randomUUID().slice(0, 8));
  await page.reload();
  await page.getByRole('link', { name: 'Аналитика', exact: true }).click();
  await expect(page.getByRole('link', { name: /Обращения.*Карточки выбранного происхождения и периода/ })).toContainText(String(before.total + 1));
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

test('registers in the browser before a route is available and assigns after recovery', async ({ page, browser }) => {
  const admin = await session(browser, 'admin');
  const queues = await get<{ id: string; name: string; visibility: string; fallback: boolean; coordinatorId: string; members: { userId: string }[] }[]>(admin.page, '/admin/work-queues');
  const fallback = queues.find(queue => queue.fallback && queue.visibility === 'NORMAL_INTERNAL')!;
  const configure = async (memberIds: string[]) => {
    const origin = new URL(admin.page.url()).origin;
    const csrf = (await admin.page.context().cookies()).find(cookie => cookie.name === 'modus_csrf')!.value;
    const response = await admin.page.request.patch('/api/v1/admin/work-queues/' + fallback.id, {
      headers: { Origin: origin, 'X-CSRF-Token': csrf },
      data: { name: fallback.name, visibility: fallback.visibility, fallback: true,
        coordinatorId: fallback.coordinatorId, memberIds },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const originalMembers = fallback.members.map(row => row.userId);
  await login(page, 'handler');
  await configure([]);
  try {
    const item = await create(page, 'Регистрация без маршрута ' + randomUUID().slice(0, 8));
    await page.goto('/appeals/' + item.id);
    await expect(page.getByText('Обращение зарегистрировано. Назначение будет повторено автоматически.')).toBeVisible();
    await expect(page.getByText(new RegExp(item.number + ' · Предложение'))).toBeVisible();
    await configure(originalMembers);
    await expect.poll(async () => (await get<{ routingPending: boolean }>(page, '/appeals/' + item.id)).routingPending, { timeout: 30000 }).toBe(false);
    await page.reload();
  } finally {
    await configure(originalMembers);
    await admin.close();
  }
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
  const publishedUrl = employee.page.url();
  await page.reload();
  await page.getByRole('tab', { name: 'Результат' }).click();
  await mutation(page, 'Запросить пересмотр', async dialog => {
    await dialog.getByLabel('Проверяющий').selectOption({ index: 1 });
    await dialog.getByLabel('Основание').fill('Нужна проверка границ интерпретации наблюдений.');
  });
  await manager.page.reload();
  await manager.page.getByRole('tab', { name: 'Результат' }).click();
  await mutation(manager.page, 'Утвердить новое заключение', async dialog => {
    await dialog.getByLabel('Итог').selectOption('INCONCLUSIVE');
    await dialog.getByLabel('Вывод').fill('Недостаточно данных для оценки эффекта.');
    await dialog.getByLabel('Ограничения и доказательства').fill('Учебная выборка без контрольной группы.');
  });
  await manager.page.getByText('Предыдущие заключения', { exact: true }).click();
  await expect(manager.page.getByRole('heading', { name: /Версия 1 ·/ })).toBeVisible();
  await employee.page.goto(publishedUrl);
  await expect(employee.page.getByRole('alert')).toContainText('недоступна');
  await page.reload();
  await page.getByRole('tab', { name: 'Результат' }).click();
  const correctedTitle = title + ' · уточнение';
  await mutation(page, 'Подготовить публикацию', async dialog => {
    await dialog.getByLabel('Название').fill(correctedTitle);
    await dialog.getByLabel('Что решали').fill('В учебном примере не хватало данных.');
    await dialog.getByLabel('Что изменили').fill('Уточнили требования к форме.');
    await dialog.getByLabel('Как проверили').fill('Повторно оценили данные учебного наблюдения.');
    await dialog.getByLabel('Результат', { exact: true }).fill('Недостаточно данных для оценки эффекта.');
    await dialog.getByLabel('Ограничения').fill('Контрольная группа отсутствовала.');
    await dialog.getByLabel('Аудитория').selectOption('INTERNAL');
  });
  await manager.page.reload();
  await manager.page.getByRole('tab', { name: 'Результат' }).click();
  const correctedPublication = manager.page.getByRole('button', { name: correctedTitle, exact: true });
  const correctedRow = manager.page.locator('.task-row').filter({ has: correctedPublication });
  for (const [operation, status] of [['Согласовать публикацию', 'Согласовано'], ['Опубликовать', 'Опубликовано']]) {
    await correctedPublication.click();
    await manager.page.getByRole('dialog').getByRole('button', { name: operation, exact: true }).click();
    await expect(correctedRow.getByText(status, { exact: true })).toBeVisible();
  }
  await employee.page.goto('/changes');
  await employee.page.getByRole('textbox', { name: 'Поиск публикаций' }).fill(correctedTitle);
  await employee.page.getByRole('link', { name: correctedTitle, exact: true }).click();
  await expect(employee.page.getByText('Недостаточно данных для оценки эффекта.')).toBeVisible();
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
  await expect(page.getByText('Недостаточно наблюдений для сравнения.')).toBeVisible();
  await expect(page.getByText('Наблюдений: 0', { exact: false })).toBeVisible();
});

test('author returns a result, then confirms the next revision from the appeal card', async ({ page, browser }, info) => {
  await login(page, 'employee');
  const item = await create(page, 'Проверка результата ' + randomUUID().slice(0, 8));
  const handler = await session(browser, 'handler');
  const path = '/appeals/' + item.id;
  await handler.page.goto('/work-queue' + path);
  await mutation(handler.page, 'Взять на рассмотрение', undefined, 'Подтвердить');
  const publish = (text: string) => mutation(handler.page, 'Закрыть с решением', async dialog => {
    await dialog.getByLabel('Обоснование').fill(text);
  });
  await publish('Перезапустили сервер, доступ восстановлен.');
  await page.goto(path);
  await page.getByRole('button', { name: 'Вернуть на доработку' }).click();
  await page.getByLabel('Что нужно доработать').fill('Сервер снова недоступен после перезапуска.');
  await page.getByRole('button', { name: 'Отправить на доработку' }).click();
  await expect(page.getByRole('status')).toContainText('Обращение возвращено в работу');
  await handler.page.reload();
  await publish('Восстановили сетевое соединение и проверили доступ.');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Подтвердить результат' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('result-review.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Подтвердить результат' }).click();
  await expect(page.getByText(/Автор подтвердил результат/).first()).toBeVisible();
  await handler.close();
});

test('E2E-10 no Groq key leaves a working manual form', async ({ page }) => {
  await login(page, 'employee');
  await page.goto('/appeals/new?type=PROPOSAL');
  await page.getByLabel('Опишите проблему или предложите улучшение').fill('Предлагаю улучшить учебный пример без подсказок.');
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
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
    await expect(page.getByLabel('Опишите проблему или предложите улучшение')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Мои последние обращения' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 1280 || width === 360) await page.screenshot({ path: info.outputPath(`dashboard-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/appeals/new?type=PROBLEM');
  const submit = page.getByRole('button', { name: 'Отправить обращение' });
  await submit.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Опишите ситуацию');
  await page.getByLabel('Опишите проблему или предложите улучшение').fill('Проверка мобильной формы с клавиатуры.');
  await submit.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /Проверка мобильной формы/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('a draft survives reload and reuses the submission after a lost response', async ({ page }) => {
  await login(page, 'employee');
  page.on('dialog', dialog => void dialog.accept());
  await page.goto('/appeals/new');
  const description = page.getByLabel('Опишите проблему или предложите улучшение');
  await description.fill('Три');
  await page.reload();
  await expect(description).toHaveValue('Три');
  const title = 'Повторная подача ' + randomUUID().slice(0, 8);
  await description.fill(title);
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
    await page.getByRole('button', { name: 'Отправить обращение' }).click();
  };
  await submit();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(createdId).toBeTruthy();
  await page.reload();
  await expect(description).toHaveValue(title);
  await expect(page.getByText('sample.txt', { exact: true })).toBeVisible();
  await submit();
  await expect(page).toHaveURL(new RegExp('/appeals/' + createdId + '$'));
  const rows = await get<{ total: number }>(page, '/appeals?own=true&q=' + encodeURIComponent(title));
  expect(rows.total).toBe(1);
});

test('demo login shows four roles and anonymous entry; director sees company analytics', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Директор', exact: true })).toBeVisible();
  for (const name of Object.values(profileNames)) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Сообщить анонимно' })).toBeVisible();
  await expect(page.getByLabel('Рабочая почта')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Обработчик', exact: true })).toHaveCount(0);
  await login(page, 'director');
  await expect(page.getByRole('heading', { name: 'Аналитика компании' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Процессы и подразделения' })).toBeVisible();
  await page.goto('/work-queue');
  await expect(page.getByRole('heading', { name: 'Очередь' })).toBeVisible();
});

test('guest submits and tracks a private appeal without signing in', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Сообщить анонимно' }).click();
  await expect(page.getByRole('heading', { name: 'Анонимное обращение' })).toBeVisible();
  const title = 'Анонимный канал ' + randomUUID().slice(0, 8);
  await page.getByLabel('Заголовок').fill(title);
  await page.getByLabel('Сообщение', { exact: true }).fill('Описание для закрытого диалога.');
  await page.getByLabel('Вложение').setInputFiles({ name: 'evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('Текстовое вложение.') });
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  const secret = await page.getByLabel('Токен доступа').inputValue();
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const handler = await session(browser, 'sensitive-handler');
  await handler.page.getByRole('textbox', { name: 'Поиск по обращениям' }).fill(title);
  await handler.page.getByRole('link', { name: new RegExp(title) }).click();
  await expect(handler.page.getByText('Описание для закрытого диалога.', { exact: true })).toBeVisible();
  await handler.page.getByLabel('Сообщение в общий диалог').fill('Ответ из специальной очереди.');
  await handler.page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(handler.page.getByText('Ответ из специальной очереди.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Проверить статус' }).click();
  await page.getByLabel('Токен доступа').fill(secret);
  await page.getByRole('button', { name: 'Проверить статус' }).last().click();
  await expect(page.getByText('Ответ из специальной очереди.', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать текстовое вложение' }).click();
  expect((await download).suggestedFilename()).toBe('attachment.txt');
  await handler.close();
});

test('an employee discusses a proposal and the owner converts it to a draft', async ({ page, browser }) => {
  await login(page, 'employee');
  await page.getByRole('link', { name: 'Мои обращения', exact: true }).click();
  await page.getByRole('link', { name: 'Предложения подразделения', exact: true }).click();
  const title = 'Идея команды ' + randomUUID().slice(0, 8);
  await page.getByRole('button', { name: 'Новое предложение' }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Название').fill(title);
  await createDialog.getByLabel('Что предлагаете изменить').fill('Сделать форму заказа короче.');
  await createDialog.getByRole('button', { name: 'Опубликовать' }).click();
  const proposal = page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });
  await proposal.getByRole('button', { name: /Голосовать/ }).click();
  await expect(proposal.getByRole('button', { name: /Убрать голос · 1/ })).toBeVisible();
  await proposal.getByRole('button', { name: /Обсуждение/ }).click();
  await page.getByRole('dialog').getByLabel('Комментарий').fill('Готов помочь с пилотной проверкой.');
  await page.getByRole('dialog').getByRole('button', { name: 'Добавить комментарий' }).click();
  await expect(page.getByText('Готов помочь с пилотной проверкой.', { exact: true })).toBeVisible();
  const handler = await session(browser, 'handler');
  await handler.page.locator('.account-menu > summary').click();
  await handler.page.getByRole('link', { name: 'Мои обращения', exact: true }).click();
  await handler.page.getByRole('link', { name: 'Предложения подразделения', exact: true }).click();
  const row = handler.page.locator('section').filter({ has: handler.page.getByRole('heading', { name: title }) });
  await row.getByRole('button', { name: 'Создать инициативу' }).click();
  const conversion = handler.page.getByRole('dialog');
  await conversion.getByLabel('Цель изменения').fill('Сократить время заполнения заказа.');
  await conversion.getByLabel('Область изменения').fill('Закупки');
  await conversion.getByRole('button', { name: 'Создать черновик' }).click();
  await expect(handler.page.getByRole('heading', { name: title })).toBeVisible();
  await expect(handler.page.getByText('Проверка результата', { exact: true })).toBeVisible();
  await handler.close();
});

test('manager can import client feedback', async ({ page }) => {
  await login(page, 'manager');
  await page.goto('/work-queue');
  await page.getByRole('link', { name: 'Клиентские отзывы' }).click();
  const title = 'Опоздание доставки ' + randomUUID().slice(0, 8);
  await page.getByRole('button', { name: 'Импортировать CSV' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Файл CSV').setInputFiles({ name: 'reviews.csv', mimeType: 'text/csv',
    buffer: Buffer.from('date,title,body\n2026-11-10,' + title + ',Курьер задержал доставку.') });
  await dialog.getByRole('button', { name: 'Импортировать', exact: true }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText(/Добавлено: 1/)).toBeVisible();
});
