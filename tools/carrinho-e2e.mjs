// Carrinho de ponta a ponta num navegador real, contra a loja de TESTE: banco temporário; Mercado Pago, jogo,
// Telegram e Resend falsos (os mesmos de test/helpers.js); bot do CounterFlame trocado por funções de teste.
// Nunca usa a conta real nem o banco de produção.
// Cobre: montar o carrinho na tela (+, adicionar, regras) → Pix único → pagamento → entrega automática →
// avisos no Telegram com "🛒 Carrinho #X · n/N" → um e-mail só; REVISAR aprovado pelo Telegram; entrega parcial
// com reembolso; Pix vencido + "Gerar novo Pix"; pedido de 1 item segue avulso.
// Uso: npm run test:e2e   (puppeteer de ~/api-base e o Chromium do playwright em ~/.cache; sem eles, pula)
import fs from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = new URL('..', import.meta.url).pathname;
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
let puppeteer;
try { puppeteer = createRequire(`${process.env.HOME}/api-base/x.js`)('puppeteer'); } catch { /* sem puppeteer */ }
if (!puppeteer || !fs.existsSync(CHROME)) { console.log('pulado: puppeteer ou Chromium não encontrados'); process.exit(0); }

process.chdir(ROOT);
const H = await import(ROOT + 'test/helpers.js');            // env de teste + fetch falso (MP, jogo, Telegram, Resend)
const DB = `/tmp/cf-carrinho-e2e-${process.pid}.db`;
process.env.DB_PATH = DB; process.env.TG_TOPICS_FILE = DB + '.topicos.json';
const mod = await import(ROOT + 'server.js');
const db = mod.db;
const server = await new Promise((r) => { const s = mod.app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
process.env.PUBLIC_URL = BASE;

// login do painel (código chega pelo Telegram falso)
const post = (u, b, h = {}) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });
const { challenge } = await (await post('/login/senha', { user: 'admin_test', pass: 'senha_test_longa' })).json();
const cookie = ((await post('/login/codigo', { challenge, code: H.lastCode() })).headers.get('set-cookie') || '').split(';')[0];
const adm = (method, u, b) => fetch(BASE + u, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-painel': '1' }, body: b && JSON.stringify(b) });

// bot do CounterFlame falso: fatura com as Stars do produto e o nick da conta; pagamento sempre aceito
const starsDo = (code) => db.prepare('SELECT stars FROM products WHERE code=?').get(code).stars;
const codeDe = (sp) => sp.slice(2, sp.lastIndexOf('_'));
const pays = [];
mod._setInvoiceChecker(async (sp) => ({ currency: 'XTR', stars: starsDo(codeDe(sp)), account: 'jogador_teste', produto: codeDe(sp), msgId: 1 }));
mod._setInvoicePayer(async (a) => { pays.push(a.startParam); return { stars: a.expectStars, account: a.expectAccount, produto: '', botReply: 'ok' }; });
await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 50000 });
await adm('POST', '/api/admin/autopay/limites', { max: 1000, dia: 100000 });

