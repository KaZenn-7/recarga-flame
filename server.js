import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import { userConfig, readStarsBalance, checkInvoice, payInvoice, invoicePaid } from './tg-user.js';
import { LOGIN_HTML } from './views/login.js';
import { painelHtml } from './views/painel.js';
import { homeHtml, pageHtml } from './seo-home.js';
import { initParceiros } from './src/parceiros.js';
import { tgApi, tgSend, doneKeyboard, hhmmSP, initAvisos } from './src/telegram.js';

const env = process.env;
for (const k of ['MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'ADMIN_USER', 'ADMIN_PASS', 'PUBLIC_URL']) {
  if (!env[k]) throw new Error(`Faltou ${k} no .env`);
}
const CF_BASE = env.CF_BASE || 'https://counterflame.com';
const MP_URL = 'https://api.mercadopago.com/v1/payments';

// Catálogo inicial (seed). Depois disso os produtos vivem no banco e são geridos pelo painel.
// [key, nome, cents, stars, code, tipo, niveis, ativo]
const SEED_PRODUCTS = [
  ['c1000', '1.000 Coins', 350, 26, 'c_1000', '', 0, 1],
  ['c3000', '3.000 Coins', 700, 53, 'c_3000', '', 0, 1],
  ['c5000', '5.000 Coins', 1000, 86, 'c_5000', '', 0, 1],
  ['c10000', '10.000 Coins', 1900, 171, 'c_10000', '', 0, 1],
  ['c30000', '30.000 Coins', 5500, 471, 'c_30000', '', 0, 1],
  ['c50000', '50.000 Coins', 9000, 771, 'c_50000', '', 0, 1],
  ['c100000', '100.000 Coins', 17250, 1499, 'c_100000', '', 0, 1],
  ['c200000', '200.000 Coins', 33500, 2908, 'c_200000', '', 0, 1],
  ['wildfire', 'Coleção Wildfire', 6000, 544, 'wf_0', 'wildfire', 0, 1],
  ['arsenal', 'Arsenal Pass', 1899, 136, 'ap_1', 'arsenal', 0, 1],
  ['gold', 'Gold Pass', 3499, 271, 'gp_1', 'gold', 0, 1],
  ['bp1', '1 Pass Level', 449, 35, 'bp_1', '', 1, 1],
  ['bp5', '5 Pass Levels', 1599, 135, 'bp_5', '', 5, 1],
  ['bp10', '10 Pass Levels', 2699, 226, 'bp_10', '', 10, 0],
  ['bp25', '25 Pass Levels', 5899, 499, 'bp_25', '', 25, 0],
];

const db = new Database(env.DB_PATH || 'loja.db');
db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  product TEXT NOT NULL,
  cents INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  email TEXT NOT NULL,
  mp_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  delivered_at TEXT
)`);
// snapshot do produto no momento da compra (sobrevive a edição/exclusão do produto)
for (const col of ['prod_nome TEXT', 'prod_stars INTEGER', 'prod_code TEXT', 'qr TEXT', 'qr_b64 TEXT', 'expires_at INTEGER']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* já existe */ }
}

db.exec(`CREATE TABLE IF NOT EXISTS products (
  key TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  cents INTEGER NOT NULL,
  stars INTEGER NOT NULL DEFAULT 0,
  code TEXT NOT NULL,
  tipo TEXT DEFAULT '',
  niveis INTEGER DEFAULT 0,
  img TEXT DEFAULT '',
  ativo INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
)`);
if (db.prepare('SELECT COUNT(*) n FROM products').get().n === 0) {
  const ins = db.prepare('INSERT INTO products (key,nome,cents,stars,code,tipo,niveis,ativo,sort) VALUES (?,?,?,?,?,?,?,?,?)');
  SEED_PRODUCTS.forEach((p, i) => ins.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], i));
}

let PRODUCTS = {};
function loadProducts() {
  PRODUCTS = {};
  for (const r of db.prepare('SELECT * FROM products ORDER BY sort, rowid').all()) {
    PRODUCTS[r.key] = {
      nome: r.nome, cents: r.cents, stars: r.stars, code: r.code,
      tipo: r.tipo || '', niveis: r.niveis || 0,
      img: r.img || `/img/${r.key}.jpg`, ativo: !!r.ativo, sort: r.sort,
    };
  }
}
loadProducts();

// ---------- Cupons (desconto ao cliente + comissão sobre o lucro) ----------
for (const col of ['coupon TEXT', 'list_cents INTEGER', 'discount_cents INTEGER DEFAULT 0', 'com_pct REAL']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* já existe */ }
}
db.exec(`CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  desconto_pct REAL NOT NULL DEFAULT 0,
  comissao_pct REAL NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1,
  nota TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
// % de comissão fica gravado no pedido: editar o cupom depois não muda o que já foi ganho.
db.exec(`UPDATE orders SET com_pct = (SELECT comissao_pct FROM coupons WHERE code = orders.coupon)
  WHERE coupon IS NOT NULL AND com_pct IS NULL`);
// Pagamentos de comissão feitos ao dono do cupom (saldo = comissão ganha − pagos).
db.exec(`CREATE TABLE IF NOT EXISTS coupon_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  cents INTEGER NOT NULL,
  nota TEXT DEFAULT '',
  paid_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
// Custos para o piso de preço e o cálculo do lucro (configuráveis no .env).
// Custo por Star: calculado das COMPRAS de Stars registradas (ver refreshStarCost); STAR_COST_BRL é só o valor
// inicial, usado enquanto não houver compra registrada. Cada pedido congela o custo da hora da venda (orders.star_cost).
const STAR_COST = Number(env.STAR_COST_BRL || 0.0875); // R$ por Star (padrão)
let STAR_NOW = STAR_COST;
const MP_FEE = Number(env.MP_FEE_PCT || 0.99) / 100;   // taxa do Pix no MP
const costCents = (stars, cost = STAR_NOW) => stars * cost * 100;
// menor preço que ainda cobre Stars + taxa do MP: final*(1-fee) >= custo
const floorCents = (stars) => Math.ceil(costCents(stars) / (1 - MP_FEE));
const profitCents = (cents, stars, cost = STAR_NOW) => cents - costCents(stars, cost) - cents * MP_FEE;
const orderProfit = (o) => profitCents(o.cents, o.prod_stars || 0, o.star_cost ?? STAR_COST);
const normCode = (c) => String(c ?? '').trim().toUpperCase();
// Códigos que o link curto nunca alcançaria: páginas, arquivos e rotas do site são resolvidos antes de /:code.
const RESERVED_CODES = new Set(['API', 'WEBHOOK', 'PAINEL', 'LOGIN', 'LOGOUT', 'PARCEIRO', 'ADMIN', 'IMG',
  ...fs.readdirSync('public').map((f) => f.replace(/\..*$/, '').toUpperCase())]);
const validCode = (c) => /^[A-Z0-9_-]{3,20}$/.test(c);
function getCoupon(code) {
  const c = normCode(code);
  if (!validCode(c)) return null;
  const row = db.prepare('SELECT * FROM coupons WHERE code=? AND ativo=1').get(c);
  return row || null;
}
// preço final com cupom; nunca abaixo do piso (e nunca acima do preço cheio)
function priceWith(p, coupon) {
  if (!coupon || !(coupon.desconto_pct > 0)) return p.cents;
  const disc = Math.round(p.cents * (1 - coupon.desconto_pct / 100));
  return Math.min(p.cents, Math.max(disc, floorCents(p.stars)));
}

try { db.exec('ALTER TABLE coupon_payouts ADD COLUMN ref_mes TEXT'); } catch { /* já existe */ } // mês que o pagamento cobre (AAAA-MM)
// Registro de alterações de cupons, faixas e pagamentos (code '*' = faixas padrão). Nunca guarda Pix nem e-mail.
db.exec('CREATE TABLE IF NOT EXISTS coupon_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT CURRENT_TIMESTAMP, code TEXT NOT NULL, acao TEXT NOT NULL)');
const logCup = (code, acao) => {
  if (!acao) return;
  try { db.prepare('INSERT INTO coupon_log (code, acao) VALUES (?,?)').run(code, String(acao).slice(0, 400)); } catch (e) { console.error('coupon_log', e.message); }
};
const tiersTxtS = (t) => t.map((x, i) => `${String(x.pct).replace('.', ',')}%${i ? ' a partir de ' + brlTxt(x.min) : ''}`).join(' · ');
// o que mudou num cupom (texto curto para o registro; Pix e e-mail só como "alterado")
function diffCup(a, c) {
  const pc = (n) => String(n).replace('.', ',') + '%';
  const tt = (t) => { try { return t ? 'próprias (' + tiersTxtS(JSON.parse(t)) + ')' : 'padrão'; } catch { return 'próprias'; } };
  const s = (v) => v || '—', m = [];
  if (a.desconto_pct !== c.desconto_pct) m.push(`desconto ${pc(a.desconto_pct)} → ${pc(c.desconto_pct)}`);
  if (a.comissao_pct !== c.comissao_pct && (a.plano === 'fixo' || c.plano === 'fixo')) m.push(`comissão fixa ${pc(a.comissao_pct)} → ${pc(c.comissao_pct)}`);
  if (!!a.ativo !== !!c.ativo) m.push(c.ativo ? 'ativado' : 'desativado');
  if ((a.plano || 'metas') !== c.plano) m.push(`plano ${a.plano || 'metas'} → ${c.plano}`);
  if ((a.tiers || null) !== (c.tiers || null)) m.push(`faixas ${tt(a.tiers)} → ${tt(c.tiers)}`);
  if ((a.ids_proprios || '') !== (c.ids_proprios || '')) m.push('IDs do parceiro alterados');
  if ((a.nota || '') !== (c.nota || '')) m.push('nota alterada');
  if ((a.parceiro_nome || '') !== c.parceiro_nome) m.push(`nome do parceiro: ${s(a.parceiro_nome)} → ${s(c.parceiro_nome)}`);
  if ((a.parceiro_canal || '') !== c.parceiro_canal) m.push(`canal: ${s(a.parceiro_canal)} → ${s(c.parceiro_canal)}`);
  if ((a.parceiro_pix || '') !== c.parceiro_pix) m.push(c.parceiro_pix ? (a.parceiro_pix ? 'chave Pix alterada' : 'chave Pix cadastrada') : 'chave Pix removida');
  if ((a.parceiro_email || '') !== c.parceiro_email) m.push(c.parceiro_email ? (a.parceiro_email ? 'e-mail do parceiro alterado' : 'e-mail do parceiro cadastrado') : 'e-mail do parceiro removido');
  return m.join('; ');
}
const findOrder = db.prepare('SELECT * FROM orders WHERE token = ?');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const SITE_URL = 'https://recargaflame.com.br';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const validId = (id) => /^\d{1,12}$/.test(id);
const limit = (max) => rateLimit({ windowMs: 60_000, limit: max, standardHeaders: true, legacyHeaders: false });
const mpHeaders = { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` };

async function getPlayer(id) {
  const r = await fetch(`${CF_BASE}/api/users/${id}`, { signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`CounterFlame respondeu ${r.status}`);
  const j = await r.json();
  return j.success && j.data?.nickname ? j.data : null;
}

function categoria(p) {
  if (p.tipo === 'wildfire') return 'Coleções';
  if (p.tipo === 'arsenal' || p.tipo === 'gold') return 'Passes';
  if (p.niveis) return 'Níveis de Passe';
  return 'Coins';
}

function blockReason(p, d) {
  const bp = d.battlePass;
  const ap = d.arsenalPass;
  if (p.niveis && bp && bp.level + p.niveis > bp.totalLevels) return 'Essa conta não tem níveis suficientes disponíveis.';
  if (p.tipo === 'gold' && bp?.gold) return 'Essa conta já tem o Gold Pass.';
  if (p.tipo === 'arsenal' && ap && ap.tickets >= ap.maxTickets) return 'Essa conta atingiu o limite do Arsenal Pass.';
  if (p.tipo === 'wildfire' && d.wildfireLevel > 0) return 'Essa conta já tem progresso na Wildfire. Fale com o suporte.';
  return null;
}

// ---------- Antifraude (Pix/MED) ----------
// Valores em R$ no .env; padrões pensados para o catálogo atual (maior item R$339,90).
const brlEnv = (v, d) => Math.round(Number(v ?? d) * 100);
// Limites em 24h (por ID ou e-mail) acompanham o PRODUTO MAIS CARO ativo:
//   revisar quando o total pago chega a 3× ele (a 3ª compra dele); recusar no checkout acima de 4× (a 5ª é recusada).
// RISK_DAY_BRL / LIMIT_DAY_BRL no .env fixam valores e desligam o cálculo automático.
const maxPriceCents = () => Math.max(0, ...Object.values(PRODUCTS).filter((p) => p.ativo).map((p) => p.cents || 0));
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
db.exec(`CREATE TABLE IF NOT EXISTS blocked (
  kind TEXT NOT NULL, value TEXT NOT NULL, reason TEXT DEFAULT '', order_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (kind, value)
)`);
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
for (const col of ['device TEXT', 'ip_h TEXT', 'payer_doc TEXT', 'payer_acct TEXT', 'tg_msg INTEGER', 'chk TEXT', 'autopay TEXT', 'autopay_info TEXT', 'autopay_at INTEGER', 'star_cost REAL', 'approved_at INTEGER', 'entrega_via TEXT', 'manual_motivo TEXT', 'refund_state TEXT', 'refund_info TEXT', 'refund_at INTEGER']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* já existe */ }
}
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
  if (o.cents >= RISK.review) why.push(`valor alto (${brlTxt(o.cents)})`);
  const prev = db.prepare("SELECT COUNT(*) n FROM orders WHERE game_id=? AND id<? AND status='delivered'").get(o.game_id, o.id).n;
  if (!prev && (o.list_cents || o.cents) >= RISK.first) why.push('primeira compra deste ID');
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
    body: '{}', // devolução integral
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
  tgApi('sendMessage', { chat_id: env.TG_CHAT_ID, disable_web_page_preview: true, reply_markup: refundKb(o),
    text: `🚫 Pedido #${o.id} BLOQUEADO automaticamente: ${motivo}.\n${o.prod_nome || o.product} · ${v} · ${o.nickname} · ID ${o.game_id}\n`
    + `NÃO foi entregue. O cliente PAGOU: devolva ${v} (botão abaixo ou app do Mercado Pago — Termos: não entregue = reembolso integral).\n`
    + 'ID e e-mail deste pedido também foram bloqueados. Se for engano, desbloqueie no card do pedido (aba Cancelados).' })
    .then((j) => { const mid = j?.result?.message_id; if (mid) db.prepare('UPDATE orders SET tg_msg=? WHERE id=?').run(mid, o.id); });
}

