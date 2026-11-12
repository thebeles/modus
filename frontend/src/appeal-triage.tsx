import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Appeal, type Catalog } from './api';
import { label } from './contracts';
import { useSession } from './session';
import { ActionForm, AiDecision, ErrorBox, Field, field, Loading, Modal, Section } from './ui';

type Group = { title: string; evidence: string; candidateIds: string[]; relation: string };
type Advice = { usageId: string; truncated: boolean; suggestion: {
  categoryId: string | null; classificationReason: string; hypotheses: string[]; possibleActions: string[]; proposedMetrics: string[]; groups: Group[];
} };

function ConfirmGroup({ group, record, close }: { group: Group; record: Appeal; close: () => void }) {
  const client = useQueryClient();
  const create = useMutation({ mutationFn: (data: FormData) => api<{ id: string }>('/problems', {
    method: 'POST', body: { title: field(data, 'title'), symptoms: field(data, 'symptoms'), appealId: record.id,
      relatedAppealIds: data.getAll('appealIds') },
  }), onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ['appeal', record.id] }), client.invalidateQueries({ queryKey: ['problems'] })]) });
  return <Modal title="Проверить группу обращений" close={close} description="Проверьте источники и отредактируйте формулировку перед созданием карточки проблемы.">
    {create.data ? <Link className="button primary" to={'/problems/' + create.data.id}>Открыть карточку проблемы</Link> :
      <ActionForm pending={create.isPending} error={create.error} submit="Создать карточку проблемы" onSubmit={data => create.mutate(data)}>
        <Field label="Название"><input name="title" defaultValue={group.title.slice(0, 180)} required minLength={3} maxLength={180} /></Field>
        <Field label="Наблюдаемые симптомы"><textarea name="symptoms" defaultValue={group.evidence} required minLength={5} maxLength={10000} rows={4} /></Field>
        <fieldset><legend>Источники группы</legend><p>{record.number} · {record.title}</p>
          {group.candidateIds.map((id, index) => <div className="checkbox-line" key={id}>
            <input name="appealIds" value={id} type="checkbox" defaultChecked aria-label={`Включить обращение ${index + 1}`} />
            <Link to={'/appeals/' + id} target="_blank" rel="noreferrer">Открыть обращение {index + 1}</Link>
          </div>)}
        </fieldset>
      </ActionForm>}
  </Modal>;
}

export function AppealTriage({ record }: { record: Appeal }) {
  const { user } = useSession();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<Group>();
  const [version, setVersion] = useState(record.version);
  const capabilities = useQuery({ queryKey: ['ai'], queryFn: () => api<{ available: boolean }>('/ai/capabilities') });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>('/catalog'), enabled: open });
  const advise = useMutation({ mutationFn: () => api<Advice>('/ai/appeal-triage', {
    method: 'POST', body: { id: record.id, consent: true },
  }) });
  const update = useMutation({ mutationFn: (categoryId: string) => api<Appeal>('/appeals/' + record.id, {
    method: 'PATCH', body: { expectedVersion: version, categoryId },
  }), onSuccess: result => {
    client.setQueryData(['appeal', record.id], result);
    void client.invalidateQueries({ queryKey: ['appeals'] });
  } });
  if (!capabilities.data?.available) return null;
  const result = advise.data?.suggestion;
  const category = catalog.data?.categories.find(row => row.id === result?.categoryId);
  return <>
    <Section title="ИИ-помощник" action={<button className="button secondary" onClick={() => {
      advise.reset(); update.reset(); setVersion(record.version); setOpen(true);
    }}>Анализ обращения</button>}>
      <small>Категория, похожие обращения, гипотезы причин и показатели для проверки.</small>
    </Section>
    {open && !group && <Modal title="Анализ обращения" close={() => setOpen(false)}
      description="Описание обычного внутреннего обращения и данные доступных кандидатов отправятся в Groq по вашему запросу.">
      <ErrorBox error={advise.error || catalog.error || update.error} />
      {advise.isPending && <Loading />}
      {result ? <div className="inner-stack">
        {advise.data?.truncated && <small>Часть входных данных была сокращена.</small>}
        <div><h3>Категория{category ? ' · ' + category.name : ''}</h3><p>{result.classificationReason}</p>
          {category && category.id !== record.categoryId && record.allowedActions.includes('EDIT') &&
            <button className="button secondary" disabled={update.isPending} onClick={() => update.mutate(category.id)}>Подтвердить категорию</button>}
          {update.isSuccess && <p role="status">Категория сохранена.</p>}
        </div>
        {result.groups.map((item, index) => <article className="comment" key={index}>
          <h3>{item.title}</h3><small>{label(item.relation)}</small><p>{item.evidence}</p>
          {item.candidateIds.map((id, i) => <div key={id}><Link to={'/appeals/' + id}>Обращение {i + 1}</Link></div>)}
          {user.permissions.includes('PROBLEM_OWNER') && <button className="button subtle" onClick={() => setGroup(item)}>Проверить и создать проблему</button>}
        </article>)}
        {([['Гипотезы причин', result.hypotheses], ['Возможные решения', result.possibleActions], ['KPI для проверки', result.proposedMetrics]] as const)
          .filter(([, rows]) => rows.length).map(([heading, rows]) => <div key={heading}><h3>{heading}</h3><ul>
            {rows.map((text, i) => <li key={i}>{text}</li>)}</ul></div>)}
        <AiDecision usageId={advise.data!.usageId} onDecide={() => setOpen(false)} />
      </div> : <button className="button primary" disabled={advise.isPending} onClick={() => advise.mutate()}>Запросить анализ</button>}
    </Modal>}
    {group && <ConfirmGroup group={group} record={record} close={() => setGroup(undefined)} />}
  </>;
}
