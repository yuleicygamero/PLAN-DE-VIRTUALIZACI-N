import { useState } from 'react';
import { changePassword, logout } from '../api/auth.js';

/** Cambio de contraseña. Con `forced` es la pantalla obligatoria tras una contraseña temporal. */
export default function ChangePassword({ user, forced, onDone, onCancel }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 12) return setError('La nueva contraseña debe tener al menos 12 caracteres.');
    if (password !== confirm) return setError('Las contraseñas nuevas no coinciden.');
    setBusy(true);
    try {
      const u = await changePassword(current, password);
      if (forced) onDone(u);
      else setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="auth-card">
        <h2>Contraseña actualizada</h2>
        <p className="muted" style={{ margin: 0 }}>Se cerraron tus sesiones en otros navegadores.</p>
        <button className="btn primary" onClick={onDone} autoFocus>Listo</button>
      </div>
    );
  }

  return (
    <form className="auth-card" onSubmit={submit}>
      <div>
        <div className="eyebrow">{forced ? 'Primer ingreso' : user.displayName}</div>
        <h2>{forced ? 'Crea tu contraseña' : 'Cambiar contraseña'}</h2>
        {forced && <p className="muted" style={{ margin: '6px 0 0' }}>Tu contraseña actual es temporal. Elige una nueva para continuar.</p>}
      </div>
      <input type="text" value={user.username} autoComplete="username" readOnly hidden />
      <label className="field">
        Contraseña actual
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" maxLength={128} autoFocus required />
      </label>
      <label className="field">
        Nueva contraseña
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={12} maxLength={128} required />
      </label>
      <label className="field">
        Repite la nueva contraseña
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={12} maxLength={128} required />
      </label>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>Mínimo 12 caracteres. Una frase de varias palabras es más fácil de recordar y más segura.</p>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <div className="actions" style={{ justifyContent: 'flex-end' }}>
        {forced
          ? <button type="button" className="btn ghost" onClick={() => logout().finally(() => window.location.reload())}>Salir</button>
          : <button type="button" className="btn" onClick={onCancel}>Cancelar</button>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar contraseña'}</button>
      </div>
    </form>
  );
}