async function syncPayment(mpId) {
  const r = await fetch(`${MP_URL}/${encodeURIComponent(mpId)}`, { headers: mpHeaders, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return;
  const pay = await r.json();
  const o = findOrder.get(pay.external_reference);
  if (!o) return;

  if (pay.status === 'approved' && Math.round(pay.transaction_amount * 100) === o.cents) {
    const pp = payerPrints(pay);
    const r = db.prepare("UPDATE orders SET status='paid', paid_at=CURRENT_TIMESTAMP, payer_acct=? WHERE id=? AND status='pending'")
      .run(pp.acct, o.id);
    // só avisa na transição pending→paid (webhook + polling podem chegar juntos: changes evita aviso duplo)
    if (r.changes) {
      orderEv(o, 'paid');
      const oo = { ...o, payer_acct: pp.acct };
      const sinal = estornoSinal(oo);
      if (sinal) bloquearPedido(oo, sinal); else { notifyPaid(oo); avisoFaixa(oo); }
    }
  } else if (['cancelled', 'rejected', 'refunded', 'charged_back'].includes(pay.status)) {
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
      tgApi('sendMessage', { chat_id: env.TG_CHAT_ID, disable_web_page_preview: true,
        ...(o.tg_msg ? { reply_parameters: { message_id: o.tg_msg, allow_sending_without_reply: true } } : {}),
        text: before === 'delivered'
          ? `⚠️ Estorno no pedido #${o.id} (${brlTxt(o.cents)}, já entregue · ${pay.status}) — detalhes no aviso original.`
          : `⛔ Pedido #${o.id} cancelado após pagamento (${brlTxt(o.cents)} · ${pay.status}) — não entregar; detalhes no aviso original.` });
    }
  }
}

const brlTxt = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
// ---------- Entrega assistida pelo Telegram ----------
// Aviso de pago vem com botões: abrir o bot do CounterFlame já com produto+ID, e "Já entreguei"
// (pede confirmação). Só o operador (TG_CHAT_ID) pode usar os botões. Lê os toques por long polling
// (getUpdates) — sem webhook, sem endpoint público novo.
const donateLink = (o) => {
  const code = o.prod_code || PRODUCTS[o.product]?.code;
  return code ? `https://t.me/CounterFlameDonate_bot?start=s_${code}_${o.game_id}` : '';
};
const starsOf = (o) => o.prod_stars || PRODUCTS[o.product]?.stars || 0;
// ---------- Saldo de Stars (livro-caixa manual) ----------
// O saldo real da conta do operador não é legível por API (Bot API só vê o saldo do bot; ler a conta
// exigiria sessão do Telegram no servidor — recusado no contexto.md). Então: entrega desconta sozinha,
// "confere o saldo" (ou a leitura real da conta faz isso sozinha). Compras de Stars NÃO entram aqui: ficam em
// stars_purchases, só para o custo — nunca alteram o saldo.
db.exec(`CREATE TABLE IF NOT EXISTS stars_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- ajuste | entrega  (legado: recarga, migrada p/ stars_purchases)
  delta INTEGER NOT NULL,        -- + entra, − sai
  cents INTEGER,                 -- legado
  order_id INTEGER UNIQUE,       -- entrega: 1 desconto por pedido
  nota TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
const STARS_LOW = Number(env.STARS_LOW ?? 500); // abaixo disso: aviso de saldo baixo
// Compras de Stars (Fragment/USDT etc.): SÓ registro de custo. Nunca mexem no saldo (que vem do Telegram).
db.exec(`CREATE TABLE IF NOT EXISTS stars_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, stars INTEGER NOT NULL, cents INTEGER NOT NULL, nota TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
// migração: "recargas" antigas do livro-caixa viram compras e saem do saldo (o alinhamento com o Telegram corrige)
db.transaction(() => {
  for (const r of db.prepare("SELECT * FROM stars_ledger WHERE kind='recarga'").all()) {
    if (r.cents > 0 && r.delta > 0) db.prepare('INSERT INTO stars_purchases (stars, cents, nota, created_at) VALUES (?,?,?,?)').run(r.delta, r.cents, r.nota || '', r.created_at);
    db.prepare('DELETE FROM stars_ledger WHERE id=?').run(r.id);
  }
})();
// pedidos antigos (antes do custo automático) ficam com o custo padrão da época
db.prepare('UPDATE orders SET star_cost=? WHERE star_cost IS NULL').run(STAR_COST);
// Custo atual = custo exato das Stars que estão na conta agora: média ponderada das compras mais recentes,
// contando só a parte de cada uma que ainda compõe o saldo. Sem compra registrada: STAR_COST_BRL.
function calcStarCost(saldo) {
  // ordem pela DATA da compra (o "estoque inicial" pode ser lançado depois, com data antiga)
  const recs = db.prepare('SELECT stars, cents FROM stars_purchases WHERE cents > 0 AND stars > 0 ORDER BY created_at DESC, id DESC').all();
  if (!recs.length) return { cost: STAR_COST, fonte: 'padrao', recargas: 0 };
  // exato: da mais nova para a mais antiga, conta só a PARTE de cada compra que ainda está no saldo
  // (ex.: saldo 3.000 = 2.500 da última + 500 da anterior). Saldo maior que tudo registrado: usa todas as compras.
  let falta = Math.max(saldo, 1), st = 0, c = 0, n = 0;
  for (const r of recs) {
    const usa = Math.min(falta, r.stars);
    st += usa; c += usa * (r.cents / r.stars); n++; falta -= usa;
    if (falta <= 0) break;
  }
  return { cost: c / st / 100, fonte: 'recargas', recargas: n };
}
let STAR_INFO = { cost: STAR_COST, fonte: 'padrao', recargas: 0 };
// recalcula; se mudou (≥ 0,1%) e notify, avisa no Telegram e aponta produtos vendidos no prejuízo
function refreshStarCost(notify = false) {
  const old = STAR_NOW;
  STAR_INFO = calcStarCost(Math.max(0, starsEff().s));
  STAR_NOW = STAR_INFO.cost;
  if (notify && Math.abs(STAR_NOW - old) / old >= 0.001) {
    const fmt = (v) => 'R$ ' + v.toFixed(4).replace('.', ',');
    const prej = Object.entries(PRODUCTS).filter(([, p]) => p.ativo && p.stars && p.cents * (1 - MP_FEE) < costCents(p.stars))
      .map(([, p]) => `${p.nome} (${brlTxt(p.cents)}, custo ${brlTxt(Math.round(costCents(p.stars)))})`);
    tgSend(`💱 Custo da Star atualizado: ${fmt(old)} → ${fmt(STAR_NOW)} (média das compras de Stars que formam o saldo atual).\n`
      + 'Vale para os novos pedidos; vendas anteriores mantêm o custo da época.'
      + (prej.length ? `\n⚠️ Vendendo NO PREJUÍZO com o custo novo: ${prej.join('; ')}. Ajuste os preços no painel.` : ''));
  }
  return STAR_NOW;
}
// n = nº de conferências: o saldo só é "configurado" depois que o operador informa o saldo real 1 vez
const starsSaldo = () => db.prepare("SELECT COALESCE(SUM(delta),0) s, SUM(kind='ajuste') n FROM stars_ledger").get();
// Stars que a fila de pagos (ainda não entregues) vai consumir
const starsFila = () => db.prepare("SELECT * FROM orders WHERE status='paid'").all().reduce((a, o) => a + starsOf(o), 0);
// ---- saldo REAL lido da conta de usuário separada (só leitura) ----
// Vale enquanto a leitura tiver < 15 min; senão, volta para o livro-caixa manual.
const REAL = { balance: null, at: 0, err: null };
let starsReader = readStarsBalance;           // trocável nos testes
const realOn = () => starsReader !== readStarsBalance || userConfig(env).ok;
const realFresh = () => REAL.at && Date.now() - REAL.at < 15 * 60_000 && REAL.err == null;
// saldo efetivo: real (se fresco) ou livro-caixa
function starsEff() {
  if (realFresh()) return { s: REAL.balance, n: 1, real: true };
  return { ...starsSaldo(), real: false };
}
let lastSync = 0, syncing = null;
async function syncStarsReal(force = false) {
  if (!realOn()) return;
  if (syncing) return syncing;
  if (!force && Date.now() - lastSync < 20_000) return;
  lastSync = Date.now();
  syncing = (async () => {
    const prev = REAL.err == null ? REAL.balance : null;
    try {
      const b = await starsReader(env);
      const hadErr = REAL.err;
      Object.assign(REAL, { balance: b, at: Date.now(), err: null });
      alignLedger(b);
      refreshStarCost(false); // o saldo muda quais compras formam o estoque; sem aviso (só registrar compra avisa)
      if (hadErr) tgSend(`✅ Leitura do saldo de Stars voltou a funcionar: ${b}★.`);
      if (prev != null && prev >= STARS_LOW && b < STARS_LOW) tgSend(`🔻 Saldo de Stars baixo: ${b}★ (limite ${STARS_LOW}★). Fila: ${starsFila()}★.`);
    } catch (e) {
      const msg = String(e?.errorMessage || e?.message || e).slice(0, 120);
      if (REAL.err !== msg) {
        tgSend(sessionDown(msg)
          ? `🔌 A sessão da conta separada do Telegram CAIU (${msg}).\nEntrega automática pausada: os pedidos vão para entrega manual.\nRefaça o login no SSH: cd ~/cf-teste-deploy && node tg-user-login.mjs && pm2 restart cf-teste`
          : `⚠️ Não consegui ler o saldo de Stars da conta separada: ${msg}\nO painel volta a usar o saldo manual.`);
      }
      REAL.err = msg;
      console.error('saldo Stars (conta usuário):', msg);
    } finally { syncing = null; }
  })();
  return syncing;
}
// Realinha o livro-caixa ao saldo real a cada leitura: o livro é o plano B se a leitura falhar.
// Ajustes automáticos seguidos viram um só (evita poluir o histórico).
const AUTO_NOTA = 'sincronizado com o Telegram';
function alignLedger(real) {
  const diff = real - starsSaldo().s;
  if (!diff) return;
  const last = db.prepare('SELECT * FROM stars_ledger ORDER BY id DESC LIMIT 1').get();
  if (last && last.kind === 'ajuste' && last.nota === AUTO_NOTA) {
    db.prepare('UPDATE stars_ledger SET delta=?, created_at=CURRENT_TIMESTAMP WHERE id=?').run(last.delta + diff, last.id);
    return;
  }
  db.prepare("INSERT INTO stars_ledger (kind, delta, nota) VALUES ('ajuste', ?, ?)").run(diff, AUTO_NOTA);
}
// sessão revogada/expirada/conta banida: não adianta tentar até refazer o login
const sessionDown = (msg) => /AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|sessão expirada|revogada/i.test(String(msg || ''));
const _setStarsReader = (fn) => { starsReader = fn || readStarsBalance; Object.assign(REAL, { balance: null, at: 0, err: null }); lastSync = 0; };

// alerta (texto) se a fila não cabe no saldo; null se ok ou se o saldo nunca foi configurado
function starsShortMsg() {
  const { s: saldo, n } = starsEff();
  if (!n) return null;
  const fila = starsFila();
  return fila > saldo ? `⚠️ Stars insuficientes: saldo ${saldo}★, fila precisa ${fila}★ — recarregue ${fila - saldo}★` : null;
}

// paid → delivered (painel ou Telegram): e-mail ao cliente + atualiza o aviso. true se mudou.
// via: 'auto' (sem toque) | 'toque' (1 toque) | 'aprovado' (aprovar e pagar) | 'painel'/'telegram' (manual)
function markDelivered(id, via, extras = []) {
  const tipo = ['auto', 'toque', 'aprovado'].includes(via) ? via : 'manual';
  const r = db.prepare("UPDATE orders SET status='delivered', delivered_at=CURRENT_TIMESTAMP, entrega_via=? WHERE id=? AND status='paid'").run(tipo, id);
  if (!r.changes) return false;
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  orderEv(o, 'delivered');
  const m = deliveredEmail(o);
  sendMail(o.email, m.subject, m.html, m.text); // em segundo plano
  // desconta os Stars da entrega e avisa ao cruzar o limite de saldo baixo
  const antes = starsSaldo();
  const st = starsOf(o);
  if (st > 0) {
    db.prepare("INSERT OR IGNORE INTO stars_ledger (kind, delta, order_id) VALUES ('entrega', ?, ?)").run(-st, o.id);
    const depois = antes.s - st;
    if (realOn()) { const t = setTimeout(() => syncStarsReal(true), env.NODE_ENV === 'test' ? 0 : 5000); t.unref?.(); }
    else if (antes.n && antes.s >= STARS_LOW && depois < STARS_LOW) tgSend(`🔻 Saldo de Stars baixo: ${depois}★ (limite ${STARS_LOW}★). Fila: ${starsFila()}★.`);
  }
  // edita o aviso "💰 Pedido pago" (sem mensagem nova)
  const st_ = starsOf(o);
  tgEntregue(id, { auto: 'entregue automaticamente', toque: `pago no bot (${st_}★) e entregue`,
    aprovado: `aprovado por você, pago no bot (${st_}★) e entregue`, painel: 'entregue manualmente (painel)' }[via] || 'entregue manualmente', extras,
    tipo !== 'manual'); // entrega manual sem aviso salvo: não manda mensagem nova (como antes)
  return true;
}


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
db.exec('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)');
// tetos do pagamento automático: editáveis no painel (settings); o .env é só o padrão inicial
const AUTOPAY_MAX_DEF = Number(env.AUTOPAY_MAX_STARS ?? 1000);   // ★ por pedido
const AUTOPAY_DAY_DEF = Number(env.AUTOPAY_DAY_STARS ?? 4000);   // ★ em 24h
const getSetting = (k, d) => db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v ?? d;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
const autopayMax = () => Number(getSetting('autopay_max', AUTOPAY_MAX_DEF));
const autopayDay = () => Number(getSetting('autopay_day', AUTOPAY_DAY_DEF));
let invoicePayer = payInvoice;               // trocável nos testes
let receiptChecker = invoicePaid;            // trocável nos testes
const _setReceiptChecker = (fn) => { receiptChecker = fn || invoicePaid; };
const _setInvoicePayer = (fn) => { invoicePayer = fn || payInvoice; };
// modo do pagamento: '0' desligado · '1' um toque · '2' automático (paga sozinho quando a conferência dá ✅)
const autopayMode = () => (chkOn() ? getSetting('autopay', '0') : '0');
const autopayOn = () => autopayMode() !== '0';
const autoMode = () => autopayMode() === '2';
const autopay24 = () => db.prepare("SELECT * FROM orders WHERE autopay='sent' AND autopay_at > ?").all(Date.now() - 86_400_000)
  .reduce((a, o) => a + starsOf(o), 0);
// pode pagar com 1 toque? { ok, why }
function canAutopay(o) {
  if (stopping) return { ok: false, why: 'loja reiniciando — tente de novo em 1 min' };
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
// ---- Avisos de pedido no Telegram (mensagem, botões, edições, toques): src/telegram.js ----
const { refundKb, tgDesbloqueado, paidKeyboard, tgMarkup, handleTgUpdate, tgPoll, paidText, tgEntregue, tgAviso, notifyPaid, tgIncerto, tgFalha } = initAvisos({ db, riskOf, podeReembolsar, reembolsar, bloqAuto, brlTxt, donateLink, starsOf, starsShortMsg, markDelivered, canAutopay, canApprove, autopay, chkOf, chkLine, conferir, saldoLine });
// por que este pedido não foi entregue sozinho (guarda o 1º motivo; vira categoria no Analytics)
const setMotivo = (id, m) => db.prepare('UPDATE orders SET manual_motivo=? WHERE id=? AND manual_motivo IS NULL').run(String(m).slice(0, 160), id);
function motivoCat(m) {
  const s = String(m || '');
  if (!s) return 'sem registro';
  if (/primeira compra/.test(s)) return 'Revisão: primeira compra';
  if (/valor alto/.test(s)) return 'Revisão: valor alto';
  if (/pagos em 24h/.test(s)) return 'Revisão: muito em 24h';
  if (/estorno|conta bancária|aparelho|mesmo IP/.test(s)) return 'Revisão: ligado a estorno';
  if (/REVISAR|conferência no bot/.test(s)) return 'Revisão: outro';
  if (/conferência/.test(s)) return 'Conferência falhou';
  if (/teto por pedido/.test(s)) return 'Acima do teto por pedido';
  if (/24h atingido/.test(s)) return 'Teto de 24h atingido';
  if (/saldo/.test(s)) return 'Sem saldo de Stars';
  if (/sessão/.test(s)) return 'Sessão da conta caiu';
  if (/desligad|modo/.test(s)) return 'Modo automático desligado';
  if (/pagamento falhou/.test(s)) return 'Pagamento falhou';
  return 'Outro';
}
// O que o CLIENTE vê enquanto o pedido está pago (só no modo automático): 'auto' | 'manual' | null.
// Nunca expõe o motivo (fraude, saldo, etc.).
function entregaState(o) {
  if (o.status !== 'paid' || !autoMode()) return null;
  if (o.autopay === 'paying' || o.autopay === 'sent') return 'auto';
  if (o.autopay === 'erro' || o.autopay === 'incerto') return 'manual';
  const ck = chkOf(o);
  if (!ck) {
    const paidMs = o.paid_at ? Date.parse(o.paid_at.replace(' ', 'T') + 'Z') : 0;
    return Date.now() - paidMs < 3 * 60_000 ? 'auto' : 'manual'; // conferência travada há >3 min
  }
  if (ck.status === 'erro' && !ck.final) return 'auto'; // ainda vai tentar de novo
  if (o.autopay === 'erro' && JSON.parse(o.autopay_info || '{}').retry) return 'auto'; // nova tentativa agendada
  if (ck.status !== 'ok') return 'manual';
  return canAutopay(o).ok ? 'auto' : 'manual';
}

// Expiração automática: pendente com Pix vencido (+5 min de folga) é conferido no MP
// uma última vez (pega pagamento atrasado) e, se seguir pendente, vira cancelled.
// Pedidos antigos sem expires_at usam created_at + 35 min.
// ---------- Lembretes de Pix (e-mail transacional sobre o próprio pedido) ----------
// 1) faltando ≤ 10 min para vencer: "seu Pix vence em X min" (1x)  2) venceu sem pagar: "gere um novo Pix" (1x).
// Nunca se o cliente já fez um pedido mais novo (mesmo ID ou e-mail) — ele já voltou por conta própria.
for (const col of ['remind_at INTEGER', 'expired_mail INTEGER']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* já existe */ }
}
const hasNewer = (o) => !!db.prepare('SELECT 1 FROM orders WHERE id > ? AND (game_id=? OR lower(email)=?)').get(o.id, o.game_id, lc(o.email));
function pixMail(o, kind, mins) {
  const nome = o.prod_nome || PRODUCTS[o.product]?.nome || o.product;
  const valor = brlTxt(o.cents);
  const link = `${env.PUBLIC_URL}/#pedido=${o.token}`;
  const vence = kind === 'lembrete';
  const subject = vence ? `Seu Pix vence em ${mins} min — pedido #${o.id}` : `Seu Pix expirou — pedido #${o.id}`;
  const title = vence ? `Seu Pix vence em ${mins} minutos ⏳` : 'Seu Pix expirou';
  const p1 = vence
    ? `Seu pedido de <b style="color:#f4f4f5">${esc(nome)}</b> (${valor}) para <b style="color:#f4f4f5">${esc(o.nickname)}</b> ainda está aguardando o pagamento. Pague antes de vencer para receber em até 10 minutos.`
    : `O Pix do pedido de <b style="color:#f4f4f5">${esc(nome)}</b> (${valor}) para <b style="color:#f4f4f5">${esc(o.nickname)}</b> venceu sem pagamento — nada foi cobrado. Se ainda quiser, gere um novo Pix em um toque.`;
  const btn = vence ? 'Abrir o Pix' : 'Gerar novo Pix';
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0e0e10;padding:24px 12px;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#161618;border:1px solid #2a2a2e;border-radius:14px">
<tr><td style="padding:22px 22px 6px"><img src="${env.PUBLIC_URL}/img/brand-mark.png" width="36" height="36" alt="" style="border-radius:8px;vertical-align:middle">
<span style="font-size:17px;font-weight:700;vertical-align:middle;margin-left:8px">Recarga <span style="color:#ff5a1f">Flame</span></span></td></tr>
<tr><td style="padding:14px 22px 4px"><h1 style="margin:0 0 8px;font-size:20px">${title}</h1>
<p style="margin:0;color:#9b9ba3;font-size:14px;line-height:1.55">${p1}</p></td></tr>
<tr><td style="padding:18px 22px 20px"><a href="${link}" style="display:block;text-align:center;background:#ff5a1f;color:#160a04;font-weight:700;text-decoration:none;padding:13px;border-radius:9px">${btn}</a></td></tr>
<tr><td style="padding:0 22px 22px;color:#6c6c74;font-size:12.5px;line-height:1.5">${vence ? 'Se você já pagou, pode ignorar este e-mail — a confirmação é automática.<br><br>' : ''}Pedido #${o.id} · conta ID ${esc(o.game_id)}. Dúvidas? É só responder este e-mail.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`${title}`, '', vence ? `Seu pedido de ${nome} (${valor}) para ${o.nickname} ainda aguarda o pagamento.` : `O Pix do pedido de ${nome} (${valor}) venceu sem pagamento — nada foi cobrado.`,
    `${btn}: ${link}`, vence ? 'Se já pagou, ignore este e-mail.' : '', `Pedido #${o.id} · ID ${o.game_id}`].join('\n');
  return { subject, html, text };
}
async function remindPending() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM orders WHERE status='pending' AND mp_id IS NOT NULL AND remind_at IS NULL
    AND expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ? LIMIT 30`).all(now + 60_000, now + 10 * 60_000);
  let sent = 0;
  for (const o of rows) {
    db.prepare('UPDATE orders SET remind_at=? WHERE id=?').run(now, o.id); // marca antes: nunca repete
    if (hasNewer(o) || !o.email) continue;
    try { await syncPayment(o.mp_id); } catch { continue; }
    if (db.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status !== 'pending') continue;
    const m = pixMail(o, 'lembrete', Math.max(1, Math.round((o.expires_at - now) / 60_000)));
    if (await sendMail(o.email, m.subject, m.html, m.text)) sent++;
  }
  return sent;
}
if (env.NODE_ENV !== 'test') setInterval(() => remindPending().catch((e) => console.error('remindPending', e)), 60_000).unref();

async function expirePending() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM orders WHERE status='pending' AND (
      (expires_at IS NOT NULL AND expires_at < ?) OR
      (expires_at IS NULL AND created_at < datetime('now','-35 minutes'))) LIMIT 50`).all(now - 5 * 60_000);
  for (const o of rows) {
    try { if (o.mp_id) await syncPayment(o.mp_id); } catch (e) { console.error('expirePending sync', o.id, e.message); continue; }
    const r = db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'").run(o.id);
    // venceu sem pagar (não foi o cliente que cancelou): avisa 1x, se ele não voltou por conta própria
    if (r.changes && o.mp_id && o.email && !o.expired_mail && !hasNewer(o)) {
      db.prepare('UPDATE orders SET expired_mail=1 WHERE id=?').run(o.id);
      const m = pixMail(o, 'expirou');
      sendMail(o.email, m.subject, m.html, m.text);
    }
  }
  return rows.length;
}
if (env.NODE_ENV !== 'test') setInterval(() => expirePending().catch((e) => console.error('expirePending', e)), 5 * 60_000).unref();

