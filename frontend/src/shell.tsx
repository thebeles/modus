import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowRight, Bell, BookOpen, ChevronDown, ChevronRight, CircleHelp, Command,
  GitPullRequest, House, Inbox, Layers3, LogOut, Menu, Plus, Settings, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { label } from '@kontur/api/contracts';
import { api, ApiError, type Session } from './api';
import { SessionContext, useSession } from './session';
import { ActionForm, date, Empty, ErrorBox, Field, field, Loading, Modal, PageHeading } from './ui';
import { AppealDetail, AppealList, Home, NewAppeal } from './appeals';
const CaseList = lazy(() => import('./cases').then(module => ({ default: module.CaseList })));
const CreateCase = lazy(() => import('./cases').then(module => ({ default: module.CreateCase })));
const ImprovementDetail = lazy(() => import('./cases').then(module => ({ default: module.ImprovementDetail })));
const ProblemDetail = lazy(() => import('./cases').then(module => ({ default: module.ProblemDetail })));
const ChangeDetail = lazy(() => import('./radar').then(module => ({ default: module.ChangeDetail })));
const Changes = lazy(() => import('./radar').then(module => ({ default: module.Changes })));
const FeedbackPage = lazy(() => import('./radar').then(module => ({ default: module.FeedbackPage })));
const RadarPage = lazy(() => import('./radar').then(module => ({ default: module.RadarPage })));
const AdminPage = lazy(() => import('./admin').then(module => ({ default: module.AdminPage })));

const employeeNav = [
  { to: '/', text: 'Главная', icon: House },
  { to: '/my/appeals', text: 'Мои обращения', icon: Inbox },
  { to: '/changes', text: 'Что улучшилось', icon: BookOpen },
];
const handlerNav = [
  { to: '/work-queue', text: 'Очередь', icon: Inbox },
  { to: '/problems', text: 'Проблемы', icon: GitPullRequest },
  { to: '/improvements', text: 'Улучшения', icon: Layers3 },
  { to: '/radar', text: 'Радар процессов', icon: Activity },
  { to: '/changes', text: 'Библиотека изменений', icon: BookOpen },
];
const managerNav = [handlerNav[3], handlerNav[2], { ...handlerNav[0], text: 'Очередь команды' }, handlerNav[1], handlerNav[4]];
const adminNav = [{ to: '/admin/users', text: 'Администрирование', icon: Settings }];
const navigation = { EMPLOYEE: employeeNav, HANDLER: handlerNav, MANAGER: managerNav, ADMIN: adminNav };
const landing = { EMPLOYEE: '/', HANDLER: '/work-queue', MANAGER: '/radar', ADMIN: '/admin/users' };
const initials = (name: string) => name.split(' ').slice(0, 2).map(part => part[0]).join('');

function Brand() {
  return <div className="brand"><span className="brand-mark"><Command size={22} strokeWidth={1.9} /></span>
    <span><strong>Модус<span className="brand-separator"> · </span>Контур</strong><small>Модус Трейд</small></span></div>;
}

function Login() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const demo = useQuery({ queryKey: ['demo'], queryFn: () => api<{ demoMode: boolean }>('/auth/capabilities') });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({ mutationFn: (data: { email: string; password: string } | { profile: string }) => api<Session>('profile' in data ? '/auth/demo' : '/auth/login', { method: 'POST', body: data }),
    onSuccess: session => { client.removeQueries({ predicate: query => query.queryKey[0] !== 'session' }); client.setQueryData(['session'], session); navigate(landing[session.user.role], { replace: true }); } });
  const demoAccounts = [['employee', 'Сотрудник'], ['handler', 'Обработчик'], ['manager', 'Руководитель'], ['admin', 'Администратор'],
    ['other-employee', 'Другой сотрудник'], ['sensitive-handler', 'Спецочередь']];
  return <main className="login-main">
    <div className="login-card">
      <h1>Вход в Контур</h1>
      <p>Войдите с рабочей учётной записью.</p>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); login.mutate({ email, password }); }}>
        <Field label="Рабочая почта"><input type="email" required autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} /></Field>
        <Field label="Пароль"><input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></Field>
        <ErrorBox error={login.error} />
        <button className="button primary login-submit" disabled={login.isPending}>{login.isPending ? 'Входим…' : 'Войти'} <ArrowRight size={20} aria-hidden="true" /></button>
      </form>
      {demo.data?.demoMode && <section className="demo-box" aria-labelledby="demo-heading">
        <h2 id="demo-heading" className="demo-heading">Демонстрационный вход</h2>
        <div className="demo-options">
          {demoAccounts.map(([account, name]) => <button type="button" key={account} disabled={login.isPending} onClick={() => {
            setEmail(`${account}@demo.local`); setPassword(''); login.mutate({ profile: account });
          }}><span>{name}</span><ChevronRight size={16} aria-hidden="true" /></button>)}
        </div>
      </section>}
    </div>
  </main>;
}

