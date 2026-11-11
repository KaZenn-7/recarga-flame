// Testes do núcleo crítico da loja CounterFlame.
// Runner nativo do Node (node --test), sem dependências novas.
// Roda contra DB temporário e mocka CounterFlame + Mercado Pago.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// --- ambiente de teste: definido ANTES de importar o server ---
const TEST_DB = '/tmp/cf-test-' + Date.now() + '.db';
process.env.NODE_ENV = 'test';
process.env.DB_PATH = TEST_DB;
process.env.MP_ACCESS_TOKEN = 'TEST-token-fake';
process.env.MP_WEBHOOK_SECRET = 'segredo-teste';
process.env.ADMIN_USER = 'admin_test';
process.env.ADMIN_PASS = 'senha_test_longa';
process.env.PUBLIC_URL = 'http://localhost:0';
process.env.CF_BASE = 'https://counterflame.test';
process.env.TG_BOT_TOKEN = 'tg-fake';
process.env.TG_CHAT_ID = '42';
process.env.RESEND_API_KEY = 're_fake';
process.env.MAX_PENDING_PIX = '99'; // testes antigos geram vários Pix p/ o mesmo ID; o teste antifraude reduz

// --- mock de fetch: intercepta só APIs externas; localhost passa direto ---
const realFetch = globalThis.fetch;
let mpShouldApprove = true;      // controla o status devolvido pelo MP
let mpStatus = null;             // força um status na consulta (ex.: 'refunded')
let mpPayer = null;              // dados do pagador devolvidos pelo MP (CPF/conta)
const tgSent = [];               // mensagens enviadas ao Telegram
const mailSent = [];             // e-mails enviados ao Resend
const tgCalls = [];
const avatarCalls = [];               // chamadas ao avatar do CounterFlame              // todas as chamadas à API do bot ({ method, body })
const lastCode = () => (tgSent.at(-1)?.text.match(/\b(\d{6})\b/) || [])[1];
let lastMpBody = null;           // captura o corpo enviado ao MP
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  // Resend (e-mail ao cliente)
  if (u === 'https://api.resend.com/emails') {
    mailSent.push({ auth: opts.headers.Authorization, ...JSON.parse(opts.body) });
    return new Response('{"id":"x"}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Telegram (código de login, notificações)
  if (u.startsWith('https://api.telegram.org/')) {
    const method = u.split('/').pop(), body = JSON.parse(opts.body);
    tgCalls.push({ method, body });
    if (method === 'sendMessage') tgSent.push(body);
    const result = method === 'sendMessage' ? { message_id: 700 + tgCalls.length } : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // avatar do CounterFlame
  if (u.startsWith('https://counterflame.test/') && u.includes('/avatar')) {
    avatarCalls.push(u);
    if (u.includes('/888777/')) return new Response('', { status: 404 }); // conta sem avatar
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  // player do CounterFlame
  if (u.startsWith('https://counterflame.test/api/users/')) {
    if (u.includes('/999999')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({
      success: true,
      data: { nickname: 'jogador_teste', wildfireLevel: 0,
        arsenalPass: { tickets: 0, maxTickets: 5 },
        battlePass: { gold: u.includes('/555555'), level: 0, totalLevels: 50 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // criar pagamento no Mercado Pago
  if (u === 'https://api.mercadopago.com/v1/payments' && opts?.method === 'POST') {
    lastMpBody = JSON.parse(opts.body);
    if (lastMpBody.payer.email.endsWith('.cokc')) {
      return new Response(JSON.stringify({ message: 'payer.email must be a valid email', status: 400, cause: [{ description: 'payer.email must be a valid email' }] }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 123456, status: 'pending',
      point_of_interaction: { transaction_data: { qr_code: 'PIXCODE', qr_code_base64: 'BASE64' } },
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  // cancelar pagamento no MP: só cancela se ainda não foi aprovado
  if (u.startsWith('https://api.mercadopago.com/v1/payments/') && opts?.method === 'PUT') {
    if (mpShouldApprove) {
      return new Response(JSON.stringify({ message: 'Payment already approved' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 123456, status: 'cancelled' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // consultar pagamento no MP (usado por syncPayment)
  if (u.startsWith('https://api.mercadopago.com/v1/payments/')) {
    return new Response(JSON.stringify({
      status: mpStatus ?? (mpShouldApprove ? 'approved' : 'pending'),
      transaction_amount: (lastMpBody?.transaction_amount) ?? 3.5,
      external_reference: lastMpBody?.external_reference,
      ...(mpPayer || {}),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts); // localhost e demais
};

let SRV, app, server, base, adminFails, expirePending, db, remindPending, starsForecast, riskOf, _setRefundCaller, RISK, handleTgUpdate, _setStarsReader, _setInvoiceChecker, conferir, _setInvoicePayer, _setReceiptChecker, dailySummary, summaryTick;
let COOKIE = '';
async function login() {
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() }, body: JSON.stringify(b) });
  const r1 = await post('/login/senha', { user: 'admin_test', pass: 'senha_test_longa' });
  const { challenge } = await r1.json();
  const r2 = await post('/login/codigo', { challenge, code: lastCode() });
  return (r2.headers.get('set-cookie') || '').split(';')[0];
}
// cada chamada ganha um IP único via X-Forwarded-For para não compartilhar baldes de rate-limit
let ipSeq = 0;
// espera uma condição ficar verdadeira (até 3 s) — evita testes que dependem de tempo fixo
const ateQue = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('condição não atingida em ' + ms + ' ms'); await new Promise((r) => setTimeout(r, 10)); } };
const freshIP = () => ({ 'X-Forwarded-For': `10.0.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` });

before(async () => {
  const mod = await import('../server.js?test=' + Date.now());
  SRV = mod; app = mod.app; adminFails = mod.adminFails; expirePending = mod.expirePending; db = mod.db; remindPending = mod.remindPending; starsForecast = mod.starsForecast; riskOf = mod.riskOf; _setRefundCaller = mod._setRefundCaller; RISK = mod.RISK; handleTgUpdate = mod.handleTgUpdate; _setStarsReader = mod._setStarsReader; _setInvoiceChecker = mod._setInvoiceChecker; conferir = mod.conferir; _setInvoicePayer = mod._setInvoicePayer; _setReceiptChecker = mod._setReceiptChecker; dailySummary = mod.dailySummary; summaryTick = mod.summaryTick;
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = base; // para checagens same-origin
  COOKIE = await login();
});

after(() => {
  server?.close();
  try { fs.unlinkSync(TEST_DB); } catch {}
});

// cada teste começa com o rate-limit do admin zerado (evita contaminação entre testes)
beforeEach(() => { adminFails?.clear(); });

// ---------- 1. Preço vem do servidor, não do cliente ----------
test('preço é do servidor: cliente não consegue forjar valor', async () => {
  // produto c1000 custa 350 centavos (seed). Cliente tenta mandar cents=1.
  const r = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'c1000', gameId: '749125', email: 'a@b.com', cents: 1, price: 1 }),
  });
  assert.equal(r.status, 200);
  // o valor enviado ao MP tem que ser 3.50, não 0.01
  assert.equal(lastMpBody.transaction_amount, 3.5);
});

test('pedido devolve número e expiração do Pix (~30 min, coerente com o MP)', async () => {
  const antes = Date.now();
  const r = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'c1000', gameId: '749125', email: 'e@f.com' }),
  });
  const j = await r.json();
  assert.ok(Number.isInteger(j.id) && j.id > 0);
  const min = (j.expiresAt - antes) / 60_000;
  assert.ok(min > 29 && min <= 30.1, `expira em ${min} min`);
  // a data enviada ao MP aponta pro mesmo instante
  assert.ok(Math.abs(new Date(lastMpBody.date_of_expiration).getTime() - j.expiresAt) < 1000);
});

// ---------- 2. Validação de pagamento ----------
test('pedido vira paid só quando aprovado E valor confere', async () => {
  mpShouldApprove = true;
  const create = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'c1000', gameId: '749125', email: 'c@d.com' }),
  });
  const { token } = await create.json();
  const r = await fetch(base + '/api/orders/' + token);
  const { status } = await r.json();
  assert.equal(status, 'paid');
});

test('produto inativo é rejeitado no checkout', async () => {
  const r = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'bp10', gameId: '749125', email: 'a@b.com' }), // bp10 = ativo:0 no seed
  });
  assert.equal(r.status, 400);
});

test('conta inexistente (404 no CF) bloqueia o pedido', async () => {
  const r = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'c1000', gameId: '999999', email: 'a@b.com' }),
  });
  assert.equal(r.status, 404);
});

test('e-mail inválido é rejeitado', async () => {
  const r = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'c1000', gameId: '749125', email: 'naoeemail' }),
  });
  assert.equal(r.status, 400);
});

// ---------- 3. CRUD + validações de produto ----------
test('admin exige autenticação', async () => {
  const r = await fetch(base + '/api/admin/products');
  assert.equal(r.status, 401);
});

test('cria produto com credencial válida', async () => {
  const r = await fetch(base + '/api/admin/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1' },
    body: JSON.stringify({ key: 'novo1', nome: 'Novo', cents: 500, stars: 5, code: 'n_1', ativo: true }),
  });
  assert.equal(r.status, 200);
});

test('rejeita chave inválida', async () => {
  const r = await fetch(base + '/api/admin/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1' },
    body: JSON.stringify({ key: 'IN VÁLIDO!', nome: 'x', cents: 100, code: 'y' }),
  });
  assert.equal(r.status, 400);
});

test('rejeita img maliciosa (javascript:)', async () => {
  const r = await fetch(base + '/api/admin/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1' },
    body: JSON.stringify({ key: 'evil1', nome: 'x', cents: 100, code: 'y', img: 'javascript:alert(1)' }),
  });
  assert.equal(r.status, 400);
});

test('rejeita preço inválido', async () => {
  const r = await fetch(base + '/api/admin/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1' },
    body: JSON.stringify({ key: 'cheap1', nome: 'x', cents: 0, code: 'y' }),
  });
  assert.equal(r.status, 400);
});

// ---------- 4. Rate limit admin ----------
test('brute-force bloqueia após 20 falhas, mas senha correta sempre passa', async () => {
  const post = (b) => fetch(base + '/login/senha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let got429 = false;
  for (let i = 0; i < 25; i++) {
    const r = await post({ user: 'admin_test', pass: 'ERRADA' });
    if (r.status === 429) got429 = true;
  }
  assert.ok(got429, 'esperava 429 após várias falhas');
  const ok = await post({ user: 'admin_test', pass: 'senha_test_longa' }); // mesmo IP
  assert.equal(ok.status, 200, 'senha correta não pode ser bloqueada junto');
  adminFails.clear();
});

// ---------- 5. Snapshot do pedido sobrevive a exclusão do produto ----------
test('excluir produto não quebra pedido já feito (snapshot)', async () => {
  // cria produto, faz pedido, exclui produto, painel ainda mostra o nome
  await fetch(base + '/api/admin/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1' },
    body: JSON.stringify({ key: 'snap1', nome: 'Produto Snapshot', cents: 700, stars: 9, code: 's_1', ativo: true }),
  });
  const create = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'snap1', gameId: '749125', email: 's@s.com' }),
  });
  assert.equal(create.status, 200);
  const del = await fetch(base + '/api/admin/products/snap1', { method: 'DELETE', headers: { Cookie: COOKIE, 'x-painel': '1' } });
  assert.equal(del.status, 200);
  // painel carrega sem erro e contém o nome do snapshot
  const painel = await fetch(base + '/painel', { headers: { Cookie: COOKIE } });
  assert.equal(painel.status, 200);
  const html = await painel.text();
  assert.ok(html.includes('Produto Snapshot'), 'nome do snapshot deve aparecer no painel');
  assert.ok(html.includes('<script src="/painel/app.js"></script>'));
  const js = await fetch(base + '/painel/app.js', { headers: { Cookie: COOKIE } });
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.ok((await js.text()).includes('function render'));
});

// ---------- 6. Webhook rejeita assinatura inválida ----------
test('webhook do MP rejeita assinatura inválida', async () => {
  const r = await fetch(base + '/webhook/mercadopago?type=payment&data.id=123', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': 'ts=1,v1=assinaturafalsa', 'x-request-id': 'req1' },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 401);
});

// ---------- cancelamento do Pix pelo cliente ----------
test('cliente cancela Pix pendente: cancela no MP e pedido vira cancelled', async () => {
  mpShouldApprove = false;
  const create = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'c1000', gameId: '749125', email: 'g@h.com' }),
  });
  const { token } = await create.json();
  const r = await fetch(base + '/api/orders/' + token + '/cancel', { method: 'POST', headers: freshIP() });
  assert.equal((await r.json()).status, 'cancelled');
  const again = await fetch(base + '/api/orders/' + token);
  assert.equal((await again.json()).status, 'cancelled');
  mpShouldApprove = true;
});

test('cancelar pedido já pago não muda nada (MP recusa, status segue paid)', async () => {
  mpShouldApprove = false;
  const create = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'c1000', gameId: '749125', email: 'i@j.com' }),
  });
  const { token } = await create.json();
  mpShouldApprove = true; // cliente pagou antes de tocar em cancelar
  const r = await fetch(base + '/api/orders/' + token + '/cancel', { method: 'POST', headers: freshIP() });
  assert.equal((await r.json()).status, 'paid');
});

test('cancelar pedido inexistente dá 404', async () => {
  const r = await fetch(base + '/api/orders/nao-existe/cancel', { method: 'POST', headers: freshIP() });
  assert.equal(r.status, 404);
});

// ---------- bloqueio visível + link do pedido ----------
test('player devolve bloqueios por produto (conta com Gold não pode comprar Gold)', async () => {
  const ok = await (await fetch(base + '/api/player/749125', { headers: freshIP() })).json();
  assert.equal(ok.blocked.gold, undefined);
  const gold = await (await fetch(base + '/api/player/555555', { headers: freshIP() })).json();
  assert.match(gold.blocked.gold, /Gold Pass/);
});

test('link do pedido: ?full=1 devolve dados e QR sem expor e-mail', async () => {
  mpShouldApprove = false;
  const create = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'c1000', gameId: '749125', email: 'segredo@cliente.com' }),
  });
  const { token, id } = await create.json();
  const r = await (await fetch(base + '/api/orders/' + token + '?full=1')).json();
  assert.equal(r.id, id); assert.equal(r.status, 'pending'); assert.equal(r.gameId, '749125');
  assert.equal(r.qr, 'PIXCODE'); assert.ok(r.expiresAt > Date.now());
  assert.ok(!JSON.stringify(r).includes('segredo@cliente.com'));
  // sem ?full continua só o status
  assert.deepEqual(Object.keys(await (await fetch(base + '/api/orders/' + token)).json()), ['status', 'entrega']);
  mpShouldApprove = true;
});

// ---------- login com código pelo Telegram ----------
const postJ = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() }, body: JSON.stringify(b) });

test('painel sem sessão redireciona para /login; API dá 401', async () => {
  const r = await fetch(base + '/painel', { redirect: 'manual' });
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/login');
  assert.equal((await fetch(base + '/painel/app.js')).status, 401); // JS do painel só com sessão
  assert.equal((await fetch(base + '/api/admin/products', { headers: { Cookie: 'cf_sess=' + 'x'.repeat(43) } })).status, 401);
});

test('senha correta só não basta: sem o código não há sessão', async () => {
  const r = await postJ('/login/senha', { user: 'admin_test', pass: 'senha_test_longa' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.match(tgSent.at(-1).text, /Código de acesso/);
  assert.equal(tgSent.at(-1).chat_id, '42');
});

test('código é de uso único e trava após 5 erros', async () => {
  const { challenge } = await (await postJ('/login/senha', { user: 'admin_test', pass: 'senha_test_longa' })).json();
  const code = lastCode();
  const ok = await postJ('/login/codigo', { challenge, code });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await postJ('/login/codigo', { challenge, code })).status, 401, 'reuso tem que falhar');
  const c2 = (await (await postJ('/login/senha', { user: 'admin_test', pass: 'senha_test_longa' })).json()).challenge;
  const certo = lastCode();
  const errado = certo === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await postJ('/login/codigo', { challenge: c2, code: errado });
  assert.equal((await postJ('/login/codigo', { challenge: c2, code: certo })).status, 401, 'desafio tem que morrer após 5 erros');
  adminFails.clear();
});

test('sair invalida a sessão', async () => {
  const ck = await login();
  assert.equal((await fetch(base + '/api/admin/products', { headers: { Cookie: ck } })).status, 200);
  await fetch(base + '/logout', { method: 'POST', headers: { Cookie: ck } });
  assert.equal((await fetch(base + '/api/admin/products', { headers: { Cookie: ck } })).status, 401);
});

