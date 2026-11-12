import { DatePicker } from './date-picker';
import * as Tabs from '@radix-ui/react-tabs';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowRight, BookOpen, CheckCircle2, ClipboardList, GitPullRequest, Layers3, Plus, Search, Sparkles } from './icons';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { improvementStatuses, label, outcomes, problemStatuses } from '@modus/api/contracts';
import { api, uploadAttachment, type Attachment, type AppealRow, type CaseRow, type Catalog, type Change, type Improvement, type Page, type Plan, type Problem, queryString, type Reference } from './api';
import { useSession } from './session';
import { ActionForm, Chip, date, Empty, EntityOptions, ErrorBox, Field, field, Loading, Modal, numeric, optional, Options,
  PageHeading, Pagination, Section, TableRegion, Timeline, timestamp } from './ui';

type Kind = 'problem' | 'improvement';
const config = {
  problem: { path: '/problems', title: 'Проблемы', subtitle: 'Исследуйте повторяющиеся сигналы и проверяйте гипотезы.', create: 'Создать проблему', statuses: problemStatuses, permission: 'PROBLEM_OWNER' },
  improvement: { path: '/improvements', title: 'Улучшения', subtitle: 'Управляйте изменениями от идеи до проверки эффекта.', create: 'Создать улучшение', statuses: improvementStatuses, permission: 'IMPROVEMENT_OWNER' },
};

function References({ items, path }: { items: Reference[]; path: string }) {
  return items.length ? <div className="reference-stack">{items.map(item => <Link key={item.id} to={`${path}/${item.id}`} className="inline-reference"><small>{item.number}</small>{item.title}<ArrowRight size={15} /></Link>)}</div> : <Empty title="Связанных записей пока нет" />;
}

export function CaseList({ kind }: { kind: Kind }) {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const { path, title, subtitle, create, statuses, permission } = config[kind];
  const page = Number(params.get('page')) || 1;
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const processId = params.get('processId') ?? '';
  const rows = useQuery({ queryKey: [kind, q, status, page, processId], queryFn: ({ signal }) =>
    api<Page<CaseRow>>(path + queryString({ q, status, page, processId }), { signal }), placeholderData: keepPreviousData });
  const filters = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (key !== 'page') next.delete('page');
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  return <><PageHeading title={title} subtitle={subtitle} action={user.permissions.includes(permission) && <Link className="button primary" to={path + '/new'}><Plus size={18} />{create}</Link>} />
    <div className="surface filter-bar"><label className="search-field"><Search size={18} /><span className="sr-only">Поиск</span><input placeholder="Поиск по номеру или названию" value={q} onChange={event => filters('q', event.target.value)} /></label>
      <select aria-label="Статус" value={status} onChange={event => filters('status', event.target.value)}><Options items={statuses} blank="Все статусы" /></select></div>
    {rows.isPending && <Loading />}<ErrorBox error={rows.error} retry={() => rows.refetch()} />
    {rows.data && <div className="surface"><div className="list-meta">Найдено: {rows.data.total}</div>
      {rows.data.items.length ? <TableRegion label={title}><table className="data-table"><thead><tr><th>Название</th><th>Статус</th><th>Владелец</th>{kind === 'improvement' && <th>Эффект</th>}<th>Обновлено</th></tr></thead>
        <tbody>{rows.data.items.map(item => <tr key={item.id}><td><Link className="table-title" to={`${path}/${item.id}`}><span className="row-icon">{kind === 'problem' ? <GitPullRequest size={17} /> : <Layers3 size={17} />}</span>
          <span><small>{item.number}{item.isSynthetic ? ' · демо' : ''}</small><strong>{item.title}</strong></span></Link></td>
          <td><Chip value={item.status} /></td><td>{item.owner?.name ?? '—'}</td>{kind === 'improvement' && <td>{item.verification ? <Chip value={item.verification.outcome} /> : 'Ещё не проверен'}</td>}<td>{date(item.updatedAt)}</td></tr>)}</tbody></table></TableRegion>
        : <Empty title="Записи не найдены" />}
      <Pagination {...rows.data} onChange={next => filters('page', String(next))} /></div>}
  </>;
}

