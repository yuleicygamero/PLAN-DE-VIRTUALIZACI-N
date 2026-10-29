/*
 * Peticiones a la API. Todas van al mismo dominio con la cookie de sesión; las que
 * modifican datos llevan el token CSRF que entrega /api/auth/session.
 * Si la sesión expira (401) se avisa con el evento 'pv:unauthorized'.
 */

// Raíz donde está publicada la app (p. ej. /plan-virtualizacion), sin barra final.
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

let csrf = '';
export const setCsrf = (t) => { csrf = t || ''; };

const MESSAGES = {
  unavailable: 'No hay conexión con el servidor.',
  permission_denied: 'Tu usuario no tiene permiso para esta acción.',
  rate_limited: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.',
};

export const apiError = (code, message) => Object.assign(new Error(message || MESSAGES[code] || 'Error'), { code });

export async function request(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-XSRF-TOKEN'] = csrf;
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw apiError('unavailable');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const code = data?.code || (res.status === 401 ? 'unauthenticated' : res.status === 403 ? 'permission_denied' : res.status === 404 ? 'not_found' : res.status === 429 ? 'rate_limited' : 'unavailable');
  // Sesión vencida o revocada: la app vuelve a la pantalla de inicio de sesión.
  if ((res.status === 401 && !path.startsWith('/api/auth/')) || code === 'must_change_password' || code === 'csrf') {
    window.dispatchEvent(new Event('pv:unauthorized'));
  }
  throw apiError(code, data?.message);
}