function Layout() {
  const { user, demoMode } = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobile, setMobile] = useState(false);
  const [profile, setProfile] = useState(false);
  const notices = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ unread: number }>('/notifications'), refetchInterval: 5000 });
  const logout = useMutation({ mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSuccess: () => { client.setQueryData(['session'], null); client.removeQueries({ predicate: query => query.queryKey[0] !== 'session' }); navigate('/login', { replace: true }); } });
  const password = useMutation({ mutationFn: (data: { current: string; password: string }) => api('/auth/change-password', { method: 'POST', body: data }),
    onSuccess: () => { client.setQueryData(['session'], null); client.removeQueries({ predicate: query => query.queryKey[0] !== 'session' }); navigate('/login', { replace: true }); } });
  const nav = navigation[user.role];
  const current = [...nav, { to: '/appeals/new', text: 'Новое обращение' }, { to: '/notifications', text: 'Уведомления' }]
    .find(item => item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to));
  function sideContent() {
    return <><div className="sidebar-brand"><Link to={landing[user.role]} onClick={() => setMobile(false)}><Brand /></Link></div>
      {user.role !== 'ADMIN' && <div className="sidebar-create"><Link className="button primary" to="/appeals/new" onClick={() => setMobile(false)}><Plus size={19} />Создать обращение</Link></div>}
      <nav className="nav-list" aria-label="Основная навигация"><div className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        {nav.map(({ to, text, icon: Icon }) => <NavLink key={to} end={to === '/'} to={to} onClick={() => setMobile(false)}><Icon size={18} />{text}</NavLink>)}
        <NavLink to="/notifications" onClick={() => setMobile(false)}><Bell size={18} />Уведомления{notices.data?.unread ? <span className="nav-count">{notices.data.unread}</span> : null}</NavLink>
      </nav>
      <div className="sidebar-bottom"><Link to="/help" className="nav-help" onClick={() => setMobile(false)}><CircleHelp size={18} />Помощь</Link>
        <button className="user-card" type="button" onClick={() => { setMobile(false); setProfile(true); }}><span className="avatar">{initials(user.name)}</span>
          <span><strong>{user.name}</strong><small>{label(user.role)}</small></span><ChevronDown size={15} /></button>
      </div></>;
  }
  return <div className={user.role === 'EMPLOYEE' && location.pathname === '/' ? 'app-shell home-shell' : 'app-shell'}>
    <a href="#content" className="skip">К содержанию</a>
    <aside className="sidebar">{sideContent()}</aside>
    {mobile && <Modal title="Навигация" close={() => setMobile(false)}><div className="mobile-nav">{sideContent()}</div></Modal>}
    <div className="main-shell"><header className="topbar"><div className="breadcrumbs">
      <button className="icon-button mobile-menu" type="button" aria-label="Открыть навигацию" onClick={() => setMobile(true)}><Menu size={21} /></button>
      <Link to={landing[user.role]} className="crumb-home" aria-label="Рабочая главная"><House size={16} aria-hidden="true" /></Link><ChevronRight size={14} className="crumb-separator" />
      <span>{current?.text ?? 'Рабочее пространство'}</span></div>
      <div className="top-actions">{demoMode && <span className="demo-pill"><span /> Демо-режим</span>}
        <Link to="/notifications" className="icon-button bell-link" aria-label={`Уведомления, непрочитанных: ${notices.data?.unread ?? 0}`}><Bell size={19} />{notices.data?.unread ? <b /> : null}</Link>
        <button className="avatar small-avatar" onClick={() => setProfile(true)} type="button" aria-label="Профиль">{initials(user.name)}</button>
      </div></header>
      <main className="content" id="content" tabIndex={-1}><Suspense fallback={<Loading />}><Outlet /></Suspense></main>
    </div>
    {profile && <Modal title="Профиль" close={() => setProfile(false)}>
      <div className="profile-box"><span className="avatar">{initials(user.name)}</span><div><strong>{user.name}</strong><p>{user.email} · {label(user.role)}</p></div></div>
      {!user.demo && <ActionForm pending={password.isPending} error={password.error} submit="Сменить пароль" onSubmit={data => password.mutate({ current: field(data, 'current'), password: field(data, 'password') })}>
        <Field label="Текущий пароль"><input name="current" type="password" required autoComplete="current-password" /></Field>
        <Field label="Новый пароль"><input name="password" type="password" minLength={12} required autoComplete="new-password" /></Field>
      </ActionForm>}
      <ErrorBox error={logout.error} /><button className="button secondary" onClick={() => logout.mutate()} disabled={logout.isPending}><LogOut size={17} /> Выйти из аккаунта</button>
    </Modal>}
  </div>;
}

