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

const findOrder = db.prepare('SELECT * FROM orders WHERE token = ?');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
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
const RISK = {
  review: brlEnv(env.RISK_REVIEW_BRL, 150), // pedido a partir disso → "revisar antes de entregar"
  first: brlEnv(env.RISK_FIRST_BRL, 50),    // 1ª compra do ID a partir disso → revisar
  day: brlEnv(env.RISK_DAY_BRL, 300),       // soma paga em 24h (ID ou e-mail) a partir disso → revisar
  cap: brlEnv(env.LIMIT_DAY_BRL, 700),      // teto em 24h por ID/e-mail: checkout recusa acima
  pend: Number(env.MAX_PENDING_PIX ?? 3),   // Pix em aberto ao mesmo tempo por ID/e-mail
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
for (const col of ['device TEXT', 'ip_h TEXT', 'payer_doc TEXT', 'payer_acct TEXT', 'tg_msg INTEGER', 'chk TEXT', 'autopay TEXT', 'autopay_info TEXT', 'autopay_at INTEGER', 'star_cost REAL']) {
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
  if (blockedIn('acct', o.payer_acct)) why.push('conta bancária que pagou já teve estorno — NÃO entregue sem checar');
  if (blockedIn('device', o.device)) why.push('aparelho ligado a um estorno');
  if (blockedIn('ip', o.ip_h)) why.push('mesmo IP de um pedido estornado (só alerta: IP de 4G é compartilhado)');
  if (o.cents >= RISK.review) why.push(`valor alto (${brlTxt(o.cents)})`);
  const prev = db.prepare("SELECT COUNT(*) n FROM orders WHERE game_id=? AND id<? AND status='delivered'").get(o.game_id, o.id).n;
  if (!prev && o.cents >= RISK.first) why.push('primeira compra deste ID');
  const day = paid24(o.game_id, o.email);
  if (day >= RISK.day) why.push(`${brlTxt(day)} pagos em 24h por este ID/e-mail`);
  return why;
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
    if (r.changes) notifyPaid({ ...o, payer_acct: pp.acct });
  } else if (['cancelled', 'rejected', 'refunded', 'charged_back'].includes(pay.status)) {
    const before = o.status;
    const r = db.prepare(`UPDATE orders SET status = CASE status WHEN 'delivered' THEN 'reversed' ELSE 'cancelled' END
      WHERE id=? AND status IN ('pending','paid','delivered')`).run(o.id);
    // estorno/chargeback de pedido já pago ou entregue: operador precisa saber (risco de MED)
    if (r.changes && (before === 'paid' || before === 'delivered')) {
      const pp = payerPrints(pay);
      blockClient({ ...o, payer_acct: o.payer_acct || pp.acct }, pay.status);
      tgMarkup(o, doneKeyboard(before === 'delivered' ? '⚠️ Estornado após entrega' : '⛔ Cancelado — não entregar'));
      tgSend(`⚠️ Pedido #${o.id} ${before === 'delivered' ? 'ESTORNADO após entrega' : 'cancelado após pagamento'} (${pay.status})\n${o.prod_nome || o.product} · ${brlTxt(o.cents)}\n${o.nickname} · ID ${o.game_id}\nBloqueados: ID, e-mail, aparelho e conta que pagou (desbloqueie no painel se for engano).`);
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
function paidKeyboard(o) {
  const rows = [];
  const url = donateLink(o);
  if (url) rows.push([{ text: `🎮 Abrir entrega · ${starsOf(o)}★`, url }]);
  if (canAutopay(o).ok) rows.push([{ text: `⭐ Pagar ${starsOf(o)}★ e entregar`, callback_data: `p:${o.id}` }]);
  rows.push([{ text: '✅ Já entreguei', callback_data: `d:${o.id}` }]);
  return { inline_keyboard: rows };
}
const doneKeyboard = (label) => ({ inline_keyboard: [[{ text: label, callback_data: 'x' }]] });
const hhmmSP = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
// troca os botões do aviso do pedido (se houver aviso com botões)
function tgMarkup(o, markup) {
  if (!o?.tg_msg) return;
  tgApi('editMessageReplyMarkup', { chat_id: env.TG_CHAT_ID, message_id: o.tg_msg, reply_markup: markup });
}
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
// Custo atual = média ponderada das COMPRAS mais recentes que somam o saldo atual — ou seja, quanto custaram as
// Stars que estão na conta agora. Sem compra registrada: STAR_COST_BRL.
function calcStarCost(saldo) {
  const recs = db.prepare('SELECT stars, cents FROM stars_purchases WHERE cents > 0 AND stars > 0 ORDER BY id DESC').all();
  if (!recs.length) return { cost: STAR_COST, fonte: 'padrao', recargas: 0 };
  let st = 0, c = 0, n = 0;
  for (const r of recs) { st += r.stars; c += r.cents; n++; if (st >= Math.max(saldo, 1)) break; }
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
function markDelivered(id, via) {
  const r = db.prepare("UPDATE orders SET status='delivered', delivered_at=CURRENT_TIMESTAMP WHERE id=? AND status='paid'").run(id);
  if (!r.changes) return false;
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
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
  tgMarkup(o, doneKeyboard(`✅ Entregue às ${hhmmSP()}${via === 'painel' ? ' (painel)' : via === 'auto' ? ' (pago no bot)' : ''}`));
  return true;
}
async function handleTgUpdate(u) {
  const cq = u.callback_query;
  if (!cq) return;
  const answer = (text, alert = false) => tgApi('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: alert });
  // só o operador, no chat do operador
  if (String(cq.from?.id) !== String(env.TG_CHAT_ID) || String(cq.message?.chat?.id) !== String(env.TG_CHAT_ID)) {
    return answer('Sem permissão.');
  }
  const m = /^([dDbpP]):(\d+)$/.exec(cq.data || '');
  if (!m) return answer('Nada a fazer aqui.');
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(m[2]));
  if (!o) return answer('Pedido não encontrado.');
  const msgId = cq.message.message_id;
  const setKb = (kb) => tgApi('editMessageReplyMarkup', { chat_id: env.TG_CHAT_ID, message_id: msgId, reply_markup: kb });
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
  if (m[1] === 'P') {
    await answer('Pagando… (até ~30 s)');
    await setKb(doneKeyboard('⏳ Pagando…'));
    const r = await autopay(o.id);
    if (r.ok) {
      tgSend(`⭐ Pedido #${o.id} pago no bot (${r.stars}★) e marcado como entregue.${r.botReply ? '\nBot do CF: ' + r.botReply : ''}\n${saldoLine()}`);
    } else {
      const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
      if (cur.status === 'paid' && cur.autopay !== 'incerto') await setKb(paidKeyboard(cur));
      else if (cur.autopay === 'incerto') await setKb(doneKeyboard('🚨 Pagamento incerto — confira'));
      if (!r.incerto) tgSend(`⚠️ Pedido #${o.id}: ${r.why}`);
    }
    return;
  }
  // D: confirmado
  markDelivered(o.id, 'telegram');
  if (!o.tg_msg || o.tg_msg !== msgId) await setKb(doneKeyboard(`✅ Entregue às ${hhmmSP()}`));
  return answer(`Pedido #${o.id} entregue. E-mail enviado ao cliente.`);
}
let tgOffset = 0;
async function tgPoll() {
  for (;;) {
    const j = await tgApi('getUpdates', { offset: tgOffset, timeout: 50, allowed_updates: ['callback_query'] }, 60000);
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
async function notifyPaid(o) {
  const j = await tgApi('sendMessage', { chat_id: env.TG_CHAT_ID, disable_web_page_preview: true, reply_markup: paidKeyboard(o), text: paidText(o) });
  const mid = j?.result?.message_id;
  if (mid) db.prepare('UPDATE orders SET tg_msg=? WHERE id=?').run(mid, o.id);
  conferir(o.id, true); // em segundo plano: lê a fatura no bot do CF; no modo automático, paga em seguida
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
const AUTOPAY_MAX = Number(env.AUTOPAY_MAX_STARS ?? 1000);   // ★ por pedido
const AUTOPAY_DAY = Number(env.AUTOPAY_DAY_STARS ?? 4000);   // ★ em 24h
const getSetting = (k, d) => db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v ?? d;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
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
  if (!autopayOn()) return { ok: false, why: 'pagamento automático desligado' };
  if (sessionDown(REAL.err)) return { ok: false, why: 'sessão da conta separada caiu — refaça o login' };
  if (o.status !== 'paid') return { ok: false, why: 'pedido não está aguardando entrega' };
  if (o.autopay && o.autopay !== 'erro') return { ok: false, why: o.autopay === 'incerto' ? 'pagamento anterior incerto — confira antes' : 'já pago/pagando' };
  const ck = chkOf(o);
  if (ck?.status !== 'ok') return { ok: false, why: 'conferência no bot ainda não deu ✅' };
  const risk = riskOf(o);
  if (risk.length) return { ok: false, why: 'pedido em REVISAR — pague na mão' };
  const st = starsOf(o);
  if (st > AUTOPAY_MAX) return { ok: false, why: `acima do teto por pedido (${AUTOPAY_MAX}★)` };
  if (autopay24() + st > AUTOPAY_DAY) return { ok: false, why: `teto de ${AUTOPAY_DAY}★ em 24h atingido` };
  const sal = starsEff();
  if (sal.n && sal.s < st) return { ok: false, why: `saldo insuficiente (${sal.s}★)` };
  return { ok: true };
}
async function autopay(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return { ok: false, why: 'pedido não encontrado' };
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
    markDelivered(id, 'auto');
    syncStarsReal(true);
    return { ok: true, ...r };
  } catch (e) {
    const msg = String(e?.errorMessage || e?.message || e).slice(0, 160);
    if (e?.safe) { save('erro', { erro: msg }); return { ok: false, why: 'não pagou: ' + msg }; }
    save('incerto', { erro: msg });
    tgSend(`🚨 Pagamento INCERTO do pedido #${id} (${starsOf(o)}★): ${msg}\nResolva pelo painel: no pedido, toque em "🔍 verificar cobrança" (a loja confere se a fatura exata deste pedido tem recibo). A loja não vai tentar de novo sozinha.`);
    return { ok: false, why: 'pagamento incerto: ' + msg, incerto: true };
  }
}
// pagamento que estava em andamento quando a loja caiu: nunca repete, vira incerto
for (const o of db.prepare("SELECT id FROM orders WHERE autopay='paying'").all()) {
  db.prepare("UPDATE orders SET autopay='incerto', autopay_info=? WHERE id=?").run(JSON.stringify({ erro: 'loja reiniciou durante o pagamento' }), o.id);
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
    tgSend(`🖐 Entrega MANUAL necessária ${head}\n${ck ? chkLine(ck) : 'sem conferência'}\n${saldoLine()}`);
    return;
  }
  const can = canAutopay(o);
  if (!can.ok) { tgSend(`🖐 Entrega MANUAL necessária ${head}\nMotivo: ${can.why}\n${saldoLine()}`); return; }
  const r = await autopay(id);
  // recusado ANTES de cobrar por motivo passageiro (bot lento, flood, rede): tenta de novo 1x
  if (!r.ok && !r.incerto && attempt < 2 && transient(r.why)) {
    db.prepare("UPDATE orders SET autopay_info=json_set(COALESCE(autopay_info,'{}'),'$.retry',1) WHERE id=?").run(id);
    const t = setTimeout(() => entregaAuto(id, attempt + 1), RETRY_MS); t.unref?.(); return;
  }
  await syncStarsReal(true);
  if (r.ok) tgSend(`✅ Entregue automaticamente ${head}${r.botReply ? '\nBot do CF: ' + r.botReply : ''}\n${saldoLine()}`);
  else if (r.incerto) tgSend(`🚨 Entrega automática INCERTA ${head} — veja o alerta acima.\n${saldoLine()}`);
  else tgSend(`⚠️ Entrega automática falhou ${head}\nMotivo: ${r.why}\nEntregue manualmente.\n${saldoLine()}`);
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
async function expirePending() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM orders WHERE status='pending' AND (
      (expires_at IS NOT NULL AND expires_at < ?) OR
      (expires_at IS NULL AND created_at < datetime('now','-35 minutes'))) LIMIT 50`).all(now - 5 * 60_000);
  for (const o of rows) {
    try { if (o.mp_id) await syncPayment(o.mp_id); } catch (e) { console.error('expirePending sync', o.id, e.message); continue; }
    db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'").run(o.id);
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

// ---------- Telegram (bot do operador) ----------
// Mesmo bot do backup. Falha de envio nunca derruba a loja: só registra no log.
// Chamada genérica à API do bot; devolve o JSON ou null (nunca lança).
async function tgApi(method, body, timeoutMs = 10000) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    // "message is not modified" = conferência repetida com o mesmo resultado; não é erro
    if (!r.ok && !/not modified/.test(j?.description || '')) console.error('Telegram', method, r.status, j?.description || '');
    return j;
  } catch (e) { if (method !== 'getUpdates') console.error('Falha Telegram', method, e.message); return null; }
}
async function tgSend(text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (!r.ok) console.error('Telegram respondeu', r.status);
    return r.ok;
  } catch (e) { console.error('Falha ao enviar Telegram:', e.message); return false; }
}

// ---------- E-mail ao cliente (Resend, API HTTP — sem dependência nova) ----------
// Desligado enquanto RESEND_API_KEY não estiver no .env. Falha de envio nunca quebra o fluxo.
// Remetente: MAIL_FROM (padrão pedidos@recargaflame.com.br); respostas vão para MAIL_REPLY_TO (suporte@…).
const MAIL_FROM = env.MAIL_FROM || 'pedidos@recargaflame.com.br';
const MAIL_REPLY_TO = env.MAIL_REPLY_TO || 'suporte@recargaflame.com.br';
async function sendMail(to, subject, html, text, replyTo = MAIL_REPLY_TO) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Recarga Flame <${MAIL_FROM}>`, reply_to: replyTo,
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
const SESSION_TTL = 12 * 3600_000; // 12h
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
  const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE id_hash=?').get(hashHex(tok));
  return !!row && row.expires_at > Date.now();
}
const cookieAttrs = () => `Path=/; HttpOnly; SameSite=Strict${env.NODE_ENV === 'test' ? '' : '; Secure'}`;

setInterval(() => {
  const now = Date.now();
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now);
  for (const [id, c] of challenges) if (c.exp < now) challenges.delete(id);
}, 10 * 60_000).unref();

function admin(req, res, next) {
  if (sessionOk(req)) return next();
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
app.use(express.static('public'));
// páginas institucionais (também em /como-funciona.html e /perguntas-frequentes.html)
app.get('/como-funciona', (req, res) => res.sendFile('como-funciona.html', { root: 'public' }));
app.get('/perguntas-frequentes', (req, res) => res.sendFile('perguntas-frequentes.html', { root: 'public' }));
app.get('/suporte', (req, res) => res.sendFile('suporte.html', { root: 'public' }));
app.get('/termos-de-uso', (req, res) => res.sendFile('termos-de-uso.html', { root: 'public' }));
app.get('/politica-de-privacidade', (req, res) => res.sendFile('politica-de-privacidade.html', { root: 'public' }));
app.use('/api', limit(120));

app.get('/api/products', (req, res) => {
  res.json(Object.entries(PRODUCTS)
    .filter(([, p]) => p.ativo)
    .map(([key, p]) => ({ key, nome: p.nome, cents: p.cents, stars: p.stars, cat: categoria(p), img: p.img || `/img/${key}.jpg` })));
});

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

app.get('/api/player/:id/avatar', limit(30), async (req, res) => {
  if (!validId(req.params.id)) return res.sendStatus(400);
  try {
    const r = await fetch(`${CF_BASE}/api/users/${req.params.id}/avatar`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.sendStatus(404);
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(buf);
  } catch { res.sendStatus(404); }
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
  if (req.query.full !== '1') return res.json({ status: o.status, entrega });
  // Dados para reabrir o pedido pelo link (quem tem o token = dono do pedido).
  // Nunca devolve e-mail. QR só enquanto o Pix pode ser pago.
  const pending = o.status === 'pending';
  res.json({
    status: o.status, entrega, id: o.id, product: o.product, nome: o.prod_nome || PRODUCTS[o.product]?.nome || o.product,
    cents: o.cents, gameId: o.game_id, nick: o.nickname,
    avatar: `/api/player/${encodeURIComponent(o.game_id)}/avatar`,
    img: PRODUCTS[o.product]?.img || `/img/${o.product}.jpg`,
    expiresAt: o.expires_at || null,
    qr: pending ? o.qr || null : null, qrBase64: pending ? o.qr_b64 || null : null,
  });
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

// Passo 2: código. Certo → cria sessão (cookie HttpOnly/Secure/SameSite=Strict, 12h).
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
      blocked: ['cancelled', 'reversed'].includes(o.status) && o.paid_at ? orderBlocked(o) : false,
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
  const compras = db.prepare('SELECT * FROM stars_purchases ORDER BY id DESC LIMIT 20').all()
    .map((p) => ({ id: p.id, stars: p.stars, cents: p.cents, nota: p.nota || '', data: fmtD(p.created_at), unit: p.cents / p.stars / 100 }));
  return { configurado: n > 0, saldo, fila: starsFila(), low: STARS_LOW, movs,
    custoMedio: c.st ? c.c / c.st / 100 : null, custoConfig: STAR_COST, custoAtual: STAR_NOW, custoFonte: STAR_INFO.fonte, compras,
    real: realOn() ? { ativo: real, at: REAL.at || null, err: REAL.err, manual: starsSaldo().s } : null,
    autopay: chkOn() ? { on: autopayOn(), mode: autopayMode(), max: AUTOPAY_MAX, dia: AUTOPAY_DAY, usado24h: autopay24() } : null };
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
app.post('/api/admin/orders/:id/autopay', admin, async (req, res) => {
  if (!guard(req, res)) return;
  const r = await autopay(Number(req.params.id));
  res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: r.why });
});
// ---------- Resumo diário no Telegram (23h, horário de Brasília) ----------
const SUMMARY_HOUR = Number(env.SUMMARY_HOUR ?? 23);
const spDay = (ms = Date.now()) => new Date(ms - 3 * 3600_000).toISOString().slice(0, 10); // dia local (UTC-3)
function dailySummary(day = spDay()) {
  const L = (col) => `date(${col}, '-3 hours')`;
  const vendas = db.prepare(`SELECT o.*, o.com_pct AS comissao_pct FROM orders o
    WHERE o.paid_at IS NOT NULL AND o.status IN ('paid','delivered') AND ${L('o.paid_at')} = ?`).all(day);
  let fat = 0, lucro = 0;
  for (const o of vendas) {
    const l = orderProfit(o);
    fat += o.cents; lucro += l - (o.coupon ? Math.max(0, l) * ((o.comissao_pct || 0) / 100) : 0);
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
  } else return res.status(400).json({ error: 'Ação inválida.' });
  res.json({ ok: true });
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
  unblockClient(o);
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
    .map((r) => ({ ...r, ativo: !!r.ativo, img: r.img || `/img/${r.key}.jpg` }));
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

// ---- Cupons (painel) ----
function parseCoupon(b, codeFixed) {
  const code = normCode(codeFixed ?? b.code);
  const desconto = Number(b.desconto_pct);
  const comissao = Number(b.comissao_pct);
  if (!validCode(code)) return { err: 'Código inválido (A-Z, 0-9, _ ou -, 3 a 20 caracteres).' };
  if (!Number.isFinite(desconto) || desconto < 0 || desconto > 50) return { err: 'Desconto deve ser de 0 a 50%.' };
  if (!Number.isFinite(comissao) || comissao < 0 || comissao > 100) return { err: 'Comissão deve ser de 0 a 100% do lucro.' };
  return { code, desconto_pct: desconto, comissao_pct: comissao, ativo: b.ativo ? 1 : 0, nota: String(b.nota || '').trim().slice(0, 80) };
}
app.get('/api/admin/coupons', admin, (req, res) => {
  res.json(db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all().map((c) => ({ ...c, ativo: !!c.ativo })));
});
app.post('/api/admin/coupons', admin, (req, res) => {
  if (!guard(req, res)) return;
  const c = parseCoupon(req.body ?? {});
  if (c.err) return res.status(400).json({ error: c.err });
  if (db.prepare('SELECT 1 FROM coupons WHERE code=?').get(c.code)) return res.status(409).json({ error: 'Já existe um cupom com esse código.' });
  db.prepare('INSERT INTO coupons (code, desconto_pct, comissao_pct, ativo, nota) VALUES (?,?,?,?,?)').run(c.code, c.desconto_pct, c.comissao_pct, c.ativo, c.nota);
  res.json({ ok: true });
});
app.put('/api/admin/coupons/:code', admin, (req, res) => {
  if (!guard(req, res)) return;
  if (!db.prepare('SELECT 1 FROM coupons WHERE code=?').get(normCode(req.params.code))) return res.status(404).json({ error: 'Cupom não encontrado.' });
  const c = parseCoupon(req.body ?? {}, req.params.code);
  if (c.err) return res.status(400).json({ error: c.err });
  db.prepare('UPDATE coupons SET desconto_pct=?, comissao_pct=?, ativo=?, nota=? WHERE code=?').run(c.desconto_pct, c.comissao_pct, c.ativo, c.nota, c.code);
  res.json({ ok: true });
});
// Relatório: só pedidos pagos/entregues (cancelado/estornado não gera comissão).
// Período (datas locais, ex.: ?from=2026-11-01&to=2026-11-30) vale para os números de venda;
// ganho total, já pago e saldo são sempre de todo o histórico.
const localDay = (t) => new Date(new Date(t.replace(' ', 'T') + 'Z').getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const comOf = (o) => Math.max(0, orderProfit(o)) * ((o.com_pct || 0) / 100);
app.get('/api/admin/coupons/report', admin, (req, res) => {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = re.test(req.query.from || '') ? req.query.from : '0000-01-01';
  const to = re.test(req.query.to || '') ? req.query.to : '9999-12-31';
  const pctNow = Object.fromEntries(db.prepare('SELECT code, comissao_pct FROM coupons').all().map((c) => [c.code, c.comissao_pct]));
  const by = {};
  const get = (code) => (by[code] ||= { code, comissao_pct: pctNow[code] ?? 0, pedidos: 0, faturado: 0, desconto: 0, lucro: 0, comissao: 0, total: 0, pago: 0, pagamentos: [] });
  const rows = db.prepare(`SELECT * FROM orders WHERE coupon IS NOT NULL AND status IN ('paid','delivered') AND paid_at IS NOT NULL`).all();
  for (const o of rows) {
    const r = get(o.coupon);
    const c = comOf(o);
    r.total += c;
    const d = localDay(o.paid_at);
    if (d < from || d > to) continue;
    r.pedidos++; r.faturado += o.cents; r.desconto += o.discount_cents || 0;
    r.lucro += orderProfit(o); r.comissao += c;
  }
  for (const p of db.prepare('SELECT * FROM coupon_payouts ORDER BY paid_at DESC, id DESC').all()) {
    const r = get(p.code);
    r.pago += p.cents;
    r.pagamentos.push({ id: p.id, cents: p.cents, nota: p.nota || '', data: localDay(p.paid_at) });
  }
  const list = Object.values(by).map((r) => {
    const total = Math.round(r.total);
    return { ...r, lucro: Math.round(r.lucro), comissao: Math.round(r.comissao), total, saldo: total - r.pago };
  });
  res.json({ from, to, cupons: list.sort((a, b) => b.saldo - a.saldo || b.faturado - a.faturado) });
});
app.post('/api/admin/coupons/:code/payouts', admin, (req, res) => {
  if (!guard(req, res)) return;
  const code = normCode(req.params.code);
  if (!db.prepare('SELECT 1 FROM coupons WHERE code=?').get(code)) return res.status(404).json({ error: 'Cupom não encontrado.' });
  const cents = Math.round(Number(req.body?.cents));
  if (!Number.isInteger(cents) || cents <= 0 || cents > 10_000_000) return res.status(400).json({ error: 'Valor inválido.' });
  const nota = String(req.body?.nota || '').trim().slice(0, 80);
  const r = db.prepare('INSERT INTO coupon_payouts (code, cents, nota) VALUES (?,?,?)').run(code, cents, nota);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
app.delete('/api/admin/payouts/:id', admin, (req, res) => {
  if (!guard(req, res)) return;
  const r = db.prepare('DELETE FROM coupon_payouts WHERE id=?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Pagamento não encontrado.' });
  res.json({ ok: true });
});

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
  let faturado = 0, lucro = 0, comissao = 0, stars = 0, comCupom = 0;
  const byDay = {}, byProd = {};
  for (const o of ok) {
    const l = orderProfit(o);
    const c = o.coupon ? Math.max(0, l) * ((o.comissao_pct || 0) / 100) : 0;
    faturado += o.cents; lucro += l; comissao += c; stars += o.prod_stars || 0;
    if (o.coupon) comCupom++;
    const d = new Date(new Date(o.paid_at.replace(' ', 'T') + 'Z').getTime() - 3 * 3600_000).toISOString().slice(0, 10);
    const day = (byDay[d] ||= { date: d, n: 0, cents: 0 }); day.n++; day.cents += o.cents;
    const nome = o.prod_nome || o.product;
    const pr = (byProd[nome] ||= { nome, n: 0, cents: 0 }); pr.n++; pr.cents += o.cents;
  }
  const gen = db.prepare(`SELECT COUNT(*) n, SUM(paid_at IS NOT NULL) pagos FROM orders
    WHERE mp_id IS NOT NULL AND ${local('created_at')} BETWEEN ? AND ?`).get(from, to);
  // entrega: minutos entre pago e entregue
  const mins = ok.filter((o) => o.delivered_at)
    .map((o) => (new Date(o.delivered_at.replace(' ', 'T') + 'Z') - new Date(o.paid_at.replace(' ', 'T') + 'Z')) / 60000)
    .sort((x, y) => x - y);
  const mediana = mins.length ? mins[Math.floor((mins.length - 1) / 2)] : null;
  res.json({
    from, to,
    vendas: ok.length, faturado, ticket: ok.length ? Math.round(faturado / ok.length) : 0,
    lucro: Math.round(lucro - comissao), comissao: Math.round(comissao), stars, comCupom,
    estornos: sold.length - ok.length,
    pixGerados: gen.n || 0, pixPagos: gen.pagos || 0,
    entregas: mins.length, entregaMedianaMin: mediana == null ? null : Math.round(mediana),
    entregaAte1h: mins.length ? mins.filter((m) => m <= 60).length / mins.length : null,
    porDia: Object.values(byDay).sort((x, y) => x.date.localeCompare(y.date)),
    produtos: Object.values(byProd).sort((x, y) => y.cents - x.cents),
  });
});

// Link curto de cupom para divulgação: /aquila → /?cupom=AQUILA (só cupom ATIVO; senão segue para o 404).
// Fica por último entre as rotas: /painel, /suporte etc. são resolvidos antes.
app.get('/:code', (req, res, next) => {
  const c = normCode(req.params.code);
  if (!validCode(c) || !getCoupon(c)) return next();
  res.redirect(302, '/?cupom=' + encodeURIComponent(c));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente.' });
});

// Sobe o servidor só quando executado diretamente (não durante os testes).
if (process.env.NODE_ENV !== 'test') {
  // Só aceita conexões da própria máquina (nginx). Ninguém fala com o Node direto,
  // mesmo se o firewall mudar — assim não dá pra forjar X-Forwarded-For e burlar rate limits.
  app.listen(env.PORT || 3000, '127.0.0.1', () => console.log('Loja no ar'));
  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) tgPoll(); // botões do aviso de pago
  if (realOn()) { syncStarsReal(true); setInterval(() => syncStarsReal(true), 5 * 60_000); } // saldo real a cada 5 min
  setInterval(summaryTick, 60_000); // resumo diário às SUMMARY_HOUR (23h)
}

refreshStarCost(false); // custo por Star a partir das recargas (depois de tudo declarado)

export { app, db, RISK, refreshStarCost, handleTgUpdate, entregaState, dailySummary, summaryTick, _setReceiptChecker, _setStarsReader, _setInvoiceChecker, _setInvoicePayer, conferir, autopay, syncStarsReal, loadProducts, PRODUCTS, adminFails, challenges, expirePending, deliveredEmail, sendMail, floorCents, profitCents };
