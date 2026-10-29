import { useEffect } from 'react';
import { startPlan } from './engine/plan.js';

const TABS = [
  ['resumen', 'Resumen'],
  ['programas', 'Programas y asignaturas'],
  ['cronograma', 'Cronograma'],
  ['inicios', 'Inicio de clases'],
  ['tronco', 'Tronco común'],
  ['ocultos', 'Ocultos'],
];

/*
 * Estructura fija de la plataforma. El contenido de cada vista lo dibuja el
 * motor (src/engine/plan.js) dentro de #main, #bulk-root, #modal-root y #toast-root,
 * así que React no vuelve a renderizar esos contenedores.
 */
export default function App() {
  useEffect(() => {
    startPlan();
  }, []);

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
        </div>
      </header>
      <div className="wrap">
        <main id="main" dangerouslySetInnerHTML={{ __html: '<div class="notice">Cargando programas y asignaturas…</div>' }} />
      </div>
      <div id="bulk-root" />
      <div id="modal-root" />
      <div id="toast-root" />
    </>
  );
}
