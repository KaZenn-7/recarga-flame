#!/usr/bin/env node
// Envia um arquivo (.docx, .md…) para o chat do operador no Telegram (bot da loja).
//   node --env-file=.env docs/acordo/enviar.cjs "<arquivo.docx>" "legenda"
// Usa TG_BOT_TOKEN e TG_CHAT_ID do .env — nunca imprime os valores.
const fs = require('fs');
const path = require('path');

(async () => {
  const [file, caption = ''] = process.argv.slice(2);
  const { TG_BOT_TOKEN: tk, TG_CHAT_ID: chat } = process.env;
  if (!file || !fs.existsSync(file)) throw new Error('arquivo não encontrado');
  if (!tk || !chat) throw new Error('TG_BOT_TOKEN/TG_CHAT_ID ausentes (rode com --env-file=.env)');
  const fd = new FormData();
  fd.append('chat_id', chat);
  fd.append('caption', caption.slice(0, 1000));
  fd.append('document', new Blob([fs.readFileSync(file)], { type: file.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : file.endsWith('.png') ? 'image/png' : 'text/plain' }), path.basename(file));
  const r = await (await fetch(`https://api.telegram.org/bot${tk}/sendDocument`, { method: 'POST', body: fd })).json();
  if (!r.ok) throw new Error('Telegram: ' + r.description);
  console.log('enviado:', r.result.document.file_name, `(${r.result.document.file_size} bytes)`);
})().catch((e) => { console.error('erro:', e.message); process.exit(1); });
