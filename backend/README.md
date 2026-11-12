# Backend

- `src/` — NestJS API, доменная логика, политика доступа и worker (`src/worker.ts`).
- `src/contracts.ts` — исходник общих перечислений и подписей для API и клиента.
- `prisma/` — схема, миграции, демосид и исходные данные.
- `tests/` — модульные и интеграционные тесты.
- `deploy/` — конфигурации Compose для разработки и production.
- [Документация](docs/README.md) · [Исходное ТЗ](docs/reference/prompt.md)

После [локальной настройки](../README.md#backend) здесь можно выполнять `pnpm dev`, `pnpm worker`, `pnpm db:migrate`, `pnpm db:seed` и `pnpm test`. Серверные команды читают `backend/.env`. Относительный путь `STORAGE_DIR` отсчитывается от `backend/`.

При изменении `src/contracts.ts` скопируйте его в `frontend/src/contracts.ts`. CI проверяет совпадение обеих версий.

`WEB_ORIGIN` задаёт точный origin интерфейса для изменяющих запросов. `APP_TIMEZONE` задаёт часовой пояс расчёта сроков. Для создания первого администратора при запуске вне Docker используйте `pnpm db:admin` с переменными `BOOTSTRAP_ADMIN_EMAIL` и `BOOTSTRAP_ADMIN_PASSWORD`. Подключение подсказок описано в [настройках Groq](docs/GROQ_AI.md).
