// Telegram em grupo com tópicos: /configurar cria os tópicos; cada assunto vai para o seu tópico; login sempre no
// privado; avisos antigos continuam editados no chat onde estão; grupo falhando → chat privado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setupStore, mock, tgSent, tgCalls, base, db, handleTgUpdate, summaryTick, COOKIE, ateQue, postJ, pagar, login, OP } from './helpers.js';

setupStore();

const GRUPO = -1001234;
const msg = (text, chat, from = OP) => handleTgUpdate({ update_id: 1, message: { message_id: 5, text, from: { id: from }, chat } });
const forum = { id: GRUPO, type: 'supergroup', is_forum: true };
const calls = (m, n0) => tgCalls.slice(n0).filter((c) => c.method === m);
const novoPago = async (gameId) => {
  mock.approve = true;
  const { token, id } = await (await postJ('/api/orders', { product: 'c1000', gameId, email: 'tp@x.com' })).json();
  await pagar(token);
  await ateQue(() => db.prepare('SELECT tg_msg FROM orders WHERE id=?').get(id).tg_msg);
  return db.prepare('SELECT * FROM orders WHERE id=?').get(id);
};
let antigo, T;

test('sem grupo configurado: tudo no chat privado, como antes', async () => {
  antigo = await novoPago('515151');
  const aviso = tgSent.find((m) => /Pedido pago #/.test(m.text) && m.text.includes(`#${antigo.id}`));
  assert.equal(String(aviso.chat_id), String(OP)); assert.equal(aviso.message_thread_id, undefined);
  assert.equal(antigo.tg_chat, null);
});

test('/configurar: só o operador, só em grupo com Tópicos; cria os 6 tópicos uma vez e grava o arquivo', async () => {
  let n = tgCalls.length;
  await msg('/configurar', forum, 999); // estranho
  assert.equal(tgCalls.length, n);
  await msg('/configurar', { id: OP, type: 'private' });
  assert.match(tgSent.at(-1).text, /dentro do grupo/);
  await msg('/configurar', { id: -100777, type: 'supergroup', is_forum: false });
  assert.match(tgSent.at(-1).text, /Ative "Tópicos"/);
  assert.ok(!fs.existsSync(process.env.TG_TOPICS_FILE));
  n = tgCalls.length;
  await msg('/configurar@LojaBot', forum);
  const criados = calls('createForumTopic', n);
  assert.deepEqual(criados.map((c) => c.body.name), ['🛒 Pedidos', '🚨 Alertas', '📊 Resumo e financeiro', '🤝 Parcerias', '💬 Suporte', '🗄️ Sistema']);
  T = JSON.parse(fs.readFileSync(process.env.TG_TOPICS_FILE, 'utf8'));
  assert.equal(T.chat, String(GRUPO));
  assert.deepEqual(Object.keys(T.threads), ['pedidos', 'alertas', 'resumo', 'parcerias', 'suporte', 'sistema']);
  assert.equal((fs.statSync(process.env.TG_TOPICS_FILE).mode & 0o777), 0o600);
  // apresentação em cada tópico + "pronto"
  for (const k of Object.keys(T.threads)) assert.ok(calls('sendMessage', n).some((c) => c.body.message_thread_id === T.threads[k]), k);
  assert.match(tgSent.at(-1).text, /Pronto/);
  n = tgCalls.length;
  await msg('/configurar', forum);
  assert.equal(calls('createForumTopic', n).length, 0);
  assert.match(tgSent.at(-1).text, /já está configurado/);
  // scripts de fora da loja (backup, healthcheck, acordos) leem o mesmo arquivo
  const destino = (a, f = process.env.TG_TOPICS_FILE) => execFileSync('node', ['tools/tg-destino.cjs', a], { env: { ...process.env, TG_TOPICS_FILE: f } }).toString().trim();
  assert.equal(destino('sistema'), `${GRUPO} ${T.threads.sistema}`);
  assert.equal(destino('nada'), '');
  assert.equal(destino('sistema', '/nao/existe.json'), '');
});

test('pedido novo: aviso no tópico Pedidos; botões funcionam no grupo (só o operador) e editam lá', async () => {
  const o = await novoPago('525252');
  assert.equal(o.tg_chat, String(GRUPO)); assert.equal(o.tg_thread, T.threads.pedidos);
  const aviso = tgSent.find((m) => m.text?.includes(`Pedido pago #${o.id}`));
  assert.equal(aviso.chat_id, String(GRUPO)); assert.equal(aviso.message_thread_id, T.threads.pedidos);
  const toque = (data, from) => handleTgUpdate({ update_id: 2, callback_query: { id: 'q' + Math.random(), data, from: { id: from },
    message: { message_id: o.tg_msg, chat: { id: GRUPO }, text: aviso.text } } });
  let n = tgCalls.length;
  await toque('D:' + o.id, 999);
  assert.match(calls('answerCallbackQuery', n)[0].body.text, /Sem permissão/);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status, 'paid');
  n = tgCalls.length;
  await toque('D:' + o.id, OP);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status, 'delivered');
  const ed = calls('editMessageText', n).at(-1);
  assert.equal(String(ed.body.chat_id), String(GRUPO)); assert.equal(ed.body.message_id, o.tg_msg);
  assert.equal(calls('sendMessage', n).length, 0); // sem mensagem nova
});

