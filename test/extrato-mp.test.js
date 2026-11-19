// Extrato do Mercado Pago: leitura do CSV, movimentos fora da rotina com o pedido de origem, alerta sem repetir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lerCsv, incomuns, textoMov, prontoDesde, initExtratoMp } from '../src/extrato-mp.js';

const CSV = `DATE;SOURCE_ID;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;MP_FEE_AMOUNT;BALANCE_AMOUNT
2026-11-16T16:22:11.000-03:00;188912052525;payment;124.55;0.00;125.80;1.25;500.00
2026-11-17T07:00:17.000-03:00;188912052525;reserve_for_debt_payment;0.00;125.80;-125.80;0.00;374.20
2026-11-17T13:02:50.000-03:00;188912052525;reserve_for_debt_payment;125.80;0.00;125.80;0.00;500.00
2026-11-18T10:00:00.000-03:00;999;payout;0.00;400.00;-400.00;0.00;100.00
`;
const banco = () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE orders (id INTEGER, mp_id TEXT, nickname TEXT, game_id TEXT, carrinho_id INTEGER); CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT)');
  db.prepare("INSERT INTO orders VALUES (178,'188912052525','Marcoscarr000','2926063',11),(179,'188912052525','Marcoscarr000','2926063',11)").run();
  return db;
};

test('extrato: só a retenção foge da rotina e vem com o pedido do carrinho', () => {
  const rows = lerCsv(CSV);
  assert.equal(rows.length, 4); assert.equal(rows[1].DESCRIPTION, 'reserve_for_debt_payment');
  const inc = incomuns(rows, banco());
  assert.equal(inc.length, 2);
  assert.deepEqual(inc[0].origem, { pedidos: [178, 179], carrinho: 11, conta: 'Marcoscarr000', gameId: '2926063' });
  assert.equal(inc[0].debito, 125.8); assert.equal(inc[1].credito, 125.8);
  assert.match(textoMov(inc[0]), /retenção para pagar dívida.*−R\$ 125,80 \(saiu do saldo\)\npagamento 188912052525 · pedidos #178, #179 \(carrinho 11\)/s);
  assert.match(textoMov(inc[1]), /\+R\$ 125,80 \(voltou para o saldo\)/);
});

test('extrato: relatório pronto só se foi pedido agora (não pega um antigo)', () => {
  const t0 = Date.parse('2026-11-19T18:00:00Z');
  const lista = [{ file_name: 'velho.csv', status: 'enabled', date_created: '2026-11-18T10:00:00.000-04:00' },
    { file_name: 'novo.csv', status: 'enabled', date_created: '2026-11-19T14:01:29.000-04:00' }, { file_name: 'gerando.csv', status: 'processing', date_created: '2026-11-19T14:02:00.000-04:00' }];
  assert.equal(prontoDesde(lista, t0), 'novo.csv');
  assert.equal(prontoDesde(lista.slice(0, 1), t0), null);
});

test('checagem diária: avisa cada movimento fora da rotina uma vez só', async () => {
  const db = banco();
  const cfg = new Map();
  const avisos = [];
  const fetchFn = async (url, o = {}) => {
    if (o.method === 'POST') return new Response('{"id":1}', { status: 202 });
    if (url.endsWith('/list')) return new Response(JSON.stringify([{ file_name: 'x.csv', status: 'enabled', date_created: new Date().toISOString() }]));
    return new Response(CSV);
  };
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-extrato-'));
  const ex = initExtratoMp({ env: { MP_ACCESS_TOKEN: 't' }, db, tgSend: (t, a) => avisos.push([a, t]), getSetting: (k, d) => cfg.get(k) ?? d, setSetting: (k, v) => cfg.set(k, String(v)), fetchFn, raiz });
  try {
    let r = await ex.checarExtrato({ esperaMs: 1000, passoMs: 1 });
    assert.equal(r.novos, 2); assert.equal(avisos.length, 2); assert.equal(avisos[0][0], 'alertas');
    assert.match(avisos[0][1], /Movimento fora da rotina no Mercado Pago[\s\S]*#178, #179/);
    r = await ex.checarExtrato({ esperaMs: 1000, passoMs: 1 });   // mesmo extrato de novo: nada novo
    assert.equal(r.novos, 0); assert.equal(avisos.length, 2);
    const f = path.join(raiz, 'backups/extrato-mp/x.csv');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);              // extrato salvo só para o dono
  } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
});
