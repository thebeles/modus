import { DatePicker } from './date-picker';
import * as Tabs from '@radix-ui/react-tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowRight, BookOpen, CheckCircle2, Clock3, Download, GitPullRequest, Inbox, Layers3, Search, TriangleAlert } from './icons';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { feedbackChoices, label } from './contracts';
import { api, type AppealRow, type CaseRow, type Catalog, type Change, type Feedback, type LinkRow, type Page, queryString } from './api';
import { LinkCards } from './appeals';
import { useSession } from './session';
import { ActionForm, Chip, date, Empty, EntityOptions, ErrorBox, Field, field, Loading, optional, Options, PageHeading, Pagination, Section } from './ui';

type Bucket = { id: string | null; name: string; count: number };
type MetricGroup = { key: string; count: number };
type RadarData = {
  total: number; closed: number; documented: number; firstResponse: { count: number; hours: number | null };
  overdue: number; stale: number; waiting: number; improved: number; verified: number; verifiedSuccess: number; verifiedDeterminate: number; topics: number; recurrenceCandidates: number;
  types: MetricGroup[]; statuses: MetricGroup[]; outcomes: MetricGroup[]; processes: Bucket[]; categories: Bucket[];
  attention: AppealRow[]; improvements: CaseRow[]; topicItems: LinkRow[]; minGroup: number;
};
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const ratio = (numerator: number, denominator: number) => denominator ? `${number.format(numerator / denominator * 100)}%` : '—';

function Metric({ label, value, detail, icon, to }: { label: string; value: number | string; detail: string; icon: ReactNode; to?: string }) {
  const contents = <><span className="metric-icon">{icon}</span><span className="metric-label">{label}</span>
    <strong>{value}</strong><small>{detail}</small>{to && <ArrowRight size={16} className="metric-arrow" />}</>;
  return to ? <Link className="surface metric" to={to}>{contents}</Link> : <div className="surface metric">{contents}</div>;
}

