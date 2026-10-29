import { useState } from 'react';
import { login } from '../api/auth.js';

export default function Login({ onLogin, initialError }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError || '');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      onLogin(await login(username.trim(), password));
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <h1>Plan de Virtualización 2026</h1>
          <span>Dirección de Innovación Educativa · Corporación Universitaria Americana</span>
        </div>
        <label className="field">
          Usuario
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck="false" maxLength={64} autoFocus required />
        </label>
        <label className="field">
          Contraseña
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" maxLength={128} required />
        </label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  );
}
