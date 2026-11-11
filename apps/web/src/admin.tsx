import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus, Settings, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { label, permissions, priorities, roles, visibilities } from '../../../packages/contracts/domain';
import { api } from './api';
import { ActionForm, Chip, date, Empty, EntityOptions, ErrorBox, Field, field, Loading, Modal, numeric, optional, Options, PageHeading, Section, timestamp } from './ui';

const resources = {
  users: 'Пользователи', 'organization-units': 'Структура', categories: 'Категории', processes: 'Процессы', 'work-queues': 'Очереди',
  'routing-rules': 'Маршрутизация', 'sla-policies': 'Сроки', ai: 'Настройки Groq', 'outbox-failures': 'Мониторинг', audit: 'Аудит',
} as const;
type Resource = keyof typeof resources;
type Row = { id: string; name?: string; email?: string; role?: string; departmentId?: string; parentId?: string; categoryId?: string;
  processId?: string; queueId?: string; assigneeId?: string; coordinatorId?: string; active?: boolean; fallback?: boolean; permissions?: string[];
  sensitive?: boolean; rank?: number; effectiveFrom?: string; effectiveTo?: string; visibility?: string; priority?: string; firstResponseHours?: number;
  nextActionHours?: number; members?: { userId: string }[]; version?: number; entity?: string; action?: string; createdAt?: string; kind?: string; deadAt?: string; attempts?: number };
const permissionLabels: Record<string, string> = {
  ROUTING_COORDINATOR: 'Переназначение обращений', PROBLEM_OWNER: 'Исследование проблем', IMPROVEMENT_OWNER: 'Управление улучшениями',
  IMPROVEMENT_APPROVER: 'Согласование улучшений', RESULT_VERIFIER: 'Проверка результата', PUBLICATION_APPROVER: 'Согласование публикаций',
  SENSITIVE_CASE_HANDLER: 'Обработка чувствительных обращений', EXPORT_DATA: 'Выгрузка данных',
};
const routeReasons: Record<string, string> = { MATCH: 'Найдено подходящее правило', SPECIAL_ROUTE: 'Специальная очередь',
  NO_RULE: 'Правило отсутствует, резервная очередь', RULE_CONFLICT: 'Совпали приоритеты правил, резервная очередь',
  ASSIGNEE_UNAVAILABLE: 'Обработчик недоступен, резервная очередь' };

export function AdminPage() {
  const { resource: raw } = useParams();
  const resource = Object.hasOwn(resources, raw ?? '') ? raw as Resource : 'users';
  return <AdminResource key={resource} resource={resource} />;
}

