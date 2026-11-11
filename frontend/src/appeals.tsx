import { DatePicker } from './date-picker';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, ChevronRight, Clock3, FileText, GitPullRequest, Heart,
  Inbox, Layers3, Lightbulb, LockKeyhole, MessageCircle, Paperclip, Plus, Search, Send, ShieldCheck, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { appealStatuses, appealTypes, label, priorities, resolutions, visibilities } from '@kontur/api/contracts';
import { api, uploadAttachment, type Appeal, type AppealRow, type Attachment, type Catalog, type Change, type LinkRow, type Page, queryString, type Reference } from './api';
import { useSession } from './session';
import { ActionForm, Chip, date, Empty, EntityOptions, ErrorBox, Field, field, Loading, Modal, optional, Options, PageHeading, Pagination, Section, Synthetic, TableRegion, Timeline } from './ui';

const kinds = [
  { code: 'PROBLEM', name: 'Сообщить о проблеме', description: 'Расскажите, что мешает работе.', icon: TriangleAlert, tone: 'peach' },
  { code: 'PROPOSAL', name: 'Предложить улучшение', description: 'Поделитесь идеей, как сделать лучше.', icon: Lightbulb, tone: 'mint' },
  { code: 'POSITIVE_FEEDBACK', name: 'Поблагодарить', description: 'Отметьте то, что хорошо работает.', icon: Heart, tone: 'lavender' },
] as const;

function AppealTable({ rows, staff = false, compact = false }: { rows: AppealRow[]; staff?: boolean; compact?: boolean }) {
  return <TableRegion label={compact ? 'Мои последние обращения' : staff ? 'Очередь обращений' : 'Мои обращения'}><table className={`data-table appeal-table ${compact ? 'compact' : ''}`}><thead><tr>
    <th>Обращение</th><th>Статус</th>{!compact && <th>{staff ? 'Подразделение' : 'Тип'}</th>}<th>{staff ? 'Срок' : 'Дата'}</th><th><span className="sr-only">Открыть</span></th>
  </tr></thead><tbody>{rows.map(item => {
    const to = `${staff ? '/work-queue' : ''}/appeals/${item.id}`;
    return <tr key={item.id}><td><Link className="table-title" to={to}><span className="row-icon"><FileText size={17} /></span><span>
      <small>{item.number}{item.isSynthetic && <span className="tiny-demo"> · демо</span>}{item.visibility !== 'NORMAL_INTERNAL' && <LockKeyhole size={12} />}</small><strong>{item.title}</strong>
    </span></Link></td><td><Chip value={item.status} /></td>{!compact && <td>{staff ? item.department?.name ?? '—' : label(item.type)}</td>}
      <td className="date-cell">{staff ? item.controlDueAt ? date(item.controlDueAt, true) : 'Срок не задан' : date(item.createdAt)}</td>
      <td><Link className="icon-button row-arrow" to={to} aria-label={`Открыть ${item.number}`}>{compact ? <ArrowRight size={18} /> : <ChevronRight size={17} />}</Link></td></tr>;
  })}</tbody></table></TableRegion>;
}

export function Home() {
  const { user } = useSession();
  const latest = useQuery({ queryKey: ['appeals', 'home'], queryFn: () => api<Page<AppealRow>>('/appeals?own=true&limit=4') });
  const waiting = useQuery({ queryKey: ['appeals', 'waiting'], queryFn: () => api<Page<AppealRow>>('/appeals?own=true&status=WAITING_AUTHOR&limit=3') });
  const changes = useQuery({ queryKey: ['changes', 'home'], queryFn: () => api<Page<Change>>('/publications?limit=2') });
  return <div className="home-page">
    <section className="home-hero">
      <div className="hero-content"><p className="hero-greeting">Здравствуйте, {user.name.split(' ')[0]}!</p>
        <h1>Сделаем работу удобнее</h1><p className="hero-copy">Расскажите, что мешает, предложите идею или поблагодарите коллег. Здесь можно проследить, что стало с вашим обращением.</p>
        <Link className="button primary hero-button" to="/appeals/new"><Plus size={19} /> Создать обращение <ArrowRight size={17} /></Link>
      </div></section>
    <section className="home-start"><h2>С чего начнём?</h2>
      <div className="kind-grid">{kinds.map(({ code, name, description, icon: Icon, tone }) => <Link key={code} className="kind-card" to={`/appeals/new?type=${code}`}>
        <span className={`kind-icon ${tone}`}><Icon size={27} strokeWidth={1.75} aria-hidden="true" /></span>
        <div><strong>{name}</strong><p>{description}</p></div><ArrowRight size={21} className="kind-arrow" aria-hidden="true" /></Link>)}</div>
    </section>
    <ErrorBox error={waiting.error} retry={() => waiting.refetch()} />
    {waiting.data?.items.length ? <Section title="Требует вашего ответа" icon={<MessageCircle size={18} />} className="attention-section">
      {waiting.data.items.map(item => <Link key={item.id} className="inline-reference" to={`/appeals/${item.id}`}><small>{item.number}</small>{item.title}<ArrowRight size={16} /></Link>)}
    </Section> : null}
    <div className="home-columns">
      <Section title="Мои последние обращения" icon={<Inbox size={25} />} className="recent-section"
        action={<Link className="text-button" to="/my/appeals">Все обращения <ArrowRight size={15} /></Link>}>
        {latest.isPending && <Loading />}<ErrorBox error={latest.error} retry={() => latest.refetch()} />
        {latest.data && (latest.data.items.length ? <AppealTable rows={latest.data.items} compact /> : <Empty title="Обращений пока нет"><Link to="/appeals/new">Создать первое обращение</Link></Empty>)}
      </Section>
      <Section title="Что улучшилось" icon={<BookOpen size={25} />} className="home-library">
        {changes.isPending && <Loading />}<ErrorBox error={changes.error} retry={() => changes.refetch()} />
        {changes.data && (changes.data.items.length ? changes.data.items.map(item => <article className="mini-change" key={item.id}>
          <div className="publication-cover"><Layers3 size={22} /><span>БИБЛИОТЕКА ИЗМЕНЕНИЙ</span></div>
          <div><Synthetic show={item.isSynthetic} /><Link to={`/changes/${item.id}`}><h3>{item.title}</h3></Link><p>{item.change}</p>
            <Link className="text-button" to={`/changes/${item.id}`}>Читать результат <ArrowRight size={14} /></Link></div></article>) : <Empty title="Публикаций пока нет" />)}
      </Section>
    </div>
  </div>;
}

