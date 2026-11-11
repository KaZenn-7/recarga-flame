#!/usr/bin/env node
// Envia um arquivo (.docx, .md…) ao operador no Telegram (bot da loja): no tópico 🤝 Parcerias do grupo, se
// configurado (tg-topicos.json); senão (ou se o grupo falhar), no chat privado.
//   node --env-file=.env docs/acordo/enviar.cjs "<arquivo.docx>" "legenda" [assunto]   (assunto padrão: parcerias)
// Usa TG_BOT_TOKEN e TG_CHAT_ID do .env — nunca imprime os valores.
const fs = require('fs');
const path = require('path');

(async () => {
  const [file, caption = '', assunto = 'parcerias'] = process.argv.slice(2);
  const { TG_BOT_TOKEN: tk, TG_CHAT_ID: chat } = process.env;
  if (!file || !fs.existsSync(file)) throw new Error('arquivo não encontrado');
  if (!tk || !chat) throw new Error('TG_BOT_TOKEN/TG_CHAT_ID ausentes (rode com --env-file=.env)');
  const send = async (chatId, thread) => {
    const fd = new FormData();
    fd.append('chat_id', chatId);
    if (thread) fd.append('message_thread_id', String(thread));
    fd.append('caption', caption.slice(0, 1000));
    fd.append('document', new Blob([fs.readFileSync(file)], { type: file.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : ({ '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.zip': 'application/zip' }[path.extname(file)] || 'text/plain') }), path.basename(file));
    return (await fetch(`https://api.telegram.org/bot${tk}/sendDocument`, { method: 'POST', body: fd })).json();
  };
  let top = null;
  try { const j = JSON.parse(fs.readFileSync(process.env.TG_TOPICS_FILE || path.join(__dirname, '..', '..', 'tg-topicos.json'), 'utf8')); if (j?.chat && j.threads?.[assunto]) top = j; } catch { /* sem grupo */ }
  let r = top ? await send(top.chat, top.threads[assunto]) : null;
  if (!r?.ok) r = await send(chat);
  if (!r.ok) throw new Error('Telegram: ' + r.description);
  console.log('enviado:', r.result.document.file_name, `(${r.result.document.file_size} bytes)`);
})().catch((e) => { console.error('erro:', e.message); process.exit(1); });
