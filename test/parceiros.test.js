// Cupons e parceiros: desconto, comissão, pagamentos, plano de metas, faixas, página do parceiro, fechamento e extrato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupStore, mock, tgSent, mailSent, SRV, base, db, COOKIE, ateQue, freshIP, postJ, adm, pagar } from './helpers.js';

setupStore();

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
  assert.equal(mock.lastBody.transaction_amount, 3.33);
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
  mock.approve = true;
  const { token } = await (await postJ('/api/orders', { product: 'c1000', gameId: '749125', email: 'u@v.com', coupon: 'AQUILA' })).json();
  await fetch(base + '/api/orders/' + token); // → paid
  const rep = await (await adm('GET', '/api/admin/coupons/report')).json();
  const a = rep.cupons.find((c) => c.code === 'AQUILA');
  assert.equal(a.pedidos, 1); // o pedido pendente do teste anterior não conta
  assert.equal(a.faturado, 333); assert.equal(a.desconto, 17);
  // lucro = 333 − 227,5 − 3,2967 = 102,2 → comissão 20% = 20,44 → 20
  assert.equal(a.lucro, 102); assert.equal(a.comissao, 20);
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

test('link curto de cupom mantém a origem (?src=wa) e descarta lixo', async () => {
  const r = await fetch(base + '/aquila?src=wa', { redirect: 'manual' });
  assert.equal(r.headers.get('location'), '/?cupom=AQUILA&src=wa');
  const x = await fetch(base + '/aquila?src=%3Cscript%3E', { redirect: 'manual' });
  assert.equal(x.headers.get('location'), '/?cupom=AQUILA');
});

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
  mock.approve = true;
  const j = await (await postJ('/api/orders', { product: 'c1000', gameId: '300102', email: 'b@m2.com', coupon: 'META2' })).json();
  db.prepare('UPDATE orders SET cents=1500 WHERE id=?').run(j.id); // garante cruzar R$ 1.500
  mock.lastBody = { ...mock.lastBody, transaction_amount: 15 };
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

test('reservar para comissões: devido de meses fechados + estimado do mês; crédito só abate do próprio parceiro; próximo dia de pagamento', async () => {
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'RESV', desconto_pct: 0, comissao_pct: 50, ativo: true })).status, 200);
  db.prepare("UPDATE coupons SET plano='fixo' WHERE code='RESV'").run();
  mock.approve = true;
  const ids = [];
  for (const g of ['606061', '606062']) {
    const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: g, email: 'rs@x.com', coupon: 'RESV' })).json();
    await pagar(token); ids.push(id);
  }
  db.prepare("UPDATE orders SET paid_at='2020-01-15 12:00:00' WHERE id=?").run(ids[0]); // venda de um mês já fechado
  const rep = async () => (await (await adm('GET', '/api/admin/coupons/report')).json());
  const soma = (cs) => cs.reduce((a, c) => a + Math.max(0, c.saldo + c.mesCom), 0);
  let r = await rep();
  const c = r.cupons.find((x) => x.code === 'RESV');
  assert.ok(c.saldo > 0 && c.mesCom > 0);
  assert.equal(r.reserva.total, soma(r.cupons));
  assert.equal(r.reserva.mes, r.cupons.reduce((a, x) => a + x.mesCom, 0));
  assert.equal(r.reserva.devido, r.cupons.reduce((a, x) => a + Math.max(0, x.saldo), 0));
  assert.ok(r.reserva.devidoJa <= r.reserva.devido);
  // período não muda a reserva
  assert.equal((await (await adm('GET', '/api/admin/coupons/report?from=2000-01-01&to=2000-01-31')).json()).reserva.total, r.reserva.total);
  // pagou a mais que o devido: o crédito abate só o mês atual dele, nunca a reserva de outro parceiro
  const antes = r.reserva.total;
  const { id: pid } = await (await adm('POST', '/api/admin/coupons/RESV/payouts', { cents: c.saldo + c.mesCom + 500 })).json();
  r = await rep();
  assert.equal(r.reserva.total, antes - (c.saldo + c.mesCom));
  assert.equal(r.reserva.total, soma(r.cupons));
  await adm('DELETE', '/api/admin/payouts/' + pid);
  // próximo pagamento: dia útil, hoje ou depois
  assert.match(r.reserva.proximo, /^\d{4}-\d{2}-\d{2}$/);
  const wd = new Date(r.reserva.proximo + 'T12:00:00Z').getUTCDay();
  assert.ok(wd >= 1 && wd <= 5);
  assert.ok(r.reserva.proximo >= new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10));
});
