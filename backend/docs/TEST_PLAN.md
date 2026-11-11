# Проверки

`pnpm lint`, `pnpm typecheck`, `pnpm test` и `pnpm build` выполняются из корня проекта. Модульные проверки используют Node test runner и tsx. Интеграционный тест запускает настоящий NestJS и PostgreSQL. Playwright запускает отдельные API, Vite и worker и открывает Chromium. Для автоматических проверок нужен Chromium из `pnpm --filter @kontur/web exec playwright install chromium`.

Создайте две пустые базы. Команды ниже подходят для локального Compose.

```sh
docker compose up -d postgres
docker compose exec -T postgres psql -U modus -d postgres -c 'CREATE DATABASE kontur_integration' -c 'CREATE DATABASE kontur_e2e'
```

PowerShell:

```powershell
$env:DATABASE_URL = 'postgresql://modus:modus_dev@localhost:5432/kontur_integration?schema=public'
$env:TEST_DATABASE_URL = $env:DATABASE_URL
pnpm db:migrate
pnpm db:seed
pnpm db:seed
pnpm test:integration

$env:DATABASE_URL = 'postgresql://modus:modus_dev@localhost:5432/kontur_e2e?schema=public'
$env:E2E_DATABASE_URL = $env:DATABASE_URL
pnpm db:migrate
pnpm db:seed
pnpm test:e2e
```

В POSIX shell используйте `export DATABASE_URL='…'` и соответствующие `export TEST_DATABASE_URL="$DATABASE_URL"` или `export E2E_DATABASE_URL="$DATABASE_URL"`. Проверьте, что `.env` содержит `DEMO_MODE=true` и `SEED_DEMO_USERS=true`. Если тесты выполняются в новой оболочке, задайте эти две переменные явно либо скопируйте `.env.example`.

Браузерные тесты проверяют E2E-01…12. Скриншоты на 360 и 1280 px записываются в `frontend/test-results`. Тесты сохраняют созданные объекты в изолированной базе. Для воспроизводимого прогона с исходным состоянием используйте свежую тестовую базу.
