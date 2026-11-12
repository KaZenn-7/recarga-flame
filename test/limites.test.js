// Limites por conta: Arsenal Pass em sequência (só o próximo ticket, um por vez) e níveis do passe até 100,
// contando pedidos já pagos ou com Pix em aberto. Vale na vitrine, no pedido avulso, no carrinho e na conferência antes de pagar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupStore, mock, postJ, pedir, pagar, adm, db, base, freshIP, conferir, _setInvoiceChecker } from './helpers.js';

setupStore(async () => {
  for (const n of [2, 3]) {
    const r = await adm('POST', '/api/admin/products', { key: 'ap_' + n, nome: `Ticket ${n} - Arsenal Pass`, code: 'ap_' + n, cents: 2000 + n, stars: 150, tipo: 'arsenal', niveis: n, ativo: true });
    assert.equal(r.status, 200, await r.text());
  }
});

const player = async (id) => (await fetch(base + '/api/player/' + id, { headers: freshIP() })).json();
const tickets = ['arsenal', 'ap_2', 'ap_3'];
const livres = (bl) => tickets.filter((k) => !bl[k]);

test('vitrine: só o próximo ticket fica disponível (0 → Ticket 1, 2 → Ticket 3, 5 → nenhum)', async () => {
  assert.deepEqual(livres((await player('333000')).blocked), ['arsenal']);
  const p2 = await player('333002');
  assert.deepEqual(livres(p2.blocked), ['ap_3']);
  assert.match(p2.blocked.arsenal, /próximo é o Ticket 3/);
  const p5 = await player('333005');
  assert.deepEqual(livres(p5.blocked), []);
  assert.match(p5.blocked.ap_3, /todos os tickets/);
});

test('pedido avulso e carrinho recusam ticket fora da sequência e mais de um ticket', async () => {
  let r = await pedir('ap_2', '333000', 'a1@ex.com');
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /Ticket 1/);
  r = await postJ('/api/carrinho', { itens: ['c1000', 'ap_3'], gameId: '333001', email: 'a2@ex.com' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /^Ticket 3 - Arsenal Pass: .*Ticket 2/);
  r = await postJ('/api/carrinho', { itens: ['arsenal', 'ap_2'], gameId: '333000', email: 'a3@ex.com' });
  assert.equal(r.status, 409);
});

test('com um ticket em andamento (Pix aberto ou pago), nenhum outro fica disponível', async () => {
  mock.approve = false;
  const r = await pedir('ap_2', '333001', 'a4@ex.com');
  assert.equal(r.status, 200, await r.clone().text());
  const { token } = await r.json();
  assert.deepEqual(livres((await player('333001')).blocked), []);
  const r2 = await pedir('ap_2', '333001', 'a5@ex.com');
  assert.equal(r2.status, 409);
  assert.match((await r2.json()).error, /em andamento/);
  mock.approve = true;
  await pagar(token);
  assert.equal(db.prepare('SELECT status FROM orders WHERE token=?').get(token).status, 'paid');
  assert.deepEqual(livres((await player('333001')).blocked), []);
  db.prepare("UPDATE orders SET status='delivered' WHERE token=?").run(token);
  mock.approve = false;
});

test('níveis: carrinho e vitrine contam o nível da conta e os níveis já pagos/em aberto', async () => {
  // conta no nível 96: cabem 4
  assert.equal((await player('444096')).niveis, 4);
  let r = await postJ('/api/carrinho', { itens: ['bp1', 'bp1', 'bp1', 'bp1', 'bp1'], gameId: '444096', email: 'n1@ex.com' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /mais 4 nível/);
  r = await postJ('/api/carrinho', { itens: ['bp1', 'bp1', 'bp1'], gameId: '444096', email: 'n2@ex.com' });
  assert.equal(r.status, 200, await r.clone().text());
  // 3 níveis com Pix em aberto: sobra 1; bp5 indisponível e 2 níveis recusados
  const p = await player('444096');
  assert.equal(p.niveis, 1);
  assert.ok(p.blocked.bp5 && !p.blocked.bp1);
  r = await postJ('/api/carrinho', { itens: ['bp1', 'bp1'], gameId: '444096', email: 'n3@ex.com' });
  assert.equal(r.status, 409);
  const prods = await (await fetch(base + '/api/products')).json();
  assert.equal(prods.find((x) => x.key === 'bp5').nv, 5);
  assert.equal(prods.find((x) => x.key === 'ap_2').nv, 0);
  assert.equal(prods.find((x) => x.key === 'c1000').nv, 0);
});

test('conferência antes de pagar: ticket que deixou de ser o próximo dá divergência', async () => {
  _setInvoiceChecker(async () => ({ currency: 'XTR', stars: 150, account: 'jogador_teste', produto: 'Ticket 2' }));
  mock.approve = false;
  const r = await pedir('ap_2', '333001', 'c1@ex.com');
  assert.equal(r.status, 200, await r.clone().text());
  const { token } = await r.json();
  const id = db.prepare('SELECT id FROM orders WHERE token=?').get(token).id;
  db.prepare("UPDATE orders SET status='paid', paid_at=?, game_id='333002' WHERE id=?").run(Date.now(), id); // conta já tem 2 tickets
  const ck = await conferir(id);
  assert.equal(ck.status, 'diverge');
  assert.match(ck.motivo, /próximo é o 3, pedido é o 2/);
  db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(id);
});
