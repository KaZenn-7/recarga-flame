// Checkout: preço do servidor, Pix, pagamento, cancelamento, webhook, link do pedido, expiração, lembretes, e-mail de entregue e reembolso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupStore, mock, tgSent, mailSent, tgCalls, base, expirePending, db, remindPending, _setRefundCaller, COOKIE, freshIP, postJ, pagar, webhookMP, lastCall } from './helpers.js';

setupStore();

test('preço é do servidor: cliente não consegue forjar valor', async () => {
  // produto c1000 custa 350 centavos (seed). Cliente tenta mandar cents=1.
  const r = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'c1000', gameId: '749125', email: 'a@b.com', cents: 1, price: 1 }),
  });
  assert.equal(r.status, 200);
  // o valor enviado ao MP tem que ser 3.50, não 0.01
  assert.equal(mock.lastBody.transaction_amount, 3.5);
  // descrição do pagamento: nº do pedido e ID da conta do jogo
  const { id } = await r.json();
  assert.equal(mock.lastBody.description, `Pedido #${id} - 1.000 Coins CounterFlame - ID 749125 - Recarga Flame`);
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
  assert.ok(Math.abs(new Date(mock.lastBody.date_of_expiration).getTime() - j.expiresAt) < 1000);
});

test('pedido vira paid só quando aprovado E valor confere', async () => {
  mock.approve = true;
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
  // painel sem script embutido: CSP só 'self' e nenhum on*="…" / <script> executável no HTML
  const scriptSrc = painel.headers.get('content-security-policy').split(';').find((d) => d.trim().startsWith('script-src'));
  assert.equal(scriptSrc.trim(), "script-src 'self'");
  assert.doesNotMatch(html, /\son[a-z]+=["']/i);
  assert.deepEqual([...html.matchAll(/<script(?![^>]*(src=|type="application\/json"))[^>]*>/g)].map((m) => m[0]), []);
  assert.ok(html.includes('<script type="application/json" id="ordersData">'));
  const js = await fetch(base + '/painel/app.js', { headers: { Cookie: COOKIE } });
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.ok((await js.text()).includes('function render'));
});

test('webhook do MP rejeita assinatura inválida', async () => {
  const r = await fetch(base + '/webhook/mercadopago?type=payment&data.id=123', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': 'ts=1,v1=assinaturafalsa', 'x-request-id': 'req1' },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 401);
});

test('cliente cancela Pix pendente: cancela no MP e pedido vira cancelled', async () => {
  mock.approve = false;
  const create = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'c1000', gameId: '749125', email: 'g@h.com' }),
  });
  const { token } = await create.json();
  const r = await fetch(base + '/api/orders/' + token + '/cancel', { method: 'POST', headers: freshIP() });
  assert.equal((await r.json()).status, 'cancelled');
  const again = await fetch(base + '/api/orders/' + token);
  assert.equal((await again.json()).status, 'cancelled');
  mock.approve = true;
});

test('cancelar pedido já pago não muda nada (MP recusa, status segue paid)', async () => {
  mock.approve = false;
  const create = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() },
    body: JSON.stringify({ product: 'c1000', gameId: '749125', email: 'i@j.com' }),
  });
  const { token } = await create.json();
  mock.approve = true; // cliente pagou antes de tocar em cancelar
  const r = await fetch(base + '/api/orders/' + token + '/cancel', { method: 'POST', headers: freshIP() });
  assert.equal((await r.json()).status, 'paid');
});

test('cancelar pedido inexistente dá 404', async () => {
  const r = await fetch(base + '/api/orders/nao-existe/cancel', { method: 'POST', headers: freshIP() });
  assert.equal(r.status, 404);
});

test('player devolve bloqueios por produto (conta com Gold não pode comprar Gold)', async () => {
  const ok = await (await fetch(base + '/api/player/749125', { headers: freshIP() })).json();
  assert.equal(ok.blocked.gold, undefined);
  const gold = await (await fetch(base + '/api/player/555555', { headers: freshIP() })).json();
  assert.match(gold.blocked.gold, /Gold Pass/);
});

