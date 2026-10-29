import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En desarrollo, Vite (puerto 5173) reenvía /api y /hubs a la API .NET (puerto 5080).
// En producción, `npm run build` deja la app compilada dentro de wwwroot de la API,
// así un solo servidor .NET sirve la plataforma y los datos.
// VITE_BASE indica la subruta pública (p. ej. /plan-virtualizacion/); por defecto la raíz.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5080',
      '/hubs': { target: 'http://localhost:5080', ws: true },
    },
  },
  build: {
    outDir: '../backend/PlanVirtualizacion.Api/wwwroot',
    emptyOutDir: true,
    sourcemap: false,
  },
});
