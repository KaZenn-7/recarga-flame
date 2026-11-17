// Entrega: Telegram (botões), conferência da fatura, pagamento automático, aprovação, robustez e desligamento seguro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupStore, mock, tgSent, mailSent, tgCalls, SRV, base, db, _setRefundCaller, RISK, handleTgUpdate, _setStarsReader, _setInvoiceChecker, conferir, _setInvoicePayer, _setReceiptChecker, COOKIE, ateQue, freshIP, postJ, adm, pagar, OP, cb, lastCall } from './helpers.js';

setupStore();

test('reembolso recusado pelo MP no botão do Telegram: edita a mensagem com o motivo e devolve o botão, sem mensagem nova', async () => {
  mock.approve = true;
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
  mock.approve = true;
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
    mock.approve = true;
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

test('pagamento 1 toque: desligado por padrão; ligado paga 1 vez, entrega e respeita travas', async () => {
  const pays = [];
  let payErr = null;
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 26, account: 'jogador_teste', produto: '1 000 coins', msgId: 1 }));
  _setInvoicePayer(async (a) => { pays.push(a); await new Promise((r) => setTimeout(r, 30)); if (payErr) throw payErr; return { stars: a.expectStars, account: a.expectAccount, produto: '1 000 coins', botReply: 'ok!' }; });
  try {
    mock.approve = true;
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
  let fatura = 9000, saldo = 5000, comSaldo = true;
  // pagamento: chega à fatura (grava o nº e o saldo antes de cobrar) e cai no envio → incerto
  _setInvoicePayer(async (q) => { await q.onInvoice(++fatura, comSaldo ? saldo : null); throw new Error('TIMEOUT'); });
  _setStarsReader(async () => saldo);
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
    // sem recibo e o saldo não mudou → provavelmente não cobrou → liberar → volta a poder pagar
    let v = await (await adm('POST', '/api/admin/orders/' + a + '/verify')).json();
    assert.equal(v.entregue, false); assert.equal(v.cobrado, false); assert.match(v.motivo, /não mudou/);
    assert.equal((await adm('POST', '/api/admin/orders/' + a + '/resolve', { acao: 'liberar' })).status, 200);
    const el = lastCall('editMessageText').body;
    assert.equal(el.message_id, aMsg); assert.match(el.text, /💰 Pedido pago/); assert.match(el.text, /nada foi cobrado/);
    assert.ok(el.reply_markup.inline_keyboard.flat().some((x) => x.callback_data === 'd:' + a));
    let o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === a);
    assert.equal(o.ap, 'erro'); assert.equal(o.canPay.ok, true);
    // sem recibo, mas o saldo caiu exatamente o valor (26★) → cobrado SEM entrega (o CF não registrou)
    const s1 = await novo('151513');
    await adm('POST', '/api/admin/orders/' + s1 + '/autopay');
    db.prepare('UPDATE orders SET autopay_at=? WHERE id=?').run(Date.now() - 120_000, s1);
    saldo -= 26;
    v = await (await adm('POST', '/api/admin/orders/' + s1 + '/verify')).json();
    assert.equal(v.entregue, false); assert.equal(v.cobrado, true); assert.match(v.motivo, /caiu exatamente 26★/);
    // saldo mudou outro valor (compra de Stars no meio) → sem prova: não libera nem marca entregue
    const s2 = await novo('151514');
    await adm('POST', '/api/admin/orders/' + s2 + '/autopay');
    db.prepare('UPDATE orders SET autopay_at=? WHERE id=?').run(Date.now() - 120_000, s2);
    saldo += 3300;
    v = await (await adm('POST', '/api/admin/orders/' + s2 + '/verify')).json();
    assert.equal(v.cobrado, null); assert.match(v.motivo, /mudou \+3300★/);
    // sem o saldo de antes (tentativa antiga) → sem prova
    comSaldo = false;
    const s3 = await novo('151515');
    await adm('POST', '/api/admin/orders/' + s3 + '/autopay');
    db.prepare('UPDATE orders SET autopay_at=? WHERE id=?').run(Date.now() - 120_000, s3);
    v = await (await adm('POST', '/api/admin/orders/' + s3 + '/verify')).json();
    assert.equal(v.cobrado, null); assert.match(v.motivo, /sem o saldo de antes/);
    comSaldo = true;
    // outro pedido incerto, mas FOI cobrado (recibo) → marcar entregue
    const b = await novo('151512');
    await adm('POST', '/api/admin/orders/' + b + '/autopay');
    db.prepare('UPDATE orders SET autopay_at=? WHERE id=?').run(Date.now() - 120_000, b);
    found = true;
    v = await (await adm('POST', '/api/admin/orders/' + b + '/verify')).json();
    assert.equal(v.entregue, true);
    // consultou a fatura EXATA de cada pedido (não valor/horário)
    assert.deepEqual(consultadas, [9001, 9002, 9003, 9004, 9005]); assert.equal(v.fatura, 9005);
    const mails = mailSent.length;
    assert.equal((await adm('POST', '/api/admin/orders/' + b + '/resolve', { acao: 'entregue' })).status, 200);
    const row = db.prepare('SELECT status, autopay FROM orders WHERE id=?').get(b);
    assert.equal(row.status, 'delivered'); assert.equal(row.autopay, 'sent');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mailSent.length, mails + 1);
    // já resolvido: não resolve de novo; sem sessão: 401
    assert.equal((await adm('POST', '/api/admin/orders/' + b + '/resolve', { acao: 'liberar' })).status, 409);
    assert.equal((await fetch(base + '/api/admin/orders/' + a + '/verify', { method: 'POST', headers: { 'x-painel': '1' } })).status, 401);
  } finally { _setInvoiceChecker(null); _setInvoicePayer(null); _setReceiptChecker(null); _setStarsReader(null); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
});

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