export function CreateCase({ kind }: { kind: Kind }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { path, create, title, permission } = config[kind];
  const { user } = useSession();
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>('/catalog') });
  const appealId = params.get('appealId') ?? undefined;
  const problemId = params.get('problemId') ?? undefined;
  const sourceAppeal = useQuery({ queryKey: ['appeal', appealId], queryFn: () => api<Reference>(`/appeals/${appealId}`), enabled: !!appealId });
  const sourceProblem = useQuery({ queryKey: ['problem', problemId], queryFn: () => api<Reference>(`/problems/${problemId}`), enabled: !!problemId });
  const save = useMutation({ mutationFn: (data: FormData) => api<{ id: string }>(path, { method: 'POST', body: kind === 'problem'
    ? { title: field(data, 'title'), symptoms: field(data, 'symptoms'), hypothesis: optional(data, 'hypothesis'), appealId }
    : { title: field(data, 'title'), rationale: field(data, 'rationale'), goal: field(data, 'goal'), scope: field(data, 'scope'), risks: optional(data, 'risks'),
      processId: optional(data, 'processId'), appealId, problemId } }), onSuccess: item => navigate(`${path}/${item.id}`) });
  return <><PageHeading title={create} back={{ to: path, label: title }} />
    {!user.permissions.includes(permission) ? <Empty title="У вас нет прав на создание записи" /> : <div className="surface form-panel">
      {(sourceAppeal.data || sourceProblem.data) && <p className="subtle-text">Основание: {(sourceAppeal.data || sourceProblem.data)?.title}</p>}
      <ErrorBox error={sourceAppeal.error || sourceProblem.error} />
      <ActionForm pending={save.isPending} error={save.error} onSubmit={data => save.mutate(data)} submit={kind === 'problem' ? 'Создать проблему' : 'Сохранить черновик'}>
        <Field label="Название"><input name="title" required minLength={3} maxLength={180} /></Field>
        {kind === 'problem' ? <><Field label="Наблюдаемые симптомы"><textarea name="symptoms" required minLength={5} rows={5} /></Field>
          <Field label="Рабочая гипотеза"><textarea name="hypothesis" rows={3} /></Field></> : <>
          <Field label="Основание"><textarea name="rationale" required minLength={5} rows={4} /></Field>
          <Field label="Цель изменения"><textarea name="goal" required minLength={5} rows={3} /></Field>
          <Field label="Область изменения"><input name="scope" required /></Field>
          <Field label="Рабочий процесс"><select name="processId"><EntityOptions rows={catalog.data?.processes ?? []} blank="Не выбран" /></select></Field>
          <Field label="Риски"><textarea name="risks" rows={3} /></Field>
        </>}
      </ActionForm></div>}
  </>;
}

type Editor = { title: string; path: string; body: (data: FormData) => Record<string, unknown>; fields?: ReactNode; method?: 'PATCH' | 'POST'; description?: string };
const textBox = (label: string, name = 'text', required = true, value?: string) =>
  <Field label={label}><textarea name={name} defaultValue={value} rows={4} required={required} minLength={5} maxLength={10000} /></Field>;

function useEditor(id: string | undefined, key: Kind, version?: number) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const update = useMutation({ mutationFn: (data: FormData) => {
    if (!editor) throw new Error('Откройте форму действия.');
    return api<{ readable?: boolean }>(editor.path, { method: editor.method ?? 'POST', body: { expectedVersion: version, ...editor.body(data) } });
  }, onSuccess: async result => {
    if (result.readable === false) {
      client.removeQueries({ queryKey: [key, id], exact: true });
      navigate(config[key].path);
      return;
    }
    await Promise.all([client.invalidateQueries({ queryKey: [key, id] }), client.invalidateQueries({ queryKey: ['radar'] }), client.invalidateQueries({ queryKey: ['changes'] })]);
    setEditor(null); setSaved(true);
  } });
  return { open: (next: Editor) => { update.reset(); setSaved(false); setUploading(false); setEditor(next); }, saved, setUploading,
    modal: editor && <Modal title={editor.title} description={editor.description} close={() => setEditor(null)}><ActionForm pending={update.isPending || uploading} error={update.error}
      reload={() => client.invalidateQueries({ queryKey: [key, id] })} onSubmit={data => update.mutate(data)}>{editor.fields}</ActionForm></Modal> };
}

