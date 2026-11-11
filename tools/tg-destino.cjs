#!/usr/bin/env node
// Destino no Telegram de um assunto, para os scripts de fora da loja (backup, healthcheck, envio de documentos).
//   node tools/tg-destino.cjs <assunto>   → imprime "chat_id thread_id" (grupo com tópicos) ou nada (use o chat privado)
// Lê tg-topicos.json (criado pelo /configurar no grupo); assuntos: pedidos alertas resumo parcerias suporte sistema.
const fs = require('fs');
const path = require('path');

const file = process.env.TG_TOPICS_FILE || path.join(__dirname, '..', 'tg-topicos.json');
const assunto = process.argv[2];
try {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = j?.threads?.[assunto];
  if (j?.chat && Number.isInteger(t)) console.log(`${j.chat} ${t}`);
} catch { /* sem grupo configurado: nada */ }
