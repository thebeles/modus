import { DatePicker } from './date-picker';
import * as Tabs from '@radix-ui/react-tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowRight, BookOpen, CheckCircle2, Clock3, Download, GitPullRequest, Inbox, Layers3, Search, TriangleAlert } from './icons';
import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { feedbackChoices, label } from './contracts';
import { api, type AppealRow, type CaseRow, type Catalog, type Change, type Feedback, type LinkRow, type Page, queryString } from './api';
import { LinkCards, nextActionText } from './appeals';
import { useSession } from './session';
import { ActionForm, Chip, date, Empty, EntityOptions, ErrorBox, Field, field, Loading, optional, Options, PageHeading, Pagination, Section } from './ui';

type Bucket = { id: string | null; name: string; count: number };
type MetricGroup = { key: string; count: number };
type RadarData = {
  total: number; closed: number; documented: number; firstResponse: { count: number; hours: number | null };
  overdue: number; stale: number; waiting: number; improved: number; verified: number; verifiedSuccess: number; verifiedDeterminate: number; topics: number; recurrenceCandidates: number;
  types: MetricGroup[]; statuses: MetricGroup[]; outcomes: MetricGroup[]; processes: Bucket[]; categories: Bucket[]; departments?: Bucket[];
  attention: (AppealRow & { reasons: string[] })[]; improvements: CaseRow[]; topicItems: LinkRow[]; minGroup: number;
};
const attentionReason: Record<string, string> = { HIGH_PRIORITY: 'Высокий приоритет', OVERDUE: 'Просрочено', DUE_SOON: 'Срок в ближайшие сутки', NO_NEXT_OWNER: 'Нет владельца следующего действия', POSSIBLE_RECURRENCE: 'Возможный повтор' };
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const ratio = (numerator: number, denominator: number) => denominator ? `${number.format(numerator / denominator * 100)}%` : '—';

function Metric({ label, value, detail, icon, to }: { label: string; value: number | string; detail: string; icon: ReactNode; to?: string }) {
  const contents = <><span className="metric-icon">{icon}</span><span className="metric-label">{label}</span>
    <strong>{value}</strong><small>{detail}</small>{to && <ArrowRight size={16} className="metric-arrow" />}</>;
  return to ? <Link className="surface metric" to={to}>{contents}</Link> : <div className="surface metric">{contents}</div>;
}

