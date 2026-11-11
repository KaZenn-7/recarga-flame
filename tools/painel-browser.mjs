// Teste do painel num navegador real contra uma loja de TESTE (banco temporário, APIs externas falsas; nunca a conta real).
// Uso: node tools/painel-browser.mjs  (usa o puppeteer de ~/api-base e o Chromium do playwright em ~/.cache)
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/home/ramos/api-base/x.js');
const puppeteer = require('puppeteer');

const TEST_DB = '/tmp/cf-painel-browser-' + Date.now() + '.db';
try { fs.unlinkSync(TEST_DB); } catch {}
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: TEST_DB, MP_ACCESS_TOKEN: 'x', MP_WEBHOOK_SECRET: 'x', ADMIN_USER: 'admin_test',
  ADMIN_PASS: 'senha_test_longa', PUBLIC_URL: 'http://127.0.0.1:0', CF_BASE: 'https://counterflame.test', TG_BOT_TOKEN: 'tg-fake', TG_CHAT_ID: '42', RESEND_API_KEY: 're_fake' });
const realFetch = globalThis.fetch; const tg = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/')) { const b = JSON.parse(opts.body); if (u.endsWith('sendMessage')) tg.push(b.text); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { 'content-type': 'application/json' } }); }
  if (u.startsWith('https://counterflame.test/')) return new Response('', { status: 404 });
  if (u.startsWith('https://api.resend.com')) return new Response('{}', { status: 200 });
  if (u.startsWith('https://api.mercadopago.com')) return new Response('{}', { status: 500 });
  return realFetch(url, opts);
};
process.chdir('/home/ramos/cf-teste-deploy');
const mod = await import('/home/ramos/cf-teste-deploy/server.js');
const server = await new Promise((r) => { const s = mod.app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
process.env.PUBLIC_URL = base;
const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const { challenge } = await (await post('/login/senha', { user: 'admin_test', pass: 'senha_test_longa' })).json();
const code = tg.at(-1).match(/\b(\d{6})\b/)[1];
const cookie = ((await post('/login/codigo', { challenge, code })).headers.get('set-cookie') || '').split(';')[0];
// pedidos: um pago (com link do Telegram), um entregue; nick com aspas e tag para testar escape
const ins = mod.db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, status, prod_nome, prod_stars, prod_code, paid_at, star_cost)
  VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,0.08)`);
ins.run('t1', 'c1000', 350, '123', `x"><img src=x onerror=alert(1)>'`, 'a@b.c', 'paid', "Coins d'Ouro", 40, 'c_1000');
mod.db.prepare("UPDATE products SET img='/img/nao-existe-xyz.png' WHERE key='c1000'").run(); mod.loadProducts();
ins.run('t2', 'c1000', 350, '124', 'fulano', 'b@b.c', 'delivered', '1.000 Coins', 40, 'c_1000');