test('aviso antigo (de antes do grupo) continua sendo editado no chat privado', async () => {
  const n = tgCalls.length;
  const r = await fetch(base + '/painel/' + antigo.id + '/entregue', { method: 'POST', headers: { Cookie: COOKIE, 'x-painel': '1' } });
  assert.equal((await r.json()).ok, true);
  const ed = calls('editMessageText', n).at(-1);
  assert.equal(String(ed.body.chat_id), String(OP)); assert.equal(ed.body.message_id, antigo.tg_msg);
});

test('código de login sempre no chat privado; resumo diário no tópico Resumo; grupo falhando → privado', async () => {
  await login();
  const cod = tgSent.at(-1);
  assert.match(cod.text, /Código de acesso/); assert.equal(String(cod.chat_id), String(OP)); assert.equal(cod.message_thread_id, undefined);
  const realNow = Date.now;
  const resumo = async (dia, esperadas) => { // summaryTick não espera o envio: aguarda as mensagens chegarem
    db.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('summary_day', ?)").run(dia);
    const n = tgCalls.length;
    try { Date.now = () => Date.parse('2026-11-08T03:00:30Z'); summaryTick(); } finally { Date.now = realNow; }
    await ateQue(() => calls('sendMessage', n).length >= esperadas);
    await new Promise((r) => setTimeout(r, 50));
    return calls('sendMessage', n);
  };
  let s = await resumo('2026-11-05', 1);
  assert.equal(s.length, 1);
  assert.equal(s[0].body.chat_id, String(GRUPO)); assert.equal(s[0].body.message_thread_id, T.threads.resumo); assert.match(s[0].body.text, /Resumo de 07\/11/);
  mock.tgFailChat = GRUPO;
  try { s = await resumo('2026-11-05', 2); } finally { mock.tgFailChat = null; }
  assert.equal(s.length, 2); // tentou o grupo (recusado) e mandou no privado
  assert.equal(String(s[1].body.chat_id), String(OP)); assert.equal(s[1].body.message_thread_id, undefined);
});

test('suporte vai para o tópico Suporte', async () => {
  const n = tgCalls.length;
  const r = await postJ('/api/suporte', { email: 'cli@x.com', assunto: 'outro', msg: 'Olá, preciso de ajuda com a minha compra de hoje.' });
  assert.equal(r.status, 200, await r.clone().text());
  const m = calls('sendMessage', n).find((c) => /Suporte #/.test(c.body.text));
  assert.equal(m.body.chat_id, String(GRUPO)); assert.equal(m.body.message_thread_id, T.threads.suporte);
});

test('mensagens: linha vazia entre parágrafos; lista com "•" fica junta; aplicar de novo não muda', async () => {
  const { paragrafos } = await import('../src/telegram.js');
  const t = paragrafos('📊 Resumo\n💰 2 vendas\n📦 2 entregues\n\nPagar hoje:\n• A: R$ 1\n• B: R$ 2\nFim');
  assert.equal(t, '📊 Resumo\n\n💰 2 vendas\n\n📦 2 entregues\n\nPagar hoje:\n• A: R$ 1\n• B: R$ 2\n\nFim');
  assert.equal(paragrafos(t), t);
});
