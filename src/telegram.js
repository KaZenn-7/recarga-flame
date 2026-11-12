// Telegram (bot do operador): chamada à API, avisos de pedido (mensagem, botões e edições) e toques nos botões.
// Separado do server.js sem mudar o código das funções. tgApi/tgSend não dependem de nada da loja; os avisos
// recebem do server.js (initAvisos) o que usam de pedidos, Stars e pagamento automático.
import fs from 'node:fs';
import path from 'node:path';
const env = process.env;

// ---------- Destinos: chat privado do operador ou grupo com tópicos ----------
// Sem grupo configurado, tudo vai para o chat privado (TG_CHAT_ID), como antes. Com grupo (comando /configurar
// no grupo), cada mensagem vai para o tópico do seu assunto. O código de login do painel vai SEMPRE no privado.
// Config em tg-topicos.json (ao lado do banco; fora do git): { chat, threads: { pedidos: 12, ... } }.
const TOPICOS = [
  ['pedidos', '🛒 Pedidos', 'avisos de pedido pago com os botões, entregas, aprovar/revisar, reembolso e alertas de cada pedido'],
  ['alertas', '🚨 Alertas', 'Stars acabando, conta separada do Telegram desconectada, loja fora do ar e outros problemas'],
  ['resumo', '📊 Resumo e financeiro', 'resumo diário (00h), comissões do mês, metas dos parceiros e custo da Star'],
  ['parcerias', '🤝 Parcerias', 'acordos, kits de mídia e documentos'],
  ['suporte', '💬 Suporte', 'mensagens do formulário de suporte do site'],
  ['sistema', '🗄️ Sistema', 'backups do banco (a cada 6 h)'],
];
const topicsFile = () => env.TG_TOPICS_FILE || path.join(path.dirname(path.resolve(env.DB_PATH || 'loja.db')), 'tg-topicos.json');
let TOP = null;
function loadTopics() {
  try { const j = JSON.parse(fs.readFileSync(topicsFile(), 'utf8')); TOP = j && j.chat && j.threads ? j : null; } catch { TOP = null; }
  return TOP;
}
loadTopics();
// destino de um assunto: { chat_id, message_thread_id? }
function dest(topico) {
  if (topico === 'privado' || !TOP || !TOP.threads[topico]) return { chat_id: env.TG_CHAT_ID };
  return { chat_id: TOP.chat, message_thread_id: TOP.threads[topico] };
}
// chat (e tópico) onde está o aviso do pedido: pedidos antigos (sem tg_chat) ficaram no chat privado
const orderDest = (o) => (o.tg_chat ? { chat_id: o.tg_chat, ...(o.tg_thread ? { message_thread_id: o.tg_thread } : {}) } : { chat_id: env.TG_CHAT_ID });
const opChat = (id) => String(id) === String(env.TG_CHAT_ID) || (!!TOP && String(id) === String(TOP.chat));
// o toque veio do aviso salvo do pedido? (mesmo nº de mensagem E mesmo chat)
const isOrderMsg = (o, chatId, msgId) => !!o.tg_msg && o.tg_msg === msgId && String(orderDest(o).chat_id) === String(chatId);

