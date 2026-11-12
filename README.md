# До результата

Внутренний сервис обратной связи. Сотрудник подаёт обращение и получает ответ. Обработчики исследуют повторяющиеся сигналы, ведут инициативы, проверяют эффект и публикуют согласованные результаты.

- [backend/](backend/README.md) — NestJS API, worker, Prisma, миграции и серверные тесты.
- [frontend/](frontend/README.md) — React, Vite, Nginx и браузерные тесты.
- [backend/deploy/](backend/deploy) — конфигурации Docker Compose.
- [.github/workflows/](.github/workflows) — проверки GitHub Actions.

## Запуск в Docker

Для конкурсного показа с отдельными томами используйте [демостенд и сценарий защиты](docs/DEMO_RUNBOOK.md).

Установите Docker Engine с Docker Compose и выполните из корня репозитория:

```sh
docker compose -f backend/deploy/docker-compose.yml up --build -d --wait
```

Compose запускает PostgreSQL, применяет миграции и загружает демоданные, затем запускает API, worker и Nginx. Имена проекта и томов прежние. На экране [веб-приложения](http://localhost:5173) можно выбрать демо-профиль. Для ручного входа используйте адрес профиля из [демосценария](backend/docs/DEMO_SCRIPT.md) и пароль новой локальной установки `Modus-Demo-2026!`. Для существующих аккаунтов действует пароль, заданный при создании.

[Готовность API](http://localhost:4000/api/v1/health/ready) · [Swagger](http://localhost:4000/api/v1/docs) · [Production и параметры запуска](backend/docs/OPERATIONS.md)

Чтобы передать Compose настройки демостенда из `backend/.env`, добавьте `--env-file backend/.env` перед `-f`.

## Локальная разработка

Для каждого проекта нужны Node.js 24 и pnpm 11.25.0. Каждый проект устанавливает зависимости по своему lockfile.

### Backend

Запустите PostgreSQL командой `docker compose -f backend/deploy/docker-compose.yml up -d postgres` из корня или используйте свой PostgreSQL 17. В `backend/` скопируйте `.env.example` в `.env` и проверьте `DATABASE_URL`. В этой же директории выполните:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Запустите `pnpm worker` из `backend/` в отдельном терминале для фоновых задач.

### Frontend

В `frontend/` скопируйте `.env.example` в `.env`, затем выполните:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Vite слушает порт 5173 и проксирует `/api` на `http://127.0.0.1:4000`. При смене `VITE_PORT` обновите `WEB_ORIGIN` в backend. Адрес API задаёт `MODUS_API_TARGET`.

## Сборка и тесты

В каждой директории приложения доступны `pnpm lint`, `pnpm typecheck`, `pnpm build` и `pnpm test`. В backend `pnpm test` запускает доменные тесты. Во frontend команда запускает Playwright. Подготовка тестовых баз, интеграционные и нагрузочные проверки описаны в [тест-плане](backend/docs/TEST_PLAN.md).

[Документация проекта](backend/docs/README.md)