test('tetos do pagamento automático editáveis no painel', async () => {
  const lim = (b) => fetch(base + '/api/admin/autopay/limites', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: JSON.stringify(b) });
  assert.equal((await fetch(base + '/api/admin/autopay/limites', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-painel': '1' }, body: '{"max":5,"dia":10}' })).status, 401);
  assert.equal((await lim({ max: 0, dia: 10 })).status, 400);
  assert.equal((await lim({ max: 500, dia: 100 })).status, 400); // diário menor que por pedido
  assert.equal((await lim({ max: 20, dia: 30 })).status, 200);
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 26, account: 'jogador_teste', produto: '', msgId: 1 }));
  try {
    await adm('POST', '/api/admin/autopay', { mode: 1 });
    mock.approve = true;
    const j = await (await postJ('/api/orders', { product: 'c1000', gameId: '191911', email: 'lim@x.com' })).json();
    await pagar(j.token); await new Promise((r) => setTimeout(r, 40));
    const o = (await (await adm('GET', '/api/admin/orders')).json()).find((x) => x.id === j.id);
    assert.match(o.canPay.why, /acima do teto por pedido \(20★\)/); // 26★ > 20★
    const s = await (await adm('GET', '/api/admin/stars')).json();
    assert.equal(s.autopay.max, 20); assert.equal(s.autopay.dia, 30);
  } finally { _setInvoiceChecker(null); await lim({ max: 1000, dia: 4000 }); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
});

