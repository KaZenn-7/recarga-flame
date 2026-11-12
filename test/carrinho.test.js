// Carrinho: vários itens num Pix só. Cada item é um pedido normal (entrega, reembolso e comissão por item);
// o Pix é único (valor total) e pagar/cancelar/estornar vale para todos os itens juntos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupStore, mock, tgSent, tgCalls, mailSent, remindPending, expirePending, base, db, RISK, riskOf, SRV, freshIP, postJ, pedir, pagar, webhookMP, adm, ateQue, cb, _setInvoiceChecker, _setInvoicePayer } from './helpers.js';

setupStore();

let seq = 0;
const novoId = () => String(700000 + ++seq); // um ID por teste: o antifraude conta por ID/e-mail
const carrinho = (itens, gameId = novoId(), extra = {}) => postJ('/api/carrinho', { itens, gameId, email: `c${seq}@ex.com`, ...extra });
const ver = async (token) => (await fetch(base + '/api/carrinho/' + token, { headers: freshIP() })).json();
const itensDB = (cid) => db.prepare('SELECT * FROM orders WHERE carrinho_id=? ORDER BY id').all(cid);
const preco = (k) => db.prepare('SELECT cents FROM products WHERE key=?').get(k).cents;

test('cria um Pix só com o total; cada item vira um pedido ligado ao carrinho', async () => {
  mock.approve = false;
  const r = await carrinho(['c1000', 'c1000', 'gold']);
  assert.equal(r.status, 200, await r.clone().text());
  const j = await r.json();
  const total = 2 * preco('c1000') + preco('gold');
  assert.equal(j.cents, total);
  assert.equal(j.itens.length, 3);
  assert.equal(mock.lastBody.transaction_amount, total / 100);
  assert.equal(mock.lastBody.external_reference, j.token);
  assert.match(mock.lastBody.description, new RegExp(`^Pedidos #${j.itens[0].id}, #${j.itens[1].id}, #${j.itens[2].id} - 3 itens CounterFlame - ID \\d+ - Recarga Flame$`));
  const its = itensDB(j.id);
  assert.deepEqual(its.map((o) => o.product), ['c1000', 'c1000', 'gold']);
  assert.ok(its.every((o) => o.status === 'pending' && o.mp_id === '123456' && o.expires_at === j.expiresAt));
  const v = await ver(j.token);
  assert.equal(v.status, 'pending');
  assert.equal(v.qr, 'PIXCODE');
  assert.equal(v.email, undefined);
});

test('regras do carrinho: até 10 itens; Gold, Wildfire e ticket do Arsenal não repetem; soma de níveis até 100', async () => {
  const casos = [
    [Array(11).fill('c1000'), 400, /até 10 itens/],
    [[], 400, /vazio/],
    [['c1000', 'naoexiste'], 400, /Produto inválido/],
    [['gold', 'gold'], 409, /uma vez/],
    [['wildfire', 'wildfire'], 409, /uma vez/],
    [['arsenal', 'arsenal'], 409, /uma vez/],
  ];
  for (const [itens, st, msg] of casos) {
    const r = await carrinho(itens);
    assert.equal(r.status, st, JSON.stringify(itens));
    assert.match((await r.json()).error, msg);
  }
  // conta no nível 96: 1 nível passa; depois dele (Pix em aberto conta) sobram 3, e 1 + 5 não cabem
  assert.equal((await carrinho(['bp1', 'c1000'], '444096')).status, 200);
  const r = await carrinho(['bp1', 'bp5'], '444096');
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /mais 3 nível\(is\) do passe/);
  // conta com Gold: o item bloqueado aparece com o nome
  const g = await carrinho(['c1000', 'gold'], '555555');
  assert.equal(g.status, 409);
  assert.match((await g.json()).error, /^Gold Pass: /);
  // 10 itens cabem num Pix só
  assert.equal((await carrinho(Array(10).fill('c1000'))).status, 200);
  // Coins e níveis podem repetir
  assert.equal((await carrinho(['c1000', 'c1000', 'bp1', 'bp1', 'arsenal'])).status, 200);
});