test('sessão do painel: 30 dias, renova com o uso e tem teto de 90 dias desde o login', async () => {
  const ck = await login();
  const DIA = 86400_000, sid = (await import('node:crypto')).createHash('sha256').update(ck.split('=')[1]).digest('hex');
  const row = () => db.prepare('SELECT created_at, expires_at FROM admin_sessions WHERE id_hash=?').get(sid);
  assert.ok(Math.abs(row().expires_at - Date.now() - 30 * DIA) < 60_000, 'nasce com 30 dias');
  // uso logo após o login: não reescreve a sessão
  const r0 = await fetch(base + '/api/admin/products', { headers: { Cookie: ck, ...freshIP() } });
  assert.equal(r0.status, 200); assert.equal(r0.headers.get('set-cookie'), null);
  // 10 dias depois sem uso: o próximo acesso estica de volta para 30 dias
  db.prepare('UPDATE admin_sessions SET created_at=?, expires_at=? WHERE id_hash=?').run(Date.now() - 10 * DIA, Date.now() + 20 * DIA, sid);
  const r1 = await fetch(base + '/api/admin/products', { headers: { Cookie: ck, ...freshIP() } });
  assert.match(r1.headers.get('set-cookie'), /Max-Age=259\d{4}; Path=\/; HttpOnly; SameSite=Strict/);
  assert.ok(Math.abs(row().expires_at - Date.now() - 30 * DIA) < 60_000);
  // perto do teto: não passa de 90 dias desde o login
  db.prepare('UPDATE admin_sessions SET created_at=?, expires_at=? WHERE id_hash=?').run(Date.now() - 85 * DIA, Date.now() + 2 * DIA, sid);
  await fetch(base + '/api/admin/products', { headers: { Cookie: ck, ...freshIP() } });
  assert.ok(Math.abs(row().expires_at - (row().created_at + 90 * DIA)) < 1000);
  // vencida: 401
  db.prepare('UPDATE admin_sessions SET expires_at=? WHERE id_hash=?').run(Date.now() - 1, sid);
  assert.equal((await fetch(base + '/api/admin/products', { headers: { Cookie: ck, ...freshIP() } })).status, 401);
});

// ---------- notificação de pago + expiração ----------
test('pedido pago avisa o operador no Telegram uma única vez', async () => {
  mpShouldApprove = true;
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'k@l.com' })).json();
  const n = tgSent.length;
  await fetch(base + '/api/orders/' + token); // polling → paid
  await fetch(base + '/api/orders/' + token); // de novo: já é paid, não pode avisar outra vez
  const msgs = tgSent.slice(n).filter((m) => m.text.includes('Pedido pago #' + id));
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].reply_markup.inline_keyboard.flat().some((b) => b.url === "https://t.me/CounterFlameDonate_bot?start=s_c_1000_749125")); // link no botão
});

test('pendente com Pix vencido é cancelado; vencido mas pago no MP vira paid', async () => {
  mpShouldApprove = false;
  const a = await (await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'm@n.com' })).json();
  db.prepare('UPDATE orders SET expires_at=? WHERE token=?').run(Date.now() - 10 * 60_000, a.token);
  await expirePending();
  assert.equal((await (await fetch(base + '/api/orders/' + a.token)).json()).status, 'cancelled');
  const b = await (await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'o@p.com' })).json();
  db.prepare('UPDATE orders SET expires_at=? WHERE token=?').run(Date.now() - 10 * 60_000, b.token);
  mpShouldApprove = true; // pagou no último segundo
  await expirePending();
  assert.equal((await (await fetch(base + '/api/orders/' + b.token)).json()).status, 'paid');
});

test('e-mail recusado pelo MP vira erro claro (400), não "falha genérica"', async () => {
  const r = await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'a@dhdh.cokc' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /não aceitou esse e-mail/);
});

// ---------- e-mail de entregue ----------
test('marcar entregue manda 1 e-mail ao cliente (nick escapado), e só uma vez', async () => {
  mpShouldApprove = true;
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'cliente@exemplo.com' })).json();
  await fetch(base + '/api/orders/' + token); // → paid
  const n = mailSent.length;
  const deliver = () => fetch(base + '/painel/' + id + '/entregue', { method: 'POST', headers: { Cookie: COOKIE, 'x-painel': '1' } });
  assert.equal((await (await deliver()).json()).ok, true);
  assert.equal((await (await deliver()).json()).ok, false); // segunda vez não muda nada
  await new Promise((r) => setTimeout(r, 50));
  const sent = mailSent.slice(n);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['cliente@exemplo.com']);
  assert.equal(sent[0].from, 'Recarga Flame <pedidos@recargaflame.com.br>');
  assert.equal(sent[0].reply_to, 'suporte@recargaflame.com.br');
  assert.equal(sent[0].auth, 'Bearer re_fake');
  assert.match(sent[0].subject, new RegExp('Pedido #' + id + ' entregue'));
  assert.ok(sent[0].html.includes('#pedido=' + token));
});

// ---------- cupons ----------
const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1' }, body: body && JSON.stringify(body) });

test('cupom: cria, valida e mostra preço com 5% (arredondado, acima do piso)', async () => {
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'aquila', desconto_pct: 5, comissao_pct: 20, ativo: true })).status, 200);
  db.prepare("UPDATE coupons SET plano='fixo' WHERE code='AQUILA'").run(); // estes testes cobrem o plano fixo (% congelado no pedido)
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'AQUILA', desconto_pct: 5, comissao_pct: 20, ativo: true })).status, 409);
  const r = await (await fetch(base + '/api/coupon/Aquila', { headers: freshIP() })).json();
  assert.equal(r.code, 'AQUILA');
  assert.equal(r.prices.c1000, 333); // 350 * 0.95 = 332.5 → 333
  assert.equal((await fetch(base + '/api/coupon/NAOEXISTE', { headers: freshIP() })).status, 404);
});

test('cupom: Pix sai com desconto calculado no servidor; cliente não forja valor', async () => {
  const r = await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'q@r.com', coupon: 'aquila', cents: 1, desconto_pct: 99 });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.cents, 333); assert.equal(j.coupon, 'AQUILA');
  assert.equal(lastMpBody.transaction_amount, 3.33);
});

test('cupom inválido ou desativado é recusado no checkout', async () => {
  assert.equal((await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 's@t.com', coupon: 'FAKE1' })).status, 400);
  await adm('POST', '/api/admin/coupons', { code: 'OFF1', desconto_pct: 5, comissao_pct: 0, ativo: false });
  assert.equal((await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 's@t.com', coupon: 'OFF1' })).status, 400);
});

test('desconto nunca derruba o preço abaixo do custo (Stars + taxa MP)', async () => {
  await adm('POST', '/api/admin/coupons', { code: 'METADE', desconto_pct: 50, comissao_pct: 0, ativo: true });
  const r = await (await fetch(base + '/api/coupon/METADE', { headers: freshIP() })).json();
  // c1000: 26★ × R$0,0875 = R$2,275 → piso com taxa 0,99% = 230 centavos (50% daria 175)
  assert.equal(r.prices.c1000, 230);
});

test('relatório: conta só pagos, desconto e comissão de 20% do lucro', async () => {
  mpShouldApprove = true;
  const { token } = await (await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'u@v.com', coupon: 'AQUILA' })).json();
  await fetch(base + '/api/orders/' + token); // → paid
  const rep = await (await adm('GET', '/api/admin/coupons/report')).json();
  const a = rep.cupons.find((c) => c.code === 'AQUILA');
  assert.equal(a.pedidos, 1); // o pedido pendente do teste anterior não conta
  assert.equal(a.faturado, 333); assert.equal(a.desconto, 17);
  // lucro = 333 − 227,5 − 3,2967 = 102,2 → comissão 20% = 20,44 → 20
  assert.equal(a.lucro, 102); assert.equal(a.comissao, 20);
});

// ---------- analytics ----------
test('analytics: vendas, conversão, lucro após comissão, entrega e estornos', async () => {
  const q = await (await adm('GET', '/api/admin/analytics')).json();
  // tudo que os testes anteriores pagaram entra; confere coerência em vez de números fixos
  assert.ok(q.vendas >= 1);
  assert.equal(q.faturado, q.porDia.reduce((a, d) => a + d.cents, 0));
  assert.equal(q.vendas, q.produtos.reduce((a, p) => a + p.n, 0));
  assert.ok(q.pixPagos <= q.pixGerados);
  assert.equal(q.ticket, Math.round(q.faturado / q.vendas));
  // entrega: o teste do e-mail marcou um pedido como entregue logo após pago
  assert.ok(q.entregas >= 1); assert.ok(q.entregaMedianaMin <= 1); assert.equal(q.entregaAte1h, 1);
  // período sem vendas
  const vazio = await (await adm('GET', '/api/admin/analytics?from=2000-01-01&to=2000-01-31')).json();
  assert.equal(vazio.vendas, 0); assert.equal(vazio.entregaMedianaMin, null);
});

test('comissão: pagamento registrado abate o saldo; desfazer devolve; % fica congelado no pedido', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  const saldo = async () => (await (await adm('GET', '/api/admin/coupons/report')).json()).cupons.find((c) => c.code === 'AQUILA');
  // venda do mês atual: ainda não entra no "a pagar" (só no estimado do mês)
  const m0 = await saldo();
  assert.equal(m0.total, 20); assert.equal(m0.mesCom, 20); assert.equal(m0.fechado, 0); assert.equal(m0.saldo, 0); assert.equal(m0.minimo, 2000);
  // leva as vendas do AQUILA para o mês passado: viram "a pagar" (restaurado no fim do teste)
  const orig = db.prepare("SELECT id, paid_at FROM orders WHERE coupon='AQUILA' AND paid_at IS NOT NULL").all();
  db.prepare("UPDATE orders SET paid_at=datetime(paid_at, '-40 days') WHERE coupon='AQUILA' AND paid_at IS NOT NULL").run();
  const a0 = await saldo();
  assert.equal(a0.total, 20); assert.equal(a0.pago, 0); assert.equal(a0.saldo, 20); assert.equal(a0.mesCom, 0);
  // editar o % do cupom depois não muda o que a venda antiga já gerou
  await adm('PUT', '/api/admin/coupons/AQUILA', { desconto_pct: 5, comissao_pct: 50, ativo: true });
  assert.equal((await saldo()).total, 20);
  assert.equal((await adm('POST', '/api/admin/coupons/AQUILA/payouts', { cents: 0 })).status, 400);
  assert.equal((await adm('POST', '/api/admin/coupons/NAOEXISTE/payouts', { cents: 100 })).status, 404);
  const { id } = await (await adm('POST', '/api/admin/coupons/aquila/payouts', { cents: 15, nota: 'Pix 07/11' })).json();
  const a1 = await saldo();
  assert.equal(a1.pago, 15); assert.equal(a1.saldo, 5);
  assert.equal(a1.pagamentos[0].nota, 'Pix 07/11');
  // período sem vendas: números do período zeram, mas saldo continua
  const vazio = (await (await adm('GET', '/api/admin/coupons/report?from=2000-01-01&to=2000-01-31')).json()).cupons.find((c) => c.code === 'AQUILA');
  assert.equal(vazio.pedidos, 0); assert.equal(vazio.saldo, 5);
  assert.equal((await adm('DELETE', '/api/admin/payouts/' + id)).status, 200);
  assert.equal((await saldo()).saldo, 20);
  // sem sessão não registra pagamento
  assert.equal((await fetch(base + '/api/admin/coupons/AQUILA/payouts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-painel': '1' }, body: '{"cents":100}' })).status, 401);
  await adm('PUT', '/api/admin/coupons/AQUILA', { desconto_pct: 5, comissao_pct: 20, ativo: true });
  for (const o of orig) db.prepare('UPDATE orders SET paid_at=? WHERE id=?').run(o.paid_at, o.id);
});

test('painel: lista de pedidos para atualização automática exige sessão', async () => {
  assert.equal((await fetch(base + '/api/admin/orders')).status, 401);
  const list = await (await adm('GET', '/api/admin/orders')).json();
  assert.ok(Array.isArray(list) && list.length > 0);
  assert.ok(list.some((o) => o.status === 'paid'));
  assert.ok('nick' in list[0] && 'tg' in list[0]);
});

// ---------- antifraude ----------
const pedir = async (product, gameId, email) => postJ('/api/orders', { product, gameId, email });
const pagar = async (token) => fetch(base + '/api/orders/' + token, { headers: freshIP() }); // consulta → syncPayment → paid

test('antifraude: pedido alto / 1ª compra chega no Telegram e no painel como REVISAR', async () => {
  mpShouldApprove = true;
  const r = await pedir('c200000', '777777', 'big@x.com');
  assert.equal(r.status, 200);
  const { token, id } = await r.json();
  await pagar(token);
  const msg = tgSent.at(-1).text;
  assert.match(msg, /Pedido pago #/); assert.match(msg, /REVISAR/); assert.doesNotMatch(msg, /valor alto/); /* 200.000 Coins (R$339,90) fica abaixo do valor alto (R$340) */ assert.match(msg, /primeira compra/);
  const o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === id);
  assert.ok(o.risk.some((r) => /primeira compra/.test(r))); // valor alto não dispara mais no 200.000 Coins
  // pedido pequeno de cliente normal não pede revisão
  const p2 = await (await pedir('c1000', '777778', 'ok@x.com')).json();
  await pagar(p2.token);
  assert.doesNotMatch(tgSent.at(-1).text, /REVISAR/);
});

test('antifraude: teto diário por ID/e-mail recusa no checkout', async () => {
  const old = RISK.cap; RISK.cap = 50000;
  try {
    const r = await pedir('c200000', '777777', 'outro@x.com'); // mesmo ID do teste anterior (já pagou R$339,90)
    assert.equal(r.status, 409); assert.match((await r.json()).error, /Limite diário/);
    const r2 = await pedir('c200000', '777779', 'BIG@x.com'); // outro ID, mesmo e-mail (maiúsculas não escapam)
    assert.equal(r2.status, 409);
  } finally { RISK.cap = old; }
});

test('antifraude: no máximo N Pix em aberto por ID/e-mail', async () => {
  const old = RISK.pend; RISK.pend = 1; mpShouldApprove = false;
  try {
    assert.equal((await pedir('c1000', '888888', 'pend@x.com')).status, 200);
    const r = await pedir('c1000', '888888', 'pend2@x.com');
    assert.equal(r.status, 429); assert.match((await r.json()).error, /Pix em aberto/);
  } finally { RISK.pend = old; mpShouldApprove = true; }
});

test('antifraude: estorno após pagamento bloqueia ID e e-mail; painel desbloqueia', async () => {
  mpShouldApprove = true;
  const { token, id } = await (await pedir('c1000', '666666', 'Mal@x.com')).json();
  await pagar(token);
  mpStatus = 'refunded';
  try {
    const crypto = await import('node:crypto');
    const v1 = crypto.createHmac('sha256', 'segredo-teste').update('id:123456;request-id:r1;ts:1;').digest('hex');
    const w = await fetch(base + '/webhook/mercadopago?type=payment&data.id=123456', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'r1', 'x-signature': `ts=1,v1=${v1}` }, body: '{}' });
    assert.equal(w.status, 200);
  } finally { mpStatus = null; }
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(id).status, 'cancelled');
  // edita o aviso do pedido (sem mensagem nova)
  const msgEst = db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(id).tg_msg;
  const ed = lastCall('editMessageText').body;
  assert.equal(ed.message_id, msgEst); assert.match(ed.text, new RegExp('⛔ Pedido #' + id + ' · cancelado após pagamento \\(refunded\\)'));
  assert.match(ed.text, /Bloqueados:/); assert.match(ed.reply_markup.inline_keyboard[0][0].text, /Cancelado/);
  assert.ok(!tgSent.some((m) => m.text.includes('#' + id) && /Bloqueados:/.test(m.text)));
  // + alerta curto respondendo ao aviso (a edição não notifica)
  const al = tgSent.at(-1);
  assert.match(al.text, new RegExp('⛔ Pedido #' + id + ' cancelado após pagamento')); assert.equal(al.reply_parameters.message_id, msgEst);
  // mesmo e-mail com outro ID, ou mesmo ID com outro e-mail: recusado
  assert.equal((await pedir('c1000', '666667', 'mal@x.com')).status, 403);
  assert.equal((await pedir('c1000', '666666', 'novo@x.com')).status, 403);
  const o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === id);
  assert.equal(o.blocked, true);
  assert.equal((await fetch(base + '/api/admin/orders/' + id + '/unblock', { method: 'POST', headers: { 'x-painel': '1' } })).status, 401);
  const nU = tgSent.length;
  assert.equal((await adm('POST', '/api/admin/orders/' + id + '/unblock')).status, 200);
  const eu = lastCall('editMessageText').body;
  assert.equal(eu.message_id, msgEst); assert.match(eu.text, new RegExp('🔓 Pedido #' + id + ' · cliente desbloqueado'));
  assert.match(eu.text, /cancelado após pagamento/); assert.match(eu.reply_markup.inline_keyboard[0][0].text, /Desbloqueado/);
  assert.ok(!eu.reply_markup.inline_keyboard.flat().some((x) => /^r:/.test(x.callback_data))); // MP já devolveu: sem botão de reembolso
  assert.equal(tgSent.length, nU);
  // desbloquear de novo (já livre): não mexe no aviso
  const cE = tgCalls.length;
  assert.equal((await adm('POST', '/api/admin/orders/' + id + '/unblock')).status, 200);
  assert.ok(!tgCalls.slice(cE).some((c) => c.method === 'editMessageText'));
  assert.equal((await pedir('c1000', '666666', 'mal@x.com')).status, 200);
});