export function AppealList({ staff = false }: { staff?: boolean }) {
  const [params, setParams] = useSearchParams();
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>('/catalog') });
  const assignees = useQuery({ queryKey: ['appeal-assignees'], enabled: staff,
    queryFn: () => api<{ id: string; name: string }[]>('/work-queue/assignees') });
  const tab = params.get('tab') ?? 'all';
  const page = Number(params.get('page')) || 1;
  const filter = Object.fromEntries(['q', 'status', 'type', 'priority', 'categoryId', 'departmentId', 'processId', 'sort', 'from', 'to', 'normalOnly', 'assigneeId', 'dueFrom', 'dueTo', 'metric'].map(key => [key, params.get(key) ?? undefined]));
  const endpoint = (staff ? '/work-queue' : '/appeals') + queryString({ ...filter, tab: staff ? tab : undefined, own: staff ? undefined : 'true', page, limit: 15 });
  const rows = useQuery({ queryKey: ['appeals', endpoint], queryFn: ({ signal }) => api<Page<AppealRow>>(endpoint, { signal }), placeholderData: keepPreviousData });
  const apply = (key: string, value: string) => {
    const updated = new URLSearchParams(params);
    if (key !== 'page') updated.delete('page');
    if (value) updated.set(key, value); else updated.delete(key);
    setParams(updated, { replace: true });
  };
  const tabs = [['all', 'Все доступные'], ['mine', 'Моё действие'], ['new', 'Новые / без назначения'], ['waiting', 'Ждут автора'], ['risk', 'Под риском'], ['overdue', 'Просроченные'], ['stale', 'Без активности']];
  return <><PageHeading title={staff ? 'Очередь обращений' : 'Мои обращения'} subtitle={staff ? 'Рассмотрение обращений, сроки и следующие действия.' : 'Следите за рассмотрением, отвечайте на вопросы и смотрите решения.'}
    action={<Link className="button primary" to="/appeals/new"><Plus size={18} />Создать обращение</Link>} />
    {staff && <nav className="tab-strip" aria-label="Представления очереди">{tabs.map(([key, text]) => <button type="button" aria-pressed={tab === key} key={key} onClick={() => apply('tab', key)}>{text}</button>)}</nav>}
    <div className="surface filter-bar">
      <label className="search-field"><Search size={18} /><span className="sr-only">Поиск по обращениям</span><input placeholder="Поиск по номеру или тексту" value={filter.q ?? ''} onChange={event => apply('q', event.target.value)} maxLength={150} /></label>
      <select aria-label="Статус" value={filter.status ?? ''} onChange={event => apply('status', event.target.value)}><Options items={appealStatuses} blank="Все статусы" /></select>
      <select aria-label="Тип" value={filter.type ?? ''} onChange={event => apply('type', event.target.value)}><Options items={appealTypes} blank="Все типы" /></select>
      <select aria-label="Категория" value={filter.categoryId ?? ''} onChange={event => apply('categoryId', event.target.value)}><EntityOptions rows={catalog.data?.categories ?? []} blank="Все категории" /></select>
      {staff && <><select aria-label="Подразделение" value={filter.departmentId ?? ''} onChange={event => apply('departmentId', event.target.value)}><EntityOptions rows={catalog.data?.departments ?? []} blank="Все подразделения" /></select>
        <select aria-label="Процесс" value={filter.processId ?? ''} onChange={event => apply('processId', event.target.value)}><EntityOptions rows={catalog.data?.processes ?? []} blank="Все процессы" /></select>
        <select aria-label="Приоритет" value={filter.priority ?? ''} onChange={event => apply('priority', event.target.value)}><Options items={priorities} blank="Все приоритеты" /></select></>}
      {staff && <>
        <select aria-label="Исполнитель" value={filter.assigneeId ?? ''} onChange={event => apply('assigneeId', event.target.value)}>
          <EntityOptions rows={assignees.data ?? []} blank="Все исполнители" />
        </select>
        <Field label="Срок с (UTC)"><DatePicker type="datetime-local" value={filter.dueFrom?.slice(0, 16) ?? ''}
          onValueChange={value => apply('dueFrom', value && new Date(value + 'Z').toISOString())} /></Field>
        <Field label="Срок до (UTC)"><DatePicker type="datetime-local" value={filter.dueTo?.slice(0, 16) ?? ''}
          onValueChange={value => apply('dueTo', value && new Date(value + 'Z').toISOString())} /></Field>
      </>}
      <select aria-label="Сортировка" value={filter.sort ?? 'recent'} onChange={event => apply('sort', event.target.value)}><option value="recent">Сначала новые</option><option value="oldest">Сначала ранние</option>{staff && <option value="due">По сроку</option>}</select>
    </div>
    <ErrorBox error={rows.error || catalog.error || assignees.error} retry={() => { void rows.refetch(); void catalog.refetch(); if (staff) void assignees.refetch(); }} />{rows.isPending && <Loading />}
    {rows.data && <div className="surface">
      <div className="list-meta" aria-live="polite">{rows.isFetching ? 'Обновляем…' : `Найдено: ${rows.data.total}`}</div>
      {rows.data.items.length ? <AppealTable rows={rows.data.items} staff={staff} /> :
        <Empty title="Обращения не найдены"><button className="button subtle" onClick={() => setParams({})}>Сбросить фильтры</button></Empty>}
      <Pagination {...rows.data} onChange={next => apply('page', String(next))} />
    </div>}
  </>;
}

