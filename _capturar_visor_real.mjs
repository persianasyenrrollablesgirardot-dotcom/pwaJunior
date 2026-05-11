#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
mkdirSync('C:\\Proyectos\\Visor_PG\\_real_shots', { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const v = await fetch('http://localhost:9222/json/version').then(r => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: v.webSocketDebuggerUrl, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
await page.bringToFront();
await page.goto('http://localhost:5173', { waitUntil: 'networkidle2', timeout: 30000 });
await page.evaluate(() => { try { sessionStorage.clear(); } catch {} });
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1200);

async function click(text) {
  await page.evaluate(t => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === t);
    if (b) b.click();
  }, text);
  await sleep(800);
}
async function shot(name) {
  await page.screenshot({ path: `C:\\Proyectos\\Visor_PG\\_real_shots\\${name}.png`, fullPage: false });
  console.log('📸 ' + name + '.png');
}

await click('Clientes'); await sleep(1500); await shot('01_clientes_lista');

// Filtrar por [REAL-CAPTURA]
await page.evaluate(() => {
  const s = [...document.querySelectorAll('input')].find(i => i.type === 'search');
  if (s) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, 'REAL-CAPTURA');
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await sleep(800);
await shot('02_clientes_filtrados');

// Click en Sr Manuel
await page.evaluate(() => {
  const card = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Sr Manuel'));
  if (card) card.click();
});
await sleep(1500);
await shot('03_manuel_m1_identidad');

// Click en M2 Comerciales
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '2 · Comerciales');
  if (b) b.click();
});
await sleep(1000);
await shot('04_manuel_m2_cotizaciones');

// Click en M3 Financieros
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '3 · Financieros');
  if (b) b.click();
});
await sleep(1000);
await shot('05_manuel_m3_facturacion');

await page.close();
await browser.disconnect();
console.log('\n✓ 5 capturas en C:\\Proyectos\\Visor_PG\\_real_shots\\');