const webhookMP = async () => {
  const crypto = await import('node:crypto');
  const v1 = crypto.createHmac('sha256', 'segredo-teste').update('id:123456;request-id:r1;ts:1;').digest('hex');
  return fetch(base + '/webhook/mercadopago?type=payment&data.id=123456', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-request-id': 'r1', 'x-signature': `ts=1,v1=${v1}` }, body: '{}' });
};
const pagadorX = {
  // o MP devolve o CNPJ dele mesmo em payer.identification: não pode virar bloqueio
  payer: { identification: { type: 'CNPJ', number: '10573521000191' } },
  point_of_interaction: { transaction_data: { bank_info: { payer: { long_name: 'Banco X', branch: '1', account_id: 987654 } } } },
};

test('antifraude: aparelho (cookie), conta/CPF do pagador e IP após estorno', async () => {
  // loja entrega um cookie de aparelho aleatório e HttpOnly
  const home = await fetch(base + '/', { headers: { 'X-Forwarded-For': '10.9.9.9' } });
  const sc = home.headers.get('set-cookie') || '';
  assert.match(sc, /cf_dev=[A-Za-z0-9_-]{22};.*HttpOnly/);
  const dev = sc.split(';')[0];
  const comprar = (gameId, email, cookie, ip) => fetch(base + '/api/orders', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ product: 'c1000', gameId, email }) });

  // golpista paga do aparelho dev, IP .9.9 e conta X; depois estorna
  mpShouldApprove = true; mpPayer = pagadorX;
  const { token, id } = await (await comprar('444441', 'g1@x.com', dev, '10.9.9.9')).json();
  await pagar(token);
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  assert.ok(row.device && row.ip_h && row.payer_acct && !row.payer_doc);
  assert.ok(!JSON.stringify(row).includes('987654') && !JSON.stringify(row).includes('10.9.9.9')); // nada em claro
  mpStatus = 'refunded';
  try { assert.equal((await webhookMP()).status, 200); } finally { mpStatus = null; }

  // mesmo aparelho, ID e e-mail novos: recusado no checkout
  assert.equal((await comprar('444442', 'g2@x.com', dev, '10.7.7.7')).status, 403);
  // outro aparelho, mesmo IP: passa (IP não bloqueia), mas pago → alerta de IP
  mpPayer = null;
  const b = await (await comprar('444443', 'g3@x.com', null, '10.9.9.9')).json();
  await pagar(b.token);
  assert.match(tgSent.at(-1).text, /mesmo IP/);
  assert.doesNotMatch(tgSent.at(-1).text, /conta bancária/);
  // outro aparelho e IP, mas paga com a MESMA conta: não dá para recusar antes do Pix → BLOQUEIO imediato ao pagar
  mpPayer = pagadorX;
  const c = await (await comprar('444444', 'g4@x.com', null, '10.6.6.6')).json();
  await pagar(c.token);
  assert.match(tgSent.at(-1).text, /🚫 Pedido #\d+ BLOQUEADO automaticamente: a conta bancária que pagou já teve estorno/);
  assert.match(tgSent.at(-1).text, /devolva R\$/);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(c.id).status, 'cancelled');
  assert.equal((await (await fetch(base + '/api/orders/' + c.token, { headers: freshIP() })).json()).status, 'refund');
  assert.equal((await comprar('444444', 'g4b@x.com', null, '10.4.4.4')).status, 403); // ID do pedido bloqueado também ficou bloqueado
  mpPayer = null;
  // desbloquear o pedido bloqueado: edita o aviso 🚫 (mantém o botão de reembolso), sem mensagem nova
  await new Promise((r) => setTimeout(r, 20));
  const cMsg = db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(c.id).tg_msg;
  const nB = tgSent.length;
  assert.equal((await adm('POST', '/api/admin/orders/' + c.id + '/unblock')).status, 200);
  const ub = lastCall('editMessageText').body;
  assert.equal(ub.message_id, cMsg); assert.match(ub.text, new RegExp('🔓 Pedido #' + c.id + ' · cliente desbloqueado'));
  assert.match(ub.text, /conta bancária que pagou já teve estorno/); assert.match(ub.text, /devolva R\$/);
  assert.equal(ub.reply_markup.inline_keyboard[0][0].callback_data, 'r:' + c.id);
  assert.equal(tgSent.length, nB);
  // reembolsar depois: o aviso guarda o motivo do bloqueio
  _setRefundCaller(async () => ({ ok: true, id: 1, estado: 'approved' }));
  try { assert.equal((await adm('POST', '/api/admin/orders/' + c.id + '/reembolsar')).status, 200); } finally { _setRefundCaller(null); }
  const rb = lastCall('editMessageText').body;
  assert.equal(rb.message_id, cMsg); assert.match(rb.text, /reembolsado às/); assert.match(rb.text, /Tinha sido bloqueado automaticamente: a conta bancária/);
  assert.equal(tgSent.length, nB);
  // desbloquear libera o aparelho também
  assert.equal((await adm('POST', '/api/admin/orders/' + id + '/unblock')).status, 200);
  assert.equal((await comprar('444445', 'g5@x.com', dev, '10.5.5.5')).status, 200);
});

test('antifraude: CNPJ do próprio MP em payer.identification não bloqueia outros clientes', async () => {
  // estorno de um pagador da conta X…
  mpShouldApprove = true; mpPayer = pagadorX;
  const a = await (await postJ('/api/orders', { product: 'c1000', gameId: '333331', email: 'a1@x.com' })).json();
  await pagar(a.token);
  mpStatus = 'refunded';
  try { await webhookMP(); } finally { mpStatus = null; }
  // …não afeta outro cliente com outra conta, mesmo com o mesmo CNPJ do MP no campo payer
  mpPayer = { payer: pagadorX.payer, point_of_interaction: { transaction_data: { bank_info: { payer: { long_name: 'Banco Y', branch: '2', account_id: 111 } } } } };
  const b = await (await postJ('/api/orders', { product: 'c1000', gameId: '333332', email: 'b1@x.com' })).json();
  await pagar(b.token);
  assert.doesNotMatch(tgSent.at(-1).text, /REVISAR/);
  mpPayer = null;
  await adm('POST', '/api/admin/orders/' + a.id + '/unblock');
});

// ---------- entrega assistida (Telegram) ----------
const OP = 42; // TG_CHAT_ID do teste
const cb = (data, msgId, from = OP) => handleTgUpdate({ update_id: 1, callback_query: {
  id: 'cq' + Math.random(), data, from: { id: from }, message: { message_id: msgId, chat: { id: from } } } });
const lastCall = (m) => tgCalls.filter((c) => c.method === m).at(-1);

test('reembolso recusado pelo MP no botão do Telegram: edita a mensagem com o motivo e devolve o botão, sem mensagem nova', async () => {
  mpShouldApprove = true;
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '222231', email: 'rr@x.com' })).json();
  await pagar(token);
  await new Promise((r) => setTimeout(r, 20));
  const msgId = db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(id).tg_msg;
  _setRefundCaller(async () => ({ ok: false, erro: 'insufficient_amount' }));
  try {
    const n = tgSent.length;
    const texto = `🚫 Pedido #${id} BLOQUEADO automaticamente: teste.\n⚠️ Reembolso recusado às 10:00: antigo`;
    await handleTgUpdate({ update_id: 1, callback_query: { id: 'cqr', data: 'R:' + id, from: { id: OP }, message: { message_id: msgId, chat: { id: OP }, text: texto } } });
    const e = lastCall('editMessageText').body;
    assert.equal(e.message_id, msgId); assert.match(e.text, /BLOQUEADO automaticamente: teste/); assert.match(e.text, /Reembolso recusado às .*insufficient_amount/);
    assert.doesNotMatch(e.text, /antigo/); // não acumula recusas
    assert.equal(e.reply_markup.inline_keyboard[0][0].callback_data, 'r:' + id);
    assert.equal(tgSent.length, n);
  } finally { _setRefundCaller(null); }
});

test('entrega pelo Telegram: aviso com botões → confirmar → entregue + e-mail; estranho não mexe', async () => {
  mpShouldApprove = true;
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '222221', email: 'tg@x.com' })).json();
  await pagar(token);
  await new Promise((r) => setTimeout(r, 20));
  const sent = lastCall('sendMessage').body;
  const kb = sent.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.url === 'https://t.me/CounterFlameDonate_bot?start=s_c_1000_222221'));
  assert.ok(kb.some((b) => b.callback_data === 'd:' + id));
  const msgId = db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(id).tg_msg;
  assert.ok(msgId > 700);
  // outra pessoa tocando no botão (mensagem encaminhada, por ex.): sem efeito
  await cb('D:' + id, msgId, 999);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(id).status, 'paid');
  // 1º toque só pede confirmação
  await cb('d:' + id, msgId);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(id).status, 'paid');
  assert.ok(lastCall('editMessageReplyMarkup').body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'D:' + id));
  // voltar restaura os botões originais
  await cb('b:' + id, msgId);
  assert.ok(lastCall('editMessageReplyMarkup').body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'd:' + id));
  // confirmar entrega
  const mails = mailSent.length;
  await cb('D:' + id, msgId);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(id).status, 'delivered');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mailSent.length, mails + 1);
  const ed = lastCall('editMessageText').body;
  assert.equal(ed.message_id, msgId); assert.match(ed.text, new RegExp('Pedido #' + id + ' · entregue manualmente às'));
  assert.match(ed.reply_markup.inline_keyboard[0][0].text, /Entregue/);
  // toque repetido não reenvia e-mail
  await cb('D:' + id, msgId);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mailSent.length, mails + 1);
});

test('entrega pelo painel edita o aviso no Telegram (texto e botões, sem mensagem nova)', async () => {
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '222222', email: 'tp@x.com' })).json();
  await pagar(token);
  await new Promise((r) => setTimeout(r, 20));
  const msgId = db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(id).tg_msg;
  await adm('POST', '/painel/' + id + '/entregue');
  const n = tgSent.length;
  await adm('POST', '/painel/' + id + '/entregue'); // de novo: nada muda
  const e = lastCall('editMessageText').body;
  assert.equal(e.message_id, msgId); assert.match(e.text, /entregue manualmente \(painel\) às/); assert.match(e.text, /Saldo/);
  assert.match(e.reply_markup.inline_keyboard[0][0].text, /Entregue/);
  assert.equal(tgSent.length, n); // sem mensagem nova
});

// ---------- saldo de Stars ----------
test('stars: saldo inicial, recarga, entrega desconta, alerta de fila e saldo baixo', async () => {
  const get = async () => (await adm('GET', '/api/admin/stars')).json();
  assert.equal((await fetch(base + '/api/admin/stars')).status, 401);
  // limpa a fila de pagos de testes anteriores para conta previsível
  db.exec("UPDATE orders SET status='delivered' WHERE status='paid'");
  assert.equal((await get()).configurado, false);
  assert.equal((await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 530 })).status, 200);
  let s = await get();
  assert.equal(s.configurado, true); assert.equal(s.saldo, 530);
  assert.equal((await adm('POST', '/api/admin/stars', { kind: 'compra', stars: -5, cents: 100 })).status, 400);
  assert.equal((await adm('POST', '/api/admin/stars', { kind: 'compra', stars: 100 })).status, 400); // valor obrigatório
  assert.equal((await adm('POST', '/api/admin/stars', { kind: 'compra', stars: 100, cents: 875 })).status, 200);
  s = await get();
  // compra NÃO altera o saldo; só entra no custo
  assert.equal(s.saldo, 530); assert.equal(s.custoMedio, 0.0875);
  assert.equal(s.compras[0].stars, 100); assert.ok(!s.movs.some((m) => m.kind === 'recarga'));
  await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 630 });
  // pedido de 1.000 Coins (26★) pago e entregue → desconta 26
  mpShouldApprove = true;
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '111111', email: 'st@x.com' })).json();
  await pagar(token);
  assert.equal((await get()).fila, 26);
  await adm('POST', '/painel/' + id + '/entregue');
  s = await get();
  assert.equal(s.saldo, 604); assert.equal(s.fila, 0);
  assert.ok(s.movs.some((m) => m.kind === 'entrega' && m.order_id === id && m.delta === -26));
  // entrega não pode ser apagada
  const ent = s.movs.find((m) => m.kind === 'entrega');
  assert.equal((await adm('DELETE', '/api/admin/stars/' + ent.id)).status, 404);
  // conferir saldo: real 480 → ajuste −124
  await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 480 });
  assert.equal((await get()).saldo, 480);
  // fila maior que o saldo → aviso de pago avisa
  await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 20 });
  const p2 = await (await postJ('/api/orders', { product: 'c1000', gameId: '111112', email: 'st2@x.com' })).json();
  await pagar(p2.token);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(tgSent.at(-1).text, /Stars insuficientes: saldo 20★, fila precisa 26★/);
  // entregar cruzando o limite de saldo baixo (500) gera aviso
  await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 510 });
  await adm('POST', '/painel/' + p2.id + '/entregue');
  await new Promise((r) => setTimeout(r, 20));
  assert.match(tgSent.at(-1).text, /Saldo de Stars baixo: 484★/);
});

test('stars: saldo REAL da conta separada substitui o manual; falha volta ao manual e avisa', async () => {
  let real = 1500, fail = false;
  _setStarsReader(async () => { if (fail) throw new Error('AUTH_KEY_UNREGISTERED'); return real; });
  try {
    let s = await (await adm('GET', '/api/admin/stars')).json();
    assert.equal(s.saldo, 1500); assert.equal(s.real.ativo, true); assert.equal(s.configurado, true);
    // "Ler agora"
    real = 1200;
    s = await (await adm('POST', '/api/admin/stars/sync')).json();
    assert.equal(s.saldo, 1200);
    assert.equal(s.real.manual, 1200); // livro-caixa realinhado ao saldo real
    const autos = s.movs.filter((m) => m.nota === 'sincronizado com o Telegram');
    assert.equal(autos.length, 1); // leituras seguidas viram um ajuste só
    // cruzou o limite (500) numa leitura → aviso
    real = 450;
    await adm('POST', '/api/admin/stars/sync');
    assert.match(tgSent.at(-1).text, /Saldo de Stars baixo: 450★/);
    // sessão revogada: avisa 1 vez e painel volta ao manual
    fail = true;
    s = await (await adm('POST', '/api/admin/stars/sync')).json();
    assert.equal(s.real.ativo, false); assert.match(s.real.err, /AUTH_KEY/);
    assert.equal(s.saldo, s.real.manual);
    assert.match(tgSent.at(-1).text, /sessão da conta separada do Telegram CAIU/); // AUTH_KEY_* = sessão caiu
    const n = tgSent.length;
    await adm('POST', '/api/admin/stars/sync');
    assert.equal(tgSent.length, n); // não repete o mesmo erro
  } finally { _setStarsReader(null); }
});

// ---------- conferência da fatura no bot do CF ----------
test('segurança: testes nunca usam a conta de usuário real do Telegram', async () => {
  const { userConfig } = await import('../tg-user.js');
  assert.equal(userConfig().ok, false);
  const r = await adm('GET', '/api/admin/stars');
  assert.equal((await r.json()).real, null);
});

test('conferência: fatura bate → ✅ no aviso; diverge → REVISAR; erro → avisa; nunca paga', async () => {
  const calls = [];
  let resp = null, fail = null;
  _setInvoiceChecker(async (startParam) => { calls.push(startParam); if (fail) throw new Error(fail); return resp; });
  try {
    mpShouldApprove = true;
    // ok: 26★ e nick igual ao do CF (mock devolve "jogador_teste")
    resp = { currency: 'XTR', stars: 26, account: 'Jogador_Teste', produto: '1 000 coins', msgId: 1 };
    const a = await (await postJ('/api/orders', { product: 'c1000', gameId: '121212', email: 'ck1@x.com' })).json();
    await pagar(a.token);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.at(-1), 's_c_1000_121212');
    let e = lastCall('editMessageText').body;
    assert.match(e.text, /Conferido no bot do CF: 26★ · Jogador_Teste ✅/);
    assert.ok(e.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'd:' + a.id)); // botões mantidos
    let o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === a.id);
    assert.equal(o.chk.status, 'ok'); assert.equal(o.risk.length, 0);
    // diverge: bot cobra outro valor e outra conta
    resp = { currency: 'XTR', stars: 30, account: 'Outro', produto: '1 000 coins', msgId: 2 };
    const ck = await (await adm('POST', '/api/admin/orders/' + a.id + '/check')).json();
    assert.equal(ck.status, 'diverge'); assert.match(ck.motivo, /30★, esperado 26★/); assert.match(ck.motivo, /Outro/);
    e = lastCall('editMessageText').body;
    assert.match(e.text, /Conferência NÃO bateu/); assert.match(e.text, /REVISAR/);
    o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === a.id);
    assert.ok(o.risk.some((r) => /conferência no bot/.test(r)));
    // erro do bot
    fail = 'o bot não respondeu em 15 s';
    const ck2 = await conferir(a.id);
    assert.equal(ck2.status, 'erro');
    assert.match(lastCall('editMessageText').body.text, /Conferência falhou/);
    // pedido entregue não é mais conferido
    await adm('POST', '/painel/' + a.id + '/entregue');
    assert.equal((await adm('POST', '/api/admin/orders/' + a.id + '/check')).status, 409);
    // nenhuma chamada de pagamento existe no fluxo
    assert.ok(!tgCalls.some((c) => /pay|sendStarsForm/i.test(c.method)));
  } finally { _setInvoiceChecker(null); }
});

