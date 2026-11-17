// Fiscal (Fase 1): compras de USDT, USDT gasto em Stars (custo médio, ganho/perda), aviso da DeCripto,
// relatório mensal e CSVs. Nada disso muda preço nem checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as H from './helpers.js';
import { relatorioMes, usdtLivro, dataBRT, mesAtual, mesAnterior } from '../src/fiscal.js';
const { setupStore, adm, postJ, pagar, tgSent } = H;

// a loja só é importada no before() do setupStore: dá tempo de apontar a pasta dos arquivos
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-fiscal-'));
process.env.FISCAL_DIR = DIR;

setupStore(async () => {
  H.SRV._setCotacao(async () => ({ cotacao: 5.5, fonte: 'teste' }));
});

const fiscal = async () => (await adm('GET', '/api/admin/fiscal')).json();

test('fiscal: data dd/mm/aaaa hh:mm em Brasília vira UTC; inválida é recusada', () => {
  assert.equal(dataBRT(''), null);
  assert.equal(dataBRT('10/11/2026 21:30'), '2026-11-11 00:30:00');
  assert.equal(dataBRT('31/02/2026 10:00'), undefined);
  assert.equal(dataBRT('10/11/2026 25:00'), undefined);
  assert.equal(dataBRT('01/01/2099'), undefined); // futuro
  assert.equal(dataBRT('ontem'), undefined);
});

test('fiscal: compra de USDT, custo médio, Stars pagas em USDT e completar compra antiga', async () => {
  assert.equal((await fetch(H.base + '/api/admin/fiscal')).status, 401);
  const bad = [{ plataforma: '', tipo: 'p2p', cents: 1000, usdt: 2 }, { plataforma: 'X', tipo: 'banco', cents: 1000, usdt: 2 },
    { plataforma: 'X', tipo: 'p2p', cents: 0, usdt: 2 }, { plataforma: 'X', tipo: 'p2p', cents: 1000, usdt: 0 },
    { plataforma: 'X', tipo: 'p2p', cents: 1000, usdt: 2, data: '99/99/2026' }];
  for (const b of bad) assert.equal((await adm('POST', '/api/admin/fiscal/usdt', b)).status, 400, JSON.stringify(b));
  // 100 USDT por R$ 560 e 100 por R$ 580 → médio R$ 5,70
  await adm('POST', '/api/admin/fiscal/usdt', { plataforma: 'Binance P2P', tipo: 'p2p', cents: 56000, usdt: 100, comprovante: 'ord-1' });
  let f = await fiscal();
  assert.equal(f.saldo, 100); assert.equal(f.custoMedio, 560);
  await adm('POST', '/api/admin/fiscal/usdt', { plataforma: 'Wallet do Telegram P2P', tipo: 'p2p', cents: 58000, usdt: 100 });
  f = await fiscal();
  assert.equal(f.saldo, 200); assert.equal(f.custoMedio, 570); assert.equal(f.compras.length, 2);
  // Stars pagas com 50 USDT: custo = 50 × 5,70 = R$ 285, cotação 5,50 → valor 275 → perda R$ 10
  const r = await (await adm('POST', '/api/admin/fiscal/compra-stars', { stars: 3000, usdt: 50 })).json();
  assert.equal(r.cents, 28500); assert.equal(r.cotacao, 5.5);
  const uso = usdtLivro(H.db).usos.at(-1);
  assert.equal(uso.custoUso, 28500); assert.equal(uso.valor, 27500); assert.equal(uso.ganho, -1000);
  f = await fiscal();
  assert.equal(f.saldo, 150); assert.equal(f.custoMedio, 570);
  const st = await (await adm('GET', '/api/admin/stars')).json();
  assert.equal(st.compras[0].usdt, 50); assert.equal(st.compras[0].cents, 28500);
  // sem saldo de USDT registrado que cubra: pede o valor em R$
  const sem = await adm('POST', '/api/admin/fiscal/compra-stars', { stars: 100, usdt: 999 });
  assert.equal(sem.status, 400); assert.equal((await sem.json()).semSaldo, true);
  assert.equal((await adm('POST', '/api/admin/fiscal/compra-stars', { stars: 100, usdt: 999, cents: 500000 })).status, 200);
  assert.ok((await fiscal()).semLastro > 800); // 999 − 150 sem compra registrada
  // compra de Stars antiga (sem USDT) completada depois
  await adm('POST', '/api/admin/stars', { kind: 'compra', stars: 500, cents: 4400 });
  const antiga = (await (await adm('GET', '/api/admin/stars')).json()).compras.find((p) => p.stars === 500);
  assert.equal(antiga.usdt, null);
  assert.equal((await adm('PATCH', '/api/admin/stars/compras/' + antiga.id, { usdt: 0 })).status, 400);
  assert.equal((await adm('PATCH', '/api/admin/stars/compras/' + antiga.id, { usdt: 8, comprovante: 'tx-9' })).status, 200);
  const row = H.db.prepare('SELECT * FROM stars_purchases WHERE id=?').get(antiga.id);
  assert.equal(row.usdt, 8); assert.equal(row.cotacao, 5.5); assert.equal(row.comprovante, 'tx-9');
  assert.equal(row.cents, 4400); // o custo da Star não muda
  // apagar compra de USDT
  const id = (await fiscal()).compras[0].id;
  assert.equal((await adm('DELETE', '/api/admin/fiscal/usdt/' + id)).status, 200);
  assert.equal((await adm('DELETE', '/api/admin/fiscal/usdt/' + id)).status, 404);
});

