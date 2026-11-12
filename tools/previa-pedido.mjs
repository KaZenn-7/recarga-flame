// Prévia da tela do pedido (index.html do disco, não o que está no ar) com um pedido FALSO em um status.
//   node tools/previa-pedido.mjs <saida.png> [status=paid] [entrega=auto|manual]
// Usa a loja local só para produtos/imagens; o pedido é simulado (nada é criado no banco).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/home/ramos/api-base/x.js'); // puppeteer de ~/api-base
const puppeteer = require('puppeteer');
const [out = 'previa-pedido.png', status = 'paid', entrega = null] = process.argv.slice(2); // entrega: auto | manual (só com status paid)
const BASE = 'http://127.0.0.1:3102';
const TK = '00000000-0000-4000-8000-000000000000';
// PREVIA_DIR=<pasta>: serve as páginas dessa pasta no lugar das de public/ (ver uma mudança antes de aplicar)
const DIR = process.env.PREVIA_DIR || new URL('../public', import.meta.url).pathname;
const PAGINA = process.env.PREVIA_PAGINA || ''; // ex.: como-funciona (padrão: tela do pedido)
const html = fs.readFileSync(`${DIR}/index.html`, 'utf8');
const pedido = { status, entrega, id: 1234, product: 'gold', nome: 'Gold Pass', cents: 3690, gameId: '749125', nick: 'Jogador',
  avatar: '/img/brand-mark.png', img: '/img/gold.jpg', expiresAt: Date.now() + 30 * 60_000, qr: null, qrBase64: null };

const browser = await puppeteer.launch({ executablePath: '/home/ramos/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = new URL(r.url());
    const pg = u.pathname.slice(1);
    if (u.origin === BASE && pg && fs.existsSync(`${DIR}/${pg}.html`)) return r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(`${DIR}/${pg}.html`, 'utf8') });
    if (u.origin === BASE && u.pathname === '/') return r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    if (u.pathname.startsWith('/api/orders/')) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(pedido) });
    if (u.pathname.startsWith('/api/track') || u.pathname.startsWith('/api/ev')) return r.respond({ status: 204, body: '' });
    return r.continue();
  });
  await page.goto(PAGINA ? `${BASE}/${PAGINA}` : `${BASE}/#pedido=${TK}`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  const wa = await page.$eval('#supWa', (a) => decodeURIComponent(a.href.split('text=')[1] || '')).catch(() => '(sem botão)');
  await page.screenshot({ path: out, fullPage: !!PAGINA });
  console.log('ok', out, '\nmensagem WhatsApp:\n' + wa);
} finally { await browser.close(); }