function validSignature(req, id) {
  const parts = Object.fromEntries((req.get('x-signature') || '').split(',').map((s) => s.trim().split('=')));
  const manifest = `id:${id};request-id:${req.get('x-request-id')};ts:${parts.ts};`;
  const hash = crypto.createHmac('sha256', env.MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return safeEq(hash, parts.v1 || '');
}

// Anti-brute-force no admin: janela deslizante por IP, conta só FALHAS.
// Login correto sempre passa (não é bloqueado nem conta), então o operador
// nunca fica trancado fora mesmo que um atacante martele o mesmo IP.
const ADMIN_MAX_FAILS = 20;
const ADMIN_WINDOW = 15 * 60_000;
const adminFails = new Map(); // ip -> [timestamps de falha]
function tooManyFails(ip) {
  const now = Date.now();
  const arr = (adminFails.get(ip) || []).filter((t) => now - t < ADMIN_WINDOW);
  adminFails.set(ip, arr);
  return arr.length >= ADMIN_MAX_FAILS;
}
function noteFail(ip) {
  const arr = adminFails.get(ip) || [];
  arr.push(Date.now());
  adminFails.set(ip, arr);
}
// limpeza periódica pra não vazar memória
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of adminFails) {
    const keep = arr.filter((t) => now - t < ADMIN_WINDOW);
    if (keep.length) adminFails.set(ip, keep); else adminFails.delete(ip);
  }
}, ADMIN_WINDOW).unref();