test('níveis do passe: limite é 100 (não o totalLevels 50 da API)', async () => {
  const r = await (await fetch(base + '/api/player/444096', { headers: freshIP() })).json(); // nível 96
  assert.equal(r.blocked.bp1, undefined); // 96 + 1 = 97
  assert.match(r.blocked.bp5, /mais 4 nível\(is\)/); // 96 + 5 = 101
  const ok = await (await fetch(base + '/api/player/749125', { headers: freshIP() })).json(); // nível 0
  assert.equal(ok.blocked.bp5, undefined);
});

test('link do pedido: ?full=1 devolve dados e QR sem expor e-mail', async () => {
  mock.approve = false;
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
  mock.approve = true;
});

test('pedido pago avisa o operador no Telegram uma única vez', async () => {
  mock.approve = true;
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'k@l.com' })).json();
  const n = tgSent.length;
  await fetch(base + '/api/orders/' + token); // polling → paid
  await fetch(base + '/api/orders/' + token); // de novo: já é paid, não pode avisar outra vez
  const msgs = tgSent.slice(n).filter((m) => m.text.includes('Pedido pago #' + id));
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].reply_markup.inline_keyboard.flat().some((b) => b.url === "https://t.me/CounterFlameDonate_bot?start=s_c_1000_749125")); // link no botão
});

test('pendente com Pix vencido é cancelado; vencido mas pago no MP vira paid', async () => {
  mock.approve = false;
  const a = await (await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'm@n.com' })).json();
  db.prepare('UPDATE orders SET expires_at=? WHERE token=?').run(Date.now() - 10 * 60_000, a.token);
  await expirePending();
  assert.equal((await (await fetch(base + '/api/orders/' + a.token)).json()).status, 'cancelled');
  const b = await (await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'o@p.com' })).json();
  db.prepare('UPDATE orders SET expires_at=? WHERE token=?').run(Date.now() - 10 * 60_000, b.token);
  mock.approve = true; // pagou no último segundo
  await expirePending();
  assert.equal((await (await fetch(base + '/api/orders/' + b.token)).json()).status, 'paid');
});

test('e-mail recusado pelo MP vira erro claro (400), não "falha genérica"', async () => {
  const r = await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'a@dhdh.cokc' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /não aceitou esse e-mail/);
});

test('marcar entregue manda 1 e-mail ao cliente (nick escapado), e só uma vez', async () => {
  mock.approve = true;
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

test('lembretes de Pix: avisa 1x quando falta ≤ 10 min e 1x quando expira; não avisa se já fez pedido novo', async () => {
  mock.approve = false;
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
  mock.approve = true;
});

test('reembolso: só pago e não entregue; 1 vez; cliente vê "valor devolvido"; não vira bloqueio de estorno', async () => {
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  const calls = [];
  let falha = null;
  _setRefundCaller(async (o) => { calls.push(o.id); if (falha) return { ok: false, erro: falha }; return { ok: true, id: 555, estado: 'approved' }; });
  try {
    mock.approve = true;
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
    const salvo = mock.lastBody; mock.lastBody = { ...mock.lastBody, external_reference: p.token };
    mock.status = 'refunded';
    const n0 = tgSent.length, c0 = tgCalls.length;
    try { assert.equal((await webhookMP()).status, 200); } finally { mock.status = null; mock.lastBody = salvo; }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM blocked WHERE value='272701'").get().n, before);
    assert.ok(!tgSent.slice(n0).some((m) => /cancelado após pagamento|ESTORNADO/.test(m.text)));
    assert.ok(!tgCalls.slice(c0).some((c) => /cancelado após pagamento|ESTORNADO/.test(c.body?.text || '')));
    // painel mostra
    const o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === p.id);
    assert.equal(o.refund, 'done'); assert.equal(o.refundable, false);
  } finally { _setRefundCaller(null); }
});
