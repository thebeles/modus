import { CalendarDays, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { useId, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent } from 'react';

type DatePickerProps = Omit<ComponentPropsWithoutRef<'input'>, 'type' | 'onChange' | 'min' | 'max'> & {
  type: 'date' | 'datetime-local' | 'time';
  min?: string;
  max?: string;
  onValueChange?: (value: string) => void;
};

const monthLabel = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeZone: 'UTC' });
const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const pad = (value: number) => String(value).padStart(2, '0');
const dateKey = (date: Date) => date.toISOString().slice(0, 10);

function monthStart(value: string) {
  return new Date(value.slice(0, 7) + '-01T00:00:00Z');
}

function moveDate(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function TimePart({ label, count, value, onChange }: {
  label: string; count: number; value: string; onChange: (value: string) => void;
}) {
  return <label className="field">{label}<select value={value} onChange={event => onChange(event.target.value)}>
    {Array.from({ length: count }, (_, index) => <option key={index} value={pad(index)}>{pad(index)}</option>)}
  </select></label>;
}

export function DatePicker({ type, min, max, onValueChange, ...props }: DatePickerProps) {
  const panelId = useId();
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const today = dateKey(new Date());
  const hasDate = type !== 'time';
  const hasTime = type !== 'date';
  const hasSeconds = props.step === 1 || props.step === '1';
  const [month, setMonth] = useState(() => monthStart(today));
  const [selected, setSelected] = useState('');
  const [tabDay, setTabDay] = useState('');
  const [hours, setHours] = useState('00');
  const [minutes, setMinutes] = useState('00');
  const [seconds, setSeconds] = useState('00');
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const canSelect = (day: string) => (!min || day >= min.slice(0, 10)) && (!max || day <= max.slice(0, 10));
  const firstDay = moveDate(month, -((month.getUTCDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, index) => moveDate(firstDay, index));
  const activeDay = days.some(day => dateKey(day) === tabDay && canSelect(tabDay))
    ? tabDay : days.map(dateKey).find(day => day.startsWith(dateKey(month).slice(0, 7)) && canSelect(day));

  function prepare() {
    const value = input.current?.value ?? '';
    const [date = '', time = ''] = hasDate ? value.split('T') : ['', value];
    const [hour = '00', minute = '00', second = '00'] = (time || '00:00').split(':');
    const initial = date || (canSelect(today) ? today : (min ?? max)?.slice(0, 10) || today);
    setMonth(monthStart(initial));
    setSelected(date);
    setTabDay(initial);
    setHours(hour);
    setMinutes(minute);
    setSeconds(second.slice(0, 2));
    setInvalid(false);
  }

  function commit(value: string) {
    const field = input.current;
    if (!field) return;
    const previous = field.value;
    field.value = value;
    if (value && !field.validity.valid) {
      field.value = previous;
      setInvalid(true);
      return;
    }
    panel.current?.hidePopover();
    trigger.current?.focus();
    onValueChange?.(field.value);
  }

  function selectDay(day: string) {
    if (!hasTime) {
      commit(day);
      return;
    }
    setSelected(day);
    setTabDay(day);
    setMonth(monthStart(day));
    setInvalid(false);
  }

  function navigateMonth(offset: number) {
    const next = new Date(month);
    next.setUTCMonth(next.getUTCMonth() + offset);
    setMonth(next);
    setTabDay('');
  }

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!offset || !(event.target instanceof HTMLButtonElement)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll('button')];
    let index = buttons.indexOf(event.target) + offset;
    while (buttons[index]?.disabled) index += Math.sign(offset);
    buttons[index]?.focus();
  }

  const time = `${hours}:${minutes}${hasSeconds ? ':' + seconds : ''}`;
  const pickerLabel = hasDate ? (hasTime ? 'Выбрать дату и время' : 'Выбрать дату') : 'Выбрать время';
  return <div className="date-picker">
    <input {...props} ref={input} type={type} min={min} max={max} onChange={event => onValueChange?.(event.currentTarget.value)} />
    <button ref={trigger} className="icon-button date-picker-trigger" type="button" aria-label={pickerLabel}
      aria-expanded={open} popoverTarget={panelId} disabled={props.disabled || props.readOnly}
      onClick={() => { if (!panel.current?.matches(':popover-open')) prepare(); }}>
      {hasDate ? <CalendarDays size={16} aria-hidden="true" /> : <Clock size={16} aria-hidden="true" />}
    </button>
    <div ref={panel} id={panelId} className="date-picker-panel" popover="auto" role="dialog" aria-label={pickerLabel}
      onToggle={event => setOpen(event.currentTarget.matches(':popover-open'))}>
      {hasDate && <>
        <div className="date-picker-month">
          <button className="icon-button" type="button" aria-label="Предыдущий месяц" onClick={() => navigateMonth(-1)}><ChevronLeft size={16} /></button>
          <strong aria-live="polite">{monthLabel.format(month)}</strong>
          <button className="icon-button" type="button" aria-label="Следующий месяц" onClick={() => navigateMonth(1)}><ChevronRight size={16} /></button>
        </div>
        <div className="date-picker-grid" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
        <div className="date-picker-grid" role="group" aria-label="Дни месяца" onKeyDown={moveFocus}>
          {days.map(day => {
            const key = dateKey(day);
            return <button key={key} type="button" aria-label={dayLabel.format(day)} aria-pressed={selected === key}
              aria-current={today === key ? 'date' : undefined} disabled={!canSelect(key)}
              data-outside={day.getUTCMonth() !== month.getUTCMonth()} tabIndex={key === activeDay ? 0 : -1}
              onFocus={() => setTabDay(key)} onClick={() => selectDay(key)}>{day.getUTCDate()}</button>;
          })}
        </div>
      </>}
      {hasTime && <div className="date-picker-time" onChange={() => setInvalid(false)}>
        <TimePart label="Часы" count={24} value={hours} onChange={setHours} />
        <TimePart label="Минуты" count={60} value={minutes} onChange={setMinutes} />
        {hasSeconds && <TimePart label="Секунды" count={60} value={seconds} onChange={setSeconds} />}
      </div>}
      {invalid && <span className="field-error" role="alert">Значение вне допустимого диапазона.</span>}
      <div className="date-picker-actions">
        {!props.required && <button type="button" className="button subtle" onClick={() => commit('')}>Очистить</button>}
        {hasDate && <button type="button" className="button subtle" disabled={!canSelect(today)} onClick={() => selectDay(today)}>Сегодня</button>}
        {hasTime && <button type="button" className="button secondary" disabled={hasDate && !selected}
          onClick={() => commit(hasDate ? selected + 'T' + time : time)}>Готово</button>}
      </div>
    </div>
  </div>;
}
