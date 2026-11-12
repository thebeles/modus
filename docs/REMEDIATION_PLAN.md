# План исправлений «Модус · Контур»

Исходная точка — `bd1a79a69543e1aea5639bd80684c9ac2e732016`, ветка исправлений `codex/remediation`. [Отчёт исходного аудита](AUDIT_REPORT.md) сохранён. Базовый прогон зафиксирован в C5 исходного отчёта: 8 доменных, 18 интеграционных и 15 браузерных тестов. Проверки исправлений выполняются в отдельных базах PostgreSQL на синтетических данных.

| ID | Проблема | Приоритет | Зависимости | Статус | Изменённые файлы | Проверка |
|---|---|---|---|---|---|---|
| D01 | Регистрация зависит от маршрута | P0 | Схема, политика доступа, worker | VERIFIED | schema, pending_routing, routing.ts, appeals.ts, worker.ts, policy.ts, admin, UI | HTTP, PostgreSQL, перезапуск API, два worker, Playwright |
| D03 | Синтетические данные в KPI | P0 | Миграция происхождения, seed и фильтры | VERIFIED | evidence_origin, verification_origin, seed.ts, appeals.ts, radar.ts, UI | Сверка 20 строк, API, CSV и SQL |
| D04 | Актор синтетического отказа A-017 | P0 | D03, адресная корректировка журнала до D14 | VERIFIED | evidence_origin, seed.ts, integration.test.ts | Акторы и даты после двух seed |
| D06 | Достижение порога считается улучшением | P0 | Модель наблюдения и заключения | VERIFIED | effect.ts, cases.ts, verification_effect, карточка улучшения | Пять пар значений, интеграция, Playwright |
| D02 | Следующее действие вычисляется из статуса | P1 | D01, события и SLA | VERIFIED | next_action, appeals.ts, schema, карточка и Compose | Ревизии ROUTING → TRIAGE, уточнение и сроки |
| D05 | Выбор цели ограничен первой сотней | P1 | Политика допустимости передачи | VERIFIED | appeals.ts, appeals.tsx, integration.test.ts | Поиск после 101 более новой записи |
| D09 | Старая история уведомлений недоступна | P1 | Пользовательская область и пагинация | VERIFIED | notifications.ts, shell.tsx, contracts, integration.test.ts | 51 уведомление, обновление списка в Chromium |
| D10 | Радар сортирует внимание по сроку | P1 | D02, объяснимые признаки | VERIFIED | radar.ts, radar.tsx, integration.test.ts | Единичный высокий приоритет и переход |
| D07 | Один прямой источник улучшения | P1 | Объектные права, история и обратная связь | VERIFIED | cases.ts, policy.ts, appeals.ts, карточка улучшения | Два источника, адресные отзывы, отвязка |
| D08 | Разные области KPI и экспорта | P1 | D03, согласование малых срезов | IMPLEMENTED | radar.ts, appeals.ts, verification_origin и UI | SQL/API/CSV прошли, корпоративная политика групп открыта |
| D11 | Нет ревизий завершённого заключения | P1 | D06, проверяющий и редакционный процесс | VERIFIED | verification_amendments, cases.ts, карточка улучшения | Независимое решение, история, отзыв публикации |
| D13 | Сканирование файлов выключено в production | P0 до пилота | ClamD и политика файлов | IMPLEMENTED | attachment_scan, files.ts, attachment-scan.ts, мониторинг | Fail-closed на подмене, живой ClamD не проверен |
| D14 | Изменяемость аудита зависит от DB-ролей | P0 до пилота | D04, runtime и мигратор | VERIFIED | append_only_audit, runtime-grants.sql, OPERATIONS.md | Приложение под runtime-ролью и запреты в PostgreSQL |
| D15 | Жизненный цикл и бюджет AI | P2 | Модель подсказки и scope организации | IMPLEMENTED | ai_suggestions, ai.ts, worker.ts, Groq UI и Compose | Интеграция с подменой, живой Groq не проверен |
| D12 | Неполный план пилота и развития | P0 до защиты | Фактические результаты исправлений | VERIFIED | PILOT_PLAN.md, ARCHITECTURE.md, OPERATIONS.md | Сверено с ТЗ 3.1, 3.4, 3.6 и 4.1 |
