import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import { userConfig, readStarsBalance, checkInvoice, payInvoice, invoicePaid } from './tg-user.js';

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
const STAR_COST = Number(env.STAR_COST_BRL || 0.0875); // R$ por Star
const MP_FEE = Number(env.MP_FEE_PCT || 0.99) / 100;   // taxa do Pix no MP
const costCents = (stars) => stars * STAR_COST * 100;
// menor preço que ainda cobre Stars + taxa do MP: final*(1-fee) >= custo
const floorCents = (stars) => Math.ceil(costCents(stars) / (1 - MP_FEE));
const profitCents = (cents, stars) => cents - costCents(stars) - cents * MP_FEE;
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
for (const col of ['device TEXT', 'ip_h TEXT', 'payer_doc TEXT', 'payer_acct TEXT', 'tg_msg INTEGER', 'chk TEXT', 'autopay TEXT', 'autopay_info TEXT', 'autopay_at INTEGER']) {
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
// operador registra recargas e "confere o saldo" de vez em quando (gera ajuste da diferença).
db.exec(`CREATE TABLE IF NOT EXISTS stars_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- recarga | ajuste | entrega
  delta INTEGER NOT NULL,        -- + entra, − sai
  cents INTEGER,                 -- recarga: quanto custou (opcional)
  order_id INTEGER UNIQUE,       -- entrega: 1 desconto por pedido
  nota TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
const STARS_LOW = Number(env.STARS_LOW ?? 500); // abaixo disso: aviso de saldo baixo
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
async function sendMail(to, subject, html, text) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Recarga Flame <${MAIL_FROM}>`, reply_to: MAIL_REPLY_TO,
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
    'Algum problema? Responda este e-mail ou fale no WhatsApp +55 11 95299-7031 / Telegram @kazenn7.', '',
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
<tr><td style="padding:0 22px 22px;color:#6c6c74;font-size:12.5px;line-height:1.5">Algum problema? Responda este e-mail ou fale com a gente no
<a href="https://wa.me/5511952997031" style="color:#9b9ba3">WhatsApp</a> ou <a href="https://t.me/kazenn7" style="color:#9b9ba3">Telegram</a>.<br><br>
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

const LOGIN_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0e0e10">
<meta name="robots" content="noindex"><title>Entrar — Painel Recarga Flame</title><link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png"><link rel="icon" type="image/png" sizes="192x192" href="/img/icon-192.png"><link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<style>
:root{--bg:#0e0e10;--panel:#161618;--line:#2a2a2e;--txt:#f4f4f5;--mut:#9b9ba3;--orange:#ff5a1f;--red:#f85149}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--txt);font:15px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;padding:16px}
.box{width:100%;max-width:360px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px 20px}
.mark{width:40px;height:40px;border-radius:9px;display:block;margin-bottom:14px}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 18px;color:var(--mut);font-size:13.5px}
label{display:block;font-size:12.5px;color:var(--mut);margin:12px 0 5px}
input{width:100%;padding:12px;border:1px solid var(--line);background:var(--bg);color:var(--txt);border-radius:9px;font:inherit}
input:focus{outline:0;border-color:#45454c}#code{font-size:24px;letter-spacing:.4em;text-align:center;font-family:ui-monospace,Menlo,monospace}
button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:9px;background:var(--orange);color:#160a04;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.5}.link{background:transparent;color:var(--mut);margin-top:8px;font-weight:600}
.err{color:var(--red);font-size:13px;min-height:18px;margin:12px 0 0;text-align:center}.hide{display:none}
</style></head><body><div class="box"><img class="mark" src="/img/brand-mark.png" alt="" width="40" height="40">
<form id="f1"><h1>Painel</h1><p>Entre com usuário e senha.</p>
<label for="user">Usuário</label><input id="user" autocomplete="username" required>
<label for="pass">Senha</label><input id="pass" type="password" autocomplete="current-password" required>
<button id="b1">Continuar</button></form>
<form id="f2" class="hide"><h1>Código de acesso</h1><p>Enviamos um código de 6 dígitos pelo Telegram. Ele vale 5 minutos.</p>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
<button id="b2">Entrar</button><button type="button" class="link" id="again">Voltar e reenviar</button></form>
<p class="err" id="err"></p></div>
<script>
const $=id=>document.getElementById(id);let ch=null;
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});let j={};try{j=await r.json();}catch{}return{ok:r.ok,j};}
function step(n){$('f1').classList.toggle('hide',n!==1);$('f2').classList.toggle('hide',n!==2);(n===1?$('pass'):$('code')).focus();}
$('f1').onsubmit=async e=>{e.preventDefault();$('err').textContent='';$('b1').disabled=true;
  const{ok,j}=await post('/login/senha',{user:$('user').value,pass:$('pass').value});$('b1').disabled=false;
  if(!ok){$('err').textContent=j.error||'Erro.';return;}ch=j.challenge;$('code').value='';step(2);};
$('f2').onsubmit=async e=>{e.preventDefault();$('err').textContent='';$('b2').disabled=true;
  const{ok,j}=await post('/login/codigo',{challenge:ch,code:$('code').value});$('b2').disabled=false;
  if(ok){location.href='/painel';return;}$('err').textContent=j.error||'Erro.';if(j.restart){$('pass').value='';step(1);}};
