/* Sesión y administración de usuarios. */
import { request, setCsrf } from './http.js';

/** Estado de la sesión: { user } o { user: null }. También renueva el token CSRF. */
export async function getSession() {
  const r = await request('GET', '/api/auth/session');
  setCsrf(r.csrf);
  return r.user;
}

export async function login(username, password) {
  await request('POST', '/api/auth/login', { username, password });
  return getSession(); // el token CSRF cambia al iniciar sesión
}

export async function logout() {
  try { await request('POST', '/api/auth/logout'); } finally { setCsrf(''); }
}

export async function changePassword(current, password) {
  await request('POST', '/api/auth/password', { current, password });
  return getSession();
}

export const listUsers = () => request('GET', '/api/users/');
export const createUser = (u) => request('POST', '/api/users/', u);
export const updateUser = (id, patch) => request('PATCH', `/api/users/${encodeURIComponent(id)}`, patch);
export const deleteUser = (id) => request('DELETE', `/api/users/${encodeURIComponent(id)}`);