test('aprovar e pagar: pedido em REVISAR só paga com aprovação do operador (painel e Telegram)', async () => {
  RISK.first = 5000; // regra antiga (1ª compra ≥ R$ 50) para provocar revisão com 50.000 Coins
  const pays = [];
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 771, account: 'jogador_teste', produto: '50 000 coins', msgId: 1 }));
  _setInvoicePayer(async (a) => { pays.push(a); return { stars: a.expectStars, account: a.expectAccount, produto: '', botReply: '' }; });
  try {
    await adm('POST', '/api/admin/autopay', { mode: 1 });
    mock.approve = true;
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

test('entregas: registra como foi entregue e o motivo de não ser automática; analytics agrupa', async () => {
  RISK.first = 5000; // regra antiga (1ª compra ≥ R$ 50) para provocar revisão com 50.000 Coins
  const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1', ...freshIP() }, body: body && JSON.stringify(body) });
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 771, account: 'jogador_teste', produto: '', msgId: 1 }));
  _setInvoicePayer(async (a) => ({ stars: a.expectStars, account: a.expectAccount, produto: '', botReply: '' }));
  try {
    await adm('POST', '/api/admin/autopay', { mode: 2 });
    await adm('POST', '/api/admin/stars', { kind: 'ajuste', saldo_real: 50000 }); // saldo de sobra (testes anteriores gastaram)
    await adm('POST', '/api/admin/autopay/limites', { max: 1000, dia: 100000 });
    mock.approve = true;
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
  // 17/11: cobrança no histórico/saldo SEM recibo não é entrega (o CounterFlame não registrou) → incerto, nunca "paid"
  assert.equal(decideAfterSendError(rpc('FORM_SUBMIT_DUPLICATE'), false, true), 'incerto');
  assert.equal(decideAfterSendError(rpc('FORM_SUBMIT_DUPLICATE'), false, false), 'incerto');
  assert.equal(decideAfterSendError(rpc('BALANCE_TOO_LOW'), false, false), 'safe');
  assert.equal(decideAfterSendError(rpc('BALANCE_TOO_LOW'), false, true), 'incerto');   // cobrou: não é "nada cobrado"
  assert.equal(decideAfterSendError(rpc('BALANCE_TOO_LOW'), false, 'outro'), 'incerto');
});

test('prova pelo saldo: só a queda EXATA do valor prova cobrança', async () => {
  const { provaPeloSaldo } = await import('../tg-user.js');
  assert.equal(provaPeloSaldo(5000, 3501, 1499), true);   // #181: caiu 1.499★
  assert.equal(provaPeloSaldo(5000, 5000, 1499), false);  // não mudou
  assert.equal(provaPeloSaldo(5000, 2002, 1499), 'outro'); // caiu 2× o valor: não é prova de 1 cobrança
  assert.equal(provaPeloSaldo(5000, 8300, 1499), 'outro'); // compra de Stars no meio
  assert.equal(provaPeloSaldo(null, 3501, 1499), null);
  assert.equal(provaPeloSaldo(5000, null, 1499), null);
});

test('desligamento seguro: recusa pagamento novo, espera o pagamento em andamento terminar e só então sai', async () => {
  const { gracefulStop, _resetStopping, autopay } = SRV;
  mock.approve = true;
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


test('fila da conta do Telegram: chamada travada esgota o tempo, a fila segue e o pagamento não cobra depois', async () => {
  const { makeSerial } = await import('../tg-user.js');
  const serial = makeSerial(40);
  let cobrou = false;
  // trava antes de cobrar: erro "safe" (nada cobrado) e, quando destrava, desiste de cobrar
  const travada = serial(async (ctx) => { await new Promise((r) => setTimeout(r, 80)); if (!ctx.dead) cobrou = true; });
  const depois = serial(async () => 'seguiu');
  await assert.rejects(travada, (e) => e.timeout && e.safe && /não respondeu em/.test(e.message));
  assert.equal(await depois, 'seguiu');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(cobrou, false);
  // travada DEPOIS de enviar a cobrança: tempo esgotado é incerto (não "safe")
  const enviada = serial(async (ctx) => { ctx.sent = true; await new Promise((r) => setTimeout(r, 80)); });
  await assert.rejects(enviada, (e) => e.timeout && e.safe === false);
  assert.equal(await serial(async () => 2), 2);
});

test('vigia: pagamento "pagando" há mais de 5 min avisa no Telegram uma vez só', async () => {
  const { vigiaPagamentos } = SRV;
  mock.approve = true;
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '333381', email: 'vg@x.com' })).json();
  await pagar(token);
  await new Promise((r) => setTimeout(r, 20));
  try {
    db.prepare("UPDATE orders SET autopay='paying', autopay_at=? WHERE id=?").run(Date.now() - 60_000, id);
    const n = tgSent.length;
    vigiaPagamentos();
    assert.equal(tgSent.length, n); // 1 min: normal
    db.prepare('UPDATE orders SET autopay_at=? WHERE id=?').run(Date.now() - 6 * 60_000, id);
    assert.ok(vigiaPagamentos() >= 1);
    await ateQue(() => tgSent.length > n);
    assert.match(tgSent.at(-1).text, new RegExp(`Pedido #${id} .*pagando" há 6 min`));
    const m = tgSent.length;
    vigiaPagamentos();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(tgSent.length, m);
  } finally { db.prepare("UPDATE orders SET autopay=NULL WHERE id=?").run(id); }
});