export function ProblemDetail() {
  const { id } = useParams();
  const { user } = useSession();
  const path = `/problems/${id}`;
  const query = useQuery({ queryKey: ['problem', id], queryFn: () => api<Problem>(path) });
  const record = query.data;
  const edit = useEditor(id, 'problem', record?.version);
  const [addSource, setAddSource] = useState(false);
  const [search, setSearch] = useState('');
  const options = useQuery({ queryKey: ['appeals', 'problem-source', search], queryFn: () => api<Page<AppealRow>>('/work-queue' + queryString({ limit: 30, q: search })), enabled: addSource });
  if (!record) return <><PageHeading title="Проблема" />{query.isPending ? <Loading /> : <ErrorBox error={query.error} retry={() => query.refetch()} />}</>;
  return <><PageHeading title={record.title} subtitle={`${record.number} · Владелец: ${record.owner?.name ?? '—'}`} back={{ to: '/problems', label: 'Проблемы' }} action={<Chip value={record.status} />} />
    {edit.saved && <p className="success-box" role="status"><CheckCircle2 size={18} />Изменения сохранены.</p>}
    <div className="detail-grid"><div className="detail-main">
      <Section title="Наблюдения и гипотеза" icon={<GitPullRequest size={18} />} action={record.canEdit && <button className="text-button" onClick={() => edit.open({
        title: 'Редактировать проблему', path, method: 'PATCH',
        body: data => ({ title: field(data, 'title'), symptoms: field(data, 'symptoms'), hypothesis: optional(data, 'hypothesis'), ownerId: optional(data, 'ownerId') }),
        fields: <><Field label="Название"><input name="title" defaultValue={record.title} required minLength={3} /></Field>
          <Field label="Владелец проблемы"><select name="ownerId" defaultValue={record.owner?.id ?? ''}><EntityOptions rows={record.people} blank="Текущий владелец" /></select></Field>
          {textBox('Симптомы', 'symptoms', true, record.symptoms)}{textBox('Гипотеза', 'hypothesis', false, record.hypothesis ?? '')}</>,
      })}>Редактировать</button>}>
        <h3>Наблюдаемые симптомы</h3><p className="preserve">{record.symptoms}</p>
        <h3>Рабочая гипотеза</h3><p className="preserve">{record.hypothesis ?? 'Гипотеза пока не сформулирована.'}</p>
        {record.conclusion && <><h3>Вывод</h3><p className="preserve">{record.conclusion}</p></>}
      </Section>
      <Section title="Доказательства" action={record.canEdit && <button className="button secondary" onClick={() => edit.open({ title: 'Добавить наблюдение', path: path + '/findings',
        body: data => ({ text: field(data, 'text'), source: field(data, 'source') }),
        fields: <>{textBox('Наблюдение')}<Field label="Источник"><input name="source" required /></Field></>,
      })}><Plus size={16} />Наблюдение</button>}>
        {record.findings.length ? record.findings.map(item => <article className="comment" key={item.id}><strong>{item.source}</strong><small>{date(item.createdAt)}</small><p className="preserve">{item.body}</p></article>) : <Empty title="Доказательства ещё не добавлены" />}
      </Section>
      <Section title="История"><Timeline items={record.events} /></Section>
    </div><aside className="detail-side">
      <Section title="Действия"><div className="side-actions">
        {record.allowedActions.map(target => <button key={target} className="button secondary" onClick={() => edit.open({
          title: label(target), path: path + '/transition', body: data => ({ target, text: field(data, 'text') }), fields: textBox('Основание перехода'),
        })}>{label(target)}</button>)}
        {user.permissions.includes('IMPROVEMENT_OWNER') && <Link className="button primary" to={`/improvements/new?problemId=${id}`}>Создать улучшение</Link>}
      </div></Section>
      <Section title="Исходные обращения" action={record.canEdit && <button className="text-button" onClick={() => setAddSource(true)}>Добавить</button>}><References items={record.sources} path="/appeals" /></Section>
      <Section title="Улучшения"><References items={record.improvements} path="/improvements" /></Section>
    </aside></div>{edit.modal}
    {addSource && <Modal title="Добавить исходное обращение" close={() => setAddSource(false)}><div className="form-stack">
      <Field label="Поиск по номеру или тексту"><input value={search} onChange={event => setSearch(event.target.value)} /></Field>
      <ErrorBox error={options.error} />{options.isPending && <Loading />}
      {options.data?.items.filter(item => item.visibility === 'NORMAL_INTERNAL' && !record.sources.some(source => source.id === item.id)).map(item => <button
        key={item.id} className="button secondary" onClick={() => { setAddSource(false); edit.open({ title: 'Связать обращение', description: item.title,
          path: path + '/sources', fields: textBox('Обоснование', 'explanation'), body: data => ({ appealId: item.id, explanation: field(data, 'explanation') }) }); }}>
        {item.number} · {item.title}</button>)}
    </div></Modal>}
  </>;
}

const transitionLabels: Record<string, string> = {
  UNDER_REVIEW: 'Отправить на согласование', APPROVED: 'Согласовать', DEFERRED: 'Отложить', REJECTED: 'Отклонить',
  DRAFT: 'Вернуть на доработку', IN_PROGRESS: 'Начать работу', IMPLEMENTED: 'Зафиксировать внедрение',
  VERIFYING: 'Начать проверку', COMPLETED: 'Завершить улучшение', CANCELED: 'Отменить',
};
const taskTransitions: Record<string, string[]> = {
  TODO: ['IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELED'], IN_PROGRESS: ['BLOCKED', 'DONE', 'CANCELED'],
  BLOCKED: ['IN_PROGRESS', 'DONE', 'CANCELED'], DONE: ['IN_PROGRESS'], CANCELED: ['TODO'],
};