const draftFields = z.object({
  type: z.enum(appealTypes), description: z.string().max(10000), title: z.string().max(180),
  categoryId: z.string(), processId: z.string(), proposedSolution: z.string().max(10000),
  visibility: z.enum(visibilities),
});
const draftSchema = draftFields.extend({
  description: z.string().trim().min(5, 'Опишите ситуацию хотя бы в нескольких словах.').max(10000),
  title: z.string().trim().max(180).refine(value => !value || value.length >= 3, 'Введите не менее 3 символов.'),
  proposedSolution: draftFields.shape.proposedSolution.refine(value => !value.trim() || value.trim().length >= 5, 'Опишите решение хотя бы в нескольких словах.'),
});
type Draft = z.infer<typeof draftSchema>;
const storedDraft = z.object({
  values: draftFields.partial(),
  step: z.union([z.literal(1), z.literal(2)]).default(1),
  attachments: z.array(z.object({ id: z.uuid(), name: z.string(), bytes: z.number(), mediaType: z.string() })).max(5).default([]),
  attempts: z.array(z.tuple([z.string(), z.uuid()])).max(5).default([]),
});
type StoredDraft = z.output<typeof storedDraft>;
function restoreDraft(key: string): StoredDraft {
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    const envelope = storedDraft.safeParse(raw);
    if (envelope.success) return envelope.data;
    return storedDraft.parse({ values: draftFields.partial().parse(raw) });
  } catch { return storedDraft.parse({ values: {} }); }
}

function persistDraft(key: string, draft: StoredDraft, catalog?: Catalog) {
  const category = draft.values.categoryId;
  try {
    if (draft.values.visibility !== 'NORMAL_INTERNAL' || catalog?.categories.some(row => row.id === category && row.sensitive)) {
      sessionStorage.removeItem(key);
    } else if (!category || catalog?.categories.some(row => row.id === category)) {
      sessionStorage.setItem(key, JSON.stringify(draft));
    }
  } catch { /* storage may be unavailable */ }
}

