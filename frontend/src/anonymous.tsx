import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, queryString } from './api';
import { ActionForm, Chip, date, Empty, ErrorBox, Field, field, Loading, Options } from './ui';

type Thread = { number: string; title: string; status: string; resolutionType: string | null; nextCursor?: string;
  messages: { id: string; side: 'STAFF' | 'AUTHOR'; kind?: 'RESOLUTION' | 'REMINDER'; text: string; hasAttachment: boolean; createdAt: string }[] };

async function payload(form: FormData) {
  const file = form.get('attachment');
  if (!(file instanceof File) || !file.size) return { text: field(form, 'text') };
  if (!file.name.toLowerCase().endsWith('.txt') || file.size > 65536) throw new Error('Выберите файл .txt размером до 64 КиБ.');
  let attachment: string;
  try { attachment = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('Сохраните вложение в кодировке UTF-8.'); }
  return { text: field(form, 'text'), attachment };
}

function MessageFields() {
  return <><Field label="Сообщение"><textarea name="text" required minLength={5} maxLength={10000} rows={4} /></Field>
    <Field label="Вложение" hint="Файл .txt в UTF-8 до 64 КиБ. Уберите имена, контакты и другие личные данные из текста и файла."><input name="attachment" type="file" accept=".txt,text/plain" /></Field></>;
}

function saveText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Messages({ thread, older, download }: { thread: Thread; older: (cursor: string) => void;
  download: (id: string) => Promise<{ attachment: string }> }) {
  const attachment = useMutation({ mutationFn: download, onSuccess: value => saveText(value.attachment, 'attachment.txt') });
  return <><ErrorBox error={attachment.error} />{thread.nextCursor && <button type="button" className="button subtle" onClick={() => older(thread.nextCursor!)}>Предыдущие сообщения</button>}
    {thread.messages.map(item => <article className="comment" key={item.id}>
      <header><strong>{item.side === 'AUTHOR' ? 'Анонимный автор' : 'Служба обработки'}</strong><small>{date(item.createdAt, true)}</small></header>
      {item.kind === 'RESOLUTION' && <strong>Итог рассмотрения</strong>}
      <p className="preserve">{item.text}</p>
      {item.hasAttachment && <button type="button" className="button subtle" disabled={attachment.isPending}
        onClick={() => attachment.mutate(item.id)}>Скачать текстовое вложение</button>}
    </article>)}</>;
}

export function StaffAnonymousThread({ appealId }: { appealId: string }) {
  const [cursor, setCursor] = useState<string>();
  const thread = useQuery({ queryKey: ['anonymous-thread', appealId, cursor],
    queryFn: ({ signal }) => api<Thread>(`/appeals/${appealId}/anonymous-thread` + queryString({ cursor }), { signal }), refetchInterval: 15000 });
  return <><ErrorBox error={thread.error} retry={() => thread.refetch()} />{thread.isPending && <Loading />}
    {cursor && <button type="button" className="button subtle" onClick={() => setCursor(undefined)}>Последние сообщения</button>}
    {thread.data && <Messages thread={thread.data} older={setCursor}
      download={id => api(`/appeals/${appealId}/anonymous-thread/attachments/${id}`)} />}</>;
}

export function AnonymousPage() {
  const [token, setToken] = useState('');
  const [activeToken, setActiveToken] = useState('');
  const [issued, setIssued] = useState<{ token: string; number: string }>();
  const [mode, setMode] = useState<'create' | 'track'>('create');
  const [replyRevision, setReplyRevision] = useState(0);
  const track = useMutation({ mutationFn: ({ secret, cursor }: { secret: string; cursor?: string }) => api<Thread>('/anonymous/track', {
    method: 'POST', anonymous: true, appealToken: secret, body: { cursor },
  }), onSuccess: (_result, { secret }) => setActiveToken(secret) });
  const create = useMutation({ mutationFn: async (form: FormData) => api<{ number: string; token: string }>('/anonymous/appeals', {
    method: 'POST', anonymous: true, body: { ...await payload(form), title: field(form, 'title'), type: field(form, 'type') },
  }), onSuccess: value => { setIssued(value); setToken(value.token); } });
  const reply = useMutation({ mutationFn: async (form: FormData) => api('/anonymous/reply', {
    method: 'POST', anonymous: true, appealToken: activeToken, body: await payload(form),
  }), onSuccess: () => { setReplyRevision(value => value + 1); track.mutate({ secret: activeToken }); } });
  const toggle = (value: typeof mode) => { track.reset(); reply.reset(); setActiveToken(''); setMode(value); };
  return <main className="login-main"><div className="login-card anonymous-card">
    <a href="/login">Рабочее пространство</a>
    <h1>Анонимное обращение</h1>
    <div className="tab-strip compact-tabs">
      <button type="button" aria-pressed={mode === 'create'} onClick={() => toggle('create')}>Отправить</button>
      <button type="button" aria-pressed={mode === 'track'} onClick={() => toggle('track')}>Проверить статус</button>
    </div>
    {mode === 'create' && (issued ? <div className="inner-stack">
      <p role="status">Обращение {issued.number} зарегистрировано. Сохраните токен, чтобы читать ответы. Восстановить его нельзя.</p>
      <Field label="Токен доступа"><input value={issued.token} readOnly autoComplete="off" /></Field>
      <button className="button secondary" onClick={() => saveText(issued.token, 'appeal-token.txt')}>Сохранить токен в файл</button>
      <button className="button primary" onClick={() => { setMode('track'); track.mutate({ secret: issued.token }); }}>Открыть обращение</button>
      <button className="button subtle" onClick={() => { setIssued(undefined); setToken(''); create.reset(); }}>Новое обращение</button>
    </div> : <ActionForm pending={create.isPending} error={create.error} submit="Отправить обращение" onSubmit={form => create.mutate(form)}>
      <Field label="Тип"><select name="type"><Options items={['PROBLEM', 'PROPOSAL', 'POSITIVE_FEEDBACK']} /></select></Field>
      <Field label="Заголовок" hint="Укажите тему без имён и контактов."><input name="title" required minLength={3} maxLength={180} autoComplete="off" /></Field>
      <MessageFields />
    </ActionForm>)}
    {mode === 'track' && <>
      <ActionForm pending={track.isPending || reply.isPending} error={track.error} submit="Проверить статус" onSubmit={() => {
        setActiveToken(''); reply.reset(); track.mutate({ secret: token.trim() });
      }}>
        <Field label="Токен доступа"><input type="password" autoComplete="off" required minLength={43} maxLength={43} value={token} onChange={event => setToken(event.target.value)} /></Field>
      </ActionForm>
      {track.data && <div className="inner-stack">
        <div className="button-row"><strong>{track.data.number} · {track.data.title}</strong><Chip value={track.data.status} />
          {track.data.resolutionType && <Chip value={track.data.resolutionType} />}</div>
        <Messages thread={track.data} older={cursor => track.mutate({ secret: activeToken, cursor })}
          download={id => api('/anonymous/attachments/' + id, { method: 'POST', body: {}, anonymous: true, appealToken: activeToken })} />
        {activeToken && !['CLOSED', 'WITHDRAWN'].includes(track.data.status) &&
          <ActionForm key={replyRevision} pending={reply.isPending || track.isPending} error={reply.error} submit="Ответить" onSubmit={form => reply.mutate(form)}><MessageFields /></ActionForm>}
      </div>}
      {!track.data && !track.isPending && !track.error && <Empty title="Введите токен, выданный при регистрации" />}
    </>}
  </div></main>;
}
