export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: { field: string; message: string }[]) {
    super(message);
  }
}

export function csrf() {
  return document.cookie.split('; ').find(item => item.startsWith('kontur_csrf='))?.split('=')[1] ?? '';
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; key?: string; signal?: AbortSignal } = {}): Promise<T> {
  const { method = 'GET', body, key, signal } = options;
  const headers = new Headers();
  if (method !== 'GET') headers.set('X-CSRF-Token', csrf());
  if (key) headers.set('Idempotency-Key', key);
  if (body !== undefined && !(body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch('/api/v1' + path, { method, headers, credentials: 'same-origin', signal: signal ?? AbortSignal.timeout(25000),
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('NETWORK_ERROR', navigator.onLine ? 'Сервер не ответил. Повторите попытку.' : 'Нет связи. Проверьте подключение к сети.', 0);
  }
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed) {
    if (response.status === 401 && !['/auth/login', '/auth/demo', '/auth/me'].includes(path)) window.dispatchEvent(new Event('kontur-session-expired'));
    throw new ApiError(parsed?.error?.code ?? 'REQUEST_ERROR', parsed?.error?.message ?? 'Не удалось выполнить запрос.', response.status, parsed?.error?.details);
  }
  return parsed.data as T;
}

export function queryString(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(key, String(value));
  return query.size ? '?' + query.toString() : '';
}

export type Session = { user: User; demoMode: boolean };
export type User = { id: string; name: string; email: string; role: 'EMPLOYEE' | 'HANDLER' | 'MANAGER' | 'ADMIN'; departmentId: string | null; permissions: string[]; demo: boolean };
export type Entity = { id: string; name: string };
export type Catalog = { categories: (Entity & { sensitive: boolean })[]; processes: Entity[]; departments: Entity[]; people: Entity[] };
export type Page<T> = { items: T[]; total: number; page: number; limit: number };
export type Reference = { id: string; number: string; title: string };
export type EventRow = { id: string; action: string; createdAt: string; details?: { reason?: string; next?: string } };
export type Attachment = { id: string; name: string; bytes: number; mediaType: string };
export function uploadAttachment(file: File) {
  const body = new FormData();
  body.set('file', file);
  return api<Attachment>('/attachments/complete', { method: 'POST', body });
}
export type AppealRow = Reference & {
  type: string; status: string; priority: string; visibility: string; version: number; isSynthetic: boolean;
  authorId: string; assigneeId: string | null; createdAt: string; dueAt: string | null; controlDueAt: string | null; category: { name: string } | null;
  process: { name: string } | null; department: { name: string } | null; categoryId: string | null; processId: string | null;
};
export type LinkRow = { id: string; version: number; from: Reference; to: Reference; relation: string; state: string; explanation: string; proposedBy: string };
export type Appeal = AppealRow & {
  description: string; proposedSolution: string | null; resolutionType: string | null; resolutionText: string | null; closedAt: string | null;
  assignee: { name: string } | null; queue: { name: string } | null; allowedActions: string[];
  comments: { id: string; author: { name: string }; body: string; internal: boolean; kind: string; createdAt: string }[];
  timing: { activeSeconds: number; waitingSeconds: number; periods: { phase: string; startedAt: string; endedAt: string | null }[] };
  events: EventRow[]; attachments: Attachment[]; problems: Reference[]; improvements: Reference[]; publications: { id: string; title: string; result: string }[]; links: LinkRow[];
  reviews: { id: string; kind: 'WITHDRAWAL' | 'RECONSIDERATION'; reason: string; decision?: string; approved?: boolean | null; decidedAt?: string }[];
};
export type Change = { id: string; title: string; problem: string; change: string; method: string; result: string; limitations: string; publishedAt: string | null;
  isSynthetic: boolean; state?: string; version?: number; authorId?: string; audienceId?: string | null; reviewNote?: string | null };
export type CaseRow = Reference & { status: string; owner: Entity | null; scope?: string; createdAt: string; updatedAt: string; isSynthetic: boolean; verification?: { outcome: string } | null };
export type Problem = CaseRow & { symptoms: string; hypothesis: string | null; conclusion: string | null; version: number; canEdit: boolean;
  allowedActions: string[]; people: Entity[]; sources: Reference[]; improvements: Reference[]; events: EventRow[]; findings: { id: string; body: string; source: string; createdAt: string }[] };
export type Plan = { version: number; method: string; hypothesis: string; criterion: string; metricName?: string; unit?: string; direction?: string; targetValue?: number; protocol?: string; minimumSampleSize: number | null; requireSameSource: boolean; maxPeriodDifferencePercent: number | null;
  observations: { id: string; phase: string; value: number | null; source: string; sourceType: string; periodStart: string; periodEnd: string; sampleSize?: number; isSynthetic: boolean; evidence: Attachment[] }[] };
export type Feedback = { id: string; choice?: string; comment?: string; submittedAt?: string; version: number };
export type Improvement = CaseRow & {
  rationale: string; goal: string; risks?: string; processId?: string; implementationNotes?: string; implementedAt?: string; version: number;
  canEdit: boolean; canMeasure: boolean; canVerify: boolean; canInvite: boolean; canDraftPublication: boolean; canApprovePublication: boolean;
  allowedActions: string[]; people: Entity[]; sources: Reference[]; problem: Reference | null; events: EventRow[]; plan: Plan | null;
  actions: { id: string; title: string; status: string; dueAt?: string; result?: string; owner: Entity; blocking: boolean; canUpdate: boolean }[];
  approvals: { id: string; reason: string; status: string; createdAt: string }[];
  verification: { outcome: string; summary: string; limitations: string; verifiedAt: string; isSynthetic: boolean; planVersion: number; measurementIds: string[]; evidence: Attachment[] } | null;
  publications: Change[]; feedback: Feedback[];
};
