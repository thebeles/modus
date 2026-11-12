import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, queryString, type Page, type Reference } from './api';
import { useSession } from './session';
import { ActionForm, Chip, date, Empty, ErrorBox, Field, field, Loading, Modal, PageHeading, Pagination, Section } from './ui';

type Proposal = { id: string; title: string; description: string; author: { name: string }; createdAt: string; voted: boolean;
  _count: { votes: number; comments: number }; improvement: { number: string; status: string } | null };

function ProposalDiscussion({ item, close }: { item: Proposal; close: () => void }) {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const client = useQueryClient();
  const path = '/proposals/' + item.id + '/comments';
  const comments = useQuery({ queryKey: ['proposal-comments', item.id, page],
    queryFn: () => api<Page<{ id: string; body: string; author: { name: string }; createdAt: string }>>(path + queryString({ page })) });
  const send = useMutation({ mutationFn: (form: FormData) => api(path, { method: 'POST', body: { body: field(form, 'body') } }),
    onSuccess: async () => {
      setRevision(value => value + 1);
      if (comments.data) setPage(Math.ceil((comments.data.total + 1) / comments.data.limit));
      await Promise.all([client.invalidateQueries({ queryKey: ['proposal-comments', item.id] }), client.invalidateQueries({ queryKey: ['proposals'] })]);
    } });
  return <Modal title="Обсуждение предложения" description={item.title} close={close}>
    <ErrorBox error={comments.error} retry={() => comments.refetch()} />{comments.isPending && <Loading />}
    {comments.data && <>{comments.data.items.length ? comments.data.items.map(comment => <article className="comment" key={comment.id}>
      <header><strong>{comment.author.name}</strong><small>{date(comment.createdAt, true)}</small></header><p className="preserve">{comment.body}</p>
    </article>) : <Empty title="Комментариев пока нет" />}<Pagination {...comments.data} onChange={setPage} /></>}
    <ActionForm key={revision} pending={send.isPending} error={send.error} submit="Добавить комментарий" onSubmit={form => send.mutate(form)}>
      <Field label="Комментарий"><textarea name="body" required minLength={5} maxLength={10000} rows={3} /></Field>
    </ActionForm>
  </Modal>;
}

export function ProposalsPage() {
  const { user } = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [sort, setSort] = useState('popular');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [discussion, setDiscussion] = useState<Proposal>();
  const [converting, setConverting] = useState<Proposal>();
  const rows = useQuery({ queryKey: ['proposals', sort, page],
    queryFn: ({ signal }) => api<Page<Proposal>>('/proposals' + queryString({ page, sort }), { signal }) });
  const reload = () => client.invalidateQueries({ queryKey: ['proposals'] });
  const create = useMutation({ mutationFn: (form: FormData) => api('/proposals', { method: 'POST',
    body: { title: field(form, 'title'), description: field(form, 'description') } }),
  onSuccess: () => { setCreating(false); return reload(); } });
  const vote = useMutation({ mutationFn: (item: Proposal) => api('/proposals/' + item.id + '/vote', { method: item.voted ? 'DELETE' : 'PUT' }), onSuccess: reload });
  const convert = useMutation({ mutationFn: (form: FormData) => api<{ id: string }>('/proposals/' + converting?.id + '/convert',
    { method: 'POST', body: { goal: field(form, 'goal'), scope: field(form, 'scope') } }),
  onSuccess: async item => { await reload(); navigate('/improvements/' + item.id); } });
  return <><PageHeading title="Предложения сотрудников" subtitle="Идеи и обсуждения вашего подразделения."
    action={<button className="button primary" onClick={() => { create.reset(); setCreating(true); }}>Новое предложение</button>} />
    <Field label="Сортировка"><select value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}>
      <option value="popular">По голосам</option><option value="recent">Сначала новые</option>
    </select></Field>
    <ErrorBox error={rows.error || vote.error} retry={() => rows.refetch()} />{rows.isPending && <Loading />}
    {rows.data && <div className="inner-stack">
      {!rows.data.items.length && <Empty title="Предложений пока нет" />}
      {rows.data.items.map(item => <Section key={item.id} title={item.title}>
        <small>{item.author.name} · {date(item.createdAt)}</small><p className="preserve">{item.description}</p>
        {item.improvement && <div className="button-row"><strong>Инициатива {item.improvement.number}</strong><Chip value={item.improvement.status} /></div>}
        <div className="button-row">
          <button className="button secondary" aria-pressed={item.voted} disabled={vote.isPending} onClick={() => vote.mutate(item)}>
            {item.voted ? 'Убрать голос' : 'Голосовать'} · {item._count.votes}
          </button>
          <button className="button subtle" onClick={() => setDiscussion(item)}>Обсуждение · {item._count.comments}</button>
          {!item.improvement && user.permissions.includes('IMPROVEMENT_OWNER') &&
            <button className="button subtle" onClick={() => { convert.reset(); setConverting(item); }}>Создать инициативу</button>}
        </div>
      </Section>)}
      <Pagination {...rows.data} onChange={setPage} />
    </div>}
    {creating && <Modal title="Новое предложение" close={() => setCreating(false)}>
      <ActionForm pending={create.isPending} error={create.error} submit="Опубликовать" onSubmit={form => create.mutate(form)}>
        <Field label="Название"><input name="title" required minLength={3} maxLength={180} /></Field>
        <Field label="Что предлагаете изменить"><textarea name="description" required minLength={5} maxLength={10000} rows={5} /></Field>
      </ActionForm>
    </Modal>}
    {discussion && <ProposalDiscussion key={discussion.id} item={discussion} close={() => setDiscussion(undefined)} />}
    {converting && <Modal title="Создать черновик инициативы" description={converting.title} close={() => setConverting(undefined)}>
      <ActionForm pending={convert.isPending} error={convert.error} submit="Создать черновик" onSubmit={form => convert.mutate(form)}>
        <Field label="Цель изменения"><textarea name="goal" required minLength={5} maxLength={10000} rows={3} /></Field>
        <Field label="Область изменения"><input name="scope" required maxLength={500} /></Field>
      </ActionForm>
    </Modal>}
  </>;
}

