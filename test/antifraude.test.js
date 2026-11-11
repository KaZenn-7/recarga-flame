// Antifraude: revisão, tetos, bloqueios (ID, e-mail, aparelho, conta, IP) e limites em 24h.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupStore, mock, tgSent, tgCalls, base, db, riskOf, _setRefundCaller, RISK, freshIP, postJ, adm, pedir, pagar, webhookMP, pagadorX, lastCall } from './helpers.js';

setupStore();

test('antifraude: pedido alto / 1ª compra chega no Telegram e no painel como REVISAR', async () => {
  mock.approve = true;
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
  const old = RISK.pend; RISK.pend = 1; mock.approve = false;
  try {
    assert.equal((await pedir('c1000', '888888', 'pend@x.com')).status, 200);
    const r = await pedir('c1000', '888888', 'pend2@x.com');
    assert.equal(r.status, 429); assert.match((await r.json()).error, /Pix em aberto/);
  } finally { RISK.pend = old; mock.approve = true; }
});

test('antifraude: estorno após pagamento bloqueia ID e e-mail; painel desbloqueia', async () => {
  mock.approve = true;
  const { token, id } = await (await pedir('c1000', '666666', 'Mal@x.com')).json();
  await pagar(token);
  mock.status = 'refunded';
  try {
    const crypto = await import('node:crypto');
    const v1 = crypto.createHmac('sha256', 'segredo-teste').update('id:123456;request-id:r1;ts:1;').digest('hex');
    const w = await fetch(base + '/webhook/mercadopago?type=payment&data.id=123456', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'r1', 'x-signature': `ts=1,v1=${v1}` }, body: '{}' });
    assert.equal(w.status, 200);
  } finally { mock.status = null; }
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
  mock.approve = true; mock.payer = pagadorX;
  const { token, id } = await (await comprar('444441', 'g1@x.com', dev, '10.9.9.9')).json();
  await pagar(token);
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  assert.ok(row.device && row.ip_h && row.payer_acct && !row.payer_doc);
  assert.ok(!JSON.stringify(row).includes('987654') && !JSON.stringify(row).includes('10.9.9.9')); // nada em claro
  mock.status = 'refunded';
  try { assert.equal((await webhookMP()).status, 200); } finally { mock.status = null; }

  // mesmo aparelho, ID e e-mail novos: recusado no checkout
  assert.equal((await comprar('444442', 'g2@x.com', dev, '10.7.7.7')).status, 403);
  // outro aparelho, mesmo IP: passa (IP não bloqueia), mas pago → alerta de IP
  mock.payer = null;
  const b = await (await comprar('444443', 'g3@x.com', null, '10.9.9.9')).json();
  await pagar(b.token);
  assert.match(tgSent.at(-1).text, /mesmo IP/);
  assert.doesNotMatch(tgSent.at(-1).text, /conta bancária/);
  // outro aparelho e IP, mas paga com a MESMA conta: não dá para recusar antes do Pix → BLOQUEIO imediato ao pagar
  mock.payer = pagadorX;
  const c = await (await comprar('444444', 'g4@x.com', null, '10.6.6.6')).json();
  await pagar(c.token);
  assert.match(tgSent.at(-1).text, /🚫 Pedido #\d+ BLOQUEADO automaticamente: a conta bancária que pagou já teve estorno/);
  assert.match(tgSent.at(-1).text, /devolva R\$/);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(c.id).status, 'cancelled');
  assert.equal((await (await fetch(base + '/api/orders/' + c.token, { headers: freshIP() })).json()).status, 'refund');
  assert.equal((await comprar('444444', 'g4b@x.com', null, '10.4.4.4')).status, 403); // ID do pedido bloqueado também ficou bloqueado
  mock.payer = null;
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
  mock.approve = true; mock.payer = pagadorX;
  const a = await (await postJ('/api/orders', { product: 'c1000', gameId: '333331', email: 'a1@x.com' })).json();
  await pagar(a.token);
  mock.status = 'refunded';
  try { await webhookMP(); } finally { mock.status = null; }
  // …não afeta outro cliente com outra conta, mesmo com o mesmo CNPJ do MP no campo payer
  mock.payer = { payer: pagadorX.payer, point_of_interaction: { transaction_data: { bank_info: { payer: { long_name: 'Banco Y', branch: '2', account_id: 111 } } } } };
  const b = await (await postJ('/api/orders', { product: 'c1000', gameId: '333332', email: 'b1@x.com' })).json();
  await pagar(b.token);
  assert.doesNotMatch(tgSent.at(-1).text, /REVISAR/);
  mock.payer = null;
  await adm('POST', '/api/admin/orders/' + a.id + '/unblock');
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
