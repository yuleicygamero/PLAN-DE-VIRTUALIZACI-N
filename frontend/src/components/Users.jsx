import { useEffect, useState } from 'react';
import { createUser, deleteUser, listUsers, updateUser } from '../api/auth.js';

const ROLES = [
  ['editor', 'Editor', 'Modifica el plan'],
  ['lector', 'Solo lectura', 'Consulta sin modificar'],
  ['admin', 'Administrador', 'Modifica el plan y administra usuarios'],
];
const fmt = (d) => (d ? new Date(d).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : 'Nunca');

/** Administración de usuarios (solo administradores). */
export default function Users({ me, onClose }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState(null); // { username, password } recién generada: se muestra una sola vez
  const [confirmDel, setConfirmDel] = useState(null);
  const [form, setForm] = useState({ username: '', displayName: '', role: 'editor' });
  const [busy, setBusy] = useState(false);

  const load = () => listUsers().then(setUsers).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (fn) => {
    setError('');
    setBusy(true);
    try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const create = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await createUser(form);
      setSecret({ username: r.user.username, password: r.password });
      setForm({ username: '', displayName: '', role: 'editor' });
    });
  };
  const patch = (u, p) => run(async () => {
    const r = await updateUser(u.id, p);
    if (r.password) setSecret({ username: u.username, password: r.password });
  });
  const remove = (u) => run(async () => { await deleteUser(u.id); setConfirmDel(null); });

  return (
    <div className="modal-bg auth-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="usuarios-title">
        <div className="modal-h">
          <div><div className="eyebrow">Administración</div><h2 id="usuarios-title">Usuarios</h2></div>
          <button className="btn ghost" onClick={onClose}>Cerrar</button>
        </div>
        <div className="modal-b">
          {secret && (
            <div className="auth-ok" role="status">
              <div>Contraseña temporal de <b>{secret.username}</b> (se muestra una sola vez; entrégala por un canal seguro y pedirá cambiarla al entrar):</div>
              <div className="secret">{secret.password}</div>
              <div><button className="btn" onClick={() => setSecret(null)}>Ya la copié</button></div>
            </div>
          )}
          {error && <div className="auth-error" role="alert">{error}</div>}

          <form className="phead users-new" onSubmit={create}>
            <h3>Nuevo usuario</h3>
            <div className="cfg">
              <label className="field">Usuario<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="nombre.apellido" autoCapitalize="none" spellCheck="false" maxLength={64} required /></label>
              <label className="field">Nombre<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Nombre completo" maxLength={100} /></label>
              <label className="field">Rol<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
            </div>
            <div><button className="btn primary" type="submit" disabled={busy}>Crear con contraseña temporal</button></div>
          </form>

          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Último ingreso</th><th /></tr></thead>
              <tbody>
                {!users && <tr><td colSpan={5} className="muted">Cargando…</td></tr>}
                {users?.map((u) => {
                  const self = u.id === me.id;
                  return (
                    <tr key={u.id}>
                      <td><b>{u.displayName}</b><div className="muted" style={{ fontSize: 12 }}>{u.username}{self ? ' · tú' : ''}{u.mustChangePassword ? ' · contraseña temporal' : ''}</div></td>
                      <td>
                        <select className="sel" value={u.role} disabled={self || busy} onChange={(e) => patch(u, { role: e.target.value })} aria-label={`Rol de ${u.username}`}>
                          {ROLES.map(([k, n, d]) => <option key={k} value={k} title={d}>{n}</option>)}
                        </select>
                      </td>
                      <td>{u.disabled ? <span className="pill late">Desactivado</span> : <span className="pill done">Activo</span>}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{fmt(u.lastLoginAt)}</td>
                      <td>
                        {!self && (
                          <div className="actions" style={{ justifyContent: 'flex-end', gap: 4 }}>
                            <button className="icon-btn" disabled={busy} onClick={() => patch(u, { disabled: !u.disabled })}>{u.disabled ? 'Activar' : 'Desactivar'}</button>
                            <button className="icon-btn" disabled={busy} onClick={() => patch(u, { resetPassword: true })}>Restablecer contraseña</button>
                            {confirmDel === u.id
                              ? <><button className="icon-btn danger" disabled={busy} onClick={() => remove(u)}>¿Eliminar?</button><button className="icon-btn" onClick={() => setConfirmDel(null)}>No</button></>
                              : <button className="icon-btn danger" onClick={() => setConfirmDel(u.id)}>Eliminar</button>}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Al cambiar el rol, desactivar o restablecer la contraseña de un usuario, sus sesiones abiertas se cierran de inmediato.
            Cada inicio de sesión y cada cambio queda registrado en la bitácora del servidor.
          </p>
        </div>
      </div>
    </div>
  );
}