test('erro não tratado: registra e avisa no Sistema no máximo 1x a cada 10 min (exceção força o aviso)', async () => {
  const { erroNaoTratado } = SRV;
  const orig = console.error; console.error = () => {};
  try {
    const t0 = Date.now() + 3600_000;
    assert.equal(erroNaoTratado('unhandledRejection', new Error('boom'), { agora: t0 }), true);
    assert.equal(erroNaoTratado('unhandledRejection', new Error('boom2'), { agora: t0 + 60_000 }), false);
    assert.equal(erroNaoTratado('uncaughtException', new Error('boom3'), { agora: t0 + 60_000, forcar: true }), true);
    assert.equal(erroNaoTratado('unhandledRejection', new Error('boom4'), { agora: t0 + 11 * 60_000 }), true);
    await ateQue(() => tgSent.some((x) => /Erro não tratado na loja \(unhandledRejection\):\nError: boom\n/.test(x.text)));
  } finally { console.error = orig; }
});

test('saúde: /api/health só pela própria máquina; aponta pagamento preso e botões parados', async () => {
  const { saude } = SRV;
  // pelo nginx (X-Forwarded-For) não existe
  assert.equal((await fetch(base + '/api/health', { headers: { 'X-Forwarded-For': '8.8.8.8' } })).status, 404);
  const r = await fetch(base + '/api/health');
  assert.ok([200, 503].includes(r.status));
  assert.equal(typeof (await r.json()).ok, 'boolean');
  mock.approve = true;
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '333371', email: 'hc@x.com' })).json();
  await pagar(token);
  await new Promise((r2) => setTimeout(r2, 20));
  try {
    db.prepare("UPDATE orders SET autopay='paying', autopay_at=? WHERE id=?").run(Date.now() - 6 * 60_000, id);
    assert.ok(saude().some((f) => /pagando" há mais de 5 min/.test(f)));
    const h = await fetch(base + '/api/health');
    assert.equal(h.status, 503);
    assert.ok((await h.json()).falhas.some((f) => /pagando/.test(f)));
  } finally { db.prepare('UPDATE orders SET autopay=NULL WHERE id=?').run(id); }
  const { POLL } = await import('../src/telegram.js');
  const antes = { ...POLL };
  try {
    Object.assign(POLL, { on: true, okAt: Date.now() - 10 * 60_000 });
    assert.ok(saude().some((f) => /botões do Telegram sem resposta há 10 min/.test(f)));
    POLL.okAt = Date.now();
    assert.ok(!saude().some((f) => /botões/.test(f)));
  } finally { Object.assign(POLL, antes); }
});

test('registro de deploy: avisa no Sistema os commits novos e alterações não commitadas; restart igual não avisa', async () => {
  const { registrarDeploy } = SRV;
  db.prepare("DELETE FROM settings WHERE k='deploy_hash'").run();
  const fake = (head, sujo = '', log = '') => (...a) => (a[0] === 'rev-parse' ? head : a[0] === 'status' ? sujo : a.includes('-1') ? `${head} Último` : log);
  assert.match(registrarDeploy(fake('aaa111')), /🚀 Loja publicada: aaa111\n• aaa111 Último/);
  assert.equal(registrarDeploy(fake('aaa111')), null); // restart sem código novo
  const m = registrarDeploy(fake('ccc333', ' M server.js\n', 'ccc333 Outra sessão\nbbb222 Minha mudança'));
  assert.match(m, /ccc333 \(antes: aaa111\)\n• ccc333 Outra sessão\n• bbb222 Minha mudança/);
  assert.match(m, /⚠️ Com alterações NÃO commitadas: server\.js/);
  await ateQue(() => tgSent.some((x) => /Loja publicada: ccc333/.test(x.text)));
  db.prepare("DELETE FROM settings WHERE k='deploy_hash'").run();
});