// ---------- Telegram (bot do operador) ----------
// Mesmo bot do backup. Falha de envio nunca derruba a loja: só registra no log.
// Chamada genérica à API do bot; devolve o JSON ou null (nunca lança).
// getUpdates com erro passageiro do Telegram (5xx/rede): só registra se continuar falhando (5 seguidas).
let getUpdFalhas = 0;
async function tgApi(method, body, timeoutMs = 10000) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (method === 'getUpdates') {
      if (r.status >= 500) { if (++getUpdFalhas === 5) console.error('Telegram getUpdates falhando há 5 tentativas seguidas:', r.status); return j; }
      getUpdFalhas = 0;
    }
    // "message is not modified" = conferência repetida com o mesmo resultado; não é erro
    if (!r.ok && !/not modified/.test(j?.description || '')) console.error('Telegram', method, r.status, j?.description || '');
    return j;
  } catch (e) { if (method !== 'getUpdates') console.error('Falha Telegram', method, e.message); return null; }
}
// Mensagem de texto para o tópico do assunto. Se o grupo falhar (bot removido, tópico apagado…), manda no privado.
async function tgSend(text, topico = 'alertas') {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return false;
  const post = async (d) => {
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ ...d, text, disable_web_page_preview: true }),
      });
      if (!r.ok) console.error('Telegram respondeu', r.status, topico);
      return r.ok;
    } catch (e) { console.error('Falha ao enviar Telegram:', e.message); return false; }
  };
  const d = dest(topico);
  if (await post(d)) return true;
  return d.message_thread_id ? post({ chat_id: env.TG_CHAT_ID }) : false;
}
// sendMessage de aviso de pedido (com botões) no tópico Pedidos; se o grupo falhar, no privado. Devolve o JSON.
async function tgPedidoMsg(body) {
  const d = dest('pedidos');
  let j = await tgApi('sendMessage', { ...body, ...d });
  if (!j?.ok && d.message_thread_id) j = await tgApi('sendMessage', { ...body, chat_id: env.TG_CHAT_ID });
  return j;
}
// grava onde ficou o aviso do pedido (para editar depois no mesmo chat)
function saveOrderMsg(db, id, j) {
  const m = j?.result;
  if (!m?.message_id) return;
  const privado = String(m.chat?.id ?? env.TG_CHAT_ID) === String(env.TG_CHAT_ID);
  db.prepare('UPDATE orders SET tg_msg=?, tg_chat=?, tg_thread=? WHERE id=?')
    .run(m.message_id, privado ? null : String(m.chat.id), privado ? null : (m.message_thread_id ?? null), id);
}
// /configurar no grupo (só o operador): cria os tópicos e grava tg-topicos.json
async function configurarTopicos(msg) {
  const chat = msg.chat;
  const reply = (text) => tgApi('sendMessage', { chat_id: chat.id, ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}), text });
  if (chat.type === 'private') return reply('Use /configurar dentro do grupo (com Tópicos ativados), não aqui.');
  if (!chat.is_forum) return reply('Ative "Tópicos" nas configurações do grupo e mande /configurar de novo.');
  if (TOP && String(TOP.chat) === String(chat.id)) return reply('Este grupo já está configurado: os tópicos já existem.');
  const threads = {};
  for (const [k, nome] of TOPICOS) {
    const j = await tgApi('createForumTopic', { chat_id: chat.id, name: nome });
    if (!j?.ok) return reply(`Não consegui criar o tópico "${nome}" (${j?.description || 'sem resposta'}). Deixe o bot como administrador com permissão de gerenciar tópicos e mande /configurar de novo.`);
    threads[k] = j.result.message_thread_id;
  }
  const f = topicsFile(), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ chat: String(chat.id), threads }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
  loadTopics();
  for (const [k, , desc] of TOPICOS) await tgApi('sendMessage', { chat_id: chat.id, message_thread_id: threads[k], text: `Aqui chegam: ${desc}.` });
  return reply('✅ Pronto: a loja passa a mandar cada assunto no seu tópico. O código de login do painel continua no chat privado com o bot. Silencie os tópicos que não precisam tocar (ex.: Sistema).');
}
const doneKeyboard = (label) => ({ inline_keyboard: [[{ text: label, callback_data: 'x' }]] });
const hhmmSP = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

export { tgApi, tgSend, tgPedidoMsg, saveOrderMsg, orderDest, isOrderMsg, opChat, dest, loadTopics, doneKeyboard, hhmmSP, TOPICOS };