// ---------- pagamento com 1 toque ----------
test('pagamento 1 toque: desligado por padrão; ligado paga 1 vez, entrega e respeita travas', async () => {
  const pays = [];
  let payErr = null;
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 26, account: 'jogador_teste', produto: '1 000 coins', msgId: 1 }));
  _setInvoicePayer(async (a) => { pays.push(a); await new Promise((r) => setTimeout(r, 30)); if (payErr) throw payErr; return { stars: a.expectStars, account: a.expectAccount, produto: '1 000 coins', botReply: 'ok!' }; });
  try {
    mpShouldApprove = true;
    const novo = async (gid) => { const j = await (await postJ('/api/orders', { product: 'c1000', gameId: gid, email: gid + '@ap.com' })).json(); await pagar(j.token); await new Promise((r) => setTimeout(r, 30)); return j.id; };
    const a = await novo('131311');
    // desligado: sem botão no aviso, endpoint recusa
    assert.ok(!lastCall('editMessageText').body.reply_markup.inline_keyboard.flat().some((b) => /Pagar/.test(b.text)));
    assert.equal((await adm('POST', '/api/admin/orders/' + a + '/autopay')).status, 409);
    assert.equal(pays.length, 0);
    // liga a chave geral
    assert.equal((await fetch(base + '/api/admin/autopay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-painel': '1' }, body: '{"on":true}' })).status, 401);
    assert.equal((await (await adm('POST', '/api/admin/autopay', { on: true })).json()).on, true);
    await conferir(a);
    const kb = lastCall('editMessageText').body.reply_markup.inline_keyboard.flat();
    assert.ok(kb.some((b) => b.callback_data === 'p:' + a && /Pagar 26★/.test(b.text)));
    // estranho não paga
    const msgId = db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(a).tg_msg;
    await cb('P:' + a, msgId, 999);
    assert.equal(pays.length, 0);
    // 1º toque só pede confirmação
    await cb('p:' + a, msgId);
    assert.equal(pays.length, 0);
    // dois toques simultâneos no "Sim, pagar": só UM pagamento
    await Promise.all([cb('P:' + a, msgId), cb('P:' + a, msgId)]);
    assert.equal(pays.length, 1);
    const { onInvoice, ...p0 } = pays[0];
    assert.deepEqual(p0, { startParam: 's_c_1000_131311', expectStars: 26, expectAccount: 'jogador_teste' });
    assert.equal(typeof onInvoice, 'function'); // grava a fatura antes de cobrar
    const row = db.prepare('SELECT status, autopay FROM orders WHERE id=?').get(a);
    assert.equal(row.status, 'delivered'); assert.equal(row.autopay, 'sent');
    assert.ok(tgCalls.some((c) => c.method === 'editMessageText' && /Pedido #\d+ · pago no bot \(26★\) e entregue/.test(c.body.text)));
    // falha ANTES de cobrar (safe) → 'erro', pode tentar de novo
    const b = await novo('131312');
    payErr = Object.assign(new Error('fatura de 30★, esperado 26★'), { safe: true });
    let r = await adm('POST', '/api/admin/orders/' + b + '/autopay');
    assert.equal(r.status, 409); assert.match((await r.json()).error, /não pagou/);
    assert.equal(db.prepare('SELECT autopay FROM orders WHERE id=?').get(b).autopay, 'erro');
    payErr = null;
    assert.equal((await adm('POST', '/api/admin/orders/' + b + '/autopay')).status, 200);
    // falha DEPOIS de cobrar (incerta) → nunca repete, alerta
    const c = await novo('131313');
    payErr = new Error('TIMEOUT');
    r = await adm('POST', '/api/admin/orders/' + c + '/autopay');
    assert.equal(r.status, 409);
    assert.equal(db.prepare('SELECT autopay, status FROM orders WHERE id=?').get(c).autopay, 'incerto');
    assert.ok(tgSent.at(-1).text.includes('INCERTO'));
    payErr = null;
    const n = pays.length;
    assert.equal((await adm('POST', '/api/admin/orders/' + c + '/autopay')).status, 409);
    assert.equal(pays.length, n);
    // pedido em REVISAR (valor alto) não tem pagamento automático
    _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 1499, account: 'jogador_teste', produto: '100 000 coins', msgId: 1 }));
    const big = await (await postJ('/api/orders', { product: 'c100000', gameId: '131314', email: 'big@ap.com' })).json();
    await pagar(big.token); await new Promise((r) => setTimeout(r, 30));
    r = await adm('POST', '/api/admin/orders/' + big.id + '/autopay');
    assert.equal(r.status, 409); assert.match((await r.json()).error, /REVISAR|teto/);
    // desliga a chave geral: nada mais paga
    await adm('POST', '/api/admin/autopay', { on: false });
    _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 26, account: 'jogador_teste', produto: '1 000 coins', msgId: 1 }));
    const d = await novo('131315');
    assert.equal((await adm('POST', '/api/admin/orders/' + d + '/autopay')).status, 409);
  } finally { _setInvoiceChecker(null); _setInvoicePayer(null); await adm('POST', '/api/admin/autopay', { on: false }); }
});

test('entrega 100% automática: paga sozinho com ✅; senão manual; cliente e Telegram avisados', async () => {
  RISK.first = 5000; // regra antiga (1ª compra ≥ R$ 50) para provocar revisão com 50.000 Coins
  const pays = [];
  let chk = { currency: 'XTR', stars: 26, account: 'jogador_teste', produto: '1 000 coins', msgId: 1 }, payErr = null;
  _setInvoiceChecker(async () => chk);
  _setInvoicePayer(async (a) => { pays.push(a); if (payErr) throw payErr; return { stars: a.expectStars, account: a.expectAccount, produto: '1 000 coins', botReply: '' }; });
  const espera = () => new Promise((r) => setTimeout(r, 80));
  const novo = async (gid, product = 'c1000') => { const j = await (await postJ('/api/orders', { product, gameId: gid, email: gid + '@au.com' })).json(); await pagar(j.token); return j; };
  const cliente = async (tk) => (await fetch(base + '/api/orders/' + tk)).json();
  try {
    assert.equal((await (await adm('POST', '/api/admin/autopay', { mode: 2 })).json()).mode, '2');
    // ✅ → entregue sem toque
    const a = await novo('141411');
    await espera();
    assert.equal(db.prepare('SELECT status, autopay FROM orders WHERE id=?').get(a.id).status, 'delivered');
    assert.equal(pays.length, 1);
    // sucesso: EDITA o aviso do pedido (sem mensagem nova)
    const aMsg = db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(a.id).tg_msg;
    const ok = tgCalls.filter((c) => c.method === 'editMessageText' && c.body.message_id === aMsg).at(-1)?.body;
    assert.ok(ok); assert.match(ok.text, new RegExp('Pedido #' + a.id + ' · entregue automaticamente')); assert.match(ok.text, /⭐ Saldo:|Saldo de Stars/);
    assert.match(ok.reply_markup.inline_keyboard[0][0].text, /Entregue às/);
    assert.ok(!tgSent.some((m) => m.text.includes('#' + a.id) && /entregue/i.test(m.text)));
    assert.equal((await cliente(a.token)).status, 'delivered');
    // conferência diverge → manual, cliente vê "manual" sem motivo, Telegram avisa
    chk = { ...chk, stars: 30 };
    const b = await novo('141412');
    await espera();
    assert.equal(pays.length, 1);
    assert.ok(tgSent.some((m) => m.text.includes('Entrega MANUAL necessária #' + b.id) && /não bateu/i.test(m.text)));
    const cb_ = await cliente(b.token);
    assert.equal(cb_.status, 'paid'); assert.equal(cb_.entrega, 'manual');
    assert.ok(!JSON.stringify(cb_).includes('30'));
    // pagamento recusado antes de cobrar → ⚠️ + manual
    chk = { ...chk, stars: 26 }; payErr = Object.assign(new Error('Telegram recusou: BALANCE_TOO_LOW'), { safe: true });
    const c = await novo('141413');
    await espera();
    assert.ok(tgSent.some((m) => m.text.includes('Entrega automática falhou #' + c.id) && /BALANCE_TOO_LOW/.test(m.text)));
    // aviso do pedido editado com o motivo, mantendo os botões de entregar; alerta curto responde a ele
    const cMsg = db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(c.id).tg_msg;
    const ef = tgCalls.filter((x) => x.method === 'editMessageText' && x.body.message_id === cMsg).at(-1).body;
    assert.match(ef.text, /💰 Pedido pago/); assert.match(ef.text, /⚠️ Entrega automática falhou: .*BALANCE_TOO_LOW/);
    assert.ok(ef.reply_markup.inline_keyboard.flat().some((x) => x.callback_data === 'd:' + c.id));
    const al = tgSent.find((m) => m.text.includes('Entrega automática falhou #' + c.id));
    assert.equal(al.reply_parameters.message_id, cMsg); assert.ok(al.text.length < 200);
    assert.equal((await cliente(c.token)).entrega, 'manual');
    payErr = null;
    // pedido em REVISAR (1ª compra ≥ R$50) → manual com motivo
    chk = { ...chk, stars: 771 };
    const d = await novo('141414', 'c50000');
    await espera();
    assert.ok(tgSent.some((m) => m.text.includes('Entrega MANUAL necessária #' + d.id) && /REVISAR/.test(m.text)));
    // modo 1 toque: cliente não vê estado de entrega automática
    await adm('POST', '/api/admin/autopay', { mode: 1 });
    assert.equal((await cliente(b.token)).entrega, null);
  } finally { RISK.first = null; _setInvoiceChecker(null); _setInvoicePayer(null); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
});

test('resolver incerto pelo painel: verifica cobrança no histórico → entregue ou libera nova tentativa', async () => {
  let found = null;
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 26, account: 'jogador_teste', produto: '1 000 coins', msgId: 1 }));
  let fatura = 9000;
  // pagamento: chega à fatura (grava o nº antes de cobrar) e cai no envio → incerto
  _setInvoicePayer(async (q) => { await q.onInvoice(++fatura); throw new Error('TIMEOUT'); });
  const consultadas = [];
  _setReceiptChecker(async (msgId) => { consultadas.push(msgId); return found ? { paid: true, receiptMsgId: msgId + 1 } : { paid: false }; });
  try {
    await adm('POST', '/api/admin/autopay', { mode: 1 });
    const novo = async (gid) => { const j = await (await postJ('/api/orders', { product: 'c1000', gameId: gid, email: gid + '@rs.com' })).json(); await pagar(j.token); await new Promise((r) => setTimeout(r, 40)); return j.id; };
    const a = await novo('151511');
    await adm('POST', '/api/admin/orders/' + a + '/autopay'); // TIMEOUT → incerto
    assert.equal(db.prepare('SELECT autopay FROM orders WHERE id=?').get(a).autopay, 'incerto');
    // aviso do pedido editado com os detalhes + alerta curto respondendo a ele
    const aMsg = db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(a).tg_msg;
    const ei = lastCall('editMessageText').body;
    assert.equal(ei.message_id, aMsg); assert.match(ei.text, new RegExp('🚨 Pedido #' + a + ' · pagamento INCERTO')); assert.match(ei.text, /TIMEOUT/);
    assert.match(ei.reply_markup.inline_keyboard[0][0].text, /incerto/);
    assert.match(tgSent.at(-1).text, new RegExp('Pagamento INCERTO no pedido #' + a)); assert.equal(tgSent.at(-1).reply_parameters.message_id, aMsg);
    assert.ok(!tgSent.some((m) => /verificar cobrança/.test(m.text) && m.text.includes('#' + a)));
    // logo após a tentativa: pede para esperar 1 min
    assert.equal((await adm('POST', '/api/admin/orders/' + a + '/verify')).status, 409);
    db.prepare('UPDATE orders SET autopay_at=? WHERE id=?').run(Date.now() - 120_000, a);
    // sem cobrança no histórico → liberar → volta a poder pagar
    let v = await (await adm('POST', '/api/admin/orders/' + a + '/verify')).json();
    assert.equal(v.cobrado, false);
    assert.equal((await adm('POST', '/api/admin/orders/' + a + '/resolve', { acao: 'liberar' })).status, 200);
    const el = lastCall('editMessageText').body;
    assert.equal(el.message_id, aMsg); assert.match(el.text, /💰 Pedido pago/); assert.match(el.text, /nada foi cobrado/);
    assert.ok(el.reply_markup.inline_keyboard.flat().some((x) => x.callback_data === 'd:' + a));
    let o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === a);
    assert.equal(o.ap, 'erro'); assert.equal(o.canPay.ok, true);
    // outro pedido incerto, mas FOI cobrado → marcar entregue
    const b = await novo('151512');
    await adm('POST', '/api/admin/orders/' + b + '/autopay');
    db.prepare('UPDATE orders SET autopay_at=? WHERE id=?').run(Date.now() - 120_000, b);
    found = true;
    v = await (await adm('POST', '/api/admin/orders/' + b + '/verify')).json();
    assert.equal(v.cobrado, true);
    // consultou a fatura EXATA de cada pedido (não valor/horário)
    assert.deepEqual(consultadas, [9001, 9002]); assert.equal(v.fatura, 9002);
    const mails = mailSent.length;
    assert.equal((await adm('POST', '/api/admin/orders/' + b + '/resolve', { acao: 'entregue' })).status, 200);
    const row = db.prepare('SELECT status, autopay FROM orders WHERE id=?').get(b);
    assert.equal(row.status, 'delivered'); assert.equal(row.autopay, 'sent');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mailSent.length, mails + 1);
    // já resolvido: não resolve de novo; sem sessão: 401
    assert.equal((await adm('POST', '/api/admin/orders/' + b + '/resolve', { acao: 'liberar' })).status, 409);
    assert.equal((await fetch(base + '/api/admin/orders/' + a + '/verify', { method: 'POST', headers: { 'x-painel': '1' } })).status, 401);
  } finally { _setInvoiceChecker(null); _setInvoicePayer(null); _setReceiptChecker(null); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
});

// ---------- robustez da automação ----------
test('automático: falha passageira na conferência tenta de novo e entrega; falha persistente vai p/ manual', async () => {
  let falhas = 2, chamadas = 0;
  const pays = [];
  _setInvoiceChecker(async () => { chamadas++; if (falhas-- > 0) throw new Error('o bot não respondeu em 15 s'); return { currency: 'XTR', stars: 26, account: 'jogador_teste', produto: '1 000 coins', msgId: 1 }; });
  _setInvoicePayer(async (a) => { pays.push(a); return { stars: 26, account: a.expectAccount, produto: '', botReply: '' }; });
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await adm('POST', '/api/admin/autopay', { mode: 2 });
    const a = await (await postJ('/api/orders', { product: 'c1000', gameId: '161611', email: 'rt1@x.com' })).json();
    await pagar(a.token);
    await espera(20);
    // durante as novas tentativas o cliente segue vendo "entregando automaticamente"
    const c1 = await (await fetch(base + '/api/orders/' + a.token, { headers: freshIP() })).json();
    assert.ok(c1.status === 'delivered' || c1.entrega === 'auto');
    await ateQue(() => pays.length === 1 && db.prepare('SELECT status FROM orders WHERE id=?').get(a.id).status === 'delivered');
    assert.equal(chamadas, 3); assert.equal(pays.length, 1);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(a.id).status, 'delivered');
    assert.ok(!tgSent.some((m) => m.text.includes('MANUAL necessária #' + a.id)));
    // persistente (3 falhas) → manual + aviso
    falhas = 99; chamadas = 0;
    const b = await (await postJ('/api/orders', { product: 'c1000', gameId: '161612', email: 'rt2@x.com' })).json();
    await pagar(b.token);
    await ateQue(() => tgSent.some((m) => m.text.includes('MANUAL necessária #' + b.id)));
    assert.equal(chamadas, 3);
    assert.ok(tgSent.some((m) => m.text.includes('MANUAL necessária #' + b.id)));
    assert.equal((await (await fetch(base + '/api/orders/' + b.token, { headers: freshIP() })).json()).entrega, 'manual');
    // erro não passageiro (bot respondeu sem fatura) não repete
    falhas = 0; chamadas = 0;
    _setInvoiceChecker(async () => { chamadas++; throw new Error('o bot respondeu sem fatura: "Player not found"'); });
    const c = await (await postJ('/api/orders', { product: 'c1000', gameId: '161613', email: 'rt3@x.com' })).json();
    await pagar(c.token);
    await espera(100);
    assert.equal(chamadas, 1);
  } finally { _setInvoiceChecker(null); _setInvoicePayer(null); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
});

test('sessão da conta separada caiu: alerta 🔌 e pagamento automático pausa', async () => {
  _setInvoiceChecker(async () => ({}));
  _setStarsReader(async () => { throw Object.assign(new Error('x'), { errorMessage: 'AUTH_KEY_UNREGISTERED' }); });
  try {
    await adm('POST', '/api/admin/autopay', { mode: 2 });
    await adm('POST', '/api/admin/stars/sync');
    assert.match(tgSent.at(-1).text, /sessão da conta separada do Telegram CAIU/);
    assert.match(tgSent.at(-1).text, /tg-user-login\.mjs/);
    db.exec("UPDATE orders SET chk='{\"status\":\"ok\"}' WHERE id=(SELECT MAX(id) FROM orders WHERE status='paid')");
    const o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.status === 'paid' && x.canPay);
    assert.match(o.canPay.why, /sessão da conta separada caiu/);
  } finally { _setStarsReader(null); _setInvoiceChecker(null); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
});

test('resumo diário: números do dia, autonomia de Stars e envio 1x por dia', async () => {
  const txt = dailySummary();
  assert.match(txt, /📊 Resumo de \d{2}\/\d{2}\/\d{4}/);
  assert.match(txt, /💰 \d+ vendas? · R\$/);
  assert.match(txt, /📦 \d+ entregues? \(\d+ automáticas?, \d+ manual\)/);
  assert.match(txt, /⭐ \d+★ gastos hoje/);
  // dia sem nada
  const vazio = dailySummary('2000-01-01');
  assert.match(vazio, /💰 0 vendas · R\$\s?0,00/);
  // envia uma vez só por dia (a hora padrão é 23h; força o horário com o setting)
  db.prepare("DELETE FROM settings WHERE k='summary_day'").run();
  const n = tgSent.length;
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-11-08T02:30:00Z'); // 23:30 em Brasília
  try { summaryTick(); summaryTick(); } finally { Date.now = realNow; }
  assert.equal(tgSent.length, n + 1);
  assert.match(tgSent.at(-1).text, /Resumo de 07\/11\/2026/);
});