test('histórico de Stars: só pela própria máquina; casa cada saída com o pedido da fatura', async () => {
  const id = db.prepare("SELECT id FROM orders ORDER BY id DESC LIMIT 1").get().id;
  db.prepare('UPDATE orders SET autopay_info=? WHERE id=?').run(JSON.stringify({ invMsgId: 77002, anterior: 77001 }), id);
  _setInvoiceChecker(async () => ({}));                       // conta de usuário "configurada"
  let pedido;
  SRV._setStarsTxReader(async (q) => { pedido = q; return [
    { id: 'tx-b', stars: -26, date: 1794857930, bot: 'CounterFlameDonate_bot', msgId: 77002, title: 'x', refund: false, pending: false, failed: false },
    { id: 'tx-a', stars: -26, date: 1794857800, bot: 'CounterFlameDonate_bot', msgId: 77001, title: 'x', refund: false, pending: false, failed: false },
    { id: 'tx-c', stars: -40, date: 1794857700, bot: 'outro', msgId: 5, title: null, refund: false, pending: false, failed: false }] });
  try {
    assert.equal((await fetch(base + '/api/local/stars-transacoes', { headers: { 'X-Forwarded-For': '8.8.8.8' } })).status, 404);
    const r = await (await fetch(base + '/api/local/stars-transacoes?desde=1794850000&ate=1794860000')).json();
    assert.deepEqual(pedido, { desde: 1794850000, ate: 1794860000 });
    assert.deepEqual(r.map((t) => [t.id, t.pedido]), [['tx-b', id], ['tx-a', id], ['tx-c', null]]);
    assert.equal(r[0].quando, new Date(1794857930 * 1000).toISOString());
  } finally { SRV._setStarsTxReader(null); _setInvoiceChecker(null); }
});


test('cobrancasCF: só cobranças concluídas do bot do CF, valor exato, na janela', async () => {
  const { cobrancasCF } = await import('../tg-user.js');
  const t = (o) => ({ id: 'x', stars: -26, date: 100, bot: 'CounterFlameDonate_bot', refund: false, pending: false, failed: false, ...o });
  assert.equal(cobrancasCF([t({})], 26, 90, 110).length, 1);
  assert.equal(cobrancasCF([t({ bot: 'outro' }), t({ stars: -27 }), t({ failed: true }), t({ refund: true }), t({ pending: true }), t({ date: 80 }), t({ date: 120 })], 26, 90, 110).length, 0);
});

test('mensagens do bot: só pela própria máquina; fatura casa com o pedido', async () => {
  const id = db.prepare('SELECT id FROM orders ORDER BY id DESC LIMIT 1').get().id;
  db.prepare('UPDATE orders SET autopay_info=? WHERE id=?').run(JSON.stringify({ invMsgId: 88001 }), id);
  _setInvoiceChecker(async () => ({}));
  let q;
  SRV._setBotMsgReader(async (x) => { q = x; return [
    { id: 88001, date: 1794893748, out: false, texto: 'Battle Pass, +1 levels', fatura: { stars: 35, titulo: 'x', recibo: null }, acao: null, respondeA: null },
    { id: 88002, date: 1794893752, out: false, texto: 'Done, payment went through … Order CF-AAAAAA', fatura: null, acao: null, respondeA: null }] });
  try {
    assert.equal((await fetch(base + '/api/local/bot-mensagens', { headers: { 'X-Forwarded-For': '8.8.8.8' } })).status, 404);
    const r = await (await fetch(base + '/api/local/bot-mensagens?desde=1794893700&ate=1794893800')).json();
    assert.deepEqual(q, { desde: 1794893700, ate: 1794893800 });
    assert.deepEqual(r.map((m) => [m.id, m.pedido]), [[88001, id], [88002, null]]);
  } finally { SRV._setBotMsgReader(null); _setInvoiceChecker(null); }
});