let falhas = 0;
const ok = (c, m) => { if (c) console.log('✔', m); else { falhas++; console.log('✘ FALHOU:', m); } };
const itensDB = (cid) => db.prepare('SELECT * FROM orders WHERE carrinho_id=? ORDER BY id').all(cid);
const ultimoCar = () => db.prepare('SELECT * FROM carrinhos ORDER BY id DESC LIMIT 1').get();
const mailsPara = (email, n0) => H.mailSent.slice(n0).filter((m) => m.to.includes(email));
let gid = 810000;

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const erros = [];
async function novaPagina() {
  const ctx = await browser.createIncognitoBrowserContext();   // localStorage limpo em cada cenário
  const page = await ctx.newPage();
  await page.setViewport({ width: 400, height: 860 });
  // navegador de celular comum (a loja descarta eventos do funil vindos de robôs/headless)
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36');
  page.on('pageerror', (e) => erros.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  return page;
}
// clique no próprio elemento (a página rola com animação ao trocar de etapa: clique por coordenada erra o alvo)
const clk = (page, sel) => page.$eval(sel, (e) => e.click());
const vis = (page, id) => page.$eval('#' + id, (e) => !e.classList.contains('hide'));
const txt = (page, sel) => page.$eval(sel, (e) => e.textContent);
const esperarTela = (page, n) => page.waitForFunction((i) => !document.getElementById('e' + i).classList.contains('hide'), { timeout: 8000 }, n);
// acompanha o pedido como a página faz sozinha (a cada 8 s), só que mais rápido
async function acompanhar(page, cond, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    await page.evaluate(() => checkOnce(false));
    if (await page.evaluate(cond)) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}
const heroE = (t) => new Function(`return /${t}/.test(document.getElementById('heroT').textContent)`);

// monta o pedido na tela: passos = ['c1000', '+c1000', 'gold' (adicionar pelo catálogo)]
async function montar(page, id, passos) {
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await page.type('#gameId', id);
  await clk(page, '#buscar'); await esperarTela(page, 2);
  await page.waitForSelector('#cat .prod');
  for (const [i, p] of passos.entries()) {
    if (p.startsWith('+')) { await clk(page, `#ritens .qty button[data-k="${p.slice(1)}"][data-d="1"]`); continue; }
    if (i) { await clk(page, '#addItem'); await esperarTela(page, 2); }
    await clk(page, `#cat .prod[data-k="${p}"]`); await esperarTela(page, 3);
  }
}
async function gerarPix(page, email) {
  await page.$eval('#email', (e, v) => { e.value = v; }, email);
  await clk(page, '#pagar'); await esperarTela(page, 4);
}

try {
  // ---------- 1. carrinho com entrega automática ----------
  {
    console.log('\n1. Carrinho pago e entregue automaticamente');
    await adm('POST', '/api/admin/autopay', { mode: 2 });
    H.mock.approve = false;
    const page = await novaPagina(), id = String(++gid), email = `e2e${gid}@gmail.com`;
    await montar(page, id, ['c1000', '+c1000', 'gold']);
    ok((await page.$$('#ritens .line')).length === 2 && await txt(page, '#ritens .qty b') === '2', 'tela: 1.000 Coins ×2 numa linha + Gold Pass');
    // Gold repetido é barrado
    await clk(page, '#addItem'); await esperarTela(page, 2);
    await clk(page, '#cat .prod[data-k="gold"]');
    ok(/só pode ser comprado uma vez/.test(await txt(page, '#err2')), 'tela: Gold repetido é barrado');
    await clk(page, '#voltar2'); await esperarTela(page, 3);
    const total = 2 * db.prepare("SELECT cents FROM products WHERE key='c1000'").get().cents + db.prepare("SELECT cents FROM products WHERE key='gold'").get().cents;
    const n0 = H.mailSent.length, t0 = H.tgSent.length, p0 = pays.length;
    await gerarPix(page, email);
    const car = ultimoCar();
    ok(H.mock.lastBody.transaction_amount === total / 100 && H.mock.lastBody.external_reference === car.token, `Pix único de R$ ${(total / 100).toFixed(2)} com a referência do carrinho`);
    ok(/^#\d+, #\d+, #\d+$/.test(await txt(page, '#onum')), 'tela do Pix com os nº dos pedidos: ' + await txt(page, '#onum'));
    H.mock.approve = true;                                  // cliente pagou
    ok(await acompanhar(page, heroE('Entregue')), 'página chega a "Entregue!" sozinha');
    ok((await txt(page, '#rsLista')).match(/✓ Entregue/g)?.length === 3, 'lista: os 3 itens entregues');
    ok(pays.length - p0 === 3, 'bot do CF: 3 pagamentos, um por item');
    const its = itensDB(car.id);
    ok(its.every((o) => o.status === 'delivered' && o.entrega_via === 'auto'), 'banco: 3 itens entregues automaticamente');
    const avisos = H.tgSent.slice(t0).filter((m) => /Pedido pago/.test(m.text));
    ok(its.every((o, i) => avisos.some((m) => m.text.includes(`#${o.id}`) && m.text.includes(`🛒 Carrinho #${car.id} · ${i + 1}/3`))), 'Telegram: aviso de cada item com 🛒 n/3');
    await new Promise((r) => setTimeout(r, 200));
    const ms = mailsPara(email, n0);
    ok(ms.length === 1 && /^Pedidos #\d+, #\d+, #\d+ entregues — 1\.000 Coins ×2, Gold Pass$/.test(ms[0].subject), 'e-mail: um só — ' + (ms[0]?.subject || 'nenhum'));
    ok(db.prepare("SELECT 1 FROM events WHERE ev='cart'").get(), 'funil: evento "montou carrinho" registrado');
    await page.browserContext().close();
  }

  // ---------- 2. REVISAR aprovado pelo Telegram ----------
  {
    console.log('\n2. Carrinho em REVISAR aprovado pelo Telegram');
    const antes = mod.RISK.review;
    mod.RISK.review = 1;                                    // qualquer valor cai em revisão
    H.mock.approve = false;
    const page = await novaPagina(), id = String(++gid), email = `e2e${gid}@gmail.com`;
    await montar(page, id, ['c1000', 'c3000']);
    await gerarPix(page, email);
    const car = ultimoCar(), p0 = pays.length;
    H.mock.approve = true;
    ok(await acompanhar(page, heroE('nossa equipe')), 'página: "Entrega pela nossa equipe" (não paga sozinho)');
    ok(pays.length === p0, 'nada pago antes da aprovação');
    const [o1] = itensDB(car.id);
    const toque = (data) => mod.handleTgUpdate({ update_id: 1, callback_query: { id: 'q' + data, data, from: { id: 42 },
      message: { message_id: o1.tg_msg, chat: { id: 42 } } } });
    await toque('c:' + o1.id);
    ok(pays.length === p0, '1º toque em "Aprovar carrinho" só pede confirmação');
    await toque('C:' + o1.id);
    ok(pays.length - p0 === 2, 'confirmado: paga os 2 itens');
    ok(await acompanhar(page, heroE('Entregue')), 'página chega a "Entregue!"');
    ok(itensDB(car.id).every((o) => o.entrega_via === 'aprovado'), 'banco: entregues como "aprovado"');
    mod.RISK.review = antes;
    await page.browserContext().close();
  }

  // ---------- 3. entrega parcial com reembolso ----------
  {
    console.log('\n3. Entrega parcial: um item entregue, outro reembolsado');
    await adm('POST', '/api/admin/autopay', { mode: 0 });
    H.mock.approve = false;
    const page = await novaPagina(), id = String(++gid), email = `e2e${gid}@gmail.com`;
    await montar(page, id, ['c1000', 'c3000']);
    await gerarPix(page, email);
    const car = ultimoCar(), n0 = H.mailSent.length, r0 = H.mock.refunds.length;
    H.mock.approve = true;
    ok(await acompanhar(page, heroE('nossa equipe')), 'página: "Entrega pela nossa equipe" (modo manual)');
    const [a, b] = itensDB(car.id);
    await adm('POST', '/painel/' + a.id + '/entregue');
    ok((await adm('POST', `/api/admin/orders/${b.id}/reembolsar`)).status === 200, 'painel: reembolso do 2º item');
    ok(H.mock.refunds.length - r0 === 1 && H.mock.refunds.at(-1).body.amount === b.cents / 100, `Mercado Pago: devolução parcial de R$ ${(b.cents / 100).toFixed(2)}`);
    ok(await acompanhar(page, heroE('Entrega parcial')), 'página: "Entrega parcial"');
    const lista = await txt(page, '#rsLista');
    ok(/✓ Entregue/.test(lista) && /Valor devolvido/.test(lista), 'lista: um entregue, um com valor devolvido');
    await new Promise((r) => setTimeout(r, 200));
    const ms = mailsPara(email, n0);
    ok(ms.length === 1 && /1 de 2 itens entregues$/.test(ms[0].subject), 'e-mail: um só — ' + (ms[0]?.subject || 'nenhum'));
    await page.browserContext().close();
  }

  // ---------- 4. Pix vencido e "Gerar novo Pix" ----------
  {
    console.log('\n4. Pix do carrinho vence e o cliente gera outro');
    H.mock.approve = false;
    const page = await novaPagina(), id = String(++gid), email = `e2e${gid}@gmail.com`;
    await montar(page, id, ['c1000', '+c1000', 'bp1']);
    await gerarPix(page, email);
    const car = ultimoCar(), n0 = H.mailSent.length;
    db.prepare('UPDATE orders SET expires_at=? WHERE carrinho_id=?').run(Date.now() - 10 * 60_000, car.id);
    await mod.expirePending();
    ok(itensDB(car.id).every((o) => o.status === 'cancelled'), 'banco: itens cancelados ao vencer');
    ok(mailsPara(email, n0).filter((m) => /^Seu Pix expirou — pedidos /.test(m.subject)).length === 1, 'e-mail: "Seu Pix expirou" um só');
    await page.evaluate(() => checkOnce(true));
    ok(await vis(page, 'novoPix'), 'página: botão "Gerar novo Pix"');
    await clk(page, '#novoPix'); await esperarTela(page, 3);
    ok(await txt(page, '#ritens .qty b') === '2' && (await page.$$('#ritens .line')).length === 2, 'volta para a confirmação com os mesmos itens');
    await clk(page, '#pagar'); await esperarTela(page, 4);
    const novo = ultimoCar();
    ok(novo.id !== car.id && itensDB(novo.id).map((o) => o.product).join() === 'c1000,c1000,bp1', 'novo Pix: carrinho novo com os mesmos 3 itens');
    await page.browserContext().close();
  }

  // ---------- 5. um item só continua pedido avulso ----------
  {
    console.log('\n5. Pedido de 1 item');
    await adm('POST', '/api/admin/autopay', { mode: 2 });
    H.mock.approve = false;
    const page = await novaPagina(), id = String(++gid), email = `e2e${gid}@gmail.com`;
    const c0 = ultimoCar().id, n0 = H.mailSent.length;
    await montar(page, id, ['c3000']);
    await gerarPix(page, email);
    ok(ultimoCar().id === c0 && /^#pedido=/.test(await page.evaluate(() => location.hash)), 'sem carrinho: pedido avulso (#pedido=)');
    H.mock.approve = true;
    ok(await acompanhar(page, heroE('Entregue')), 'página chega a "Entregue!"');
    await new Promise((r) => setTimeout(r, 200));
    const ms = mailsPara(email, n0);
    ok(ms.length === 1 && /^Pedido #\d+ entregue — 3\.000 Coins$/.test(ms[0].subject), 'e-mail de pedido avulso, como antes');
    await page.browserContext().close();
  }
  ok(!erros.length, 'nenhum erro de JavaScript nas páginas' + (erros.length ? ': ' + erros.join(' | ') : ''));
} catch (e) {
  falhas++; console.log('✘ ERRO:', e.stack || e);
} finally {
  await browser.close(); server.close();
  for (const f of [DB, DB + '-wal', DB + '-shm', DB + '.topicos.json']) fs.rmSync(f, { force: true });
}
console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
process.exit(falhas ? 1 : 0);