function PlanForm({ plan }: { plan: Plan | null }) {
  const [method, setMethod] = useState(plan?.method ?? 'QUANTITATIVE');
  return <><Field label="Метод проверки"><select name="method" value={method} onChange={event => setMethod(event.target.value)}><Options items={['QUANTITATIVE', 'QUALITATIVE', 'MIXED']} /></select></Field>
    {textBox('Гипотеза', 'hypothesis', true, plan?.hypothesis)}{textBox('Критерий успеха', 'criterion', true, plan?.criterion)}
    {method !== 'QUALITATIVE' && <><div className="two-fields"><Field label="Показатель"><input name="metricName" defaultValue={plan?.metricName ?? ''} required /></Field>
      <Field label="Единица измерения"><input name="unit" defaultValue={plan?.unit ?? ''} required /></Field></div>
      <div className="two-fields"><Field label="Направление"><select name="direction" defaultValue={plan?.direction ?? 'DECREASE'}><Options items={['DECREASE', 'INCREASE', 'TARGET']} /></select></Field>
        <Field label="Целевое значение"><input name="targetValue" type="number" step="any" defaultValue={plan?.targetValue ?? ''} required /></Field></div></>}
    {method !== 'QUANTITATIVE' && textBox('Протокол качественной проверки', 'protocol', true, plan?.protocol)}
    <fieldset><legend>Сопоставимость наблюдений</legend>
      <div className="two-fields">
        <Field label="Минимум наблюдений в выборке"><input name="minimumSampleSize" type="number" min={1} max={100000000} defaultValue={plan?.minimumSampleSize ?? ''} /></Field>
        <Field label="Допустимая разница длительности, %"><input name="maxPeriodDifferencePercent" type="number" min={0} max={100} defaultValue={plan?.maxPeriodDifferencePercent ?? ''} /></Field>
      </div>
      <label className="checkbox-line"><input type="checkbox" name="requireSameSource" defaultChecked={plan?.requireSameSource} /> Один указанный вид источника</label>
    </fieldset>
  </>;
}

const sourceTypes = { SYSTEM_REPORT: 'Отчёт системы', MANUAL_SAMPLE: 'Ручная выборка', INTERVIEW: 'Интервью', OTHER: 'Другой источник' };

function EvidencePicker({ onUploading }: { onUploading: (active: boolean) => void }) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const upload = useMutation({ mutationFn: uploadAttachment, onMutate: () => onUploading(true),
    onSuccess: file => setFiles(items => [...items, file]), onSettled: () => onUploading(false) });
  return <>
    <Field label="Подтверждающие файлы" hint="До 5 файлов. Вложения доступны участникам с доступом к улучшению.">
      <input type="file" accept=".txt,.pdf,.png,.jpg,.jpeg" disabled={upload.isPending || files.length >= 5} onChange={event => {
        const file = event.currentTarget.files?.[0];
        if (file) upload.mutate(file);
        event.currentTarget.value = '';
      }} />
    </Field>
    {upload.isPending && <small role="status">Загружаем файл…</small>}
    <ErrorBox error={upload.error} />
    {files.map(file => <div className="file-line" key={file.id}>
      <input type="hidden" name="evidenceIds" value={file.id} />
      <span>{file.name}</span><button className="button subtle" type="button" onClick={() => setFiles(items => items.filter(item => item.id !== file.id))}>Убрать</button>
    </div>)}
  </>;
}

function EvidenceLinks({ files }: { files: Attachment[] }) {
  return files.length ? <ul>{files.map(file => <li key={file.id}><a href={`/api/v1/attachments/${file.id}/download`}>{file.name}</a></li>)}</ul> : null;
}

function PublicationFields({ item }: { item?: Change }) {
  return <>
    <Field label="Название"><input name="title" required minLength={3} maxLength={180} defaultValue={item?.title} /></Field>
    {textBox('Что решали', 'problem', true, item?.problem)}{textBox('Что изменили', 'change', true, item?.change)}
    {textBox('Как проверили', 'method', true, item?.method)}{textBox('Результат', 'result', true, item?.result)}
    {textBox('Ограничения', 'limitations', true, item?.limitations)}
    <Field label="Аудитория"><select name="audience" defaultValue={item && !item.audienceId ? 'INTERNAL' : 'DEPARTMENT'}>
      <option value="DEPARTMENT">Подразделение</option><option value="INTERNAL">Все сотрудники</option>
    </select></Field>
  </>;
}

function publicationBody(data: FormData) {
  return Object.fromEntries(['title', 'problem', 'change', 'method', 'result', 'limitations', 'audience'].map(key => [key, field(data, key)]));
}

function PublicationPreview({ item }: { item: Change }) {
  return <div className="inner-stack">{[
    ['Что решали', item.problem], ['Что изменилось', item.change], ['Как проверили', item.method], ['Что показала проверка', item.result], ['Ограничения', item.limitations],
  ].map(([title, text]) => <div key={title}><h3>{title}</h3><p className="preserve">{text}</p></div>)}</div>;
}

