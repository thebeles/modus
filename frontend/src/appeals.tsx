import { DatePicker } from './date-picker';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BookOpen, CheckCircle2, ChevronRight, FileText, GitPullRequest,
  LockKeyhole, MessageCircle, Paperclip, Search, Send, Sparkles } from './icons';
import { lazy, useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { appealStatuses, appealTypes, label, priorities, resolutions } from './contracts';
import { api, type Appeal, type AppealRow, type Catalog, type LinkRow, type Page, queryString, type Reference } from './api';
import { useSession } from './session';
import { StaffAnonymousThread } from './anonymous';
import { AppealTriage } from './appeal-triage';
import { AppealComposer, JoinedAppeals } from './appeal-composer';
export { NewAppeal } from './appeal-composer';

import { ActionForm, AiDecision, Chip, date, Empty, EntityOptions, ErrorBox, Field, field, Loading, Modal, optional, Options, PageHeading, Pagination, Section, TableRegion, timestamp } from './ui';

const nextActionLabels: Record<string, string> = {
  NONE: 'Рассмотрение завершено', TRIAGE: 'Первичное рассмотрение', DECISION: 'Рассмотрение и решение',
  EXECUTION: 'Работа над обращением', AUTHOR_RESPONSE: 'Ответ автора', ROUTING: 'Назначение ответственного',
};

function nextActionText(item: Pick<AppealRow, 'nextActionKind' | 'status'>) {
  if (item.status === 'IMPLEMENTED') return 'Проверка результата автором';
  if (item.nextActionKind && nextActionLabels[item.nextActionKind]) return nextActionLabels[item.nextActionKind];
  if (['CLOSED', 'WITHDRAWN'].includes(item.status)) return nextActionLabels.NONE;
  if (item.status === 'WAITING_AUTHOR') return nextActionLabels.AUTHOR_RESPONSE;
  if (item.status === 'IN_PROGRESS') return nextActionLabels.EXECUTION;
  return item.status === 'NEW' ? nextActionLabels.TRIAGE : nextActionLabels.DECISION;
}

function AppealTable({ rows, staff = false, compact = false, returnTo }: { rows: AppealRow[]; staff?: boolean; compact?: boolean; returnTo?: string }) {
  const tableClass = ['data-table', 'appeal-table', !staff && 'personal-appeal-table', compact && 'compact'].filter(Boolean).join(' ');
  return <TableRegion label={compact ? 'Мои последние обращения' : staff ? 'Очередь обращений' : 'Мои обращения'}><table className={tableClass}><thead><tr>
    <th>Обращение</th><th>Статус</th>{!compact && <th className="appeal-context">{staff ? 'Подразделение' : 'Тип'}</th>}<th>{staff ? 'Срок' : 'Дата'}</th><th className="appeal-arrow"><span className="sr-only">Открыть</span></th>
  </tr></thead><tbody>{rows.map(item => {
    const dueAt = ['CLOSED', 'WITHDRAWN', 'IMPLEMENTED'].includes(item.status) ? null :
      [item.controlDueAt, item.resolutionDueAt].filter((value): value is string => !!value).sort()[0];
    const overdue = staff && !!dueAt && Date.parse(dueAt) < Date.now();
    const to = `${staff && item.recommendedAction !== 'AUTHOR_RESPONSE' ? '/work-queue' : ''}/appeals/${item.id}`;
    if (item.routingOnly) return <tr key={item.id}><td><span className="table-title"><span><small>{item.number}</small><strong>{item.title}</strong></span></span></td>
      <td><Chip value={item.status} /></td><td className="appeal-context">{item.department?.name}</td><td className="date-cell">Назначается</td><td className="appeal-arrow" /></tr>;
    return <tr key={item.id}><td><Link className="table-title" to={to} state={{ returnTo }}><span className="row-icon"><FileText size={17} /></span><span>
      <small>{item.number}{item.isSynthetic && <span className="tiny-demo"> · демо</span>}{item.visibility !== 'NORMAL_INTERNAL' && <LockKeyhole size={12} aria-label="Ограниченный доступ" />}</small><strong>{item.title}</strong>
      {!compact && <small className="appeal-context-mobile">{staff ? item.department?.name : label(item.type)}</small>}
      {staff && <small className="queue-next">{nextActionText(item)}</small>}
    </span></Link></td><td><Chip value={item.status} /></td>{!compact && <td className="appeal-context">{staff ? item.department?.name ?? '—' : label(item.type)}</td>}
      <td className="date-cell">{overdue && <strong className="overdue-label">Просрочено</strong>}{staff ? dueAt ? date(dueAt, true) : '—' : date(item.createdAt)}</td>
      <td className="appeal-arrow"><Link className="icon-button row-arrow" to={to} state={{ returnTo }} aria-label={`Открыть ${item.number}`}>{compact ? <ArrowRight size={18} /> : <ChevronRight size={17} />}</Link></td></tr>;
  })}</tbody></table></TableRegion>;
}

export function Home() {
  return <div className="home-compose"><h1 className="sr-only">Главная</h1><AppealComposer /></div>;
}

const queueTabs = [['mine', 'Мои задачи'], ['in-progress', 'В работе'], ['waiting', 'Ждут автора'], ['review-result', 'Ожидают проверки'], ['overdue', 'Просроченные'], ['all', 'Все']] as const;
const additionalTabs = [['unassigned', 'Без маршрута'], ['new', 'Новые / без назначения'], ['risk', 'Под риском'], ['stale', 'Без активности'], ['urgent', 'Срочно'], ['attention-mine', 'Нужно моё действие']] as const;
const filterKeys = ['q', 'status', 'type', 'priority', 'categoryId', 'departmentId', 'processId', 'sort', 'from', 'to',
  'normalOnly', 'assigneeId', 'dueFrom', 'dueTo', 'metric', 'origin', 'evidence'];

export function AppealChannels({ staff = false }: { staff?: boolean }) {
  const { user } = useSession();
  const location = useLocation();
  const tabs = staff ? [['/work-queue', 'Очередь'], ['/customer-reviews', 'Клиентские отзывы']] :
    [['/my/appeals', 'Мои обращения'], ['/proposals', 'Предложения подразделения']];
  if (!user.departmentId || user.role === 'DIRECTOR' || (!staff && user.role === 'ADMIN')) return null;
  return <nav className="context-links" aria-label={staff ? 'Каналы обратной связи' : 'Обращения и предложения'}>
    {tabs.map(([to, title]) => <NavLink key={to} to={typeof location.state?.returnTo === 'string' && location.state.returnTo.startsWith(to + '?') ? location.state.returnTo : to}
      state={{ returnTo: location.pathname + location.search }}>{title}</NavLink>)}
  </nav>;
}

export function AppealList({ staff = false }: { staff?: boolean }) {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>('/catalog') });
  const assignees = useQuery({ queryKey: ['appeal-assignees'], enabled: staff,
    queryFn: () => api<{ id: string; name: string }[]>('/work-queue/assignees') });
  const defaultTab = user.role === 'HANDLER' || user.role === 'MANAGER' ? 'mine' : 'all';
  const tab = params.get('tab') ?? (params.size ? 'all' : defaultTab);
  const page = Number(params.get('page')) || 1;
  const filter = Object.fromEntries(filterKeys.map(key => [key, params.get(key) ?? undefined]));
  const activeFilters = filterKeys.filter(key => key !== 'q' && filter[key]).length;
  const additionalView = additionalTabs.some(([key]) => key === tab);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const endpoint = (staff ? '/work-queue' : '/appeals') + queryString({ ...filter, tab: staff ? tab : undefined, own: staff ? undefined : 'true', page, limit: 15 });
  const rows = useQuery({ queryKey: ['appeals', endpoint], queryFn: ({ signal }) => api<Page<AppealRow>>(endpoint, { signal }), placeholderData: keepPreviousData });
  const apply = (key: string, value: string) => {
    const updated = new URLSearchParams(params);
    if (key !== 'page') updated.delete('page');
    if (staff && key !== 'tab' && !updated.has('tab')) updated.set('tab', tab);
    if (value) updated.set(key, value); else updated.delete(key);
    setParams(updated, { replace: true, state: location.state });
  };
  const reset = () => setParams(staff ? { tab } : {}, { replace: true, state: location.state });
  const dateFilter = (key: string, title: string) => <Field label={title}><DatePicker type="datetime-local" value={filter[key]?.slice(0, 16) ?? ''}
    onValueChange={value => apply(key, value && new Date(value + 'Z').toISOString())} /></Field>;
  const previous = location.state?.returnTo;
  const back = staff && typeof previous === 'string' && previous.split('?')[0] === '/overview' ? { to: previous, label: 'Обзор' } : undefined;
  return <><PageHeading back={back} title={staff ? user.role === 'MANAGER' ? 'Обращения' : 'Очередь' : 'Мои обращения'} />
    <AppealChannels staff={staff} />
    {!staff && <JoinedAppeals />}
    {staff && <nav className="tab-strip" aria-label="Представления очереди">{queueTabs.map(([key, title]) =>
      <button type="button" aria-pressed={tab === key} key={key} onClick={() => apply('tab', key)}>{title}</button>)}
      {user.permissions.includes('ROUTING_COORDINATOR') && <button type="button" aria-pressed={tab === 'unassigned'} onClick={() => apply('tab', 'unassigned')}>Без маршрута</button>}
    </nav>}
    <div className="surface filter-bar">
      <label className="search-field"><Search size={18} aria-hidden="true" /><span className="sr-only">Поиск по обращениям</span><input placeholder="Поиск по номеру или тексту" value={filter.q ?? ''} onChange={event => apply('q', event.target.value)} maxLength={150} /></label>
      <button type="button" className="button secondary" aria-expanded={filtersOpen} aria-controls="appeal-filters" onClick={() => setFiltersOpen(!filtersOpen)}>
        Фильтры{activeFilters > 0 ? ` (${activeFilters})` : ''}{additionalView ? ` · ${additionalTabs.find(([key]) => key === tab)?.[1]}` : ''}
      </button>
      <div id="appeal-filters" className="queue-filters" hidden={!filtersOpen}>
        <div className="advanced-filter-fields">
          {staff && <Field label="Представление очереди"><select value={tab} onChange={event => apply('tab', event.target.value)}>
            {[...queueTabs, ...additionalTabs].map(([key, title]) => <option key={key} value={key}>{title}</option>)}
          </select></Field>}
          <Field label="Статус"><select value={filter.status ?? ''} onChange={event => apply('status', event.target.value)}><Options items={appealStatuses} blank="Все статусы" /></select></Field>
          <Field label="Тип"><select value={filter.type ?? ''} onChange={event => apply('type', event.target.value)}><Options items={appealTypes} blank="Все типы" /></select></Field>
          <Field label="Категория"><select value={filter.categoryId ?? ''} onChange={event => apply('categoryId', event.target.value)}><EntityOptions rows={catalog.data?.categories ?? []} blank="Все категории" /></select></Field>
          {staff && <>
            <Field label="Подразделение"><select value={filter.departmentId ?? ''} onChange={event => apply('departmentId', event.target.value)}><EntityOptions rows={catalog.data?.departments ?? []} blank="Все подразделения" /></select></Field>
            <Field label="Процесс"><select value={filter.processId ?? ''} onChange={event => apply('processId', event.target.value)}><EntityOptions rows={catalog.data?.processes ?? []} blank="Все процессы" /></select></Field>
            <Field label="Приоритет"><select value={filter.priority ?? ''} onChange={event => apply('priority', event.target.value)}><Options items={priorities} blank="Все приоритеты" /></select></Field>
            <Field label="Исполнитель"><select value={filter.assigneeId ?? ''} onChange={event => apply('assigneeId', event.target.value)}><EntityOptions rows={assignees.data ?? []} blank="Все исполнители" /></select></Field>
            {dateFilter('dueFrom', 'Срок с (UTC)')}{dateFilter('dueTo', 'Срок до (UTC)')}
          </>}
          {dateFilter('from', 'Создано с (UTC)')}{dateFilter('to', 'Создано до (UTC)')}
          <Field label="Сортировка"><select value={filter.sort ?? 'recent'} onChange={event => apply('sort', event.target.value)}><option value="recent">Сначала новые</option><option value="oldest">Сначала ранние</option>{staff && <option value="due">По сроку</option>}</select></Field>
          {staff && <>
            <Field label="Происхождение карточки"><select value={filter.origin ?? ''} onChange={event => apply('origin', event.target.value)}><option value="">Все источники</option><option value="LIVE">Рабочие</option><option value="DEMO">Демонстрационные</option><option value="ORIGINAL">Исходный набор</option></select></Field>
            <Field label="Доказательства"><select value={filter.evidence ?? 'OBSERVED'} onChange={event => apply('evidence', event.target.value === 'OBSERVED' ? '' : event.target.value)}><option value="OBSERVED">Действия и подтверждённый импорт</option><option value="DEMO_FIXTURE">Синтетические примеры</option><option value="UNKNOWN">Неустановленное происхождение</option></select></Field>
            <Field label="Показатель обзора"><select value={filter.metric ?? ''} onChange={event => apply('metric', event.target.value)}><option value="">Все</option><option value="closed">Закрытые</option><option value="documented">Закрытые с итогом</option><option value="responded">С первым ответом</option></select></Field>
            <label className="checkbox-line"><input type="checkbox" checked={filter.normalOnly === 'true'} onChange={event => apply('normalOnly', event.target.checked ? 'true' : '')} /> Только с обычным доступом</label>
          </>}
        </div>
        {(activeFilters > 0 || filter.q) && <button className="button subtle" type="button" onClick={reset}>Очистить фильтры</button>}
      </div>
    </div>
    <ErrorBox error={rows.error || catalog.error || assignees.error} retry={() => { void rows.refetch(); void catalog.refetch(); if (staff) void assignees.refetch(); }} />{rows.isPending && <Loading />}
    {rows.data && !rows.error && <div className={staff ? 'surface' : 'surface personal-appeal-list'}>
      <div className="list-meta" aria-live="polite">{rows.isFetching ? 'Обновляем…' : `Найдено: ${rows.data.total}`}</div>
      {rows.data.items.length ? <AppealTable rows={rows.data.items} staff={staff} returnTo={location.pathname + location.search} /> :
        <Empty title={filter.q ? 'По вашему запросу ничего не найдено' : activeFilters ? 'По выбранным фильтрам обращений нет' : staff && tab === 'mine' ? 'Сейчас у вас нет задач по обращениям' : 'Обращений пока нет'}>
          {(activeFilters > 0 || filter.q) && <button className="button subtle" type="button" onClick={reset}>Сбросить фильтры</button>}
          {staff && tab !== 'all' && <button className="button subtle" type="button" onClick={() => apply('tab', 'all')}>Показать все обращения</button>}
        </Empty>}
      <Pagination {...rows.data} onChange={next => apply('page', String(next))} />
    </div>}
  </>;
}