test('carrinho em aberto conta como 1 Pix no limite de Pix em aberto', async () => {
  mock.approve = false;
  const antes = RISK.pend;
  RISK.pend = 2;
  try {
    const id = novoId();
    assert.equal((await carrinho(['c1000', 'c3000', 'c5000'], id)).status, 200); // 3 itens = 1 Pix
    assert.equal((await pedir('c1000', id, `c${seq}@ex.com`)).status, 200);      // 2º Pix
    const r = await carrinho(['c1000'], id);
    assert.equal(r.status, 429);
  } finally { RISK.pend = antes; }
});

test('pagamento do Pix marca todos os itens como pagos uma vez só (consulta + webhook)', async () => {
  mock.approve = false;
  const j = await (await carrinho(['c1000', 'c3000', 'bp1'])).json();
  mock.approve = true;
  const n0 = tgSent.length;
  const v = await ver(j.token);
  assert.equal(v.status, 'paid');
  assert.ok(v.itens.every((it) => it.status === 'paid'));
  await webhookMP(); // o webhook chegando depois não avisa de novo
  await ver(j.token);
  const avisos = tgSent.slice(n0).filter((m) => /Pedido pago #/.test(m.text));
  assert.deepEqual(avisos.map((m) => Number(m.text.match(/#(\d+)/)[1])).sort(), j.itens.map((it) => it.id).sort());
  assert.ok(itensDB(j.id).every((o) => o.status === 'paid' && o.paid_at));
});

test('valor pago diferente do total do carrinho não confirma nenhum item', async () => {
  mock.approve = false;
  const j = await (await carrinho(['c1000', 'c3000'])).json();
  mock.approve = true;
  mock.lastBody.transaction_amount = preco('c1000') / 100; // pagou só o valor de 1 item
  try {
    const v = await ver(j.token);
    assert.equal(v.status, 'pending');
    assert.ok(itensDB(j.id).every((o) => o.status === 'pending'));
  } finally { mock.approve = false; }
});

test('cancelar pelo carrinho ou por um item cancela o Pix inteiro', async () => {
  mock.approve = false;
  const a = await (await carrinho(['c1000', 'c3000'])).json();
  const ra = await postJ(`/api/carrinho/${a.token}/cancel`, {});
  assert.equal((await ra.json()).status, 'cancelled');
  assert.ok(itensDB(a.id).every((o) => o.status === 'cancelled'));
  const b = await (await carrinho(['c1000', 'c3000'])).json();
  const rb = await postJ(`/api/orders/${b.itens[1].token}/cancel`, {});
  assert.equal((await rb.json()).status, 'cancelled');
  assert.ok(itensDB(b.id).every((o) => o.status === 'cancelled'));
});

test('reembolso de um item devolve só o valor dele; os outros seguem', async () => {
  mock.approve = false;
  const j = await (await carrinho(['c1000', 'c5000'])).json();
  mock.approve = true;
  await ver(j.token);
  const [i1, i2] = j.itens;
  const r = await SRV.reembolsar(i2.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  const ref = mock.refunds.at(-1);
  assert.deepEqual(ref.body, { amount: i2.cents / 100 });
  assert.equal(ref.key, `recargaflame-reembolso-${i2.id}`);
  const its = itensDB(j.id);
  assert.equal(its[0].status, 'paid');
  assert.equal(its[1].status, 'cancelled');
  assert.equal(its[1].refund_state, 'done');
  const v = await ver(j.token);
  assert.deepEqual(v.itens.map((it) => it.status), ['paid', 'refunded']);
  assert.equal(v.status, 'paid'); // ainda entregando o 1º
  // pedido avulso continua com devolução integral
  mock.approve = false;
  const o = await (await pedir('c1000', novoId(), 'avulso@ex.com')).json();
  mock.approve = true;
  await fetch(base + '/api/orders/' + o.token, { headers: freshIP() });
  assert.equal((await SRV.reembolsar(o.id)).ok, true);
  assert.deepEqual(mock.refunds.at(-1).body, {});
  mock.approve = false;
  void i1;
});

test('REVISAR: valor alto e primeira compra olham o carrinho inteiro', async () => {
  const antes = [RISK.review, RISK.first];
  try {
    RISK.review = preco('c3000') + preco('c1000'); // nenhum item sozinho chega lá; o carrinho chega
    RISK.first = 10 ** 9;
    mock.approve = false;
    const j = await (await carrinho(['c1000', 'c3000'])).json();
    mock.approve = true;
    await ver(j.token);
    for (const o of itensDB(j.id)) assert.ok(riskOf(o).some((w) => /valor alto .* no carrinho/.test(w)), `item #${o.id}`);
    // 1ª compra: entregar o 1º item do carrinho não tira o 2º da revisão
    RISK.review = 10 ** 9;
    RISK.first = preco('c3000') + preco('c1000');
    const [o1] = itensDB(j.id);
    db.prepare("UPDATE orders SET status='delivered', delivered_at=CURRENT_TIMESTAMP WHERE id=?").run(o1.id);
    const o2 = itensDB(j.id)[1];
    assert.ok(riskOf(o2).includes('primeira compra deste ID'));
  } finally { [RISK.review, RISK.first] = antes; mock.approve = false; }
});

test('estorno do Pix (chargeback) atinge todos os itens: entregue vira estornado, pago vira cancelado', async () => {
  mock.approve = false;
  const j = await (await carrinho(['c1000', 'c3000'])).json();
  mock.approve = true;
  await ver(j.token);
  const [o1] = itensDB(j.id);
  db.prepare("UPDATE orders SET status='delivered', delivered_at=CURRENT_TIMESTAMP WHERE id=?").run(o1.id);
  mock.status = 'charged_back';
  try {
    await webhookMP();
    const its = itensDB(j.id);
    assert.deepEqual(its.map((o) => o.status), ['reversed', 'cancelled']);
    assert.ok(db.prepare("SELECT 1 FROM blocked WHERE kind='game' AND value=?").get(o1.game_id));
  } finally { mock.status = null; mock.approve = false; }
});

test('entrega automática: cada item é conferido e pago no bot uma vez', async () => {
  const starsDo = (code) => db.prepare('SELECT stars FROM products WHERE code=?').get(code).stars;
  const codeDe = (sp) => sp.slice(2, sp.lastIndexOf('_'));
  const pays = [];
  _setInvoiceChecker(async (sp) => ({ currency: 'XTR', stars: starsDo(codeDe(sp)), account: 'jogador_teste', produto: codeDe(sp), msgId: 1 }));
  _setInvoicePayer(async (a) => {
    await new Promise((r) => setTimeout(r, 20));
    pays.push(a.startParam);
    return { stars: a.expectStars, account: a.expectAccount, produto: '', botReply: 'ok' };
  });
  try {
    await adm('POST', '/api/admin/autopay', { mode: 2 });
    mock.approve = false;
    const j = await (await carrinho(['c1000', 'c3000', 'c1000'])).json();
    mock.approve = true;
    await ver(j.token);
    await ateQue(() => itensDB(j.id).every((o) => o.status === 'delivered'));
    assert.equal(pays.length, 3); // um pagamento por item, nenhum repetido
    assert.deepEqual(pays.map(codeDe).sort(), ['c_1000', 'c_1000', 'c_3000']);
    assert.ok(pays.every((sp) => sp.endsWith('_' + itensDB(j.id)[0].game_id)));
    // (a fila de uma fatura por vez fica no tg-user.js, que os testes não usam: conta real nunca entra em teste)
    const v = await ver(j.token);
    assert.equal(v.status, 'delivered');
  } finally {
    await adm('POST', '/api/admin/autopay', { mode: 0 });
    _setInvoiceChecker(null); _setInvoicePayer(null); mock.approve = false;
  }
});

test('teto de 24h e saldo contam os itens que já estão sendo pagos', async () => {
  const pays = [];
  let libera;
  const trava = new Promise((r) => { libera = r; });
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 26, account: 'jogador_teste', produto: '1 000 coins', msgId: 1 }));
  _setInvoicePayer(async (a) => { pays.push(a); await trava; return { stars: a.expectStars, account: a.expectAccount, produto: '', botReply: '' }; });
  try {
    await adm('POST', '/api/admin/autopay', { mode: 2 });
    await adm('POST', '/api/admin/autopay/limites', { max: 100, dia: 26 * 2 + db.prepare("SELECT COALESCE(SUM(prod_stars),0) s FROM orders WHERE autopay='sent'").get().s });
    mock.approve = false;
    const j = await (await carrinho(['c1000', 'c1000', 'c1000'])).json();
    mock.approve = true;
    await ver(j.token);
    await ateQue(() => pays.length === 2 && itensDB(j.id).some((o) => o.manual_motivo));
    const motivos = itensDB(j.id).map((o) => o.manual_motivo).filter(Boolean);
    assert.equal(motivos.length, 1);
    assert.match(motivos[0], /teto de \d+★ em 24h/);
    libera();
    await ateQue(() => itensDB(j.id).filter((o) => o.status === 'delivered').length === 2);
  } finally {
    libera();
    await adm('POST', '/api/admin/autopay/limites', { max: 1000, dia: 4000 });
    await adm('POST', '/api/admin/autopay', { mode: 0 });
    _setInvoiceChecker(null); _setInvoicePayer(null); mock.approve = false;
  }
});

test('Telegram: aviso de cada item mostra "🛒 Carrinho #X · n/N"; pedido avulso não', async () => {
  mock.approve = false;
  const j = await (await carrinho(['c1000', 'c3000', 'bp1'])).json();
  const n0 = tgSent.length;
  mock.approve = true;
  await ver(j.token);
  await ateQue(() => tgSent.slice(n0).filter((m) => /Pedido pago/.test(m.text)).length === 3);
  const avisos = tgSent.slice(n0).filter((m) => /Pedido pago/.test(m.text));
  j.itens.forEach((it, i) => {
    const a = avisos.find((m) => m.text.includes(`Pedido pago #${it.id}`));
    assert.ok(a.text.includes(`🛒 Carrinho #${j.id} · ${i + 1}/3`), a.text);
  });
  // pedido avulso: sem a linha do carrinho
  mock.approve = false;
  const p = await (await pedir('c1000', novoId(), `c${seq}@ex.com`)).json();
  mock.approve = true;
  await pagar(p.token);
  await ateQue(() => tgSent.some((m) => m.text.includes(`Pedido pago #${p.id}`)));
  assert.ok(!tgSent.find((m) => m.text.includes(`Pedido pago #${p.id}`)).text.includes('🛒 Carrinho'));
  mock.approve = false;
});

// carrinho pago em REVISAR (valor alto do carrinho), com conferência ✅ em todos os itens e modo 1 toque
async function carrinhoRevisar(itens, checker) {
  const starsDo = (code) => db.prepare('SELECT stars FROM products WHERE code=?').get(code).stars;
  const codeDe = (sp) => sp.slice(2, sp.lastIndexOf('_'));
  _setInvoiceChecker(checker || (async (sp) => ({ currency: 'XTR', stars: starsDo(codeDe(sp)), account: 'jogador_teste', produto: '', msgId: 1 })));
  await adm('POST', '/api/admin/autopay', { mode: 1 });
  RISK.review = 1; // qualquer carrinho cai em REVISAR por valor
  mock.approve = false;
  const j = await (await carrinho(itens)).json();
  mock.approve = true;
  await ver(j.token);
  await ateQue(() => itensDB(j.id).every((o) => o.chk && o.tg_msg));
  return j;
}
const kbDe = (msgId) => tgCalls.filter((c) => c.body?.message_id === msgId && c.body.reply_markup).at(-1).body.reply_markup.inline_keyboard.flat();

test('REVISAR: "Aprovar carrinho" aprova uma vez e paga todos os itens (só o operador, só depois de confirmar)', async () => {
  const antes = RISK.review;
  const pays = [];
  _setInvoicePayer(async (a) => { pays.push(a.startParam); return { stars: a.expectStars, account: a.expectAccount, produto: '', botReply: '' }; });
  try {
    await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 50000 });
    await adm('POST', '/api/admin/autopay/limites', { max: 1000, dia: 100000 });
    const j = await carrinhoRevisar(['c1000', 'c3000', 'c1000']);
    const [o1] = itensDB(j.id);
    const tot = itensDB(j.id).reduce((a, o) => a + o.prod_stars, 0);
    const kb = kbDe(o1.tg_msg);
    assert.ok(kb.some((b) => b.callback_data === 'c:' + o1.id && b.text.includes(`Aprovar carrinho #${j.id} · 3 itens · ${tot}★`)), JSON.stringify(kb));
    assert.ok(!kb.some((b) => /^[ap]:/.test(b.callback_data)));
    await cb('C:' + o1.id, o1.tg_msg, 999);   // estranho: nada
    await cb('c:' + o1.id, o1.tg_msg);        // 1º toque: só pede confirmação
    assert.equal(pays.length, 0);
    assert.ok(kbDe(o1.tg_msg).some((b) => b.callback_data === 'C:' + o1.id));
    await cb('C:' + o1.id, o1.tg_msg);
    assert.equal(pays.length, 3);
    const its = itensDB(j.id);
    assert.ok(its.every((o) => o.status === 'delivered' && o.entrega_via === 'aprovado' && o.approved_at > 0 && o.autopay === 'sent'));
    await cb('C:' + o1.id, o1.tg_msg);        // toque repetido: não paga de novo
    assert.equal(pays.length, 3);
  } finally {
    RISK.review = antes; _setInvoiceChecker(null); _setInvoicePayer(null); mock.approve = false;
    await adm('POST', '/api/admin/autopay/limites', { max: 1000, dia: 4000 });
    await adm('POST', '/api/admin/autopay', { mode: 0 });
  }
});

test('REVISAR: carrinho que não cabe no teto de 24h não é pago pela metade', async () => {
  const antes = RISK.review;
  const pays = [];
  _setInvoicePayer(async (a) => { pays.push(a); return { stars: a.expectStars, account: a.expectAccount, produto: '', botReply: '' }; });
  try {
    await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 50000 });
    const usado = db.prepare("SELECT COALESCE(SUM(prod_stars),0) s FROM orders WHERE autopay IN ('sent','paying') AND autopay_at > ?").get(Date.now() - 86_400_000).s;
    const j = await carrinhoRevisar(['c1000', 'c1000']);
    const st = itensDB(j.id)[0].prod_stars;
    await adm('POST', '/api/admin/autopay/limites', { max: st, dia: usado + st }); // cabe 1 item, não 2
    const [o1] = itensDB(j.id);
    const n0 = tgSent.length;
    await cb('C:' + o1.id, o1.tg_msg);
    assert.equal(pays.length, 0);
    assert.ok(itensDB(j.id).every((o) => o.status === 'paid' && !o.approved_at));
    assert.ok(tgSent.slice(n0).some((m) => m.text.includes(`Carrinho #${j.id}`) && /teto de \d+★ em 24h/.test(m.text)));
  } finally {
    RISK.review = antes; _setInvoiceChecker(null); _setInvoicePayer(null); mock.approve = false;
    await adm('POST', '/api/admin/autopay/limites', { max: 1000, dia: 4000 });
    await adm('POST', '/api/admin/autopay', { mode: 0 });
  }
});

