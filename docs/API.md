# REST API

Префикс /api/v1. [Swagger локального запуска](http://localhost:4000/api/v1/docs), [OpenAPI JSON](http://localhost:4000/api/v1/openapi.json). Swagger доступен в режиме разработки. Для запроса через Swagger сначала откройте интерфейс и войдите, затем передайте Origin и CSRF в клиенте, который может их установить.

JSON-ответы используют `{ data, requestId }` и `{ error: { code, message, details }, requestId }`. CSV и загрузки возвращают содержимое с Content-Disposition. Невидимые записи дают 404. 409 обозначает конфликт версии, недопустимый переход или конфликт данных.

| Ресурс | Основные операции |
|---|---|
| /auth | login, demo, me, refresh, logout, change-password |
| /appeals и /work-queue | поиск и фильтры, карточка, изменение, переходы, назначения, диалог, события |
| /problems и /object-links | наблюдения, источники, переходы, предложения и решения о связях |
| /improvements | управление стадиями, задачи, согласование, измерения, верификация, приглашения |
| /radar и /analytics | агрегаты, внимание, процессы, темы, результаты, ограниченный CSV |
| /publications | библиотека, черновики, согласование, выпуск и отзыв |
| /admin | структура, доступ, классификаторы, маршрутизация, сроки, аудит и сбои доставки |
| /notifications и /notification-preferences | список, прочтение, настройка подтверждения регистрации |
| /attachments | multipart upload и проверяемое скачивание |
| /ai | возможности, четыре вида подсказок |

POST /appeals принимает `Idempotency-Key` и объект с полями `type`, `description`, необязательными `title`, `categoryId`, `processId`, `proposedSolution`, `attachmentIds` и `visibility`. Повтор с тем же телом возвращает прежний ID. Новое тело с уже использованным ключом возвращает 409.

Например, POST /appeals/:id/transition принимает `{ "expectedVersion": 1, "action": "REVIEW" }`. Доступные действия вычисляет сервер. Изменяющие запросы с сессией требуют заголовка `X-CSRF-Token` со значением cookie `kontur_csrf` и совпадения Origin. Страницы списков используют `page` и `limit` с максимумом 100. Экспорт ограничен 1000 строками.
