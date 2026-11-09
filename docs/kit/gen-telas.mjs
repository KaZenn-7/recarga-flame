// Captura telas REAIS da loja (public/index.html) no celular, com dados de DEMONSTRAÇÃO, para o vídeo de divulgação.
// Sobe um servidor local só com a página e uma API falsa (nada vai ao Mercado Pago, ao jogo ou ao Telegram;
// o catálogo vem do loja.db aberto só para leitura) e controla o Chromium headless pelo DevTools Protocol.
// Uso: node docs/kit/gen-telas.mjs [pasta]   (padrão: docs/kit/telas)
// Saída: 1-id.png, 2-catalogo.png, 3-confirmar.png, 4-pix.png, 5-entregue.png (400×860 @2x)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.resolve(process.argv[2] || path.join(HERE, 'telas'));
const require = createRequire(path.join(ROOT, 'package.json'));
const express = require('express');
const QRCode = require(path.join(HERE, 'node_modules', 'qrcode'));
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`;
fs.mkdirSync(OUT, { recursive: true });

// ---- dados de demonstração ----
const db = require('better-sqlite3')(path.join(ROOT, 'loja.db'), { readonly: true, fileMustExist: true });
const prods = db.prepare('SELECT * FROM products WHERE ativo=1 ORDER BY sort, rowid').all();
db.close();
// mesma regra do categoria() do server.js
const cat = (p) => (p.tipo === 'wildfire' ? 'Coleções' : p.tipo === 'arsenal' || p.tipo === 'gold' ? 'Passes' : p.niveis ? 'Níveis de Passe' : 'Coins');
const DEMO = { id: '51234567', nick: 'Jogador_Demo' };
// QR de demonstração: NÃO é um Pix (aponta para o site)
const qrB64 = (await QRCode.toDataURL('https://recargaflame.com.br', { margin: 2, width: 400 })).split(',')[1];
let estado = 'pending';

const app = express();
app.use(express.json());
app.get('/api/products', (req, res) => res.json(prods.map((p) => ({ key: p.key, nome: p.nome, cents: p.cents, stars: p.stars, cat: cat(p), img: p.img || `/img/${p.key}.jpg` }))));
app.get('/api/coupon/:code', (req, res) => res.status(404).json({ error: 'Cupom inválido ou expirado.' }));
app.get('/api/player/:id/avatar', (req, res) => res.type('svg').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2a1a12"/><circle cx="32" cy="25" r="11" fill="#ff5a1f"/><path d="M12 56c2-11 10-17 20-17s18 6 20 17" fill="#ff5a1f"/></svg>'));
app.get('/api/player/:id', (req, res) => res.json({ nickname: DEMO.nick, avatar: `/api/player/${DEMO.id}/avatar`, blocked: {} }));
app.post('/api/orders', (req, res) => {
  const p = prods.find((x) => x.key === req.body.product) || prods[0];
  res.json({ token: 'demo-token-video-0000000000000000000000', id: 128, expiresAt: Date.now() + 30 * 60000, cents: p.cents, coupon: null, qr: '00020126580014br.gov.bcb.pix0136demo-recargaflame-video', qrBase64: qrB64 });
});
app.get('/api/orders/:token', (req, res) => res.json({ status: estado, entrega: 'auto' }));
app.post('/api/ev', (req, res) => res.sendStatus(204));
app.use(express.static(path.join(ROOT, 'public')));
const srv = http.createServer(app).listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

// ---- Chromium + DevTools Protocol (WebSocket nativo do Node) ----
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-telas-'));
const chrome = spawn(CHROME, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${prof}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((ok, bad) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\S+)/); if (m) ok(m[1]); });
  setTimeout(() => bad(new Error('chrome não abriu')), 15000);
});
const port = new URL(wsUrl).port;
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((ok, bad) => { const id = ++seq; pend.set(id, (m) => (m.error ? bad(new Error(method + ': ' + m.error.message)) : ok(m.result))); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (expr, ms = 8000) => { const t = Date.now(); while (!(await js(expr))) { if (Date.now() - t > ms) throw new Error('timeout: ' + expr); await wait(100); } };
const shot = async (name) => {
  await wait(500);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
  console.log('ok', path.join(OUT, name));
};

try {
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 2, mobile: true });
  await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36' });
  await cdp('Page.navigate', { url: BASE + '/' });
  await until("document.readyState==='complete' && !!document.getElementById('gameId')");
  await js("localStorage.clear()");
  await cdp('Page.navigate', { url: BASE + '/' });
  await until("document.readyState==='complete' && !!document.getElementById('gameId')");
  // 1. digita o ID
  await js(`(()=>{const i=document.getElementById('gameId');i.value='${DEMO.id}';i.dispatchEvent(new Event('input'));})()`);
  await shot('1-id.png');
  // 2. busca a conta → catálogo
  await js("document.getElementById('buscar').click()");
  await until("!document.getElementById('e2').classList.contains('hide') && document.querySelectorAll('#cat *').length>5");
  await wait(800); // imagens
  await shot('2-catalogo.png');
  // 3. escolhe o Gold Pass e preenche o e-mail
  const clicou = await js(`(()=>{const el=document.querySelector('#cat .prod[data-k="gold"]');if(!el)return false;el.click();return true;})()`);
  if (!clicou) throw new Error('não achei o Gold Pass no catálogo');
  await until("!document.getElementById('e3').classList.contains('hide')");
  await js("(()=>{const e=document.getElementById('email');e.value='voce@gmail.com';e.dispatchEvent(new Event('input'));})()");
  await shot('3-confirmar.png');
  // 4. gera o "Pix" (falso)
  await js("document.getElementById('pagar').click()");
  await until("!document.getElementById('e4').classList.contains('hide')");
  await shot('4-pix.png');
  // 5. pagamento confirmado → entregue
  estado = 'delivered';
  await js("typeof checkOnce==='function' ? checkOnce(false) : null");
  await until("/Entregue/.test(document.getElementById('e4').textContent)", 15000);
  await js('scrollTo(0,0)');
  await shot('5-entregue.png');
} finally {
  ws.close(); chrome.kill(); srv.close();
  fs.rmSync(prof, { recursive: true, force: true });
}
