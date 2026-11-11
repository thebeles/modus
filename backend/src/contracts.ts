export const appealTypes = ['PROBLEM', 'PROPOSAL', 'POSITIVE_FEEDBACK'] as const;
export const priorities = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const visibilities = ['NORMAL_INTERNAL', 'RESTRICTED', 'SPECIAL'] as const;
export const appealStatuses = ['NEW', 'REVIEW', 'WAITING_AUTHOR', 'IN_PROGRESS', 'CLOSED', 'WITHDRAWN'] as const;
export const resolutions = ['RESOLVED', 'ACCEPTED_FOR_IMPROVEMENT', 'EXPLANATION_PROVIDED', 'REJECTED', 'ALREADY_ADDRESSED', 'LINKED_TO_EXISTING_CASE', 'TRANSFERRED', 'POSITIVE_FEEDBACK_RECORDED', 'INSUFFICIENT_INFO'] as const;
export const problemStatuses = ['CANDIDATE', 'INVESTIGATING', 'CONFIRMED', 'DISPROVED', 'CLOSED'] as const;
export const improvementStatuses = ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'DEFERRED', 'REJECTED', 'IN_PROGRESS', 'IMPLEMENTED', 'VERIFYING', 'COMPLETED', 'CANCELED'] as const;
export const actionStatuses = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELED'] as const;
export const outcomes = ['VERIFIED', 'PARTIAL', 'NOT_ACHIEVED', 'INCONCLUSIVE'] as const;
export const relations = ['SIMILAR_TOPIC', 'POSSIBLE_DUPLICATE', 'CONFIRMED_SAME_ISSUE', 'RELATED_CONTEXT'] as const;
export const roles = ['EMPLOYEE', 'HANDLER', 'MANAGER', 'ADMIN'] as const;
export const permissions = ['ROUTING_COORDINATOR', 'PROBLEM_OWNER', 'IMPROVEMENT_OWNER', 'IMPROVEMENT_APPROVER', 'RESULT_VERIFIER', 'PUBLICATION_APPROVER', 'SENSITIVE_CASE_HANDLER', 'EXPORT_DATA'] as const;
export const feedbackChoices = ['YES', 'PARTLY', 'NO', 'CANNOT_ASSESS'] as const;

export const labels: Record<string, string> = {
  PROBLEM: 'Проблема', PROPOSAL: 'Предложение', POSITIVE_FEEDBACK: 'Положительный отзыв',
  LOW: 'Низкий', MEDIUM: 'Средний', HIGH: 'Высокий',
  NORMAL_INTERNAL: 'Обычный доступ', RESTRICTED: 'Ограниченный доступ', SPECIAL: 'Специальная очередь',
  NEW: 'Новое', REVIEW: 'На рассмотрении', WAITING_AUTHOR: 'Ожидает уточнения', IN_PROGRESS: 'В работе', CLOSED: 'Закрыто', WITHDRAWN: 'Отозвано',
  CANDIDATE: 'Гипотеза', INVESTIGATING: 'Исследуется', CONFIRMED: 'Подтверждено', DISPROVED: 'Не подтвердилось',
  DRAFT: 'Черновик', UNDER_REVIEW: 'На согласовании', APPROVED: 'Согласовано', DEFERRED: 'Отложено', REJECTED: 'Отклонено',
  IMPLEMENTED: 'Внедрено', VERIFYING: 'Проверка эффекта', COMPLETED: 'Завершено', CANCELED: 'Отменено',
  TODO: 'К выполнению', BLOCKED: 'Заблокировано', DONE: 'Выполнено', VERIFIED: 'Подтверждён', PARTIAL: 'Частичный эффект', NOT_ACHIEVED: 'Цель не достигнута', INCONCLUSIVE: 'Недостаточно данных',
  EXPECTED: 'Ожидаемый эффект', PRELIMINARY: 'Предварительный результат',
  EMPLOYEE: 'Сотрудник', HANDLER: 'Обработчик', MANAGER: 'Руководитель', ADMIN: 'Администратор',
  RESOLVED: 'Решено', ACCEPTED_FOR_IMPROVEMENT: 'Принято к улучшению', EXPLANATION_PROVIDED: 'Дано пояснение',
  ALREADY_ADDRESSED: 'Уже решено', LINKED_TO_EXISTING_CASE: 'Связано с существующим обращением', TRANSFERRED: 'Передано',
  POSITIVE_FEEDBACK_RECORDED: 'Отзыв передан', INSUFFICIENT_INFO: 'Недостаточно информации',
  SIMILAR_TOPIC: 'Похожая тема', POSSIBLE_DUPLICATE: 'Возможный дубль', CONFIRMED_SAME_ISSUE: 'Один и тот же случай',
  RELATED_CONTEXT: 'Общий контекст', ADDRESSED_BY_IMPROVEMENT: 'Решается улучшением', POSSIBLE_RECURRENCE: 'Возможное повторение',
  SUGGESTED: 'Предложено', PUBLISHED: 'Опубликовано', RETRACTED: 'Отозвано',
  YES: 'Да', PARTLY: 'Частично', NO: 'Нет', CANNOT_ASSESS: 'Не могу оценить',
  QUANTITATIVE: 'Количественная', QUALITATIVE: 'Качественная', MIXED: 'Смешанная',
  DECREASE: 'Снижение', INCREASE: 'Рост', TARGET: 'Целевое значение',
  BEFORE: 'До внедрения', AFTER: 'После внедрения',
  CREATED: 'Запись создана', EDITED: 'Редакция изменена', CHANGES_REQUESTED: 'Запрошены правки', REGISTRATION_CONFIRMED: 'Обращение зарегистрировано', UPDATED: 'Данные обновлены', ASSIGNED: 'Ответственный назначен', TRANSFER_RECEIVED: 'Получено переданное обращение', REROUTED: 'Маршрут обращения изменён', PUBLICATION_CHANGES_REQUESTED: 'Запрошены правки публикации',
  ROUTING_FALLBACK: 'Направлено в резервную очередь', CLARIFICATION: 'Запрошено уточнение',
  AUTHOR_RESPONSE: 'Автор ответил', COMMENT: 'Новое сообщение', INTERNAL_NOTE: 'Служебная заметка',
  RESOLVED_EVENT: 'Зафиксировано решение', REVIEW_REQUEST: 'Запрошен пересмотр', REVIEW_DECISION: 'Решение о пересмотре',
  SLA_DUE: 'Приближается срок действия', SLA_OVERDUE: 'Срок действия истёк',
  FIRST_RESPONSE_DUE: 'Приближается срок ответа', FIRST_RESPONSE_OVERDUE: 'Срок ответа истёк',
  FINDING: 'Добавлено наблюдение', ACTION: 'Изменена задача', MEASUREMENT: 'Записано измерение',
  MEASUREMENT_PLAN: 'План проверки обновлён', VERIFICATION: 'Результат проверен',
  FEEDBACK_INVITED: 'Оцените результат изменения', FEEDBACK_SUBMITTED: 'Получена обратная связь',
  CLARIFICATION_REMINDER: 'Напоминание об уточнении', WITHDRAWAL_REQUEST: 'Запрошен отзыв', SOURCE_LINKED: 'Добавлен источник',
  VERIFICATION_SUPERSEDED: 'Результат отправлен на доработку', EXPORT: 'Выполнена выгрузка',
};

export function label(value: string) {
  return labels[value] ?? value;
}
