#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
mkdirSync('C:\\Proyectos\\Visor_PG\\_vistas_globales_shots', { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const v = await fetch('http://localhost:9222/json/version').then(r => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: v.webSocketDebuggerUrl, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
await page.bringToFront();
await page.goto('http://localhost:5173', { waitUntil: 'networkidle2', timeout: 30000 });
await page.evaluate(() => { try { sessionStorage.clear(); } catch {} });
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1500);

// Click Vistas globales
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('Vistas globales'));
  if (b) b.click();
});
await sleep(1500);
await page.screenshot({ path: 'C:\\Proyectos\\Visor_PG\\_vistas_globales_shots\\01_vistas_globales_agenda.png' });
console.log('📸 01_vistas_globales_agenda.png');

// Click M3 Financieros para mostrar que ya solo tiene 4 sub-tabs per-cliente
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '3 · Financieros');
  if (b) b.click();
});
await sleep(1000);
await page.screenshot({ path: 'C:\\Proyectos\\Visor_PG\\_vistas_globales_shots\\02_m3_sin_cartera.png' });
console.log('📸 02_m3_sin_cartera.png');

await page.close();
await browser.disconnect();
