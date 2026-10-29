import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { db, downloads } from './api/db.js';
import './engine/plan.css';

// El motor pide sus servicios a través de window.claude.use(nombre).
window.claude = {
  use: async (name) => (name === 'db' ? db : name === 'downloads' ? downloads : null),
};

createRoot(document.getElementById('root')).render(<App />);