test('REVISAR: item com conferência que não bateu fica fora da aprovação e vai para entrega manual', async () => {
  const antes = RISK.review;
  const pays = [];
  _setInvoicePayer(async (a) => { pays.push(a.startParam); return { stars: a.expectStars, account: a.expectAccount, produto: '', botReply: '' }; });
  const starsDo = (code) => db.prepare('SELECT stars FROM products WHERE code=?').get(code).stars;
  const codeDe = (sp) => sp.slice(2, sp.lastIndexOf('_'));
  try {
    await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 50000 });
    await adm('POST', '/api/admin/autopay/limites', { max: 1000, dia: 100000 });
    // o bot cobra diferente no c_3000: conferência ❌
    const j = await carrinhoRevisar(['c1000', 'c3000', 'c1000'], async (sp) => ({ currency: 'XTR',
      stars: starsDo(codeDe(sp)) + (codeDe(sp) === 'c_3000' ? 1 : 0), account: 'jogador_teste', produto: '', msgId: 1 }));
    const [o1, o2, o3] = itensDB(j.id);
    assert.ok(kbDe(o1.tg_msg).some((b) => b.callback_data === 'c:' + o1.id && /2 itens/.test(b.text)));
    const n0 = tgSent.length;
    await cb('C:' + o1.id, o1.tg_msg);
    assert.equal(pays.length, 2);
    const st = Object.fromEntries(itensDB(j.id).map((o) => [o.id, o.status]));
    assert.deepEqual([st[o1.id], st[o2.id], st[o3.id]], ['delivered', 'paid', 'delivered']);
    assert.ok(tgSent.slice(n0).some((m) => m.text.includes(`Carrinho #${j.id}: 2 item(ns) pago(s); #${o2.id} segue(m) para entrega manual`)));
  } finally {
    RISK.review = antes; _setInvoiceChecker(null); _setInvoicePayer(null); mock.approve = false;
    await adm('POST', '/api/admin/autopay/limites', { max: 1000, dia: 4000 });
    await adm('POST', '/api/admin/autopay', { mode: 0 });
  }
});

