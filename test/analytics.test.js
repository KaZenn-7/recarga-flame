// Analytics: vendas, funil, margem, picos/clientes e resumo diário.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupStore, mock, tgSent, base, db, dailySummary, summaryTick, COOKIE, freshIP, postJ, adm, pagar } from './helpers.js';

// dados próprios deste arquivo: cupom AQUILA (plano fixo, 5% / 20%) e uma venda com ele, entregue logo após paga
setupStore(async () => {
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'AQUILA', desconto_pct: 5, comissao_pct: 20, ativo: true })).status, 200);
  db.prepare("UPDATE coupons SET plano='fixo' WHERE code='AQUILA'").run();
  mock.approve = true;
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '303031', email: 'an@x.com', coupon: 'AQUILA' })).json();
  await pagar(token);
  const r = await fetch(base + '/painel/' + id + '/entregue', { method: 'POST', headers: { Cookie: COOKIE, 'x-painel': '1' } });
  assert.equal((await r.json()).ok, true);
});

test('analytics: vendas, conversão, lucro após comissão, entrega e estornos', async () => {
  const q = await (await adm('GET', '/api/admin/analytics')).json();
  // confere coerência em vez de números fixos
  assert.ok(q.vendas >= 1);
  assert.equal(q.faturado, q.porDia.reduce((a, d) => a + d.cents, 0));
  assert.equal(q.vendas, q.produtos.reduce((a, p) => a + p.n, 0));
  assert.ok(q.pixPagos <= q.pixGerados);
  assert.equal(q.ticket, Math.round(q.faturado / q.vendas));
  // entrega: a preparação marcou um pedido como entregue logo após pago
  assert.ok(q.entregas >= 1); assert.ok(q.entregaMedianaMin <= 1); assert.equal(q.entregaAte1h, 1);
  // período sem vendas
  const vazio = await (await adm('GET', '/api/admin/analytics?from=2000-01-01&to=2000-01-31')).json();
  assert.equal(vazio.vendas, 0); assert.equal(vazio.entregaMedianaMin, null);
});

test('resumo diário: números do dia, autonomia de Stars e envio 1x por dia', async () => {
  const txt = dailySummary();
  assert.match(txt, /📊 Resumo de \d{2}\/\d{2}\/\d{4}/);
  assert.match(txt, /💰 \d+ vendas? · R\$/);
  assert.match(txt, /📦 \d+ entregues? \(\d+ automáticas?, \d+ manual\)/);
  assert.match(txt, /⭐ \d+★ gastos no dia/);
  // comissões do dia = soma da comissão das vendas com cupom do dia; reserva = total do quadro do painel
  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const rep = await (await adm('GET', '/api/admin/coupons/report')).json();
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const comHoje = rep.cupons.reduce((a, c) => a + c.mesCom, 0); // todas as vendas com cupom deste arquivo são de hoje
  assert.ok(comHoje > 0);
  const linha = dailySummary(hoje).split('\n').find((l) => l.startsWith('🤝'));
  assert.equal(linha, `🤝 Comissões do dia ${brl(comHoje)} (estimado) · reserva total ${brl(rep.reserva.total)}`);
  // dia sem nada
  const vazio = dailySummary('2000-01-01');
  assert.match(vazio, /💰 0 vendas · R\$\s?0,00/);
  // envia uma vez só por dia, logo após a meia-noite, o resumo do dia que terminou
  db.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('summary_day', '2026-11-06')").run(); // 06/11 já enviado
  const n = tgSent.length;
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-11-08T02:59:00Z'); // 23:59 de 07/11 em Brasília: o dia ainda não acabou
    summaryTick();
    assert.equal(tgSent.length, n);
    Date.now = () => Date.parse('2026-11-08T03:00:30Z'); // 00:00 de 08/11: manda o resumo de 07/11 (inclui 23h–00h)
    summaryTick(); summaryTick();
  } finally { Date.now = realNow; }
  assert.equal(tgSent.length, n + 1);
  assert.match(tgSent.at(-1).text, /Resumo de 07\/11\/2026/);
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
  mock.approve = true;
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
