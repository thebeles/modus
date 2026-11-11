import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, ArrowLeft, ArrowRight, Check, CircleDashed, FileText, Inbox, X } from 'lucide-react';
import { cloneElement, useId, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { label } from '@kontur/api/contracts';
import { ApiError, type Entity, type EventRow } from './api';

const tones: Record<string, string> = {
  NEW: 'blue', REVIEW: 'violet', WAITING_AUTHOR: 'amber', IN_PROGRESS: 'blue', CLOSED: 'green', WITHDRAWN: 'muted',
  HIGH: 'red', MEDIUM: 'amber', LOW: 'muted', PUBLISHED: 'green', APPROVED: 'green', IMPLEMENTED: 'blue',
  VERIFYING: 'violet', COMPLETED: 'green', REJECTED: 'red', DEFERRED: 'amber', VERIFIED: 'green', DONE: 'green',
  INCONCLUSIVE: 'amber', NOT_ACHIEVED: 'red', PARTIAL: 'amber', SUGGESTED: 'amber', CONFIRMED: 'green', BLOCKED: 'red',
};

export const date = (value?: string | null, time = false) => value ? new Intl.DateTimeFormat('ru-RU', {
  timeZone: import.meta.env.VITE_APP_TIMEZONE || 'Asia/Almaty', day: 'numeric', month: 'short', ...(time ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }),
}).format(new Date(value)) : '—';

export function Chip({ value, dot = true }: { value: string; dot?: boolean }) {
  return <span className={`chip tone-${tones[value] ?? 'muted'}`}>{dot && <span className="chip-dot" />}{label(value)}</span>;
}

export function Synthetic({ show }: { show: boolean }) {
  return show ? <span className="chip tone-muted">Синтетические данные</span> : null;
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Не удалось загрузить данные.';
  return <div className="error-box" role="alert"><AlertCircle size={19} /><div>{message}
    {error instanceof ApiError && error.details?.length ? <ul>{error.details.map((field, index) => <li key={index}>{field.message}</li>)}</ul> : null}</div>
    {retry && <button className="button subtle" type="button" onClick={retry}>{error instanceof ApiError && error.code === 'VERSION_CONFLICT' ? 'Обновить карточку' : 'Повторить'}</button>}
  </div>;
}

export function Loading() {
  return <div className="loading" role="status" aria-label="Загрузка"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>;
}

export function Empty({ title = 'Пока ничего нет', children }: { title?: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Inbox size={24} /></span><strong>{title}</strong>{children && <div>{children}</div>}</div>;
}

export function PageHeading({ title, subtitle, action, back }: { title: string; subtitle?: string; action?: ReactNode; back?: { to: string; label: string } }) {
  return <header className="page-heading">
    {back && <Link className="back-link" to={back.to}><ArrowLeft size={16} /> {back.label}</Link>}
    <div className="heading-line"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action}</div>
  </header>;
}

export function Section({ title, icon, action, children, className = '' }: { title: string; icon?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`surface section ${className}`}><header className="section-head"><h2>{icon}{title}</h2>{action}</header>{children}</section>;
}

export function TableRegion({ label, children }: { label: string; children: ReactNode }) {
  return <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }> }) {
  const id = useId();
  const description = [hint && id + '-hint', error && id + '-error'].filter(Boolean).join(' ') || undefined;
  return <div className="field"><label htmlFor={id}>{label}</label>
    {cloneElement(children, { id, 'aria-describedby': description, 'aria-invalid': !!error })}
    {hint && <small id={id + '-hint'}>{hint}</small>}{error && <small id={id + '-error'} className="field-error" role="alert">{error}</small>}</div>;
}

export function EntityOptions({ rows, blank = 'Выберите значение' }: { rows: Entity[]; blank?: string }) {
  return <><option value="">{blank}</option>{rows.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</>;
}

export function Options({ items, blank }: { items: readonly string[]; blank?: string }) {
  return <>{blank && <option value="">{blank}</option>}{items.map(item => <option key={item} value={item}>{label(item)}</option>)}</>;
}

export function Pagination({ total, limit, page, onChange }: { total: number; limit: number; page: number; onChange: (page: number) => void }) {
  return total > limit ? <div className="pagination"><span>Страница {page} из {Math.ceil(total / limit)}</span>
    <button type="button" className="button subtle" aria-label="Предыдущая страница" disabled={page <= 1} onClick={() => onChange(page - 1)}><ArrowLeft size={16} /></button>
    <button type="button" className="button subtle" aria-label="Следующая страница" disabled={page * limit >= total} onClick={() => onChange(page + 1)}><ArrowRight size={16} /></button></div> : null;
}

export function Modal({ title, description, close, children, className }: { title: string; description?: string; close: () => void; children: ReactNode; className?: string }) {
  return <Dialog.Root open onOpenChange={open => { if (!open) close(); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className={className ? `dialog-content ${className}` : 'dialog-content'} aria-describedby={description ? undefined : 'dialog-description'}>
      <div className="dialog-header"><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><button className="icon-button" aria-label="Закрыть"><X size={19} /></button></Dialog.Close></div>
      <Dialog.Description id="dialog-description" className={description ? 'subtle-text' : 'sr-only'}>{description ?? title}</Dialog.Description>{children}
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function Timeline({ items }: { items: EventRow[] }) {
  return items.length ? <ol className="timeline">{items.map(event => <li key={event.id} id={`event-${event.id}`}><span className="timeline-dot"><Check size={12} /></span>
    <div><strong>{label(event.action)}</strong><small>{date(event.createdAt, true)}</small>{event.details?.reason && <p>{event.details.reason}</p>}</div>
  </li>)}</ol> : <Empty title="История пока пуста" />;
}

export function ActionForm({ pending, error, children, onSubmit, submit = 'Сохранить', reload }: { pending: boolean; error?: unknown;
  children?: ReactNode; onSubmit: (data: FormData) => void; submit?: string; reload?: () => void }) {
  const handle = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onSubmit(new FormData(event.currentTarget)); };
  return <form className="form-stack" onSubmit={handle}>{children}<ErrorBox error={error}
    retry={error instanceof ApiError && error.code === 'VERSION_CONFLICT' ? reload : undefined} />
    <div className="form-actions"><button className="button primary" disabled={pending} type="submit">{pending ? <CircleDashed className="spin" size={16} /> : null}{pending ? 'Сохраняем…' : submit}</button></div>
  </form>;
}

export const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
export const optional = (data: FormData, key: string) => field(data, key) || undefined;
export const numeric = (data: FormData, key: string) => optional(data, key) === undefined ? undefined : Number(data.get(key));
export const timestamp = (data: FormData, key: string) => optional(data, key) ? new Date(field(data, key).includes('T') ? field(data, key) + 'Z' : field(data, key)).toISOString() : undefined;
export const referenceIcon = <FileText size={18} />;