const actionNames: Record<string, string> = {
  REVIEW: 'Взять на рассмотрение', IN_PROGRESS: 'В работу', RESUME: 'Возобновить рассмотрение', CLARIFICATION: 'Запросить уточнение',
  AUTHOR_RESPONSE: 'Ответить на уточнение', RESOLVE: 'Закрыть с решением', WITHDRAW: 'Отозвать обращение',
  REVIEW_REQUEST: 'Запросить пересмотр', REVIEW_DECISION: 'Рассмотреть запрос', ASSIGN: 'Назначить ответственного', REROUTE: 'Перенаправить', EDIT: 'Редактировать',
  CREATE_PROBLEM: 'Создать проблему', CREATE_IMPROVEMENT: 'Создать улучшение',
  SHARE_TOPIC: 'Опубликовать общую тему',
  SET_RESOLUTION_DEADLINE: 'Изменить срок решения',
};

export function LinkCards({ items, onChanged }: { items: LinkRow[]; onChanged?: () => void }) {
  const { user } = useSession();
  const client = useQueryClient();
  const [decision, setDecision] = useState<{ link: LinkRow; operation: 'confirm' | 'reject' } | null>(null);
  const update = useMutation({ mutationFn: (data: FormData) => api(`/object-links/${decision?.link.id}/${decision?.operation}`, {
    method: 'POST', body: { expectedVersion: decision?.link.version, sameIssue: data.has('sameIssue'), reason: optional(data, 'reason') },
  }), onSuccess: () => { setDecision(null); void client.invalidateQueries({ queryKey: ['radar'] }); onChanged?.(); } });
  return <>{items.length ? <div className="link-cards">{items.map(item => <article key={item.id} className="link-card">
    <div className="inline-chips"><Chip value={item.relation} /><Chip value={item.state} /></div>
    <div className="link-pair"><Link to={`/appeals/${item.from.id}`}>{item.from.number} · {item.from.title}</Link><Link to={`/appeals/${item.to.id}`}>{item.to.number} · {item.to.title}</Link></div>
    <p>{item.explanation}</p><small>Источник: {item.proposedBy === 'SYSTEM_RULE' ? 'правило' : item.proposedBy === 'AI' ? 'подсказка' : 'сотрудник'}</small>
    {item.state === 'SUGGESTED' && user.permissions.includes('PROBLEM_OWNER') && <div className="button-row">
      <button className="button secondary" onClick={() => { update.reset(); setDecision({ link: item, operation: 'confirm' }); }}>Подтвердить связь</button>
      <button className="button subtle" onClick={() => { update.reset(); setDecision({ link: item, operation: 'reject' }); }}>Отклонить связь</button></div>}
  </article>)}</div> : <Empty title="Связей пока нет" />}
  {decision && <Modal title={decision.operation === 'confirm' ? 'Подтвердить связь' : 'Отклонить связь'} close={() => setDecision(null)}>
    <ActionForm pending={update.isPending} error={update.error} onSubmit={data => update.mutate(data)}>
      {decision.operation === 'confirm' && decision.link.relation === 'POSSIBLE_DUPLICATE' && <label className="checkbox-line"><input type="checkbox" name="sameIssue" /> Подтверждаю, что это один случай</label>}
      <Field label="Обоснование"><textarea rows={3} name="reason" /></Field>
    </ActionForm>
  </Modal>}</>;
}