test('incerto conferido sozinho (17/11): recibo → entregue; sem recibo → avisa cobrança perdida e paga 1x de novo; 2ª sem recibo → operador', async () => {
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 26, account: 'jogador_teste', produto: '1 000 coins', msgId: 1 }));
  let fatura = 9500, saldo = 5000, falhar = 0;
  const pagas = [];
  _setInvoicePayer(async (q) => {
    await q.onInvoice(++fatura, saldo, Math.floor(Date.now() / 1000) - 120);
    if (falhar > 0) { falhar--; saldo -= q.expectStars; throw Object.assign(new Error('FORM_SUBMIT_DUPLICATE'), { errorMessage: 'FORM_SUBMIT_DUPLICATE' }); } // cobra sem recibo
    pagas.push(fatura); saldo -= q.expectStars;
    return { stars: 26, account: 'jogador_teste', produto: '1 000 coins', botReply: 'Done' };
  });
  _setStarsReader(async () => saldo);
  const recibos = new Set(); const consultadas = [];
  _setReceiptChecker(async (m) => { consultadas.push(m); return recibos.has(m) ? { paid: true, receiptMsgId: m + 1 } : { paid: false }; });
  const row = (id) => db.prepare('SELECT status, autopay, autopay_info FROM orders WHERE id=?').get(id);
  const info = (id) => JSON.parse(row(id).autopay_info);
  try {
    await adm('POST', '/api/admin/autopay', { mode: 1 });
    const novo = async (gid) => { const j = await (await postJ('/api/orders', { product: 'c1000', gameId: gid, email: gid + '@ri.com' })).json(); await pagar(j.token); await new Promise((r) => setTimeout(r, 40)); return j.id; };
    const tentar = async (id, n = 1) => { falhar = n; await adm('POST', '/api/admin/orders/' + id + '/autopay'); assert.equal(row(id).autopay, 'incerto'); };

    // 1) #214/#217: cobrou sem recibo → NÃO marca entregue por isso; avisa a cobrança perdida e paga de novo → entregue
    const a = await novo('161611');
    await tentar(a);
    assert.match(lastCall('editMessageText').body.text, /sem recibo \(o CounterFlame não registrou\)/);
    const t0 = tgSent.length;
    await SRV.resolverIncerto(a);
    let i = info(a);
    assert.equal(row(a).status, 'delivered'); assert.equal(row(a).autopay, 'sent');
    assert.equal(i.retry, 1); assert.equal(i.anterior, 9501); assert.equal(i.invMsgId, 9502); assert.equal(i.perdida.stars, 26);
    assert.deepEqual(pagas, [9502]);
    assert.ok(tgSent.slice(t0).some((m) => new RegExp('Cobrança SEM entrega no pedido #' + a).test(m.text)));
    assert.ok(tgCalls.some((c) => /1ª tentativa sem recibo .*cobrou 26★ SEM entrega/.test(c.body?.text || '')));
    // 10 min depois: a fatura antiga sem recibo → nada; com recibo atrasado → alerta de entrega dupla
    const n0 = tgSent.length;
    await SRV.conferirAtraso(a, 9501);
    assert.equal(tgSent.length, n0);
    recibos.add(9501);
    await SRV.conferirAtraso(a, 9501);
    assert.match(tgSent.at(-1).text, new RegExp('Entrega DUPLA possível no pedido #' + a));

    // 2) com recibo → o CF registrou → entregue, sem pagar de novo
    const b = await novo('161612');
    await tentar(b);
    recibos.add(fatura);
    await SRV.resolverIncerto(b);
    assert.equal(row(b).status, 'delivered'); assert.equal(info(b).resolvido, 'recibo');
    assert.deepEqual(pagas, [9502]);

    // 3) não cobrou (saldo igual) e sem recibo → paga de novo, sem aviso de cobrança perdida
    const c = await novo('161613');
    falhar = 1; const saldoOrig = saldo;
    _setInvoicePayer(async (q) => {
      await q.onInvoice(++fatura, saldo, Math.floor(Date.now() / 1000) - 120);
      if (falhar > 0) { falhar--; throw Object.assign(new Error('FORM_SUBMIT_DUPLICATE'), { errorMessage: 'FORM_SUBMIT_DUPLICATE' }); } // NÃO cobra
      pagas.push(fatura); saldo -= q.expectStars;
      return { stars: 26, account: 'jogador_teste', produto: '1 000 coins', botReply: 'Done' };
    });
    await adm('POST', '/api/admin/orders/' + c + '/autopay');
    assert.equal(saldo, saldoOrig);
    const t1 = tgSent.length;
    await SRV.resolverIncerto(c);
    assert.equal(row(c).status, 'delivered'); assert.equal(pagas.length, 2);
    assert.ok(!tgSent.slice(t1).some((m) => /Cobrança SEM entrega/.test(m.text)));

    // 4) 1ª e 2ª sem recibo → libera para o operador (não tenta a 3ª)
    _setInvoicePayer(async (q) => {
      await q.onInvoice(++fatura, saldo, Math.floor(Date.now() / 1000) - 120);
      if (falhar > 0) { falhar--; saldo -= q.expectStars; throw Object.assign(new Error('FORM_SUBMIT_DUPLICATE'), { errorMessage: 'FORM_SUBMIT_DUPLICATE' }); }
      pagas.push(fatura); saldo -= q.expectStars;
      return { stars: 26, account: 'jogador_teste', produto: '1 000 coins', botReply: 'Done' };
    });
    const d = await novo('161614');
    await tentar(d, 2);
    await SRV.resolverIncerto(d);
    assert.equal(row(d).autopay, 'incerto'); assert.equal(info(d).retry, 1);
    await SRV.resolverIncerto(d);
    assert.equal(row(d).status, 'paid'); assert.equal(row(d).autopay, 'erro');
    assert.match(lastCall('editMessageText').body.text, /2ª tentativa também ficou sem recibo/);
    assert.match(tgSent.at(-1).text, new RegExp('Entrega MANUAL necessária #' + d));
    assert.equal(pagas.length, 2);                                     // nenhuma 3ª tentativa

    // 5) não conseguiu ler o recibo → continua incerto (não sabe se entregou) e não paga
    const e = await novo('161615');
    await tentar(e);
    _setReceiptChecker(async () => { throw new Error('TIMEOUT'); });
    await SRV.resolverIncerto(e);
    assert.equal(row(e).autopay, 'incerto');
    assert.match(lastCall('editMessageText').body.text, /Não consegui ler o recibo \(TIMEOUT\)/);
    assert.equal(pagas.length, 2);

    // 6) já resolvido pelo painel: a conferência automática não mexe
    _setReceiptChecker(async (m) => { consultadas.push(m); return { paid: false }; });
    const g = await novo('161617');
    await tentar(g);
    db.prepare("UPDATE orders SET status='delivered' WHERE id=?").run(g);
    const antes = consultadas.length;
    await SRV.resolverIncerto(g);
    assert.equal(consultadas.length, antes);
  } finally { _setInvoiceChecker(null); _setInvoicePayer(null); _setReceiptChecker(null); _setStarsReader(null); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
});