export function NewAppeal() {
  const { user } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const key = `kontur-draft:${user.id}`;
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>('/catalog') });
  const ai = useQuery({ queryKey: ['ai'], queryFn: () => api<{ available: boolean }>('/ai/capabilities') });
  const selected = z.enum(appealTypes).safeParse(params.get('type'));
  const [initialDraft] = useState(() => restoreDraft(key));
  const [step, setStep] = useState(initialDraft.step);
  const [attachments, setAttachments] = useState<Attachment[]>(initialDraft.attachments);
  const [showConsent, setShowConsent] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const form = useForm<Draft>({ resolver: zodResolver(draftSchema), defaultValues: {
    type: 'PROBLEM', description: '', title: '', categoryId: '', processId: '', proposedSolution: '', visibility: 'NORMAL_INTERNAL',
    ...initialDraft.values, ...(selected.success ? { type: selected.data } : {}),
  } });
  const { errors } = form.formState;
  const type = form.watch('type');
  const visibility = form.watch('visibility');
  const categoryId = form.watch('categoryId');
  const category = catalog.data?.categories.find(item => item.id === categoryId);
  const isConfidential = visibility !== 'NORMAL_INTERNAL' || (!!categoryId && (!category || category.sensitive));
  const submitted = useRef(new Map(initialDraft.attempts));
  const completed = useRef(false);

  useEffect(() => {
    const save = () => {
      if (!completed.current) persistDraft(key, { values: form.getValues(), step, attachments, attempts: [...submitted.current] }, catalog.data);
    };
    save();
    const subscription = form.watch(save);
    return () => subscription.unsubscribe();
  }, [form, key, catalog.data, step, attachments]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!completed.current && (form.getValues('description') || attachments.length)) { event.preventDefault(); }
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [form, attachments.length]);

  const create = useMutation({ mutationFn: async (draft: Draft) => {
    const { title, categoryId, processId, proposedSolution, ...required } = draft;
    const body = { ...required, title: title || undefined, categoryId: categoryId || undefined, processId: processId || undefined,
      proposedSolution: proposedSolution.trim() || undefined, attachmentIds: attachments.map(item => item.id) };
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    const attemptKey = submitted.current.get(fingerprint) ?? crypto.randomUUID();
    submitted.current.delete(fingerprint);
    submitted.current.set(fingerprint, attemptKey);
    const attempts = [...submitted.current].slice(-5);
    submitted.current = new Map(attempts);
    persistDraft(key, { values: form.getValues(), step, attachments, attempts }, catalog.data);
    return api<{ id: string }>('/appeals', { method: 'POST', body, key: attemptKey });
  }, onSuccess: result => {
    completed.current = true;
    try { sessionStorage.removeItem(key); } catch { /* storage may be unavailable */ }
    void client.invalidateQueries({ queryKey: ['appeals'] });
    navigate(`/appeals/${result.id}`, { state: { created: true } });
  } });
  const upload = useMutation({ mutationFn: uploadAttachment, onSuccess: result => setAttachments(items => [...items, result]) });
  const assist = useMutation({ mutationFn: () => api<{ usageId: string; suggestion: { title: string; type: Draft['type']; categoryId: string | null; rephrasedDescription: string; followUpQuestions: string[] }; truncated?: boolean }>('/ai/appeal-assist', {
    method: 'POST', body: { consent: true, text: form.getValues('description'), visibility, categoryId: categoryId || undefined },
  }) });
  const acceptSuggestion = useMutation({ mutationFn: async (selection: FormData | null) => {
    if (!assist.data) return;
    const { usageId, suggestion } = assist.data;
    await api(`/ai/usage/${usageId}/decision`, { method: 'POST', body: { decision: selection ? 'APPLIED' : 'DISMISSED' } });
    if (selection?.has('title')) form.setValue('title', suggestion.title, { shouldValidate: true });
    if (selection?.has('description')) form.setValue('description', suggestion.rephrasedDescription, { shouldValidate: true });
    if (selection?.has('type')) form.setValue('type', suggestion.type, { shouldValidate: true });
    if (selection?.has('category') && suggestion.categoryId) form.setValue('categoryId', suggestion.categoryId, { shouldValidate: true });
  }, onSuccess: () => setShowConsent(false) });
  const suggestedCategory = catalog.data?.categories.find(row => row.id === assist.data?.suggestion.categoryId && !row.sensitive);
  return <><PageHeading title="Новое обращение" subtitle="Опишите ситуацию. Мы направим её ответственному сотруднику." back={{ to: '/my/appeals', label: 'Мои обращения' }} />
    <div className="compose-grid"><div className="surface compose-panel">
      <ol className="stepper"><li className={step === 1 ? 'active' : 'done'}><span>{step > 1 ? <CheckCircle2 size={16} /> : 1}</span> Суть обращения</li>
        <li className={step === 2 ? 'active' : ''}><span>2</span> Детали и отправка</li></ol>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); if (step === 1) void form.trigger(['type', 'description']).then(ok => { if (ok) setStep(2); });
        else void form.handleSubmit(() => setShowPreview(true))(); }}>
        {step === 1 ? <><fieldset className="type-select"><legend>Тип обращения</legend>{kinds.map(({ code, icon: Icon, tone }) =>
          <label key={code} className={type === code ? 'selected' : ''}><input type="radio" value={code} {...form.register('type')} /><span className={`kind-icon ${tone}`}><Icon size={18} /></span>{label(code)}</label>)}</fieldset>
          <Field label="Что вы хотите сообщить?" hint="Укажите, где и когда это происходит, если это важно." error={errors.description?.message}><textarea rows={7} placeholder="Опишите ситуацию своими словами…" {...form.register('description')} /></Field>
          <div className="form-actions"><button type="submit" className="button primary">Продолжить <ArrowRight size={17} /></button></div>
        </> : <>
          <Field label="Заголовок" hint="Можно оставить пустым. Система возьмёт первые слова из описания." error={errors.title?.message}><input {...form.register('title')} placeholder="Коротко о главном" /></Field>
          {ai.data?.available && !isConfidential ? <button className="button subtle self-start" type="button" onClick={() => { assist.reset(); acceptSuggestion.reset(); setShowConsent(true); }}><Sparkles size={16} /> Подсказать заголовок</button>
            : <small className="subtle-text">{isConfidential ? 'Для конфиденциальных обращений доступны ручные правки.' : 'Заполните детали вручную.'}</small>}
          <div className="two-fields">
            <Field label="Категория"><select {...form.register('categoryId')}><EntityOptions rows={catalog.data?.categories ?? []} blank="Не выбрана" /></select></Field>
            <Field label="Рабочий процесс"><select {...form.register('processId')}><EntityOptions rows={catalog.data?.processes ?? []} blank="Не выбран" /></select></Field>
          </div>
          <Field label="Ваш вариант решения" error={errors.proposedSolution?.message}><textarea rows={3} {...form.register('proposedSolution')} placeholder="Если есть, опишите здесь" /></Field>
          <Field label="Доступ" hint={category?.sensitive ? 'Эта категория будет направлена в специальную очередь.' : 'Ваше имя сохраняется в системе.'}>
            <select {...form.register('visibility')}><Options items={visibilities} /></select></Field>
          <Field label="Вложения" hint="До 5 файлов по 5 МБ. PDF, PNG, JPEG или TXT.">
            <input type="file" aria-label="Вложения" accept=".pdf,.png,.jpg,.jpeg,.txt" disabled={upload.isPending || attachments.length >= 5} onChange={event => {
              const selected = event.currentTarget.files?.[0]; if (selected) upload.mutate(selected); event.currentTarget.value = '';
            }} />
          </Field>
          {upload.isPending && <span role="status">Загружаем файл…</span>}<ErrorBox error={upload.error || catalog.error} />
          {attachments.map(item => <div className="file-line" key={item.id}><Paperclip size={16} />{item.name}
            <button type="button" className="icon-button" aria-label={`Убрать ${item.name}`} onClick={() => setAttachments(rows => rows.filter(row => row.id !== item.id))}><X size={16} /></button></div>)}
          <div className="form-actions split"><button className="button secondary" type="button" onClick={() => setStep(1)}><ArrowLeft size={16} /> Назад</button>
            <button className="button primary" disabled={upload.isPending} type="submit">Проверить и отправить <ArrowRight size={17} /></button></div>
        </>}
      </form>
    </div><aside className="surface compose-aside"><span className="kind-icon mint"><ShieldCheck size={22} /></span>
      <h2>Кто увидит обращение</h2><p>Вы и сотрудники, отвечающие за рассмотрение в рамках выданных полномочий.</p>
      <p>Для чувствительных тем можно выбрать ограниченный доступ. Если категория не выбрана, обращение получит координатор резервной очереди.</p></aside></div>
    {showConsent && <Modal title="Подсказка Groq" close={() => { if (!acceptSuggestion.isPending) setShowConsent(false); }}
      description="С вашего согласия описание и список обычных категорий будут переданы внешнему сервису. Проверьте, что в тексте нет конфиденциальных сведений.">
      <ErrorBox error={assist.error} />
      {assist.data ? <ActionForm pending={acceptSuggestion.isPending} error={acceptSuggestion.error} submit="Применить выбранное"
        onSubmit={selection => { if (Array.from(selection.keys()).length) acceptSuggestion.mutate(selection); }}>
        {assist.data.truncated && <small>Часть входных данных была сокращена.</small>}
        <label className="checkbox-line"><input type="checkbox" name="title" defaultChecked /> Заголовок «{assist.data.suggestion.title}»</label>
        <label className="checkbox-line"><input type="checkbox" name="type" /> Тип «{label(assist.data.suggestion.type)}»</label>
        {suggestedCategory && <label className="checkbox-line"><input type="checkbox" name="category" /> Категория «{suggestedCategory.name}»</label>}
        <div><h3>Текущее описание</h3><p className="preserve">{form.getValues('description')}</p></div>
        <label className="checkbox-line"><input type="checkbox" name="description" /> Использовать предложенное описание</label>
        <p className="preserve">{assist.data.suggestion.rephrasedDescription}</p>
        {assist.data.suggestion.followUpQuestions.map((question, index) => <small key={index}>{question}</small>)}
        <button className="button subtle self-start" type="button" disabled={acceptSuggestion.isPending}
          onClick={() => acceptSuggestion.mutate(null)}>Оставить свой текст</button>
      </ActionForm> :
        <button className="button primary" disabled={assist.isPending} onClick={() => assist.mutate()}>{assist.isPending ? 'Получаем подсказку…' : 'Отправить описание в Groq'}</button>}
    </Modal>}
    {showPreview && <Modal title="Проверка обращения" close={() => { if (!create.isPending) setShowPreview(false); }}><div className="form-stack">
      <div className="inline-chips"><Chip value={form.getValues('type')} /><Chip value={category?.sensitive ? 'SPECIAL' : visibility} /></div>
      <h3>{form.getValues('title') || 'Заголовок будет сформирован из описания'}</h3><p className="preserve">{form.getValues('description')}</p>
      {attachments.length > 0 && <small>Вложений: {attachments.length}</small>}
      <ErrorBox error={create.error} /><button className="button primary" disabled={create.isPending} onClick={() => void form.handleSubmit(values => create.mutate(values))()}>
        <Send size={17} />{create.isPending ? 'Отправляем…' : 'Отправить обращение'}</button>
    </div></Modal>}
  </>;
}