$('again').onclick=()=>{$('err').textContent='';step(1);};
</script></body></html>`;

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
      coupon, list_cents, discount_cents, com_pct, device, ip_h) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(token, product, finalCents, String(gameId), player.nickname, email, p.nome, p.stars, p.code,
      coupon?.code || null, p.cents, p.cents - finalCents, coupon ? coupon.comissao_pct : null, device, fp('ip:' + req.ip));

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
  // custo médio real das recargas com valor informado (para comparar com STAR_COST_BRL)
  const c = db.prepare("SELECT SUM(delta) st, SUM(cents) c FROM stars_ledger WHERE kind='recarga' AND cents > 0").get();
  return { configurado: n > 0, saldo, fila: starsFila(), low: STARS_LOW, movs,
    custoMedio: c.st ? c.c / c.st / 100 : null, custoConfig: STAR_COST,
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
  if (b.kind === 'recarga') {
    const st = int(b.stars);
    if (!(st > 0 && st <= 1_000_000)) return res.status(400).json({ error: 'Quantidade de Stars inválida.' });
    const cents = b.cents == null || b.cents === '' ? null : Math.round(Number(b.cents));
    if (cents != null && !(cents >= 0 && cents <= 100_000_000)) return res.status(400).json({ error: 'Valor inválido.' });
    db.prepare("INSERT INTO stars_ledger (kind, delta, cents, nota) VALUES ('recarga', ?, ?, ?)").run(st, cents, nota);
  } else if (b.kind === 'ajuste') {
    const real = int(b.saldo_real);
    if (!(real >= 0 && real <= 10_000_000)) return res.status(400).json({ error: 'Saldo inválido.' });
    const { s: atual, n } = starsSaldo();
    if (real === atual && n) return res.json({ ok: true, delta: 0 });
    db.prepare("INSERT INTO stars_ledger (kind, delta, nota) VALUES ('ajuste', ?, ?)").run(real - atual, nota || (n ? 'conferência' : 'saldo inicial'));
  } else return res.status(400).json({ error: 'Tipo inválido.' });
  res.json({ ok: true, saldo: starsSaldo().s });
});
app.delete('/api/admin/stars/:id', admin, (req, res) => {
  if (!guard(req, res)) return;
  // entregas não se apagam por aqui (corrija com "conferir saldo")
  const r = db.prepare("DELETE FROM stars_ledger WHERE id=? AND kind IN ('recarga','ajuste')").run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Movimento não encontrado (entregas não podem ser apagadas).' });
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
    const l = profitCents(o.cents, o.prod_stars || 0);
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

  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0e0e10">
<meta name="format-detection" content="telephone=no"><meta name="format-detection" content="date=no,address=no,email=no">
<title>Painel — Recarga Flame</title><link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png"><link rel="icon" type="image/png" sizes="192x192" href="/img/icon-192.png"><link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<style>
:root{--bg:#0e0e10;--panel:#161618;--panel2:#1c1c1f;--line:#2a2a2e;--txt:#f4f4f5;--mut:#9b9ba3;--dim:#6c6c74;--orange:#ff5a1f;--green:#3fb950;--red:#f85149;--gold:#e3b341;--blue:#4493f8}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{font:15px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;margin:0;background:var(--bg);color:var(--txt)}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
header{position:sticky;top:0;z-index:9;background:rgba(14,14,16,.95);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.htop{display:flex;align-items:center;gap:10px;padding:14px 16px}
.mark{width:26px;height:26px;border-radius:6px;display:block}
.htop b{font-size:15px}.htop .rf{margin-left:auto;font-size:13px;color:var(--mut);background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:6px 11px;cursor:pointer}
.tabs{display:flex;gap:4px;padding:0 10px 10px;overflow-x:auto}
.tab{flex-shrink:0;border:0;background:transparent;color:var(--mut);font:inherit;font-weight:600;padding:8px 12px;border-radius:7px;cursor:pointer;white-space:nowrap}
.tab.on{background:var(--panel);color:var(--txt)}
.tab .c{display:inline-block;min-width:18px;margin-left:5px;padding:0 5px;font-size:12px;font-weight:700;border-radius:99px;background:var(--panel2);color:var(--mut)}
.tab.on .c{background:var(--orange);color:#160a04}
.search{padding:10px 16px}.search input{width:100%;padding:10px 13px;border:1px solid var(--line);background:var(--panel);color:var(--txt);border-radius:8px;font:inherit}
.search input::placeholder{color:var(--dim)}.search input:focus{outline:0;border-color:#45454c}
main{max-width:620px;margin:0 auto;padding:6px 16px 48px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:14px;margin-bottom:11px}
.chead{display:flex;align-items:center;gap:7px;margin-bottom:11px}
.bdg{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:3px 8px;border-radius:5px}
.bdg.pending{background:rgba(227,179,65,.14);color:var(--gold)}.bdg.paid{background:rgba(68,147,248,.14);color:var(--blue)}
.bdg.delivered{background:rgba(63,185,80,.14);color:var(--green)}.bdg.cancelled{background:rgba(155,155,163,.12);color:var(--mut)}.bdg.reversed{background:rgba(248,81,73,.14);color:var(--red)}
.oid{margin-left:auto;color:var(--dim);font-weight:700}
.body{display:flex;gap:13px}
.av{width:56px;height:56px;border-radius:9px;object-fit:cover;background:#242428;flex-shrink:0}
.info{min-width:0;flex:1}.info .pn{font-weight:700;font-size:15px}
.info .nk{color:var(--txt);margin-top:2px}.info .meta{font-size:12.5px;color:var(--mut);margin-top:4px;word-break:break-all}
.info .meta b{color:var(--txt)}
.price{text-align:right;flex-shrink:0}.price .v{font-weight:800;font-size:16px}.price .s{font-size:11.5px;color:var(--gold);margin-top:2px}
.times{font-size:12px;color:var(--dim);margin-top:11px;padding-top:11px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:4px 14px}
.acts{display:flex;gap:8px;margin-top:11px}
.acts a,.acts button{flex:1;text-align:center;text-decoration:none;padding:11px;border-radius:8px;font:inherit;font-weight:700;cursor:pointer;border:0}
.a-tg{background:#229ED9;color:#fff}.a-ok{background:var(--green);color:#06240f}
.empty{text-align:center;color:var(--dim);padding:70px 16px}
/* nav topo */
.nav{display:flex;gap:4px;padding:0 10px}
.nav button{flex:1;border:0;background:transparent;color:var(--mut);font:inherit;font-weight:700;padding:12px;border-bottom:2px solid transparent;cursor:pointer}
.nav button.on{color:var(--txt);border-bottom-color:var(--orange)}
/* produtos */
.padd{padding:12px 16px}
.newbtn{width:100%;padding:13px;border:1px dashed var(--line);background:var(--panel);color:var(--orange);border-radius:10px;font:inherit;font-weight:700;cursor:pointer}
.prow{display:flex;gap:12px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px;margin-bottom:10px}
.prow img{width:52px;height:52px;border-radius:8px;object-fit:cover;background:#242428;flex-shrink:0}
.prow .pi{flex:1;min-width:0}.prow .pi .nm{font-weight:700}.prow .pi .sub{font-size:12.5px;color:var(--mut);margin-top:2px;word-break:break-all}
.prow .pi .sub b{color:var(--txt)}
.prow .rt{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0}
.prow .pr{font-weight:800;font-family:ui-monospace,Menlo,monospace}
.sw{position:relative;width:42px;height:24px;border-radius:99px;background:#33333a;cursor:pointer;transition:.15s;border:0;flex-shrink:0}
.sw.on{background:var(--green)}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.15s}
.sw.on::after{left:20px}
.prow .ops{display:flex;gap:6px}
.prow .ops button{border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:7px;padding:7px 11px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.prow .ops .del{color:var(--red);border-color:rgba(248,81,73,.3)}
.pinact{opacity:.55}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.chips button{flex-shrink:0;border:1px solid var(--line);background:var(--panel);color:var(--mut);font:inherit;font-size:13px;font-weight:600;padding:7px 11px;border-radius:99px;cursor:pointer}
.chips button.on{background:var(--txt);color:var(--bg);border-color:var(--txt)}
#anaBody.loading{opacity:.5;transition:opacity .15s}
.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:9px;margin-bottom:12px}
@media(min-width:560px){.kpis{grid-template-columns:repeat(3,1fr)}}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:11px 12px;min-width:0}
.kpi .l{font-size:12px;color:var(--mut)}.kpi .v{font-size:20px;font-weight:700;margin-top:2px;line-height:1.2}
.kpi .s{font-size:11.5px;color:var(--dim);margin-top:3px}
.ccard{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px 12px 10px;margin-bottom:12px;position:relative}
.ccard h4{margin:0 0 2px;font-size:14px}.ccard .sub{font-size:12px;color:var(--mut);margin:0 0 8px}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.chart .col{fill:#f05420}.chart .hit{fill:transparent;cursor:pointer;outline:none}
.chart .hit:hover+.col,.chart .hit:focus+.col{fill:#ff7a4d}
.chart .grid{stroke:#2a2a2e;stroke-width:1}.chart text{fill:#9b9ba3;font-size:10.5px;font-family:inherit}
.chart .lbl{fill:#f4f4f5;font-weight:700}
.tip{position:absolute;pointer-events:none;background:#0e0e10;border:1px solid #45454c;border-radius:8px;padding:7px 9px;font-size:12px;white-space:nowrap;display:none;z-index:5}
.tip b{display:block;font-size:14px;color:var(--txt)}.tip span{color:var(--mut)}
.rank{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.rk .top{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}.rk .top span:first-child{color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk .top span:last-child{color:var(--mut);flex-shrink:0}
.rk .track{height:10px;margin-top:4px}.rk .bar{height:10px;background:#f05420;border-radius:0 4px 4px 0;min-width:2px}
.ccard details{margin-top:8px;font-size:12.5px}.ccard summary{cursor:pointer;color:var(--mut)}
.ttab{width:100%;border-collapse:collapse;margin-top:6px;font-variant-numeric:tabular-nums}
.ttab td,.ttab th{padding:5px 4px;border-top:1px solid var(--line);text-align:right}.ttab td:first-child,.ttab th:first-child{text-align:left}
.ttab th{color:var(--mut);font-weight:600}
.cuptag.off{background:rgba(248,81,73,.14);color:var(--red)}
.cuptag{display:inline-block;margin-left:7px;font-size:10.5px;font-weight:700;padding:2px 6px;border-radius:5px;background:rgba(63,185,80,.14);color:var(--green);vertical-align:2px}
.rephead{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.rephead select{background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:7px;padding:6px 9px;font:inherit;font-size:13px}
.rep{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px 14px;margin-bottom:9px}
.rep .top{display:flex;justify-content:space-between;font-weight:700}.rep .top .due{color:var(--gold)}
.rep .nums{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--mut);margin-top:6px}.rep .nums b{color:var(--txt)}
.hint{font-size:11.5px;color:var(--dim)}
.sync{font-size:11px;color:var(--dim);padding:0 14px 7px}
.htop .st{color:var(--gold);font-weight:700}.htop .st.lo{color:#160a04;background:var(--gold);border-color:var(--gold)}.htop .st.no{color:#fff;background:var(--red);border-color:var(--red)}
@media(max-width:400px){#htitle{display:none}}
.sbar{margin:10px 14px 0;padding:10px 12px;border-radius:9px;background:rgba(227,179,65,.12);border:1px solid rgba(227,179,65,.4);font-size:13px;display:flex;align-items:center;gap:10px}
.sbar span{flex:1}.sbar button{border:0;border-radius:7px;padding:7px 10px;font:inherit;font-size:13px;font-weight:700;background:var(--gold);color:#160a04;cursor:pointer}
.nost{display:inline-block;margin-left:7px;font-size:10.5px;font-weight:700;padding:2px 6px;border-radius:5px;background:rgba(227,179,65,.18);color:var(--gold);vertical-align:1px}
.serr{color:var(--red)}
.sbig{font-size:34px;font-weight:800;line-height:1.1;color:var(--gold)}.ssub{font-size:13px;color:var(--mut);margin:4px 0 14px}
.sacts{display:flex;gap:8px;margin-bottom:14px}.sacts button{flex:1;padding:11px;border-radius:9px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);font:inherit;font-weight:700;cursor:pointer}
.sacts .pri{background:var(--orange);color:#160a04;border-color:var(--orange)}
.smov{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
.smov td{padding:6px 4px;border-top:1px solid var(--line)}.smov td.n{text-align:right;font-weight:700}.smov .p{color:var(--green)}.smov .m{color:var(--mut)}
.smov .undo{background:none;border:0;color:var(--red);font:inherit;font-size:12px;cursor:pointer;padding:0}
.wait{margin-left:auto;margin-right:8px;font-size:11.5px;font-weight:700;color:var(--mut)}
.wait.w2{color:var(--gold)}.wait.w3{color:var(--red)}
#backbar{position:fixed;left:0;right:0;bottom:0;z-index:40;background:var(--panel);border-top:1px solid var(--line);padding:12px 14px calc(12px + env(safe-area-inset-bottom));display:none;box-shadow:0 -8px 24px rgba(0,0,0,.45)}
#backbar.on{display:block}#backbar p{margin:0 0 9px;font-size:14px}#backbar .bb{display:flex;gap:8px}
#backbar button{flex:1;padding:12px;border-radius:9px;border:0;font:inherit;font-weight:700;cursor:pointer}
#backbar .y{background:var(--green);color:#06240f}#backbar .n{background:var(--panel2);color:var(--mut);border:1px solid var(--line)}
.chk{margin:10px 14px 0;padding:8px 11px;border-radius:8px;font-size:12.5px;background:var(--panel2);border:1px solid var(--line);color:var(--mut)}
.chk.ok{background:rgba(63,185,80,.1);border-color:rgba(63,185,80,.35);color:var(--txt)}
.chk.diverge{background:rgba(248,81,73,.1);border-color:rgba(248,81,73,.4);color:var(--txt)}
.chk.erro{background:rgba(227,179,65,.1);border-color:rgba(227,179,65,.4);color:var(--txt)}
.a-pay{background:var(--gold);color:#160a04}
.seg{display:flex;gap:4px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:3px}
.seg button{flex:1;border:0;background:none;color:var(--mut);font:inherit;font-size:13px;font-weight:700;padding:8px 4px;border-radius:7px;cursor:pointer}
.seg button.on{background:var(--txt);color:var(--bg)}
.aprow{display:flex;align-items:center;gap:10px;margin:0 0 14px;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg)}
.aprow div{flex:1;font-size:13px}.aprow b{display:block;font-size:14px}.aprow span{color:var(--mut)}
.rechk{background:none;border:0;color:var(--blue);font:inherit;font-size:12px;cursor:pointer;padding:0;margin-left:4px}
.risk{margin:10px 14px 0;padding:9px 11px;border-radius:8px;background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.35);font-size:12.5px}
.risk b{display:block;color:var(--red);margin-bottom:2px}.risk span{display:block;color:var(--txt)}
.blk{flex:1;align-self:center;color:var(--red);font-size:13px;font-weight:700}
.a-unb{border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:9px;padding:11px 14px;font:inherit;font-weight:700;cursor:pointer}
.card.new{border-color:var(--orange);box-shadow:0 0 0 1px var(--orange) inset}
.newtag{display:inline-block;margin-left:7px;font-size:10.5px;font-weight:700;padding:2px 6px;border-radius:5px;background:var(--orange);color:#160a04;vertical-align:1px}
.rep .tot{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--mut);margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}.rep .tot b{color:var(--txt)}
.rep .ops{display:flex;gap:6px;margin-top:10px}
.rep .ops button{border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:7px;padding:7px 11px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.rep .top .ok{color:var(--green)}
.rep details{margin-top:8px;font-size:12.5px}.rep summary{cursor:pointer;color:var(--mut)}
.rep .undo{background:none;border:0;color:var(--red);font:inherit;font-size:12px;cursor:pointer;padding:0}
/* modal */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:flex-end;justify-content:center;z-index:50}
.modal.on{display:flex}
.sheet{background:var(--panel);border:1px solid var(--line);border-radius:16px 16px 0 0;width:100%;max-width:560px;max-height:92vh;overflow:auto;padding:20px 18px calc(20px + env(safe-area-inset-bottom))}
.sheet h3{margin:0 0 16px;font-size:17px}
.fg{margin-bottom:13px}.fg label{display:block;font-size:12.5px;color:var(--mut);margin-bottom:5px}
.fg input,.fg select{width:100%;padding:11px 12px;border:1px solid var(--line);background:var(--bg);color:var(--txt);border-radius:8px;font:inherit}
.fg input:focus,.fg select:focus{outline:0;border-color:#45454c}
.fg .hint{font-size:11.5px;color:var(--dim);margin-top:4px}
.frow{display:flex;gap:11px}.frow .fg{flex:1}
.fchk{display:flex;align-items:center;gap:10px;margin:4px 0 16px}
.fchk span{font-size:14px}
.mbtns{display:flex;gap:9px;margin-top:6px}
.mbtns button{flex:1;padding:13px;border:0;border-radius:9px;font:inherit;font-weight:700;cursor:pointer}
.mbtns .save{background:var(--orange);color:#160a04}.mbtns .cancel{background:var(--panel2);color:var(--mut);border:1px solid var(--line)}
.merr{color:var(--red);font-size:13px;margin-top:10px;min-height:16px;text-align:center}
</style></head><body>
<header>
  <div class="htop"><img class="mark" src="/img/brand-mark.png" alt="" width="26" height="26"><b id="htitle">Painel</b><button class="rf st" id="stBtn" onclick="openStars()" title="Saldo de Stars">★ …</button><button class="rf" id="rfBtn" style="margin-left:6px" onclick="refreshView()">Atualizar</button><button class="rf" style="margin-left:6px" onclick="fetch('/logout',{method:'POST'}).then(()=>location.href='/login')">Sair</button></div>
  <div class="nav">
    <button id="navPed" class="on" onclick="setView('pedidos')">Pedidos</button>
    <button id="navProd" onclick="setView('produtos')">Produtos</button>
    <button id="navCup" onclick="setView('cupons')">Cupons</button>
    <button id="navAna" onclick="setView('analytics')">Analytics</button>
  </div>
  <div id="hdrPed">
    <div class="tabs" id="tabs"></div>
    <div class="search"><input id="q" placeholder="Buscar por nick, ID ou nº do pedido…" autocomplete="off"></div>
    <div class="sync" id="sync">Atualiza sozinho a cada 15 s</div>
  </div>
</header>
<div id="sbarBox"></div>
<main id="viewPed"></main>
<div class="modal" id="smodal">
  <div class="sheet">
    <h3>Saldo de Stars</h3>
    <div id="sBody"><div class="empty">Carregando…</div></div>
    <div class="mbtns"><button class="cancel" onclick="closeStars()">Fechar</button></div>
  </div>
</div>
<div id="backbar" role="dialog" aria-live="polite"><p id="bbtxt"></p><div class="bb"><button class="n" onclick="closeBack()">Ainda não</button><button class="y" onclick="yesBack()">✅ Sim, marcar entregue</button></div></div>
<main id="viewAna" style="display:none">
  <div class="padd">
    <div class="chips" id="anaPer" role="group" aria-label="Período">
      <button data-p="d0">Hoje</button><button data-p="d7">7 dias</button><button data-p="d30" class="on">30 dias</button>
      <button data-p="m0">Este mês</button><button data-p="m1">Mês passado</button><button data-p="all">Tudo</button>
    </div>
    <div id="anaBody"><div class="empty">Carregando…</div></div>
  </div>
</main>
<main id="viewCup" style="display:none">
  <div class="padd">
    <div class="rephead"><b>Comissões</b><select id="repPer" onchange="loadRep()"><option value="m0">Este mês</option><option value="m1">Mês passado</option><option value="all">Tudo</option></select></div>
    <div id="repBox"><div class="empty">Carregando…</div></div>
    <p class="hint" style="margin:8px 2px 18px">Conta só pedidos pagos ou entregues. Lucro = valor pago − Stars (custo) − taxa do MP. Comissão = % do lucro, com o % que valia no dia da venda. O período muda só a primeira linha; <b>a pagar</b> = ganho total − pagamentos registrados.</p>
    <button class="newbtn" onclick="openCup()">+ Novo cupom</button>
  </div>
  <div id="cupList" class="padd" style="padding-top:0"></div>
</main>
<div class="modal" id="cmodal">
  <div class="sheet">
    <h3 id="ctitle">Novo cupom</h3>
    <div class="fg"><label>Código</label><input id="c_code" placeholder="ex.: AQUILA" autocomplete="off" style="text-transform:uppercase"><div class="hint">A-Z, 0-9, _ ou -. Link: <span class="mono" id="c_link"></span></div></div>
    <div class="frow">
      <div class="fg"><label>Desconto ao cliente (%)</label><input id="c_desc" inputmode="decimal" placeholder="5"></div>
      <div class="fg"><label>Comissão (% do lucro)</label><input id="c_com" inputmode="decimal" placeholder="20"></div>
    </div>
    <div class="fg"><label>Nota (opcional)</label><input id="c_nota" placeholder="ex.: youtuber aquilagado" autocomplete="off"></div>
    <label class="fchk"><button type="button" class="sw" id="c_ativo" onclick="this.classList.toggle('on');cupAtivoTxt()"></button><span id="c_ativo_txt">Ativo — já pode ser usado</span></label>
    <p class="merr" id="cerr"></p>
    <div class="mbtns"><button class="cancel" onclick="closeCup()">Cancelar</button><button class="save" id="csave" onclick="saveCup()">Salvar</button></div>
  </div>
</div>
<main id="viewProd" style="display:none">
  <div class="padd"><button class="newbtn" onclick="openForm()">+ Novo produto</button></div>
  <div id="prodList" class="padd" style="padding-top:0"></div>
</main>

<div class="modal" id="modal">
  <div class="sheet">
    <h3 id="mtitle">Novo produto</h3>
    <div class="fg"><label>Chave (identificador único)</label><input id="f_key" placeholder="ex.: c1000" autocomplete="off"><div class="hint">Só a-z, 0-9 e _. Não pode mudar depois de criado.</div></div>
    <div class="fg"><label>Nome exibido</label><input id="f_nome" placeholder="ex.: 1.000 Coins" autocomplete="off"></div>
    <div class="frow">
      <div class="fg"><label>Preço (R$)</label><input id="f_preco" inputmode="decimal" placeholder="3,50" autocomplete="off"></div>
      <div class="fg"><label>Stars (interno)</label><input id="f_stars" inputmode="numeric" placeholder="26" autocomplete="off"></div>
    </div>
    <div class="fg"><label>Código do link Telegram</label><input id="f_code" placeholder="ex.: c_1000" autocomplete="off"><div class="hint">Vira s_&lt;código&gt;_&lt;ID&gt; no link do bot.</div></div>
    <div class="frow">
      <div class="fg"><label>Tipo (regra de bloqueio)</label><select id="f_tipo">
        <option value="">Nenhum (Coins)</option>
        <option value="wildfire">Wildfire</option>
        <option value="arsenal">Arsenal Pass</option>
        <option value="gold">Gold Pass</option>
      </select></div>
      <div class="fg"><label>Níveis de passe</label><input id="f_niveis" inputmode="numeric" placeholder="0" autocomplete="off"><div class="hint">0 se não for nível.</div></div>
    </div>
    <div class="fg"><label>Imagem (URL/caminho)</label><input id="f_img" placeholder="/img/c1000.jpg" autocomplete="off"></div>
    <label class="fchk"><button type="button" class="sw" id="f_ativo" onclick="this.classList.toggle('on')"></button><span>Ativo (aparece na loja)</span></label>
    <p class="merr" id="merr"></p>
    <div class="mbtns"><button class="cancel" onclick="closeForm()">Cancelar</button><button class="save" id="msave" onclick="saveForm()">Salvar</button></div>
  </div>
</div>
<script>
const ORDERS=${data};
let STARS=null;const NOST=new Set();
const CATS={'':'Coins',wildfire:'Coleções',arsenal:'Passes',gold:'Passes'};
const LABEL={pending:'Pendentes',paid:'Na fila',delivered:'Entregues',cancelled:'Cancelados',reversed:'Estornados'};
const BADGE={pending:'Pendente',paid:'Pago',delivered:'Entregue',cancelled:'Cancelado',reversed:'Estornado'};
const TABS=['paid','pending','delivered','cancelled','reversed'];
const brl=c=>(c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let cur=location.hash.slice(1)||'paid',q='';
if(!TABS.includes(cur))cur='paid';

function count(s){return ORDERS.filter(o=>o.status===s).length}
function renderTabs(){
  document.getElementById('tabs').innerHTML=TABS.filter(s=>s!=='reversed'||count(s)).map(s=>
    \`<button class="tab \${s===cur?'on':''}" data-s="\${s}">\${LABEL[s]}<span class="c">\${count(s)}</span></button>\`).join('');
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{cur=b.dataset.s;location.hash=cur;render();});
}
function card(o){
  const tl=[];
  if(o.created)tl.push('Criado '+o.created);
  if(o.paid)tl.push('Pago '+o.paid);
  if(o.delivered)tl.push('Entregue '+o.delivered);
  let acts='';
  if(o.status==='paid'){
    acts=\`<div class="acts">\${o.tg?\`<a class="a-tg" href="\${esc(o.tg)}" target="_blank" rel="noopener" onclick="backFrom=\${o.id}">Abrir no Telegram · \${o.stars}★</a>\`:''}
      <button class="a-ok" onclick="deliver(\${o.id})">Marcar entregue</button></div>\`;
  }
  if(o.status==='paid'&&o.canPay&&o.canPay.ok)acts=acts.replace('<div class="acts">','<div class="acts"><button class="a-pay" onclick="payNow('+o.id+',this)">⭐ Pagar '+o.stars+'★</button>');
  const apb=o.status!=='paid'?(o.ap==='incerto'?'<div class="chk">Pagamento automático ficou incerto — resolvido manualmente.</div>':''):
    o.ap==='incerto'?'<div class="chk diverge">🚨 Pagamento incerto: '+esc((o.apInfo&&o.apInfo.erro)||'')+'. <button class="rechk" onclick="verifyPay('+o.id+',this)">🔍 verificar cobrança</button></div>':
    o.ap==='paying'?'<div class="chk wait">⏳ Pagando no bot…</div>':
    o.ap==='erro'?'<div class="chk erro">Pagamento não feito: '+esc((o.apInfo&&o.apInfo.erro)||'')+' — pague de novo ou entregue na mão e toque em Marcar entregue.</div>':
    o.ap==='sent'?'<div class="chk ok">⭐ Pago no bot ('+((o.apInfo&&o.apInfo.stars)||'')+'★)'+(o.apInfo&&o.apInfo.botReply?' · '+esc(o.apInfo.botReply):'')+'</div>':'';
  if(o.blocked)acts='<div class="acts"><span class="blk">🚫 Cliente bloqueado</span><button class="a-unb" onclick="unblock('+o.id+')">Desbloquear</button></div>';
  const ck=o.chk;
  const chk=o.status!=='paid'||!o.chkOn?'':'<div class="chk '+(ck?ck.status:'wait')+'">'+(
    !ck?'🔎 Conferindo no bot do CF…':
    ck.status==='ok'?'🔎 Conferido no bot: <b>'+ck.stars+'★</b> · '+esc(ck.account)+' · '+esc(ck.produto||'')+' ✅':
    ck.status==='diverge'?'❌ Conferência não bateu: '+esc(ck.motivo):
    '⚠ Conferência falhou: '+esc(ck.motivo))+
    ' <button class="rechk" onclick="recheck('+o.id+',this)">conferir de novo</button></div>';
  const risk=(o.risk&&o.risk.length)?'<div class="risk"><b>⚠ Revisar antes de entregar</b>'+o.risk.map(function(r){return '<span>· '+esc(r)+'</span>';}).join('')+'</div>':'';
  return \`<div class="card\${NEWS.has(o.id)?' new':''}">
    <div class="chead"><span class="bdg \${o.status}">\${BADGE[o.status]}</span>\${NEWS.has(o.id)?'<span class="newtag">NOVO</span>':''}\${waitTag(o)}\${NOST.has(o.id)?'<span class="nost">SEM STARS</span>':''}<span class="oid">#\${o.id}</span></div>
    <div class="body">
      <img class="av" src="/api/player/\${esc(o.gameId)}/avatar" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="info">
        <div class="pn">\${esc(o.nome)}\${o.cup?'<span class="cuptag">'+esc(o.cup)+'</span>':''}</div>
        <div class="nk">\${esc(o.nick)}</div>
        <div class="meta">ID <b class="mono">\${esc(o.gameId)}</b> · \${esc(o.email)}</div>
      </div>
      <div class="price"><div class="v mono">\${brl(o.cents)}</div><div class="s">\${o.stars}★ Stars</div></div>
    </div>
    \${tl.length?\`<div class="times">\${tl.map(t=>'<span>'+esc(t)+'</span>').join('')}</div>\`:''}
    \${chk}\${apb}\${risk}\${acts}
  </div>\`;
}
function render(){
  renderTabs();
  let items=ORDERS.filter(o=>o.status===cur);
  if(cur==='paid')items=items.slice().sort(function(a,b){return a.id-b.id;}); // fila: mais antigo primeiro
  NOST.clear();
  if(STARS&&STARS.configurado){let acc=0;ORDERS.filter(function(o){return o.status==='paid';}).sort(function(a,b){return a.id-b.id;})
    .forEach(function(o){acc+=o.stars;if(acc>STARS.saldo)NOST.add(o.id);});}
  renderSbar();
  if(q){const s=q.toLowerCase();items=items.filter(o=>o.nick.toLowerCase().includes(s)||o.gameId.includes(s)||('#'+o.id).includes(s)||String(o.id)===s);}
  document.getElementById('viewPed').innerHTML=items.length?items.map(card).join(''):
    \`<div class="empty">Nenhum pedido \${LABEL[cur].toLowerCase()}\${q?' para "'+esc(q)+'"':''}.</div>\`;
}
// ---- saldo de Stars ----
const fmtN=function(n){return Number(n).toLocaleString('pt-BR');};
async function loadStars(){
  try{STARS=await api('/api/admin/stars');}catch(e){return;}
  const b=$$('stBtn');b.textContent='★ '+(STARS.configurado?fmtN(STARS.saldo):'?');
  b.classList.toggle('no',!STARS.configurado||STARS.fila>STARS.saldo);
  b.classList.toggle('lo',STARS.configurado&&STARS.fila<=STARS.saldo&&STARS.saldo<STARS.low);
  if(VIEW==='pedidos')render();
  if($$('smodal').classList.contains('on'))renderStars();
}
function renderSbar(){
  const box=$$('sbarBox');box.textContent='';
  if(VIEW!=='pedidos'||!STARS)return;
  let msg='';
  if(!STARS.configurado)msg='Informe seu saldo de Stars para a loja avisar quando faltar.';
  else if(STARS.fila>STARS.saldo)msg='Faltam '+fmtN(STARS.fila-STARS.saldo)+'★ para entregar a fila ('+fmtN(STARS.fila)+'★, saldo '+fmtN(STARS.saldo)+'★).';
  else if(STARS.saldo<STARS.low)msg='Saldo de Stars baixo: '+fmtN(STARS.saldo)+'★.';
  if(!msg)return;
  const d=el('div','sbar');d.appendChild(el('span',null,msg));
  const bt=el('button',null,STARS.configurado?'Recarregar':'Informar saldo');bt.onclick=openStars;d.appendChild(bt);box.appendChild(d);
}
function openStars(){$$('smodal').classList.add('on');renderStars();loadStars();}
function closeStars(){$$('smodal').classList.remove('on');}
function renderStars(){
  const B=$$('sBody');B.textContent='';if(!STARS){B.appendChild(el('div','empty','Carregando…'));return;}
  B.appendChild(el('div','sbig',STARS.configurado?fmtN(STARS.saldo)+'★':'—'));
  if(STARS.real){
    const R=STARS.real;let t;
    if(R.ativo)t='📡 Lido da conta do Telegram às '+new Date(R.at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})+' (atualiza a cada 5 min)';
    else if(R.err)t='⚠ Leitura do Telegram falhou ('+R.err+'). Usando o saldo manual.';
    else t='Lendo saldo do Telegram…';
    B.appendChild(el('div','ssub'+(R.err?' serr':''),t));
  }
  let sub=STARS.configurado?'Fila a entregar: '+fmtN(STARS.fila)+'★ · aviso abaixo de '+fmtN(STARS.low)+'★':'Ainda não configurado. Confira no Telegram e informe o saldo atual.';
  if(STARS.custoMedio)sub+=' · custo médio das recargas R$ '+STARS.custoMedio.toFixed(4).replace('.',',')+'/★ (cálculo de lucro usa R$ '+STARS.custoConfig.toFixed(4).replace('.',',')+')';
  B.appendChild(el('div','ssub',sub));
  if(STARS.autopay){
    const A=STARS.autopay,row=el('div','aprow'),tx=el('div');
    tx.appendChild(el('b',null,'Entrega com Stars'));
    tx.appendChild(el('span',null,'até '+fmtN(A.max)+'★ por pedido · '+fmtN(A.usado24h)+' de '+fmtN(A.dia)+'★ usados em 24h'));
    const seg=el('div','seg');
    [['0','Desligado'],['1','1 toque'],['2','Automático']].forEach(function(m){
      const bt=el('button',A.mode===m[0]?'on':'',m[1]);
      bt.onclick=async function(){
        if(A.mode===m[0])return;
        if(m[0]==='2'&&!confirm('Ligar a entrega AUTOMÁTICA?\\n\\nA loja vai pagar sozinha, sem você tocar, todo pedido com conferência ✅, sem REVISAR, dentro dos tetos e com saldo. Os outros ficam para entrega manual e você é avisado no Telegram.'))return;
        if(m[0]==='1'&&!confirm('Ligar o pagamento com 1 toque?\\n\\nO botão Pagar aparece só em pedidos com conferência ✅, sem REVISAR e dentro dos tetos. Cada pagamento pede confirmação.'))return;
        try{await api('/api/admin/autopay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:m[0]})});await loadStars();refreshOrders(false);}catch(e){alert(e.message);}
      };
      seg.appendChild(bt);
    });
    row.style.flexDirection='column';row.style.alignItems='stretch';
    row.appendChild(tx);row.appendChild(seg);B.appendChild(row);
  }
  const a=el('div','sacts');
  const b1=el('button','pri','+ Registrar recarga');b1.onclick=addRecarga;
  const b2=STARS.real?el('button',null,'↻ Ler agora'):el('button',null,STARS.configurado?'Conferir saldo':'Informar saldo');
  b2.onclick=STARS.real?syncNow:conferir;
  a.appendChild(b1);a.appendChild(b2);B.appendChild(a);
  if(!STARS.movs.length)return;
  const t=el('table','smov');
  const NM={recarga:'Recarga',ajuste:'Ajuste',entrega:'Entrega'};
  STARS.movs.forEach(function(m){
    const tr=document.createElement('tr');
    tr.appendChild(el('td','m',m.data));
    tr.appendChild(el('td',null,NM[m.kind]+(m.order_id?' #'+m.order_id:'')+(m.nota?' · '+m.nota:'')+(m.cents?' · '+brlFromCents(m.cents):'')));
    tr.appendChild(el('td','n '+(m.delta>0?'p':''),(m.delta>0?'+':'')+fmtN(m.delta)+'★'));
    const td=document.createElement('td');
    if(m.kind!=='entrega'){const u=el('button','undo','apagar');u.onclick=function(){delMov(m.id,m.delta);};td.appendChild(u);}
    tr.appendChild(td);t.appendChild(tr);
  });
  B.appendChild(t);
}
async function syncNow(){
  try{STARS=await api('/api/admin/stars/sync',{method:'POST'});renderStars();loadStars();}catch(e){alert(e.message);}
}
async function postStars(body){
  try{await api('/api/admin/stars',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await loadStars();}
  catch(e){alert(e.message);}
}
function addRecarga(){
  const v=prompt('Quantos Stars entraram na recarga?','');if(v==null)return;
  const st=parseInt(v.replace(/[^0-9]/g,''),10);if(!(st>0)){alert('Quantidade inválida.');return;}
  const c=prompt('Quanto custou em R$? (opcional, para calcular o custo médio por Star)','');if(c==null)return;
  let t=c.replace(/[^0-9,.]/g,'');if(t.indexOf(',')>=0)t=t.split('.').join('').replace(',','.');
  const cents=t?Math.round(parseFloat(t)*100):null;
  postStars({kind:'recarga',stars:st,cents:cents,nota:''});
}
function conferir(){
  const v=prompt('Qual o saldo de Stars que aparece agora no Telegram?',STARS&&STARS.configurado?String(STARS.saldo):'');if(v==null)return;
  const n=parseInt(v.replace(/[^0-9]/g,''),10);if(!(n>=0)){alert('Saldo inválido.');return;}
  postStars({kind:'ajuste',saldo_real:n});
}
async function delMov(id,delta){
  if(!confirm('Apagar este movimento de '+(delta>0?'+':'')+fmtN(delta)+'★?'))return;
  try{await api('/api/admin/stars/'+id,{method:'DELETE'});await loadStars();}catch(e){alert(e.message);}
}

// tempo de espera do pago (prazo prometido: 1h)
function waitTag(o){
  if(o.status!=='paid'||!o.paidTs)return '';
  const m=Math.max(0,Math.floor((Date.now()-o.paidTs)/60000));
  const t=m<60?m+' min':m<1440?Math.floor(m/60)+'h'+String(m%60).padStart(2,'0'):Math.floor(m/1440)+(m<2880?' dia':' dias');
  return '<span class="wait '+(m>=50?'w3':m>=30?'w2':'')+'" title="Tempo desde o pagamento">⏱ '+t+'</span>';
}
// voltou do Telegram depois de tocar em "Abrir no Telegram": pergunta se entregou
let backFrom=null;
function askBack(){
  if(!backFrom)return;const o=ORDERS.find(function(x){return x.id===backFrom;});
  if(!o||o.status!=='paid'){backFrom=null;return;}
  $$('bbtxt').textContent='Entregou o pedido #'+o.id+' ('+o.nome+' para '+o.nick+')?';
  $$('backbar').classList.add('on');
}
function closeBack(){backFrom=null;$$('backbar').classList.remove('on');}
async function yesBack(){const id=backFrom;closeBack();if(id)await deliver(id,true);}
async function deliver(id,fromBack){
  const ob=ORDERS.find(function(x){return x.id===id;});
  const rk=ob&&ob.risk&&ob.risk.length?'\\n\\n⚠ REVISAR: '+ob.risk.join('; ')+'\\n\\nConfira no app do Mercado Pago se o Pix caiu e quem pagou. Na dúvida, fale com o cliente antes.':'';
  if((!fromBack||rk)&&!confirm('Confirmar entrega do pedido #'+id+'?'+rk))return;
  const r=await fetch('/painel/'+id+'/entregue',{method:'POST',headers:{'x-painel':'1'}});
  if(r.ok){const o=ORDERS.find(x=>x.id===id);NEWS.delete(id);loadStars();if(o){o.status='delivered';o.delivered=new Date().toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}render();}
  else alert('Não foi possível marcar como entregue.');
}
document.getElementById('q').oninput=e=>{q=e.target.value.trim();render();};

// ---- atualização automática dos pedidos ----
const NEWS=new Set();let VIEW='pedidos',syncing=false,unseen=0;
function hhmm(){return new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}
async function refreshOrders(manual){
  if(syncing)return;syncing=true;
  try{
    const r=await fetch('/api/admin/orders',{headers:{'x-painel':'1'}});
    if(r.status===401){location.href='/login';return;}
    if(!r.ok)throw new Error();
    const list=await r.json();
    const known=new Set(ORDERS.filter(function(o){return o.status==='paid';}).map(function(o){return o.id;}));
    let fresh=0;
    list.forEach(function(o){if(o.status==='paid'&&!known.has(o.id)){NEWS.add(o.id);fresh++;}});
    ORDERS.length=0;list.forEach(function(o){ORDERS.push(o);});
    if(fresh&&document.hidden){unseen+=fresh;document.title='('+unseen+') Painel — Recarga Flame';}
    if(VIEW==='pedidos')render();
    loadStars();
    $$('sync').textContent='Atualizado às '+hhmm()+' · atualiza sozinho a cada 15 s';
  }catch(e){
    $$('sync').textContent='Sem conexão às '+hhmm()+' · tentando de novo…';
    if(manual)alert('Não foi possível atualizar os pedidos.');
  }finally{syncing=false;}
}
setInterval(function(){if(!document.hidden)refreshOrders(false);},15000);
document.addEventListener('visibilitychange',function(){
  if(!document.hidden){unseen=0;document.title='Painel — Recarga Flame';askBack();refreshOrders(false);}
});
async function payNow(id,btn){
  const o=ORDERS.find(function(x){return x.id===id;});if(!o)return;
  if(!confirm('Pagar '+o.stars+'★ da conta separada no bot do CounterFlame?\\n\\n'+o.nome+' para '+o.nick+' (ID '+o.gameId+')\\n\\nA fatura é conferida de novo antes de pagar.'))return;
  btn.disabled=true;btn.textContent='Pagando…';
  try{const r=await api('/api/admin/orders/'+id+'/autopay',{method:'POST'});alert('Pago ('+r.stars+'★) e marcado como entregue.'+(r.botReply?'\\n\\nBot do CF: '+r.botReply:''));}
  catch(e){alert(e.message);}
  refreshOrders(false);loadStars();
}
async function verifyPay(id,btn){
  btn.disabled=true;btn.textContent='verificando…';
  try{
    const r=await api('/api/admin/orders/'+id+'/verify',{method:'POST'});
    if(r.cobrado){
      if(confirm('FOI COBRADO: a fatura deste pedido no bot do CounterFlame (mensagem '+r.fatura+') tem recibo de pagamento de '+r.stars+'★.\\n\\nConfira se o item chegou na conta do cliente. Marcar o pedido #'+id+' como entregue (o cliente recebe o e-mail)?'))
        await api('/api/admin/orders/'+id+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'entregue'})});
    }else{
      if(confirm('NÃO foi cobrado: '+(r.semFatura?'a tentativa falhou antes de chegar à fatura':'a fatura deste pedido (mensagem '+r.fatura+') não tem recibo de pagamento')+'.\\n\\nLiberar uma nova tentativa (o botão Pagar volta)? Se preferir, entregue na mão e toque em Marcar entregue.'))
        await api('/api/admin/orders/'+id+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'liberar'})});
    }
  }catch(e){alert(e.message);}
  refreshOrders(false);loadStars();
}
async function recheck(id,btn){
  btn.disabled=true;btn.textContent='conferindo…';
  try{await api('/api/admin/orders/'+id+'/check',{method:'POST'});}catch(e){alert(e.message);}
  refreshOrders(false);
}
async function unblock(id){
  if(!confirm('Desbloquear o cliente do pedido #'+id+' (ID, e-mail, aparelho e conta que pagou)? Ele volta a poder comprar.'))return;
  try{await api('/api/admin/orders/'+id+'/unblock',{method:'POST'});refreshOrders(false);}
  catch(e){alert(e.message);}
}
function refreshView(){
  if(VIEW==='pedidos')refreshOrders(true);
  else if(VIEW==='produtos')loadProds();
  else if(VIEW==='cupons'){loadCups();loadRep();}
  else loadAna();
}

// ---- views ----
function setView(v){
  const ped=v==='pedidos',prod=v==='produtos',cup=v==='cupons',ana=v==='analytics';
  VIEW=v;if(ped){NEWS.clear();render();}
  document.getElementById('navPed').classList.toggle('on',ped);
  document.getElementById('navProd').classList.toggle('on',prod);
  document.getElementById('navCup').classList.toggle('on',cup);
  document.getElementById('navAna').classList.toggle('on',ana);
  document.getElementById('hdrPed').style.display=ped?'':'none';
  document.getElementById('viewPed').style.display=ped?'':'none';
  document.getElementById('viewProd').style.display=prod?'':'none';
  document.getElementById('viewCup').style.display=cup?'':'none';
  document.getElementById('viewAna').style.display=ana?'':'none';
  document.getElementById('htitle').textContent=ped?'Painel de pedidos':prod?'Produtos':cup?'Cupons':'Analytics';
  if(prod)loadProds();
  if(cup){loadCups();loadRep();}
  if(ana)loadAna();
}

// ---- CRUD produtos ----
let PRODS=[];
const brlFromCents=c=>(c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
async function api(url,opt){
  const o=opt||{}; o.headers=Object.assign({'x-painel':'1'},o.headers||{});
  const r=await fetch(url,o); let j={}; try{j=await r.json();}catch{}
  if(!r.ok)throw new Error(j.error||'Erro na operação.');
  return j;
}
async function loadProds(){
  document.getElementById('prodList').innerHTML='<div class="empty">Carregando…</div>';
  try{PRODS=await api('/api/admin/products');renderProds();}
  catch(e){document.getElementById('prodList').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
function catName(p){
  if(p.niveis>0&&!p.tipo)return 'Níveis de Passe';
  return CATS[p.tipo||'']||'Coins';
}
function renderProds(){
  document.getElementById('prodList').innerHTML=PRODS.map(p=>\`
    <div class="prow \${p.ativo?'':'pinact'}">
      <img src="\${esc(p.img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="pi">
        <div class="nm">\${esc(p.nome)}</div>
        <div class="sub">\${esc(catName(p))} · chave <b>\${esc(p.key)}</b> · cód <b>\${esc(p.code)}</b> · \${p.stars}★</div>
      </div>
      <div class="rt">
        <div class="pr">\${brlFromCents(p.cents)}</div>
        <button class="sw \${p.ativo?'on':''}" title="Ativo na loja" onclick="toggle('\${esc(p.key)}')"></button>
        <div class="ops"><button onclick="openForm('\${esc(p.key)}')">Editar</button><button class="del" onclick="delProd('\${esc(p.key)}','\${esc(p.nome)}')">Excluir</button></div>
      </div>
    </div>\`).join('')||'<div class="empty">Nenhum produto. Crie o primeiro.</div>';
}
async function toggle(key){
  try{const r=await api('/api/admin/products/'+key+'/ativo',{method:'PATCH'});
    const p=PRODS.find(x=>x.key===key);if(p)p.ativo=r.ativo;renderProds();}
  catch(e){alert(e.message);}
}
async function delProd(key,nome){
  if(!confirm('Excluir o produto "'+nome+'"?\\n\\nPedidos antigos não são afetados.'))return;
  try{await api('/api/admin/products/'+key,{method:'DELETE'});PRODS=PRODS.filter(x=>x.key!==key);renderProds();}
  catch(e){alert(e.message);}
}
let editKey=null;
const $$=id=>document.getElementById(id);
function openForm(key){
  editKey=key||null;
  const p=key?PRODS.find(x=>x.key===key):null;
  $$('mtitle').textContent=p?'Editar produto':'Novo produto';
  $$('f_key').value=p?p.key:''; $$('f_key').disabled=!!p;
  $$('f_nome').value=p?p.nome:''; $$('f_preco').value=p?(p.cents/100).toFixed(2).replace('.',','):'';
  $$('f_stars').value=p?p.stars:''; $$('f_code').value=p?p.code:'';
  $$('f_tipo').value=p?(p.tipo||''):''; $$('f_niveis').value=p?(p.niveis||0):0;
  $$('f_img').value=p?(p.img||''):'';
  $$('f_ativo').classList.toggle('on',p?!!p.ativo:true);
  $$('merr').textContent='';
  $$('modal').classList.add('on');
}
function closeForm(){$$('modal').classList.remove('on');}
$$('modal').onclick=e=>{if(e.target.id==='modal')closeForm();};
async function saveForm(){
  $$('merr').textContent=''; const btn=$$('msave'); btn.disabled=true;
  const centsNum=Math.round(parseFloat(($$('f_preco').value||'').replace('.','').replace(',','.'))*100);
  const payload={
    key:$$('f_key').value.trim(), nome:$$('f_nome').value.trim(),
    cents:centsNum, stars:$$('f_stars').value||0, code:$$('f_code').value.trim(),
    tipo:$$('f_tipo').value, niveis:$$('f_niveis').value||0,
    img:$$('f_img').value.trim(), ativo:$$('f_ativo').classList.contains('on'),
  };
  try{
    if(editKey)await api('/api/admin/products/'+editKey,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    else await api('/api/admin/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    closeForm(); await loadProds();
  }catch(e){$$('merr').textContent=e.message;}
  finally{btn.disabled=false;}
}


// ---- cupons ----
let CUPS=[],editCup=null;
const pct=n=>String(n).replace('.',',')+'%';
async function loadCups(){
  try{CUPS=await api('/api/admin/coupons');renderCups();}
  catch(e){$$('cupList').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
function renderCups(){
  $$('cupList').innerHTML=CUPS.map(function(c){
    return '<div class="prow"><div class="pi"><div class="nm mono">'+esc(c.code)+(c.ativo?'<span class="cuptag">ATIVO</span>':'<span class="cuptag off">INATIVO</span>')+'</div>'+
      '<div class="sub">desconto <b>'+pct(c.desconto_pct)+'</b> · comissão <b>'+pct(c.comissao_pct)+'</b> do lucro'+(c.nota?' · '+esc(c.nota):'')+'</div>'+
      '<div class="sub mono">'+esc(location.origin+'/?cupom='+c.code)+'</div></div>'+
      '<div class="rt"><button class="sw '+(c.ativo?'on':'')+'" title="Ativar/desativar" data-tog="'+esc(c.code)+'"></button>'+
      '<div class="ops"><button data-copy="'+esc(c.code)+'">Copiar link</button><button data-edit="'+esc(c.code)+'">Editar</button></div></div></div>';
  }).join('')||'<div class="empty">Nenhum cupom ainda.</div>';
  $$('cupList').querySelectorAll('[data-copy]').forEach(function(b){b.onclick=function(){copyCup(b.dataset.copy);};});
  $$('cupList').querySelectorAll('[data-edit]').forEach(function(b){b.onclick=function(){openCup(b.dataset.edit);};});
  $$('cupList').querySelectorAll('[data-tog]').forEach(function(b){b.onclick=function(){togCup(b.dataset.tog);};});
}
async function togCup(code){
  const c=CUPS.find(function(x){return x.code===code;});if(!c)return;
  try{await api('/api/admin/coupons/'+code,{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({desconto_pct:c.desconto_pct,comissao_pct:c.comissao_pct,nota:c.nota,ativo:!c.ativo})});
    c.ativo=!c.ativo;renderCups();}
  catch(e){alert(e.message);}
}
function copyCup(code){const u=location.origin+'/?cupom='+code;
  (navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(function(){alert('Link copiado: '+u);},function(){prompt('Copie o link:',u);});}
function perRange(){
  const v=$$('repPer').value,d=new Date(new Date().toLocaleString('en-US',{timeZone:'America/Sao_Paulo'}));
  const f=function(x){return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');};
  if(v==='all')return '';
  const m=v==='m1'?d.getMonth()-1:d.getMonth();
  return '?from='+f(new Date(d.getFullYear(),m,1))+'&to='+f(new Date(d.getFullYear(),m+1,0));
}
async function loadRep(){
  $$('repBox').innerHTML='<div class="empty">Carregando…</div>';
  try{const r=await api('/api/admin/coupons/report'+perRange());
    $$('repBox').innerHTML=r.cupons.map(function(c){
      const st=c.saldo>0?'<span class="due">a pagar '+brlFromCents(c.saldo)+'</span>':
        c.saldo<0?'<span class="due">crédito '+brlFromCents(-c.saldo)+'</span>':'<span class="ok">em dia ✓</span>';
      const pays=c.pagamentos.map(function(p){
        return '<tr><td>'+esc(p.data.split('-').reverse().join('/'))+'</td><td>'+brlFromCents(p.cents)+'</td><td style="text-align:left">'+esc(p.nota)+'</td>'+
          '<td><button class="undo" data-undo="'+p.id+'" data-v="'+esc(brlFromCents(p.cents))+'">desfazer</button></td></tr>';
      }).join('');
      return '<div class="rep"><div class="top"><span class="mono">'+esc(c.code)+'</span>'+st+'</div>'+
        '<div class="nums"><span><b>'+c.pedidos+'</b> vendas</span><span>faturado <b>'+brlFromCents(c.faturado)+'</b></span>'+
        '<span>descontos <b>'+brlFromCents(c.desconto)+'</b></span><span>lucro <b>'+brlFromCents(c.lucro)+'</b></span>'+
        '<span>comissão <b>'+brlFromCents(c.comissao)+'</b></span></div>'+
        '<div class="tot"><span>ganho total <b>'+brlFromCents(c.total)+'</b></span><span>já pago <b>'+brlFromCents(c.pago)+'</b></span><span>hoje '+pct(c.comissao_pct)+' do lucro</span></div>'+
        '<div class="ops"><button data-pay="'+esc(c.code)+'" data-saldo="'+Math.max(0,c.saldo)+'">Registrar pagamento</button></div>'+
        (pays?'<details><summary>Pagamentos feitos ('+c.pagamentos.length+')</summary><table class="ttab"><tr><th>Data</th><th>Valor</th><th style="text-align:left">Obs.</th><th></th></tr>'+pays+'</table></details>':'')+
        '</div>';
    }).join('')||'<div class="empty" style="padding:24px">Nenhuma venda com cupom ainda.</div>';
    $$('repBox').querySelectorAll('[data-pay]').forEach(function(b){b.onclick=function(){payCup(b.dataset.pay,Number(b.dataset.saldo));};});
    $$('repBox').querySelectorAll('[data-undo]').forEach(function(b){b.onclick=function(){undoPay(b.dataset.undo,b.dataset.v);};});
  }catch(e){$$('repBox').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
async function payCup(code,saldo){
  const v=prompt('Quanto você pagou para '+code+'? (R$)',saldo>0?(saldo/100).toFixed(2).replace('.',','):'');
  if(v==null)return;
  let t=v.replace(/[^0-9,.]/g,'');
  if(t.indexOf(',')>=0)t=t.split('.').join('').replace(',','.');
  const cents=Math.round(parseFloat(t)*100);
  if(!(cents>0)){alert('Valor inválido.');return;}
  const nota=prompt('Observação (opcional), ex.: Pix 07/11','');
  if(nota==null)return;
  try{await api('/api/admin/coupons/'+code+'/payouts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cents:cents,nota:nota})});loadRep();}
  catch(e){alert(e.message);}
}
async function undoPay(id,v){
  if(!confirm('Desfazer o pagamento de '+v+'? Ele volta para o saldo a pagar.'))return;
  try{await api('/api/admin/payouts/'+id,{method:'DELETE'});loadRep();}
  catch(e){alert(e.message);}
}
function openCup(code){
  editCup=code||null;const c=code?CUPS.find(function(x){return x.code===code;}):null;
  $$('ctitle').textContent=c?'Editar cupom':'Novo cupom';
  $$('c_code').value=c?c.code:'';$$('c_code').disabled=!!c;
  $$('c_desc').value=c?String(c.desconto_pct).replace('.',','):'5';
  $$('c_com').value=c?String(c.comissao_pct).replace('.',','):'20';
  $$('c_nota').value=c?(c.nota||''):'';
  $$('c_ativo').classList.toggle('on',c?!!c.ativo:true);
  $$('cerr').textContent='';cupLink();cupAtivoTxt();$$('cmodal').classList.add('on');
}
function cupAtivoTxt(){$$('c_ativo_txt').textContent=$$('c_ativo').classList.contains('on')?'Ativo — já pode ser usado':'Inativo — o link não dá desconto';}
function cupLink(){$$('c_link').textContent=location.origin+'/?cupom='+($$('c_code').value.trim().toUpperCase()||'CODIGO');}
$$('c_code').oninput=cupLink;
function closeCup(){$$('cmodal').classList.remove('on');}
$$('cmodal').onclick=function(e){if(e.target.id==='cmodal')closeCup();};
async function saveCup(){
  $$('cerr').textContent='';const b=$$('csave');b.disabled=true;
  const num=function(id){return Number(($$(id).value||'0').replace(',','.'));};
  const payload={code:$$('c_code').value.trim(),desconto_pct:num('c_desc'),comissao_pct:num('c_com'),nota:$$('c_nota').value.trim(),ativo:$$('c_ativo').classList.contains('on')};
  try{
    if(editCup)await api('/api/admin/coupons/'+editCup,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    else await api('/api/admin/coupons',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    closeCup();await loadCups();loadRep();
  }catch(e){$$('cerr').textContent=e.message;}
  finally{b.disabled=false;}
}


// ---- analytics ----
let anaP='d30';
function ymd(x){return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');}
function spNow(){return new Date(new Date().toLocaleString('en-US',{timeZone:'America/Sao_Paulo'}));}
function anaRange(p){
  const d=spNow(),Y=d.getFullYear(),M=d.getMonth(),D=d.getDate();
  if(p==='d0')return [ymd(d),ymd(d)];
  if(p==='d7')return [ymd(new Date(Y,M,D-6)),ymd(d)];
  if(p==='d30')return [ymd(new Date(Y,M,D-29)),ymd(d)];
  if(p==='m0')return [ymd(new Date(Y,M,1)),ymd(d)];
  if(p==='m1')return [ymd(new Date(Y,M-1,1)),ymd(new Date(Y,M,0))];
  return [null,null];
}
document.querySelectorAll('#anaPer button').forEach(function(b){b.onclick=function(){
  anaP=b.dataset.p;document.querySelectorAll('#anaPer button').forEach(function(x){x.classList.toggle('on',x===b);});loadAna();};});
function el(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
function kpi(l,v,sub){const k=el('div','kpi');k.appendChild(el('div','l',l));k.appendChild(el('div','v',v));if(sub)k.appendChild(el('div','s',sub));return k;}
const brlC=function(c){return brlFromCents(Math.round(c));};
async function loadAna(){
  const body=$$('anaBody');body.classList.add('loading');
  const r=anaRange(anaP);const qs=r[0]?('?from='+r[0]+'&to='+r[1]):'';
  let a;try{a=await api('/api/admin/analytics'+qs);}catch(e){body.classList.remove('loading');body.textContent=e.message;return;}
  body.classList.remove('loading');body.textContent='';
  const conv=a.pixGerados?Math.round(a.pixPagos/a.pixGerados*100)+'%':'—';
  const k=el('div','kpis');
  k.appendChild(kpi('Vendas',String(a.vendas),a.comCupom?(a.comCupom+' com cupom'):null));
  k.appendChild(kpi('Faturado',brlC(a.faturado)));
  k.appendChild(kpi('Ticket médio',a.vendas?brlC(a.ticket):'—'));
  k.appendChild(kpi('Lucro estimado',brlC(a.lucro),a.comissao?('após '+brlC(a.comissao)+' de comissão'):'Stars + taxa MP descontadas'));
  k.appendChild(kpi('Conversão do Pix',conv,a.pixGerados?(a.pixPagos+' pagos de '+a.pixGerados+' gerados'):'nenhum Pix gerado'));
  k.appendChild(kpi('Entrega (mediana)',a.entregaMedianaMin==null?'—':fmtMin(a.entregaMedianaMin),
    a.entregaAte1h==null?'nenhuma entrega':(Math.round(a.entregaAte1h*100)+'% em até 1h · '+a.entregas+' entregas')));
  body.appendChild(k);
  if(a.estornos){const w=el('div','ccard');w.appendChild(el('h4',null,'⚠ '+a.estornos+(a.estornos>1?' estornos':' estorno')+' no período'));
    w.appendChild(el('p','sub','Pedidos pagos que voltaram (MED/chargeback). Não entram nas vendas acima.'));body.appendChild(w);}
  body.appendChild(dayChart(a,r));
  body.appendChild(prodRank(a.produtos));
}
function fmtMin(m){return m<60?(m+' min'):(Math.floor(m/60)+'h'+(m%60?String(m%60).padStart(2,'0'):''));}
function niceMax(v){if(v<=0)return 100;const p=Math.pow(10,Math.floor(Math.log10(v))),n=v/p;return (n<=1?1:n<=2?2:n<=5?5:10)*p;}
function dayChart(a,r){
  const card=el('div','ccard');card.appendChild(el('h4',null,'Faturamento por dia'));
  // série contínua (dias sem venda = 0); período "Tudo": do 1º dia com venda até hoje
  const map={};a.porDia.forEach(function(d){map[d.date]=d;});
  let start=r[0]||(a.porDia[0]&&a.porDia[0].date),end=r[1]||ymd(spNow());
  let days=[];
  if(start){const s0=new Date(start+'T12:00:00'),e0=new Date(end+'T12:00:00');
    for(let t=new Date(s0);t<=e0;t.setDate(t.getDate()+1))days.push(map[ymd(t)]||{date:ymd(t),n:0,cents:0});}
  let unit='dia';
  if(days.length>62){ // agrega por mês
    const m={};days.forEach(function(d){const k=d.date.slice(0,7);(m[k]=m[k]||{date:k,n:0,cents:0});m[k].n+=d.n;m[k].cents+=d.cents;});
    days=Object.keys(m).sort().map(function(k){return m[k];});unit='mês';card.firstChild.textContent='Faturamento por mês';}
  card.appendChild(el('p','sub',days.length?('Total '+brlC(a.faturado)+' · passe o dedo/mouse nas colunas'):'Sem vendas no período'));
  if(!days.length)return card;
  const wrap=el('div','chart');card.appendChild(wrap);const tip=el('div','tip');card.appendChild(tip);
  const W=Math.max(260,($$('anaBody').clientWidth||560)-26),H=170,L=44,B=22,T=14,pw=Math.max(W-L-4,100),ph=H-B-T;
  const max=niceMax(Math.max.apply(null,days.map(function(d){return d.cents;})));
  const NS='http://www.w3.org/2000/svg';const svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 '+W+' '+H);
  svg.setAttribute('role','img');svg.setAttribute('aria-label','Faturamento por '+unit+', '+days.length+' períodos');
  function sv(tag,at){const e=document.createElementNS(NS,tag);for(const k in at)e.setAttribute(k,at[k]);return e;}
  [0,0.5,1].forEach(function(f){const y=T+ph-ph*f;svg.appendChild(sv('line',{x1:L,x2:L+pw,y1:y,y2:y,class:'grid'}));
    const t=sv('text',{x:L-6,y:y+3.5,'text-anchor':'end'});t.textContent=compactBRL(max*f);svg.appendChild(t);});
  const slot=pw/days.length,bw=Math.min(24,Math.max(2,slot-2));
  let iMax=0;days.forEach(function(d,i){if(d.cents>days[iMax].cents)iMax=i;});
  const every=Math.ceil(days.length/7);
  days.forEach(function(d,i){
    const x=L+slot*i+(slot-bw)/2,h=d.cents?Math.max(2,ph*d.cents/max):0,y=T+ph-h;
    const hit=sv('rect',{x:L+slot*i,y:T,width:slot,height:ph,class:'hit',tabindex:'0'});
    hit.setAttribute('aria-label',lbl(d)+': '+brlC(d.cents)+', '+d.n+' vendas');
    svg.appendChild(hit);
    // coluna: 4px arredondado em cima, reta na base
    const r4=Math.min(4,h,bw/2);
    svg.appendChild(sv('path',{class:'col',d:h?('M'+x+','+(T+ph)+'V'+(y+r4)+'Q'+x+','+y+' '+(x+r4)+','+y+'H'+(x+bw-r4)+'Q'+(x+bw)+','+y+' '+(x+bw)+','+(y+r4)+'V'+(T+ph)+'Z'):''}));
    if(i%every===0||i===days.length-1){const t=sv('text',{x:x+bw/2,y:H-6,'text-anchor':'middle'});t.textContent=short(d);svg.appendChild(t);}
    if(i===iMax&&d.cents){const t=sv('text',{x:x+bw/2,y:y-4,'text-anchor':'middle',class:'lbl'});t.textContent=compactBRL(d.cents);svg.appendChild(t);}
    function show(){tip.textContent='';tip.appendChild(el('b',null,brlC(d.cents)));tip.appendChild(el('span',null,lbl(d)+' · '+d.n+(d.n===1?' venda':' vendas')));
      tip.style.display='block';const cx=(x+bw/2)/W*wrap.clientWidth+12;
      tip.style.left=Math.min(cx,card.clientWidth-tip.offsetWidth-8)+'px';tip.style.top='34px';}
    hit.addEventListener('pointermove',show);hit.addEventListener('focus',show);
    hit.addEventListener('pointerleave',function(){tip.style.display='none';});hit.addEventListener('blur',function(){tip.style.display='none';});
  });
  wrap.appendChild(svg);
  // tabela (acessível, sem depender do hover)
  const det=el('details');det.appendChild(el('summary',null,'Ver tabela'));const tb=el('table','ttab');
  const hr=el('tr');['Período','Vendas','Faturado'].forEach(function(h){hr.appendChild(el('th',null,h));});tb.appendChild(hr);
  days.filter(function(d){return d.n;}).forEach(function(d){const tr=el('tr');tr.appendChild(el('td',null,lbl(d)));tr.appendChild(el('td',null,String(d.n)));tr.appendChild(el('td',null,brlC(d.cents)));tb.appendChild(tr);});
  det.appendChild(tb);card.appendChild(det);
  return card;
}
function lbl(d){return d.date.length===7?(d.date.slice(5,7)+'/'+d.date.slice(0,4)):(d.date.slice(8,10)+'/'+d.date.slice(5,7));}
function short(d){return d.date.length===7?d.date.slice(5,7)+'/'+d.date.slice(2,4):d.date.slice(8,10)+'/'+d.date.slice(5,7);}
function compactBRL(c){const v=c/100;return v>=1000?('R$'+(v/1000).toFixed(v>=10000?0:1).replace('.',',')+'k'):('R$'+Math.round(v));}
function prodRank(list){
  const card=el('div','ccard');card.appendChild(el('h4',null,'Produtos mais vendidos'));
  card.appendChild(el('p','sub','por faturamento no período'));
  if(!list.length){card.appendChild(el('p','sub','Sem vendas no período'));return card;}
  const top=list.slice(0,8),max=top[0].cents||1,box=el('div','rank');
  top.forEach(function(p){const r=el('div','rk'),t=el('div','top');t.appendChild(el('span',null,p.nome));
    t.appendChild(el('span',null,brlC(p.cents)+' · '+p.n+(p.n===1?' venda':' vendas')));r.appendChild(t);
    const tr=el('div','track'),b=el('div','bar');b.style.width=Math.max(1,p.cents/max*100)+'%';tr.appendChild(b);r.appendChild(tr);box.appendChild(r);});
  card.appendChild(box);
  if(list.length>8)card.appendChild(el('p','sub','+ '+(list.length-8)+' outros produtos'));
  return card;
}

render();
$$('smodal').onclick=function(e){if(e.target.id==='smodal')closeStars();};
loadStars();

</script>
</body></html>`);
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
const comOf = (o) => Math.max(0, profitCents(o.cents, o.prod_stars || 0)) * ((o.com_pct || 0) / 100);
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
    r.lucro += profitCents(o.cents, o.prod_stars || 0); r.comissao += c;
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
    const l = profitCents(o.cents, o.prod_stars || 0);
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

export { app, db, RISK, handleTgUpdate, entregaState, dailySummary, summaryTick, _setReceiptChecker, _setStarsReader, _setInvoiceChecker, _setInvoicePayer, conferir, autopay, syncStarsReal, loadProducts, PRODUCTS, adminFails, challenges, expirePending, deliveredEmail, sendMail, floorCents, profitCents };