test('fiscal: aviso da DeCripto aos 80% e ao passar de R$ 35 mil no mês (uma vez cada)', async () => {
  H.db.exec('DELETE FROM usdt_compras; DELETE FROM stars_purchases;');
  H.db.prepare("DELETE FROM settings WHERE k='decripto_aviso'").run();
  const n0 = tgSent.length;
  await adm('POST', '/api/admin/fiscal/usdt', { plataforma: 'Binance P2P', tipo: 'p2p', cents: 2_900_000, usdt: 5000 });
  assert.match(tgSent.at(-1).text, /80% do limite/);
  await adm('POST', '/api/admin/fiscal/usdt', { plataforma: 'Binance P2P', tipo: 'p2p', cents: 10_000, usdt: 2 });
  assert.equal(tgSent.length, n0 + 1); // mesmo nível: sem aviso repetido
  await adm('POST', '/api/admin/fiscal/usdt', { plataforma: 'Binance P2P', tipo: 'p2p', cents: 700_000, usdt: 1200 });
  assert.match(tgSent.at(-1).text, /passou de R\$ 35 mil/);
  assert.equal(tgSent.length, n0 + 2);
});

test('fiscal: relatório do mês, CSVs e rotina do dia 1º', async () => {
  H.db.exec('DELETE FROM usdt_compras; DELETE FROM stars_purchases;');
  const mes = mesAtual();
  // um pedido pago e entregue no mês
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId: '777001', email: 'fis@x.com' })).json();
  await pagar(token);
  await adm('POST', '/painel/' + id + '/entregue');
  const o = H.db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const r = relatorioMes(H.db, mes, { simulador: false });
  const linha = r.csv.pedidos.split('\n').find((l) => l.startsWith(id + ','));
  assert.ok(linha, 'pedido no CSV');
  const repasse = Math.round(o.prod_stars * o.star_cost * 100);
  assert.ok(linha.includes(',777001,') && linha.includes(',entregue,'));
  assert.ok(linha.includes((repasse / 100).toFixed(2)) && linha.includes(((o.cents - repasse) / 100).toFixed(2)));
  assert.equal(r.csv.compras_usdt.split('\n')[0], 'id,data_hora_brt,plataforma,tipo_plataforma,brl_pago,usdt_recebido,custo_brl_por_usdt,comprovante');
  assert.match(r.md, /Receita bruta pelos dois modelos/);
  assert.ok(r.resumo.recebido >= o.cents && r.resumo.taxa < r.resumo.recebido);
  // pedido pago e reembolsado sem entrega: reembolso, sem repasse
  H.db.prepare("UPDATE orders SET delivered_at=NULL, status='cancelled', refund_state='done', refund_at=? WHERE id=?").run(Date.now(), id);
  const r2 = relatorioMes(H.db, mes, { simulador: false });
  const l2 = r2.csv.pedidos.split('\n').find((l) => l.startsWith(id + ','));
  assert.ok(l2.includes(',reembolsado,'));
  assert.equal(r2.resumo.recebido - r2.resumo.reemb - r2.resumo.repasse, r2.resumo.taxa);
  // rotina: 1ª execução só marca o mês anterior; no mês seguinte gera os arquivos e avisa
  H.db.prepare("DELETE FROM settings WHERE k='fiscal_mes'").run();
  assert.equal(H.SRV.fiscalTick(Date.now()), null);
  assert.equal(H.db.prepare("SELECT v FROM settings WHERE k='fiscal_mes'").get().v, mesAnterior(mes));
  const prox = Date.now() + 32 * 86_400_000;
  const g = H.SRV.fiscalTick(prox);
  assert.equal(g.resumo.mes, mes);
  assert.ok(fs.existsSync(path.join(DIR, 'fiscal/relatorios', mes + '.md')));
  const csvp = path.join(DIR, 'fiscal/registros', mes, 'pedidos.csv');
  assert.equal(fs.statSync(csvp).mode & 0o777, 0o600);
  assert.match(tgSent.at(-1).text, /Relatório fiscal de/);
  assert.equal(H.SRV.fiscalTick(prox), null); // não repete
  fs.rmSync(DIR, { recursive: true, force: true });
});
