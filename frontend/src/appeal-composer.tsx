import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { api, uploadAttachment, type Attachment } from './api';
import { appealTypes } from './contracts';
import { BookOpen, CheckCircle2, Paperclip, Send, X } from './icons';
import { useSession } from './session';
import { Chip, ErrorBox, Field, PageHeading, Section } from './ui';

const fields = z.object({
  description: z.string().max(10000), proposedSolution: z.string().max(10000),
});
const schema = fields.extend({
  description: z.string().trim().min(5, 'Опишите ситуацию хотя бы в нескольких словах.').max(10000),
  proposedSolution: fields.shape.proposedSolution.refine(value => !value.trim() || value.trim().length >= 5, 'Введите не менее 5 символов.'),
});
type Draft = z.infer<typeof schema>;
const stored = z.object({
  values: fields.partial(),
  attachments: z.array(z.object({ id: z.uuid(), name: z.string(), bytes: z.number(), mediaType: z.string() })).max(5).default([]),
  attempts: z.array(z.tuple([z.string(), z.uuid()])).max(5).default([]),
});
function restore(key: string) {
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    const envelope = stored.safeParse(raw);
    if (envelope.success) return envelope.data;
    return stored.parse({ values: fields.partial().parse(raw) });
  } catch { return stored.parse({ values: {} }); }
}

type Preview = {
  similar: { id: string; title: string; status: string; joined: boolean }[];
  knowledge: { id: string; title: string; version: number; change: string }[];
};
type Joined = { id: string; title: string; status: string; results: { id: string; title: string; result: string }[] };

