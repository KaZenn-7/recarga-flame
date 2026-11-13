// Pagamento automático no bot do CounterFlame (conta separada): conferência da fatura, travas (tetos, saldo,
// REVISAR), pagamento com 1 toque/automático e entrega automática. Separado do server.js: o server chama
// initAutopay no mesmo ponto em que este trecho ficava. Única mudança no código: `stopping` virou função
// (o desligamento seguro muda esse valor no server.js e aqui ele é lido na hora).
import { userConfig, checkInvoice, payInvoice } from '../tg-user.js';
import { tgApi, orderDest, tgSend } from './telegram.js';

// O corpo fica sem recuo extra de propósito: é o trecho original do server.js.
export function initAutopay({ env, db, PRODUCTS, riskOf, starsOf, STARS_LOW, starsFila, REAL, starsEff, syncStarsReal, sessionDown, markDelivered, paidKeyboard, tgFalha, paidText, tgIncerto, setMotivo, stopping, getPlayer, ticketNum, BP_NIVEIS, receiptOf }) {
// ---------- Conferência da fatura no bot do CounterFlame (conta separada; NÃO paga) ----------
// Compara com o pedido: valor em Stars (XTR) e nick da conta do ID. Nome do produto é só informativo
// (o bot escreve "1 000 coins", a loja "1.000 Coins").
let invoiceChecker = checkInvoice;            // trocável nos testes
const chkOn = () => invoiceChecker !== checkInvoice || userConfig(env).ok;
const _setInvoiceChecker = (fn) => { invoiceChecker = fn || checkInvoice; };
// ---------- Pagamento com 1 toque (conta separada) ----------
// Só paga com toque + confirmação do operador. Travas: chave geral (desligada por padrão), conferência ✅,
// pedido sem REVISAR, teto por pedido e por 24h, saldo suficiente. Estados em orders.autopay:
// null → paying → sent | erro (falha ANTES de cobrar: pode tentar de novo) | incerto (falha depois: nunca repete).
// tetos do pagamento automático: editáveis no painel (settings); o .env é só o padrão inicial
const AUTOPAY_MAX_DEF = Number(env.AUTOPAY_MAX_STARS ?? 1000);   // ★ por pedido
const AUTOPAY_DAY_DEF = Number(env.AUTOPAY_DAY_STARS ?? 4000);   // ★ em 24h
const getSetting = (k, d) => db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v ?? d;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
const autopayMax = () => Number(getSetting('autopay_max', AUTOPAY_MAX_DEF));
const autopayDay = () => Number(getSetting('autopay_day', AUTOPAY_DAY_DEF));
let invoicePayer = payInvoice;               // trocável nos testes
const _setInvoicePayer = (fn) => { invoicePayer = fn || payInvoice; };
// modo do pagamento: '0' desligado · '1' um toque · '2' automático (paga sozinho quando a conferência dá ✅)
const autopayMode = () => (chkOn() ? getSetting('autopay', '0') : '0');
const autopayOn = () => autopayMode() !== '0';
const autoMode = () => autopayMode() === '2';
// teto de 24h conta também o que está sendo pago agora ('paying'): itens de um carrinho são checados quase juntos
const autopay24 = () => db.prepare("SELECT * FROM orders WHERE autopay IN ('sent','paying') AND autopay_at > ?").all(Date.now() - 86_400_000)
  .reduce((a, o) => a + starsOf(o), 0);
// Stars já comprometidas com pagamentos em andamento (ainda não saíram do saldo lido)
const emCurso = (exceto) => db.prepare("SELECT * FROM orders WHERE autopay='paying' AND id<>?").all(exceto).reduce((a, o) => a + starsOf(o), 0);
// pode pagar com 1 toque? { ok, why }
function canAutopay(o) {
  if (stopping()) return { ok: false, why: 'loja reiniciando — tente de novo em 1 min' };
  if (!autopayOn()) return { ok: false, why: 'pagamento automático desligado' };
  if (sessionDown(REAL.err)) return { ok: false, why: 'sessão da conta separada caiu — refaça o login' };
  if (o.status !== 'paid') return { ok: false, why: 'pedido não está aguardando entrega' };
  if (o.autopay && o.autopay !== 'erro') return { ok: false, why: o.autopay === 'incerto' ? 'pagamento anterior incerto — confira antes' : 'já pago/pagando' };
  const ck = chkOf(o);
  if (ck?.status !== 'ok') return { ok: false, why: 'conferência no bot ainda não deu ✅' };
  const risk = riskOf(o);
  // em REVISAR só paga depois que o operador aprova ("Aprovar e pagar" grava approved_at)
  if (risk.length && !o.approved_at) return { ok: false, why: 'pedido em REVISAR — revise e use "Aprovar e pagar"', revisar: true };
  const st = starsOf(o);
  const max = autopayMax(), dia = autopayDay();
  if (st > max) return { ok: false, why: `acima do teto por pedido (${max}★)` };
  if (autopay24() + st > dia) return { ok: false, why: `teto de ${dia}★ em 24h atingido` };
  const sal = starsEff();
  const livre = sal.s - emCurso(o.id);
  if (sal.n && livre < st) return { ok: false, why: `saldo insuficiente (${livre}★ livres)` };
  return { ok: true };
}
// pedido em REVISAR que poderia ser pago se aprovado (conferência ✅, tetos, saldo, modo ligado)
const canApprove = (o) => o.status === 'paid' && !o.approved_at && riskOf(o).length > 0 && canAutopay({ ...o, approved_at: 1 }).ok;
// Carrinho em REVISAR: o risco é do Pix inteiro, então o operador aprova uma vez e a loja paga, um por um, os itens
// que podem ser pagos (conferência ✅, tetos, saldo). Item sem conferência ✅ fica para entrega manual.
const carrinhoAprovavel = (cid) => db.prepare("SELECT * FROM orders WHERE carrinho_id=? AND status='paid' ORDER BY id").all(cid).filter(canApprove);
async function aprovarCarrinho(cid) {
  const its = carrinhoAprovavel(cid);
  if (!its.length) return { ok: false, why: 'nada a aprovar neste carrinho (ou fora dos tetos/saldo/conferência)', pagos: [], falhas: [] };
  // tetos e saldo com a SOMA dos itens antes de começar: não paga o carrinho pela metade por falta de teto/saldo
  const tot = its.reduce((a, o) => a + starsOf(o), 0);
  const dia = autopayDay(), sal = starsEff();
  if (autopay24() + tot > dia) return { ok: false, why: `o carrinho (${tot}★) passa do teto de ${dia}★ em 24h`, pagos: [], falhas: [] };
  const livre = sal.s - emCurso(-1);
  if (sal.n && livre < tot) return { ok: false, why: `saldo insuficiente para o carrinho (${tot}★; ${livre}★ livres)`, pagos: [], falhas: [] };
  const agora = Date.now();
  db.transaction(() => { for (const o of its) db.prepare('UPDATE orders SET approved_at=? WHERE id=? AND approved_at IS NULL').run(agora, o.id); })();
  const pagos = [], falhas = [];
  for (const o of its) {
    const r = await autopay(o.id, { via: 'aprovado' });
    if (r.ok) pagos.push(o.id); else falhas.push({ id: o.id, why: r.why, incerto: !!r.incerto });
  }
  return { ok: pagos.length > 0, pagos, falhas };
}
// extra: campos a mais no autopay_info (2ª tentativa: retry/anterior/erro1); nota: linha a mais no aviso de entregue
async function autopay(id, { aprovar = false, via = aprovar ? 'aprovado' : 'toque', extra = {}, nota = '' } = {}) {
  let o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return { ok: false, why: 'pedido não encontrado' };
  if (aprovar) {
    if (!canApprove(o)) return { ok: false, why: o.approved_at ? 'pedido já aprovado' : 'nada a aprovar (ou fora dos tetos/saldo/conferência)' };
    db.prepare('UPDATE orders SET approved_at=? WHERE id=? AND approved_at IS NULL').run(Date.now(), id);
    o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  }
  const can = canAutopay(o);
  if (!can.ok) return can;
  // trava atômica: só um pagamento por pedido
  const lock = db.prepare("UPDATE orders SET autopay='paying', autopay_at=? WHERE id=? AND status='paid' AND (autopay IS NULL OR autopay='erro')").run(Date.now(), id);
  if (!lock.changes) return { ok: false, why: 'já pago/pagando' };
  let invMsgId = null; // nº da mensagem da fatura paga: identifica o pagamento de forma única
  const save = (st, info) => db.prepare('UPDATE orders SET autopay=?, autopay_info=?, autopay_at=? WHERE id=?')
    .run(st, JSON.stringify({ ...extra, ...info, ...(invMsgId ? { invMsgId } : {}) }), Date.now(), id);
  const code = o.prod_code || PRODUCTS[o.product]?.code;
  try {
    const r = await invoicePayer({ startParam: `s_${code}_${o.game_id}`, expectStars: starsOf(o), expectAccount: o.nickname,
      onInvoice: (m) => { invMsgId = m; db.prepare('UPDATE orders SET autopay_info=? WHERE id=?').run(JSON.stringify({ ...extra, invMsgId: m }), id); } }, env);
    save('sent', r);
    markDelivered(id, via, [r.botReply && 'Bot do CF: ' + r.botReply, r.recuperado && `(o Telegram respondeu "${r.recuperado}", mas a fatura tem recibo: cobrado 1 vez)`, nota]);
    if (extra.anterior) agendar(() => conferirAtraso(id, extra.anterior), ATRASO_MS);
    syncStarsReal(true);
    return { ok: true, ...r };
  } catch (e) {
    const msg = String(e?.errorMessage || e?.message || e).slice(0, 160);
    if (e?.safe) { save('erro', { erro: msg }); return { ok: false, why: 'não pagou: ' + msg }; }
    save('incerto', { erro: msg });
    tgIncerto(id, msg, extra.retry ? 'confere' : 'tenta');
    agendar(() => resolverIncerto(id), INCERTO_MS);
    return { ok: false, why: 'pagamento incerto: ' + msg, incerto: true };
  }
}

// ---- Pagamento incerto resolvido sozinho (decisão do operador, 12/11/2026, pedido #74: FORM_SUBMIT_DUPLICATE sem cobrança) ----
// 2 min depois do erro, olha o recibo da fatura EXATA que a loja tentou pagar (só leitura):
//   recibo → foi cobrado 1 vez: marca entregue;
//   sem recibo, 1ª tentativa → paga UMA vez de novo com fatura NOVA (nunca a mesma) e, 10 min depois, confere se a
//     fatura antiga foi cobrada com atraso (aí avisa: cobrança dupla);
//   sem recibo, já era a 2ª → libera o pedido para o operador pagar/entregar (aviso com os botões).
// Não consegue ler o recibo → fica incerto, como antes (operador usa "verificar cobrança").
// nos testes os timers ficam longos (não disparam): os testes chamam resolverIncerto/conferirAtraso direto
const INCERTO_MS = env.NODE_ENV === 'test' ? 3_600_000 : 120_000;
const ATRASO_MS = env.NODE_ENV === 'test' ? 3_600_000 : 600_000;
const infoOf = (o) => { try { return o?.autopay_info ? JSON.parse(o.autopay_info) : {}; } catch { return {}; } };
function agendar(fn, ms) {
  const t = setTimeout(() => Promise.resolve().then(fn).catch((e) => console.error('autopay (incerto):', e?.message || e)), ms);
  t.unref?.();
}
async function resolverIncerto(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o || o.status !== 'paid' || o.autopay !== 'incerto') return; // já resolvido (painel, entrega manual…)
  const info = infoOf(o);
  const head = `#${id} · ${o.prod_nome || o.product} · ${starsOf(o)}★ · ${o.nickname}`;
  if (!info.invMsgId) return; // sem fatura registrada: fica com o operador
  let r;
  try { r = await receiptOf(info.invMsgId, env); } catch (e) {
    await tgFalha(id, `🔍 Não consegui conferir o recibo sozinho (${String(e?.message || e).slice(0, 80)}) — use "verificar cobrança" no painel.`); return;
  }
  const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (cur.status !== 'paid' || cur.autopay !== 'incerto') return;
  if (r.paid) {
    db.prepare("UPDATE orders SET autopay='sent', autopay_info=? WHERE id=? AND autopay='incerto'")
      .run(JSON.stringify({ ...info, stars: starsOf(o), resolvido: 'recibo', recibo: r.receiptMsgId || null, em: Date.now() }), id);
    markDelivered(id, 'auto', [`🔍 Recibo conferido sozinho: a fatura foi cobrada 1 vez (o Telegram tinha respondido "${info.erro}").`]);
    syncStarsReal(true);
    return;
  }
  // sem recibo: nada foi cobrado nessa fatura
  db.prepare("UPDATE orders SET autopay='erro', autopay_info=? WHERE id=? AND autopay='incerto'")
    .run(JSON.stringify({ ...info, erro: `verificado sozinho: sem cobrança (${info.erro})` }), id);
  if (info.retry) {
    setMotivo(id, 'pagamento incerto 2x (sem cobrança)');
    await tgFalha(id, `🔍 Recibo conferido às ${hhmm()}: a 2ª tentativa também não cobrou (${info.erro}). Nada foi cobrado — pague ou entregue manualmente.`,
      `🖐 Entrega MANUAL necessária ${head}: 2 tentativas sem cobrança — detalhes no aviso original.`);
    return;
  }
  const r2 = await autopay(id, { via: 'auto', extra: { retry: 1, anterior: info.invMsgId, erro1: info.erro },
    nota: `🔁 1ª tentativa: "${info.erro}" sem cobrança (recibo conferido); paga de novo com fatura nova.` });
  if (!r2.ok && !r2.incerto) {
    setMotivo(id, 'pagamento incerto (sem cobrança); 2ª tentativa: ' + r2.why);
    await tgFalha(id, `🔍 Recibo conferido: a 1ª tentativa não cobrou. 2ª tentativa não feita: ${r2.why} — pague ou entregue manualmente.`,
      `🖐 Entrega MANUAL necessária ${head}: ${r2.why} — detalhes no aviso original.`);
  }
}
// 2ª tentativa paga: a fatura da 1ª foi cobrada com atraso? (seria cobrança dupla — só avisa, o operador decide)
async function conferirAtraso(id, msgId) {
  const r = await receiptOf(msgId, env);
  if (!r.paid) return;
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  db.prepare('UPDATE orders SET autopay_info=? WHERE id=?').run(JSON.stringify({ ...infoOf(o), cobrancaDupla: msgId }), id);
  tgSend(`⚠️ Cobrança DUPLA no pedido #${id} (${o.prod_nome || o.product} · ${starsOf(o)}★ · ${o.nickname}): a fatura da 1ª tentativa, `
    + `que estava sem recibo, foi cobrada com atraso. A conta pagou ${starsOf(o)}★ a mais no bot do CounterFlame.`, 'alertas');
}
const hhmm = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