test('catálogo informa quais produtos podem repetir no carrinho', async () => {
  const ps = await (await fetch(base + '/api/products')).json();
  const rep = Object.fromEntries(ps.map((p) => [p.key, p.rep]));
  assert.equal(rep.c1000, true); assert.equal(rep.bp1, true);
  assert.equal(rep.gold, false); assert.equal(rep.wildfire, false); assert.equal(rep.arsenal, false);
});

// ---------- etapa 4: e-mails, painel e números ----------
const mailsPara = (email, n0) => mailSent.slice(n0).filter((m) => m.to.includes(email));

test('e-mail: carrinho entregue manda UM e-mail com todos os itens (nenhum por item)', async () => {
  mock.approve = false;
  const j = await (await carrinho(['c1000', 'c1000', 'gold'])).json();
  const email = `c${seq}@ex.com`;
  mock.approve = true;
  await ver(j.token);
  const n0 = mailSent.length;
  const ids = itensDB(j.id).map((o) => o.id);
  await adm('POST', '/painel/' + ids[0] + '/entregue');
  await adm('POST', '/painel/' + ids[1] + '/entregue');
  assert.equal(mailsPara(email, n0).length, 0); // ainda falta o Gold
  await adm('POST', '/painel/' + ids[2] + '/entregue');
  await ateQue(() => mailsPara(email, n0).length === 1);
  const m = mailsPara(email, n0)[0];
  assert.equal(m.subject, `Pedidos #${ids[0]}, #${ids[1]}, #${ids[2]} entregues — 1.000 Coins ×2, Gold Pass`);
  assert.ok(m.html.includes('#carrinho=' + j.token));
  for (const id of ids) assert.ok(m.text.includes(`#${id} `));
  assert.ok(!m.html.includes(email)); // o e-mail do cliente não aparece no corpo
  // varredura não manda de novo
  await expirePending();
  assert.equal(mailsPara(email, n0).length, 1);
  mock.approve = false;
});