test('página "Como funciona": responde em /como-funciona e a loja aponta para ela', async () => {
  const r = await fetch(base + '/como-funciona');
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Como funciona<\/h1>/); assert.match(h, /href="\/perguntas-frequentes"/);
  const f = await fetch(base + '/perguntas-frequentes');
  assert.equal(f.status, 200);
  const fh = await f.text();
  assert.match(fh, /<h1>Perguntas frequentes<\/h1>/); assert.match(fh, /FAQPage/);
  // rodapé igual nas 3 páginas, marcando a página atual
  const loja = await (await fetch(base + '/')).text();
  for (const [p, cur] of [[loja, '/'], [h, '/como-funciona'], [fh, '/perguntas-frequentes']]) {
    assert.match(p, /<footer class="ft">/);
    assert.ok(p.includes(`href="${cur}" aria-current="page"`));
  }
});

test('termos de uso e política de privacidade: no ar, linkados no rodapé e no aceite do Pix', async () => {
  const t = await (await fetch(base + '/termos-de-uso')).text();
  assert.match(t, /<h1>Termos de uso<\/h1>/);
  assert.match(t, /reembolso só é possível quando o item não foi entregue/);
  assert.match(t, /inclusive se o ID foi digitado errado/);
  const p = await (await fetch(base + '/politica-de-privacidade')).text();
  assert.match(p, /<h1>Política de privacidade<\/h1>/); assert.match(p, /LGPD/);
  const loja = await (await fetch(base + '/')).text();
  assert.match(loja, /class="terms">Ao gerar o Pix você concorda/);
  for (const pg of [loja, t, p]) assert.match(pg, /class="ft-docs"><a href="\/termos-de-uso">/);
});

test('suporte: formulário valida, vincula o pedido pelo link e envia e-mail (Responder → cliente) + Telegram', async () => {
  const sup = (b) => fetch(base + '/api/suporte', { method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() }, body: JSON.stringify(b) });
  assert.equal((await fetch(base + '/suporte')).status, 200);
  assert.equal((await sup({ email: 'x', assunto: 'outro', msg: 'mensagem longa o bastante' })).status, 400);
  assert.equal((await sup({ email: 'a@b.com', assunto: 'hack', msg: 'mensagem longa o bastante' })).status, 400);
  assert.equal((await sup({ email: 'a@b.com', assunto: 'outro', msg: 'curta' })).status, 400);
  // robô (campo invisível): finge sucesso e não envia nada
  const m0 = mailSent.length;
  assert.equal((await sup({ email: 'a@b.com', assunto: 'outro', msg: 'mensagem de robô aqui', site: 'x' })).status, 200);
  assert.equal(mailSent.length, m0);
  // com o link do pedido: pedido verificado, status e alerta de e-mail diferente
  mpShouldApprove = true;
  const p = await (await postJ('/api/orders', { product: 'c1000', gameId: '171711', email: 'dono@x.com' })).json();
  await pagar(p.token);
  const r = await sup({ email: 'outro@x.com', assunto: 'naochegou', msg: 'Paguei e <b>não</b> chegou ainda.', token: p.token, pedido: '999', gameId: '1' });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  const m = mailSent.at(-1);
  assert.deepEqual(m.to, ['suporte@recargaflame.com.br']);
  assert.equal(m.reply_to, 'outro@x.com');
  assert.match(m.subject, new RegExp(`\\[Suporte #${id}\\] Meu pedido não chegou — pedido #${p.id}`));
  assert.match(m.text, new RegExp(`Pedido #${p.id} \\(verificado\\).*ID 171711`));
  assert.match(m.text, /e-mail diferente do usado no pedido/);
  assert.ok(m.html.includes('&#60;b&#62;não&#60;/b&#62;')); // HTML do cliente escapado
  assert.ok(tgSent.some((t) => t.text.includes(`📩 Suporte #${id}`)));
  // sem link: número informado não é tratado como verificado
  await sup({ email: 'c@d.com', assunto: 'duvida', msg: 'Vocês vendem passe de batalha?', pedido: '#55' });
  assert.match(mailSent.at(-1).text, /Pedido informado: #55 \(não verificado\)/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM support_tickets').get().n, 2);
});

test('link curto de cupom: /aquila → /?cupom=AQUILA; inativo vai p/ a loja (aviso); inexistente → 404; rotas fixas não são afetadas', async () => {
  const r = await fetch(base + '/aquila', { redirect: 'manual' });
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/?cupom=AQUILA');
  const off = await fetch(base + '/OFF1', { redirect: 'manual' }); // cupom desativado: loja avisa e mostra preço cheio
  assert.equal(off.status, 302); assert.equal(off.headers.get('location'), '/?cupom=OFF1');
  assert.equal((await fetch(base + '/api/coupon/OFF1', { headers: freshIP() })).status, 404); // e não dá desconto
  assert.equal((await fetch(base + '/naoexiste', { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(base + '/suporte', { redirect: 'manual' })).status, 200);
  assert.equal((await fetch(base + '/login', { redirect: 'manual' })).status, 200);
});

test('custo da Star: recarga com valor atualiza o custo dos NOVOS pedidos; vendas antigas mantêm o da época', async () => {
  const antes = db.prepare("SELECT id, star_cost FROM orders WHERE status IN ('paid','delivered') ORDER BY id DESC LIMIT 1").get();
  assert.equal(antes.star_cost, 0.0875);
  const n = tgSent.length;
  // recarga grande e cara (R$ 0,10/★) cobre todo o saldo → custo vira 0,10
  const saldoAntes = (await (await adm('GET', '/api/admin/stars')).json()).saldo;
  await adm('POST', '/api/admin/stars', { kind: 'compra', stars: 100000, cents: 1000000 });
  const s = await (await adm('GET', '/api/admin/stars')).json();
  assert.equal(s.saldo, saldoAntes); // compra não mexe no saldo
  // a compra de 100.000★ sozinha já cobre o saldo atual → custo = R$ 0,10
  assert.equal(s.custoAtual, 0.1); assert.equal(s.custoFonte, 'recargas');
  const msg = tgSent.slice(n).find((m) => /Custo da Star atualizado/.test(m.text));
  assert.ok(msg); assert.match(msg.text, /0,0875 → R\$ 0,1000/); assert.match(msg.text, /compras de Stars/);
  // novo pedido congela o custo novo; o antigo continua 0,0875
  mpShouldApprove = true;
  const p = await (await postJ('/api/orders', { product: 'c1000', gameId: '181811', email: 'sc@x.com' })).json();
  assert.equal(db.prepare('SELECT star_cost FROM orders WHERE id=?').get(p.id).star_cost, s.custoAtual);
  assert.equal(db.prepare('SELECT star_cost FROM orders WHERE id=?').get(antes.id).star_cost, 0.0875);
  // apagar a compra volta ao custo anterior
  const rec = s.compras.find((c) => c.stars === 100000);
  assert.equal((await adm('DELETE', '/api/admin/stars/compras/' + rec.id)).status, 200);
  assert.equal((await (await adm('GET', '/api/admin/stars')).json()).custoAtual, 0.0875);
});

test('custo da Star exato: conta só a parte de cada compra que ainda está no saldo', async () => {
  // saldo manual de 3.000★; compras: antiga 2.000★ a R$ 0,0875 e nova 2.500★ a R$ 0,092
  _setStarsReader(null);
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 3000 });
  await adm('POST', '/api/admin/stars', { kind: 'compra', stars: 2000, cents: 17500 });
  await adm('POST', '/api/admin/stars', { kind: 'compra', stars: 2500, cents: 23000 });
  let s = await (await adm('GET', '/api/admin/stars')).json();
  // 2.500 × 0,092 + 500 × 0,0875 = 273,75 ÷ 3.000 = 0,09125
  assert.ok(Math.abs(s.custoAtual - 0.09125) < 1e-9, String(s.custoAtual));
  // saldo cai para 2.000 → só a compra nova
  await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 2000 });
  await adm('POST', '/api/admin/stars', { kind: 'compra', stars: 1, cents: 9 }); // dispara recálculo
  s = await (await adm('GET', '/api/admin/stars')).json();
  // 1 × 0,09 + 1.999 × 0,092
  assert.ok(Math.abs(s.custoAtual - (0.09 + 1999 * 0.092) / 2000) < 1e-9, String(s.custoAtual));
  for (const c of s.compras.filter((c) => [2000, 2500, 1].includes(c.stars))) await adm('DELETE', '/api/admin/stars/compras/' + c.id);
});

test('tetos do pagamento automático editáveis no painel', async () => {
  const lim = (b) => fetch(base + '/api/admin/autopay/limites', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: JSON.stringify(b) });
  assert.equal((await fetch(base + '/api/admin/autopay/limites', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-painel': '1' }, body: '{"max":5,"dia":10}' })).status, 401);
  assert.equal((await lim({ max: 0, dia: 10 })).status, 400);
  assert.equal((await lim({ max: 500, dia: 100 })).status, 400); // diário menor que por pedido
  assert.equal((await lim({ max: 20, dia: 30 })).status, 200);
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 26, account: 'jogador_teste', produto: '', msgId: 1 }));
  try {
    await adm('POST', '/api/admin/autopay', { mode: 1 });
    mpShouldApprove = true;
    const j = await (await postJ('/api/orders', { product: 'c1000', gameId: '191911', email: 'lim@x.com' })).json();
    await pagar(j.token); await new Promise((r) => setTimeout(r, 40));
    const o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === j.id);
    assert.match(o.canPay.why, /acima do teto por pedido \(20★\)/); // 26★ > 20★
    const s = await (await adm('GET', '/api/admin/stars')).json();
    assert.equal(s.autopay.max, 20); assert.equal(s.autopay.dia, 30);
  } finally { _setInvoiceChecker(null); await lim({ max: 1000, dia: 4000 }); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
});

// ---------- prévia do link, funil e lembretes de Pix ----------
test('prévia do link: tags Open Graph; link de cupom ativo mostra o desconto', async () => {
  const h = await (await fetch(base + '/')).text();
  assert.match(h, /<meta property="og:image" content="https:\/\/recargaflame\.com\.br\/img\/og\.jpg">/);
  assert.match(h, /og:title" content="Recarga Flame — Coins e passes/);
  const c = await (await fetch(base + '/?cupom=aquila')).text();
  assert.match(c, /og:title" content="5% OFF com o cupom AQUILA — Recarga Flame"/);
  assert.match(c, /og:url" content="https:\/\/recargaflame\.com\.br\/\?cupom=AQUILA"/);
  const off = await (await fetch(base + '/?cupom=OFF1')).text(); // desativado → prévia padrão
  assert.match(off, /og:title" content="Recarga Flame — Coins e passes/);
  for (const p of ['/como-funciona', '/perguntas-frequentes', '/suporte', '/termos-de-uso', '/politica-de-privacidade'])
    assert.match(await (await fetch(base + p)).text(), /og:image/, p);
});

test('funil: etapas do cliente + pedido entram no analytics por aparelho, cupom e origem; robô ignorado', async () => {
  const dev = 'cf_dev=FUNILaaaaaaaaaaaaaaaaa';
  const ua = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Mobile Safari', Cookie: dev };
  const ev = (b, h = ua) => fetch(base + '/api/ev', { method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP(), ...h }, body: JSON.stringify(b) });
  assert.equal((await ev({ ev: 'visit', src: 'youtube', coupon: 'aquila' })).status, 204);
  await ev({ ev: 'visit', src: 'youtube', coupon: 'aquila' }); // mesmo aparelho: conta 1
  await ev({ ev: 'lookup', coupon: 'AQUILA' });
  await ev({ ev: 'select', coupon: 'AQUILA' });
  await ev({ ev: 'hack' }); // etapa inválida: ignorada
  await ev({ ev: 'visit', src: 'google' }, { 'User-Agent': 'WhatsApp/2.23 Android', Cookie: 'cf_dev=BOTbbbbbbbbbbbbbbbbbbb' }); // prévia de link
  // pedido do mesmo aparelho → pix/pago
  mpShouldApprove = true;
  const r = await fetch(base + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP(), Cookie: dev },
    body: JSON.stringify({ product: 'c1000', gameId: '202021', email: 'fun@x.com', coupon: 'AQUILA' }) });
  const { token } = await r.json();
  await pagar(token);
  const a = await (await adm('GET', '/api/admin/analytics')).json();
  const n = Object.fromEntries(a.funil.etapas.map((e) => [e.ev, e.n]));
  assert.ok(n.visit >= 1 && n.lookup >= 1 && n.select >= 1 && n.pix >= 1 && n.paid >= 1);
  const yt = a.funil.origens.find((o) => o.k === 'youtube');
  assert.ok(yt && yt.visit >= 1 && yt.pix >= 1 && yt.paid >= 1, JSON.stringify(a.funil.origens)); // pix/pago herdam a origem da visita
  assert.ok(!a.funil.origens.some((o) => o.k === 'google')); // robô não contou
  const aq = a.funil.cupons.find((c) => c.k === 'AQUILA');
  assert.ok(aq && aq.paid >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE dev='FUNILaaaaaaaaaaaaaaaaa' AND ev='visit'").get().n, 2);
});

test('lembretes de Pix: avisa 1x quando falta ≤ 10 min e 1x quando expira; não avisa se já fez pedido novo', async () => {
  mpShouldApprove = false;
  const novo = async (gid, email) => (await postJ('/api/orders', { product: 'c1000', gameId: gid, email })).json();
  const a = await novo('212121', 'lemb@x.com');
  db.prepare('UPDATE orders SET expires_at=? WHERE id=?').run(Date.now() + 8 * 60_000, a.id);
  const m0 = mailSent.length;
  await remindPending();
  assert.equal(mailSent.length, m0 + 1);
  assert.match(mailSent.at(-1).subject, new RegExp(`Seu Pix vence em \\d+ min — pedido #${a.id}`));
  assert.deepEqual(mailSent.at(-1).to, ['lemb@x.com']);
  assert.ok(mailSent.at(-1).html.includes('#pedido=' + a.token));
  await remindPending(); // não repete
  assert.equal(mailSent.length, m0 + 1);
  // venceu → e-mail de expirado, 1x
  db.prepare('UPDATE orders SET expires_at=? WHERE id=?').run(Date.now() - 10 * 60_000, a.id);
  await expirePending();
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(a.id).status, 'cancelled');
  await new Promise((r) => setTimeout(r, 20));
  assert.match(mailSent.at(-1).subject, new RegExp(`Seu Pix expirou — pedido #${a.id}`));
  const m1 = mailSent.length;
  await expirePending();
  assert.equal(mailSent.length, m1);
  // cliente já gerou outro pedido → nenhum lembrete para o antigo
  const b = await novo('212122', 'lemb2@x.com');
  await novo('212122', 'lemb2@x.com');
  db.prepare('UPDATE orders SET expires_at=? WHERE id=?').run(Date.now() + 8 * 60_000, b.id);
  const m2 = mailSent.length;
  await remindPending();
  assert.ok(!mailSent.slice(m2).some((m) => m.subject.includes('#' + b.id)));
  mpShouldApprove = true;
});

test('aprovar e pagar: pedido em REVISAR só paga com aprovação do operador (painel e Telegram)', async () => {
  RISK.first = 5000; // regra antiga (1ª compra ≥ R$ 50) para provocar revisão com 50.000 Coins
  const pays = [];
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 771, account: 'jogador_teste', produto: '50 000 coins', msgId: 1 }));
  _setInvoicePayer(async (a) => { pays.push(a); return { stars: a.expectStars, account: a.expectAccount, produto: '', botReply: '' }; });
  try {
    await adm('POST', '/api/admin/autopay', { mode: 1 });
    mpShouldApprove = true;
    const novo = async (gid) => { const j = await (await postJ('/api/orders', { product: 'c50000', gameId: gid, email: gid + '@ap2.com' })).json(); await pagar(j.token); await new Promise((r) => setTimeout(r, 40)); return j.id; };
    // 1ª compra ≥ R$ 50 → REVISAR: sem "Pagar", com "Aprovar e pagar"
    const a = await novo('222201');
    let o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === a);
    assert.ok(o.risk.some((r) => /primeira compra/.test(r)));
    assert.equal(o.canPay.ok, false); assert.equal(o.canApprove, true);
    assert.equal((await adm('POST', '/api/admin/orders/' + a + '/autopay')).status, 409); // sem aprovação não paga
    const kb = lastCall('editMessageText').body.reply_markup.inline_keyboard.flat();
    assert.ok(kb.some((b) => b.callback_data === 'a:' + a && /Aprovar e pagar 771★/.test(b.text)));
    assert.ok(!kb.some((b) => b.callback_data === 'p:' + a));
    // painel: aprovar e pagar
    assert.equal((await fetch(base + '/api/admin/orders/' + a + '/aprovar', { method: 'POST', headers: { 'x-painel': '1', ...freshIP() } })).status, 401);
    const r = await adm('POST', '/api/admin/orders/' + a + '/aprovar');
    assert.equal(r.status, 200);
    const row = db.prepare('SELECT status, autopay, approved_at FROM orders WHERE id=?').get(a);
    assert.equal(row.status, 'delivered'); assert.equal(row.autopay, 'sent'); assert.ok(row.approved_at > 0);
    assert.equal(pays.length, 1);
    assert.equal((await adm('POST', '/api/admin/orders/' + a + '/aprovar')).status, 409); // não paga 2x
    // Telegram: a → confirmação (não paga) → A paga; estranho não
    const b = await novo('222202');
    const msgId = db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(b).tg_msg;
    await cb('A:' + b, msgId, 999);
    await cb('a:' + b, msgId);
    assert.equal(pays.length, 1);
    await cb('A:' + b, msgId);
    assert.equal(pays.length, 2);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(b).status, 'delivered');
    assert.ok(tgCalls.some((c) => c.method === 'editMessageText' && c.body.message_id === msgId && c.body.text.includes(`Pedido #${b} · aprovado por você, pago no bot (771★) e entregue`)));
    assert.ok(!tgSent.some((m) => m.text.includes(`#${b}`) && /pago no bot/.test(m.text)));
  } finally { RISK.first = null; _setInvoiceChecker(null); _setInvoicePayer(null); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
});