const actionNames: Record<string, string> = {
  REVIEW: 'Взять на рассмотрение', IN_PROGRESS: 'В работу', RESUME: 'Возобновить рассмотрение', CLARIFICATION: 'Запросить уточнение',
  AUTHOR_RESPONSE: 'Ответить на уточнение', RESOLVE: 'Закрыть с решением', WITHDRAW: 'Отозвать обращение',
  REVIEW_REQUEST: 'Запросить пересмотр', REVIEW_DECISION: 'Рассмотреть запрос', ASSIGN: 'Назначить ответственного', REROUTE: 'Перенаправить', EDIT: 'Редактировать',
  CREATE_PROBLEM: 'Создать проблему', CREATE_IMPROVEMENT: 'Создать улучшение',
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

function RelatedAppeals({ record, reload }: { record: Appeal; reload: () => void }) {
  const { user } = useSession();
  const [show, setShow] = useState(false);
  const [candidate, setCandidate] = useState<Reference | null>(null);
  const similar = useQuery({ queryKey: ['similar', record.id], queryFn: () => api<(Reference & { explanation: string })[]>(`/object-links/similar/${record.id}`), enabled: show });
  const ai = useQuery({ queryKey: ['ai'], queryFn: () => api<{ available: boolean }>('/ai/capabilities') });
  const suggestion = useMutation({ mutationFn: (feature: string) => api<{ mode: 'GROQ' | 'RULE'; suggestion?: Record<string, unknown>; candidates?: (Reference & { explanation: string })[] }>(`/ai/${feature}`, { method: 'POST', body: { id: record.id, consent: true } }) });
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
      </div> :
        <button className="button primary" disabled={suggestion.isPending} onClick={() => suggestion.mutate(aiFeature)}>{suggestion.isPending ? 'Получаем подсказку…' : 'Запросить подсказку'}</button>}
    </Modal>}
  </Section>;
}