test('e-mail: carrinho com item devolvido manda o e-mail único depois do reembolso ("1 de 2")', async () => {
  mock.approve = false;
  const j = await (await carrinho(['c1000', 'c3000'])).json();
  const email = `c${seq}@ex.com`;
  mock.approve = true;
  await ver(j.token);
  const n0 = mailSent.length;
  const [a, b] = itensDB(j.id).map((o) => o.id);
  await adm('POST', '/painel/' + a + '/entregue');
  assert.equal(mailsPara(email, n0).length, 0);
  assert.equal((await adm('POST', '/api/admin/orders/' + b + '/reembolsar')).status, 200);
  await ateQue(() => mailsPara(email, n0).length === 1);
  const m = mailsPara(email, n0)[0];
  assert.match(m.subject, /: 1 de 2 itens entregues$/);
  assert.match(m.text, new RegExp(`#${b} 3\\.000 Coins .*devolvidos via Pix`));
  mock.approve = false;
});

test('e-mail: lembrete e Pix expirado saem uma vez por carrinho, com o link do carrinho', async () => {
  mock.approve = false;
  const j = await (await carrinho(['c1000', 'bp1', 'c1000'])).json();
  const email = `c${seq}@ex.com`;
  const ids = itensDB(j.id).map((o) => o.id);
  const n0 = mailSent.length;
  db.prepare('UPDATE orders SET expires_at=? WHERE carrinho_id=?').run(Date.now() + 5 * 60_000, j.id);
  await remindPending();
  await remindPending();
  let ms = mailsPara(email, n0);
  assert.equal(ms.length, 1);
  assert.match(ms[0].subject, new RegExp(`^Seu Pix vence em \\d+ min — pedidos #${ids[0]}, #${ids[1]}, #${ids[2]}$`));
  assert.ok(ms[0].html.includes('#carrinho=' + j.token));
  assert.ok(ms[0].html.includes('1.000 Coins ×2'));
  // venceu
  db.prepare('UPDATE orders SET expires_at=? WHERE carrinho_id=?').run(Date.now() - 10 * 60_000, j.id);
  await expirePending();
  await expirePending();
  ms = mailsPara(email, n0);
  assert.equal(ms.length, 2);
  assert.match(ms[1].subject, /^Seu Pix expirou — pedidos /);
  assert.ok(itensDB(j.id).every((o) => o.status === 'cancelled'));
});

