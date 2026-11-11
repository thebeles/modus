# Модус · Контур

Внутренний сервис обратной связи. Сотрудник подаёт обращение и получает ответ. Обработчики исследуют повторяющиеся сигналы, ведут инициативы, проверяют эффект и публикуют согласованные результаты.

## Запуск в Docker

Нужны Docker Engine и Docker Compose.

```sh
docker compose up --build
```

- [Веб-приложение](http://localhost:5173)
- [Проверка готовности API](http://localhost:4000/api/v1/health/ready)
- [Swagger](http://localhost:4000/api/v1/docs)

Compose запускает PostgreSQL, применяет миграции и загружает демоданные, затем запускает API, worker и Nginx. Каталог вложений и база сохраняются в отдельных томах. Порты опубликованы на loopback.

## Демо

На экране входа выберите профиль. Для ручного входа все перечисленные учётные записи используют локальный пароль `Kontur-Demo-2026!`.

| Профиль | Адрес |
|---|---|
| Сотрудник | `employee@demo.local` |
| Обработчик | `handler@demo.local` |
| Руководитель | `manager@demo.local` |
| Администратор | `admin@demo.local` |
| Другой сотрудник | `other-employee@demo.local` |
| Обработчик специальной очереди | `sensitive-handler@demo.local` |

Двадцать исходных обращений A-001…A-020 и дополнения `DEMO-*` синтетические. Цифры в радаре вычисляются из доступных записей базы. Демо-вход и демосид отключены при `NODE_ENV=production`. Сценарий показа описан в [DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## Локальная разработка

Установите Node.js 24 и pnpm 11.25.0, например через Corepack. Скопируйте `.env.example` в `.env`. Запустите PostgreSQL через Compose либо укажите строку подключения к своему PostgreSQL 17.

```sh
docker compose up -d postgres
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Команда `pnpm dev` запускает Vite на порту 5173, API на 4000 и worker. Если Compose уже запустил весь стек, освободите порты API и web перед локальным запуском.

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Для интеграционных и браузерных проверок используйте отдельные базы. Подготовка и команды для PowerShell и POSIX описаны в [TEST_PLAN.md](docs/TEST_PLAN.md).

## Настройки

- `WEB_ORIGIN` — точный origin интерфейса для проверки изменяющих запросов. В продуктивной среде требуется HTTPS.
- `APP_TIMEZONE` — календарь сроков API, по умолчанию `Asia/Almaty`. В базе используются даты UTC.
- `STORAGE_DIR` — закрытый каталог для вложений.
- `GROQ_AI_ENABLED` и `GROQ_API_KEY` включают необязательные подсказки. Без ключа обращения, улучшения, радар и библиотека работают через обычные формы и поиск.
- Для первого администратора вне деморежима предусмотрена команда `pnpm db:admin`. Подробнее в [OPERATIONS.md](docs/OPERATIONS.md).

[Документация](docs/README.md) · [Статус требований](docs/TRACEABILITY.md) · [План и результаты проверок](docs/IMPLEMENTATION_PLAN.md)