export function RadarPage() {
  const { user, demoMode } = useSession();
  const defaults = { processId: '', departmentId: '', from: '', to: '', origin: demoMode ? 'DEMO' : 'LIVE', evidence: 'OBSERVED' };
  const [params, setParams] = useSearchParams();
  const analysis = params.get('view') === 'analytics';
  const filters = {
    processId: params.get('processId') ?? defaults.processId,
    departmentId: params.get('departmentId') ?? defaults.departmentId,
    from: params.get('from') ?? defaults.from,
    to: params.get('to') ?? defaults.to,
    origin: params.get('origin') ?? defaults.origin,
    evidence: params.get('evidence') ?? defaults.evidence,
  };
  const catalog = useQuery({ queryKey: ['catalog'], enabled: analysis, queryFn: () => api<Catalog>('/catalog') });
  const dateBoundary = (day: string, inclusiveEnd = false) => {
    if (!day) return undefined;
    const midnight = new Date(day + 'T00:00:00+05:00').getTime();
    if (!Number.isFinite(midnight)) return undefined;
    return new Date(midnight + (inclusiveEnd ? 86400000 : 0)).toISOString();
  };
  const scope = { ...filters, from: dateBoundary(filters.from), to: dateBoundary(filters.to, true) };
  const query = queryString(scope);
  const data = useQuery({ queryKey: ['radar', query], queryFn: ({ signal }) => api<RadarData>('/radar/overview' + query, { signal }) });
  const [showRecurrences, setShowRecurrences] = useState(false);
  const [recurrencePage, setRecurrencePage] = useState(1);
  const [outcome, setOutcome] = useState('');
  const [outcomePage, setOutcomePage] = useState(1);
  const requestedTab = params.get('tab') ?? '';
  const tab = ['topics', 'processes', 'improvements', 'outcomes'].includes(requestedTab) ? requestedTab : 'summary';
  const canVerify = !!user.departmentId && user.permissions.includes('RESULT_VERIFIER');
  const actionable = useQuery({ queryKey: ['problem', 'overview'], enabled: !analysis, queryFn: ({ signal }) =>
    api<Page<CaseRow>>('/problems?actionable=true&limit=3', { signal }) });
  const verifications = useQuery({ queryKey: ['improvement', 'overview'], enabled: !analysis && canVerify, queryFn: ({ signal }) =>
    api<Page<CaseRow>>('/improvements?stage=review&actionable=true&limit=3', { signal }) });
  const recurrences = useQuery({ queryKey: ['radar', 'recurrences', query, recurrencePage], enabled: analysis && tab === 'topics' && showRecurrences,
    queryFn: () => api<Page<LinkRow>>('/radar/recurrences' + queryString({ ...scope, page: recurrencePage })) });
  const outcomeRows = useQuery({ queryKey: ['radar', 'outcomes', query, outcome, outcomePage], enabled: analysis && tab === 'outcomes',
    queryFn: () => api<Page<Pick<CaseRow, 'id' | 'title' | 'status' | 'verification'>>>('/analytics/improvement-outcomes' + queryString({ ...scope, outcome, page: outcomePage })) });
  const updateFilters = (next: typeof filters) => {
    const updated = new URLSearchParams(params);
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      if (next[key] && next[key] !== defaults[key]) updated.set(key, next[key]); else updated.delete(key);
    }
    setParams(updated, { replace: true });
    setOutcomePage(1);
    setRecurrencePage(1);
  };
  const setTab = (value: string) => {
    const updated = new URLSearchParams(params);
    updated.set('tab', value);
    setParams(updated, { replace: true });
  };
  const viewLink = (analytics: boolean) => {
    const updated = new URLSearchParams(params);
    if (analytics) updated.set('view', 'analytics'); else updated.delete('view');
    return { search: updated.toString() };
  };
  const values = data.data;
  const toQueue = (extra: Record<string, string> = {}) => '/work-queue' + queryString({ ...scope, normalOnly: 'true', tab: 'all', ...extra });
  const attention = values?.attention.map(item => ({
    id: item.id, number: item.number, title: item.title, status: item.status, due: item.controlDueAt,
    href: `/work-queue/appeals/${item.id}`, next: nextActionText(item),
    reason: item.reasons.map(reason => attentionReason[reason]).filter(Boolean).join(' · ') || 'Превышен порог активности',
    rank: item.reasons.includes('OVERDUE') ? 0 : item.reasons.includes('HIGH_PRIORITY') ? 1 : item.reasons.includes('DUE_SOON') ? 2 : 5,
  })) ?? [];
  for (const [items, path, reason, next, rank] of [
    [verifications.data?.items, '/improvements', 'Ожидает независимой проверки', 'Открыть доказательства', 3],
    [actionable.data?.items, '/problems', 'Открытая проблема', 'Открыть проблему', 4],
  ] as const) {
    for (const item of items ?? []) attention.push({ ...item, href: path + '/' + item.id + (path === '/improvements' ? '?tab=result' : ''), reason, next, rank, due: null });
  }
  attention.sort((a, b) => a.rank - b.rank || (a.due ?? '').localeCompare(b.due ?? ''));
  return <><PageHeading title="Обзор" action={analysis && user.permissions.includes('EXPORT_DATA') && <a className="button secondary" href={'/api/v1/analytics/export' + query}><Download size={17} />Выгрузить CSV</a>} />
    <nav className="tab-strip" aria-label="Разделы обзора">
      <Link to={viewLink(false)} className={!analysis ? 'active' : undefined} aria-current={!analysis ? 'page' : undefined}>Требует внимания</Link>
      <Link to={viewLink(true)} className={analysis ? 'active' : undefined} aria-current={analysis ? 'page' : undefined}>Аналитика</Link>
    </nav>
    {filters.origin === 'DEMO' || filters.evidence === 'DEMO_FIXTURE' ? <div className="info-box"><Activity size={18} /> В показателях обращений выбраны демонстрационные данные.</div> : null}
    {filters.origin === 'ORIGINAL' && <div className="info-box"><Activity size={18} /> В показателях обращений выбран исходный набор данных.</div>}
    {!analysis && <>
      <ErrorBox error={data.error || actionable.error || verifications.error} retry={() => {
        void data.refetch();
        void actionable.refetch();
        if (canVerify) void verifications.refetch();
      }} />
      {(data.isPending || actionable.isPending || (canVerify && verifications.isPending)) && <Loading />}
      <div className="metric-grid overview-signals">
        {values && <>
          <Metric label="Просроченные обращения" value={values.overdue} detail="Истёк срок ответа или следующего действия" icon={<TriangleAlert size={19} />} to={toQueue({ tab: 'overdue' })} />
          <Metric label="Обращения без активности" value={values.stale} detail="Давно без изменений или без ответственного" icon={<Clock3 size={19} />} to={toQueue({ tab: 'stale' })} />
        </>}
        {actionable.data && <Metric label="Открытые проблемы" value={actionable.data.total} detail="Сигналы и подтверждённые проблемы в доступной области" icon={<GitPullRequest size={19} />} to="/improvements?view=problems&actionable=true" />}
        {canVerify && verifications.data && <Metric label="Ожидают моей проверки" value={verifications.data.total} detail="Инициативы, доступные для независимой проверки" icon={<CheckCircle2 size={19} />} to="/improvements?view=review&actionable=true" />}
      </div>
      <Section title="Требует внимания" icon={<TriangleAlert size={18} />}>
        {attention.length ? attention.map(item => <div className="task-row overview-task" key={item.href}>
          <div><Link to={item.href} state={{ returnTo: '/overview' + (params.size ? `?${params}` : '') }}>{item.title}</Link>
            <small>{item.number} · {item.reason}</small><small>{item.due ? date(item.due, true) : 'Срок не задан'} · {item.next}</small>
          </div><Chip value={item.status} />
        </div>) : values && actionable.data && (!canVerify || verifications.data) ? <Empty title="Сейчас нет задач, требующих внимания" /> : null}
      </Section>
    </>}
    {analysis && <>
    <details className="surface overview-filters"><summary>Фильтры аналитики</summary>
    <div className="filter-bar">
      <Field label="Карточки"><select value={filters.origin} onChange={event => updateFilters({ ...filters, origin: event.target.value })}>
        <option value="LIVE">Рабочие</option><option value="DEMO">Демонстрационные</option><option value="ORIGINAL">Исходный набор</option>
      </select></Field>
      <Field label="Доказательства"><select value={filters.evidence} onChange={event => updateFilters({ ...filters, evidence: event.target.value })}>
        <option value="OBSERVED">Действия в приложении и подтверждённый импорт</option><option value="DEMO_FIXTURE">Синтетические примеры</option><option value="UNKNOWN">Неустановленное происхождение</option>
      </select></Field>
      <Field label="Подразделение"><select value={filters.departmentId} onChange={event => updateFilters({ ...filters, departmentId: event.target.value })}><EntityOptions rows={catalog.data?.departments ?? []} blank="Все доступные" /></select></Field>
      <Field label="Процесс"><select value={filters.processId} onChange={event => updateFilters({ ...filters, processId: event.target.value })}><EntityOptions rows={catalog.data?.processes ?? []} blank="Все процессы" /></select></Field>
      <Field label="Создано с"><DatePicker type="date" value={filters.from} max={filters.to || undefined} onValueChange={value => updateFilters({ ...filters, from: value })} /></Field>
      <Field label="Создано по"><DatePicker type="date" value={filters.to} min={filters.from || undefined} onValueChange={value => updateFilters({ ...filters, to: value })} /></Field>
      {Object.keys(defaults).some(key => filters[key as keyof typeof filters] !== defaults[key as keyof typeof defaults]) && <button type="button" className="button subtle" onClick={() => updateFilters(defaults)}>Сбросить</button>}
    </div>
    <p className="muted">Период, подразделение и процесс применяются к карточке каждого типа. Фильтры обращения уточняют выборку улучшений по доступным источникам.</p></details>
    <ErrorBox error={data.error || catalog.error} retry={() => { void data.refetch(); void catalog.refetch(); }} />{data.isPending && <Loading />}
    {values && <>
      <div className="metric-grid">
        <Metric label="Обращения" value={values.total} detail="Карточки выбранного происхождения и периода" icon={<Inbox size={19} />} to={toQueue()} />
        <Metric label="Просрочено" value={values.overdue} detail="Истёк срок первого ответа или следующего действия" icon={<TriangleAlert size={19} />} to={toQueue({ tab: 'overdue' })} />
        <Metric label="Без активности" value={values.stale} detail="Истёк порог активности или нет ответственного" icon={<Clock3 size={19} />} to={toQueue({ tab: 'stale' })} />
        <Metric label="Тематические связи" value={values.topics} detail="Связи, включая возможные повторы" icon={<GitPullRequest size={19} />} />
      </div>
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="tab-strip radix-tabs" aria-label="Представления радара">{[
          ['summary', 'Обращения'], ['topics', 'Темы'], ['processes', 'Процессы и подразделения'], ['improvements', 'Улучшения'], ['outcomes', 'Результаты'],
        ].map(([key, title]) => <Tabs.Trigger key={key} value={key}>{title}</Tabs.Trigger>)}</Tabs.List>
        <Tabs.Content value="summary" className="inner-stack">
          <div>
            <Section title="Рассмотрение" icon={<Activity size={19} />}><dl className="facts">
              <div><dt>Закрыты по выбранным доказательствам</dt><dd><Link to={toQueue({ metric: 'closed' })}>{ratio(values.closed, values.total)} · {values.closed} из {values.total}</Link></dd></div>
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
          {[{ title: 'По процессам', field: 'processId', rows: values.processes }, { title: 'По категориям', field: 'categoryId', rows: values.categories },
            { title: 'По подразделениям', field: 'departmentId', rows: values.departments ?? [] }].map(group =>
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
          <Metric label="Критерий проверки выполнен" value={ratio(values.verifiedSuccess, values.verifiedDeterminate)} detail={`${values.verifiedSuccess} из ${values.verifiedDeterminate} с определённым итогом`} icon={<Activity size={19} />} />
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
    </>}
  </>;
}

export function Changes() {
  const [q, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const rows = useQuery({ queryKey: ['changes', q, page], queryFn: ({ signal }) => api<Page<Change>>('/publications' + queryString({ q, page, limit: 9 }), { signal }) });
  return <><PageHeading title="Что изменилось" subtitle="Что изменилось в рабочих процессах и как проверили результат." />
    <div className="surface filter-bar"><label className="search-field"><Search size={18} /><span className="sr-only">Поиск публикаций</span>
      <input placeholder="Поиск по названию" value={q} maxLength={150} onChange={event => { setQuery(event.target.value); setPage(1); }} /></label></div>
    {rows.isPending && <Loading />}<ErrorBox error={rows.error} retry={() => rows.refetch()} />
    {rows.data && (rows.data.items.length ? <div className="change-grid">{rows.data.items.map(item => <article className="surface change-card" key={item.id}>
      <div className="publication-cover"><BookOpen size={22} /></div>
      <div className="change-body"><div className="inline-chips"><small>{date(item.publishedAt)}</small>{item.verificationOutcome && <Chip value={item.verificationOutcome} />}{item.isSynthetic && <small>Демо</small>}</div>
        <Link to={`/changes/${item.id}`}><h2>{item.title}</h2></Link><p>{item.change}</p><Link className="text-button" to={`/changes/${item.id}`}>Читать результат <ArrowRight size={15} /></Link></div>
    </article>)}</div> : <div className="surface"><Empty title="Публикации не найдены" /></div>)}
    {rows.data && <Pagination {...rows.data} onChange={setPage} />}
  </>;
}

export function ChangeDetail() {
  const { id } = useParams();
  const query = useQuery({ queryKey: ['changes', id], queryFn: () => api<Change>(`/publications/${id}`) });
  const record = query.data;
  return <><PageHeading title={record?.title ?? 'Публикация'} subtitle={record ? date(record.publishedAt) : undefined} back={{ to: '/changes', label: 'Что изменилось' }} />
    {query.isPending && <Loading />}<ErrorBox error={query.error} retry={() => query.refetch()} />
    {record && <div className="reading-column"><Section title="Что изменилось" icon={<Layers3 size={19} />}><p className="preserve">{record.change}</p></Section>
      <Section title="Какую задачу решали"><p className="preserve">{record.problem}</p></Section>
      <Section title="Что показала проверка" icon={<CheckCircle2 size={19} />}>{record.verificationOutcome && <Chip value={record.verificationOutcome} />}{record.isSynthetic && <small className="demo-indicator">Демонстрационный пример</small>}<p className="preserve">{record.result}</p><h3>Метод</h3><p className="preserve">{record.method}</p>
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