test('margem por produto, ranking por lucro e desempenho de cupom (visitas/conversão/lucro da loja)', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  const prods = await (await adm('GET', '/api/admin/products')).json();
  const c1 = prods.find((p) => p.key === 'c1000');
  const s = await (await adm('GET', '/api/admin/stars')).json();
  const esperado = c1.cents - c1.stars * s.custoAtual * 100 - c1.cents * s.taxaMP;
  assert.equal(c1.lucro, Math.round(esperado)); assert.ok(Math.abs(c1.margem - esperado / c1.cents) < 1e-9);
  const a = await (await adm('GET', '/api/admin/analytics')).json();
  assert.ok(a.produtos.length > 0 && 'lucro' in a.produtos[0] && 'margem' in a.produtos[0]);
  for (let i = 1; i < a.produtos.length; i++) assert.ok(a.produtos[i - 1].lucro >= a.produtos[i].lucro); // ordenado por lucro
  const rep = await (await adm('GET', '/api/admin/coupons/report')).json();
  const aq = rep.cupons.find((c) => c.code === 'AQUILA');
  assert.ok(aq.visitas >= 1); // visitas do teste do funil
  assert.equal(aq.conversao, aq.pedidos / aq.visitas);
  assert.equal(aq.lucroLoja, aq.lucro - aq.comissao);
});

test('entregas: registra como foi entregue e o motivo de não ser automática; analytics agrupa', async () => {
  RISK.first = 5000; // regra antiga (1ª compra ≥ R$ 50) para provocar revisão com 50.000 Coins
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 771, account: 'jogador_teste', produto: '', msgId: 1 }));
  _setInvoicePayer(async (a) => ({ stars: a.expectStars, account: a.expectAccount, produto: '', botReply: '' }));
  try {
    await adm('POST', '/api/admin/autopay', { mode: 2 });
    await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 50000 }); // saldo de sobra (testes anteriores gastaram)
    await adm('POST', '/api/admin/autopay/limites', { max: 1000, dia: 100000 });
    mpShouldApprove = true;
    // 1ª compra ≥ R$ 50 no automático → não paga sozinho, motivo = revisão: primeira compra; depois aprovado
    const j = await (await postJ('/api/orders', { product: 'c50000', gameId: '232301', email: 'ent@x.com' })).json();
    await pagar(j.token); await new Promise((r) => setTimeout(r, 60));
    assert.match(db.prepare('SELECT manual_motivo FROM orders WHERE id=?').get(j.id).manual_motivo, /REVISAR: primeira compra/);
    { const rr = await adm('POST', '/api/admin/orders/' + j.id + '/aprovar'); assert.equal(rr.status, 200, await rr.text()); }
    assert.equal(db.prepare('SELECT entrega_via FROM orders WHERE id=?').get(j.id).entrega_via, 'aprovado');
    // entrega manual pelo painel
    await adm('POST', '/api/admin/autopay', { mode: 0 });
    const k = await (await postJ('/api/orders', { product: 'c1000', gameId: '232302', email: 'ent2@x.com' })).json();
    await pagar(k.token); await new Promise((r) => setTimeout(r, 40));
    await adm('POST', '/painel/' + k.id + '/entregue');
    assert.equal(db.prepare('SELECT entrega_via FROM orders WHERE id=?').get(k.id).entrega_via, 'manual');
    const a = await (await adm('GET', '/api/admin/analytics')).json();
    const tipos = Object.fromEntries(a.entregaTipos.map((x) => [x.tipo, x.n]));
    assert.ok(tipos.aprovado >= 1 && tipos.manual >= 1);
    assert.ok(a.motivos.some((m) => m.motivo === 'Revisão: primeira compra'));
  } finally { RISK.first = null; _setInvoiceChecker(null); _setInvoicePayer(null); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
});

test('previsão de Stars: ritmo, até quando e quanto comprar', async () => {
  // saldo manual 3.000★; 1.400★ entregues "ontem" → ritmo ~700★/dia (2 dias de histórico)
  db.exec("DELETE FROM stars_ledger");
  db.prepare("INSERT INTO stars_ledger (kind, delta, nota) VALUES ('ajuste', 4400, 'x')").run();
  db.prepare("INSERT INTO stars_ledger (kind, delta, order_id, created_at) VALUES ('entrega', -1400, 999001, datetime('now','-1 day'))").run();
  const f = starsForecast();
  assert.equal(f.saldo, 3000);
  assert.ok(f.ritmo >= 600 && f.ritmo <= 1400, String(f.ritmo));
  assert.ok(f.dias > 0 && f.dias < 6);
  assert.ok(f.comprar > 0 && f.comprar % 100 === 0); // cobre 14 dias + reserva
  assert.match(f.ate, /^\d{4}-\d{2}-\d{2}$/);
  const s = await (await fetch(base + '/api/admin/stars', { headers: { Cookie: COOKIE, 'x-painel': '1', ...freshIP() } })).json();
  assert.ok(s.previsao && s.previsao.comprar === f.comprar);
  assert.match(dailySummary(), /🛒 Compre ~\d+★ \(≈ R\$/);
  db.exec("DELETE FROM stars_ledger WHERE order_id=999001");
});

test('analytics: horários/dias de pico e clientes (novos, voltaram, recompra, intervalo, top)', async () => {
  const get = async (q = '') => (await fetch(base + '/api/admin/analytics' + q, { headers: { Cookie: COOKIE, 'x-painel': '1', ...freshIP() } })).json();
  // cliente com 2 compras: uma há 10 dias (antes do período) e uma hoje
  const mk = (gid, when, cents) => db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, status, created_at, paid_at, prod_nome, prod_stars, star_cost)
    VALUES (?, 'c1000', ?, ?, 'volta', 'v@x.com', 'delivered', datetime('now', ?), datetime('now', ?), '1.000 Coins', 26, 0.0875)`).run('t' + gid + when, cents, gid, when, when);
  mk('242401', '-10 days', 390); mk('242401', '-1 minutes', 390);
  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const a = await get(`?from=${hoje}&to=${hoje}`);
  assert.equal(a.porHora.length, 24); assert.equal(a.porSemana.length, 7);
  assert.equal(a.porHora.reduce((s, h) => s + h.n, 0), a.vendas);
  assert.equal(a.porSemana.reduce((s, d) => s + d.n, 0), a.vendas);
  const c = a.clientes;
  assert.equal(c.total, c.novos + c.voltaram);
  const v = c.top.find((x) => x.id === '242401');
  assert.ok(v && v.compras === 1 && v.comprasTotal === 2);
  assert.ok(c.voltaram >= 1); // 242401 já tinha comprado antes do período
  assert.ok(c.intervaloDias !== null); // mediana entre todos os clientes do período (outros testes compram várias vezes no mesmo minuto)
});

test('avatar: sem foto → imagem padrão em cache e o CounterFlame não é consultado de novo', async () => {
  const get = () => fetch(base + '/api/player/888777/avatar', { headers: freshIP() });
  const n = avatarCalls.length;
  const r = await get();
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(r.headers.get('cache-control'), /max-age=21600/);
  await get(); await get();
  assert.equal(avatarCalls.length, n + 1); // só a 1ª consultou o CounterFlame
  const ok = await fetch(base + '/api/player/749125/avatar', { headers: freshIP() });
  assert.equal(ok.headers.get('content-type'), 'image/jpeg'); assert.match(ok.headers.get('cache-control'), /max-age=3600/);
});

test('robots.txt e sitemap.xml', async () => {
  const r = await (await fetch(base + '/robots.txt')).text();
  assert.match(r, /Disallow: \/painel/); assert.match(r, /Sitemap: https:\/\/recargaflame\.com\.br\/sitemap\.xml/);
  const s = await fetch(base + '/sitemap.xml');
  assert.equal(s.status, 200);
  const x = await s.text();
  for (const p of ['/como-funciona', '/perguntas-frequentes', '/termos-de-uso']) assert.ok(x.includes('https://recargaflame.com.br' + p));
  assert.ok(!x.includes('/painel'));
});

test('limites em 24h seguem o produto mais caro: 3ª compra dele → revisar; 5ª → recusada', async () => {
  const prods = await (await fetch(base + '/api/products', { headers: freshIP() })).json();
  const top = prods.reduce((a, b) => (b.cents > a.cents ? b : a));
  const max = top.cents;
  assert.equal(RISK.day, 3 * max); assert.equal(RISK.cap, 4 * max);
  const ins = (gid, n, status = 'delivered') => { for (let i = 0; i < n; i++) db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, status, created_at, paid_at, prod_nome, prod_stars)
    VALUES (?, ?, ?, ?, 'baleia', ?, ?, datetime('now'), datetime('now'), 'top', 10)`).run(gid + '-' + i + status, top.key, max, gid, gid + '@x.com', status); };
  // 4 pagas hoje → a 5ª é recusada no checkout
  ins('252501', 4);
  const r = await postJ('/api/orders', { product: top.key, gameId: '252501', email: 'outro5@x.com' });
  assert.equal(r.status, 409); assert.match((await r.json()).error, /Limite diário/);
  // 2ª compra (2 no dia, contando ela): não pede revisão por "muito em 24h"; 3ª: pede
  ins('252502', 1); ins('252502', 1, 'paid');
  let o = db.prepare("SELECT * FROM orders WHERE game_id='252502' AND status='paid'").get();
  assert.ok(!riskOf(o).some((x) => /pagos em 24h/.test(x)));
  ins('252503', 2); ins('252503', 1, 'paid');
  o = db.prepare("SELECT * FROM orders WHERE game_id='252503' AND status='paid'").get();
  assert.ok(riskOf(o).some((x) => /pagos em 24h/.test(x)));
  db.exec("DELETE FROM orders WHERE game_id IN ('252501','252502','252503')");
});

test('1ª compra: só o item mais caro (preço de tabela) vai para revisão', async () => {
  const prods = await (await fetch(base + '/api/products', { headers: freshIP() })).json();
  const top = prods.reduce((a, b) => (b.cents > a.cents ? b : a));
  const outro = prods.filter((p) => p.key !== top.key).reduce((a, b) => (b.cents > a.cents ? b : a));
  assert.equal(RISK.first, top.cents);
  const mk = (gid, p, cents, list) => db.prepare(`INSERT INTO orders (token, product, cents, list_cents, game_id, nickname, email, status, created_at, paid_at, prod_nome, prod_stars)
    VALUES (?, ?, ?, ?, ?, 'n', ?, 'paid', datetime('now'), datetime('now'), 'x', 10)`).run('fc' + gid, p, cents, list, gid, gid + '@f.com');
  mk('262601', outro.key, outro.cents, outro.cents);                       // 2º mais caro, 1ª compra → sem revisão
  mk('262602', top.key, top.cents, top.cents);                             // mais caro, 1ª compra → revisão
  mk('262603', top.key, Math.round(top.cents * 0.95), top.cents);          // mais caro com cupom → revisão também
  const r = (gid) => riskOf(db.prepare('SELECT * FROM orders WHERE game_id=?').get(gid));
  assert.ok(!r('262601').some((x) => /primeira compra/.test(x)));
  assert.ok(r('262602').some((x) => /primeira compra/.test(x)));
  assert.ok(r('262603').some((x) => /primeira compra/.test(x)));
  db.exec("DELETE FROM orders WHERE game_id IN ('262601','262602','262603')");
});

test('reembolso: só pago e não entregue; 1 vez; cliente vê "valor devolvido"; não vira bloqueio de estorno', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  const calls = [];
  let falha = null;
  _setRefundCaller(async (o) => { calls.push(o.id); if (falha) return { ok: false, erro: falha }; return { ok: true, id: 555, estado: 'approved' }; });
  try {
    mpShouldApprove = true;
    const p = await (await postJ('/api/orders', { product: 'c1000', gameId: '272701', email: 'rb@x.com' })).json();
    await pagar(p.token);
    // entregue → sem reembolso
    const q = await (await postJ('/api/orders', { product: 'c1000', gameId: '272702', email: 'rb2@x.com' })).json();
    await pagar(q.token); await adm('POST', '/painel/' + q.id + '/entregue');
    assert.equal((await adm('POST', '/api/admin/orders/' + q.id + '/reembolsar')).status, 409);
    // sem sessão → 401
    assert.equal((await fetch(base + '/api/admin/orders/' + p.id + '/reembolsar', { method: 'POST', headers: { 'x-painel': '1', ...freshIP() } })).status, 401);
    // MP recusa → erro, pedido sai da fila e pode tentar de novo
    falha = 'insufficient_amount';
    let r = await adm('POST', '/api/admin/orders/' + p.id + '/reembolsar');
    assert.equal(r.status, 409); assert.match((await r.json()).error, /insufficient_amount/);
    // aviso do pedido editado (cancelado, ainda precisa reembolsar, botão de reembolso), sem mensagem nova
    const eR = lastCall('editMessageText').body;
    assert.equal(eR.message_id, db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(p.id).tg_msg);
    assert.match(eR.text, new RegExp(`⚠️ Pedido #${p.id} · reembolso recusado pelo Mercado Pago`)); assert.match(eR.text, /insufficient_amount/);
    assert.match(eR.text, /ainda precisa receber/); assert.equal(eR.reply_markup.inline_keyboard[0][0].callback_data, 'r:' + p.id);
    assert.ok(!tgSent.some((m) => m.text.includes(`#${p.id}`) && /recus/.test(m.text)));
    let row = db.prepare('SELECT status, refund_state FROM orders WHERE id=?').get(p.id);
    assert.equal(row.status, 'cancelled'); assert.equal(row.refund_state, 'erro');
    falha = null;
    // cancelar e reembolsar (pago na fila) → ok; 2ª vez recusada
    r = await adm('POST', '/api/admin/orders/' + p.id + '/reembolsar');
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT refund_state FROM orders WHERE id=?').get(p.id).refund_state, 'done');
    assert.equal((await adm('POST', '/api/admin/orders/' + p.id + '/reembolsar')).status, 409);
    assert.deepEqual(calls, [p.id, p.id]);
    const edR = lastCall('editMessageText').body;
    assert.equal(edR.message_id, db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(p.id).tg_msg);
    assert.match(edR.text, new RegExp(`💸 Pedido #${p.id} · reembolsado às`)); assert.match(edR.reply_markup.inline_keyboard[0][0].text, /Reembolsado/);
    assert.ok(!tgSent.some((m) => m.text.includes(`#${p.id}`) && /reembolsado/.test(m.text)));
    // cliente
    assert.equal((await (await fetch(base + '/api/orders/' + p.token, { headers: freshIP() })).json()).status, 'refunded');
    // depois o MP avisa "refunded": NÃO bloqueia o cliente (foi a loja que devolveu)
    const before = db.prepare("SELECT COUNT(*) n FROM blocked WHERE value='272701'").get().n;
    const salvo = lastMpBody; lastMpBody = { ...lastMpBody, external_reference: p.token };
    mpStatus = 'refunded';
    const n0 = tgSent.length, c0 = tgCalls.length;
    try { assert.equal((await webhookMP()).status, 200); } finally { mpStatus = null; lastMpBody = salvo; }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM blocked WHERE value='272701'").get().n, before);
    assert.ok(!tgSent.slice(n0).some((m) => /cancelado após pagamento|ESTORNADO/.test(m.text)));
    assert.ok(!tgCalls.slice(c0).some((c) => /cancelado após pagamento|ESTORNADO/.test(c.body?.text || '')));
    // painel mostra
    const o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === p.id);
    assert.equal(o.refund, 'done'); assert.equal(o.refundable, false);
  } finally { _setRefundCaller(null); }
});

test('link curto de cupom mantém a origem (?src=wa) e descarta lixo', async () => {
  const r = await fetch(base + '/aquila?src=wa', { redirect: 'manual' });
  assert.equal(r.headers.get('location'), '/?cupom=AQUILA&src=wa');
  const x = await fetch(base + '/aquila?src=%3Cscript%3E', { redirect: 'manual' });
  assert.equal(x.headers.get('location'), '/?cupom=AQUILA');
});