function PublicationHistory({ id, version }: { id: string; version?: number }) {
  const [page, setPage] = useState(1);
  const history = useQuery({ queryKey: ['publication-revisions', id, version, page], queryFn: () =>
    api<Page<{ version: number; action: string; recordedAt: string; snapshot: Change }>>(`/publications/${id}/revisions?page=${page}`) });
  return <details><summary>Редакции публикации</summary>
    {history.isPending && <Loading />}<ErrorBox error={history.error} retry={() => history.refetch()} />
    {history.data?.items.map(item => <details key={item.version}>
      <summary>Версия {item.version} · {item.action === 'BASELINE' ? 'Сохранённая редакция' : label(item.action)} · {date(item.recordedAt, true)}</summary>
      <h3>{item.snapshot.title}</h3><PublicationPreview item={item.snapshot} />
      {item.snapshot.reviewNote && <p>{item.snapshot.reviewNote}</p>}
    </details>)}
    {history.data && <Pagination {...history.data} onChange={setPage} />}
  </details>;
}

export function ImprovementDetail() {
  const { id } = useParams();
  const { user } = useSession();
  const client = useQueryClient();
  const path = `/improvements/${id}`;
  const query = useQuery({ queryKey: ['improvement', id], queryFn: () => api<Improvement>(path) });
  const ai = useQuery({ queryKey: ['ai'], queryFn: () => api<{ available: boolean }>('/ai/capabilities') });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>('/catalog') });
  const record = query.data;
  const edit = useEditor(id, 'improvement', record?.version);
  const [aiOpen, setAiOpen] = useState(false);
  const [publication, setPublication] = useState<Change | null>(null);
  const pub = useMutation({ mutationFn: (operation: string) => api(`/publications/${publication?.id}/${operation}`, { method: 'POST', body: { expectedVersion: publication?.version } }),
    onSuccess: () => { setPublication(null); void client.invalidateQueries({ queryKey: ['improvement', id] }); void client.invalidateQueries({ queryKey: ['changes'] }); } });
  const suggestion = useMutation({ mutationFn: () => api<{ suggestion: Record<string, string[] | boolean>; truncated?: boolean }>('/ai/improvement-analysis', {
    method: 'POST', body: { consent: true, id },
  }) });
  if (!record) return <><PageHeading title="Улучшение" />{query.isPending ? <Loading /> : <ErrorBox error={query.error} retry={() => query.refetch()} />}</>;
  const planEditable = record.canEdit && ['DRAFT', 'DEFERRED'].includes(record.status);
  const plan = record.plan;
  const addPlan = () => edit.open({ title: plan ? 'Изменить план проверки' : 'Добавить план проверки', path: path + '/measurement-plan',
    fields: <PlanForm plan={plan} />, body: data => ({ method: field(data, 'method'), hypothesis: field(data, 'hypothesis'), criterion: field(data, 'criterion'),
      metricName: optional(data, 'metricName'), unit: optional(data, 'unit'), direction: optional(data, 'direction'), targetValue: numeric(data, 'targetValue'), protocol: optional(data, 'protocol'),
      minimumSampleSize: numeric(data, 'minimumSampleSize'), requireSameSource: data.has('requireSameSource'),
      maxPeriodDifferencePercent: numeric(data, 'maxPeriodDifferencePercent') }) });
  const addTask = (task?: Improvement['actions'][number]) => edit.open({ title: task ? 'Редактировать задачу' : 'Добавить задачу',
    path: path + '/actions' + (task ? '/' + task.id : ''), method: task ? 'PATCH' : 'POST',
    fields: <><Field label="Название"><input name="title" defaultValue={task?.title} required minLength={3} /></Field>
      <Field label="Исполнитель"><select name="ownerId" defaultValue={task?.owner.id ?? record.owner?.id ?? ''}><EntityOptions rows={record.people} blank="Владелец инициативы" /></select></Field>
      <Field label="Срок (дата в UTC)"><DatePicker name="dueAt" type="date" defaultValue={task?.dueAt?.slice(0, 10)} /></Field>
      <label className="checkbox-line"><input name="blocking" type="checkbox" defaultChecked={task?.blocking ?? true} /> Задача блокирует завершение</label></>,
    body: data => ({ title: field(data, 'title'), ownerId: optional(data, 'ownerId'), dueAt: timestamp(data, 'dueAt') ?? null, blocking: data.has('blocking') }),
  });
  return <><PageHeading title={record.title} subtitle={`${record.number} · ${record.scope ?? ''}`} back={{ to: '/improvements', label: 'Улучшения' }} action={<Chip value={record.status} />} />
    {edit.saved && <p className="success-box" role="status"><CheckCircle2 size={18} />Изменения сохранены.</p>}
    <div className="detail-grid"><div className="detail-main">
      <Tabs.Root defaultValue="overview">
        <Tabs.List className="tab-strip radix-tabs" aria-label="Разделы улучшения">
          {[['overview', 'Обзор'], ['plan', 'План'], ['result', 'Результат'], ['feedback', 'Обратная связь'], ['history', 'История']].map(([key, title]) => <Tabs.Trigger key={key} value={key}>{title}</Tabs.Trigger>)}
        </Tabs.List>
        <Tabs.Content value="overview" className="inner-stack">
          <Section title="Цель и основание" icon={<Layers3 size={18} />} action={planEditable && <button className="text-button" onClick={() => edit.open({
            title: 'Редактировать улучшение', path, method: 'PATCH',
            fields: <><Field label="Название"><input name="title" defaultValue={record.title} required minLength={3} /></Field>
              {textBox('Основание', 'rationale', true, record.rationale)}{textBox('Цель', 'goal', true, record.goal)}
              <Field label="Область изменения"><input name="scope" defaultValue={record.scope} required /></Field>
              <Field label="Владелец"><select name="ownerId" defaultValue={record.owner?.id ?? ''}><EntityOptions rows={record.people} blank="Текущий владелец" /></select></Field>
              <Field label="Процесс"><select name="processId" defaultValue={record.processId ?? ''}><EntityOptions rows={catalog.data?.processes ?? []} blank="Не выбран" /></select></Field>
              {textBox('Риски', 'risks', false, record.risks)}</>,
            body: data => ({ title: field(data, 'title'), rationale: field(data, 'rationale'), goal: field(data, 'goal'), scope: field(data, 'scope'), ownerId: optional(data, 'ownerId'),
              processId: optional(data, 'processId') ?? null, risks: optional(data, 'risks') }),
          })}>Редактировать</button>}>
            <h3>Что хотим изменить</h3><p className="preserve">{record.goal}</p>
            <h3>Основание</h3><p className="preserve">{record.rationale}</p>{record.risks && <><h3>Риски</h3><p className="preserve">{record.risks}</p></>}
            {record.implementationNotes && <><h3>Что внедрили</h3><p className="preserve">{record.implementationNotes}</p><small>{date(record.implementedAt)}</small></>}
          </Section>
          <Section title="Решения согласования"><div className="inner-stack">{record.approvals.length ? record.approvals.map(item => <article className="comment" key={item.id}>
            <Chip value={item.status} /><p>{item.reason}</p><small>{date(item.createdAt)}</small></article>) : <Empty title="Решений пока нет" />}</div></Section>
        </Tabs.Content>
        <Tabs.Content value="plan" className="inner-stack">
          <Section title="Задачи" icon={<ClipboardList size={18} />} action={record.canEdit && <button className="button secondary" onClick={() => addTask()}><Plus size={16} />Задача</button>}>
            {record.actions.length ? record.actions.map(item => <article className="task-row" key={item.id}><div><strong>{item.title}</strong><small>{item.owner.name} · {item.dueAt ? date(item.dueAt) : 'Срок не задан'}{item.blocking ? ' · Блокирующая' : ''}</small>
              {item.result && <p>{item.result}</p>}</div><Chip value={item.status} />
              {item.canUpdate && <button className="button subtle" onClick={() => edit.open({ title: 'Обновить статус задачи', path: path + `/actions/${item.id}/transition`,
                fields: <><Field label="Новый статус"><select name="target"><Options items={taskTransitions[item.status]} /></select></Field>{textBox('Результат или причина', 'text', false)}</>,
                body: data => ({ target: field(data, 'target'), text: optional(data, 'text') }),
              })}>Статус</button>}
              {record.canEdit && <button className="button subtle" onClick={() => addTask(item)}>Изменить</button>}
            </article>) : <Empty title="Задачи ещё не добавлены" />}
          </Section>
          <Section title="План проверки эффекта" icon={<Activity size={18} />} action={planEditable && <button className="button secondary" onClick={addPlan}>{plan ? 'Изменить' : 'Добавить план'}</button>}>
            {plan ? <dl className="facts"><div><dt>Метод</dt><dd>{label(plan.method)}</dd></div><div><dt>Гипотеза</dt><dd>{plan.hypothesis}</dd></div><div><dt>Критерий успеха</dt><dd>{plan.criterion}</dd></div>
              {plan.metricName && <div><dt>Целевой показатель</dt><dd>{plan.metricName}: {plan.targetValue} {plan.unit}</dd></div>}{plan.protocol && <div><dt>Протокол</dt><dd>{plan.protocol}</dd></div>}
              {plan.minimumSampleSize != null && <div><dt>Минимальная выборка</dt><dd>{plan.minimumSampleSize}</dd></div>}
              {plan.requireSameSource && <div><dt>Источник</dt><dd>Одинаковый указанный вид</dd></div>}
              {plan.maxPeriodDifferencePercent != null && <div><dt>Допуск длительности</dt><dd>{plan.maxPeriodDifferencePercent}%</dd></div>}</dl> :
              <Empty title="План проверки пока не задан" />}
          </Section>
        </Tabs.Content>
        <Tabs.Content value="result" className="inner-stack">
          <Section title="Измерения" icon={<Activity size={18} />} action={record.canMeasure && <button className="button secondary" onClick={() => edit.open({
            title: 'Добавить измерение', path: path + '/measurements', fields: <><Field label="Этап"><select name="phase"><Options items={record.implementedAt ? ['BEFORE', 'AFTER'] : ['BEFORE']} /></select></Field>
              <div className="two-fields"><Field label="Начало периода (UTC)"><DatePicker name="periodStart" type="datetime-local" step={1} required /></Field><Field label="Конец периода (UTC)"><DatePicker name="periodEnd" type="datetime-local" step={1} required /></Field></div>
              <div className="two-fields"><Field label="Значение"><input name="value" type="number" step="any" required={plan?.method !== 'QUALITATIVE'} /></Field>
                <Field label="Размер выборки"><input name="sampleSize" type="number" min={1} /></Field></div><Field label="Вид источника"><select name="sourceType" defaultValue="OTHER">
                {Object.entries(sourceTypes).map(([code, title]) => <option key={code} value={code}>{title}</option>)}
              </select></Field>{textBox('Источник и способ сбора', 'source')}<EvidencePicker onUploading={edit.setUploading} /></>,
            body: data => ({ phase: field(data, 'phase'), periodStart: timestamp(data, 'periodStart'), periodEnd: timestamp(data, 'periodEnd'),
              value: numeric(data, 'value'), sampleSize: numeric(data, 'sampleSize'), source: field(data, 'source'),
              sourceType: field(data, 'sourceType'), evidenceIds: data.getAll('evidenceIds') }),
          })}><Plus size={16} />Измерение</button>}>
            {plan?.observations.length ? <div className="observations">{plan.observations.map(item => <article key={item.id}><small>{label(item.phase)}</small><strong>{item.value ?? '—'} {item.value != null && plan.unit}</strong>
              <small>{sourceTypes[item.sourceType as keyof typeof sourceTypes] ?? sourceTypes.OTHER}</small><p>{item.source}</p><EvidenceLinks files={item.evidence} /><small>{date(item.periodStart)} — {date(item.periodEnd)}{item.sampleSize ? ` · N = ${item.sampleSize}` : ''}</small></article>)}</div> :
              <Empty title="Измерений пока нет" />}
          </Section>
          <Section title="Проверка результата" icon={<CheckCircle2 size={18} />} action={record.canVerify && <button className="button primary" onClick={() => edit.open({
            title: 'Зафиксировать результат проверки', path: path + '/verification', fields: <><Field label="Итог"><select name="outcome"><Options items={outcomes} /></select></Field>
              {textBox('Вывод', 'summary')}{textBox('Ограничения и доказательства', 'limitations')}<EvidencePicker onUploading={edit.setUploading} /></>,
            body: data => ({ outcome: field(data, 'outcome'), summary: field(data, 'summary'), limitations: field(data, 'limitations'), evidenceIds: data.getAll('evidenceIds') }),
          })}>Зафиксировать результат</button>}>
            {record.verification ? <div className="inner-stack"><div className="inline-chips"><Chip value={record.verification.outcome} /></div>
              <p className="preserve">{record.verification.summary}</p><div><h3>Ограничения</h3><p className="preserve">{record.verification.limitations}</p></div><EvidenceLinks files={record.verification.evidence} />
              <small>{date(record.verification.verifiedAt)} · План v{record.verification.planVersion} · Наблюдений: {record.verification.measurementIds.length}</small></div> :
              <Empty title="Результат ещё не проверен">{plan?.observations.length ? 'Есть предварительные наблюдения.' : 'Добавьте наблюдения и передайте результат на проверку.'}</Empty>}
          </Section>
          <Section title="Публикации" icon={<BookOpen size={18} />} action={record.canDraftPublication && <button className="button secondary" onClick={() => edit.open({
            title: 'Подготовить публикацию', path: '/publications/drafts', description: 'Подготовьте отдельное изложение для сотрудников. Уберите частные и коммерческие сведения.',
            fields: <PublicationFields />,
            body: data => ({ expectedVersion: undefined, improvementId: id, ...publicationBody(data) }),
          })}>Подготовить публикацию</button>}>
            {record.publications.length ? record.publications.map(item => <div className="task-row" key={item.id}>
              <button className="text-button" onClick={() => { pub.reset(); setPublication(item); }}>{item.title}</button>{item.state && <Chip value={item.state} />}
            </div>) : <Empty title="Публикаций пока нет" />}
          </Section>
        </Tabs.Content>
        <Tabs.Content value="feedback" className="inner-stack"><Section title="Обратная связь авторов" action={record.canInvite && <button className="button secondary" onClick={() => edit.open({
          title: 'Пригласить авторов', description: 'Авторы доступных исходных обращений получат уведомление с предложением оценить изменение.',
          path: path + '/feedback-invitations', body: () => ({}),
        })}>Пригласить авторов</button>}>
          {record.feedback.length ? record.feedback.map(item => <article className="comment" key={item.id}><strong>{item.choice ? label(item.choice) : 'Ожидаем ответа'}</strong>
            {item.comment && <p>{item.comment}</p>}{item.submittedAt && <small>{date(item.submittedAt)}</small>}</article>) : <Empty title="Ответов пока нет" />}
        </Section></Tabs.Content>
        <Tabs.Content value="history"><Section title="История улучшения"><Timeline items={record.events} /></Section></Tabs.Content>
      </Tabs.Root>
    </div><aside className="detail-side">
      <Section title="Управление"><dl className="facts"><div><dt>Владелец</dt><dd>{record.owner?.name ?? '—'}</dd></div><div><dt>Стадия</dt><dd>{label(record.status)}</dd></div></dl>
        <div className="side-actions">{record.allowedActions.map(target => {
          const reason = ['APPROVED', 'REJECTED', 'DEFERRED', 'DRAFT', 'IMPLEMENTED', 'CANCELED'].includes(target) || (target === 'IN_PROGRESS' && ['IMPLEMENTED', 'VERIFYING'].includes(record.status));
          const caption = target === 'IN_PROGRESS' && reason ? 'Вернуть в работу' : transitionLabels[target] ?? label(target);
          return <button className="button secondary" key={target} onClick={() => edit.open({ title: caption, path: path + '/transition',
            fields: reason ? textBox(target === 'IMPLEMENTED' ? 'Что внедрено' : 'Обоснование') : undefined,
            body: data => ({ target, text: optional(data, 'text') }),
          })}>{caption}</button>;
        })}{ai.data?.available && <button className="button subtle" onClick={() => { suggestion.reset(); setAiOpen(true); }}><Sparkles size={16} />Анализ Groq</button>}</div>
      </Section>
      <Section title="Основания"><References items={record.sources} path="/appeals" />{record.problem && <References items={[record.problem]} path="/problems" />}</Section>
    </aside></div>{edit.modal}
    {publication && <Modal title={publication.title} close={() => setPublication(null)}>
      <div className="inline-chips"><span className="chip tone-muted">{publication.audienceId ? 'Подразделение' : 'Все сотрудники'}</span></div>
      <PublicationPreview item={publication} /><PublicationHistory key={publication.id} id={publication.id} version={publication.version} /><ErrorBox error={pub.error} />
      {publication.reviewNote && <div className="info-box">{publication.reviewNote}</div>}
      {record.canDraftPublication && publication.authorId === user.id && ['DRAFT', 'APPROVED'].includes(publication.state ?? '') &&
        <button className="button secondary" onClick={() => {
          setPublication(null);
          edit.open({ title: 'Редактировать публикацию', path: `/publications/${publication.id}`, method: 'PATCH',
            fields: <PublicationFields item={publication} />, body: data => ({ ...publicationBody(data), expectedVersion: publication.version }) });
        }}>Редактировать публикацию</button>}
      {record.canApprovePublication && publication.authorId !== user.id && publication.state && ['DRAFT', 'APPROVED', 'PUBLISHED'].includes(publication.state) &&
        <div className="button-row">
          {!publication.reviewNote && <button className="button primary" disabled={pub.isPending} onClick={() => pub.mutate(publication.state === 'DRAFT' ? 'approve' : publication.state === 'APPROVED' ? 'publish' : 'unpublish')}>
            {publication.state === 'DRAFT' ? 'Согласовать публикацию' : publication.state === 'APPROVED' ? 'Опубликовать' : 'Отозвать публикацию'}
          </button>}
          {publication.state !== 'PUBLISHED' && <button className="button secondary" disabled={pub.isPending} onClick={() => {
            setPublication(null);
            edit.open({ title: 'Запросить правки', path: `/publications/${publication.id}/request-changes`,
              fields: textBox('Какие правки нужны', 'reason'), body: data => ({ expectedVersion: publication.version, reason: field(data, 'reason') }) });
          }}>Запросить правки</button>}
        </div>}
    </Modal>}
    {aiOpen && <Modal title="Анализ Groq" description="Цель и основание будут отправлены внешнему сервису после вашего согласия." close={() => setAiOpen(false)}>
      <ErrorBox error={suggestion.error} />{suggestion.data ? <div className="inner-stack">{suggestion.data.truncated && <p>Часть текста была сокращена.</p>}
        {Object.entries({ hypotheses: 'Гипотезы', possibleActions: 'Возможные действия', risks: 'Риски', proposedMetrics: 'Показатели', limitations: 'Ограничения' }).map(([key, title]) =>
          <div key={key}><h3>{title}</h3>{Array.isArray(suggestion.data.suggestion[key]) && (suggestion.data.suggestion[key] as string[]).map((item, index) => <p key={index}>{item}</p>)}</div>)}
        </div> : <button className="button primary" disabled={suggestion.isPending} onClick={() => suggestion.mutate()}>{suggestion.isPending ? 'Получаем подсказку…' : 'Запросить анализ'}</button>}
    </Modal>}
  </>;
}