const LinkedReviews = lazy(() => import('./feedback-channels').then(module => ({ default: module.LinkedReviews })));

function RelatedAppeals({ record, reload }: { record: Appeal; reload: () => void }) {
  const { user } = useSession();
  const [show, setShow] = useState(false);
  const [candidate, setCandidate] = useState<Reference | null>(null);
  const similar = useQuery({ queryKey: ['similar', record.id], queryFn: () => api<(Reference & { explanation: string })[]>(`/object-links/similar/${record.id}`), enabled: show });
  const ai = useQuery({ queryKey: ['ai'], queryFn: () => api<{ available: boolean }>('/ai/capabilities') });
  const suggestion = useMutation({ mutationFn: (feature: string) => api<{ mode: 'GROQ' | 'RULE'; usageId?: string; suggestion?: Record<string, unknown>; candidates?: (Reference & { explanation: string })[] }>(`/ai/${feature}`, { method: 'POST', body: { id: record.id, consent: true } }) });
  const [aiFeature, setAiFeature] = useState<string | null>(null);
  const create = useMutation({ mutationFn: (data: FormData) => api('/object-links/suggest-or-create', { method: 'POST', body: {
    fromId: record.id, toId: candidate?.id, relation: field(data, 'relation'), explanation: field(data, 'explanation'),
  } }), onSuccess: () => { setCandidate(null); reload(); } });
  return <Section title="Связи и похожие темы" icon={<GitPullRequest size={18} />}>
    <LinkCards items={record.links} onChanged={reload} />
    <div className="button-row spaced">
      <button className="button secondary" onClick={() => setShow(!show)}><Search size={16} />{show ? 'Скрыть похожие' : 'Найти похожие'}</button>
      {ai.data?.available && ['similar-appeals', 'handler-summary'].map((feature, index) => <button className="button subtle" key={feature}
        onClick={() => { suggestion.reset(); setAiFeature(feature); }}><Sparkles size={16} />{index ? 'Сводка Groq' : 'Поиск Groq'}</button>)}
    </div>
    {show && <div className="inner-stack"><small>Поиск по категории, процессу и словам заголовка.</small><ErrorBox error={similar.error} retry={() => similar.refetch()} />
      {similar.isPending ? <Loading /> : similar.data?.length ? similar.data.map(item => <div key={item.id} className="file-line">
        <Link to={`/appeals/${item.id}`}>{item.number} · {item.title}</Link><small>{item.explanation}</small>
        {user.permissions.includes('PROBLEM_OWNER') && <button className="button subtle" onClick={() => { create.reset(); setCandidate(item); }}>Предложить связь</button>}
      </div>) : <Empty title="Похожих доступных обращений нет" />}</div>}
    {candidate && <Modal title="Предложить связь" description={candidate.title} close={() => setCandidate(null)}>
      <ActionForm pending={create.isPending} error={create.error} onSubmit={data => create.mutate(data)}>
        <Field label="Тип связи"><select name="relation"><Options items={['SIMILAR_TOPIC', 'POSSIBLE_DUPLICATE', 'RELATED_CONTEXT']} /></select></Field>
        <Field label="Основание"><textarea name="explanation" rows={4} required minLength={5} /></Field>
      </ActionForm></Modal>}
    {aiFeature && <Modal title="Подсказка Groq" description="Разрешённые данные будут отправлены внешнему сервису после вашего согласия." close={() => setAiFeature(null)}>
      <ErrorBox error={suggestion.error} />
      {suggestion.data ? <div className="inner-stack">
        {suggestion.data.mode === 'RULE' && (suggestion.data.candidates?.length ? suggestion.data.candidates.map(item => <div className="file-line" key={item.id}>
          <Link to={`/appeals/${item.id}`}>{item.number} · {item.title}</Link><small>{item.explanation}</small></div>) : <Empty title="Похожих доступных обращений нет" />)}
        {Object.entries(suggestion.data.suggestion ?? {}).filter(([key]) => key !== 'sourceEventIds').map(([key, value]) =>
        <div key={key}>{typeof value === 'string' ? <p>{value}</p> : Array.isArray(value) && value.map((item, index) =>
          typeof item === 'string' ? <p key={index}>{item}</p> : <p key={index}><Link to={`/appeals/${item.candidateId}`}>Открыть похожее обращение</Link> · {item.explanation}</p>)}</div>)}
        {Array.isArray(suggestion.data.suggestion?.sourceEventIds) && suggestion.data.suggestion.sourceEventIds.flatMap(id => {
          const event = record.events.find(row => row.id === id);
          return event ? [<a key={event.id} href={`#event-${event.id}`} onClick={() => setAiFeature(null)}>{label(event.action)} · {date(event.createdAt, true)}</a>] : [];
        })}
        {suggestion.data.usageId && <AiDecision usageId={suggestion.data.usageId} onDecide={() => setAiFeature(null)} />}
      </div> :
        <button className="button primary" disabled={suggestion.isPending} onClick={() => suggestion.mutate(aiFeature)}>{suggestion.isPending ? 'Получаем подсказку…' : 'Запросить подсказку'}</button>}
    </Modal>}
  </Section>;
}

