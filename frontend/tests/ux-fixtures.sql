-- Load only into a disposable E2E database with the demo seed.
INSERT INTO "Appeal" (id, number, title, description, "descriptionOriginal", "authorId", "departmentId", "queueId", type, "createdAt", "updatedAt", "isSynthetic")
SELECT gen_random_uuid()::text, 'UX-' || n, CASE WHEN n = 0 THEN 'UX archived transfer target' ELSE 'UX recent fixture' END,
  'Synthetic UX test fixture', 'Synthetic UX test fixture', u.id, u."departmentId", q.id, 'PROBLEM',
  CASE WHEN n = 0 THEN TIMESTAMP '2025-01-01' ELSE CURRENT_TIMESTAMP END, CURRENT_TIMESTAMP, true
FROM generate_series(0,101) n
JOIN "User" u ON u.email = 'employee@demo.local'
JOIN "WorkQueue" q ON q.fallback AND q.visibility = 'NORMAL_INTERNAL'
ON CONFLICT (number) DO NOTHING;

INSERT INTO "Notification" (id, key, "userId", kind, href, "readAt", "createdAt")
SELECT gen_random_uuid()::text, 'ux-history-' || n, a."authorId", 'REGISTRATION_CONFIRMED',
  CASE WHEN n = 0 THEN '/appeals/' || a.id END,
  CASE WHEN n > 0 THEN CURRENT_TIMESTAMP END,
  CASE WHEN n = 0 THEN TIMESTAMP '2025-01-01' ELSE CURRENT_TIMESTAMP END
FROM generate_series(0,50) n JOIN "Appeal" a ON a.number = 'UX-0'
ON CONFLICT (key) DO NOTHING;
