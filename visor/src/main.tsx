import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { Junior } from './panels/Junior';
import './index.css';

// PWA Junior mode: en /junior se monta SOLO el módulo Junior (sin sidebar,
// captura, etc.) — pensado para móvil/PWA. Mismo Supabase, mismo endpoint
// /api/junior-v2 → cualquier cosa que hagas acá se ve en el Visor desktop.
const esJuniorPwa = window.location.pathname.startsWith('/junior');

// Registrar service worker para PWA installable (solo en /junior).
if (esJuniorPwa && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err =>
      console.warn('[PWA] sw register failed:', err));
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {esJuniorPwa ? <Junior /> : <App />}
  </React.StrictMode>,
);
