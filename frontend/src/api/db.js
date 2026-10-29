/*
 * Cliente de datos: habla con la API .NET (/api/docs) y escucha cambios en tiempo
 * real por SignalR (/hubs/changes). Expone la misma forma que usa el motor de la
 * plataforma: db.collection(c).onSnapshot(...), db.doc('c/id').update(...), etc.
 */
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr';

const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

const err = (code, message) => Object.assign(new Error(message), { code, message });

async function http(method, path, body) {
  let res;
  try {
    res = await fetch(`${API}/api/docs/${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw err('unavailable', 'No hay conexión con el servidor');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw err(res.status === 400 ? 'invalid_argument' : 'unavailable', `Error ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/* ---------- tiempo real ---------- */
const colListeners = new Map(); // colección -> Set(fn(change))
let hub = null;
function ensureHub() {
  if (hub) return;
  hub = new HubConnectionBuilder()
    .withUrl(`${API}/hubs/changes`)
    .withAutomaticReconnect()
    .configureLogging(LogLevel.Warning)
    .build();
  hub.on('changed', (ev) => {
    const set = colListeners.get(ev.collection);
    if (set) set.forEach((fn) => fn(ev));
  });
  hub.onreconnected(() => {
    // tras una desconexión, recarga cada colección para no perder cambios
    colListeners.forEach((set) => set.forEach((fn) => fn({ resync: true })));
  });
  hub.start().catch((e) => console.error('SignalR', e));
}

const snapDoc = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : structuredClone(data)), metadata: {} });
const newId = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function docRef(col, id) {
  const path = `${encodeURIComponent(col)}/${encodeURIComponent(id)}`;
  return {
    id,
    path: `${col}/${id}`,
    async get() {
      const r = await http('GET', path);
      return snapDoc(id, r ? r.data : null);
    },
    async set(data) { await http('PUT', path, data); },
    async update(patch) {
      const r = await http('PATCH', path, patch);
      if (r == null) throw err('invalid_argument', 'El documento no existe');
    },
    async delete() { await http('DELETE', path); },
    onSnapshot(next, onError) {
      return collectionRef(col).onSnapshot((snap) => {
        const d = snap.docs.find((x) => x.id === id);
        next(d || snapDoc(id, null));
      }, onError);
    },
  };
}

function collectionRef(col) {
  return {
    path: col,
    doc: (id) => docRef(col, id || newId()),
    async add(data) { const r = docRef(col, newId()); await r.set(data); return r; },
    async get() {
      const list = (await http('GET', encodeURIComponent(col))) || [];
      const docs = list.map((d) => snapDoc(d.id, d.data));
      return { docs, size: docs.length, empty: !docs.length };
    },
    onSnapshot(next, onError) {
      ensureHub();
      const state = new Map();
      let alive = true;
      const emit = (changes) => {
        if (!alive) return;
        const docs = [...state.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([id, data]) => snapDoc(id, data));
        next({ docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => changes });
      };
      const load = async () => {
        try {
          const list = (await http('GET', encodeURIComponent(col))) || [];
          const seen = new Set();
          const changes = [];
          for (const d of list) {
            seen.add(d.id);
            changes.push({ type: state.has(d.id) ? 'modified' : 'added', doc: snapDoc(d.id, d.data) });
            state.set(d.id, d.data);
          }
          for (const id of [...state.keys()]) if (!seen.has(id)) {
            changes.push({ type: 'removed', doc: snapDoc(id, state.get(id)) });
            state.delete(id);
          }
          emit(changes);
        } catch (e) {
          onError && onError(e);
        }
      };
      const onChange = (ev) => {
        if (ev.resync) { load(); return; }
        if (ev.deleted) {
          const prev = state.get(ev.id);
          state.delete(ev.id);
          emit([{ type: 'removed', doc: snapDoc(ev.id, prev) }]);
        } else {
          const type = state.has(ev.id) ? 'modified' : 'added';
          state.set(ev.id, ev.data);
          emit([{ type, doc: snapDoc(ev.id, ev.data) }]);
        }
      };
      if (!colListeners.has(col)) colListeners.set(col, new Set());
      colListeners.get(col).add(onChange);
      load();
      return () => { alive = false; colListeners.get(col)?.delete(onChange); };
    },
    where() { return this; },
    orderBy() { return this; },
    limit() { return this; },
  };
}

export const db = {
  collection: (path) => collectionRef(path),
  doc: (path) => {
    const i = path.lastIndexOf('/');
    return docRef(path.slice(0, i), path.slice(i + 1));
  },
};

export const downloads = {
  async save({ filename, data }) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    return { status: 'saved' };
  },
};
