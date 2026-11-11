// Stars: saldo (manual e real), custo por compra e previsão.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupStore, mock, tgSent, base, db, starsForecast, _setStarsReader, dailySummary, COOKIE, freshIP, postJ, adm, pagar } from './helpers.js';

setupStore();

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
  mock.approve = true;
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
  mock.approve = true;
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
