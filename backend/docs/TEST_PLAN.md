# Проверки

`pnpm lint`, `pnpm typecheck`, `pnpm test` и `pnpm build` доступны в каждом проекте. Интеграционные тесты используют NestJS и PostgreSQL. Playwright запускает отдельные API, Vite и worker для тестовой базы. Установите зависимости обоих проектов и Chromium командой `pnpm -C frontend exec playwright install chromium`.

Создайте две пустые базы. Команды ниже выполняются из корня репозитория.

```sh
docker compose -f backend/deploy/docker-compose.yml up -d postgres
docker compose -f backend/deploy/docker-compose.yml exec -T postgres psql -U modus -d postgres -c 'CREATE DATABASE modus_integration' -c 'CREATE DATABASE modus_e2e'
```

PowerShell:

```powershell
$env:DATABASE_URL = 'postgresql://modus:modus_dev@localhost:5432/modus_integration?schema=public'
$env:TEST_DATABASE_URL = $env:DATABASE_URL
pnpm -C backend db:migrate
pnpm -C backend db:seed
pnpm -C backend db:seed
pnpm -C backend test:integration

$env:DATABASE_URL = 'postgresql://modus:modus_dev@localhost:5432/modus_e2e?schema=public'
$env:E2E_DATABASE_URL = $env:DATABASE_URL
pnpm -C backend db:migrate
pnpm -C backend db:seed
pnpm -C frontend test:e2e
```

В POSIX shell используйте `export DATABASE_URL='…'` и соответствующие `export TEST_DATABASE_URL="$DATABASE_URL"` или `export E2E_DATABASE_URL="$DATABASE_URL"`. Проверьте, что `backend/.env` содержит `DEMO_MODE=true` и `SEED_DEMO_USERS=true`. Если тесты выполняются в новой оболочке, задайте эти две переменные явно либо скопируйте `backend/.env.example` в `backend/.env`.

Браузерные тесты проверяют E2E-01…12. Скриншоты на 360 и 1280 px записываются в `frontend/test-results`. Тесты сохраняют созданные объекты в изолированной базе. Для воспроизводимого прогона с исходным состоянием используйте свежую тестовую базу.

Для тестирования уже запущенного демостенда укажите `E2E_BASE_URL` и запустите `pnpm -C frontend test:e2e`. Используйте стенд с отдельными демоданными, так как сценарии записывают изменения в базу.