export function RadarPage() {
  const { user, demoMode } = useSession();
  const [filters, setFilters] = useState({ processId: '', departmentId: '', from: '', to: '' });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>('/catalog') });
  const dateBoundary = (day: string, inclusiveEnd = false) => {
    if (!day) return undefined;
    const midnight = new Date(day + 'T00:00:00+05:00').getTime();
    return new Date(midnight + (inclusiveEnd ? 86400000 : 0)).toISOString();
  };
  const scope = { ...filters, from: dateBoundary(filters.from), to: dateBoundary(filters.to, true) };
  const query = queryString(scope);
  const data = useQuery({ queryKey: ['radar', query], queryFn: ({ signal }) => api<RadarData>('/radar/overview' + query, { signal }) });
  const [showRecurrences, setShowRecurrences] = useState(false);
  const [recurrencePage, setRecurrencePage] = useState(1);
  const [outcome, setOutcome] = useState('');
  const [outcomePage, setOutcomePage] = useState(1);
  const [tab, setTab] = useState('attention');
  const recurrences = useQuery({ queryKey: ['radar', 'recurrences', query, recurrencePage], enabled: tab === 'topics' && showRecurrences,
    queryFn: () => api<Page<LinkRow>>('/radar/recurrences' + queryString({ ...scope, page: recurrencePage })) });
  const outcomeRows = useQuery({ queryKey: ['radar', 'outcomes', query, outcome, outcomePage], enabled: tab === 'outcomes',
    queryFn: () => api<Page<Pick<CaseRow, 'id' | 'title' | 'status' | 'verification'>>>('/analytics/improvement-outcomes' + queryString({ ...scope, outcome, page: outcomePage })) });
  const updateFilters = (next: typeof filters) => { setFilters(next); setOutcomePage(1); setRecurrencePage(1); };
  const values = data.data;
  const toQueue = (extra: Record<string, string> = {}) => '/work-queue' + queryString({ ...scope, normalOnly: 'true', ...extra });
  return <><PageHeading title="Радар процессов" subtitle="Сигналы, сроки и результаты изменений по доступным вам записям."
    action={user.permissions.includes('EXPORT_DATA') && <a className="button secondary" href={'/api/v1/analytics/export' + query}><Download size={17} />Выгрузить CSV</a>} />
    {demoMode && <div className="info-box"><Activity size={18} /> В деморежиме примеры и результаты измерений синтетические.</div>}
    <div className="surface filter-bar">
      <Field label="Подразделение"><select value={filters.departmentId} onChange={event => updateFilters({ ...filters, departmentId: event.target.value })}><EntityOptions rows={catalog.data?.departments ?? []} blank="Все доступные" /></select></Field>
      <Field label="Процесс"><select value={filters.processId} onChange={event => updateFilters({ ...filters, processId: event.target.value })}><EntityOptions rows={catalog.data?.processes ?? []} blank="Все процессы" /></select></Field>
      <Field label="Создано с"><DatePicker type="date" value={filters.from} max={filters.to || undefined} onValueChange={value => updateFilters({ ...filters, from: value })} /></Field>
      <Field label="Создано по"><DatePicker type="date" value={filters.to} min={filters.from || undefined} onValueChange={value => updateFilters({ ...filters, to: value })} /></Field>
      {Object.values(filters).some(Boolean) && <button type="button" className="button subtle" onClick={() => updateFilters({ processId: '', departmentId: '', from: '', to: '' })}>Сбросить</button>}
    </div>
    <ErrorBox error={data.error || catalog.error} retry={() => { void data.refetch(); void catalog.refetch(); }} />{data.isPending && <Loading />}
    {values && <>
      <div className="metric-grid">
        <Metric label="Обращения" value={values.total} detail="Созданы в выбранном периоде" icon={<Inbox size={19} />} to={toQueue()} />
        <Metric label="Просрочено" value={values.overdue} detail="Истёк срок первого ответа или следующего действия" icon={<TriangleAlert size={19} />} to={toQueue({ tab: 'overdue' })} />
        <Metric label="Без активности" value={values.stale} detail="Три суток без действий или нет ответственного" icon={<Clock3 size={19} />} to={toQueue({ tab: 'stale' })} />
        <Metric label="Тематические связи" value={values.topics} detail="Связи, включая возможные повторы" icon={<GitPullRequest size={19} />} />
      </div>
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="tab-strip radix-tabs" aria-label="Представления радара">{[
          ['attention', 'Требует внимания'], ['topics', 'Темы'], ['processes', 'Процессы'], ['improvements', 'Улучшения'], ['outcomes', 'Результаты'],
        ].map(([key, title]) => <Tabs.Trigger key={key} value={key}>{title}</Tabs.Trigger>)}</Tabs.List>
        <Tabs.Content value="attention" className="inner-stack">
          <div className="detail-grid">
            <Section title="Обращения к проверке" icon={<TriangleAlert size={19} />}>{values.attention.length ? values.attention.map(item => <div className="task-row" key={item.id}>
              <div><Link to={`/work-queue/appeals/${item.id}`}>{item.title}</Link><small>{item.number} · {item.controlDueAt ? date(item.controlDueAt) : 'Срок не задан'}</small></div><Chip value={item.status} />
            </div>) : <Empty title="Нет обращений к проверке" />}</Section>
            <Section title="Рассмотрение" icon={<Activity size={19} />}><dl className="facts">
              <div><dt>Закрыты из созданных</dt><dd><Link to={toQueue({ status: 'CLOSED' })}>{ratio(values.closed, values.total)} · {values.closed} из {values.total}</Link></dd></div>
              <div><dt>С итогом среди закрытых</dt><dd><Link to={toQueue({ metric: 'documented' })}>{ratio(values.documented, values.closed)} · {values.documented} из {values.closed}</Link></dd></div>
              <div><dt>До первого ответа</dt><dd>{values.firstResponse.hours === null ? 'Нет данных' : <Link to={toQueue({ metric: 'responded' })}>{number.format(values.firstResponse.hours)} ч · N = {values.firstResponse.count}</Link>}</dd></div>
              <div><dt>Ждут уточнения</dt><dd><Link to={toQueue({ tab: 'waiting' })}>{values.waiting}</Link></dd></div>
            </dl></Section>
          </div>
          <Section title="Обращения по типам">{values.types.length ? <div className="chart" role="img" aria-label={values.types.map(row => label(row.key) + ': ' + row.count).join(', ')}>
            <ResponsiveContainer width="100%" height={230}><BarChart data={values.types.map(row => ({ name: label(row.key), count: row.count }))} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} /><XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--muted)' }} /><YAxis allowDecimals={false} width={32} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
              <Tooltip formatter={value => [value, 'Обращения']} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--control-radius)', boxShadow: 'var(--shadow)' }} />
              <Bar dataKey="count" fill="var(--chart-accent, var(--primary))" radius={[5, 5, 0, 0]} maxBarSize={58} /></BarChart></ResponsiveContainer>
            </div> : <Empty title="Нет данных за выбранный период" />}</Section>
        </Tabs.Content>
        <Tabs.Content value="topics"><Section title="Тематические связи" icon={<GitPullRequest size={18} />}>
          <p className="subtle-text section-intro">Связи основаны на теме или возможном повторе. Возможные повторы после внедрения: {values.recurrenceCandidates}. Проверяйте первичные обращения перед подтверждением.</p>
          <button type="button" className="button secondary" aria-pressed={showRecurrences} onClick={() => setShowRecurrences(!showRecurrences)}>
            {showRecurrences ? 'Все темы' : 'Показать возможные повторы'}</button>
          {showRecurrences ? <>{recurrences.isPending && <Loading />}<ErrorBox error={recurrences.error} retry={() => recurrences.refetch()} />
            {recurrences.data && <><LinkCards items={recurrences.data.items} /><Pagination {...recurrences.data} onChange={setRecurrencePage} /></>}</> :
            <LinkCards items={values.topicItems} />}</Section></Tabs.Content>
        <Tabs.Content value="processes"><div className="two-fields">
          {[{ title: 'По процессам', field: 'processId', rows: values.processes }, { title: 'По категориям', field: 'categoryId', rows: values.categories }].map(group =>
            <Section title={group.title} key={group.title}>{group.rows.length ? <div className="inner-stack">{group.rows.map(item =>
              <div className="bucket-row" key={item.id ?? 'empty'}><span>{item.id ? <Link to={toQueue({ [group.field]: item.id })}>{item.name}</Link> : item.name}</span>
                <span>{item.count}</span><div className="bucket-track"><i style={{ width: `${item.count / Math.max(1, values.total) * 100}%` }} /></div></div>)}</div> :
              <Empty title="Недостаточно данных" />}<p className="subtle-text section-intro">Группы с числом записей меньше {values.minGroup} скрыты.</p></Section>)}</div></Tabs.Content>
        <Tabs.Content value="improvements"><Section title="Доступные улучшения" icon={<Layers3 size={18} />}>
          {values.improvements.length ? values.improvements.map(item => <div className="task-row" key={item.id}><div>
            <Link to={`/improvements/${item.id}`}>{item.title}</Link><small>{item.number} · {item.owner?.name}</small></div><Chip value={item.status} /></div>) : <Empty title="Улучшения не найдены" />}
        </Section></Tabs.Content>
        <Tabs.Content value="outcomes" className="inner-stack"><div className="metric-grid three">
          <Metric label="Внедрено" value={values.improved} detail="Внедрено, проверяется или завершено" icon={<Layers3 size={19} />} />
          <Metric label="Есть проверка" value={ratio(values.verified, values.improved)} detail={`${values.verified} из ${values.improved} внедрённых`} icon={<CheckCircle2 size={19} />} />
          <Metric label="Эффект подтверждён" value={ratio(values.verifiedSuccess, values.verifiedDeterminate)} detail={`${values.verifiedSuccess} из ${values.verifiedDeterminate} с определённым итогом`} icon={<Activity size={19} />} />
        </div><Section title="Итоги проверки">
          <Field label="Исход проверки"><select value={outcome} onChange={event => { setOutcome(event.target.value); setOutcomePage(1); }}>
            <option value="">Все внедрённые</option>{values.outcomes.map(row => <option key={row.key} value={row.key}>{label(row.key)} · {row.count}</option>)}
          </select></Field>
          {outcomeRows.isPending && <Loading />}<ErrorBox error={outcomeRows.error} retry={() => outcomeRows.refetch()} />
          {outcomeRows.data && <>{outcomeRows.data.items.length ? outcomeRows.data.items.map(item => <div className="task-row" key={item.id}>
            <Link to={`/improvements/${item.id}`}>{item.title}</Link>{item.verification ? <Chip value={item.verification.outcome} /> : <small>Ожидает проверки</small>}
          </div>) : <Empty title="Улучшения не найдены" />}<Pagination {...outcomeRows.data} onChange={setOutcomePage} /></>}
        </Section></Tabs.Content>
      </Tabs.Root>
    </>}
  </>;
}