// ---------- E-mail ao cliente (Resend, API HTTP — sem dependência nova) ----------
// Desligado enquanto RESEND_API_KEY não estiver no .env. Falha de envio nunca quebra o fluxo.
// Remetente: MAIL_FROM (padrão pedidos@recargaflame.com.br); respostas vão para MAIL_REPLY_TO (suporte@…).
const MAIL_FROM = env.MAIL_FROM || 'pedidos@recargaflame.com.br';
const MAIL_REPLY_TO = env.MAIL_REPLY_TO || 'suporte@recargaflame.com.br';
async function sendMail(to, subject, html, text, replyTo = MAIL_REPLY_TO, fromAddr = MAIL_FROM) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Recarga Flame <${fromAddr}>`, reply_to: replyTo,
        to: [to], subject, html, text,
      }),
    });
    if (!r.ok) console.error('Resend respondeu', r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.error('Falha ao enviar e-mail:', e.message); return false; }
}

function deliveredEmail(o) {
  const nome = o.prod_nome || PRODUCTS[o.product]?.nome || o.product;
  const valor = (o.cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const site = env.PUBLIC_URL;
  const link = `${site}/#pedido=${o.token}`;
  const subject = `Pedido #${o.id} entregue — ${nome}`;
  const text = [
    `Olá, ${o.nickname}!`, '',
    `Seu pedido #${o.id} (${nome}, ${valor}) foi entregue na conta ID ${o.game_id}.`,
    'Abra o CounterFlame para conferir.', '',
    `Acompanhar o pedido: ${link}`,
    'Algum problema? É só responder este e-mail (suporte@recargaflame.com.br).', '',
    'Recarga Flame — revenda independente, sem vínculo com a Valve nem com a equipe oficial do CounterFlame.',
  ].join('\n');
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0e0e10;padding:24px 12px;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#161618;border:1px solid #2a2a2e;border-radius:14px">
<tr><td style="padding:22px 22px 6px"><img src="${site}/img/brand-mark.png" width="36" height="36" alt="" style="border-radius:8px;vertical-align:middle">
<span style="font-size:17px;font-weight:700;vertical-align:middle;margin-left:8px">Recarga <span style="color:#ff5a1f">Flame</span></span></td></tr>
<tr><td style="padding:14px 22px 4px"><h1 style="margin:0 0 8px;font-size:20px">Pedido entregue ✅</h1>
<p style="margin:0;color:#9b9ba3;font-size:14px;line-height:1.55">Olá, <b style="color:#f4f4f5">${esc(o.nickname)}</b>! Seu pedido já está na sua conta. Abra o CounterFlame para conferir.</p></td></tr>
<tr><td style="padding:16px 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0e0e10;border:1px solid #2a2a2e;border-radius:10px;font-size:14px">
<tr><td style="padding:12px 14px;color:#9b9ba3">Pedido</td><td align="right" style="padding:12px 14px;font-weight:700">#${o.id}</td></tr>
<tr><td style="padding:12px 14px;color:#9b9ba3;border-top:1px solid #2a2a2e">Produto</td><td align="right" style="padding:12px 14px;font-weight:700;border-top:1px solid #2a2a2e">${esc(nome)}</td></tr>
<tr><td style="padding:12px 14px;color:#9b9ba3;border-top:1px solid #2a2a2e">Conta</td><td align="right" style="padding:12px 14px;border-top:1px solid #2a2a2e">${esc(o.nickname)} · ID ${esc(o.game_id)}</td></tr>
<tr><td style="padding:12px 14px;color:#9b9ba3;border-top:1px solid #2a2a2e">Valor</td><td align="right" style="padding:12px 14px;font-weight:700;border-top:1px solid #2a2a2e">${valor}</td></tr>
</table></td></tr>
<tr><td style="padding:0 22px 20px"><a href="${link}" style="display:block;text-align:center;background:#ff5a1f;color:#160a04;font-weight:700;text-decoration:none;padding:13px;border-radius:9px">Ver pedido</a></td></tr>
<tr><td style="padding:0 22px 22px;color:#6c6c74;font-size:12.5px;line-height:1.5">Algum problema? É só responder este e-mail ou escrever para
<a href="mailto:suporte@recargaflame.com.br" style="color:#9b9ba3">suporte@recargaflame.com.br</a>.<br><br>
Recarga Flame é uma revenda independente, sem vínculo com a Valve nem com a equipe oficial do CounterFlame.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text };
}

// ---------- Login do painel: senha + código pelo Telegram + sessão ----------
db.exec(`CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, ua TEXT
)`);
// Sessão deslizante: vale 30 dias sem uso e renova sozinha a cada uso (no máx. 1×/h),
// com teto de 90 dias desde o login — depois disso, senha + código de novo.
const SESSION_TTL = 30 * 86400_000;
const SESSION_MAX = 90 * 86400_000;
const SESSION_RENEW = 3600_000;
const CODE_TTL = 5 * 60_000;       // código vale 5 min
const CODE_MAX_TRIES = 5;          // por desafio
const COOKIE = 'cf_sess';
const hashHex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const challenges = new Map(); // id -> { codeHash, exp, tries, ip }

function getCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function sessionOk(req) {
  const tok = getCookie(req, COOKIE);
  if (!tok || !/^[A-Za-z0-9_-]{43}$/.test(tok)) return false;
  const row = db.prepare('SELECT created_at, expires_at FROM admin_sessions WHERE id_hash=?').get(hashHex(tok));
  if (!row || row.expires_at <= Date.now()) return false;
  return { tok, ...row };
}
// Renova a sessão em uso (prazo e cookie), sem passar do teto desde o login.
function renewSession(s, res) {
  const now = Date.now();
  const exp = Math.min(now + SESSION_TTL, s.created_at + SESSION_MAX);
  if (exp - s.expires_at < SESSION_RENEW) return;
  db.prepare('UPDATE admin_sessions SET expires_at=? WHERE id_hash=?').run(exp, hashHex(s.tok));
  res.append('Set-Cookie', `${COOKIE}=${s.tok}; Max-Age=${Math.floor((exp - now) / 1000)}; ${cookieAttrs()}`);
}
const cookieAttrs = () => `Path=/; HttpOnly; SameSite=Strict${env.NODE_ENV === 'test' ? '' : '; Secure'}`;

setInterval(() => {
  const now = Date.now();
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now);
  for (const [id, c] of challenges) if (c.exp < now) challenges.delete(id);
}, 10 * 60_000).unref();

function admin(req, res, next) {
  const s = sessionOk(req);
  if (s) { renewSession(s, res); return next(); }
  // página do painel: manda pro login; API: 401
  if (req.method === 'GET' && req.path === '/painel') return res.redirect(302, '/login');
  res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
}


const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by'); // não anuncia que é Express

// Headers de segurança (hardening Fase 0)
app.use((req, res, next) => {
  res.set('Strict-Transport-Security', 'max-age=31536000'); // HSTS: navegador só usa HTTPS por 1 ano
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});

const DEV = 'cf_dev';
const devOf = (req) => { const d = getCookie(req, DEV); return d && /^[A-Za-z0-9_-]{22}$/.test(d) ? d : null; };
app.use((req, res, next) => {
  if (req.method === 'GET' && !devOf(req) && !req.path.startsWith('/api/') && !req.path.startsWith('/painel')) {
    const d = crypto.randomBytes(16).toString('base64url');
    res.append('Set-Cookie', `${DEV}=${d}; Max-Age=63072000; Path=/; HttpOnly; SameSite=Lax${env.NODE_ENV === 'test' ? '' : '; Secure'}`);
  }
  next();
});
app.use(express.json({ limit: '10kb' }));
// Prévia do link (WhatsApp/Telegram) personalizada no link de cupom: /?cupom=AQUILA (o /aquila redireciona para cá).
const INDEX_HTML = fs.readFileSync(path.join('public', 'index.html'), 'utf8');
// Home sempre renderizada aqui: vitrine de preços e dados estruturados vêm dos produtos ativos (seo-home.js).
const prodsPublic = () => Object.entries(PRODUCTS).filter(([, p]) => p.ativo)
  .map(([key, p]) => ({ key, nome: p.nome, cents: p.cents, stars: p.stars, cat: categoria(p), img: p.img || `/img/${key}.jpg` }));
app.get(['/', '/index.html'], (req, res) => {
  const home = homeHtml(INDEX_HTML, prodsPublic());
  const c = req.query.cupom ? getCoupon(req.query.cupom) : null;
  if (!c) return res.type('html').set('Cache-Control', 'no-cache').send(home);
  const t = c.desconto_pct > 0 ? `${String(c.desconto_pct).replace('.', ',')}% OFF com o cupom ${c.code} — Recarga Flame` : `Cupom ${c.code} — Recarga Flame`;
  const d = `Coins e passes do CounterFlame no Pix com o cupom ${c.code}. Entrega automática em até 10 minutos, só com o ID da conta.`;
  const html = home
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(t)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(d)}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${SITE_URL}/?cupom=${encodeURIComponent(c.code)}">`);
  res.type('html').set('Cache-Control', 'no-cache').send(html);
});
// páginas de conteúdo (SEO); a de Coins recebe a tabela de preços dos produtos ativos
const PAGES_SEO = Object.fromEntries(['onde-encontrar-id-counterflame', 'comprar-coins-counterflame', 'gold-pass-counterflame', 'item-nao-chegou-counterflame', 'e-seguro-comprar-coins-counterflame']
  .map((s) => [s, fs.existsSync(path.join('public', s + '.html')) ? fs.readFileSync(path.join('public', s + '.html'), 'utf8') : null]));
for (const [s, html] of Object.entries(PAGES_SEO)) if (html) app.get(['/' + s, '/' + s + '.html'], (req, res) => res.type('html').set('Cache-Control', 'no-cache').send(pageHtml(html, prodsPublic())));
app.use(express.static('public'));
// páginas institucionais (também em /como-funciona.html e /perguntas-frequentes.html)
app.get('/como-funciona', (req, res) => res.sendFile('como-funciona.html', { root: 'public' }));
app.get('/perguntas-frequentes', (req, res) => res.sendFile('perguntas-frequentes.html', { root: 'public' }));
app.get('/suporte', (req, res) => res.sendFile('suporte.html', { root: 'public' }));
app.get('/termos-de-uso', (req, res) => res.sendFile('termos-de-uso.html', { root: 'public' }));
app.get('/politica-de-privacidade', (req, res) => res.sendFile('politica-de-privacidade.html', { root: 'public' }));
app.use('/api', limit(120));

app.get('/api/products', (req, res) => res.json(prodsPublic()));

// Valida cupom e devolve o preço final de cada produto ativo (para a loja mostrar o desconto).
app.get('/api/coupon/:code', limit(20), (req, res) => {
  const c = getCoupon(req.params.code);
  if (!c) return res.status(404).json({ error: 'Cupom inválido ou expirado.' });
  const prices = {};
  for (const [key, p] of Object.entries(PRODUCTS)) if (p.ativo) prices[key] = priceWith(p, c);
  res.json({ code: c.code, desconto_pct: c.desconto_pct, prices });
});

app.get('/api/player/:id', limit(15), async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'ID inválido.' });
  const player = await getPlayer(req.params.id);
  if (!player) return res.status(404).json({ error: 'Conta não encontrada.' });
  // bloqueios por produto (Gold já comprado etc.) para o catálogo marcar como indisponível.
  // Só informativo: o POST /api/orders continua validando.
  const blocked = {};
  for (const [key, p] of Object.entries(PRODUCTS)) {
    if (!p.ativo) continue;
    const why = blockReason(p, player);
    if (why) blocked[key] = why;
  }
  res.json({ nickname: player.nickname, avatar: `/api/player/${encodeURIComponent(req.params.id)}/avatar`, blocked });
});

// Avatar do jogador. Conta sem avatar → imagem padrão em cache (o navegador não pede de novo) e o servidor lembra
// por 6 h que aquele ID não tem foto (não consulta o CounterFlame a cada atualização do painel).
const AVATAR_PADRAO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1c1c1f"/>'
  + '<circle cx="32" cy="25" r="11" fill="#45454c"/><path d="M12 56c2-11 10-17 20-17s18 6 20 17" fill="#45454c"/></svg>');