test('cobrança perdida pelo histórico: ID da transação no aviso; outro pedido de mesmo valor na janela; pendente = sem prova', async () => {
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 26, account: 'jogador_teste', produto: '1 000 coins', msgId: 1 }));
  let fatura = 9700, envio = 0, falhar = 1;
  _setInvoicePayer(async (q) => {
    await q.onInvoice(++fatura, null, envio);
    if (falhar > 0) { falhar--; throw Object.assign(new Error('FORM_SUBMIT_DUPLICATE'), { errorMessage: 'FORM_SUBMIT_DUPLICATE' }); }
    return { stars: 26, account: 'jogador_teste', produto: '1 000 coins', botReply: 'Done' };
  });
  _setReceiptChecker(async () => ({ paid: false }));
  let tx = [];
  SRV._setStarsTxReader(async ({ desde, ate }) => tx.filter((t) => t.date >= desde && t.date <= ate));
  const cf = (date, stars = -26, extra = {}) => ({ id: 'tx' + date + stars, stars, date, bot: 'CounterFlameDonate_bot', msgId: null, refund: false, pending: false, failed: false, ...extra });
  const row = (id) => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  try {
    await adm('POST', '/api/admin/autopay', { mode: 1 });
    const novo = async (gid) => { const j = await (await postJ('/api/orders', { product: 'c1000', gameId: gid, email: gid + '@hi.com' })).json(); await pagar(j.token); await new Promise((r) => setTimeout(r, 40)); return j.id; };
    const agora = () => Math.floor(Date.now() / 1000);

    // 1) histórico mostra a cobrança da 1ª tentativa → aviso com o ID para disputa; paga de novo
    envio = agora() - 120;
    const a = await novo('171711');
    await adm('POST', '/api/admin/orders/' + a + '/autopay');
    tx = [cf(envio + 5), cf(envio + 3, -40), cf(envio - 30)];
    const t0 = tgSent.length;
    await SRV.resolverIncerto(a);
    const i = JSON.parse(row(a).autopay_info);
    assert.equal(row(a).status, 'delivered'); assert.equal(i.perdida.tx, 'tx' + (envio + 5) + '-26');
    assert.ok(tgSent.slice(t0).some((m) => m.text.includes('Transação para disputa no @BotFather: tx' + (envio + 5) + '-26')));

    // 2) 2 cobranças de 26★ na janela, 1 de outro pedido pago nesse meio tempo → a outra é deste
    envio = agora() - 120; falhar = 1;
    const d = await novo('171714');
    await adm('POST', '/api/admin/orders/' + d + '/autopay');
    const outro = await novo('171719');
    db.prepare("UPDATE orders SET status='delivered', autopay='sent', autopay_at=? WHERE id=?").run((envio + 20) * 1000, outro);
    tx = [cf(envio + 4), cf(envio + 20)];
    const p = await SRV.provaCobranca(row(d));
    assert.equal(p.cobrado, true); assert.equal(p.txId, 'tx' + (envio + 4) + '-26');

    // 3) cobrança pendente → sem prova
    tx = [cf(envio + 4, -26, { pending: true })];
    const v = await SRV.provaCobranca(row(d));
    assert.equal(v.cobrado, null); assert.match(v.motivo, /pendente/);
  } finally { _setInvoiceChecker(null); _setInvoicePayer(null); _setReceiptChecker(null); SRV._setStarsTxReader(null); await adm('POST', '/api/admin/autopay', { mode: 0 }); }
});

