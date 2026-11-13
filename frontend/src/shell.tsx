import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowRight, Bell, BookOpen, ChevronRight, CircleHelp,
  House, Inbox, Layers3, LogOut, Menu, Plus, Settings, X } from './icons';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { label } from './contracts';
import { api, ApiError, queryString, type Page, type Session } from './api';
import { SessionContext, useSession } from './session';
import { ActionForm, date, Empty, ErrorBox, Field, Loading, Modal, PageHeading, Pagination } from './ui';
import { AppealChannels, AppealDetail, AppealList, Home, NewAppeal } from './appeals';
import { AnonymousPage } from './anonymous';
const ProposalsPage = lazy(() => import('./feedback-channels').then(module => ({ default: module.ProposalsPage })));
const ReviewsPage = lazy(() => import('./feedback-channels').then(module => ({ default: module.ReviewsPage })));
const OneCPage = lazy(() => import('./one-c').then(module => ({ default: module.OneCPage })));
const ImprovementsWorkspace = lazy(() => import('./cases').then(module => ({ default: module.ImprovementsWorkspace })));
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
  { to: '/changes', text: 'Что изменилось', icon: BookOpen },
];
const queueNav = { to: '/work-queue', text: 'Очередь', icon: Inbox };
const improvementNav = { to: '/improvements', text: 'Улучшения', icon: Layers3 };
const overviewNav = { to: '/overview', text: 'Обзор', icon: Activity };
const navigation = {
  EMPLOYEE: employeeNav,
  HANDLER: [queueNav, improvementNav],
  MANAGER: [overviewNav, { ...queueNav, text: 'Обращения' }, improvementNav],
  ADMIN: [{ to: '/admin', text: 'Администрирование', icon: Settings }],
};
const landing = { EMPLOYEE: '/', HANDLER: '/work-queue', MANAGER: '/overview', ADMIN: '/admin/users' };

function Brand() {
  return <div className="brand"><strong>До результата</strong></div>;
}

function Login() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const demo = useQuery({ queryKey: ['demo'], queryFn: () => api<{ demoMode: boolean }>('/auth/capabilities') });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({ mutationFn: (data: { email: string; password: string } | { profile: string }) => api<Session>('profile' in data ? '/auth/demo' : '/auth/login', { method: 'POST', body: data }),
    onSuccess: session => { client.removeQueries({ predicate: query => query.queryKey[0] !== 'session' }); client.setQueryData(['session'], session); navigate(['/', '/login'].includes(location.pathname) ? landing[session.user.role] : location, { replace: true }); } });
  const demoAccounts = [['employee', 'Сотрудник'], ['manager', 'Руководитель'], ['handler', 'Обработчик'], ['admin', 'Администратор'],
    ['other-employee', 'Другой сотрудник'], ['sensitive-handler', 'Спецочередь']];
  return <main className="login-main">
    <div className="login-card">
      <h1>До результата</h1>
      <p>Ваши идеи. Реальные изменения. Проверенный результат</p>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); login.mutate({ email, password }); }}>
        <Field label="Рабочая почта"><input type="email" required autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} /></Field>
        <Field label="Пароль"><input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></Field>
        <ErrorBox error={login.error} />
        <button className="button primary login-submit" disabled={login.isPending}>{login.isPending ? 'Входим…' : 'Войти'} <ArrowRight size={20} aria-hidden="true" /></button>
      </form>
      <a className="text-button anonymous-login" href="/anonymous">Сообщить анонимно</a>
      {demo.data?.demoMode && <details className="demo-box">
        <summary>Попробовать демоверсию</summary>
        <div className="demo-options">
          {demoAccounts.slice(0, 3).map(([account, name]) => <button type="button" key={account} disabled={login.isPending} onClick={() => login.mutate({ profile: account })}>
            <span>{name}</span><ChevronRight size={16} aria-hidden="true" /></button>)}
        </div>
        <details className="demo-other"><summary>Другие сценарии</summary>
          <div className="demo-options">
            {demoAccounts.slice(3).map(([account, name]) => <button type="button" key={account} disabled={login.isPending} onClick={() => login.mutate({ profile: account })}>
              <span>{name}</span><ChevronRight size={16} aria-hidden="true" /></button>)}
          </div>
        </details>
      </details>}
    </div>
  </main>;
}