test('painel: tag do carrinho em cada item e "Aprovar carrinho" paga todos de uma vez', async () => {
  const antes = RISK.review;
  const pays = [];
  _setInvoicePayer(async (a) => { pays.push(a.startParam); return { stars: a.expectStars, account: a.expectAccount, produto: '', botReply: '' }; });
  try {
    await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 50000 });
    await adm('POST', '/api/admin/autopay/limites', { max: 1000, dia: 100000 });
    const j = await carrinhoRevisar(['c1000', 'c3000']);
    const ids = itensDB(j.id).map((o) => o.id);
    const lista = await (await adm('GET', '/api/admin/orders')).json();
    const [x, y] = ids.map((id) => lista.find((o) => o.id === id));
    assert.deepEqual(x.car, { id: j.id, pos: 1, n: 2, aprov: 2 });
    assert.deepEqual(y.car, { id: j.id, pos: 2, n: 2, aprov: 2 });
    assert.equal((await fetch(base + '/api/admin/carrinhos/' + j.id + '/aprovar', { method: 'POST', headers: { 'x-painel': '1', ...freshIP() } })).status, 401);
    const r = await adm('POST', '/api/admin/carrinhos/' + j.id + '/aprovar');
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).pagos, ids);
    assert.equal(pays.length, 2);
    assert.ok(itensDB(j.id).every((o) => o.status === 'delivered' && o.entrega_via === 'aprovado'));
    assert.equal((await adm('POST', '/api/admin/carrinhos/' + j.id + '/aprovar')).status, 409);
  } finally {
    RISK.review = antes; _setInvoiceChecker(null); _setInvoicePayer(null); mock.approve = false;
    await adm('POST', '/api/admin/autopay/limites', { max: 1000, dia: 4000 });
    await adm('POST', '/api/admin/autopay', { mode: 0 });
  }
});

test('números: carrinho conta como 1 Pix gerado/pago; KPI de carrinhos; evento "cart" aceito', async () => {
  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const ana = async () => (await adm('GET', `/api/admin/analytics?from=${hoje}&to=${hoje}`)).json();
  const a0 = await ana();
  mock.approve = false;
  const j = await (await carrinho(['c1000', 'c1000', 'c3000'])).json();
  mock.approve = true;
  await ver(j.token);
  const a1 = await ana();
  assert.equal(a1.pixGerados - a0.pixGerados, 1);
  assert.equal(a1.pixPagos - a0.pixPagos, 1);
  assert.equal(a1.carrinhos.itens - a0.carrinhos.itens, 3);
  assert.equal(a1.carrinhos.n - a0.carrinhos.n, 1);
  assert.equal(a1.vendas - a0.vendas, 3);
  assert.equal(a1.carrinhos.compras - a0.carrinhos.compras, 1);
  const ev = await postJ('/api/ev', { ev: 'cart', src: 'direto' });
  assert.equal(ev.status, 204);
  assert.ok(db.prepare("SELECT 1 FROM events WHERE ev='cart'").get());
  mock.approve = false;
});