const categoryLabels: Record<string, string> = { DELIVERY: 'Доставка и сроки', QUALITY: 'Качество', SERVICE: 'Обслуживание', PAYMENT: 'Оплата и возвраты', OTHER: 'Прочее' };
type Review = { id: string; title: string; body: string; category: string; occurredAt: string;
  appeals: { appeal: Reference }[]; improvements: { improvement: Reference }[] };
type ReviewPage = Page<Review> & { groups: { category: string; count: number }[] };
type ReviewTarget = { target: 'appeal' | 'improvement'; targetId: string };

function SimilarReviews({ item, close }: { item: Review; close: () => void }) {
  const rows = useQuery({ queryKey: ['similar-reviews', item.id],
    queryFn: () => api<{ id: string; title: string; score: number }[]>('/customer-reviews/' + item.id + '/similar') });
  return <Modal title="Похожие отзывы" description={item.title} close={close}>
    <ErrorBox error={rows.error} retry={() => rows.refetch()} />{rows.isPending && <Loading />}
    {rows.data?.length === 0 && <Empty title="Похожих отзывов нет" />}
    {rows.data?.map(row => <p key={row.id}>{row.title} · {Math.round(row.score * 100)}% сходства</p>)}
  </Modal>;
}

function ReviewLinkForm({ item, fixed, close }: { item: Review; fixed?: ReviewTarget; close: () => void }) {
  const client = useQueryClient();
  const [target, setTarget] = useState<ReviewTarget['target']>(fixed?.target ?? 'appeal');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const candidates = useQuery({ queryKey: ['review-targets', target, search, page],
    queryFn: () => api<Page<Reference>>('/customer-reviews/targets' + queryString({ target, q: search, page })), enabled: !fixed });
  const save = useMutation({ mutationFn: (form: FormData) => api('/customer-reviews/' + item.id + '/links', {
    method: 'POST', body: fixed ?? { target, targetId: field(form, 'targetId') },
  }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['customer-reviews'] }); close(); } });
  return <Modal title="Связать отзыв" description={item.title} close={close}>
    {!fixed && <><Field label="Вид записи"><select value={target} onChange={event => { setTarget(event.target.value as ReviewTarget['target']); setPage(1); }}>
      <option value="appeal">Внутреннее обращение</option><option value="improvement">Инициатива</option>
    </select></Field>
      <Field label="Поиск по названию или номеру"><input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></Field>
      <ErrorBox error={candidates.error} retry={() => candidates.refetch()} />
      {candidates.data && <Pagination {...candidates.data} onChange={setPage} />}</>}
    <ActionForm pending={save.isPending || (!fixed && !candidates.data?.items.length)} error={save.error} submit="Связать" onSubmit={form => save.mutate(form)}>
      {!fixed && <Field label="Запись"><select name="targetId" required key={target + search + page}><option value="">Выберите запись</option>
        {candidates.data?.items.map(row => <option key={row.id} value={row.id}>{row.number} · {row.title}</option>)}</select></Field>}
    </ActionForm>
  </Modal>;
}

