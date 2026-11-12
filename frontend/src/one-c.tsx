import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, queryString, type Page } from './api';
import { ActionForm, date, Empty, ErrorBox, Field, field, Loading, Modal, PageHeading, Pagination, Section } from './ui';

type Mode = 'http' | 'simulator';
type Product = { sku: string; name: string; stock: number };
type RequestRow = { id: string; sku: string; quantity: number; status: string; externalId: string | null; improvementId: string | null; createdAt: string };
type LogRow = { id: string; action: string; result: string; requestId: string | null; createdAt: string };
const states: Record<string, string> = {
  PENDING: 'Ожидает отправки', SUBMITTED: 'Передана', PROCESSING: 'В работе', COMPLETED: 'Выполнена', REJECTED: 'Отклонена',
  STARTED: 'Начата', OK: 'Успешно', ERROR: 'Ошибка', PRODUCTS: 'Товары и остатки', SUBMIT: 'Отправка заявки', STATUS: 'Проверка статуса',
};

export function useOneCCapabilities(enabled = true) {
  return useQuery({ queryKey: ['one-c-capabilities'], queryFn: () => api<{ mode: Mode | null }>('/one-c/capabilities'), enabled });
}

function Requests({ improvementId, compact = false }: { improvementId?: string; compact?: boolean }) {
  const [page, setPage] = useState(1);
  const client = useQueryClient();
  const rows = useQuery({ queryKey: ['one-c-requests', improvementId, page, compact],
    queryFn: () => api<Page<RequestRow>>(compact
      ? '/one-c/improvements/' + improvementId + '/requests' + queryString({ page, limit: 5 })
      : '/one-c/requests' + queryString({ page, improvementId })) });
  const refresh = useMutation({ mutationFn: (id: string) => api('/one-c/requests/' + id + '/refresh', { method: 'POST' }),
    onSettled: () => Promise.all(['one-c-requests', 'one-c-products', 'one-c-journal'].map(key => client.invalidateQueries({ queryKey: [key] }))) });
  return <><ErrorBox error={rows.error || refresh.error} retry={() => rows.refetch()} />{rows.isPending && <Loading />}
    {rows.data && <>{!rows.data.items.length && <Empty title="Заявок пока нет" />}
      {rows.data.items.map(row => <article className="comment" key={row.id}>
        <header><strong>{row.sku} · {row.quantity} шт.</strong><small>{date(row.createdAt, true)}</small></header>
        <p>{states[row.status]}{row.externalId && <> · {row.externalId}</>}</p>
        <div className="button-row">
          {row.improvementId && !compact && <Link to={'/improvements/' + row.improvementId}>Инициатива</Link>}
          {!compact && !['COMPLETED', 'REJECTED'].includes(row.status) && <button type="button" className="button subtle" disabled={refresh.isPending}
            onClick={() => refresh.mutate(row.id)}>{row.status === 'PENDING' ? 'Повторить отправку' : 'Обновить статус'}</button>}
        </div>
      </article>)}
      <Pagination {...rows.data} onChange={setPage} />
    </>}
  </>;
}

function Journal() {
  const [page, setPage] = useState(1);
  const rows = useQuery({ queryKey: ['one-c-journal', page], queryFn: () => api<Page<LogRow>>('/one-c/journal' + queryString({ page })) });
  return <><ErrorBox error={rows.error} retry={() => rows.refetch()} />{rows.isPending && <Loading />}
    {rows.data && <>{!rows.data.items.length && <Empty title="Журнал пока пуст" />}
      {rows.data.items.map(row => <div className="file-line" key={row.id}><strong>{states[row.action]}</strong>
        <span>{states[row.result]}</span><small>{date(row.createdAt, true)}</small></div>)}
      <Pagination {...rows.data} onChange={setPage} />
    </>}
  </>;
}