export function AppealDetail() {
  const { id } = useParams();
  return <AppealDetailContent key={id} />;
}

function AppealDetailContent() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const section = location.hash.slice(1);
  const { user } = useSession();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['appeal', id], queryFn: () => api<Appeal>(`/appeals/${id}`) });
  const [action, setAction] = useState<string | null>(null);
  const [actionVersion, setActionVersion] = useState<number>();
  const [notes, setNotes] = useState(false);
  const [drafts, setDrafts] = useState({ external: '', internal: '' });
  const channel = notes ? 'internal' : 'external';
  const [resolution, setResolution] = useState('RESOLVED');
  const [targetSearch, setTargetSearch] = useState('');
  const [targetPage, setTargetPage] = useState(1);
  const [notice, setNotice] = useState('');
  const [returning, setReturning] = useState(false);
  const record = query.data;
  const recordId = record?.id;
  useEffect(() => {
    if (recordId && ['appeal-actions', 'appeal-dialogue'].includes(section)) {
      const target = document.getElementById(section);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'start' });
    }
  }, [recordId, section]);
  const staff = !!record && record.authorId !== user.id;
  const catalog = useQuery({ queryKey: ['catalog', id], queryFn: () => api<Catalog>(`/catalog?appealId=${id}`), enabled: !!action && ['EDIT', 'ASSIGN', 'REROUTE'].includes(action) });
  const targets = useQuery({ queryKey: ['appeals', id, 'resolution-targets', resolution, targetSearch, targetPage],
    queryFn: ({ signal }) => api<Page<Reference>>(`/appeals/${id}/resolution-targets` + queryString({ type: resolution, q: targetSearch, page: targetPage }), { signal }),
    enabled: action === 'RESOLVE' && ['LINKED_TO_EXISTING_CASE', 'ALREADY_ADDRESSED', 'TRANSFERRED'].includes(resolution) });
  const update = useMutation({ mutationFn: ({ data, edit }: { data: Record<string, unknown>; edit?: boolean }) => api<Appeal>(
    `/appeals/${id}${edit ? '' : '/transition'}`, { method: edit ? 'PATCH' : 'POST', body: { expectedVersion: action ? actionVersion : record?.version, ...data } }),
  onSuccess: (item, { data }) => {
    client.setQueryData(['appeal', id], item);
    void client.invalidateQueries({ queryKey: ['appeals'] });
    if (item.authorId === null) void client.invalidateQueries({ queryKey: ['anonymous-thread', id] });
    if (data.action === 'COMMENT') {
      const sent = data.internal ? 'internal' : 'external';
      setDrafts(previous => previous[sent] === data.text ? { ...previous, [sent]: '' } : previous);
    } else setAction(null);
    setNotice('Изменения сохранены.');
  } });
  const reroute = useMutation({ mutationFn: (data: FormData) => api<{ readable: boolean }>(`/appeals/${id}/reroute`, { method: 'POST', body: {
    expectedVersion: actionVersion, categoryId: optional(data, 'categoryId') ?? null, processId: optional(data, 'processId') ?? null,
    text: field(data, 'text'),
  } }), onSuccess: result => {
    void client.invalidateQueries({ queryKey: ['appeals'] });
    if (!result.readable) {
      client.removeQueries({ queryKey: ['appeal', id], exact: true });
      navigate('/work-queue');
      return;
    }
    void query.refetch();
    setAction(null);
    setNotice('Маршрут обновлён.');
  } });
  const share = useMutation({ mutationFn: (data: FormData) => api(`/intake/shared/${id}/publish`, {
    method: 'POST', body: { expectedVersion: actionVersion, title: optional(data, 'sharedTitle') ?? null },
  }), onSuccess: () => {
    void query.refetch();
    setAction(null);
    setNotice('Общая тема обновлена.');
  } });
  const reviewResult = useMutation({ mutationFn: (input: { confirm: boolean; reason?: string }) =>
    api<Appeal>(`/appeals/${id}/result-review`, { method: 'POST', body: { expectedVersion: record?.resolutionVersion, ...input } }),
  onSuccess: (item, { confirm }) => {
    client.setQueryData(['appeal', id], item);
    void client.invalidateQueries({ queryKey: ['appeals'] });
    setReturning(false);
    setNotice(confirm ? 'Результат подтверждён.' : 'Обращение возвращено в работу.');
  } });
  const deadline = useMutation({ mutationFn: (data: FormData) =>
    api<Appeal>(`/appeals/${id}/resolution-deadline`, { method: 'POST', body: {
      expectedVersion: actionVersion, dueAt: timestamp(data, 'dueAt') ?? null, reason: field(data, 'text'),
    } }),
  onSuccess: item => {
    client.setQueryData(['appeal', id], item);
    void client.invalidateQueries({ queryKey: ['appeals'] });
    setAction(null);
    setNotice('Срок решения обновлён.');
  } });
  if (!record) return <><PageHeading title="Обращение" />{query.isPending ? <Loading /> : <ErrorBox error={query.error} retry={() => query.refetch()} />}</>;
  const can = (key: string) => record.allowedActions.includes(key);
  const saving = update.isPending || reroute.isPending || share.isPending || reviewResult.isPending || deadline.isPending;
  const awaitingAnswer = can('AUTHOR_RESPONSE');
  const sideActions = record.allowedActions.filter(item => actionNames[item] && item !== 'EDIT' && item !== 'AUTHOR_RESPONSE');
  const primaryByStatus: Record<string, string[]> = {
    NEW: ['REVIEW'], REVIEW: ['IN_PROGRESS'], IN_PROGRESS: ['RESOLVE'], WAITING_AUTHOR: ['RESUME'],
  };
  const primary = ['REVIEW_DECISION', ...(primaryByStatus[record.status] ?? [])].find(item => sideActions.includes(item));
  const clarify = sideActions.includes('CLARIFICATION');
  const secondary = sideActions.filter(item => item !== primary && item !== 'CLARIFICATION' && !['CREATE_PROBLEM', 'SHARE_TOPIC'].includes(item));
  const linkedReviews = staff && record.visibility === 'NORMAL_INTERNAL' && record.departmentId &&
    record.departmentId === user.departmentId && record.isSynthetic === user.demo;
  const openAction = (operation: string) => {
    update.reset();
    reroute.reset();
    share.reset();
    deadline.reset();
    setNotice('');
    setActionVersion(record.version);
    if (operation === 'RESOLVE') setResolution(record.status === 'WAITING_AUTHOR' ? 'INSUFFICIENT_INFO' : 'RESOLVED');
    setAction(operation);
  };
  const refreshAction = async () => {
    const result = await query.refetch();
    if (!result.data || result.isError) return;
    setActionVersion(result.data.version);
    update.reset();
    reroute.reset();
    share.reset();
    deadline.reset();
  };
  const next = record.status === 'IMPLEMENTED' ? 'Проверка результата автором' :
    record.routingPending ? nextActionLabels.ROUTING : nextActionText({ ...record, nextActionKind: record.nextAction?.kind });
  const nextDue = record.nextAction ? record.nextAction.dueAt : record.controlDueAt;
  const plain = ['REVIEW', 'IN_PROGRESS'].includes(action ?? '') && record.status !== 'IN_PROGRESS';
  const fromQueue = location.pathname.startsWith('/work-queue/');
  const listPath = fromQueue ? '/work-queue' : '/my/appeals';
  const previousList = location.state?.returnTo;
  const previousPath = typeof previousList === 'string' ? previousList.split('?')[0] : undefined;
  const fromOverview = previousPath === '/overview';
  const backTo = ['/work-queue', '/my/appeals', '/overview'].includes(previousPath ?? '') ? previousList : listPath;
  return <><PageHeading title={record.title} subtitle={`${record.number} · ${label(record.type)} · ${date(record.createdAt)}`}
    back={{ to: backTo, label: fromOverview ? 'Обзор' : fromQueue || previousPath === '/work-queue' ? 'Очередь' : 'Мои обращения' }}
    action={<Chip value={record.status} />} />
    {(notice || location.state?.created) && <div className="success-box" role="status"><CheckCircle2 size={18} />{notice || `Обращение ${record.number} зарегистрировано.`}</div>}
    {record.routingPending && <div className="success-box" role="status">Обращение зарегистрировано. Назначение будет повторено автоматически.</div>}
    <div className="appeal-reading"><div className="detail-main">
      <Section title="Об обращении" icon={<FileText size={18} />} action={can('EDIT') ? <button className="text-button" disabled={saving} onClick={() => openAction('EDIT')}>Редактировать</button> : undefined}>
        <div className="inline-chips"><Chip value={record.priority} />{record.visibility !== 'NORMAL_INTERNAL' && <Chip value={record.visibility} />}</div>
        <p className="preserve detail-text">{record.description}</p>
        {record.proposedSolution && <><h3>Предложенное решение</h3><p className="preserve">{record.proposedSolution}</p></>}
        {record.attachments.map(file => <a className="file-line" key={file.id} href={`/api/v1/attachments/${file.id}/download`}><Paperclip size={16} />{file.name}<small>{Math.max(1, Math.ceil(file.bytes / 1024))} КБ</small></a>)}
      <div id="appeal-actions" className="appeal-workflow" tabIndex={-1}>
        <dl className="facts"><div><dt>Действие</dt><dd>{next}</dd></div><div><dt>Ответственный</dt><dd>{record.status === 'WAITING_AUTHOR' ? 'Автор обращения' : record.assignee?.name ?? record.queue?.name ?? 'Служба обработки'}</dd></div>
          <div><dt>Срок следующего шага</dt><dd>{nextDue ? date(nextDue, true) : 'Срок не задан'}</dd></div>
          <div><dt>Первый ответ</dt><dd>{record.firstHumanResponseAt ? date(record.firstHumanResponseAt, true) : record.firstResponseDueAt ? `до ${date(record.firstResponseDueAt, true)}` : 'Срок не задан'}</dd></div>
          <div><dt>Срок решения</dt><dd>{record.resolutionDueAt ? date(record.resolutionDueAt, true) : 'Срок не задан'}</dd></div>
          <div><dt>Автор</dt><dd>{record.author?.name ?? 'Анонимно'}</dd></div>
          {record.category && <div><dt>Категория</dt><dd>{record.category.name}</dd></div>}{record.process && <div><dt>Процесс</dt><dd>{record.process.name}</dd></div>}</dl>
        <div className="appeal-workflow-actions">
        {primary && <button className="button primary" disabled={saving} onClick={() => openAction(primary)}>{actionNames[primary]}</button>}
        {clarify && <button className="button secondary" disabled={saving} onClick={() => openAction('CLARIFICATION')}>Запросить уточнение</button>}
        {secondary.length > 0 && <details className="appeal-actions-menu">
          <summary>Другие действия</summary>
          <div className="side-actions">
            {secondary.map(item => item === 'CREATE_IMPROVEMENT' ?
              <Link key={item} className="button secondary" to={`/improvements/new?appealId=${record.id}`}>{actionNames[item]}</Link> :
              <button key={item} className="button secondary" disabled={saving} onClick={() => openAction(item)}>{actionNames[item]}</button>)}
          </div>
        </details>}
        </div>
      </div>
      </Section>
      {record.resolutionText && <Section title="Итог рассмотрения" icon={<CheckCircle2 size={18} />} className="resolution-section">
        {record.resolutionType && <Chip value={record.resolutionType} />}{record.resolutionOrigin === 'DEMO_FIXTURE' && <small>Демонстрационный пример решения</small>}
        <p className="preserve">{record.resolutionText}</p>{record.closedAt && <small>{date(record.closedAt, true)}</small>}
        {record.resolutionConfirmedAt && <p>Автор подтвердил результат {date(record.resolutionConfirmedAt, true)}.</p>}
        {can('CONFIRM_RESULT') && <div className="form-actions">
          <button className="button primary" disabled={saving} onClick={() => reviewResult.mutate({ confirm: true })}>Подтвердить результат</button>
          <button className="button secondary" disabled={saving} onClick={() => setReturning(value => !value)}>Вернуть на доработку</button>
        </div>}
        {returning && can('RETURN_RESULT') && <ActionForm pending={reviewResult.isPending} submit="Отправить на доработку"
          onSubmit={data => reviewResult.mutate({ confirm: false, reason: field(data, 'reason') })}>
          <Field label="Что нужно доработать"><textarea name="reason" minLength={5} maxLength={10000} required /></Field>
        </ActionForm>}
        <ErrorBox error={reviewResult.error} retry={() => query.refetch()} />
      </Section>}
      <Section id="appeal-dialogue" title="Обсуждение" icon={<MessageCircle size={18} />} action={awaitingAnswer ?
        <button className="button primary" disabled={saving} onClick={() => openAction('AUTHOR_RESPONSE')}>{actionNames.AUTHOR_RESPONSE}</button> : undefined}>
        {staff && <div className="tab-strip compact-tabs"><button aria-pressed={!notes} onClick={() => setNotes(false)}>Переписка с автором</button><button aria-pressed={notes} onClick={() => setNotes(true)}>Служебные заметки</button></div>}
        {!notes && record.authorId === null && <StaffAnonymousThread appealId={record.id} />}
        {record.comments.filter(item => item.internal === notes).map(item => <article className={`comment ${item.internal ? 'internal' : ''}`} key={item.id}><header><strong>{item.author.name}</strong><small>{date(item.createdAt, true)}</small></header>
          {item.kind !== 'COMMENT' && <small>{label(item.kind)}</small>}<p className="preserve">{item.body}</p></article>)}
        {(notes || record.authorId !== null) && !record.comments.some(item => item.internal === notes) && <Empty title={notes ? 'Служебных заметок пока нет' : 'Сообщений пока нет'} />}
        {can('COMMENT') && <form className="form-stack" onSubmit={event => { event.preventDefault(); setNotice(''); update.mutate({ data: { action: 'COMMENT', text: drafts[channel], internal: notes } }); }}>
          <Field label={notes ? 'Заметка только для обработчиков' : 'Сообщение в общий диалог'}
            hint={notes ? 'Автор обращения не увидит эту заметку.' : awaitingAnswer ? 'Чтобы возобновить обработку обращения, нажмите «Ответить на уточнение».' : staff ? 'Автор обращения увидит это сообщение.' : undefined}>
            <textarea rows={3} minLength={5} maxLength={10000} required value={drafts[channel]} onChange={event => setDrafts(previous => ({ ...previous, [channel]: event.target.value }))} /></Field>
          {!action && <ErrorBox error={update.error} retry={() => query.refetch()} />}
          <button className={`button ${notes ? 'secondary' : 'primary'} self-start`} disabled={saving}><Send size={16} />{notes ? 'Сохранить служебную заметку' : 'Отправить сообщение'}</button>
        </form>}
      </Section>
      {staff && user.role !== 'DIRECTOR' && record.visibility === 'NORMAL_INTERNAL' && <details className="surface appeal-extra">
        <summary>Похожие обращения и источники</summary>
        {can('SHARE_TOPIC') && <button className="button secondary" onClick={() => openAction('SHARE_TOPIC')}>Опубликовать общую тему</button>}
        <RelatedAppeals record={record} reload={() => void query.refetch()} />
        {can('EDIT') && <AppealTriage record={record} />}
        {linkedReviews && <LinkedReviews target="appeal" targetId={record.id} />}
      </details>}
      {(record.improvements.length > 0 || record.problems.length > 0) && <Section title="Связанные записи">
        {record.problems.map(item => <Link key={item.id} className="inline-reference" to={`/problems/${item.id}`}><small>{item.number}</small>{item.title}</Link>)}
        {record.improvements.map(item => <Link key={item.id} className="inline-reference" to={`/improvements/${item.id}`}><small>{item.number}</small>{item.title}</Link>)}
      </Section>}
      {!!record.authorImprovements?.length && <Section title="Работа по вашему обращению">
        {record.authorImprovements.map(item => <div className="task-row" key={item.number}><span>{item.number}</span><Chip value={item.status} /></div>)}
      </Section>}
      {record.publications.length > 0 && <Section title="Опубликованные результаты" icon={<BookOpen size={18} />}>
        {record.publications.map(item => <article key={item.id} className="comment">
          <Link className="inline-reference" to={`/changes/${item.id}`}>{item.title}<ArrowRight size={16} /></Link>
          <p className="preserve">{item.result}</p>
        </article>)}
      </Section>}
      {record.reviews.length > 0 && <Section title="Запросы на отзыв и пересмотр">{record.reviews.map(item => <div className="review-row" key={item.id}><strong>{item.kind === 'WITHDRAWAL' ? 'Отзыв' : 'Пересмотр'}</strong><p>{item.reason}</p><small>{item.approved === true ? 'Одобрен. ' : item.approved === false ? 'Отклонён. ' : ''}{item.decision ?? 'Ожидает рассмотрения'}</small></div>)}</Section>}
    </div></div>
    {action && <Modal title={actionNames[action]} close={() => setAction(null)}>
      <ActionForm pending={saving || (action === 'REROUTE' && !catalog.data)} error={update.error || reroute.error || share.error || deadline.error || catalog.error} reload={() => void refreshAction()} submit={plain ? 'Подтвердить' : 'Сохранить'} onSubmit={data => {
        if (action === 'SET_RESOLUTION_DEADLINE') {
          deadline.mutate(data);
        } else if (action === 'SHARE_TOPIC') {
          share.mutate(data);
        } else if (action === 'REROUTE') {
          reroute.mutate(data);
        } else if (action === 'EDIT') {
          update.mutate({ edit: true, data: { title: field(data, 'title'), description: staff ? undefined : field(data, 'description'),
            categoryId: optional(data, 'categoryId') ?? null, processId: optional(data, 'processId') ?? null, priority: staff ? field(data, 'priority') : undefined } });
        } else update.mutate({ data: { action, text: optional(data, 'text'), resolutionType: action === 'RESOLVE' ? resolution : undefined,
          relatedId: optional(data, 'relatedId'), assigneeId: action === 'ASSIGN' ? optional(data, 'assigneeId') ?? null : undefined,
          approve: action === 'REVIEW_DECISION' ? field(data, 'decision') === 'yes' : undefined } });
      }}>
        {action === 'SET_RESOLUTION_DEADLINE' && <Field label="Срок решения (UTC)" hint="Пустое поле снимает срок.">
          <DatePicker name="dueAt" type="datetime-local" defaultValue={record.resolutionDueAt?.slice(0, 16)} />
        </Field>}
        {action === 'SHARE_TOPIC' && <Field label="Название для подразделения"
          hint="Укажите общую проблему без имён и закрытых подробностей. Пустое поле снимает тему с публикации.">
          <input name="sharedTitle" maxLength={180} defaultValue={record.sharedTitle ?? ''} />
        </Field>}
        {action === 'REROUTE' && catalog.data && <>
          <Field label="Категория"><select name="categoryId" defaultValue={record.categoryId ?? ''}><EntityOptions rows={catalog.data.categories} blank="Не выбрана" /></select></Field>
          <Field label="Процесс"><select name="processId" defaultValue={record.processId ?? ''}><EntityOptions rows={catalog.data.processes} blank="Не выбран" /></select></Field>
        </>}
        {action === 'EDIT' ? <>
          <Field label="Заголовок"><input name="title" defaultValue={record.title} required minLength={3} maxLength={180} /></Field>
          {!staff && <Field label="Описание"><textarea name="description" defaultValue={record.description} required minLength={5} rows={5} /></Field>}
          <Field label="Категория"><select name="categoryId" key={catalog.data?.categories.length ?? 0} defaultValue={record.categoryId ?? ''}><EntityOptions rows={catalog.data?.categories ?? []} blank="Не выбрана" /></select></Field>
          <Field label="Процесс"><select name="processId" key={catalog.data?.processes.length ?? 0} defaultValue={record.processId ?? ''}><EntityOptions rows={catalog.data?.processes ?? []} blank="Не выбран" /></select></Field>
          {staff && <Field label="Приоритет"><select name="priority" defaultValue={record.priority}><Options items={priorities} /></select></Field>}
        </> : <>
          {action === 'RESOLVE' && <Field label="Тип решения"><select value={resolution} onChange={event => { setResolution(event.target.value); setTargetSearch(''); setTargetPage(1); }}><Options items={record.status === 'WAITING_AUTHOR' ? ['INSUFFICIENT_INFO'] : resolutions.filter(item => item !== 'INSUFFICIENT_INFO' && (item !== 'REJECTED' || user.role === 'MANAGER'))} /></select></Field>}
          {action === 'RESOLVE' && ['ACCEPTED_FOR_IMPROVEMENT', 'LINKED_TO_EXISTING_CASE', 'ALREADY_ADDRESSED', 'TRANSFERRED'].includes(resolution) &&
            <>{resolution !== 'ACCEPTED_FOR_IMPROVEMENT' && <>
              <Field label="Поиск цели по номеру или заголовку"><input value={targetSearch} onChange={event => { setTargetSearch(event.target.value); setTargetPage(1); }} /></Field>
              <ErrorBox error={targets.error} />{targets.data?.total === 0 && <small>Доступных целей не найдено. Для передачи нужна активная запись с совместимым доступом и действующим ответственным.</small>}
              {targets.data && <Pagination {...targets.data} onChange={setTargetPage} />}
            </>}
            <Field label="Связанная запись"><select name="relatedId" required><EntityOptions rows={(resolution === 'ACCEPTED_FOR_IMPROVEMENT' ? record.improvements : targets.data?.items ?? []).filter(item => item.id !== record.id).map(item => ({ id: item.id, name: `${item.number} · ${item.title}` }))} /></select></Field></>}
          {action === 'ASSIGN' && <Field label="Ответственный"><select name="assigneeId" key={catalog.data?.people.length ?? 0} defaultValue={record.assigneeId ?? ''}><EntityOptions rows={catalog.data?.people ?? []} blank="Координатор очереди" /></select></Field>}
          {action === 'REVIEW_DECISION' && <Field label="Решение"><select name="decision"><option value="yes">Одобрить запрос</option><option value="no">Отклонить запрос</option></select></Field>}
          {!plain && action !== 'SHARE_TOPIC' && <Field label={action === 'CLARIFICATION' ? 'Вопрос автору' : action === 'AUTHOR_RESPONSE' ? 'Ваш ответ' : 'Обоснование'}>
            <textarea name="text" rows={4} required minLength={5} maxLength={10000} /></Field>}
        </>}
      </ActionForm>
    </Modal>}
  </>;
}