// ---------- plano de metas dos parceiros ----------
test('plano de metas: faixa pelo faturamento do mês vale p/ todas as vendas; garantida no mês seguinte; IDs próprios fora; meses fechados congelados', async () => {
  db.prepare("INSERT INTO coupons (code, desconto_pct, comissao_pct, ativo, plano, ids_proprios) VALUES ('META1', 5, 0, 1, 'metas', '999555')").run();
  const mes = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
  const [y, m] = mes.split('-').map(Number);
  const ant = new Date(Date.UTC(y, m - 2, 15)).toISOString().slice(0, 10) + ' 15:00:00';
  const ins = (gid, cents, paid) => db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, status, created_at, paid_at, prod_nome, prod_stars, coupon, star_cost)
    VALUES (?, 'c1000', ?, ?, 'p', ?, 'delivered', ?, ?, 'x', 0, 'META1', 0.0875)`).run('m' + gid + paid + cents + Math.random(), cents, gid, gid + '@m.com', paid, paid);
  // mês anterior: R$ 4.500 → atingiu 40%
  ins('300001', 450000, ant);
  // mês atual: R$ 1.000 (faixa atingida 30%) → garantida 35% (uma abaixo de 40%)
  ins('300002', 100000, new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' '));
  // compra do próprio parceiro (ID 999555) não conta
  ins('999555', 900000, new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' '));
  const rep = await (await fetch(base + '/api/admin/coupons/report', { headers: { Cookie: COOKIE, 'x-painel': '1', ...freshIP() } })).json();
  const c = rep.cupons.find((x) => x.code === 'META1');
  assert.equal(c.plano, 'metas');
  assert.equal(c.mesAtual.faturamento, 100000);           // sem a compra própria
  assert.equal(c.mesAtual.ating, 0); assert.equal(c.mesAtual.garant, 1); // atingiu 40% (índice 2) no mês anterior → garantida 35% (índice 1)
  assert.equal(c.mesAtual.pct, 35);
  assert.equal(c.mesAtual.prox.pct, 40); assert.equal(c.mesAtual.prox.falta, 400000 - 100000);
  // lucro de cada venda (prod_stars 0): cents − 0,99% taxa; comissão do mês atual a 35%, do anterior a 40%, própria = 0
  const esperado = Math.round(450000 * (1 - 0.0099) * 0.40) + Math.round(100000 * (1 - 0.0099) * 0.35);
  assert.ok(Math.abs(c.total - esperado) <= 1, c.total + ' vs ' + esperado);
  // mês anterior congelado: mudar as faixas não altera a comissão passada
  db.prepare("INSERT INTO settings (k, v) VALUES ('tiers', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify([{ min: 0, pct: 10 }, { min: 150000, pct: 11 }, { min: 400000, pct: 12 }, { min: 1000000, pct: 13 }]));
  const rep2 = await (await fetch(base + '/api/admin/coupons/report', { headers: { Cookie: COOKIE, 'x-painel': '1', ...freshIP() } })).json();
  const c2 = rep2.cupons.find((x) => x.code === 'META1');
  const antCom = Math.round(450000 * (1 - 0.0099) * 0.40);
  assert.ok(c2.total >= antCom - 1); // o mês fechado segue a 40%
  db.prepare("DELETE FROM settings WHERE k='tiers'").run();
  db.exec("DELETE FROM orders WHERE coupon='META1'"); db.exec("DELETE FROM partner_months WHERE code='META1'"); db.exec("DELETE FROM coupons WHERE code='META1'");
});

test('plano de metas: aviso 🎯 no Telegram quando o parceiro sobe de faixa com uma venda', async () => {
  db.prepare("INSERT INTO coupons (code, desconto_pct, comissao_pct, ativo, plano) VALUES ('META2', 5, 0, 1, 'metas')").run();
  const agora = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, status, created_at, paid_at, prod_nome, prod_stars, coupon)
    VALUES ('mm1', 'c1000', 149000, '300101', 'p', 'a@m2.com', 'delivered', ?, ?, 'x', 0, 'META2')`).run(agora, agora);
  mpShouldApprove = true;
  const j = await (await postJ('/api/orders', { product: 'c1000', gameId: '300102', email: 'b@m2.com', coupon: 'META2' })).json();
  db.prepare('UPDATE orders SET cents=1500 WHERE id=?').run(j.id); // garante cruzar R$ 1.500
  lastMpBody = { ...lastMpBody, transaction_amount: 15 };
  await pagar(j.token); await new Promise((r) => setTimeout(r, 30));
  assert.ok(tgSent.some((m) => /🎯 Parceiro META2 bateu a meta de R\$\s?1\.500,00 no mês → comissão de 35%/.test(m.text)), tgSent.at(-1).text);
  db.exec("DELETE FROM orders WHERE coupon='META2'"); db.exec("DELETE FROM coupons WHERE code='META2'");
});

test('plano de metas — edição: faixas validadas; cupom com plano/IDs próprios; ativar não apaga o plano', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  assert.deepEqual((await (await adm('GET', '/api/admin/tiers')).json()).map((t) => t.pct), [30, 35, 40, 45]);
  assert.equal((await adm('PUT', '/api/admin/tiers', [{ min: 100, pct: 30 }])).status, 400);                       // 1ª não começa em 0
  assert.equal((await adm('PUT', '/api/admin/tiers', [{ min: 0, pct: 30 }, { min: 100000, pct: 25 }])).status, 400); // % caindo
  assert.equal((await adm('PUT', '/api/admin/tiers', [{ min: 0, pct: 30 }, { min: 0, pct: 35 }])).status, 400);     // meta repetida
  const ok = await adm('PUT', '/api/admin/tiers', [{ min: 0, pct: 30 }, { min: 200000, pct: 36 }]);
  assert.equal(ok.status, 200);
  assert.equal((await (await adm('GET', '/api/admin/tiers')).json())[1].pct, 36);
  await adm('PUT', '/api/admin/tiers', [{ min: 0, pct: 30 }, { min: 150000, pct: 35 }, { min: 400000, pct: 40 }, { min: 1000000, pct: 45 }]);
  // cupom: plano fixo + IDs próprios; IDs inválidos recusados
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'PARC2', desconto_pct: 5, comissao_pct: 25, ativo: true, plano: 'fixo', ids_proprios: 'abc' })).status, 400);
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'PARC2', desconto_pct: 5, comissao_pct: 25, ativo: true, plano: 'fixo', ids_proprios: '111; 222 333' })).status, 200);
  let c = (await (await adm('GET', '/api/admin/coupons')).json()).find((x) => x.code === 'PARC2');
  assert.equal(c.plano, 'fixo'); assert.equal(c.ids_proprios, '111, 222, 333'); assert.ok(c.ptoken);
  // desativar pelo painel (envia plano/ids juntos) mantém o plano
  await adm('PUT', '/api/admin/coupons/PARC2', { desconto_pct: 5, comissao_pct: 25, nota: '', ativo: false, plano: c.plano, ids_proprios: c.ids_proprios });
  c = (await (await adm('GET', '/api/admin/coupons')).json()).find((x) => x.code === 'PARC2');
  assert.equal(c.plano, 'fixo'); assert.equal(c.ativo, false);
  db.exec("DELETE FROM coupons WHERE code='PARC2'");
});

test('faixas individuais: parceiro com faixas próprias calcula por elas; voltar ao padrão; inválidas recusadas', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  const proprias = [{ min: 0, pct: 40 }, { min: 50000, pct: 50 }];
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'IND1', desconto_pct: 5, comissao_pct: 0, ativo: true, plano: 'metas', tiers: [{ min: 10, pct: 40 }] })).status, 400);
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'IND1', desconto_pct: 5, comissao_pct: 0, ativo: true, plano: 'metas', tiers: proprias })).status, 200);
  await adm('POST', '/api/admin/coupons', { code: 'IND2', desconto_pct: 5, comissao_pct: 0, ativo: true, plano: 'metas' }); // padrão
  const agora = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
  for (const [cup, gid] of [['IND1', '310001'], ['IND2', '310002']]) db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, status, created_at, paid_at, prod_nome, prod_stars, coupon)
    VALUES (?, 'c1000', 60000, ?, 'p', ?, 'delivered', ?, ?, 'x', 0, ?)`).run('ind' + gid, gid, gid + '@i.com', agora, agora, cup);
  const rep = async () => (await (await adm('GET', '/api/admin/coupons/report')).json()).cupons;
  let r = await rep();
  const i1 = r.find((x) => x.code === 'IND1').mesAtual, i2 = r.find((x) => x.code === 'IND2').mesAtual;
  assert.equal(i1.pct, 50); assert.equal(i1.proprias, true);   // R$ 600 ≥ R$ 500 nas faixas próprias
  assert.equal(i2.pct, 30); assert.equal(i2.proprias, false);  // R$ 600 nas padrão = 30%
  // edição parcial (ex.: ativar/desativar) mantém as faixas próprias
  await adm('PUT', '/api/admin/coupons/IND1', { desconto_pct: 5, comissao_pct: 0, nota: '', ativo: false });
  assert.ok((await (await adm('GET', '/api/admin/coupons')).json()).find((x) => x.code === 'IND1').tiers);
  // voltar ao padrão (tiers: null)
  await adm('PUT', '/api/admin/coupons/IND1', { desconto_pct: 5, comissao_pct: 0, nota: '', ativo: true, tiers: null });
  r = await rep();
  assert.equal(r.find((x) => x.code === 'IND1').mesAtual.pct, 30);
  db.exec("DELETE FROM orders WHERE coupon IN ('IND1','IND2')"); db.exec("DELETE FROM coupons WHERE code IN ('IND1','IND2')");
});

test('página do parceiro: link privado mostra mês, faixa e pagamentos — nunca lucro/margem/custos; novo link invalida o antigo', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  await adm('POST', '/api/admin/coupons', { code: 'PAG1', desconto_pct: 5, comissao_pct: 0, ativo: true, plano: 'metas' });
  const agora = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, status, created_at, paid_at, prod_nome, prod_stars, coupon, star_cost)
    VALUES ('pg1', 'c1000', 100000, '320001', 'p', 'p@g.com', 'delivered', ?, ?, '1.000 Coins', 26, 'PAG1', 0.0875)`).run(agora, agora);
  db.prepare("INSERT INTO coupon_payouts (code, cents, nota) VALUES ('PAG1', 1234, 'Pix teste')").run();
  const rep = (await (await adm('GET', '/api/admin/coupons/report')).json()).cupons.find((x) => x.code === 'PAG1');
  assert.match(rep.linkParceiro, /\/parceiro\/[A-Za-z0-9_-]{20,}$/);
  const path = new URL(rep.linkParceiro).pathname;
  const r = await fetch(base + path, { headers: freshIP() });
  assert.equal(r.status, 200); assert.match(r.headers.get('x-robots-tag'), /noindex/);
  const h = await r.text();
  assert.match(h, /Parceiro PAG1/); assert.match(h, /30% <small>de comissão/); assert.match(h, /Faltam/);
  assert.match(h, /R\$\s?1\.000,00/);       // faturado do mês
  assert.match(h, /Pix teste/);              // pagamento recebido
  for (const proibido of [/lucro/i, /margem/i, /custo/i, /stars/i, /★/]) assert.doesNotMatch(h, proibido, String(proibido));
  // token inválido
  assert.equal((await fetch(base + '/parceiro/abc', { headers: freshIP() })).status, 404);
  // novo link: o antigo para de funcionar
  assert.equal((await adm('POST', '/api/admin/coupons/PAG1/ptoken')).status, 200);
  assert.equal((await fetch(base + path, { headers: freshIP() })).status, 404);
  db.exec("DELETE FROM orders WHERE coupon='PAG1'"); db.exec("DELETE FROM coupon_payouts WHERE code='PAG1'"); db.exec("DELETE FROM coupons WHERE code='PAG1'");
});

test('excluir cupom: só sem vendas pagas nem pagamentos; com histórico pede para desativar', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'APAGAR1', desconto_pct: 5, comissao_pct: 0, ativo: true })).status, 200);
  assert.equal((await adm('DELETE', '/api/admin/coupons/apagar1')).status, 200);
  assert.equal(db.prepare("SELECT 1 FROM coupons WHERE code='APAGAR1'").get(), undefined);
  assert.equal((await adm('DELETE', '/api/admin/coupons/APAGAR1')).status, 404);
  // com venda paga: recusa e mantém
  const comVenda = db.prepare("SELECT coupon FROM orders WHERE coupon IS NOT NULL AND status IN ('paid','delivered') LIMIT 1").get();
  assert.ok(comVenda, 'os testes anteriores criam vendas com cupom');
  const r = await adm('DELETE', '/api/admin/coupons/' + comVenda.coupon);
  assert.equal(r.status, 409); assert.match((await r.json()).error, /desative/);
  assert.ok(db.prepare('SELECT 1 FROM coupons WHERE code=?').get(comVenda.coupon));
  // sem sessão: 401
  assert.equal((await fetch(base + '/api/admin/coupons/' + comVenda.coupon, { method: 'DELETE', headers: { 'x-painel': '1', ...freshIP() } })).status, 401);
});

test('fechamento: a pagar só de meses fechados; faixas agendadas p/ o mês que vem; congela antes de mudar; aviso mensal', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  const PADRAO = [{ min: 0, pct: 30 }, { min: 150000, pct: 35 }, { min: 400000, pct: 40 }, { min: 1000000, pct: 45 }];
  const BAIXAS = [{ min: 0, pct: 10 }, { min: 150000, pct: 11 }, { min: 400000, pct: 12 }, { min: 1000000, pct: 13 }];
  await adm('PUT', '/api/admin/tiers', PADRAO);
  db.prepare("INSERT INTO coupons (code, desconto_pct, comissao_pct, ativo, plano, ptoken) VALUES ('FECH1', 5, 0, 1, 'metas', 'tokfech1tokfech1tokfech1')").run();
  const mes = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
  const [y, m] = mes.split('-').map(Number);
  const ant = new Date(Date.UTC(y, m - 2, 15)).toISOString().slice(0, 10) + ' 15:00:00';
  const agora = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const ins = (gid, cents, paid) => db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, status, created_at, paid_at, prod_nome, prod_stars, coupon, star_cost)
    VALUES (?, 'c1000', ?, ?, 'p', 'f@f.com', 'delivered', ?, ?, 'x', 0, 'FECH1', 0.0875)`).run('f' + gid, cents, gid, paid, paid);
  ins('330001', 450000, ant);   // mês passado: R$ 4.500 → 40%
  ins('330002', 100000, agora); // mês atual: R$ 1.000 → garantida 35%
  const rep = async () => (await (await adm('GET', '/api/admin/coupons/report')).json()).cupons.find((x) => x.code === 'FECH1');
  const fech = Math.round(450000 * (1 - 0.0099) * 0.40), est = Math.round(100000 * (1 - 0.0099) * 0.35);
  let c = await rep();
  assert.ok(Math.abs(c.fechado - fech) <= 1 && Math.abs(c.mesCom - est) <= 1, JSON.stringify(c));
  assert.equal(c.saldo, c.fechado); // o mês atual NÃO entra no a pagar
  // página do parceiro: a receber só dos meses fechados + estimado do mês à parte
  let h = await (await fetch(base + '/parceiro/tokfech1tokfech1tokfech1', { headers: freshIP() })).text();
  assert.match(h, /A receber \(meses fechados\)/); assert.match(h, /Este mês, em andamento/);

  // 2) agendar faixas para o mês que vem: hoje nada muda; parceiro é avisado; dá para cancelar
  const prox = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  assert.equal((await adm('PUT', '/api/admin/tiers?quando=proximo', BAIXAS)).status, 200);
  assert.deepEqual((await (await adm('GET', '/api/admin/tiers/agendado')).json()).agendado, { mes: prox, tiers: BAIXAS });
  assert.deepEqual((await (await adm('GET', '/api/admin/tiers')).json()).map((t) => t.pct), [30, 35, 40, 45]);
  assert.ok(Math.abs((await rep()).mesCom - est) <= 1);
  h = await (await fetch(base + '/parceiro/tokfech1tokfech1tokfech1', { headers: freshIP() })).text();
  assert.match(h, /A partir de \w{3}\/\d{4} as faixas passam a ser: 10%/);
  assert.equal((await adm('DELETE', '/api/admin/tiers/agendado')).status, 200);
  assert.equal((await (await adm('GET', '/api/admin/tiers/agendado')).json()).agendado, null);

  // 3) "aplicar já" congela o mês fechado com as faixas antigas antes de trocar
  db.exec("DELETE FROM partner_months WHERE code='FECH1'");
  await adm('PUT', '/api/admin/tiers', BAIXAS);
  assert.equal(db.prepare("SELECT pct FROM partner_months WHERE code='FECH1' AND mes=?").get(ant.slice(0, 7)).pct, 40);
  assert.ok(Math.abs((await rep()).fechado - fech) <= 1);
  await adm('PUT', '/api/admin/tiers', PADRAO);
  // virada do mês com faixas agendadas: congela com as antigas, depois troca
  db.exec("DELETE FROM partner_months WHERE code='FECH1'");
  db.prepare("INSERT INTO settings (k, v) VALUES ('tiers_next', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify({ mes, tiers: BAIXAS }));
  SRV.makePartnerCtx();
  assert.equal(db.prepare("SELECT pct FROM partner_months WHERE code='FECH1' AND mes=?").get(ant.slice(0, 7)).pct, 40);
  assert.deepEqual((await (await adm('GET', '/api/admin/tiers')).json()).map((t) => t.pct), [10, 11, 12, 13]);
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE k='tiers_next'").get(), undefined);
  await adm('PUT', '/api/admin/tiers', PADRAO);

  // 6) fechamento mensal: pagar ≥ mínimo; abaixo do mínimo acumula
  assert.match(SRV.fechamentoMsg(), /Pagar hoje por Pix[\s\S]*FECH1: R\$\s?1\.782,1\d/);
  db.prepare("INSERT INTO coupon_payouts (code, cents) VALUES ('FECH1', ?)").run(c.fechado - 500);
  assert.match(SRV.fechamentoMsg(), /Abaixo do mínimo de R\$\s?20,00[\s\S]*FECH1: R\$\s?5,00/);
  // dispara 1x no 1º dia útil a partir das 9h (horário de Brasília)
  const du = String(SRV.primeiroDiaUtil(mes)).padStart(2, '0');
  const em = (hh) => Date.parse(`${mes}-${du}T${hh}:00:00Z`) + 3 * 3600_000;
  db.prepare("DELETE FROM settings WHERE k='fechamento_mes'").run();
  assert.equal(SRV.fechamentoTick(em('08')), false);
  const n = tgSent.length;
  assert.equal(SRV.fechamentoTick(em('10')), true);
  await ateQue(() => tgSent.length > n);
  assert.match(tgSent.at(-1).text, /💸 Comissões dos parceiros — fechamento de/);
  assert.equal(SRV.fechamentoTick(em('11')), false); // já enviado neste mês
  // 1º dia útil: pula fim de semana e 1º/jan, 1º/mai
  assert.equal(SRV.primeiroDiaUtil('2026-11'), 2); // 01/11/2026 é domingo
  assert.equal(SRV.primeiroDiaUtil('2027-01'), 4); // 01/01 feriado, 02 e 03 fim de semana
  assert.equal(SRV.primeiroDiaUtil('2026-05'), 4); // 01/05 feriado (sexta)
  assert.equal(SRV.primeiroDiaUtil('2026-12'), 1);
  db.exec("DELETE FROM orders WHERE coupon='FECH1'"); db.exec("DELETE FROM coupon_payouts WHERE code='FECH1'");
  db.exec("DELETE FROM partner_months WHERE code='FECH1'"); db.exec("DELETE FROM coupons WHERE code='FECH1'");
});

test('códigos reservados e página do parceiro: visitas/conversão, aviso de desativado e contato', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  for (const code of ['suporte', 'PAINEL', 'como-funciona', 'parceiro', 'api', 'ROBOTS']) {
    const r = await adm('POST', '/api/admin/coupons', { code, desconto_pct: 5, comissao_pct: 0, ativo: true });
    assert.equal(r.status, 400, code); assert.match((await r.json()).error, /reservado/);
  }
  db.prepare("INSERT INTO coupons (code, desconto_pct, comissao_pct, ativo, plano, ptoken) VALUES ('VIS1', 5, 0, 1, 'metas', 'tokvis1tokvis1tokvis1tokvis1')").run();
  for (const dev of ['d1', 'd2', 'd3', 'd4']) db.prepare("INSERT INTO events (dev, ev, coupon) VALUES (?, 'visit', 'VIS1')").run(dev);
  db.prepare("INSERT INTO events (dev, ev, coupon) VALUES ('d1', 'visit', 'VIS1')").run(); // mesmo aparelho não conta 2x
  db.prepare("INSERT INTO events (dev, ev, coupon, ts) VALUES ('d9', 'visit', 'VIS1', '2000-01-01 12:00:00')").run(); // antiga: só no total
  const agora = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, status, created_at, paid_at, prod_nome, prod_stars, coupon, star_cost)
    VALUES ('vis1', 'c1000', 1000, '340001', 'p', 'v@v.com', 'delivered', ?, ?, 'x', 0, 'VIS1', 0.0875)`).run(agora, agora);
  const pg = async () => (await fetch(base + '/parceiro/tokvis1tokvis1tokvis1tokvis1', { headers: freshIP() })).text();
  let h = await pg();
  assert.match(h, /<span>Visitas<\/span><b>4<\/b>/); assert.match(h, /<span>Conversão<\/span><b>25%<\/b>/); assert.match(h, /\(5 desde o início\)/);
  assert.match(h, /mailto:suporte@recargaflame\.com\.br/); assert.match(h, /href="\/perguntas-frequentes"/);
  assert.doesNotMatch(h, /está desativado/);
  db.prepare("UPDATE coupons SET ativo=0 WHERE code='VIS1'").run();
  h = await pg();
  assert.match(h, /O cupom VIS1 está desativado no momento/);
  for (const proibido of [/lucro/i, /margem/i, /custo/i, /stars/i, /★/]) assert.doesNotMatch(h, proibido, String(proibido));
  db.exec("DELETE FROM orders WHERE coupon='VIS1'"); db.exec("DELETE FROM events WHERE coupon='VIS1'"); db.exec("DELETE FROM coupons WHERE code='VIS1'");
});

