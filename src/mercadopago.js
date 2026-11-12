// Mercado Pago: antifraude (bloqueios, impressões, REVISAR), reembolso e sincronização do pagamento (pago,
// cancelado, estornado). Separado do server.js sem mudar o código: o server chama initMercadoPago no mesmo ponto
// em que este trecho ficava (cria as tabelas na mesma ordem). O que o server só declara depois chega por funções
// que repassam a chamada (resolvidas na hora do uso).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tgApi, tgPedidoMsg, saveOrderMsg, orderDest, dest, carTag } from './telegram.js';

// O corpo fica sem recuo extra de propósito: é o trecho original do server.js, linha por linha.
export function initMercadoPago({ env, MP_URL, db, findOrder, mpHeaders, chkOf, brlTxt, notifyPaid, tgAviso, refundKb, orderEv, avisoFaixa, maxPriceCents, emailCarrinho }) {
// ---------- Antifraude (Pix/MED) ----------
// Valores em R$ no .env; padrões pensados para o catálogo atual (maior item R$339,90).
const brlEnv = (v, d) => Math.round(Number(v ?? d) * 100);
// Limites em 24h (por ID ou e-mail) acompanham o PRODUTO MAIS CARO ativo:
//   revisar quando o total pago chega a 3× ele (a 3ª compra dele); recusar no checkout acima de 4× (a 5ª é recusada).
// RISK_DAY_BRL / LIMIT_DAY_BRL no .env fixam valores e desligam o cálculo automático.
const RISK = {
  review: brlEnv(env.RISK_REVIEW_BRL, 340), // pedido a partir disso → "revisar" (acima do 200.000 Coins, R$ 339,90)
  pend: Number(env.MAX_PENDING_PIX ?? 3),   // Pix em aberto ao mesmo tempo por ID/e-mail
  _day: null, _cap: null, _first: null,     // sobrescritas (testes)
  // 1ª compra do ID → revisar só a partir do preço do produto mais caro (preço de tabela, antes do cupom)
  get first() { return this._first ?? (env.RISK_FIRST_BRL ? brlEnv(env.RISK_FIRST_BRL) : maxPriceCents() || 5000); },
  set first(v) { this._first = v; },
  get day() { return this._day ?? (env.RISK_DAY_BRL ? brlEnv(env.RISK_DAY_BRL) : 3 * maxPriceCents() || 30000); },
  set day(v) { this._day = v; },
  get cap() { return this._cap ?? (env.LIMIT_DAY_BRL ? brlEnv(env.LIMIT_DAY_BRL) : 4 * maxPriceCents() || 70000); },
  set cap(v) { this._cap = v; },
};
const lc = (e) => String(e ?? '').trim().toLowerCase();
// Impressões do cliente: aparelho (cookie aleatório), IP e conta bancária de quem pagou.
// IP e conta NUNCA são guardados em claro: só HMAC com chave local (.fp_key, fora do banco),
// então um vazamento do banco não os revela. Perder a chave só invalida esses bloqueios antigos.
const FP_KEY = (() => {
  if (env.NODE_ENV === 'test') return crypto.randomBytes(32);
  const f = env.FP_KEY_PATH || path.join(path.dirname(path.resolve(env.DB_PATH || 'loja.db')), '.fp_key');
  try { return fs.readFileSync(f); } catch { /* cria na 1ª vez */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k, { mode: 0o600, flag: 'wx' });
  return k;
})();
const fp = (v) => (v ? crypto.createHmac('sha256', FP_KEY).update(String(v)).digest('hex').slice(0, 32) : null);
// conta de origem do Pix vinda do MP (só depois de pago). NÃO usar payer.identification:
// sem CPF no pedido, o MP devolve ali o CNPJ dele mesmo (igual em todo pagamento) — verificado 2026-11-07.
function payerPrints(pay) {
  const b = pay.point_of_interaction?.transaction_data?.bank_info?.payer || {};
  return {
    acct: b.account_id ? fp(['acct', lc(b.long_name), String(b.branch ?? ''), String(b.account_id)].join('|')) : null,
  };
}
const BLOCK_KINDS = { game: 'game_id', email: 'email', device: 'device', acct: 'payer_acct' };
const valOf = (o, k) => (k === 'email' ? lc(o.email) : o[BLOCK_KINDS[k]] == null ? null : String(o[BLOCK_KINDS[k]]));
const blockedIn = (kind, value) => !!value && !!db.prepare('SELECT 1 FROM blocked WHERE kind=? AND value=?').get(kind, value);
// checkout: ID, e-mail ou aparelho bloqueado
const isBlocked = (gameId, email, device) => blockedIn('game', String(gameId)) || blockedIn('email', lc(email)) || blockedIn('device', device);
// painel: qualquer impressão deste pedido bloqueada (exceto IP, que é só alerta)
const orderBlocked = (o) => Object.keys(BLOCK_KINDS).some((k) => blockedIn(k, valOf(o, k)));
function blockClient(o, reason) {
  const ins = db.prepare('INSERT OR IGNORE INTO blocked (kind, value, reason, order_id) VALUES (?,?,?,?)');
  for (const k of Object.keys(BLOCK_KINDS)) { const v = valOf(o, k); if (v) ins.run(k, v, reason, o.id); }
  if (o.ip_h) ins.run('ip', o.ip_h, reason, o.id); // IP: só para alertar, nunca bloqueia
}
function unblockClient(o) {
  const del = db.prepare('DELETE FROM blocked WHERE kind=? AND value=?');
  for (const k of Object.keys(BLOCK_KINDS)) { const v = valOf(o, k); if (v) del.run(k, v); }
  if (o.ip_h) del.run('ip', o.ip_h);
}
// soma paga nas últimas 24h pelo mesmo ID ou e-mail
const paid24 = (gameId, email) => db.prepare(`SELECT COALESCE(SUM(cents),0) s FROM orders
  WHERE (game_id=? OR lower(email)=?) AND status IN ('paid','delivered') AND paid_at >= datetime('now','-24 hours')`)
  .get(String(gameId), lc(email)).s;
// Motivos para revisar um pedido pago antes de entregar (vazio = normal).
function riskOf(o) {
  const why = [];
  const ck = chkOf(o);
  if (ck?.status === 'diverge') why.push('conferência no bot do CF não bateu: ' + ck.motivo);
  if (blockedIn('ip', o.ip_h)) why.push('mesmo IP de um pedido estornado (só alerta: IP de 4G é compartilhado)');
  // item de carrinho: valor e 1ª compra contam o carrinho inteiro (um Pix só) — o carrinho todo vai para REVISAR junto
  const tot = o.carrinho_id ? db.prepare('SELECT SUM(cents) c, SUM(COALESCE(list_cents, cents)) l FROM orders WHERE carrinho_id=?').get(o.carrinho_id)
    : { c: o.cents, l: o.list_cents || o.cents };
  if (tot.c >= RISK.review) why.push(`valor alto (${brlTxt(tot.c)}${o.carrinho_id ? ' no carrinho' : ''})`);
  const prev = db.prepare("SELECT COUNT(*) n FROM orders WHERE game_id=? AND id<? AND status='delivered' AND COALESCE(carrinho_id, -1) <> COALESCE(?, -2)")
    .get(o.game_id, o.id, o.carrinho_id ?? null).n;
  if (!prev && tot.l >= RISK.first) why.push('primeira compra deste ID');
  const day = paid24(o.game_id, o.email);
  if (day >= RISK.day) why.push(`${brlTxt(day)} pagos em 24h por este ID/e-mail`);
  return why;
}

// ---------- Reembolso pelo Mercado Pago (só pedido pago e NÃO entregue) ----------
// Chave de idempotência fixa por pedido: o MP nunca devolve 2x o mesmo pedido, mesmo com toque repetido ou rede caindo
// (por isso, em erro, é seguro tentar de novo). Estado em orders.refund_state: pending → done | erro.
async function mpRefund(o) {
  const r = await fetch(`${MP_URL}/${encodeURIComponent(o.mp_id)}/refunds`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { ...mpHeaders, 'Content-Type': 'application/json', 'X-Idempotency-Key': `recargaflame-reembolso-${o.id}` },
    // pedido avulso: devolução integral; item de carrinho: só o valor dele (o resto do Pix é dos outros itens)
    body: o.carrinho_id ? JSON.stringify({ amount: o.cents / 100 }) : '{}',
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && ['approved', 'in_process', 'authorized'].includes(j.status || 'approved'), status: r.status, id: j.id, estado: j.status,
    erro: r.ok ? null : (j.message || j.error || `HTTP ${r.status}`) };
}
let refundCaller = mpRefund;                 // trocável nos testes
const _setRefundCaller = (fn) => { refundCaller = fn || mpRefund; };
const podeReembolsar = (o) => !!(o && o.mp_id && o.paid_at && ['paid', 'cancelled'].includes(o.status) && o.refund_state !== 'done' && o.refund_state !== 'pending');
async function reembolsar(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return { ok: false, why: 'pedido não encontrado' };
  if (['delivered', 'reversed'].includes(o.status)) return { ok: false, why: 'pedido já entregue — sem reembolso pelos Termos' };
  if (!podeReembolsar(o)) return { ok: false, why: o.refund_state === 'done' ? 'já reembolsado' : o.refund_state === 'pending' ? 'reembolso em andamento' : 'pedido sem pagamento' };
  // trava + tira da fila (pago → cancelado) ANTES de chamar o MP
  const lock = db.prepare(`UPDATE orders SET refund_state='pending', status='cancelled', manual_motivo=COALESCE(manual_motivo, 'reembolsado pela loja')
    WHERE id=? AND status IN ('paid','cancelled') AND (refund_state IS NULL OR refund_state='erro')`).run(id);
  if (!lock.changes) return { ok: false, why: 'reembolso em andamento' };
  let r;
  try { r = await refundCaller(o); } catch (e) { r = { ok: false, erro: String(e?.message || e).slice(0, 120) }; }
  if (r.ok) {
    db.prepare("UPDATE orders SET refund_state='done', refund_at=?, refund_info=? WHERE id=?").run(Date.now(), JSON.stringify({ id: r.id, estado: r.estado }), id);
    tgAviso(id, { icone: '💸', titulo: 'reembolsado', saldo: false, botao: `💸 Reembolsado ${brlTxt(o.cents)}`,
      extras: [`${brlTxt(o.cents)} devolvidos ao cliente via Mercado Pago. Pedido cancelado (não entregar).`,
        bloqAuto(o) && `🚫 Tinha sido bloqueado automaticamente: ${bloqAuto(o)}.`] });
    if (o.carrinho_id) emailCarrinho(o.carrinho_id); // último item resolvido: e-mail único do carrinho
    return { ok: true, cents: o.cents };
  }
  db.prepare("UPDATE orders SET refund_state='erro', refund_info=? WHERE id=?").run(JSON.stringify({ erro: r.erro }), id);
  return { ok: false, mp: true, why: 'o Mercado Pago recusou: ' + (r.erro || 'erro desconhecido') + ' (pode tentar de novo; não devolve em dobro)' };
}

// Sinal de estorno anterior (conta bancária que pagou ou aparelho) → NÃO entrega: cancela na hora, bloqueia o
// cliente e avisa o operador para devolver o valor (Termos: pedido não entregue = reembolso integral).
// IP de estorno NÃO entra aqui (4G/CGNAT é compartilhado): continua só como alerta em riskOf.
function estornoSinal(o) {
  if (blockedIn('acct', o.payer_acct)) return 'a conta bancária que pagou já teve estorno';
  if (blockedIn('device', o.device)) return 'o aparelho está ligado a um estorno';
  return null;
}
// motivo do bloqueio automático do pedido (ou null)
const bloqAuto = (o) => (String(o?.manual_motivo || '').startsWith('bloqueado: ') ? o.manual_motivo.slice(11) : null);
function bloquearPedido(o, motivo) {
  const r = db.prepare("UPDATE orders SET status='cancelled', manual_motivo=? WHERE id=? AND status='paid'").run('bloqueado: ' + motivo, o.id);
  if (!r.changes) return;
  blockClient(o, 'bloqueio automático (sinal de estorno)');
  const v = brlTxt(o.cents);
  tgPedidoMsg({ disable_web_page_preview: true, reply_markup: refundKb(o),
    text: `🚫 Pedido #${o.id} BLOQUEADO automaticamente: ${motivo}.\n${o.carrinho_id ? carTag(db, o) + '\n' : ''}${o.prod_nome || o.product} · ${v} · ${o.nickname} · ID ${o.game_id}\n`
    + `NÃO foi entregue. O cliente PAGOU: devolva ${v} (botão abaixo ou app do Mercado Pago — Termos: não entregue = reembolso integral).\n`
    + 'ID e e-mail deste pedido também foram bloqueados. Se for engano, desbloqueie no card do pedido (aba Cancelados).' })
    .then((j) => saveOrderMsg(db, o.id, j));
}

async function syncPayment(mpId) {
  const r = await fetch(`${MP_URL}/${encodeURIComponent(mpId)}`, { headers: mpHeaders, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return;
  const pay = await r.json();
  const o1 = findOrder.get(pay.external_reference);
  const car = o1 ? null : db.prepare('SELECT * FROM carrinhos WHERE token=?').get(pay.external_reference);
  if (!o1 && !car) return;
  const itens = car ? db.prepare('SELECT * FROM orders WHERE carrinho_id=? ORDER BY id').all(car.id) : [o1];
  const total = car ? car.cents : o1.cents;

  if (pay.status === 'approved' && Math.round(pay.transaction_amount * 100) === total) {
    const pp = payerPrints(pay);
    // todos os itens do Pix numa transação; só avisa na transição pending→paid (webhook + polling podem chegar juntos)
    const up = db.prepare("UPDATE orders SET status='paid', paid_at=CURRENT_TIMESTAMP, payer_acct=? WHERE id=? AND status='pending'");
    const pagos = db.transaction(() => itens.filter((o) => up.run(pp.acct, o.id).changes))();
    for (const o of pagos) {
      orderEv(o, 'paid');
      const oo = { ...o, payer_acct: pp.acct };
      const sinal = estornoSinal(oo);
      if (sinal) bloquearPedido(oo, sinal); else { notifyPaid(oo); avisoFaixa(oo); }
    }
  } else if (['cancelled', 'rejected', 'refunded', 'charged_back'].includes(pay.status)) {
    for (const o of itens) cancelarItem(o, pay);
  }
}
// Pix cancelado/recusado/devolvido/contestado: vale para o pedido avulso ou para cada item do carrinho
function cancelarItem(o, pay) {
  const before = o.status;
  const r = db.prepare(`UPDATE orders SET status = CASE status WHEN 'delivered' THEN 'reversed' ELSE 'cancelled' END
    WHERE id=? AND status IN ('pending','paid','delivered')`).run(o.id);
  // estorno/chargeback de pedido já pago ou entregue: operador precisa saber (risco de MED)
  // (reembolso feito pela própria loja — refund_state — não é contestação do cliente: não bloqueia)
  if (r.changes && (before === 'paid' || before === 'delivered') && !o.refund_state) {
    const pp = payerPrints(pay);
    blockClient({ ...o, payer_acct: o.payer_acct || pp.acct }, pay.status);
    tgAviso(o.id, { icone: before === 'delivered' ? '⚠️' : '⛔', saldo: false,
      titulo: `${before === 'delivered' ? 'ESTORNADO após entrega' : 'cancelado após pagamento'} (${pay.status})`,
      botao: before === 'delivered' ? '⚠️ Estornado após entrega' : '⛔ Cancelado — não entregar',
      extras: ['Bloqueados: ID, e-mail, aparelho e conta que pagou (desbloqueie no painel se for engano).'] });
    // e um alerta curto (a edição não notifica): responde ao aviso original, que tem os detalhes
    tgApi('sendMessage', { ...(o.tg_msg ? orderDest(o) : dest('pedidos')), disable_web_page_preview: true,
      ...(o.tg_msg ? { reply_parameters: { message_id: o.tg_msg, allow_sending_without_reply: true } } : {}),
      text: before === 'delivered'
        ? `⚠️ Estorno no pedido #${o.id} (${brlTxt(o.cents)}, já entregue · ${pay.status}) — detalhes no aviso original.`
        : `⛔ Pedido #${o.id} cancelado após pagamento (${brlTxt(o.cents)} · ${pay.status}) — não entregar; detalhes no aviso original.` });
  }
}

return { RISK, lc, fp, payerPrints, isBlocked, orderBlocked, blockClient, unblockClient, paid24, riskOf, podeReembolsar, reembolsar, _setRefundCaller, bloqAuto, syncPayment };
}