export function Notifications() {
  const client = useQueryClient();
  const rows = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ unread: number; items: { id: string; href?: string; kind: string; readAt?: string; createdAt: string }[] }>('/notifications') });
  const [settings, setSettings] = useState(false);
  const preferences = useQuery({ queryKey: ['notification-preferences'], queryFn: () => api<{ notifyRegistration: boolean }>('/notification-preferences'), enabled: settings });
  const updatePreferences = useMutation({ mutationFn: (notifyRegistration: boolean) => api<{ notifyRegistration: boolean }>('/notification-preferences', {
    method: 'PATCH', body: { notifyRegistration },
  }), onSuccess: value => { client.setQueryData(['notification-preferences'], value); setSettings(false); } });
  const read = useMutation({ mutationFn: (path: string) => api(path, { method: 'POST' }), onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }) });
  return <><PageHeading title="Уведомления" subtitle="Ответы, решения и приглашения к обратной связи." action={<div className="button-row"><button className="button secondary" onClick={() => { updatePreferences.reset(); setSettings(true); }}><Settings size={16} />Настройки</button>
    {rows.data?.unread ? <button className="button secondary" disabled={read.isPending} onClick={() => read.mutate('/notifications/read-all')}>Отметить все прочитанными</button> : null}</div>} />
    {settings && <Modal title="Настройки уведомлений" close={() => setSettings(false)} description="Уточнения, назначения и решения приходят всегда.">
      <ErrorBox error={preferences.error} retry={() => preferences.refetch()} />{preferences.isPending && <Loading />}
      {preferences.data && <ActionForm pending={updatePreferences.isPending} error={updatePreferences.error} onSubmit={data => updatePreferences.mutate(data.has('notifyRegistration'))}>
        <label className="checkbox-line"><input type="checkbox" name="notifyRegistration" defaultChecked={preferences.data.notifyRegistration} /> Подтверждения регистрации моих обращений</label>
      </ActionForm>}
    </Modal>}
    <ErrorBox error={rows.error || read.error} retry={() => rows.refetch()} />{rows.isPending && <Loading />}
    {rows.data && <div className="surface">{rows.data.items.length ? rows.data.items.map(item => <div className={`notification-row ${item.readAt ? '' : 'unread'}`} key={item.id}>
      <span className="row-icon"><Bell size={18} /></span><div>{item.href ? <Link to={item.href} onClick={() => { if (!item.readAt) read.mutate(`/notifications/${item.id}/read`); }}>{label(item.kind)}</Link> : <strong>{label(item.kind)}</strong>}
      <small>{date(item.createdAt, true)}</small></div>{!item.readAt && <button className="icon-button" aria-label="Отметить прочитанным" onClick={() => read.mutate(`/notifications/${item.id}/read`)}><X size={17} /></button>}
    </div>) : <Empty title="Новых событий нет" />}</div>}</>;
}