// ---------- Avisos de pedido no Telegram ----------
// O corpo fica sem recuo extra de propósito: são as funções originais do server.js, sem mudança.
export function initAvisos({ db, riskOf, podeReembolsar, reembolsar, bloqAuto, brlTxt, donateLink, starsOf, starsShortMsg, markDelivered, canAutopay, canApprove, autopay, chkOf, chkLine, conferir, saldoLine }) {
const refundKb = (o) => ({ inline_keyboard: [[{ text: `💸 Reembolsar ${brlTxt(o.cents)}`, callback_data: `r:${o.id}` }]] });
// desbloqueio pelo painel de um pedido bloqueado automaticamente: edita o aviso 🚫 (sem mensagem nova)
function tgDesbloqueado(o) {
  if (!o?.tg_msg) return;
  // pedido de estorno/contestação (bloqueio feito pelo aviso do MP): o valor já voltou ao cliente pelo MP
  if (!bloqAuto(o) && o.paid_at && !o.refund_state && ['reversed', 'cancelled'].includes(o.status)) {
    tgAviso(o.id, { icone: '🔓', titulo: 'cliente desbloqueado', saldo: false, fallback: false, botao: '🔓 Desbloqueado',
      extras: [o.status === 'reversed' ? 'Pedido ESTORNADO após entrega (contestação no Mercado Pago).' : 'Pedido cancelado após pagamento (estorno no Mercado Pago) — não entregar.',
        'Bloqueio desfeito: ID, e-mail, aparelho e conta que pagou podem comprar de novo.'] });
    return;
  }
  if (!bloqAuto(o)) return;
  const pode = podeReembolsar(o), v = brlTxt(o.cents);
  tgAviso(o.id, { icone: '🔓', titulo: 'cliente desbloqueado', saldo: false, fallback: false,
    kb: pode ? refundKb(o) : doneKeyboard(o.refund_state === 'done' ? `💸 Reembolsado ${v}` : '🔓 Desbloqueado'),
    extras: [`Bloqueio automático desfeito: ${bloqAuto(o)}.`,
      pode ? `Pedido cancelado e NÃO entregue: devolva ${v} (botão abaixo ou app do Mercado Pago).` : o.refund_state === 'done' ? `${v} já devolvidos ao cliente.` : ''] });
}
function paidKeyboard(o) {
  const rows = [];
  const url = donateLink(o);
  if (url) rows.push([{ text: `🎮 Abrir entrega · ${starsOf(o)}★`, url }]);
  if (canAutopay(o).ok) rows.push([{ text: `⭐ Pagar ${starsOf(o)}★ e entregar`, callback_data: `p:${o.id}` }]);
  else if (canApprove(o)) rows.push([{ text: `✅ Aprovar e pagar ${starsOf(o)}★`, callback_data: `a:${o.id}` }]);
  rows.push([{ text: '✅ Já entreguei', callback_data: `d:${o.id}` }]);
  return { inline_keyboard: rows };
}
// troca os botões do aviso do pedido (se houver aviso com botões)
function tgMarkup(o, markup) {
  if (!o?.tg_msg) return;
  tgApi('editMessageReplyMarkup', { chat_id: orderDest(o).chat_id, message_id: o.tg_msg, reply_markup: markup });
}
async function handleTgUpdate(u) {
  // comando /configurar (só do operador) no grupo: cria os tópicos
  const msg = u.message;
  if (msg) {
    if (String(msg.from?.id) === String(env.TG_CHAT_ID) && /^\/configurar(@\w+)?(\s|$)/.test(msg.text || '')) await configurarTopicos(msg);
    return;
  }
  const cq = u.callback_query;
  if (!cq) return;
  const answer = (text, alert = false) => tgApi('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: alert });
  // só o operador, no chat privado dele ou no grupo configurado
  if (String(cq.from?.id) !== String(env.TG_CHAT_ID) || !opChat(cq.message?.chat?.id)) {
    return answer('Sem permissão.');
  }
  const cqChat = cq.message.chat.id;
  const m = /^([dDbpPaArR]):(\d+)$/.exec(cq.data || '');
  if (!m) return answer('Nada a fazer aqui.');
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(m[2]));
  if (!o) return answer('Pedido não encontrado.');
  const msgId = cq.message.message_id;
  const setKb = (kb) => tgApi('editMessageReplyMarkup', { chat_id: cqChat, message_id: msgId, reply_markup: kb });
  const noAviso = isOrderMsg(o, cqChat, msgId); // tocou no aviso salvo do pedido (e não numa mensagem avulsa)
  if (m[1] === 'r') {
    if (!podeReembolsar(o)) { await setKb(doneKeyboard(o.refund_state === 'done' ? '💸 Já reembolsado' : 'Sem reembolso possível')); return answer('Este pedido não pode ser reembolsado (entregue, sem pagamento ou já reembolsado).', true); }
    await setKb({ inline_keyboard: [[{ text: `💸 Sim, devolver ${brlTxt(o.cents)}`, callback_data: `R:${o.id}` }]] });
    return answer(`Vai devolver ${brlTxt(o.cents)} ao cliente pelo Mercado Pago e cancelar o pedido #${o.id}. Não dá para desfazer.`, true);
  }
  if (m[1] === 'R') {
    await answer('Reembolsando…');
    const r = await reembolsar(o.id);
    if (!r.ok) {
      // recusado: edita a própria mensagem (o operador está nela) com o motivo e devolve o botão; sem mensagem nova
      const base = String(cq.message?.text || `💸 Pedido #${o.id} · ${o.prod_nome || o.product} · ${brlTxt(o.cents)}\n${o.nickname} · ID ${o.game_id}`)
        .split('\n').filter((l) => !l.startsWith('⚠️ Reembolso recusado')).join('\n');
      const j = await tgApi('editMessageText', { chat_id: cqChat, message_id: msgId, disable_web_page_preview: true,
        text: `${base}\n⚠️ Reembolso recusado às ${hhmmSP()}: ${r.why}`, reply_markup: refundKb(o) });
      if (!j?.ok) { await setKb(refundKb(o)); tgSend(`⚠️ Reembolso do pedido #${o.id}: ${r.why}`, 'pedidos'); }
    }
    else if (!noAviso) await setKb(doneKeyboard(`💸 Reembolsado ${brlTxt(o.cents)}`));
    return;
  }
  if (o.status !== 'paid') {
    const lbl = o.status === 'delivered' ? '✅ Já estava entregue' : '⛔ Pedido ' + (o.status === 'reversed' ? 'estornado' : 'cancelado') + ' — não entregar';
    await setKb(doneKeyboard(lbl));
    return answer(lbl, o.status !== 'delivered');
  }
  if (m[1] === 'd') {
    const risk = riskOf(o);
    await setKb({ inline_keyboard: [
      [{ text: `✅ Sim, entreguei #${o.id}`, callback_data: `D:${o.id}` }],
      [{ text: '↩ Voltar', callback_data: `b:${o.id}` }],
    ] });
    return risk.length
      ? answer(`⚠ REVISAR: ${risk.join('; ')}\n\nConfira no app do MP antes de confirmar.`, true)
      : answer(`Confirme: ${o.prod_nome || o.product} para ${o.nickname} (ID ${o.game_id})`);
  }
  if (m[1] === 'b') { await setKb(paidKeyboard(o)); return answer('Ok'); }
  if (m[1] === 'p') {
    const can = canAutopay(o);
    if (!can.ok) { await setKb(paidKeyboard(o)); return answer('Não dá para pagar automático: ' + can.why, true); }
    await setKb({ inline_keyboard: [
      [{ text: `⭐ Sim, pagar ${starsOf(o)}★ para ${o.nickname}`, callback_data: `P:${o.id}` }],
      [{ text: '↩ Voltar', callback_data: `b:${o.id}` }],
    ] });
    return answer(`Vai gastar ${starsOf(o)}★ da conta separada: ${o.prod_nome || o.product} para ${o.nickname} (ID ${o.game_id}).`, true);
  }
  if (m[1] === 'a') {
    if (!canApprove(o)) { await setKb(paidKeyboard(o)); return answer('Não dá para aprovar e pagar agora (conferência, tetos, saldo ou modo desligado).', true); }
    await setKb({ inline_keyboard: [
      [{ text: `✅ Sim, aprovei — pagar ${starsOf(o)}★`, callback_data: `A:${o.id}` }],
      [{ text: '↩ Voltar', callback_data: `b:${o.id}` }],
    ] });
    return answer(`Pedido em REVISAR: ${riskOf(o).join('; ')}.\n\nSó aprove se conferiu o Pix no app do Mercado Pago. Vai gastar ${starsOf(o)}★ da conta separada.`, true);
  }
  if (m[1] === 'P' || m[1] === 'A') {
    const aprovar = m[1] === 'A';
    await answer('Pagando… (até ~30 s)');
    await setKb(doneKeyboard('⏳ Pagando…'));
    const r = await autopay(o.id, { aprovar });
    if (r.ok) {
      // o aviso já foi editado pelo markDelivered
    } else {
      const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
      if (cur.autopay === 'incerto') await setKb(doneKeyboard('🚨 Pagamento incerto — confira'));
      else if (cur.status === 'paid' && isOrderMsg(cur, cqChat, msgId)) await tgFalha(o.id, `⚠️ Pagamento com 1 toque falhou às ${hhmmSP()}: ${r.why}`);
      else if (cur.status === 'paid') { await setKb(paidKeyboard(cur)); tgSend(`⚠️ Pedido #${o.id}: ${r.why}`, 'pedidos'); }
      else tgSend(`⚠️ Pedido #${o.id}: ${r.why}`, 'pedidos');
    }
    return;
  }
  // D: confirmado
  markDelivered(o.id, 'telegram');
  if (!noAviso) await setKb(doneKeyboard(`✅ Entregue às ${hhmmSP()}`));
  return answer(`Pedido #${o.id} entregue. E-mail enviado ao cliente.`);
}
let tgOffset = 0;
async function tgPoll() {
  for (;;) {
    const j = await tgApi('getUpdates', { offset: tgOffset, timeout: 50, allowed_updates: ['callback_query', 'message'] }, 60000);
    if (!j?.ok) { await new Promise((r) => setTimeout(r, 5000)); continue; }
    for (const u of j.result || []) {
      tgOffset = u.update_id + 1;
      try { await handleTgUpdate(u); } catch (e) { console.error('callback Telegram', e.message); }
    }
  }
}
function paidText(o) {
  const stars = starsOf(o);
  const ck = chkOf(o);
  return [
    `💰 Pedido pago #${o.id}`,
    `${o.prod_nome || o.product} · ${brlTxt(o.cents)} · ${stars}★${o.coupon ? ` · cupom ${o.coupon}` : ''}`,
    `${o.nickname} · ID ${o.game_id}`,
    ...(() => { const w = riskOf(o); return w.length ? [`⚠️ REVISAR antes de entregar: ${w.join('; ')}`] : []; })(),
    starsShortMsg(),
    ck && chkLine(ck),
    `Painel: ${env.PUBLIC_URL}/painel`,
  ].filter(Boolean).join('\n');
}
// Entrega paga no bot com sucesso: EDITA o aviso "💰 Pedido pago" (sem mensagem nova; o aviso já notificou).
// Sem aviso salvo ou se a edição falhar, manda mensagem nova (fallback) com o mesmo texto.
function tgEntregue(id, titulo, extras = [], fallback = true) {
  return tgAviso(id, { icone: '✅', titulo, extras, botao: `✅ Entregue às ${hhmmSP()}`, fallback });
}
// Reescreve o aviso do pedido (texto + 1 botão inerte), sem mensagem nova. Sem aviso salvo ou se a edição
// falhar: manda mensagem nova com o mesmo texto (se fallback).
async function tgAviso(id, { icone, titulo, extras = [], botao, kb, saldo = true, fallback = true }) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const text = [
    `${icone} Pedido #${o.id} · ${titulo} às ${hhmmSP()}`,
    `${o.prod_nome || o.product} · ${brlTxt(o.cents)} · ${starsOf(o)}★${o.coupon ? ` · cupom ${o.coupon}` : ''}`,
    `${o.nickname} · ID ${o.game_id}`,
    ...extras.filter(Boolean),
    saldo && saldoLine(),
  ].filter(Boolean).join('\n');
  if (o.tg_msg) {
    const j = await tgApi('editMessageText', { chat_id: orderDest(o).chat_id, message_id: o.tg_msg, text,
      disable_web_page_preview: true, reply_markup: kb || doneKeyboard(botao) });
    if (j?.ok) return;
  }
  if (fallback) tgSend(text, 'pedidos');
}
async function notifyPaid(o) {
  const j = await tgPedidoMsg({ disable_web_page_preview: true, reply_markup: paidKeyboard(o), text: paidText(o) });
  saveOrderMsg(db, o.id, j);
  conferir(o.id, true); // em segundo plano: lê a fatura no bot do CF; no modo automático, paga em seguida
}
// Pagamento incerto: edita o aviso do pedido com os detalhes + alerta curto respondendo a ele (a edição não
// notifica). Sem aviso salvo: o fallback do tgAviso manda a mensagem completa (que já notifica).
function tgIncerto(id, motivo) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return;
  tgAviso(id, { icone: '🚨', titulo: `pagamento INCERTO (${starsOf(o)}★)`, botao: '🚨 Pagamento incerto — confira',
    extras: [`Erro: ${motivo}`, 'Resolva pelo painel: no pedido, toque em "🔍 verificar cobrança" (a loja confere se a fatura exata deste pedido tem recibo). A loja não vai tentar de novo sozinha.'] });
  if (o.tg_msg) tgApi('sendMessage', { ...orderDest(o), disable_web_page_preview: true,
    reply_parameters: { message_id: o.tg_msg, allow_sending_without_reply: true },
    text: `🚨 Pagamento INCERTO no pedido #${o.id} (${starsOf(o)}★ · ${o.nickname}) — confira no painel; detalhes no aviso original.` });
}
// Entrega automática não feita/falhou: edita o aviso do pedido (mantém os botões de entregar) com o motivo e,
// se houver `alerta`, manda um alerta curto respondendo a ele (a edição não notifica). Sem aviso salvo ou se a
// edição falhar: mensagem nova completa.
async function tgFalha(id, linha, alerta) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o || o.status !== 'paid') return;
  const text = `${paidText(o)}\n${linha}\n${saldoLine()}`;
  let ok = false;
  if (o.tg_msg) {
    const j = await tgApi('editMessageText', { chat_id: orderDest(o).chat_id, message_id: o.tg_msg, text,
      disable_web_page_preview: true, reply_markup: paidKeyboard(o) });
    ok = !!j?.ok;
  }
  if (!ok) { tgSend(alerta ? `${alerta.split(' — ')[0]}\n\n${text}` : text, 'pedidos'); return; }
  if (alerta) tgApi('sendMessage', { ...orderDest(o), disable_web_page_preview: true,
    reply_parameters: { message_id: o.tg_msg, allow_sending_without_reply: true }, text: alerta });
}

return { refundKb, tgDesbloqueado, paidKeyboard, tgMarkup, handleTgUpdate, tgPoll, paidText, tgEntregue, tgAviso, notifyPaid, tgIncerto, tgFalha };
}