function CreateRequest({ products, improvementId, close }: { products: Product[]; improvementId?: string; close: () => void }) {
  const client = useQueryClient();
  const [attempt, setAttempt] = useState<{ key: string; sku: string; quantity: number }>();
  const create = useMutation({ mutationFn: ({ key, sku, quantity }: NonNullable<typeof attempt>) =>
    api('/one-c/requests', { method: 'POST', key, body: { sku, quantity, improvementId } }),
  onSuccess: close,
  onSettled: () => Promise.all(['one-c-requests', 'one-c-products', 'one-c-journal'].map(key => client.invalidateQueries({ queryKey: [key] }))) });
  return <Modal title="Новая заявка 1С" close={close}>
    {attempt ? <div className="inner-stack"><p>{attempt.sku} · {attempt.quantity} шт.</p><ErrorBox error={create.error} />
      {create.isPending ? <Loading /> : <button className="button primary" onClick={() => create.mutate(attempt)}>Повторить отправку</button>}
    </div> : <ActionForm pending={create.isPending} error={create.error} submit="Отправить заявку" onSubmit={form => {
      const value = { key: crypto.randomUUID(), sku: field(form, 'sku'), quantity: Number(field(form, 'quantity')) };
      setAttempt(value); create.mutate(value);
    }}>
      <Field label="Товар"><select name="sku" required><option value="">Выберите товар</option>
        {products.map(item => <option key={item.sku} value={item.sku}>{item.name} · {item.stock} шт.</option>)}</select></Field>
      <Field label="Количество"><input name="quantity" type="number" min={1} max={1000000} step={1} required /></Field>
    </ActionForm>}
  </Modal>;
}

export function OneCPage() {
  const [params] = useSearchParams();
  const improvementId = params.get('improvementId') ?? undefined;
  const [tab, setTab] = useState<'products' | 'requests' | 'journal'>(improvementId ? 'requests' : 'products');
  const [creating, setCreating] = useState(false);
  const capability = useOneCCapabilities();
  const products = useQuery({ queryKey: ['one-c-products'], queryFn: () => api<{ items: Product[] }>('/one-c/products'),
    enabled: !!capability.data?.mode && (tab === 'products' || creating) });
  return <><PageHeading title="Интеграция с 1С" subtitle={capability.data?.mode === 'simulator' ? 'Демонстрационный симулятор 1С' : undefined}
    back={improvementId ? { to: '/improvements/' + improvementId, label: 'Инициатива' } : undefined}
    action={capability.data?.mode && <button className="button primary" onClick={() => setCreating(true)}>Новая заявка</button>} />
    <ErrorBox error={capability.error} retry={() => capability.refetch()} />{capability.isPending && <Loading />}
    {capability.data && (capability.data.mode ? <>
      <div className="tab-strip compact-tabs">
        <button type="button" aria-pressed={tab === 'products'} onClick={() => setTab('products')}>Товары и остатки</button>
        <button type="button" aria-pressed={tab === 'requests'} onClick={() => setTab('requests')}>Заявки</button>
        <button type="button" aria-pressed={tab === 'journal'} onClick={() => setTab('journal')}>Журнал операций</button>
      </div>
      {tab === 'products' && <Section title="Остатки" action={<button className="button secondary" disabled={products.isFetching}
        onClick={() => products.refetch()}>Обновить</button>}>
        <ErrorBox error={products.error} retry={() => products.refetch()} />{products.isPending && <Loading />}
        {products.data?.items.map(item => <div className="file-line" key={item.sku}><strong>{item.name}</strong><small>{item.sku}</small><span>{item.stock} шт.</span></div>)}
        {products.data?.items.length === 0 && <Empty title="Товары отсутствуют" />}
      </Section>}
      {tab === 'requests' && <Section title="Мои заявки"><Requests key={improvementId} improvementId={improvementId} /></Section>}
      {tab === 'journal' && <Section title="Операции"><Journal /></Section>}
      {creating && (products.data ? <CreateRequest products={products.data.items} improvementId={improvementId}
        close={() => { setCreating(false); setTab('requests'); }} />
        : <Modal title="Новая заявка 1С" close={() => setCreating(false)}>
          <ErrorBox error={products.error} retry={() => products.refetch()} />{products.isPending && <Loading />}
        </Modal>)}
    </> : <Empty title="Интеграция 1С недоступна" />)}
  </>;
}

export function ImprovementOneC({ improvementId }: { improvementId: string }) {
  const capability = useOneCCapabilities();
  return <Section title="Заявки 1С" action={capability.data?.mode && <Link to={'/one-c' + queryString({ improvementId })}>Открыть заявки</Link>}>
    <Requests improvementId={improvementId} compact />
  </Section>;
}