export function AppealDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useSession();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['appeal', id], queryFn: () => api<Appeal>(`/appeals/${id}`) });
  const [action, setAction] = useState<string | null>(null);
  const [actionVersion, setActionVersion] = useState<number>();
  const [notes, setNotes] = useState(false);
  const [comment, setComment] = useState('');
  const [resolution, setResolution] = useState('RESOLVED');
  const [notice, setNotice] = useState('');
  const record = query.data;
  const staff = !!record && record.authorId !== user.id;
  const catalog = useQuery({ queryKey: ['catalog', id], queryFn: () => api<Catalog>(`/catalog?appealId=${id}`), enabled: !!action && ['EDIT', 'ASSIGN', 'REROUTE'].includes(action) });
  const targets = useQuery({ queryKey: ['appeals', 'resolution-targets'], queryFn: () => api<Page<AppealRow>>('/work-queue?limit=100'),
    enabled: action === 'RESOLVE' && ['LINKED_TO_EXISTING_CASE', 'ALREADY_ADDRESSED', 'TRANSFERRED'].includes(resolution) });
  const update = useMutation({ mutationFn: ({ data, edit }: { data: Record<string, unknown>; edit?: boolean }) => api<Appeal>(
    `/appeals/${id}${edit ? '' : '/transition'}`, { method: edit ? 'PATCH' : 'POST', body: { expectedVersion: action ? actionVersion : record?.version, ...data } }),
  onSuccess: item => { client.setQueryData(['appeal', id], item); void client.invalidateQueries({ queryKey: ['appeals'] }); setAction(null); setComment(''); setNotice('Изменения сохранены.'); } });
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
  if (!record) return <><PageHeading title="Обращение" />{query.isPending ? <Loading /> : <ErrorBox error={query.error} retry={() => query.refetch()} />}</>;
  const { timing } = record;
  const can = (key: string) => record.allowedActions.includes(key);
  const openAction = (operation: string) => {
    update.reset();
    reroute.reset();
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
  };
  const next = record.status === 'WAITING_AUTHOR' ? 'Ответ автора' : ['CLOSED', 'WITHDRAWN'].includes(record.status) ? 'Рассмотрение завершено' :
    record.status === 'NEW' ? 'Первичное рассмотрение' : 'Рассмотрение и решение';
  const plain = ['REVIEW', 'IN_PROGRESS'].includes(action ?? '') && record.status !== 'IN_PROGRESS';
  return <><PageHeading title={record.title} subtitle={`${record.number} · ${label(record.type)} · ${date(record.createdAt)}`}
    back={{ to: staff ? '/work-queue' : '/my/appeals', label: staff ? 'Очередь' : 'Мои обращения' }}
    action={<Chip value={record.status} />} />
    {notice && <div className="success-box" role="status"><CheckCircle2 size={18} />{notice}</div>}
    <div className="detail-grid"><div className="detail-main">
      <Section title="Об обращении" icon={<FileText size={18} />} action={can('EDIT') ? <button className="text-button" onClick={() => openAction('EDIT')}>Редактировать</button> : undefined}>
        <div className="inline-chips"><Synthetic show={record.isSynthetic} /><Chip value={record.priority} dot={false} />{record.visibility !== 'NORMAL_INTERNAL' && <Chip value={record.visibility} />}</div>
        <p className="preserve detail-text">{record.description}</p>
        {record.proposedSolution && <><h3>Предложенное решение</h3><p className="preserve">{record.proposedSolution}</p></>}
        {record.attachments.map(file => <a className="file-line" key={file.id} href={`/api/v1/attachments/${file.id}/download`}><Paperclip size={16} />{file.name}<small>{Math.max(1, Math.ceil(file.bytes / 1024))} КБ</small></a>)}
      </Section>
      {record.resolutionText && <Section title="Итог рассмотрения" icon={<CheckCircle2 size={18} />} className="resolution-section">
        {record.resolutionType && <Chip value={record.resolutionType} />}<p className="preserve">{record.resolutionText}</p><small>{date(record.closedAt, true)}</small>
      </Section>}
      <Section title="Диалог" icon={<MessageCircle size={18} />}>
        {staff && <div className="tab-strip compact-tabs"><button aria-pressed={!notes} onClick={() => setNotes(false)}>Переписка с автором</button><button aria-pressed={notes} onClick={() => setNotes(true)}>Служебные заметки</button></div>}
        {record.comments.filter(item => item.internal === notes).map(item => <article className={`comment ${item.internal ? 'internal' : ''}`} key={item.id}><header><strong>{item.author.name}</strong><small>{date(item.createdAt, true)}</small></header>
          {item.kind !== 'COMMENT' && <small>{label(item.kind)}</small>}<p className="preserve">{item.body}</p></article>)}
        {!record.comments.some(item => item.internal === notes) && <Empty title={notes ? 'Служебных заметок пока нет' : 'Сообщений пока нет'} />}
        {can('COMMENT') && <form className="form-stack" onSubmit={event => { event.preventDefault(); setNotice(''); update.mutate({ data: { action: 'COMMENT', text: comment, internal: notes } }); }}>
          <Field label={notes ? 'Заметка только для обработчиков' : 'Сообщение в общий диалог'}>
            <textarea rows={3} minLength={5} maxLength={10000} required value={comment} onChange={event => setComment(event.target.value)} /></Field>
          {!action && <ErrorBox error={update.error} retry={() => query.refetch()} />}
          <button className={`button ${notes ? 'secondary' : 'primary'} self-start`} disabled={update.isPending}><Send size={16} />{notes ? 'Сохранить служебную заметку' : 'Отправить сообщение'}</button>
        </form>}
      </Section>
      {staff && record.visibility === 'NORMAL_INTERNAL' && <RelatedAppeals record={record} reload={() => void query.refetch()} />}
      {timing && <Section title="Время рассмотрения" icon={<Clock3 size={18} />}>
        <dl className="facts"><div><dt>Активное время</dt><dd>{Math.floor(timing.activeSeconds / 60)} мин</dd></div>
          <div><dt>Ожидание автора</dt><dd>{Math.floor(timing.waitingSeconds / 60)} мин</dd></div></dl>
        {timing.periods.length > 0 && <details><summary>Последние периоды</summary><ul>
          {timing.periods.map(period => <li key={period.startedAt}>{period.phase === 'ACTIVE' ? 'Рассмотрение' : 'Ожидание автора'} · {date(period.startedAt, true)} — {period.endedAt ? date(period.endedAt, true) : 'сейчас'}</li>)}
        </ul></details>}
      </Section>}
      <Section title="История" icon={<Clock3 size={18} />}><Timeline items={record.events} /></Section>
    </div><aside className="detail-side">
      <Section title="Следующий шаг" icon={<ArrowRight size={18} />}>
        <dl className="facts"><div><dt>Действие</dt><dd>{next}</dd></div><div><dt>Ответственный</dt><dd>{record.status === 'WAITING_AUTHOR' ? 'Автор обращения' : record.assignee?.name ?? record.queue?.name ?? 'Служба обработки'}</dd></div>
          <div><dt>Срок</dt><dd>{record.controlDueAt ? date(record.controlDueAt, true) : 'Срок не задан'}</dd></div>
          {record.category && <div><dt>Категория</dt><dd>{record.category.name}</dd></div>}{record.process && <div><dt>Процесс</dt><dd>{record.process.name}</dd></div>}</dl>
        {record.allowedActions.some(item => actionNames[item] && item !== 'EDIT') && <div className="side-actions">
          {record.allowedActions.filter(item => actionNames[item] && item !== 'EDIT').map(item => item === 'CREATE_PROBLEM' || item === 'CREATE_IMPROVEMENT' ?
            <Link key={item} className="button secondary" to={`/${item === 'CREATE_PROBLEM' ? 'problems' : 'improvements'}/new?appealId=${record.id}`}>{actionNames[item]}</Link> :
            <button key={item} className={`button ${['REVIEW', 'AUTHOR_RESPONSE'].includes(item) ? 'primary' : 'secondary'}`} onClick={() => openAction(item)}>{actionNames[item]}</button>)}
        </div>}
      </Section>
      {(record.improvements.length > 0 || record.problems.length > 0) && <Section title="Связанные записи">
        {record.problems.map(item => <Link key={item.id} className="inline-reference" to={`/problems/${item.id}`}><small>{item.number}</small>{item.title}</Link>)}
        {record.improvements.map(item => <Link key={item.id} className="inline-reference" to={`/improvements/${item.id}`}><small>{item.number}</small>{item.title}</Link>)}
      </Section>}
      {record.publications.length > 0 && <Section title="Опубликованные результаты" icon={<BookOpen size={18} />}>
        {record.publications.map(item => <article key={item.id} className="comment">
          <Link className="inline-reference" to={`/changes/${item.id}`}>{item.title}<ArrowRight size={16} /></Link>
          <p className="preserve">{item.result}</p>
        </article>)}
      </Section>}
      {record.reviews.length > 0 && <Section title="Запросы на отзыв и пересмотр">{record.reviews.map(item => <div className="review-row" key={item.id}><strong>{item.kind === 'WITHDRAWAL' ? 'Отзыв' : 'Пересмотр'}</strong><p>{item.reason}</p><small>{item.approved === true ? 'Одобрен. ' : item.approved === false ? 'Отклонён. ' : ''}{item.decision ?? 'Ожидает рассмотрения'}</small></div>)}</Section>}
    </aside></div>
    {action && <Modal title={actionNames[action]} close={() => setAction(null)}>
      <ActionForm pending={update.isPending || reroute.isPending || (action === 'REROUTE' && !catalog.data)} error={update.error || reroute.error || catalog.error} reload={() => void refreshAction()} submit={plain ? 'Подтвердить' : 'Сохранить'} onSubmit={data => {
        if (action === 'REROUTE') {
          reroute.mutate(data);
        } else if (action === 'EDIT') {
          update.mutate({ edit: true, data: { title: field(data, 'title'), description: staff ? undefined : field(data, 'description'),
            categoryId: optional(data, 'categoryId') ?? null, processId: optional(data, 'processId') ?? null, priority: staff ? field(data, 'priority') : undefined } });
        } else update.mutate({ data: { action, text: optional(data, 'text'), resolutionType: action === 'RESOLVE' ? resolution : undefined,
          relatedId: optional(data, 'relatedId'), assigneeId: action === 'ASSIGN' ? optional(data, 'assigneeId') ?? null : undefined,
          approve: action === 'REVIEW_DECISION' ? field(data, 'decision') === 'yes' : undefined } });
      }}>
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
          {action === 'RESOLVE' && <Field label="Тип решения"><select value={resolution} onChange={event => setResolution(event.target.value)}><Options items={record.status === 'WAITING_AUTHOR' ? ['INSUFFICIENT_INFO'] : resolutions.filter(item => item !== 'INSUFFICIENT_INFO' && (item !== 'REJECTED' || user.role === 'MANAGER'))} /></select></Field>}
          {action === 'RESOLVE' && ['ACCEPTED_FOR_IMPROVEMENT', 'LINKED_TO_EXISTING_CASE', 'ALREADY_ADDRESSED', 'TRANSFERRED'].includes(resolution) &&
            <Field label="Связанная запись"><select name="relatedId" required><EntityOptions rows={(resolution === 'ACCEPTED_FOR_IMPROVEMENT' ? record.improvements : targets.data?.items ?? []).filter(item => item.id !== record.id).map(item => ({ id: item.id, name: `${item.number} · ${item.title}` }))} /></select></Field>}
          {action === 'ASSIGN' && <Field label="Ответственный"><select name="assigneeId" key={catalog.data?.people.length ?? 0} defaultValue={record.assigneeId ?? ''}><EntityOptions rows={catalog.data?.people ?? []} blank="Координатор очереди" /></select></Field>}
          {action === 'REVIEW_DECISION' && <Field label="Решение"><select name="decision"><option value="yes">Одобрить запрос</option><option value="no">Отклонить запрос</option></select></Field>}
          {!plain && <Field label={action === 'CLARIFICATION' ? 'Вопрос автору' : action === 'AUTHOR_RESPONSE' ? 'Ваш ответ' : 'Обоснование'}>
            <textarea name="text" rows={4} required minLength={5} maxLength={10000} /></Field>}
        </>}
      </ActionForm>
    </Modal>}
  </>;
}