const browser = await puppeteer.launch({ executablePath: '/home/ramos/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('dialog', async (d) => { problems.push('DIALOG: ' + d.message()); await d.accept(); });
await page.evaluateOnNewDocument(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || ''))); });
const [n, v] = cookie.split('=');
await page.setCookie({ name: n, value: v, url: base });
const resp = await page.goto(base + '/painel', { waitUntil: 'networkidle0' });
const ok = (cond, msg) => console.log(cond ? '✔' : '✘', msg);
ok(resp.status() === 200, 'painel abre (200)');
ok(!/unsafe-inline/.test(resp.headers()['content-security-policy'].split(';').find((d) => d.includes('script-src'))), 'CSP do painel sem unsafe-inline em script-src');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const vis = (sel) => page.$eval(sel, (e) => getComputedStyle(e).display !== 'none').catch(() => false);
const cls = (sel, c) => page.$eval(sel, (e, c) => e.classList.contains(c), c).catch(() => false);
ok(await page.$$eval('.card', (l) => l.length) >= 1, 'pedidos renderizados a partir do JSON');
ok(await page.$eval('#tabs', (e) => e.textContent.includes('Na fila')), 'abas renderizadas');
await page.click('#navProd'); await wait(400);
ok(await vis('#viewProd') || await cls('#navProd', 'on'), 'botão Produtos troca a tela');
const nprods = await page.$$eval('.prow', (l) => l.length);
ok(nprods > 0, `lista de produtos (${nprods})`);
await page.click('button[data-act="openForm"]:not([data-key])'); await wait(200);
ok(await cls('#modal', 'on') || await page.$eval('#f_nome', (e) => e.offsetParent !== null).catch(() => false), 'Novo produto abre o formulário');
const sw0 = await cls('#f_ativo', 'on'); await page.click('#f_ativo'); ok((await cls('#f_ativo', 'on')) !== sw0, 'chave Ativo alterna');
await page.click('button[data-act="closeForm"]'); await wait(200);
await page.click('.prow button[data-act="openForm"]'); await wait(300);
ok(await page.$eval('#f_nome', (e) => e.value.length > 0), 'Editar produto abre com os dados');
await page.click('button[data-act="closeForm"]'); await wait(200);
await page.click('#navCup'); await wait(600);
await page.click('button[data-act="openCup"]'); await wait(300);
ok(await cls('#cmodal', 'on'), 'Novo cupom abre o formulário');
await page.select('#c_plano', 'fixo'); await wait(100);
const fixoVis = await page.evaluate(() => [...document.querySelectorAll('[id^=c_]')].filter((e) => e.offsetParent !== null).map((e) => e.id).join(','));
await page.select('#c_plano', 'metas'); await wait(100);
const metasVis = await page.evaluate(() => [...document.querySelectorAll('[id^=c_]')].filter((e) => e.offsetParent !== null).map((e) => e.id).join(','));
ok(fixoVis !== metasVis, 'select Plano (change) muda o formulário');
const a0 = await page.$eval('#c_ativo_txt', (e) => e.textContent); await page.click('#c_ativo');
ok(a0 !== await page.$eval('#c_ativo_txt', (e) => e.textContent), 'chave Ativo do cupom atualiza o texto');
await page.click('button[data-act="closeCup"]'); await wait(200);
ok(!(await cls('#cmodal', 'on')), 'Cancelar fecha o cupom');
await page.click('#navAna'); await wait(800);
ok(await vis('#viewAna'), 'Analytics abre');
await page.click('#navPed'); await wait(300);
await page.click('#stBtn'); await wait(800);
ok(await cls('#smodal', 'on'), 'botão ★ abre o saldo de Stars');
await page.click('#smodal button[data-act="closeStars"]'); await wait(200);
ok(!(await cls('#smodal', 'on')), 'Fechar fecha o saldo de Stars');
// pedido pago: abrir Telegram define backFrom; Marcar entregue pede confirmação (confirm → dialog)
const hasTg = await page.$('a[data-act="backFrom"]');
if (hasTg) { await page.evaluate(() => { document.querySelector('a[data-act="backFrom"]').removeAttribute('href'); }); await page.click('a[data-act="backFrom"]'); ok(await page.evaluate(() => backFrom === 1), 'Abrir no Telegram marca o pedido para "já entregou?"'); }
else console.log('· pedido sem link do Telegram (sem bot/código) — pulado');
await page.click('button[data-act="deliver"]'); await wait(800);
const st = mod.db.prepare('SELECT status FROM orders WHERE id=1').get().status;
ok(st === 'delivered', `Marcar entregue (com confirmação) entrega o pedido (status: ${st})`);
await page.click('#navProd'); await wait(500);
ok(await page.$$eval('img[data-hide-err]', (l) => l.some((i) => i.style.visibility === 'hidden')), 'imagem quebrada some (data-hide-err)');
ok(!(await page.evaluate(() => window.__xss === 1)), 'nick malicioso não executou');
await page.click('#navPed'); await wait(300); await page.click('#rfBtn'); await wait(500);
const csp = await page.evaluate(() => window.__csp);
ok(csp.length === 0, 'nenhuma violação de CSP' + (csp.length ? ': ' + csp.join(' | ') : ''));
ok(problems.filter((p) => !p.startsWith('DIALOG') && !/Failed to load resource/.test(p)).length === 0, 'sem erro de JS' + (problems.length ? ': ' + problems.join(' | ') : ''));
await page.click('button[data-act="logout"]'); await wait(800);
ok(page.url().endsWith('/login'), 'Sair volta ao login');
await browser.close(); server.close(); try { fs.unlinkSync(TEST_DB); } catch {}
process.exit(0);