export function Changes() {
  const [q, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const rows = useQuery({ queryKey: ['changes', q, page], queryFn: ({ signal }) => api<Page<Change>>('/publications' + queryString({ q, page, limit: 9 }), { signal }) });
  return <><PageHeading title="Библиотека изменений" subtitle="Что изменилось в рабочих процессах и как проверили результат." />
    <div className="surface filter-bar"><label className="search-field"><Search size={18} /><span className="sr-only">Поиск публикаций</span>
      <input placeholder="Поиск по названию" value={q} maxLength={150} onChange={event => { setQuery(event.target.value); setPage(1); }} /></label></div>
    {rows.isPending && <Loading />}<ErrorBox error={rows.error} retry={() => rows.refetch()} />
    {rows.data && (rows.data.items.length ? <div className="change-grid">{rows.data.items.map(item => <article className="surface change-card" key={item.id}>
      <div className="publication-cover"><BookOpen size={22} /></div>
      <div className="change-body"><div className="inline-chips"><small>{date(item.publishedAt)}</small></div>
        <Link to={`/changes/${item.id}`}><h2>{item.title}</h2></Link><p>{item.change}</p><Link className="text-button" to={`/changes/${item.id}`}>Читать результат <ArrowRight size={15} /></Link></div>
    </article>)}</div> : <div className="surface"><Empty title="Публикации не найдены" /></div>)}
    {rows.data && <Pagination {...rows.data} onChange={setPage} />}
  </>;
}

export function ChangeDetail() {
  const { id } = useParams();
  const query = useQuery({ queryKey: ['changes', id], queryFn: () => api<Change>(`/publications/${id}`) });
  const record = query.data;
  return <><PageHeading title={record?.title ?? 'Публикация'} subtitle={record ? date(record.publishedAt) : undefined} back={{ to: '/changes', label: 'Библиотека изменений' }} />
    {query.isPending && <Loading />}<ErrorBox error={query.error} retry={() => query.refetch()} />
    {record && <div className="reading-column"><Section title="Что изменилось" icon={<Layers3 size={19} />}><p className="preserve">{record.change}</p></Section>
      <Section title="Какую задачу решали"><p className="preserve">{record.problem}</p></Section>
      <Section title="Что показала проверка" icon={<CheckCircle2 size={19} />}><p className="preserve">{record.result}</p><h3>Метод</h3><p className="preserve">{record.method}</p>
        <h3>Ограничения</h3><p className="preserve">{record.limitations}</p></Section></div>}
  </>;
}

export function FeedbackPage() {
  const { id } = useParams();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['feedback', id], queryFn: () => api<Feedback>(`/feedback/${id}`) });
  const save = useMutation({ mutationFn: (data: FormData) => api<Feedback>(`/feedback/${id}/respond`, { method: 'POST',
    body: { expectedVersion: query.data?.version, choice: field(data, 'choice'), comment: optional(data, 'comment') } }),
    onSuccess: data => client.setQueryData(['feedback', id], data) });
  return <><PageHeading title="Оцените изменение" subtitle="Помогло ли изменение в работе? Ответ можно обновить." back={{ to: '/notifications', label: 'Уведомления' }} />
    {query.isPending && <Loading />}<ErrorBox error={query.error} retry={() => query.refetch()} />
    {query.data && <div className="surface form-panel">
      {query.data.submittedAt && <p className="success-box" role="status"><CheckCircle2 size={18} />Ответ сохранён {date(query.data.submittedAt, true)}</p>}
      <ActionForm pending={save.isPending} error={save.error} onSubmit={data => save.mutate(data)} submit="Сохранить ответ" reload={() => query.refetch()}>
        <Field label="Помогло ли изменение?"><select name="choice" defaultValue={query.data.choice ?? ''} required><Options items={feedbackChoices} blank="Выберите ответ" /></select></Field>
        <Field label="Комментарий"><textarea name="comment" defaultValue={query.data.comment} rows={5} minLength={5} /></Field>
      </ActionForm></div>}
  </>;
}