const semAvatar = new Map(); // id → expira (ms)
const avatarPadrao = (res) => res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=21600' }).send(AVATAR_PADRAO);
app.get('/api/player/:id/avatar', limit(30), async (req, res) => {
  const id = req.params.id;
  if (!validId(id)) return res.sendStatus(400);
  if ((semAvatar.get(id) || 0) > Date.now()) return avatarPadrao(res);
  try {
    const r = await fetch(`${CF_BASE}/api/users/${id}/avatar`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      if (r.status === 404) { if (semAvatar.size > 5000) semAvatar.clear(); semAvatar.set(id, Date.now() + 6 * 3600_000); }
      return avatarPadrao(res);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch { avatarPadrao(res); }
});

app.post('/api/orders', limit(5), async (req, res) => {
  const { product, gameId, email, coupon: couponIn } = req.body ?? {};
  const p = Object.hasOwn(PRODUCTS, product) ? PRODUCTS[product] : null;
  if (!p?.ativo) return res.status(400).json({ error: 'Produto inválido.' });
  let coupon = null;
  if (couponIn) {
    coupon = getCoupon(couponIn);
    if (!coupon) return res.status(400).json({ error: 'Cupom inválido ou expirado.', field: 'coupon' });
  }
  const finalCents = priceWith(p, coupon); // preço SEMPRE calculado no servidor
  if (!validId(String(gameId))) return res.status(400).json({ error: 'ID inválido.' });
  if (typeof email !== 'string' || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }

  const player = await getPlayer(gameId);
  if (!player) return res.status(404).json({ error: 'Conta não encontrada.' });
  const reason = blockReason(p, player);
  if (reason) return res.status(409).json({ error: reason });
  const device = devOf(req);
  if (isBlocked(gameId, email, device)) return res.status(403).json({ error: 'Não foi possível concluir esta compra. Fale com o suporte.' });
  const pend = db.prepare("SELECT COUNT(*) n FROM orders WHERE (game_id=? OR lower(email)=?) AND status='pending'").get(String(gameId), lc(email)).n;
  if (pend >= RISK.pend) return res.status(429).json({ error: 'Você já tem Pix em aberto. Pague ou cancele antes de gerar outro.' });

  if (paid24(gameId, email) + finalCents > RISK.cap) {
    return res.status(409).json({ error: 'Limite diário de compras atingido para esta conta. Fale com o suporte para compras maiores.' });
  }
  const token = crypto.randomUUID();
  const ins = db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, prod_nome, prod_stars, prod_code,
      coupon, list_cents, discount_cents, com_pct, device, ip_h, star_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(token, product, finalCents, String(gameId), player.nickname, email, p.nome, p.stars, p.code,
      coupon?.code || null, p.cents, p.cents - finalCents, coupon ? coupon.comissao_pct : null, device, fp('ip:' + req.ip), STAR_NOW);

  // Pix expira em 30 min. Formato exigido pelo MP: ISO com offset (ex: -03:00).
  const expiresAt = Date.now() + 30 * 60_000;
  const expira = (() => {
    const d = new Date(expiresAt);
    const off = -d.getTimezoneOffset(); // minutos; servidor em -03:00 => 180... usamos valor real
    const sign = off >= 0 ? '+' : '-';
    const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
    const tz = `${sign}${pad(off / 60)}:${pad(off % 60)}`;
    // monta a data no horário local do servidor
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
    return `${local}${tz}`;
  })();
  const r = await fetch(MP_URL, {
    method: 'POST',
    headers: { ...mpHeaders, 'Content-Type': 'application/json', 'X-Idempotency-Key': token },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      transaction_amount: finalCents / 100,
      description: `${p.nome} CounterFlame - Recarga Flame`,
      payment_method_id: 'pix',
      external_reference: token,
      date_of_expiration: expira,
      payer: { email },
    }),
  });
  const pay = await r.json();
  const tx = pay.point_of_interaction?.transaction_data;
  if (!r.ok || !tx?.qr_code) {
    console.error('Erro no Mercado Pago:', pay);
    db.prepare("UPDATE orders SET status='cancelled' WHERE token=?").run(token);
    // e-mail recusado pelo MP (ex.: domínio inexistente como "gmail.con"): diz ao cliente o que corrigir
    if (r.status === 400 && /payer\.email/i.test(JSON.stringify(pay))) {
      return res.status(400).json({ error: 'O Mercado Pago não aceitou esse e-mail. Confira se está digitado certo (ex.: @gmail.com).', field: 'email' });
    }
    return res.status(502).json({ error: 'Não foi possível gerar o Pix. Tente de novo em instantes.' });
  }

  db.prepare('UPDATE orders SET mp_id=?, qr=?, qr_b64=?, expires_at=? WHERE token=?')
    .run(String(pay.id), tx.qr_code, tx.qr_code_base64, expiresAt, token);
  orderEv({ id: Number(ins.lastInsertRowid), device, coupon: coupon?.code || null }, 'pix');
  res.json({ token, id: Number(ins.lastInsertRowid), expiresAt, cents: finalCents, coupon: coupon?.code || null, qr: tx.qr_code, qrBase64: tx.qr_code_base64 });
});

app.get('/api/orders/:token', async (req, res) => {
  let o = findOrder.get(req.params.token);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status === 'pending' && o.mp_id) {
    await syncPayment(o.mp_id);
    o = findOrder.get(req.params.token);
  }
  const entrega = entregaState(o);
  const st = o.status === 'cancelled' && o.paid_at ? (o.refund_state === 'done' ? 'refunded' : 'refund') : o.status; // pago e não entregue
  if (req.query.full !== '1') return res.json({ status: st, entrega });
  // Dados para reabrir o pedido pelo link (quem tem o token = dono do pedido).
  // Nunca devolve e-mail. QR só enquanto o Pix pode ser pago.
  const pending = o.status === 'pending';
  res.json({
    status: st, entrega, id: o.id, product: o.product, nome: o.prod_nome || PRODUCTS[o.product]?.nome || o.product,
    cents: o.cents, gameId: o.game_id, nick: o.nickname,
    avatar: `/api/player/${encodeURIComponent(o.game_id)}/avatar`,
    img: PRODUCTS[o.product]?.img || `/img/${o.product}.jpg`,
    expiresAt: o.expires_at || null,
    qr: pending ? o.qr || null : null, qrBase64: pending ? o.qr_b64 || null : null,
  });
});

// ---------- Funil (estatística própria, sem serviço externo) ----------
// Etapas: visit → lookup (ID buscado) → select (item escolhido) → pix → paid → delivered.
// Contamos APARELHOS distintos (cookie aleatório cf_dev; sem cookie, IP embaralhado). Robôs/prévias de link não
// rodam o JS da página, e agentes conhecidos de robô são ignorados.
db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT CURRENT_TIMESTAMP,
  dev TEXT NOT NULL, ev TEXT NOT NULL, coupon TEXT, src TEXT, order_id INTEGER
)`);
db.exec('CREATE INDEX IF NOT EXISTS events_ts ON events(ts)');
const EV_CLIENT = new Set(['visit', 'lookup', 'select']);
const SRCS = new Set(['whatsapp', 'youtube', 'instagram', 'tiktok', 'telegram', 'google', 'facebook', 'discord', 'twitter', 'outro', 'direto']);
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|headless|curl|wget|python|axios|node-fetch|go-http|java\/|okhttp|monitor|lighthouse/i;
const devKey = (req) => devOf(req) || 'ip:' + fp('ip:' + req.ip);
function logEv(dev, ev, { coupon = null, src = null, orderId = null } = {}) {
  try {
    if (!src && ev !== 'visit') src = db.prepare("SELECT src FROM events WHERE dev=? AND ev='visit' ORDER BY id DESC LIMIT 1").get(dev)?.src || null;
    db.prepare('INSERT INTO events (dev, ev, coupon, src, order_id) VALUES (?,?,?,?,?)').run(dev, ev, coupon, src, orderId);
  } catch (e) { console.error('evento', ev, e.message); }
}
// evento de pedido (servidor): usa o aparelho do pedido
const orderEv = (o, ev) => logEv(o.device || `pedido:${o.id}`, ev, { coupon: o.coupon || null, orderId: o.id });
app.post('/api/ev', limit(60), (req, res) => {
  const b = req.body ?? {};
  if (!EV_CLIENT.has(b.ev) || BOT_UA.test(req.get('user-agent') || '')) return res.sendStatus(204);
  const coupon = b.coupon ? normCode(b.coupon) : null;
  logEv(devKey(req), b.ev, {
    coupon: coupon && validCode(coupon) ? coupon : null,
    src: SRCS.has(b.src) ? b.src : b.ev === 'visit' ? 'outro' : null,
  });
  res.sendStatus(204);
});

// ---------- Suporte: formulário → e-mail para suporte@ (Responder vai ao cliente) + aviso no Telegram ----------
db.exec(`CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  email TEXT, assunto TEXT, msg TEXT, order_id INTEGER, game_id TEXT, ip_h TEXT, mail_ok INTEGER, tg_ok INTEGER
)`);
const SUPPORT_TO = env.SUPPORT_TO || 'suporte@recargaflame.com.br';
const ASSUNTOS = {
  naochegou: 'Meu pedido não chegou', pagamento: 'Problema com o pagamento', iderrado: 'Informei o ID errado',
  reembolso: 'Reembolso', duvida: 'Dúvida antes de comprar', outro: 'Outro assunto',
};
const STATUS_TXT = { pending: 'aguardando pagamento', paid: 'pago, aguardando entrega', delivered: 'entregue', cancelled: 'cancelado', reversed: 'estornado' };
const supportLimit = rateLimit({ windowMs: 3600_000, limit: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas mensagens em pouco tempo. Tente de novo mais tarde.' } });
app.post('/api/suporte', supportLimit, async (req, res) => {
  const b = req.body ?? {};
  if (b.site) return res.json({ ok: true, id: 0 }); // campo invisível preenchido = robô
  const email = String(b.email || '').trim().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido para a resposta.', field: 'email' });
  if (!ASSUNTOS[b.assunto]) return res.status(400).json({ error: 'Escolha o assunto.', field: 'assunto' });
  const msg = String(b.msg || '').trim();
  if (msg.length < 10) return res.status(400).json({ error: 'Conte um pouco mais (pelo menos 10 caracteres).', field: 'msg' });
  if (msg.length > 2000) return res.status(400).json({ error: 'Mensagem muito longa (máximo 2000 caracteres).', field: 'msg' });
  // pedido: pelo link (token, verificado) ou só o número informado (não verificado)
  const o = typeof b.token === 'string' && /^[A-Za-z0-9-]{10,64}$/.test(b.token) ? findOrder.get(b.token) || null : null;
  const num = String(b.pedido || '').replace(/\D/g, '');
  const pedidoNum = o ? o.id : /^\d{1,7}$/.test(num) ? Number(num) : null;
  const gidIn = String(b.gameId || '').trim();
  const gid = o ? o.game_id : validId(gidIn) ? gidIn : null;
  const assunto = ASSUNTOS[b.assunto];
  const tid = Number(db.prepare('INSERT INTO support_tickets (email, assunto, msg, order_id, game_id, ip_h) VALUES (?,?,?,?,?,?)')
    .run(email, assunto, msg, pedidoNum, gid, fp('ip:' + req.ip)).lastInsertRowid);
  const pedLine = o
    ? `Pedido #${o.id} (verificado) · ${o.prod_nome || o.product} · ${brlTxt(o.cents)} · ${STATUS_TXT[o.status] || o.status} · ${o.nickname} (ID ${o.game_id})`
      + (lc(o.email) !== lc(email) ? ' · ⚠ e-mail diferente do usado no pedido' : '')
    : pedidoNum ? `Pedido informado: #${pedidoNum} (não verificado)` : 'Sem pedido informado';
  const lines = [`Chamado #${tid} — ${assunto}`, `De: ${email}`, pedLine, !o && gid ? `ID informado: ${gid}` : null].filter(Boolean);
  const subject = `[Suporte #${tid}] ${assunto}${pedidoNum ? ` — pedido #${pedidoNum}` : ''}`;
  const html = `<div style="font-family:Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.55;color:#111">
${lines.map((l) => `<div>${esc(l)}</div>`).join('')}
<hr style="border:0;border-top:1px solid #ddd;margin:14px 0">
<div style="white-space:pre-wrap">${esc(msg)}</div>
<hr style="border:0;border-top:1px solid #ddd;margin:14px 0">
<div style="color:#777;font-size:12px">Responder este e-mail envia a resposta direto para ${esc(email)}.</div></div>`;
  const text = `${lines.join('\n')}\n\n${msg}\n\n— Responder este e-mail envia a resposta direto para ${email}.`;
  const [mailOk, tgOk] = await Promise.all([
    sendMail(SUPPORT_TO, subject, html, text, email),
    tgSend(`📩 Suporte #${tid} — ${assunto}\nDe: ${email}\n${pedLine}\n\n${msg.slice(0, 600)}${msg.length > 600 ? '…' : ''}\n\nResponda pelo e-mail (Gmail).`),
  ]);
  db.prepare('UPDATE support_tickets SET mail_ok=?, tg_ok=? WHERE id=?').run(mailOk ? 1 : 0, tgOk ? 1 : 0, tid);
  if (!mailOk && !tgOk) return res.status(502).json({ error: `Não conseguimos enviar agora. Tente de novo em instantes ou escreva para ${SUPPORT_TO}.` });
  res.json({ ok: true, id: tid });
});

// Cliente cancela o próprio Pix pendente (só quem tem o token do pedido).
// Cancela DE VERDADE no Mercado Pago, para o QR antigo não poder mais ser pago
// (evita pagamento em dobro ao trocar de produto). Se o MP recusar — ex.: já foi
// pago — sincroniza com o MP e devolve o status real; pedido pago nunca é cancelado aqui.
app.post('/api/orders/:token/cancel', limit(10), async (req, res) => {
  const o = findOrder.get(req.params.token);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status !== 'pending') return res.json({ status: o.status });
  let cancelled = !o.mp_id; // sem Pix no MP: nada a cancelar lá
  if (o.mp_id) {
    const r = await fetch(`${MP_URL}/${encodeURIComponent(o.mp_id)}`, {
      method: 'PUT',
      headers: { ...mpHeaders, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ status: 'cancelled' }),
    });
    const j = await r.json().catch(() => ({}));
    cancelled = r.ok && j.status === 'cancelled';
    if (!cancelled) await syncPayment(o.mp_id);
  }
  if (cancelled) db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'").run(o.id);
  res.json({ status: findOrder.get(o.token).status });
});

app.post('/webhook/mercadopago', async (req, res) => {
  const type = req.query.type ?? req.body?.type;
  const id = String(req.query['data.id'] ?? req.body?.data?.id ?? '');
  if (type !== 'payment') return res.sendStatus(200);
  if (!/^\d+$/.test(id) || !validSignature(req, id)) return res.sendStatus(401);
  await syncPayment(id);
  res.sendStatus(200);
});

