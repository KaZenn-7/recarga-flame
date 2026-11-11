// Pagamento automático no bot do CounterFlame (conta separada): conferência da fatura, travas (tetos, saldo,
// REVISAR), pagamento com 1 toque/automático e entrega automática. Separado do server.js: o server chama
// initAutopay no mesmo ponto em que este trecho ficava. Única mudança no código: `stopping` virou função
// (o desligamento seguro muda esse valor no server.js e aqui ele é lido na hora).
import { userConfig, checkInvoice, payInvoice } from '../tg-user.js';
import { tgApi } from './telegram.js';

// O corpo fica sem recuo extra de propósito: é o trecho original do server.js.
export function initAutopay({ env, db, PRODUCTS, riskOf, starsOf, STARS_LOW, starsFila, REAL, starsEff, syncStarsReal, sessionDown, markDelivered, paidKeyboard, tgFalha, paidText, tgIncerto, setMotivo, stopping }) {
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
const autopay24 = () => db.prepare("SELECT * FROM orders WHERE autopay='sent' AND autopay_at > ?").all(Date.now() - 86_400_000)
  .reduce((a, o) => a + starsOf(o), 0);
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
  if (sal.n && sal.s < st) return { ok: false, why: `saldo insuficiente (${sal.s}★)` };
  return { ok: true };
}
// pedido em REVISAR que poderia ser pago se aprovado (conferência ✅, tetos, saldo, modo ligado)
const canApprove = (o) => o.status === 'paid' && !o.approved_at && riskOf(o).length > 0 && canAutopay({ ...o, approved_at: 1 }).ok;
async function autopay(id, { aprovar = false, via = aprovar ? 'aprovado' : 'toque' } = {}) {
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
    .run(st, JSON.stringify({ ...info, ...(invMsgId ? { invMsgId } : {}) }), Date.now(), id);
  const code = o.prod_code || PRODUCTS[o.product]?.code;
  try {
    const r = await invoicePayer({ startParam: `s_${code}_${o.game_id}`, expectStars: starsOf(o), expectAccount: o.nickname,
      onInvoice: (m) => { invMsgId = m; db.prepare('UPDATE orders SET autopay_info=? WHERE id=?').run(JSON.stringify({ invMsgId: m }), id); } }, env);
    save('sent', r);
    markDelivered(id, via, [r.botReply && 'Bot do CF: ' + r.botReply, r.recuperado && `(o Telegram respondeu "${r.recuperado}", mas a fatura tem recibo: cobrado 1 vez)`]);
    syncStarsReal(true);
    return { ok: true, ...r };
  } catch (e) {
    const msg = String(e?.errorMessage || e?.message || e).slice(0, 160);
    if (e?.safe) { save('erro', { erro: msg }); return { ok: false, why: 'não pagou: ' + msg }; }
    save('incerto', { erro: msg });
    tgIncerto(id, msg);
    return { ok: false, why: 'pagamento incerto: ' + msg, incerto: true };
  }
}
// pagamento que estava em andamento quando a loja caiu: nunca repete, vira incerto (e avisa, depois de subir)
for (const o of db.prepare("SELECT id FROM orders WHERE autopay='paying'").all()) {
  db.prepare("UPDATE orders SET autopay='incerto', autopay_info=? WHERE id=?").run(JSON.stringify({ erro: 'loja reiniciou durante o pagamento' }), o.id);
  const t = setTimeout(() => tgIncerto(o.id, 'loja reiniciou durante o pagamento'), 3000); t.unref?.();
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
    tgApi('editMessageText', { chat_id: env.TG_CHAT_ID, message_id: cur.tg_msg, text: paidText(cur),
      disable_web_page_preview: true, reply_markup: paidKeyboard(cur) });
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

return { chkOn, _setInvoiceChecker, _setInvoicePayer, getSetting, setSetting, autopayMode, autopayOn, autoMode, autopayMax, autopayDay, autopay24, canAutopay, canApprove, autopay, chkOf, chkLine, conferir, saldoLine };
}