test('pagamento sem a repetição automática do GramJS: 1 tentativa durante o envio, valor de volta depois (mesmo com erro)', async () => {
  const { semRepetir } = await import('../tg-user.js');
  const c = { _requestRetries: 5 };
  let durante;
  assert.equal(await semRepetir(c, async () => { durante = c._requestRetries; return 'ok'; }), 'ok');
  assert.equal(durante, 1); assert.equal(c._requestRetries, 5);
  await assert.rejects(semRepetir(c, async () => { throw new Error('RPC_CALL_FAIL'); }), /RPC_CALL_FAIL/);
  assert.equal(c._requestRetries, 5);
});

test('conta separada: ID só pela própria máquina', async () => {
  _setInvoiceChecker(async () => ({}));
  SRV._setContaReader(async () => ({ id: '123456789', username: 'conta_loja' }));
  try {
    assert.equal((await fetch(base + '/api/local/conta', { headers: { 'X-Forwarded-For': '8.8.8.8' } })).status, 404);
    assert.deepEqual(await (await fetch(base + '/api/local/conta')).json(), { id: '123456789', username: 'conta_loja' });
  } finally { SRV._setContaReader(null); _setInvoiceChecker(null); }
});

test('intervalo mínimo entre cobranças: espera só o que falta para 10 s', async () => {
  const { esperaEnvio } = await import('../tg-user.js');
  assert.equal(esperaEnvio(0, 1_000_000, 10_000), 0);                 // nunca pagou
  assert.equal(esperaEnvio(1_000_000, 1_004_000, 10_000), 6_000);     // pagou há 4 s → espera 6 s
  assert.equal(esperaEnvio(1_000_000, 1_010_000, 10_000), 0);         // já passou o intervalo
  assert.equal(esperaEnvio(1_000_000, 1_030_000, 10_000), 0);
});