export function ReviewsPage() {
  const { user } = useSession();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const fixed = params.get('appealId') ? { target: 'appeal' as const, targetId: params.get('appealId')! }
    : params.get('improvementId') ? { target: 'improvement' as const, targetId: params.get('improvementId')! } : undefined;
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Review>();
  const [similar, setSimilar] = useState<Review>();
  const [receipt, setReceipt] = useState('');
  const canWrite = user.permissions.includes('PROBLEM_OWNER');
  const rows = useQuery({ queryKey: ['customer-reviews', category, page],
    queryFn: ({ signal }) => api<ReviewPage>('/customer-reviews' + queryString({ category, page }), { signal }) });
  const reload = () => client.invalidateQueries({ queryKey: ['customer-reviews'] });
  const upload = useMutation({ mutationFn: async (form: FormData) => {
    const file = form.get('csv');
    if (!(file instanceof File) || !file.size || file.size > 64000) throw new Error('Выберите CSV размером до 64 КБ.');
    let csv: string;
    try { csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error('Сохраните CSV в кодировке UTF-8.'); }
    return api<{ inserted: number; duplicates: number }>('/customer-reviews/import', { method: 'POST', body: { csv } });
  }, onSuccess: result => { setReceipt(`Добавлено: ${result.inserted}. Пропущено дублей: ${result.duplicates}.`); setImporting(false); setPage(1); return reload(); } });
  const unlink = useMutation({ mutationFn: ({ item, target }: { item: string; target: ReviewTarget }) =>
    api('/customer-reviews/' + item + '/links', { method: 'DELETE', body: target }), onSuccess: reload });
  return <><PageHeading title="Клиентские отзывы" subtitle="Категории жалоб, повторяющиеся темы и связанные записи."
    action={canWrite && <button className="button primary" onClick={() => { upload.reset(); setImporting(true); }}>Импортировать CSV</button>} />
    {fixed && <p><Link to={`/${fixed.target === 'appeal' ? 'appeals' : 'improvements'}/${fixed.targetId}`}>Вернуться к связанной записи</Link></p>}
    {receipt && <p className="success-box" role="status">{receipt}</p>}
    <Field label="Категория"><select value={category} onChange={event => { setCategory(event.target.value); setPage(1); }}>
      <option value="">Все категории</option>{Object.entries(categoryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></Field>
    <ErrorBox error={rows.error || unlink.error} retry={() => rows.refetch()} />{rows.isPending && <Loading />}
    {rows.data && <div className="inner-stack">
      {rows.data.groups.length > 0 && <Section title="Отзывы по категориям">
        <div className="button-row">{rows.data.groups.map(group => <button key={group.category} className="button subtle"
          aria-pressed={group.category === category} onClick={() => { setCategory(group.category); setPage(1); }}>{categoryLabels[group.category]} · {group.count}</button>)}</div>
      </Section>}
      {!rows.data.items.length && <Empty title="В этой категории пока нет отзывов" />}
      {rows.data.items.map(item => <Section key={item.id} title={item.title}>
        <small>{categoryLabels[item.category]} · {date(item.occurredAt)}</small><p className="preserve">{item.body}</p>
        {([...item.appeals.map(({ appeal }) => ({ ...appeal, target: 'appeal' as const })),
          ...item.improvements.map(({ improvement }) => ({ ...improvement, target: 'improvement' as const }))]).map(row =>
          <div className="file-line" key={row.id}><Link to={`/${row.target === 'appeal' ? 'appeals' : 'improvements'}/${row.id}`}>{row.number} · {row.title}</Link>
            {canWrite && <button className="button subtle" disabled={unlink.isPending}
              onClick={() => unlink.mutate({ item: item.id, target: { target: row.target, targetId: row.id } })}>Удалить связь</button>}
          </div>)}
        <div className="button-row"><button className="button secondary" onClick={() => setSimilar(item)}>Похожие отзывы</button>
          {canWrite && <button className="button subtle" onClick={() => setSelected(item)}>Связать с записью</button>}</div>
      </Section>)}
      <Pagination {...rows.data} onChange={setPage} />
    </div>}
    {importing && <Modal title="Импорт отзывов" close={() => setImporting(false)}
      description="CSV в UTF-8 с колонками date, title, body и датой ГГГГ-ММ-ДД. Перед импортом удалите личные данные клиентов.">
      <ActionForm pending={upload.isPending} error={upload.error} submit="Импортировать" onSubmit={form => upload.mutate(form)}>
        <Field label="Файл CSV"><input name="csv" type="file" accept=".csv,text/csv" required /></Field>
      </ActionForm>
    </Modal>}
    {similar && <SimilarReviews item={similar} close={() => setSimilar(undefined)} />}
    {selected && <ReviewLinkForm item={selected} fixed={fixed} close={() => setSelected(undefined)} />}
  </>;
}

export function LinkedReviews({ target, targetId }: ReviewTarget) {
  const { user } = useSession();
  const [page, setPage] = useState(1);
  const key = target + 'Id';
  const rows = useQuery({ queryKey: ['customer-reviews', target, targetId, page],
    queryFn: ({ signal }) => api<ReviewPage>('/customer-reviews' + queryString({ [key]: targetId, page, limit: 5 }), { signal }) });
  return <Section title="Клиентские отзывы" action={user.permissions.includes('PROBLEM_OWNER') &&
    <Link to={'/customer-reviews' + queryString({ [key]: targetId })}>Связать отзыв</Link>}>
    <ErrorBox error={rows.error} retry={() => rows.refetch()} />{rows.isPending && <Loading />}
    {rows.data && <>{rows.data.items.length ? rows.data.items.map(item =>
      <details key={item.id}><summary>{item.title}</summary><p className="preserve">{item.body}</p></details>) : <small>Связанных отзывов пока нет</small>}
    <Pagination {...rows.data} onChange={setPage} /></>}
  </Section>;
}