test('dados do parceiro no cupom e mês de referência no pagamento; Pix nunca vai para a página do parceiro', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  const dados = { parceiro_nome: 'Fulano Teste', parceiro_canal: 'Canal X', parceiro_pix: 'pix-secreto-123', parceiro_email: 'Fulano@Ex.com' };
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'DADOS1', desconto_pct: 5, comissao_pct: 0, ativo: true, ...dados })).status, 200);
  let c = (await (await adm('GET', '/api/admin/coupons')).json()).find((x) => x.code === 'DADOS1');
  assert.equal(c.parceiro_nome, 'Fulano Teste'); assert.equal(c.parceiro_pix, 'pix-secreto-123'); assert.equal(c.parceiro_email, 'fulano@ex.com');
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'DADOS2', desconto_pct: 5, comissao_pct: 0, ativo: true, parceiro_email: 'sem-arroba' })).status, 400);
  // ativar/desativar (edição parcial) não apaga os dados do parceiro
  await adm('PUT', '/api/admin/coupons/DADOS1', { desconto_pct: 5, comissao_pct: 0, ativo: false });
  c = (await (await adm('GET', '/api/admin/coupons')).json()).find((x) => x.code === 'DADOS1');
  assert.equal(c.parceiro_pix, 'pix-secreto-123'); assert.equal(c.parceiro_canal, 'Canal X');
  // pagamento: mês de referência informado, padrão (mês passado) e inválidos
  const mes = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
  const [y, m] = mes.split('-').map(Number);
  const ant = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7), prox = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  assert.equal((await adm('POST', '/api/admin/coupons/DADOS1/payouts', { cents: 500, ref_mes: '2026-13' })).status, 400);
  assert.equal((await adm('POST', '/api/admin/coupons/DADOS1/payouts', { cents: 500, ref_mes: prox })).status, 400); // mês futuro
  assert.equal((await adm('POST', '/api/admin/coupons/DADOS1/payouts', { cents: 500, ref_mes: '2026-09', nota: 'Pix A' })).status, 200);
  assert.equal((await adm('POST', '/api/admin/coupons/DADOS1/payouts', { cents: 700 })).status, 200);
  const rep = (await (await adm('GET', '/api/admin/coupons/report')).json()).cupons.find((x) => x.code === 'DADOS1');
  assert.deepEqual(rep.pagamentos.map((p) => p.ref).sort(), ['2026-09', ant].sort());
  assert.deepEqual(rep.parceiro, { nome: 'Fulano Teste', pix: 'pix-secreto-123', email: true });
  // página do parceiro: mostra a referência; nunca o Pix nem o e-mail
  const tk = db.prepare("SELECT ptoken FROM coupons WHERE code='DADOS1'").get().ptoken;
  const h = await (await fetch(base + '/parceiro/' + tk, { headers: freshIP() })).text();
  assert.match(h, /ref\. set\/2026/);
  assert.doesNotMatch(h, /pix-secreto-123/); assert.doesNotMatch(h, /fulano@ex\.com/);
  // fechamento mostra o nome do parceiro (crédito, pois não há venda)
  assert.match(SRV.fechamentoMsg(), /DADOS1 \(Fulano Teste\): R\$\s?12,00/);
  db.exec("DELETE FROM coupon_payouts WHERE code='DADOS1'"); db.exec("DELETE FROM coupons WHERE code='DADOS1'");
});

test('registro de alterações: cupom, pagamentos, link e faixas padrão — sem Pix/e-mail no texto', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  const log = async (code) => (await (await adm('GET', '/api/admin/cupons-log?code=' + encodeURIComponent(code))).json()).map((r) => r.acao);
  await adm('POST', '/api/admin/coupons', { code: 'LOG1', desconto_pct: 5, comissao_pct: 0, ativo: true });
  await adm('PUT', '/api/admin/coupons/LOG1', { desconto_pct: 10, comissao_pct: 0, ativo: false, parceiro_nome: 'Beltrano', parceiro_pix: 'pix-log-999', parceiro_email: 'b@log.com',
    tiers: [{ min: 0, pct: 30 }, { min: 100000, pct: 40 }] });
  await adm('PUT', '/api/admin/coupons/LOG1', { desconto_pct: 10, comissao_pct: 0, ativo: false }); // nada mudou → nada registrado
  const { id } = await (await adm('POST', '/api/admin/coupons/LOG1/payouts', { cents: 2500, ref_mes: '2026-10' })).json();
  await adm('DELETE', '/api/admin/payouts/' + id);
  await adm('POST', '/api/admin/coupons/LOG1/ptoken');
  const L = await log('log1');
  assert.equal(L.length, 5, JSON.stringify(L));
  assert.match(L[4], /^criado: desconto 5%, plano metas/);
  assert.match(L[3], /desconto 5% → 10%; desativado; faixas padrão → próprias \(30% · 40% a partir de R\$\s?1\.000,00\); nome do parceiro: — → Beltrano; chave Pix cadastrada; e-mail do parceiro cadastrado/);
  assert.match(L[2], /pagamento registrado: R\$\s?25,00 \(ref\. out\/2026\)/);
  assert.match(L[1], /pagamento desfeito: R\$\s?25,00 \(ref\. out\/2026\)/);
  assert.match(L[0], /link do parceiro trocado/);
  assert.doesNotMatch(JSON.stringify(L), /pix-log-999|b@log\.com/);
  // excluir fica registrado (o registro sobrevive ao cupom)
  await adm('DELETE', '/api/admin/coupons/LOG1');
  assert.equal((await log('LOG1'))[0], 'excluído');
  // faixas padrão
  const T = [{ min: 0, pct: 30 }, { min: 150000, pct: 35 }, { min: 400000, pct: 40 }, { min: 1000000, pct: 45 }];
  await adm('PUT', '/api/admin/tiers?quando=proximo', [{ min: 0, pct: 31 }]);
  await adm('DELETE', '/api/admin/tiers/agendado');
  await adm('PUT', '/api/admin/tiers', T);
  const G = await log('*');
  assert.match(G[0], /^faixas padrão aplicadas já: /); assert.match(G[1], /^agendamento p\/ \w{3}\/\d{4} cancelado/); assert.match(G[2], /^faixas padrão agendadas p\/ \w{3}\/\d{4}: 31%/);
  assert.equal((await fetch(base + '/api/admin/cupons-log?code=*', { headers: freshIP() })).status, 401);
  db.exec("DELETE FROM coupon_log WHERE code IN ('LOG1','*')");
});

test('extrato mensal por e-mail: só p/ parceiro com e-mail e movimento; nunca lucro/custos; prévia no painel', async () => {
  const adm = (method, url) => fetch(base + url, { method, headers: { Cookie: COOKIE, 'x-painel': '1', ...freshIP() } });
  const mes = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
  const [y, m] = mes.split('-').map(Number);
  const antMes = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7), ant = antMes + '-15 15:00:00';
  db.prepare("INSERT INTO coupons (code, desconto_pct, comissao_pct, ativo, plano, ptoken, parceiro_nome, parceiro_email) VALUES ('EXT1', 5, 0, 1, 'metas', 'tokext1tokext1tokext1tokext1', 'Cicrano', 'cicrano@ext.com')").run();
  db.prepare("INSERT INTO coupons (code, desconto_pct, comissao_pct, ativo, plano, ptoken) VALUES ('EXT2', 5, 0, 1, 'metas', 'tokext2tokext2tokext2tokext2')").run(); // sem e-mail
  db.prepare("INSERT INTO coupons (code, desconto_pct, comissao_pct, ativo, plano, ptoken, parceiro_email) VALUES ('EXT3', 5, 0, 1, 'metas', 'tokext3tokext3tokext3tokext3', 'nada@ext.com')").run(); // sem movimento
  const ins = (code, gid, cents) => db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, status, created_at, paid_at, prod_nome, prod_stars, coupon, star_cost)
    VALUES (?, 'c1000', ?, ?, 'p', 'x@x.com', 'delivered', ?, ?, 'x', 26, ?, 0.0875)`).run('e' + gid, cents, gid, ant, ant, code);
  ins('EXT1', '350001', 200000); ins('EXT2', '350002', 200000);
  const n = mailSent.length;
  const r = await SRV.enviarExtratos(antMes);
  assert.deepEqual(r.ok, ['EXT1']); assert.deepEqual(r.falha, []);
  const e = mailSent.slice(n);
  assert.equal(e.length, 1); assert.deepEqual(e[0].to, ['cicrano@ext.com']);
  assert.match(e[0].from, /parcerias@recargaflame\.com\.br/); assert.equal(e[0].reply_to, 'parcerias@recargaflame.com.br');
  assert.match(e[0].subject, /^Seu extrato de \w{3}\/\d{4} — cupom EXT1$/);
  assert.match(e[0].html, /Olá, <b[^>]*>Cicrano<\/b>/); assert.match(e[0].html, /35%/); assert.match(e[0].html, /\/parceiro\/tokext1tokext1tokext1tokext1/);
  assert.match(e[0].text, /O pagamento de R\$\s?[\d.,]+ é feito por Pix/);
  for (const proibido of [/lucro/i, /margem/i, /custo/i, /stars/i, /★/]) { assert.doesNotMatch(e[0].html, proibido); assert.doesNotMatch(e[0].text, proibido); }
  await ateQue(() => tgSent.some((t) => /📧 Extrato de \w{3}\/\d{4} por e-mail: enviado para EXT1/.test(t.text)));
  // prévia no painel (exige sessão)
  const p = await adm('GET', '/api/admin/coupons/ext1/extrato?mes=' + antMes);
  assert.equal(p.status, 200); assert.match(await p.text(), /Seu extrato de/);
  assert.equal((await fetch(base + '/api/admin/coupons/EXT1/extrato', { headers: freshIP() })).status, 401);
  db.exec("DELETE FROM orders WHERE coupon IN ('EXT1','EXT2')"); db.exec("DELETE FROM partner_months WHERE code IN ('EXT1','EXT2','EXT3')");
  db.exec("DELETE FROM coupons WHERE code IN ('EXT1','EXT2','EXT3')");
});

test('erro depois de enviar o pagamento: só "nada cobrado" se a fatura não tem recibo e a recusa não é duplicidade', async () => {
  const { decideAfterSendError } = await import('../tg-user.js');
  const rpc = (m) => ({ errorMessage: m, code: 400 });
  // incidente #17: FORM_SUBMIT_DUPLICATE com o 1º envio cobrado → recibo existe → pago (não tenta de novo)
  assert.equal(decideAfterSendError(rpc('FORM_SUBMIT_DUPLICATE'), true), 'paid');
  assert.equal(decideAfterSendError(rpc('FORM_SUBMIT_DUPLICATE'), false), 'incerto'); // recibo pode atrasar
  assert.equal(decideAfterSendError(rpc('FORM_SUBMIT_DUPLICATE'), null), 'incerto');
  assert.equal(decideAfterSendError(rpc('BALANCE_TOO_LOW'), false), 'safe');
  assert.equal(decideAfterSendError(rpc('BALANCE_TOO_LOW'), null), 'incerto');      // não deu para conferir
  assert.equal(decideAfterSendError(new Error('timeout'), false), 'incerto');       // rede: nunca "seguro"
  assert.equal(decideAfterSendError({ errorMessage: 'INTERNAL', code: 500 }, false), 'incerto');
});

test('desligamento seguro: recusa pagamento novo, espera o pagamento em andamento terminar e só então sai', async () => {
  const { gracefulStop, _resetStopping, autopay } = SRV;
  mpShouldApprove = true;
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '333391', email: 'gs@x.com' })).json();
  await pagar(token);
  await new Promise((r) => setTimeout(r, 20));
  db.prepare("UPDATE orders SET autopay='paying' WHERE id=?").run(id); // pagamento em andamento
  let saiu = null;
  const p = gracefulStop({ exit: (c) => { saiu = c; }, stepMs: 10, maxMs: 2000 });
  try {
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(saiu, null); // ainda esperando
    // durante o desligamento, nenhum pagamento novo começa
    const o2 = await (await postJ('/api/orders', { product: 'c1000', gameId: '333392', email: 'gs2@x.com' })).json();
    await pagar(o2.token);
    const r = await autopay(o2.id);
    assert.equal(r.ok, false); assert.match(r.why, /reiniciando/);
    // terminou o pagamento → sai
    db.prepare("UPDATE orders SET autopay='sent' WHERE id=?").run(id);
    await p;
    assert.equal(saiu, 0);
    // teto de espera: sai mesmo com pagamento travado
    _resetStopping(); saiu = null;
    db.prepare("UPDATE orders SET autopay='paying' WHERE id=?").run(id);
    await gracefulStop({ exit: (c) => { saiu = c; }, stepMs: 10, maxMs: 50 });
    assert.equal(saiu, 0);
  } finally { db.prepare("UPDATE orders SET autopay='sent' WHERE id=?").run(id); _resetStopping(); }
});
