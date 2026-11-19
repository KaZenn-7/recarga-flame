#!/usr/bin/env node
// Extrato do Mercado Pago sob demanda: pede o Relatório de liberações dos últimos N dias, baixa (backups/extrato-mp, 600)
// e mostra o resumo por tipo e os movimentos fora da rotina, já com o pedido da loja.
//   node --env-file=.env tools/extrato-mp.mjs [dias=7]        (só leitura; não imprime a chave)
//   node tools/extrato-mp.mjs --arquivo backups/extrato-mp/<arquivo>.csv   (analisa um já baixado)
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { lerCsv, incomuns, textoMov, nomeMov, mpRelatorio, nomes, prontoNovo, cobre, guardar } from '../src/extrato-mp.js';

process.chdir(new URL('..', import.meta.url).pathname);
const db = new Database(process.env.DB_PATH || 'loja.db', { readonly: true });
let txt, nome;
const ia = process.argv.indexOf('--arquivo');
if (ia > 0) { nome = process.argv[ia + 1]; txt = fs.readFileSync(nome, 'utf8'); }
else {
  if (!process.env.MP_ACCESS_TOKEN) { console.error('rode com --env-file=.env'); process.exit(1); }
  const dias = Number(process.argv[2]) || 7;
  const api = mpRelatorio(process.env.MP_ACCESS_TOKEN);
  const t0 = Date.now();
  const antes = nomes(await api.lista());
  const de = Date.now() - dias * 86_400_000, ate = Date.now();
  // já há relatório de hoje cobrindo esses dias? o MP não gera outro igual: usa esse
  nome = cobre(await api.lista(), de, ate);
  if (nome) console.log('já existe relatório de hoje para esse período:', nome);
  else await api.pedir(de, ate);
  process.stdout.write(`pedindo o extrato de ${dias} dias ao Mercado Pago`);
  while (!nome && Date.now() - t0 < 30 * 60_000) { await new Promise((r) => setTimeout(r, 15_000)); process.stdout.write('.'); nome = prontoNovo(await api.lista(), antes); }
  console.log('');
  if (!nome) { console.error('não ficou pronto em 30 min — tente de novo mais tarde'); process.exit(1); }
  txt = await api.baixar(nome);
  console.log('salvo em', guardar(nome, txt));
}
const rows = lerCsv(txt);
const brl = (v) => 'R$ ' + v.toFixed(2).replace('.', ',');
const porTipo = {};
for (const r of rows) {
  const t = (porTipo[r.DESCRIPTION || '—'] ||= { n: 0, cred: 0, deb: 0 });
  t.n++; t.cred += Number(r.NET_CREDIT_AMOUNT) || 0; t.deb += Number(r.NET_DEBIT_AMOUNT) || 0;
}
console.log(`\n${rows.length} movimentos`);
for (const [t, v] of Object.entries(porTipo).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${nomeMov(t).padEnd(42)} ${String(v.n).padStart(4)}×   entrou ${brl(v.cred).padStart(12)}   saiu ${brl(v.deb).padStart(12)}`);
const inc = incomuns(rows, db);
console.log(`\nFora da rotina: ${inc.length}`);
for (const m of inc) console.log('  ' + textoMov(m).replace('\n', '\n  '));
