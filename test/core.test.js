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
const tgCalls = [];              // todas as chamadas à API do bot ({ method, body })
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
  if (u.includes('/avatar')) {
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

let app, loadProducts, server, base, adminFails, expirePending, db, RISK, handleTgUpdate, _setStarsReader, _setInvoiceChecker, conferir, _setInvoicePayer, _setReceiptChecker, dailySummary, summaryTick;
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
const freshIP = () => ({ 'X-Forwarded-For': `10.0.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` });

before(async () => {
  const mod = await import('../server.js?test=' + Date.now());
  app = mod.app; loadProducts = mod.loadProducts; adminFails = mod.adminFails; expirePending = mod.expirePending; db = mod.db; RISK = mod.RISK; handleTgUpdate = mod.handleTgUpdate; _setStarsReader = mod._setStarsReader; _setInvoiceChecker = mod._setInvoiceChecker; conferir = mod.conferir; _setInvoicePayer = mod._setInvoicePayer; _setReceiptChecker = mod._setReceiptChecker; dailySummary = mod.dailySummary; summaryTick = mod.summaryTick;
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
  const saldo = async () => (await (await adm('GET', '/api/admin/coupons/report')).json()).cupons.find((c) => c.code === 'AQUILA');
  const a0 = await saldo();
  assert.equal(a0.total, 20); assert.equal(a0.pago, 0); assert.equal(a0.saldo, 20);
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
  assert.match(msg, /Pedido pago #/); assert.match(msg, /REVISAR/); assert.match(msg, /valor alto/); assert.match(msg, /primeira compra/);
  const o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === id);
  assert.ok(o.risk.length >= 2);
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
  assert.match(tgSent.at(-1).text, /Bloqueados:/);
  // mesmo e-mail com outro ID, ou mesmo ID com outro e-mail: recusado
  assert.equal((await pedir('c1000', '666667', 'mal@x.com')).status, 403);
  assert.equal((await pedir('c1000', '666666', 'novo@x.com')).status, 403);
  const o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === id);
  assert.equal(o.blocked, true);
  assert.equal((await fetch(base + '/api/admin/orders/' + id + '/unblock', { method: 'POST', headers: { 'x-painel': '1' } })).status, 401);
  assert.equal((await adm('POST', '/api/admin/orders/' + id + '/unblock')).status, 200);
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
  // outro aparelho e IP, mas paga com a MESMA conta: não dá para recusar antes, então REVISAR no aviso
  mpPayer = pagadorX;
  const c = await (await comprar('444444', 'g4@x.com', null, '10.6.6.6')).json();
  await pagar(c.token);
  assert.match(tgSent.at(-1).text, /conta bancária que pagou já teve estorno/);
  mpPayer = null;
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
  assert.match(lastCall('editMessageReplyMarkup').body.reply_markup.inline_keyboard[0][0].text, /Entregue/);
  // toque repetido não reenvia e-mail
  await cb('D:' + id, msgId);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mailSent.length, mails + 1);
});

test('entrega pelo painel também atualiza os botões do aviso no Telegram', async () => {
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '222222', email: 'tp@x.com' })).json();
  await pagar(token);
  await new Promise((r) => setTimeout(r, 20));
  const msgId = db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(id).tg_msg;
  await adm('POST', '/painel/' + id + '/entregue');
  const e = lastCall('editMessageReplyMarkup').body;
  assert.equal(e.message_id, msgId); assert.match(e.reply_markup.inline_keyboard[0][0].text, /Entregue.*painel/);
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
    assert.ok(tgSent.some((m) => /Pedido #\d+ pago no bot \(26★\)/.test(m.text)));
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
    const ok = tgSent.find((m) => m.text.includes('Entregue automaticamente #' + a.id));
    assert.ok(ok); assert.match(ok.text, /⭐ Saldo:|Saldo de Stars/);
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
  } finally { _setInvoiceChecker(null); _setInvoicePayer(null); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
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
    // logo após a tentativa: pede para esperar 1 min
    assert.equal((await adm('POST', '/api/admin/orders/' + a + '/verify')).status, 409);
    db.prepare('UPDATE orders SET autopay_at=? WHERE id=?').run(Date.now() - 120_000, a);
    // sem cobrança no histórico → liberar → volta a poder pagar
    let v = await (await adm('POST', '/api/admin/orders/' + a + '/verify')).json();
    assert.equal(v.cobrado, false);
    assert.equal((await adm('POST', '/api/admin/orders/' + a + '/resolve', { acao: 'liberar' })).status, 200);
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
    await espera(150);
    assert.equal(chamadas, 3); assert.equal(pays.length, 1);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(a.id).status, 'delivered');
    assert.ok(!tgSent.some((m) => m.text.includes('MANUAL necessária #' + a.id)));
    // persistente (3 falhas) → manual + aviso
    falhas = 99; chamadas = 0;
    const b = await (await postJ('/api/orders', { product: 'c1000', gameId: '161612', email: 'rt2@x.com' })).json();
    await pagar(b.token);
    await espera(200);
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

test('link curto de cupom: /aquila → /?cupom=AQUILA; inativo/inexistente → 404; rotas fixas não são afetadas', async () => {
  const r = await fetch(base + '/aquila', { redirect: 'manual' });
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/?cupom=AQUILA');
  assert.equal((await fetch(base + '/OFF1', { redirect: 'manual' })).status, 404); // cupom desativado
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