// pagamento que estava em andamento quando a loja caiu: nunca repete na hora, vira incerto (e avisa, depois de subir);
// guarda o nº da fatura (se já tinha) para a conferência automática do recibo
for (const o of db.prepare("SELECT * FROM orders WHERE autopay='paying'").all()) {
  db.prepare("UPDATE orders SET autopay='incerto', autopay_info=?, autopay_at=? WHERE id=?")
    .run(JSON.stringify({ ...infoOf(o), erro: 'loja reiniciou durante o pagamento' }), Date.now(), o.id);
  const t = setTimeout(() => tgIncerto(o.id, 'loja reiniciou durante o pagamento', infoOf(o).retry ? 'confere' : 'tenta'), 3000); t.unref?.();
}
// incertos recentes (a loja reiniciou antes da conferência): agenda de novo, no tempo que faltava
for (const o of db.prepare("SELECT * FROM orders WHERE autopay='incerto' AND status='paid' AND autopay_at > ?").all(Date.now() - 3600_000)) {
  agendar(() => resolverIncerto(o.id), Math.max(5000, o.autopay_at + INCERTO_MS - Date.now()));
}

function chkOf(o) { try { return o?.chk ? JSON.parse(o.chk) : null; } catch { return null; } }
function chkLine(ck) {
  if (ck.status === 'ok') return `🔎 Conferido no bot do CF: ${ck.stars}★ · ${ck.account} ✅`;
  if (ck.status === 'diverge') return `❌ Conferência NÃO bateu: ${ck.motivo} — não entregue sem checar`;
  return `⚠️ Conferência falhou: ${ck.motivo} (confira na mão)`;
}
const sameNick = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
// Falha passageira (bot não respondeu, rede) na conferência de um pedido recém-pago: tenta de novo até 3x
// antes de mandar para a entrega manual.
const CHK_TRIES = 3;
const RETRY_MS = env.NODE_ENV === 'test' ? 15 : 90_000;
const transient = (msg) => /não respondeu|FLOOD|timeout|timed out|ECONN|disconnect|reconnect|network|Not connected/i.test(String(msg || ''));
async function conferir(id, fromPaid = false, attempt = 1) {
  if (!chkOn()) return null;
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o || o.status !== 'paid') return null;
  const code = o.prod_code || PRODUCTS[o.product]?.code;
  if (!code) return null;
  let ck;
  try {
    const r = await invoiceChecker(`s_${code}_${o.game_id}`, env);
    const esperado = starsOf(o);
    const erros = [];
    if (r.currency !== 'XTR') erros.push(`moeda ${r.currency}`);
    if (r.stars !== esperado) erros.push(`bot cobra ${r.stars}★, esperado ${esperado}★`);
    if (!sameNick(r.account, o.nickname)) erros.push(`conta no bot "${r.account}", pedido "${o.nickname}"`);
    // Arsenal Pass: na hora de pagar, o ticket do pedido ainda tem que ser o próximo da conta (pode ter comprado no jogo nesse meio-tempo)
    const prod = PRODUCTS[o.product];
    // níveis do passe: o nível atual + este pedido não pode passar do máximo
    if (prod?.niveis && prod.tipo !== 'arsenal') {
      const lv = (await getPlayer(o.game_id))?.battlePass?.level;
      if (!Number.isInteger(lv)) erros.push('não deu para ler o nível do passe da conta');
      else if (lv + prod.niveis > BP_NIVEIS) erros.push(`conta no nível ${lv}: +${prod.niveis} passa de ${BP_NIVEIS}`);
    }
    if (prod?.tipo === 'arsenal') {
      const n = ticketNum({ code, nome: o.prod_nome || prod.nome });
      const ap = (await getPlayer(o.game_id))?.arsenalPass;
      if (!ap || !Number.isInteger(ap.tickets)) erros.push('não deu para ler o Arsenal Pass da conta');
      else if (ap.tickets >= ap.maxTickets) erros.push(`conta já tem os ${ap.maxTickets} tickets`);
      else if (n !== ap.tickets + 1) erros.push(`conta tem ${ap.tickets} ticket(s): o próximo é o ${ap.tickets + 1}, pedido é o ${n ?? '?'}`);
    }
    ck = { status: erros.length ? 'diverge' : 'ok', motivo: erros.join('; '), stars: r.stars, account: r.account,
      produto: r.produto || r.desc, at: Date.now() };
  } catch (e) {
    ck = { status: 'erro', motivo: String(e?.errorMessage || e?.message || e).slice(0, 140), at: Date.now() };
  }
  // vai tentar de novo? então ainda não é o resultado final (cliente segue vendo "entregando automaticamente")
  const retry = fromPaid && ck.status === 'erro' && attempt < CHK_TRIES && transient(ck.motivo);
  ck.tentativa = attempt; ck.final = !retry;
  db.prepare('UPDATE orders SET chk=? WHERE id=?').run(JSON.stringify(ck), id);
  const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (cur.status === 'paid' && cur.tg_msg) {
    tgApi('editMessageText', { chat_id: orderDest(cur).chat_id, message_id: cur.tg_msg, text: paidText(cur),
      disable_web_page_preview: true, reply_markup: paidKeyboard(cur) });
  }
  // item de carrinho: quando o último item termina a conferência, redesenha os botões dos outros (o "Aprovar
  // carrinho" só aparece com todos conferidos). Uma edição por item, uma vez só: o grupo tem limite de mensagens.
  if (!retry && cur.carrinho_id) {
    const irmaos = db.prepare("SELECT * FROM orders WHERE carrinho_id=? AND status='paid' AND id<>?").all(cur.carrinho_id, id);
    if (irmaos.every((x) => chkOf(x)?.final !== false && chkOf(x)) && carrinhoAprovavel(cur.carrinho_id).length > 1) {
      for (const x of irmaos) if (x.tg_msg) tgApi('editMessageReplyMarkup', { chat_id: orderDest(x).chat_id, message_id: x.tg_msg, reply_markup: paidKeyboard(x) });
    }
  }
  if (retry) { const t = setTimeout(() => conferir(id, true, attempt + 1), RETRY_MS); t.unref?.(); return ck; }
  if (fromPaid && autoMode()) await entregaAuto(id);
  else if (fromPaid) setMotivo(id, autopayMode() === '1' ? 'modo 1 toque (automático desligado)' : 'modo desligado');
  return ck;
}