function AdminResource({ resource }: { resource: Resource }) {
  const client = useQueryClient();
  const [editor, setEditor] = useState<Row | 'new' | null>(null);
  const [preview, setPreview] = useState(false);
  const editable = !['audit', 'outbox-failures', 'ai'].includes(resource);
  const rows = useQuery({ queryKey: ['admin', resource], queryFn: () => api<Row[]>(`/admin/${resource}`), enabled: resource !== 'ai' });
  const ai = useQuery({ queryKey: ['ai'], queryFn: () => api<{ available: boolean; fallback: string }>('/ai/capabilities'), enabled: resource === 'ai' });
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<Row[]>('/admin/users'), enabled: !!editor || preview });
  const units = useQuery({ queryKey: ['admin', 'organization-units'], queryFn: () => api<Row[]>('/admin/organization-units'), enabled: !!editor || preview });
  const cats = useQuery({ queryKey: ['admin', 'categories'], queryFn: () => api<Row[]>('/admin/categories'), enabled: !!editor || preview });
  const processes = useQuery({ queryKey: ['admin', 'processes'], queryFn: () => api<Row[]>('/admin/processes'), enabled: !!editor || preview });
  const queues = useQuery({ queryKey: ['admin', 'work-queues'], queryFn: () => api<Row[]>('/admin/work-queues'), enabled: !!editor || preview });
  const row = editor && editor !== 'new' ? editor : undefined;
  const save = useMutation({ mutationFn: (data: FormData) => {
    let body: Record<string, unknown> = { name: field(data, 'name') };
    switch (resource) {
      case 'users': body = { ...body, email: field(data, 'email'), role: field(data, 'role'), password: row ? undefined : field(data, 'password'),
        departmentId: optional(data, 'departmentId') ?? null, permissions: data.getAll('permissions'), active: data.has('active') }; break;
      case 'organization-units': body.parentId = optional(data, 'parentId') ?? null; break;
      case 'categories': body = { ...body, parentId: optional(data, 'parentId') ?? null, sensitive: data.has('sensitive') }; break;
      case 'work-queues': body = { ...body, visibility: field(data, 'visibility'), coordinatorId: field(data, 'coordinatorId'),
        memberIds: data.getAll('memberIds'), fallback: data.has('fallback') }; break;
      case 'routing-rules': body = { ...body, categoryId: field(data, 'categoryId'), departmentId: optional(data, 'departmentId') ?? null,
        processId: optional(data, 'processId') ?? null, queueId: field(data, 'queueId'), assigneeId: optional(data, 'assigneeId') ?? null,
        rank: numeric(data, 'rank'), active: data.has('active'), effectiveFrom: timestamp(data, 'effectiveFrom') ?? null, effectiveTo: timestamp(data, 'effectiveTo') ?? null }; break;
      case 'sla-policies': body = { priority: field(data, 'priority'), firstResponseHours: numeric(data, 'firstResponseHours'),
        nextActionHours: numeric(data, 'nextActionHours'), active: data.has('active'), expectedVersion: row?.version }; break;
    }
    return api(`/admin/${resource}${row ? '/' + row.id : ''}`, { method: row ? 'PATCH' : 'POST', body });
  }, onSuccess: () => { setEditor(null); void client.invalidateQueries({ queryKey: ['admin'] }); void client.invalidateQueries({ queryKey: ['catalog'] }); } });
  const inspect = useMutation({ mutationFn: (data: FormData) => api<{ reason: string; queueId: string; assigneeId: string | null; visibility: string }>('/admin/routing-rules/preview', {
    method: 'POST', body: { categoryId: optional(data, 'categoryId'), departmentId: optional(data, 'departmentId'), processId: optional(data, 'processId'), visibility: field(data, 'visibility') },
  }) });
  const opts = (rows: Row[] | undefined) => rows?.filter(item => item.id !== row?.id).map(item => ({ id: item.id, name: item.name ?? item.email ?? item.id })) ?? [];
  const staff = users.data?.filter(item => item.active && ['HANDLER', 'MANAGER'].includes(item.role ?? '')) ?? [];
  const select = (caption: string, name: string, options: Row[] | undefined, value?: string, required = false) =>
    <Field label={caption}><select name={name} key={`${name}:${options?.length ?? 0}`} defaultValue={value ?? ''} required={required}><EntityOptions rows={opts(options)} blank={required ? 'Выберите значение' : 'Не задано'} /></select></Field>;
  const active = <label className="checkbox-line"><input type="checkbox" name="active" defaultChecked={row?.active ?? true} /> Активно</label>;
  return <><PageHeading title="Администрирование" subtitle="Справочники, доступ, правила обработки и эксплуатация." action={editable && <button className="button primary"
    onClick={() => { save.reset(); setEditor('new'); }}><Plus size={18} />Добавить запись</button>} />
    <nav className="tab-strip admin-tabs" aria-label="Разделы администрирования">{Object.entries(resources).map(([key, title]) => <NavLink key={key} to={`/admin/${key}`}>{title}</NavLink>)}</nav>
    {resource === 'ai' ? <Section title="Groq" icon={<Settings size={18} />}><ErrorBox error={ai.error} retry={() => ai.refetch()} />
      {ai.isPending && <Loading />}{ai.data && <div className="inner-stack"><span className="chip tone-muted">{ai.data.available ? 'Включено' : 'Отключено'}</span>
        <p>{ai.data.fallback}</p><p>Провайдер настраивается серверными переменными окружения. Конфиденциальные карточки закрыты для передачи.</p></div>}</Section> :
      <Section title={resources[resource]} icon={<Settings size={18} />} action={resource === 'routing-rules' && <button className="button secondary"
        onClick={() => { inspect.reset(); setPreview(true); }}>Проверить маршрут <ArrowRight size={16} /></button>}>
        <ErrorBox error={rows.error} retry={() => rows.refetch()} />{rows.isPending && <Loading />}
        {rows.data && (rows.data.length ? rows.data.map(item => <div key={item.id} className="task-row admin-row">
          <div><strong>{item.name ?? (item.priority ? label(item.priority) : label(item.action ?? item.kind ?? ''))}</strong>
            <small>{item.email ? `${item.email} · ${label(item.role ?? '')}` : item.priority ? `Первый ответ: ${item.firstResponseHours} ч · Следующее действие: ${item.nextActionHours} ч` :
              item.visibility ? label(item.visibility) + (item.fallback ? ' · Резервная' : '') : item.rank !== undefined ? `Приоритет ${item.rank}` :
                item.entity ? `${item.entity} · ${date(item.createdAt, true)}` : item.deadAt ? `Попыток: ${item.attempts} · ${date(item.deadAt, true)}` : item.sensitive ? 'Специальный маршрут' : ''}</small></div>
          {item.active === false && <Chip value="Неактивно" />}
          {editable && <button className="button subtle" onClick={() => { save.reset(); setEditor(item); }}>Изменить</button>}
        </div>) : <Empty title="Записей пока нет" />)}
      </Section>}
    {editor && <Modal title={row ? 'Редактировать запись' : 'Добавить запись'} description={resources[resource]} close={() => setEditor(null)}>
      <ErrorBox error={users.error || units.error || cats.error || processes.error || queues.error} />
      <ActionForm pending={save.isPending} error={save.error} onSubmit={data => save.mutate(data)}>
        {resource !== 'sla-policies' && <Field label="Название"><input name="name" defaultValue={row?.name} required /></Field>}
        {resource === 'users' && <>
          <Field label="Электронная почта"><input name="email" type="email" defaultValue={row?.email} required /></Field>
          {!row && <Field label="Пароль"><input name="password" type="password" minLength={12} maxLength={72} required /></Field>}
          <Field label="Роль"><select name="role" defaultValue={row?.role ?? 'EMPLOYEE'}><Options items={roles} /></select></Field>
          {select('Подразделение', 'departmentId', units.data, row?.departmentId)}
          <fieldset className="checks"><legend>Полномочия в рабочей области</legend>{permissions.map(item => <label className="checkbox-line" key={item}>
            <input type="checkbox" name="permissions" value={item} defaultChecked={row?.permissions?.includes(item)} /> {permissionLabels[item]}</label>)}</fieldset>{active}
        </>}
        {resource === 'organization-units' && select('Родительское подразделение', 'parentId', units.data, row?.parentId)}
        {resource === 'categories' && <>{select('Родительская категория', 'parentId', cats.data, row?.parentId)}
          <label className="checkbox-line"><input name="sensitive" type="checkbox" defaultChecked={row?.sensitive} /> Специальный маршрут</label></>}
        {resource === 'work-queues' && <>
          <Field label="Класс доступа"><select name="visibility" defaultValue={row?.visibility ?? 'NORMAL_INTERNAL'}><Options items={visibilities} /></select></Field>
          {select('Координатор', 'coordinatorId', staff, row?.coordinatorId, true)}
          <Field label="Участники"><select multiple name="memberIds" key={staff.length} defaultValue={row?.members?.map(item => item.userId) ?? []}>
            {staff.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <label className="checkbox-line"><input type="checkbox" name="fallback" defaultChecked={row?.fallback} /> Резервная очередь</label>
        </>}
        {resource === 'routing-rules' && <>
          {select('Категория', 'categoryId', cats.data, row?.categoryId, true)}{select('Подразделение', 'departmentId', units.data, row?.departmentId)}
          {select('Процесс', 'processId', processes.data, row?.processId)}{select('Очередь', 'queueId', queues.data?.filter(item => item.visibility === 'NORMAL_INTERNAL'), row?.queueId, true)}
          {select('Ответственный', 'assigneeId', staff, row?.assigneeId)}
          <Field label="Приоритет правила" hint="Меньшее число имеет преимущество. При совпадении сработает резерв."><input name="rank" type="number" min={0} max={1000} defaultValue={row?.rank ?? 100} required /></Field>
          <div className="two-fields"><Field label="Действует с (UTC)"><input name="effectiveFrom" type="date" defaultValue={row?.effectiveFrom?.slice(0, 10)} /></Field>
            <Field label="Действует до (UTC)"><input name="effectiveTo" type="date" defaultValue={row?.effectiveTo?.slice(0, 10)} /></Field></div>{active}
        </>}
        {resource === 'sla-policies' && <>
          <Field label="Приоритет"><select name="priority" defaultValue={row?.priority ?? 'MEDIUM'}><Options items={priorities} /></select></Field>
          <Field label="Первый ответ, рабочих часов"><input type="number" name="firstResponseHours" min={1} max={240} defaultValue={row?.firstResponseHours ?? 8} required /></Field>
          <Field label="Следующее действие, рабочих часов"><input type="number" name="nextActionHours" min={1} max={480} defaultValue={row?.nextActionHours ?? 24} required /></Field>{active}
        </>}
      </ActionForm></Modal>}
    {preview && <Modal title="Предпросмотр маршрута" description="Проверка по текущим правилам. Обращение не сохраняется." close={() => setPreview(false)}>
      <ActionForm pending={inspect.isPending} error={inspect.error} submit="Проверить" onSubmit={data => inspect.mutate(data)}>
        {select('Категория', 'categoryId', cats.data)}{select('Подразделение', 'departmentId', units.data)}{select('Процесс', 'processId', processes.data)}
        <Field label="Класс доступа"><select name="visibility"><Options items={visibilities} /></select></Field>
      </ActionForm>
      {inspect.data && <div className="info-box"><ShieldCheck size={18} /><div><strong>{routeReasons[inspect.data.reason]}</strong>
        <p>{queues.data?.find(item => item.id === inspect.data?.queueId)?.name} · {staff.find(item => item.id === inspect.data?.assigneeId)?.name ?? 'Координатор очереди'}</p></div></div>}
    </Modal>}
  </>;
}