// Passo 1: senha. Correta → manda código pelo Telegram e devolve um desafio.
// Senha correta sempre passa (operador nunca fica trancado fora); erradas contam no anti-brute-force.
app.post('/login/senha', limit(30), async (req, res) => {
  const ip = req.ip;
  const { user, pass } = req.body ?? {};
  const ok = safeEq(String(user ?? ''), env.ADMIN_USER) & safeEq(String(pass ?? ''), env.ADMIN_PASS);
  if (!ok) {
    if (tooManyFails(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
    noteFail(ip);
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const id = crypto.randomBytes(24).toString('base64url');
  challenges.set(id, { codeHash: hashHex(code), exp: Date.now() + CODE_TTL, tries: 0, ip });
  const sent = await tgSend(`🔐 Código de acesso ao painel: ${code}\nVale 5 minutos. IP: ${ip}\nSe não foi você, troque a senha do admin.`);
  if (!sent) { challenges.delete(id); return res.status(502).json({ error: 'Não foi possível enviar o código pelo Telegram.' }); }
  res.json({ challenge: id });
});

// Passo 2: código. Certo → cria sessão (cookie HttpOnly/Secure/SameSite=Strict, 30 dias renováveis, teto 90).
app.post('/login/codigo', limit(30), (req, res) => {
  const ip = req.ip;
  const { challenge, code } = req.body ?? {};
  const c = typeof challenge === 'string' ? challenges.get(challenge) : null;
  if (!c || c.exp < Date.now()) {
    if (c) challenges.delete(challenge);
    return res.status(401).json({ error: 'Código expirado. Entre com a senha de novo.', restart: true });
  }
  const given = String(code ?? '').trim();
  if (/^\d{6}$/.test(given) && safeEq(hashHex(given), c.codeHash)) {
    challenges.delete(challenge); // uso único
    const tok = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO admin_sessions (id_hash, created_at, expires_at, ip, ua) VALUES (?,?,?,?,?)')
      .run(hashHex(tok), Date.now(), Date.now() + SESSION_TTL, ip, String(req.get('user-agent') || '').slice(0, 200));
    res.set('Set-Cookie', `${COOKIE}=${tok}; Max-Age=${SESSION_TTL / 1000}; ${cookieAttrs()}`);
    return res.json({ ok: true });
  }
  noteFail(ip);
  if (++c.tries >= CODE_MAX_TRIES) {
    challenges.delete(challenge);
    return res.status(401).json({ error: 'Código incorreto várias vezes. Entre com a senha de novo.', restart: true });
  }
  res.status(401).json({ error: `Código incorreto. Restam ${CODE_MAX_TRIES - c.tries} tentativas.` });
});

app.post('/logout', (req, res) => {
  const tok = getCookie(req, COOKIE);
  if (tok) db.prepare('DELETE FROM admin_sessions WHERE id_hash=?').run(hashHex(tok));
  res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieAttrs()}`);
  res.json({ ok: true });
});

app.get('/login', (req, res) => {
  if (sessionOk(req)) return res.redirect(302, '/painel');
  res.send(LOGIN_HTML);
});

function painelOrders() {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  return rows.map((o) => {
    const p = PRODUCTS[o.product] || {};
    const nome = o.prod_nome || p.nome || o.product;
    const stars = o.prod_stars || p.stars || 0;
    const code = o.prod_code || p.code || '';
    const fmt = (t) => (t ? new Date(t.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null);
    return {
      id: o.id, status: o.status, nome, stars,
      cents: o.cents, gameId: o.game_id, nick: o.nickname, email: o.email, cup: o.coupon || '', desc: o.discount_cents || 0,
      tg: code ? `https://t.me/CounterFlameDonate_bot?start=s_${code}_${o.game_id}` : '',
      created: fmt(o.created_at), paid: fmt(o.paid_at), delivered: fmt(o.delivered_at),
      paidTs: o.paid_at ? Date.parse(o.paid_at.replace(' ', 'T') + 'Z') : null,
      risk: o.status === 'paid' ? riskOf(o) : [],
      chk: o.status === 'paid' ? chkOf(o) : null, chkOn: chkOn(),
      ap: o.autopay || null, apInfo: o.autopay_info ? JSON.parse(o.autopay_info) : null,
      canPay: o.status === 'paid' ? canAutopay(o) : null,
      canApprove: o.status === 'paid' ? canApprove(o) : false, approved: !!o.approved_at,
      blocked: ['cancelled', 'reversed'].includes(o.status) && o.paid_at ? orderBlocked(o) : false,
      refundable: podeReembolsar(o), refund: o.refund_state || null,
    };
  });
}
app.get('/api/admin/orders', admin, (req, res) => res.json(painelOrders()));
function starsInfo() {
  const { s: saldo, n, real } = starsEff();
  const movs = db.prepare('SELECT * FROM stars_ledger ORDER BY id DESC LIMIT 40').all().map((m) => ({
    id: m.id, kind: m.kind, delta: m.delta, cents: m.cents, order_id: m.order_id, nota: m.nota || '',
    data: new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
  }));
  // custo médio de TODAS as compras (histórico); o custo usado nos pedidos é custoAtual
  const c = db.prepare('SELECT SUM(stars) st, SUM(cents) c FROM stars_purchases').get();
  const fmtD = (t) => new Date(t.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: '2-digit' });
  const compras = db.prepare('SELECT * FROM stars_purchases ORDER BY created_at DESC, id DESC LIMIT 20').all()
    .map((p) => ({ id: p.id, stars: p.stars, cents: p.cents, nota: p.nota || '', data: fmtD(p.created_at), unit: p.cents / p.stars / 100 }));
  return { configurado: n > 0, saldo, fila: starsFila(), low: STARS_LOW, movs,
    custoMedio: c.st ? c.c / c.st / 100 : null, custoConfig: STAR_COST, custoAtual: STAR_NOW, taxaMP: MP_FEE, previsao: starsForecast(), custoFonte: STAR_INFO.fonte, compras,
    real: realOn() ? { ativo: real, at: REAL.at || null, err: REAL.err, manual: starsSaldo().s } : null,
    autopay: chkOn() ? { on: autopayOn(), mode: autopayMode(), max: autopayMax(), dia: autopayDay(), usado24h: autopay24() } : null };
}
app.get('/api/admin/stars', admin, async (req, res) => {
  if (realOn() && !realFresh()) await syncStarsReal(); // lê se a última leitura envelheceu
  res.json(starsInfo());
});
app.post('/api/admin/stars/sync', admin, async (req, res) => {
  if (!guard(req, res)) return;
  if (!realOn()) return res.status(400).json({ error: 'Conta de usuário não configurada.' });
  await syncStarsReal(true);
  res.json(starsInfo());
});
app.post('/api/admin/stars', admin, (req, res) => {
  if (!guard(req, res)) return;
  const b = req.body ?? {};
  const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : NaN);
  const nota = String(b.nota || '').trim().slice(0, 80);
  if (b.kind === 'compra' || b.kind === 'recarga') { // registro de CUSTO; não altera o saldo
    const st = int(b.stars);
    if (!(st > 0 && st <= 1_000_000)) return res.status(400).json({ error: 'Quantidade de Stars inválida.' });
    const cents = Math.round(Number(b.cents));
    if (!(cents > 0 && cents <= 100_000_000)) return res.status(400).json({ error: 'Informe quanto você pagou (R$).' });
    db.prepare('INSERT INTO stars_purchases (stars, cents, nota) VALUES (?,?,?)').run(st, cents, nota);
    refreshStarCost(true);
  } else if (b.kind === 'ajuste') {
    const real = int(b.saldo_real);
    if (!(real >= 0 && real <= 10_000_000)) return res.status(400).json({ error: 'Saldo inválido.' });
    const { s: atual, n } = starsSaldo();
    if (real === atual && n) return res.json({ ok: true, delta: 0 });
    db.prepare("INSERT INTO stars_ledger (kind, delta, nota) VALUES ('ajuste', ?, ?)").run(real - atual, nota || (n ? 'conferência' : 'saldo inicial'));
  } else return res.status(400).json({ error: 'Tipo inválido.' });
  res.json({ ok: true, saldo: starsSaldo().s });
});
app.delete('/api/admin/stars/compras/:id', admin, (req, res) => {
  if (!guard(req, res)) return;
  const r = db.prepare('DELETE FROM stars_purchases WHERE id=?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Compra não encontrada.' });
  refreshStarCost(true);
  res.json({ ok: true });
});
app.delete('/api/admin/stars/:id', admin, (req, res) => {
  if (!guard(req, res)) return;
  // entregas não se apagam por aqui (corrija com "conferir saldo")
  const r = db.prepare("DELETE FROM stars_ledger WHERE id=? AND kind='ajuste'").run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Movimento não encontrado (entregas não podem ser apagadas).' });
  refreshStarCost(true);
  res.json({ ok: true });
});
app.post('/api/admin/orders/:id/check', admin, async (req, res) => {
  if (!guard(req, res)) return;
  if (!chkOn()) return res.status(400).json({ error: 'Conta de usuário não configurada.' });
  const o = db.prepare('SELECT status FROM orders WHERE id=?').get(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status !== 'paid') return res.status(409).json({ error: 'Só pedidos pagos aguardando entrega.' });
  res.json(await conferir(Number(req.params.id)));
});
app.post('/api/admin/orders/:id/reembolsar', admin, async (req, res) => {
  if (!guard(req, res)) return;
  const id = Number(req.params.id);
  const r = await reembolsar(id);
  // recusado pelo MP: edita o aviso do pedido (o pedido já saiu da fila e o cliente ainda precisa receber); sem mensagem nova
  if (!r.ok && r.mp) {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    tgAviso(id, { icone: '⚠️', titulo: 'reembolso recusado pelo Mercado Pago', saldo: false, fallback: false, kb: refundKb(o),
      extras: [bloqAuto(o) && `🚫 Bloqueado automaticamente: ${bloqAuto(o)}.`,
        `Pedido cancelado e NÃO entregue: o cliente ainda precisa receber ${brlTxt(o.cents)}.`, `Motivo: ${r.why}`] });
  }
  res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: r.why });
});
app.post('/api/admin/orders/:id/aprovar', admin, async (req, res) => {
  if (!guard(req, res)) return;
  const r = await autopay(Number(req.params.id), { aprovar: true });
  res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: r.why });
});
app.post('/api/admin/orders/:id/autopay', admin, async (req, res) => {
  if (!guard(req, res)) return;
  const r = await autopay(Number(req.params.id));
  res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: r.why });
});
// ---------- Previsão de compra de Stars ----------
// Ritmo = Stars entregues por dia nos últimos 7 dias (dias com histórico, 1 a 7). Reserva mínima = maior entre o
// aviso de saldo baixo e o maior produto ativo (para nunca travar um pedido grande). Sugestão: cobrir STARS_TARGET_DAYS.
const STARS_TARGET_DAYS = Number(env.STARS_TARGET_DAYS ?? 14);
function starsForecast(now = Date.now()) {
  const e = starsEff();
  const gasto7 = -db.prepare("SELECT COALESCE(SUM(delta),0) s FROM stars_ledger WHERE kind='entrega' AND created_at > datetime(?, 'unixepoch', '-7 days')").get(Math.floor(now / 1000)).s;
  const first = db.prepare("SELECT MIN(created_at) m FROM stars_ledger WHERE kind='entrega'").get().m;
  const dias = first ? Math.min(7, Math.max(1, Math.ceil((now - Date.parse(first.replace(' ', 'T') + 'Z')) / 86_400_000))) : 7;
  const ritmo = gasto7 / dias;
  const fila = starsFila();
  const maior = Math.max(0, ...Object.values(PRODUCTS).filter((p) => p.ativo).map((p) => p.stars || 0));
  const reserva = Math.max(STARS_LOW, maior);
  const livre = (e.n ? e.s : 0) - fila;
  if (!(ritmo > 0)) return { ritmo: 0, saldo: e.s, fila, reserva, dias: null, ate: null, comprar: livre < reserva ? Math.ceil((reserva - livre) / 100) * 100 : 0, custo: null };
  const duraDias = livre / ritmo;
  const ateDias = Math.max(0, (livre - reserva) / ritmo);                       // quando o saldo chega na reserva
  const comprar = Math.max(0, Math.ceil((ritmo * STARS_TARGET_DAYS + reserva - livre) / 100) * 100);
  const ate = new Date(now - 3 * 3600_000 + ateDias * 86_400_000).toISOString().slice(0, 10);
  return { ritmo: Math.round(ritmo), saldo: e.s, fila, reserva, dias: duraDias, ate, comprar, custo: comprar ? Math.round(comprar * STAR_NOW * 100) : 0, alvo: STARS_TARGET_DAYS };
}
const fcLine = (f) => {
  if (!f.ritmo) return f.comprar ? `🛒 Compre ~${f.comprar}★ para manter a reserva de ${f.reserva}★` : null;
  const ate = f.ate.split('-').reverse().slice(0, 2).join('/');
  return f.comprar
    ? `🛒 Compre ~${f.comprar}★ (≈ ${brlTxt(f.custo)}) até ${ate} — cobre ${f.alvo} dias no ritmo de ${f.ritmo}★/dia`
    : `🛒 Stars ok por ~${Math.floor(f.dias)} dias no ritmo de ${f.ritmo}★/dia`;
};