function Layout() {
  const { user } = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [mobile, setMobile] = useState(false);
  const notices = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ unread: number }>('/notifications?limit=1'), refetchInterval: 5000 });
  const logout = useMutation({ mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSuccess: () => { client.setQueryData(['session'], null); client.removeQueries({ predicate: query => query.queryKey[0] !== 'session' }); navigate('/login', { replace: true }); } });
  const location = useLocation();
  const staff = user.role === 'HANDLER' || user.role === 'MANAGER';
  const oneC = useQuery({ queryKey: ['one-c-capabilities'], queryFn: () => api<{ mode: string | null }>('/one-c/capabilities'),
    enabled: staff && (user.demo || user.permissions.includes('ONEC_OPERATOR')) });
  const isHome = user.role === 'EMPLOYEE' && location.pathname === '/';
  const profileLinks = staff || user.role === 'ADMIN';
  function sideContent() {
    return <><div className="sidebar-brand"><Link to={landing[user.role]} onClick={() => setMobile(false)}><Brand /></Link></div>
      {user.role !== 'ADMIN' && !isHome && <div className="sidebar-create"><Link className="button primary" to="/appeals/new" onClick={() => setMobile(false)}><Plus size={19} />Создать обращение</Link></div>}
      <nav className="nav-list" aria-label="Основная навигация">
        {navigation[user.role].map(({ to, text, icon: Icon }) => {
          const legacyActive = (to === '/improvements' && /^\/problems(?:\/|$)/.test(location.pathname)) ||
            (to === '/work-queue' && location.pathname === '/customer-reviews') ||
            (to === '/my/appeals' && location.pathname === '/proposals');
          return <NavLink key={to} end={to === '/'} to={to} className={legacyActive ? 'active' : undefined}
            aria-current={legacyActive ? 'location' : undefined} onClick={() => setMobile(false)}><Icon size={18} aria-hidden="true" />{text}</NavLink>;
        })}
      </nav>
      <div className="sidebar-bottom"><Link to="/help" className="nav-help" onClick={() => setMobile(false)}><CircleHelp size={18} />Помощь</Link></div></>;
  }
  return <div className="app-shell">
    <a href="#content" className="skip">К содержанию</a>
    <aside className="sidebar">{sideContent()}</aside>
    {mobile && <Modal title="Навигация" close={() => setMobile(false)}><div className="mobile-nav">{sideContent()}</div></Modal>}
    <div className="main-shell">
      <header className="workspace-header">
        <button className="icon-button mobile-menu" type="button" aria-label="Открыть навигацию" onClick={() => setMobile(true)}><Menu size={21} aria-hidden="true" /></button>
        <div className="workspace-account">
          <Link to="/notifications" className="icon-button notification-button" aria-label={notices.data?.unread ? `Уведомления, непрочитанных: ${notices.data.unread}` : 'Уведомления'}>
            <Bell size={19} aria-hidden="true" />{notices.data?.unread ? <span className="nav-count" aria-hidden="true">{notices.data.unread}</span> : null}
          </Link>
          <details className="account-menu" key={location.key}>
            <summary>{user.name}</summary>
            <div className="surface account-panel">
              <div className="user-card"><strong>{user.name}</strong><small>{user.email}</small><small>{label(user.role)}</small></div>
              {profileLinks && <Link to="/my/appeals">Мои обращения</Link>}
              {profileLinks && <Link to="/changes">Что изменилось</Link>}
              {staff && user.role !== 'MANAGER' && <Link to="/overview">Обзор</Link>}
              {staff && oneC.data?.mode && <Link to="/one-c">Интеграция 1С</Link>}
              <button className="button secondary" type="button" disabled={logout.isPending} onClick={() => logout.mutate()}><LogOut size={17} aria-hidden="true" />Выйти из аккаунта</button>
              <ErrorBox error={logout.error} />
            </div>
          </details>
        </div>
      </header>
      <main className="content" id="content" tabIndex={-1}><Suspense fallback={<Loading />}><Outlet /></Suspense></main>
    </div>
  </div>;
}

