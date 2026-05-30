import React from 'react';
import ReactDOM from 'react-dom/client';
import { Junior } from './panels/Junior';
import './index.css';

// PWA Junior — esta app es 100% Junior, no hay otra vista. Cualquier ruta
// monta el módulo Junior con sus 4 tabs. Mismo Supabase que el Visor desktop
// → todo lo que hagas acá se sincroniza al instante.

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err =>
      console.warn('[PWA] sw register failed:', err));
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Junior />
  </React.StrictMode>,
);
