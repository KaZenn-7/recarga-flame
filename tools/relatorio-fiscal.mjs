#!/usr/bin/env node
// Relatório fiscal de um mês, sob demanda (a loja também gera sozinha no dia 1º):
//   node tools/relatorio-fiscal.mjs [AAAA-MM]      (padrão: mês atual, parcial)
// Lê o banco em modo leitura e grava fiscal/relatorios/AAAA-MM.md e fiscal/registros/AAAA-MM/*.csv.
import 'dotenv/config';
import Database from 'better-sqlite3';
import { gerarArquivos, mesAtual } from '../src/fiscal.js';

const mes = process.argv[2] || mesAtual();
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) { console.error('Uso: node tools/relatorio-fiscal.mjs [AAAA-MM]'); process.exit(1); }
const db = new Database(process.env.DB_PATH || 'loja.db', { readonly: true, fileMustExist: true });
if (db.pragma('user_version', { simple: true }) < 6) { console.error('Banco sem a migração 6 (fiscal): reinicie a loja antes.'); process.exit(1); }
const r = gerarArquivos(db, mes, process.cwd());
console.log(r.md);
console.log(`\nArquivos: ${r.arquivos.relatorio} e ${r.arquivos.registros}/`);