function Help() {
  return <><PageHeading title="Помощь" /><div className="surface detail-section"><h2>Как отправить обращение</h2><p>Выберите тип, опишите ситуацию и отправьте. Категорию и решение можно добавить, если они уже известны.</p>
    <h2>Кто увидит обращение</h2><p>Автор и сотрудники с разрешением на обработку. Для чувствительных тем используйте ограниченный доступ или специальную очередь. Система сохраняет личность автора.</p>
    <h2>Как узнать результат</h2><p>Откройте карточку обращения или перейдите по ссылке из уведомления. Итог и обоснование появятся после рассмотрения.</p></div></>;
}

function Guard({ roles, children }: { roles: Session['user']['role'][]; children: React.ReactNode }) {
  const { user } = useSession();
  return roles.includes(user.role) ? children : <Unavailable />;
}

function Unavailable() {
  const { user } = useSession();
  return <><PageHeading title="Страница недоступна" /><Empty title="Страница отсутствует или у вас нет доступа"><Link className="button secondary" to={landing[user.role]}>В рабочее пространство</Link></Empty></>;
}

export function App() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ['session'], queryFn: async () => {
    try { return await api<Session>('/auth/me'); } catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
  } });
  useEffect(() => {
    const expired = () => { client.setQueryData(['session'], null); client.removeQueries({ predicate: query => query.queryKey[0] !== 'session' }); };
    window.addEventListener('kontur-session-expired', expired);
    return () => window.removeEventListener('kontur-session-expired', expired);
  }, [client]);
  if (me.isPending) return <main className="full-center"><Loading /></main>;
  if (me.error) return <main className="full-center"><ErrorBox error={me.error} retry={() => me.refetch()} /></main>;
  if (!me.data) return <Login />;
  const staff: Session['user']['role'][] = ['HANDLER', 'MANAGER'];
  return <SessionContext.Provider value={me.data}><Routes>
    <Route element={<Layout />}>
      <Route index element={me.data.user.role === 'EMPLOYEE' ? <Home /> : <Navigate to={landing[me.data.user.role]} replace />} />
      <Route path="login" element={<Navigate to={landing[me.data.user.role]} replace />} />
      <Route path="appeals/new" element={<Guard roles={['EMPLOYEE', ...staff]}><NewAppeal /></Guard>} />
      <Route path="my/appeals" element={<AppealList />} />
      <Route path="appeals/:id" element={<AppealDetail />} />
      <Route path="work-queue" element={<Guard roles={staff}><AppealList staff /></Guard>} />
      <Route path="work-queue/appeals/:id" element={<Guard roles={staff}><AppealDetail /></Guard>} />
      <Route path="problems" element={<Guard roles={staff}><CaseList kind="problem" /></Guard>} />
      <Route path="problems/new" element={<Guard roles={staff}><CreateCase kind="problem" /></Guard>} />
      <Route path="problems/:id" element={<Guard roles={staff}><ProblemDetail /></Guard>} />
      <Route path="improvements" element={<Guard roles={staff}><CaseList kind="improvement" /></Guard>} />
      <Route path="improvements/new" element={<Guard roles={staff}><CreateCase kind="improvement" /></Guard>} />
      <Route path="improvements/:id" element={<Guard roles={staff}><ImprovementDetail /></Guard>} />
      <Route path="radar" element={<Guard roles={staff}><RadarPage /></Guard>} />
      <Route path="changes" element={<Changes />} /><Route path="changes/:id" element={<ChangeDetail />} />
      <Route path="feedback/:id" element={<FeedbackPage />} /><Route path="notifications" element={<Notifications />} />
      <Route path="admin/:resource" element={<Guard roles={['ADMIN']}><AdminPage /></Guard>} />
      <Route path="help" element={<Help />} /><Route path="*" element={<Unavailable />} />
    </Route>
  </Routes></SessionContext.Provider>;
}