export function Notifications() {
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const rows = useQuery({ queryKey: ['notifications', page, unreadOnly], queryFn: ({ signal }) => api<Page<{ id: string; href?: string; kind: string; readAt?: string; createdAt: string }> & { unread: number }>(
    '/notifications' + queryString({ page, unreadOnly: unreadOnly ? 'true' : undefined }), { signal }), refetchInterval: 3000 });
  const [settings, setSettings] = useState(false);
  const preferences = useQuery({ queryKey: ['notification-preferences'], queryFn: () => api<{ notifyRegistration: boolean }>('/notification-preferences'), enabled: settings });
  const updatePreferences = useMutation({ mutationFn: (notifyRegistration: boolean) => api<{ notifyRegistration: boolean }>('/notification-preferences', {
    method: 'PATCH', body: { notifyRegistration },
  }), onSuccess: value => { client.setQueryData(['notification-preferences'], value); setSettings(false); } });
  const read = useMutation({ mutationFn: (path: string) => api(path, { method: 'POST' }), onSuccess: () => { if (unreadOnly) setPage(1); return client.invalidateQueries({ queryKey: ['notifications'] }); } });
  return <><PageHeading title="Уведомления" subtitle="Ответы, решения и приглашения к обратной связи." action={<div className="button-row"><button className="button secondary" onClick={() => { updatePreferences.reset(); setSettings(true); }}><Settings size={16} />Настройки</button>
    {rows.data?.unread ? <button className="button secondary" disabled={read.isPending} onClick={() => read.mutate('/notifications/read-all')}>Отметить все прочитанными</button> : null}</div>} />
    {settings && <Modal title="Настройки уведомлений" close={() => setSettings(false)} description="Уточнения, назначения и решения приходят всегда.">
      <ErrorBox error={preferences.error} retry={() => preferences.refetch()} />{preferences.isPending && <Loading />}
      {preferences.data && <ActionForm pending={updatePreferences.isPending} error={updatePreferences.error} onSubmit={data => updatePreferences.mutate(data.has('notifyRegistration'))}>
        <label className="checkbox-line"><input type="checkbox" name="notifyRegistration" defaultChecked={preferences.data.notifyRegistration} /> Подтверждения регистрации моих обращений</label>
      </ActionForm>}
    </Modal>}
    <label className="checkbox-line"><input type="checkbox" checked={unreadOnly} onChange={event => { setUnreadOnly(event.target.checked); setPage(1); }} /> Только непрочитанные</label>
    <ErrorBox error={rows.error || read.error} retry={() => rows.refetch()} />{rows.isPending && <Loading />}
    {rows.data && <div className="surface">{rows.data.items.length ? rows.data.items.map(item => <div className={`notification-row ${item.readAt ? '' : 'unread'}`} key={item.id}>
      <span className="row-icon"><Bell size={18} /></span><div>{item.href ? <Link to={item.href} onClick={() => { if (!item.readAt) read.mutate(`/notifications/${item.id}/read`); }}>{label(item.kind)}</Link> : <strong>{label(item.kind)}</strong>}
      <small>{date(item.createdAt, true)}</small></div>{!item.readAt && <button className="icon-button" aria-label="Отметить прочитанным" onClick={() => read.mutate(`/notifications/${item.id}/read`)}><X size={17} /></button>}
    </div>) : <Empty title="Новых событий нет" />}</div>}{rows.data && <Pagination {...rows.data} onChange={setPage} />}</>;
}

function Help() {
  return <><PageHeading title="Помощь" /><div className="surface detail-section"><h2>Как отправить обращение</h2><p>Выберите тип, опишите ситуацию и отправьте. Категорию и решение можно добавить, если они уже известны.</p>
    <h2>Кто увидит обращение</h2><p>Автор и сотрудники с разрешением на обработку. Для чувствительных тем используйте ограниченный доступ или специальную очередь. Для подачи без учётной записи откройте <a href="/anonymous">анонимный канал</a>.</p>
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

function LegacyList({ to, view }: { to: string; view?: string }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  if (view) params.set('view', view);
  return <Navigate to={{ pathname: to, search: params.toString(), hash: location.hash }} replace />;
}

export function App() {
  const location = useLocation();
  const client = useQueryClient();
  const me = useQuery({ queryKey: ['session'], enabled: !['/anonymous', '/anonymous/'].includes(location.pathname), queryFn: async () => {
    try { return await api<Session>('/auth/me'); } catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
  } });
  useEffect(() => {
    const expired = () => { client.setQueryData(['session'], null); client.removeQueries({ predicate: query => query.queryKey[0] !== 'session' }); };
    window.addEventListener('modus-session-expired', expired);
    return () => window.removeEventListener('modus-session-expired', expired);
  }, [client]);
  if (location.pathname === '/anonymous' || location.pathname === '/anonymous/') return <AnonymousPage />;
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
      <Route path="problems" element={<Guard roles={staff}><LegacyList to="/improvements" view="problems" /></Guard>} />
      <Route path="problems/new" element={<Guard roles={staff}><CreateCase kind="problem" /></Guard>} />
      <Route path="problems/:id" element={<Guard roles={staff}><ProblemDetail /></Guard>} />
      <Route path="improvements" element={<Guard roles={staff}><ImprovementsWorkspace /></Guard>} />
      <Route path="improvements/new" element={<Guard roles={staff}><CreateCase kind="improvement" /></Guard>} />
      <Route path="improvements/:id" element={<Guard roles={staff}><ImprovementDetail /></Guard>} />
      <Route path="proposals" element={<Guard roles={['EMPLOYEE', ...staff]}><><AppealChannels /><ProposalsPage /></></Guard>} />
      <Route path="customer-reviews" element={<Guard roles={staff}><><AppealChannels staff /><ReviewsPage /></></Guard>} />
      <Route path="one-c" element={<Guard roles={staff}><OneCPage /></Guard>} />
      <Route path="overview" element={<Guard roles={staff}><RadarPage /></Guard>} />
      <Route path="radar" element={<Guard roles={staff}><LegacyList to="/overview" /></Guard>} />
      <Route path="changes" element={<Changes />} /><Route path="changes/:id" element={<ChangeDetail />} />
      <Route path="feedback/:id" element={<FeedbackPage />} /><Route path="notifications" element={<Notifications />} />
      <Route path="admin" element={<Guard roles={['ADMIN']}><LegacyList to="/admin/users" /></Guard>} />
      <Route path="admin/:resource" element={<Guard roles={['ADMIN']}><AdminPage /></Guard>} />
      <Route path="help" element={<Help />} /><Route path="*" element={<Unavailable />} />
    </Route>
  </Routes></SessionContext.Provider>;
}