// ---------- Resumo diário no Telegram (23h, horário de Brasília) ----------
const SUMMARY_HOUR = Number(env.SUMMARY_HOUR ?? 23);
const spDay = (ms = Date.now()) => new Date(ms - 3 * 3600_000).toISOString().slice(0, 10); // dia local (UTC-3)
function dailySummary(day = spDay()) {
  const L = (col) => `date(${col}, '-3 hours')`;
  const vendas = db.prepare(`SELECT o.*, o.com_pct AS comissao_pct FROM orders o
    WHERE o.paid_at IS NOT NULL AND o.status IN ('paid','delivered') AND ${L('o.paid_at')} = ?`).all(day);
  let fat = 0, lucro = 0;
  const pctOf = makePartnerCtx().pctOf;
  for (const o of vendas) {
    const l = orderProfit(o);
    fat += o.cents; lucro += l - (o.coupon ? Math.max(0, l) * (pctOf(o) / 100) : 0);
  }
  const entregues = db.prepare(`SELECT * FROM orders WHERE status='delivered' AND ${L('delivered_at')} = ?`).all(day);
  const auto = entregues.filter((o) => o.autopay === 'sent' && !JSON.parse(o.autopay_info || '{}').resolvido).length;
  const mins = entregues.filter((o) => o.paid_at)
    .map((o) => (Date.parse(o.delivered_at.replace(' ', 'T') + 'Z') - Date.parse(o.paid_at.replace(' ', 'T') + 'Z')) / 60000)
    .sort((a, b) => a - b);
  const med = mins.length ? mins[Math.floor((mins.length - 1) / 2)] : null;
  const fmtMin = (m) => (m < 1 ? '<1 min' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`);
  const fila = db.prepare("SELECT COUNT(*) n FROM orders WHERE status='paid'").get().n;
  const problemas = db.prepare(`SELECT COUNT(*) n FROM orders WHERE status='paid' AND autopay='incerto'`).get().n;
  const estornos = db.prepare(`SELECT COUNT(*) n FROM orders WHERE status IN ('reversed','cancelled') AND paid_at IS NOT NULL
    AND ${L('paid_at')} >= date(?, '-7 days')`).get(day).n;
  // Stars: gasto do dia e autonomia pelo ritmo dos últimos 7 dias
  const gastoDia = -db.prepare(`SELECT COALESCE(SUM(delta),0) s FROM stars_ledger WHERE kind='entrega' AND ${L('created_at')} = ?`).get(day).s;
  const gasto7 = -db.prepare(`SELECT COALESCE(SUM(delta),0) s FROM stars_ledger WHERE kind='entrega' AND ${L('created_at')} > date(?, '-7 days')`).get(day).s;
  const e = starsEff();
  // média por dia sobre os dias que de fato existem no histórico (1 a 7), para não subestimar no começo
  const first = db.prepare("SELECT MIN(created_at) m FROM stars_ledger WHERE kind='entrega'").get().m;
  const dias = first ? Math.min(7, Math.max(1, Math.ceil((Date.parse(day + 'T23:59:59Z') + 3 * 3600_000 - Date.parse(first.replace(' ', 'T') + 'Z')) / 86_400_000))) : 7;
  const porDia = gasto7 / dias;
  const autonomia = e.n && porDia > 0 ? e.s / porDia : null;
  const dd = day.split('-').reverse().join('/');
  return [
    `📊 Resumo de ${dd}`,
    `💰 ${vendas.length} venda${vendas.length === 1 ? '' : 's'} · ${brlTxt(fat)} · lucro estimado ${brlTxt(Math.round(lucro))}`,
    `📦 ${entregues.length} entregue${entregues.length === 1 ? '' : 's'} (${auto} automática${auto === 1 ? '' : 's'}, ${entregues.length - auto} manual)`
      + (med != null ? ` · mediana ${fmtMin(med)} do pagamento à entrega` : ''),
    fila ? `⏳ ${fila} pedido${fila === 1 ? '' : 's'} na fila agora${problemas ? ` (🚨 ${problemas} incerto${problemas === 1 ? '' : 's'})` : ''}` : '✅ Fila vazia',
    `⭐ ${gastoDia}★ gastos hoje · saldo ${e.n ? e.s + '★' : 'não configurado'}`
      + (autonomia != null ? ` · dura ~${autonomia < 1 ? 'menos de 1 dia' : Math.floor(autonomia) + (Math.floor(autonomia) === 1 ? ' dia' : ' dias')} no ritmo atual (${Math.round(porDia)}★/dia)` : '')
      + (e.n && e.s < STARS_LOW ? ' · 🔻 BAIXO' : ''),
    estornos ? `⚠️ ${estornos} estorno/cancelamento após pagamento nos últimos 7 dias` : null,
    fcLine(starsForecast()),
  ].filter(Boolean).join('\n');
}
// dispara 1x por dia a partir da hora marcada (sobrevive a reinício: guarda o último dia enviado)
function summaryTick() {
  const now = new Date(Date.now() - 3 * 3600_000);
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < SUMMARY_HOUR || getSetting('summary_day', '') === day) return;
  setSetting('summary_day', day);
  tgSend(dailySummary(day));
}

// Resolver pagamento incerto/falho: olha a fatura EXATA que a loja tentou pagar (nº gravado antes de cobrar)
// e vê se ela tem recibo. Só leitura.
app.post('/api/admin/orders/:id/verify', admin, async (req, res) => {
  if (!guard(req, res)) return;
  if (!chkOn()) return res.status(400).json({ error: 'Conta de usuário não configurada.' });
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status !== 'paid' || !['incerto', 'erro'].includes(o.autopay)) return res.status(409).json({ error: 'Nada a verificar neste pedido.' });
  if (Date.now() - (o.autopay_at || 0) < 60_000) return res.status(409).json({ error: 'Aguarde 1 minuto após a tentativa e verifique de novo.' });
  const inv = o.autopay_info ? JSON.parse(o.autopay_info).invMsgId : null;
  // sem fatura registrada = falhou antes de chegar a cobrar
  if (!inv) return res.json({ cobrado: false, stars: starsOf(o), semFatura: true });
  try {
    const r = await receiptChecker(inv, env);
    res.json({ cobrado: !!r.paid, recibo: r.receiptMsgId || null, fatura: inv, stars: starsOf(o) });
  } catch (e) {
    res.status(502).json({ error: 'Não consegui ler o histórico de Stars: ' + String(e?.message || e).slice(0, 100) });
  }
});
// acao 'entregue': foi cobrado (ou entregue na mão) → marca entregue. acao 'liberar': não foi cobrado → volta a permitir pagar.
app.post('/api/admin/orders/:id/resolve', admin, (req, res) => {
  if (!guard(req, res)) return;
  const id = Number(req.params.id);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status !== 'paid' || !['incerto', 'erro'].includes(o.autopay)) return res.status(409).json({ error: 'Nada a resolver neste pedido.' });
  const info = { ...(o.autopay_info ? JSON.parse(o.autopay_info) : {}), resolvido: req.body?.acao, em: Date.now() };
  if (req.body?.acao === 'entregue') {
    db.prepare("UPDATE orders SET autopay='sent', autopay_info=? WHERE id=?").run(JSON.stringify({ ...info, stars: starsOf(o) }), id);
    markDelivered(id, 'painel');
    syncStarsReal(true);
  } else if (req.body?.acao === 'liberar') {
    db.prepare("UPDATE orders SET autopay='erro', autopay_info=? WHERE id=?").run(JSON.stringify({ ...info, erro: 'verificado: sem cobrança — pode pagar de novo' }), id);
    // volta o aviso ao normal (botões de pagar/entregar), com a nota da verificação
    const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (cur.tg_msg) tgApi('editMessageText', { chat_id: env.TG_CHAT_ID, message_id: cur.tg_msg, disable_web_page_preview: true,
      text: paidText(cur) + `\n🔍 Verificado às ${hhmmSP()}: nada foi cobrado — pode pagar de novo.`, reply_markup: paidKeyboard(cur) });
  } else return res.status(400).json({ error: 'Ação inválida.' });
  res.json({ ok: true });
});
app.post('/api/admin/autopay/limites', admin, (req, res) => {
  if (!guard(req, res)) return;
  const max = Number(req.body?.max), dia = Number(req.body?.dia);
  if (!Number.isInteger(max) || max < 1 || max > 100_000) return res.status(400).json({ error: 'Máximo por pedido: de 1 a 100.000★.' });
  if (!Number.isInteger(dia) || dia < max || dia > 1_000_000) return res.status(400).json({ error: 'Máximo em 24h: precisa ser pelo menos o máximo por pedido (até 1.000.000★).' });
  setSetting('autopay_max', max); setSetting('autopay_day', dia);
  res.json({ ok: true, max, dia });
});
app.post('/api/admin/autopay', admin, (req, res) => {
  if (!guard(req, res)) return;
  const b = req.body ?? {};
  const mode = b.mode != null ? String(b.mode) : b.on ? '1' : '0';
  if (!['0', '1', '2'].includes(mode)) return res.status(400).json({ error: 'Modo inválido.' });
  if (mode !== '0' && !chkOn()) return res.status(400).json({ error: 'Conta de usuário não configurada.' });
  setSetting('autopay', mode);
  res.json({ on: autopayOn(), mode: autopayMode() });
});
app.post('/api/admin/orders/:id/unblock', admin, (req, res) => {
  if (!guard(req, res)) return;
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const estava = orderBlocked(o);
  unblockClient(o);
  if (estava) tgDesbloqueado(o);
  res.json({ ok: true });
});

app.get('/painel', admin, (req, res) => {
  const data = JSON.stringify(painelOrders()).replace(/</g, '\\u003c');

  res.send(painelHtml(data));
});

app.post('/painel/:id/entregue', admin, (req, res) => {
  const origin = req.get('origin');
  const sameOrigin = origin === new URL(env.PUBLIC_URL).origin;
  if (!sameOrigin && req.get('x-painel') !== '1') return res.sendStatus(403);
  // e-mail ao cliente só na transição paid→delivered; também atualiza os botões do aviso no Telegram
  res.json({ ok: markDelivered(Number(req.params.id), 'painel') });
});

// ---- CRUD de produtos (painel) ----
function guard(req, res) {
  const sameOrigin = req.get('origin') === new URL(env.PUBLIC_URL).origin;
  if (!sameOrigin && req.get('x-painel') !== '1') { res.sendStatus(403); return false; }
  return true;
}
function parseProduct(b) {
  const key = String(b.key || '').trim().toLowerCase();
  const nome = String(b.nome || '').trim();
  const code = String(b.code || '').trim();
  const cents = Math.round(Number(b.cents));
  const stars = Math.round(Number(b.stars) || 0);
  const niveis = Math.round(Number(b.niveis) || 0);
  const tipo = ['', 'wildfire', 'arsenal', 'gold'].includes(b.tipo) ? b.tipo : '';
  const img = String(b.img || '').trim();
  const ativo = b.ativo ? 1 : 0;
  if (!/^[a-z0-9_]{2,24}$/.test(key)) return { err: 'Chave inválida (use a-z, 0-9, _, 2-24 caracteres).' };
  if (!nome || nome.length > 60) return { err: 'Nome obrigatório (até 60 caracteres).' };
  if (!code || code.length > 40) return { err: 'Código do link obrigatório (até 40 caracteres).' };
  if (!Number.isFinite(cents) || cents < 1 || cents > 10_000_00) return { err: 'Preço inválido.' };
  if (niveis < 0 || niveis > 999) return { err: 'Níveis inválidos.' };
  // img: aceita vazio (usa /img/<key>.jpg por padrão), caminho local /img/... ou URL https.
  if (img && !/^\/img\/[\w.-]+$/.test(img) && !/^https:\/\/[\w.-]+\/[\w./-]*$/.test(img)) {
    return { err: 'Imagem inválida: use /img/arquivo.jpg ou uma URL https.' };
  }
  return { key, nome, code, cents, stars, niveis, tipo, img, ativo };
}

app.get('/api/admin/products', admin, (req, res) => {
  const list = db.prepare('SELECT * FROM products ORDER BY sort, rowid').all()
    .map((r) => {
      const l = profitCents(r.cents, r.stars || 0); // com o custo ATUAL da Star
      return { ...r, ativo: !!r.ativo, img: r.img || `/img/${r.key}.jpg`, lucro: Math.round(l), margem: r.cents ? l / r.cents : 0 };
    });
  res.json(list);
});

app.post('/api/admin/products', admin, (req, res) => {
  if (!guard(req, res)) return;
  const p = parseProduct(req.body ?? {});
  if (p.err) return res.status(400).json({ error: p.err });
  if (PRODUCTS[p.key] || db.prepare('SELECT 1 FROM products WHERE key=?').get(p.key)) {
    return res.status(409).json({ error: 'Já existe um produto com essa chave.' });
  }
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),-1) m FROM products').get().m;
  db.prepare('INSERT INTO products (key,nome,cents,stars,code,tipo,niveis,img,ativo,sort) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(p.key, p.nome, p.cents, p.stars, p.code, p.tipo, p.niveis, p.img, p.ativo, maxSort + 1);
  loadProducts();
  res.json({ ok: true });
});

app.put('/api/admin/products/:key', admin, (req, res) => {
  if (!guard(req, res)) return;
  const key = req.params.key;
  if (!db.prepare('SELECT 1 FROM products WHERE key=?').get(key)) return res.status(404).json({ error: 'Produto não encontrado.' });
  const p = parseProduct({ ...req.body, key });
  if (p.err) return res.status(400).json({ error: p.err });
  db.prepare('UPDATE products SET nome=?,cents=?,stars=?,code=?,tipo=?,niveis=?,img=?,ativo=? WHERE key=?')
    .run(p.nome, p.cents, p.stars, p.code, p.tipo, p.niveis, p.img, p.ativo, key);
  loadProducts();
  res.json({ ok: true });
});

app.patch('/api/admin/products/:key/ativo', admin, (req, res) => {
  if (!guard(req, res)) return;
  const key = req.params.key;
  const row = db.prepare('SELECT ativo FROM products WHERE key=?').get(key);
  if (!row) return res.status(404).json({ error: 'Produto não encontrado.' });
  const novo = row.ativo ? 0 : 1;
  db.prepare('UPDATE products SET ativo=? WHERE key=?').run(novo, key);
  loadProducts();
  res.json({ ok: true, ativo: !!novo });
});

app.delete('/api/admin/products/:key', admin, (req, res) => {
  if (!guard(req, res)) return;
  const key = req.params.key;
  if (!db.prepare('SELECT 1 FROM products WHERE key=?').get(key)) return res.status(404).json({ error: 'Produto não encontrado.' });
  // pedidos já guardam snapshot (prod_nome/stars/code), então excluir não quebra histórico
  db.prepare('DELETE FROM products WHERE key=?').run(key);
  loadProducts();
  res.json({ ok: true });
});

// ---- Parceiros (cupons no painel, metas, fechamento, extrato, página do parceiro): src/parceiros.js ----
const { makePartnerCtx, freezeClosedMonths, freezeTick, avisoFaixa, fechamentoMsg, fechamentoTick, primeiroDiaUtil, enviarExtratos, extratoEmail } = initParceiros({ env, db, app, admin, guard, limit, orderProfit, normCode, RESERVED_CODES, validCode, logCup, tiersTxtS, diffCup, SITE_URL, esc, brlTxt, REAL, getSetting, setSetting, tgSend, sendMail });
// ---- Analytics (painel) ----
// Datas no fuso local (America/Sao_Paulo = UTC-3). Vendas = pagos/entregues/estornados pela data do pagamento;
// conversão = dos Pix gerados no período (com mp_id), quantos foram pagos.
app.get('/api/admin/analytics', admin, (req, res) => {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = re.test(req.query.from || '') ? req.query.from : '0000-01-01';
  const to = re.test(req.query.to || '') ? req.query.to : '9999-12-31';
  const local = (col) => `date(${col}, '-3 hours')`;
  const sold = db.prepare(`SELECT o.*, o.com_pct AS comissao_pct FROM orders o
    WHERE o.paid_at IS NOT NULL AND o.status IN ('paid','delivered','reversed') AND ${local('o.paid_at')} BETWEEN ? AND ?`).all(from, to);
  const ok = sold.filter((o) => o.status !== 'reversed');
  const pctOf = makePartnerCtx().pctOf;
  let faturado = 0, lucro = 0, comissao = 0, stars = 0, comCupom = 0;
  const byDay = {}, byProd = {};
  for (const o of ok) {
    const l = orderProfit(o);
    const c = o.coupon ? Math.max(0, l) * (pctOf(o) / 100) : 0;
    faturado += o.cents; lucro += l; comissao += c; stars += o.prod_stars || 0;
    if (o.coupon) comCupom++;
    const d = new Date(new Date(o.paid_at.replace(' ', 'T') + 'Z').getTime() - 3 * 3600_000).toISOString().slice(0, 10);
    const day = (byDay[d] ||= { date: d, n: 0, cents: 0 }); day.n++; day.cents += o.cents;
    const nome = o.prod_nome || o.product;
    const pr = (byProd[nome] ||= { nome, n: 0, cents: 0, lucro: 0 }); pr.n++; pr.cents += o.cents; pr.lucro += l - c;
  }
  const gen = db.prepare(`SELECT COUNT(*) n, SUM(paid_at IS NOT NULL) pagos FROM orders
    WHERE mp_id IS NOT NULL AND ${local('created_at')} BETWEEN ? AND ?`).get(from, to);
  // entrega: minutos entre pago e entregue
  const mins = ok.filter((o) => o.delivered_at)
    .map((o) => (new Date(o.delivered_at.replace(' ', 'T') + 'Z') - new Date(o.paid_at.replace(' ', 'T') + 'Z')) / 60000)
    .sort((x, y) => x - y);
  const mediana = mins.length ? mins[Math.floor((mins.length - 1) / 2)] : null;
  // funil: aparelhos distintos por etapa no período; e quebras por cupom e por origem
  const ETAPAS = ['visit', 'lookup', 'select', 'pix', 'paid', 'delivered'];
  const evRows = db.prepare(`SELECT ev, COALESCE(coupon,'') coupon, COALESCE(src,'') src, dev FROM events
    WHERE date(ts, '-3 hours') BETWEEN ? AND ?`).all(from, to);
  const uniq = (rows, ev) => new Set(rows.filter((r) => r.ev === ev).map((r) => r.dev)).size;
  const etapas = ETAPAS.map((ev) => ({ ev, n: uniq(evRows, ev) }));
  const grupo = (key) => {
    const g = {};
    for (const r of evRows) (g[r[key] || '—'] ||= []).push(r);
    return Object.entries(g).map(([k, rs]) => ({ k, visit: uniq(rs, 'visit'), pix: uniq(rs, 'pix'), paid: uniq(rs, 'paid') }))
      .sort((x, y) => y.visit - x.visit || y.paid - x.paid);
  };
  const funil = { etapas, cupons: grupo('coupon'), origens: grupo('src') };
  // como foram entregues os pedidos vendidos no período, e por que não foram automáticos
  const entregues = ok.filter((o) => o.delivered_at);
  const tipoDe = (o) => o.entrega_via || (o.autopay === 'sent' ? (o.approved_at ? 'aprovado' : 'auto') : 'manual');
  const med = (arr) => { if (!arr.length) return null; const v = arr.slice().sort((x, y) => x - y); return Math.round(v[Math.floor((v.length - 1) / 2)]); };
  const minsOf = (o) => (Date.parse(o.delivered_at.replace(' ', 'T') + 'Z') - Date.parse(o.paid_at.replace(' ', 'T') + 'Z')) / 60000;
  const entregaTipos = ['auto', 'aprovado', 'toque', 'manual'].map((t) => {
    const g = entregues.filter((o) => tipoDe(o) === t);
    return { tipo: t, n: g.length, medianaMin: med(g.map(minsOf)) };
  });
  const mc = {};
  for (const o of entregues.filter((x) => tipoDe(x) !== 'auto')) { const k = motivoCat(o.manual_motivo); mc[k] = (mc[k] || 0) + 1; }
  const motivos = Object.entries(mc).map(([motivo, n]) => ({ motivo, n })).sort((x, y) => y.n - x.n);
  // horários e dias de pico (horário de Brasília)
  const porHora = Array.from({ length: 24 }, (_, h) => ({ h, n: 0, cents: 0 }));
  const porSemana = Array.from({ length: 7 }, (_, d) => ({ d, n: 0, cents: 0 }));
  for (const o of ok) {
    const t = new Date(Date.parse(o.paid_at.replace(' ', 'T') + 'Z') - 3 * 3600_000);
    const ph = porHora[t.getUTCHours()], pd = porSemana[t.getUTCDay()];
    ph.n++; ph.cents += o.cents; pd.n++; pd.cents += o.cents;
  }
  // clientes (pelo ID do jogo): novos × que voltaram, recompra, intervalo entre compras, melhores clientes
  const hist = {};
  for (const o of db.prepare(`SELECT game_id, nickname, cents, paid_at FROM orders WHERE paid_at IS NOT NULL
      AND status IN ('paid','delivered') AND ${local('paid_at')} <= ? ORDER BY paid_at`).all(to)) {
    (hist[o.game_id] ||= []).push({ t: Date.parse(o.paid_at.replace(' ', 'T') + 'Z'), cents: o.cents, nick: o.nickname });
  }
  const noPer = {};
  for (const o of ok) { const c = (noPer[o.game_id] ||= { id: o.game_id, compras: 0, total: 0 }); c.compras++; c.total += o.cents; }
  const ids = Object.keys(noPer);
  const dayOf = (t) => new Date(t - 3 * 3600_000).toISOString().slice(0, 10);
  const novos = ids.filter((id) => dayOf(hist[id][0].t) >= from).length;
  const gaps = [];
  for (const id of ids) for (let i = 1; i < hist[id].length; i++) gaps.push((hist[id][i].t - hist[id][i - 1].t) / 86_400_000);
  gaps.sort((x, y) => x - y);
  const clientes = {
    total: ids.length, novos, voltaram: ids.length - novos,
    recompra: ids.length ? ids.filter((id) => hist[id].length >= 2).length / ids.length : null,
    intervaloDias: gaps.length ? Math.round(gaps[Math.floor((gaps.length - 1) / 2)] * 10) / 10 : null,
    top: ids.map((id) => ({ ...noPer[id], nick: hist[id].at(-1).nick, comprasTotal: hist[id].length, ultima: dayOf(hist[id].at(-1).t) }))
      .sort((x, y) => y.total - x.total || y.compras - x.compras).slice(0, 10),
  };
  res.json({
    from, to, funil, entregaTipos, motivos, porHora, porSemana, clientes,
    vendas: ok.length, faturado, ticket: ok.length ? Math.round(faturado / ok.length) : 0,
    lucro: Math.round(lucro - comissao), comissao: Math.round(comissao), stars, comCupom,
    estornos: sold.length - ok.length,
    pixGerados: gen.n || 0, pixPagos: gen.pagos || 0,
    entregas: mins.length, entregaMedianaMin: mediana == null ? null : Math.round(mediana),
    entregaAte1h: mins.length ? mins.filter((m) => m <= 60).length / mins.length : null,
    porDia: Object.values(byDay).sort((x, y) => x.date.localeCompare(y.date)),
    // ordenado por LUCRO (após Stars, taxa MP e comissão de cupom); margem = lucro ÷ faturado
    produtos: Object.values(byProd).map((p) => ({ ...p, lucro: Math.round(p.lucro), margem: p.cents ? p.lucro / p.cents : 0 }))
      .sort((x, y) => y.lucro - x.lucro || y.cents - x.cents),
  });
});

// Link curto de cupom para divulgação: /aquila → /?cupom=AQUILA. Cupom desativado também redireciona: a loja avisa
// "cupom não disponível, preços sem desconto" e o cliente de um vídeo antigo não cai num 404. Inexistente → 404.
// Fica por último entre as rotas: /painel, /suporte etc. são resolvidos antes.
app.get('/:code', (req, res, next) => {
  const c = normCode(req.params.code);
  if (!validCode(c) || !db.prepare('SELECT 1 FROM coupons WHERE code=?').get(c)) return next();
  // mantém a origem da divulgação (ex.: /aquila?src=wa) para o funil
  const extra = ['src', 'utm_source'].filter((k) => /^[a-z0-9_-]{1,20}$/i.test(String(req.query[k] || '')))
    .map((k) => `&${k}=${encodeURIComponent(req.query[k])}`).join('');
  res.redirect(302, '/?cupom=' + encodeURIComponent(c) + extra);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente.' });
});

// ---------- Desligamento seguro (deploy/reinício) ----------
// Ao receber SIGINT/SIGTERM (pm2 restart/stop): para de aceitar pagamentos novos no bot (canAutopay recusa), espera
// o pagamento em andamento terminar (autopay='paying') e só então sai. Sem isso, um reinício no meio do pagamento
// vira "incerto". Teto de espera: STOP_MAX_MS (o kill_timeout do pm2 precisa ser maior).
let stopping = false;
const STOP_MAX_MS = 25_000;
const payingNow = () => db.prepare("SELECT COUNT(*) n FROM orders WHERE autopay='paying'").get().n;
async function gracefulStop({ exit = (c) => process.exit(c), maxMs = STOP_MAX_MS, stepMs = 250, server } = {}) {
  if (stopping) return;
  stopping = true;
  server?.close();
  const t0 = Date.now();
  let n = payingNow();
  if (n) console.log(`Desligando: esperando ${n} pagamento(s) em andamento…`);
  while (n && Date.now() - t0 < maxMs) { await new Promise((r) => setTimeout(r, stepMs)); n = payingNow(); }
  if (n) console.error(`Desligando com ${n} pagamento(s) ainda em andamento (viram "incerto" ao subir)`);
  else console.log('Desligando: nenhum pagamento em andamento');
  exit(0);
}
const _resetStopping = () => { stopping = false; };

// Sobe o servidor só quando executado diretamente (não durante os testes).
if (process.env.NODE_ENV !== 'test') {
  // Só aceita conexões da própria máquina (nginx). Ninguém fala com o Node direto,
  // mesmo se o firewall mudar — assim não dá pra forjar X-Forwarded-For e burlar rate limits.
  const server = app.listen(env.PORT || 3000, '127.0.0.1', () => console.log('Loja no ar'));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => gracefulStop({ server }));
  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) tgPoll(); // botões do aviso de pago
  if (realOn()) { syncStarsReal(true); setInterval(() => syncStarsReal(true), 5 * 60_000); } // saldo real a cada 5 min
  setInterval(summaryTick, 60_000); // resumo diário às SUMMARY_HOUR (23h)
  // virada do mês: congela as faixas do mês fechado; 1º dia útil: comissões a pagar no Telegram
  setInterval(() => { try { freezeTick(); fechamentoTick(); } catch (e) { console.error('fechamento', e.message); } }, 60_000);
}

refreshStarCost(false); // custo por Star a partir das recargas (depois de tudo declarado)

export { gracefulStop, _resetStopping, app, db, makePartnerCtx, freezeClosedMonths, fechamentoMsg, fechamentoTick, primeiroDiaUtil, enviarExtratos, extratoEmail, _setRefundCaller, reembolsar, remindPending, starsForecast, riskOf, RISK, refreshStarCost, handleTgUpdate, entregaState, dailySummary, summaryTick, _setReceiptChecker, _setStarsReader, _setInvoiceChecker, _setInvoicePayer, conferir, autopay, syncStarsReal, loadProducts, PRODUCTS, adminFails, challenges, expirePending, deliveredEmail, sendMail, floorCents, profitCents };