export function AppealComposer({ initialType }: { initialType?: typeof appealTypes[number] }) {
  const { user } = useSession();
  const key = 'modus-draft:' + user.id;
  const navigate = useNavigate();
  const client = useQueryClient();
  const [initial] = useState(() => restore(key));
  const [attachments, setAttachments] = useState<Attachment[]>(initial.attachments);
  const [showSolution, setShowSolution] = useState(!!initial.values.proposedSolution);
  const [done, setDone] = useState('');
  const [stable, setStable] = useState('');
  const attempts = useRef(new Map(initial.attempts));
  const complete = useRef(false);
  const form = useForm<Draft>({ resolver: zodResolver(schema), defaultValues: {
    description: '', proposedSolution: '', ...initial.values,
  } });
  const description = useWatch({ control: form.control, name: 'description' });
  useEffect(() => {
    const timer = window.setTimeout(() => setStable(description.trim()), 550);
    return () => window.clearTimeout(timer);
  }, [description]);
  const preview = useQuery({
    queryKey: ['intake-preview', user.id, stable, initialType],
    queryFn: ({ signal }) => api<Preview>('/intake/preview', { method: 'POST', body: { description: stable, type: initialType }, signal }),
    enabled: stable.length >= 5 && stable === description.trim() && !done,
    retry: false, gcTime: 0,
  });
  const suggestions = stable === description.trim() ? preview.data : undefined;
  useEffect(() => {
    const save = () => {
      if (complete.current) return;
      const values = form.getValues();
      try {
        sessionStorage.setItem(key, JSON.stringify({ values, attachments, attempts: [...attempts.current] }));
      } catch { /* storage may be unavailable */ }
    };
    save();
    const subscription = form.watch(save);
    return () => subscription.unsubscribe();
  }, [attachments, form, key]);
  const clear = () => {
    complete.current = true;
    attempts.current.clear();
    try { sessionStorage.removeItem(key); } catch { /* storage may be unavailable */ }
    setAttachments([]);
    form.reset({ description: '', proposedSolution: '' });
    setShowSolution(false);
    complete.current = false;
  };
  const create = useMutation({ mutationFn: async (draft: Draft) => {
    const proposedSolution = draft.proposedSolution.trim() || undefined;
    const body = { description: draft.description, type: initialType, proposedSolution, attachmentIds: attachments.map(item => item.id) };
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    const attemptKey = attempts.current.get(fingerprint) ?? crypto.randomUUID();
    attempts.current.delete(fingerprint);
    attempts.current.set(fingerprint, attemptKey);
    attempts.current = new Map([...attempts.current].slice(-5));
    try { sessionStorage.setItem(key, JSON.stringify({ values: form.getValues(), attachments, attempts: [...attempts.current] })); } catch { /* storage may be unavailable */ }
    return api<{ id: string }>('/appeals', { method: 'POST', body, key: attemptKey });
  }, onSuccess: result => {
    clear();
    void client.invalidateQueries({ queryKey: ['appeals'] });
    navigate('/appeals/' + result.id, { state: { created: true } });
  } });
  const upload = useMutation({ mutationFn: uploadAttachment, onSuccess: result => setAttachments(items => [...items, result]) });
  const join = useMutation({ mutationFn: (id: string) => api('/intake/shared/' + id + '/join', { method: 'POST' }), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['joined-appeals'] });
    navigate('/my/appeals#joined-appeals');
  } });
  const solved = useMutation({ mutationFn: ({ id, version }: { id: string; version: number }) =>
    api('/intake/knowledge/' + id + '/solved', { method: 'POST', body: { expectedVersion: version } }), onSuccess: () => {
    clear();
    setDone('Отмечено, что инструкция помогла.');
  } });
  const busy = create.isPending || upload.isPending || join.isPending || solved.isPending;
  const { errors } = form.formState;
  const fileInput = useRef<HTMLInputElement>(null);
  return <section className="surface intake-panel" aria-label="Новое обращение">
    <form className="form-stack" onSubmit={form.handleSubmit(values => create.mutate(values))}>
      {done && <div className="success-box" role="status"><CheckCircle2 size={18} />{done}</div>}
      <Field label="Опишите проблему или предложите улучшение" error={errors.description?.message}>
        <textarea rows={4} maxLength={10000} placeholder="Что произошло и где это мешает работе?" {...form.register('description', {
          onChange: () => { if (done) setDone(''); },
        })} />
      </Field>
      <div className="form-actions intake-tools">
        <input ref={fileInput} type="file" aria-label="Вложения" hidden accept=".pdf,.png,.jpg,.jpeg,.txt"
          disabled={busy || attachments.length >= 5} onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) upload.mutate(file);
          }} />
        <button className="button subtle" type="button" disabled={busy || attachments.length >= 5}
          onClick={() => fileInput.current?.click()}><Paperclip size={16} /> Прикрепить файл</button>
        <button className="button subtle" type="button" disabled={busy} aria-expanded={showSolution} onClick={() => {
          if (showSolution) form.setValue('proposedSolution', '');
          setShowSolution(value => !value);
        }}>Есть решение</button>
      </div>
      {showSolution && <Field label="Как это можно решить?" error={errors.proposedSolution?.message}>
        <textarea rows={2} maxLength={10000} {...form.register('proposedSolution')} />
      </Field>}
      <ErrorBox error={upload.error} />
      {attachments.map(item => <div className="file-line" key={item.id}><Paperclip size={16} />{item.name}
        <button type="button" disabled={busy} className="icon-button" aria-label={`Убрать ${item.name}`} onClick={() => setAttachments(rows => rows.filter(row => row.id !== item.id))}><X size={16} /></button></div>)}
      {suggestions?.similar.length ? <div className="intake-suggestions"><strong>Похожие обращения</strong>{suggestions.similar.map(item => <div className="intake-match" key={item.id}>
        <span>{item.title} <Chip value={item.status} /></span>
        {item.joined ? <Link to="/my/appeals#joined-appeals">Вы присоединились</Link> : item.status !== 'CLOSED' &&
          <button className="button secondary" disabled={busy} type="button" onClick={() => join.mutate(item.id)}>У меня такая же проблема</button>}
      </div>)}</div> : null}
      {suggestions?.knowledge.map(item => <div className="intake-suggestions" key={item.id}>
        <strong>Возможно, эта инструкция уже решает вашу проблему</strong>
        <details><summary>{item.title}</summary><p className="preserve">{item.change}</p>
          <Link to={'/changes/' + item.id} target="_blank" rel="noreferrer">Открыть публикацию <BookOpen size={15} /></Link>
          <button className="button secondary" disabled={busy} type="button" onClick={() => solved.mutate(item)}>Проблема решена</button>
        </details>
      </div>)}
      <ErrorBox error={create.error || join.error || solved.error} />
      <div className="form-actions"><button type="submit" className="button primary" disabled={busy}>
        <Send size={17} />{create.isPending ? 'Отправляем…' : suggestions?.similar.length ? 'Создать новое обращение' : 'Отправить обращение'}
      </button></div>
    </form>
  </section>;
}

export function NewAppeal() {
  const [params] = useSearchParams();
  const type = z.enum(appealTypes).safeParse(params.get('type'));
  return <><PageHeading title="Новое обращение" back={{ to: '/my/appeals', label: 'Мои обращения' }} />
    <AppealComposer initialType={type.data} /></>;
}

export function JoinedAppeals() {
  const { user } = useSession();
  const joined = useQuery({ queryKey: ['joined-appeals', user.id], queryFn: () => api<Joined[]>('/intake/joined') });
  if (!joined.data?.length) return null;
  return <Section id="joined-appeals" title="Общие проблемы">
    {joined.data.map(item => <article className="comment" key={item.id}>
      <header><strong>{item.title}</strong><Chip value={item.status} /></header>
      {item.results.map(result => <div key={result.id}><Link to={'/changes/' + result.id}>{result.title}</Link><p>{result.result}</p></div>)}
    </article>)}
  </Section>;
}
