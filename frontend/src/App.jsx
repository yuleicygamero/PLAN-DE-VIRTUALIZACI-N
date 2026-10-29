import { useEffect, useState } from 'react';
import { startPlan } from './engine/plan.js';
import { db, downloads } from './api/db.js';
import { getSession, logout } from './api/auth.js';
import Login from './components/Login.jsx';
import ChangePassword from './components/ChangePassword.jsx';
import Users from './components/Users.jsx';

const TABS = [
  ['resumen', 'Resumen'],
  ['programas', 'Programas y asignaturas'],
  ['cronograma', 'Cronograma'],
  ['inicios', 'Inicio de clases'],
  ['tronco', 'Tronco común'],
  ['ocultos', 'Ocultos'],
];

const ROLE_NAMES = { admin: 'Administrador', editor: 'Editor', lector: 'Solo lectura' };

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = comprobando la sesión
  const [error, setError] = useState('');

  useEffect(() => {
    getSession().then(setUser).catch((e) => { setUser(null); setError(e.message); });
  }, []);

  useEffect(() => {
    // Una petición recibió 401/CSRF o se cortó el tiempo real: si la sesión ya no vale, se recarga la app.
    const check = () => getSession()
      .then((u) => { if (!u || u.mustChangePassword) window.location.reload(); })
      .catch(() => {});
    window.addEventListener('pv:unauthorized', check);
    return () => window.removeEventListener('pv:unauthorized', check);
  }, []);

  if (user === undefined) return <div className="auth-page"><div className="notice">Cargando…</div></div>;
  if (!user) return <Login onLogin={setUser} initialError={error} />;
  if (user.mustChangePassword) return <div className="auth-page"><ChangePassword forced user={user} onDone={setUser} /></div>;
  return <Platform user={user} />;
}

/*
 * Estructura fija de la plataforma. El contenido de cada vista lo dibuja el
 * motor (src/engine/plan.js) dentro de #main, #bulk-root, #modal-root y #toast-root,
 * así que React no vuelve a renderizar esos contenedores.
 */
function Platform({ user }) {
  const [panel, setPanel] = useState(null); // 'usuarios' | 'password' | null

  useEffect(() => {
    startPlan({ db, downloads, canWrite: user.role !== 'lector' });
  }, []);

  const exit = async () => {
    await logout().catch(() => {});
    window.location.reload();
  };

  return (
    <>
      <header className="top">
        <div className="wrap top-row">
          <div className="brand">
            <h1>Plan de Virtualización 2026</h1>
            <span>Dirección de Innovación Educativa · Corporación Universitaria Americana</span>
          </div>
          <nav className="tabs" role="tablist" id="tabs">
            {TABS.map(([id, label]) => (
              <button key={id} className="tab" role="tab" data-tab={id} id={id === 'ocultos' ? 'tab-ocultos' : undefined}>
                {label}
              </button>
            ))}
          </nav>
          <div className="actions">
            <button className="btn primary" id="import-all-btn">Importar Excel</button>
            <button className="btn" id="export-btn" hidden>Exportar</button>
          </div>
          <div className="user-menu">
            <div className="user-chip">
              <b>{user.displayName}</b>
              <small>{ROLE_NAMES[user.role] || user.role}</small>
            </div>
            {user.role === 'admin' && <button className="btn" onClick={() => setPanel('usuarios')}>Usuarios</button>}
            <button className="btn" onClick={() => setPanel('password')}>Contraseña</button>
            <button className="btn ghost" onClick={exit}>Salir</button>
          </div>
        </div>
      </header>
      <div className="wrap">
        <main id="main" dangerouslySetInnerHTML={{ __html: '<div class="notice">Cargando programas y asignaturas…</div>' }} />
      </div>
      <div id="bulk-root" />
      <div id="modal-root" />
      <div id="toast-root" />
      {panel === 'usuarios' && <Users me={user} onClose={() => setPanel(null)} />}
      {panel === 'password' && (
        <div className="modal-bg auth-modal" onMouseDown={(e) => e.target === e.currentTarget && setPanel(null)}>
          <ChangePassword user={user} onDone={() => setPanel(null)} onCancel={() => setPanel(null)} />
        </div>
      )}
    </>
  );
}
