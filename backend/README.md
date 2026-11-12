# Backend

- `src/` — NestJS API, доменная логика, политика доступа и worker (`src/worker.ts`).
- `src/contracts.ts` — публичный контракт `@modus/api/contracts`, который использует клиент.
- `prisma/` — схема, миграции, демосид и исходные данные.
- `tests/` — модульные и интеграционные тесты.
- [Документация](docs/README.md) · [Исходное ТЗ](docs/reference/prompt.md)

После [общей настройки](../README.md#локальная-разработка) здесь можно выполнять `pnpm dev`, `pnpm worker`, `pnpm db:migrate`, `pnpm db:seed` и `pnpm test`. Серверные команды подхватывают общий `.env` из корня. Относительный путь `STORAGE_DIR` отсчитывается от корня репозитория.