// linha de saldo para os avisos (com alerta de baixo / não cobre a fila)
function saldoLine() {
  const e = starsEff();
  if (!e.n) return '⭐ Saldo de Stars: não configurado';
  const fila = starsFila();
  return `⭐ Saldo: ${e.s}★${e.real ? '' : ' (manual)'} · fila: ${fila}★`
    + (e.s < STARS_LOW ? ` · 🔻 BAIXO (limite ${STARS_LOW}★)` : '')
    + (fila > e.s ? ` · ⚠️ faltam ${fila - e.s}★ para a fila` : '');
}
// Entrega 100% automática (modo '2'): chamada logo após a conferência de um pedido recém-pago.
async function entregaAuto(id, attempt = 1) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o || o.status !== 'paid') return;
  const ck = chkOf(o);
  const head = `#${id} · ${o.prod_nome || o.product} · ${starsOf(o)}★ · ${o.nickname}`;
  if (ck?.status !== 'ok') {
    setMotivo(id, ck?.status === 'diverge' ? 'conferência não bateu' : 'conferência falhou');
    tgFalha(id, `🖐 Entrega automática não feita: ${ck ? chkLine(ck) : 'sem conferência'} — entregue manualmente.`,
      `🖐 Entrega MANUAL necessária ${head}: ${ck?.status === 'diverge' ? 'conferência não bateu' : 'conferência falhou'} — detalhes no aviso original.`);
    return;
  }
  const can = canAutopay(o);
  if (!can.ok) {
    setMotivo(id, can.revisar ? 'REVISAR: ' + riskOf(o)[0] : can.why);
    tgFalha(id, `🖐 Entrega automática não feita: ${can.why} — entregue manualmente.`,
      `🖐 Entrega MANUAL necessária ${head}: ${can.why} — detalhes no aviso original.`); return;
  }
  const r = await autopay(id, { via: 'auto' });
  // recusado ANTES de cobrar por motivo passageiro (bot lento, flood, rede): tenta de novo 1x
  if (!r.ok && !r.incerto && attempt < 2 && transient(r.why)) {
    db.prepare("UPDATE orders SET autopay_info=json_set(COALESCE(autopay_info,'{}'),'$.retry',1) WHERE id=?").run(id);
    const t = setTimeout(() => entregaAuto(id, attempt + 1), RETRY_MS); t.unref?.(); return;
  }
  await syncStarsReal(true);
  if (r.ok || r.incerto) { /* aviso já editado (markDelivered / tgIncerto) */ }
  else {
    setMotivo(id, 'pagamento falhou: ' + r.why);
    tgFalha(id, `⚠️ Entrega automática falhou: ${r.why} — entregue manualmente.`,
      `⚠️ Entrega automática falhou ${head}: ${r.why} — detalhes no aviso original.`);
  }
}

return { resolverIncerto, conferirAtraso, chkOn, _setInvoiceChecker, _setInvoicePayer, getSetting, setSetting, autopayMode, autopayOn, autoMode, autopayMax, autopayDay, autopay24, canAutopay, canApprove, carrinhoAprovavel, aprovarCarrinho, autopay, chkOf, chkLine, conferir, saldoLine };
}
