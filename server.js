import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import { migrate } from './src/db.js';
import { invoicePaid } from './tg-user.js';
import { initLogin } from './src/login.js';
import { initEmail } from './src/email.js';
import { painelHtml } from './views/painel.js';
import { homeHtml, pageHtml } from './seo-home.js';
import { initParceiros } from './src/parceiros.js';
import { tgApi, tgSend, hhmmSP, initAvisos, orderDest } from './src/telegram.js';
import { initMercadoPago } from './src/mercadopago.js';
import { initAutopay } from './src/autopay.js';
import { initStars } from './src/stars.js';
import { initCheckout } from './src/checkout.js';
import { initCarrinho } from './src/carrinho.js';

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
// esquema do banco: migrações numeradas em src/db.js (PRAGMA user_version)
migrate(db, { starCost: Number(env.STAR_COST_BRL || 0.0875) });

if (db.prepare('SELECT COUNT(*) n FROM products').get().n === 0) {
  const ins = db.prepare('INSERT INTO products (key,nome,cents,stars,code,tipo,niveis,ativo,sort) VALUES (?,?,?,?,?,?,?,?,?)');
  SEED_PRODUCTS.forEach((p, i) => ins.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], i));
}

// mesmo objeto sempre (os módulos recebem a referência): recarregar limpa e preenche no lugar
const PRODUCTS = {};
function loadProducts() {
  for (const k of Object.keys(PRODUCTS)) delete PRODUCTS[k];
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
// ---- Stars (custo, saldo, entrega, previsão, rotas do painel de Stars): src/stars.js ----
// (brlTxt/orderEv/deliveredEmail/sendMail/tgEntregue são declarados mais abaixo: vão como funções que repassam)
const { floorCents, profitCents, orderProfit, starNow, starsOf, STARS_LOW, refreshStarCost, starsFila, REAL, realOn, starsEff,
  syncStarsReal, sessionDown, _setStarsReader, starsShortMsg, markDelivered, starsForecast, fcLine, rotasStars } = initStars({ env, db, PRODUCTS,
  brlTxt: (c) => brlTxt(c), orderEv: (...a) => orderEv(...a), deliveredEmail: (o) => deliveredEmail(o), sendMail: (...a) => sendMail(...a), emailCarrinho: (cid) => emailCarrinho(cid),
  tgEntregue: (...a) => tgEntregue(...a) });
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

// Registro de alterações de cupons, faixas e pagamentos (code '*' = faixas padrão). Nunca guarda Pix nem e-mail.
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

// Vitrine: categorias nesta ordem e, dentro de cada uma, do mais barato ao mais caro (produto novo entra no lugar certo sozinho);
// em Battle Pass, o Gold Pass vem antes dos níveis (pedido do operador)
const CATEGORIAS = ['Coins', 'Coleções', 'Battle Pass', 'Arsenal Pass'];
function categoria(p) {
  if (p.tipo === 'wildfire') return 'Coleções';
  if (p.tipo === 'arsenal') return 'Arsenal Pass';
  if (p.tipo === 'gold' || p.niveis) return 'Battle Pass'; // Gold Pass e níveis de passe
  return 'Coins';
}
const ordemVitrine = (a, b) => CATEGORIAS.indexOf(categoria(a)) - CATEGORIAS.indexOf(categoria(b))
  || (b.tipo === 'gold') - (a.tipo === 'gold') || a.cents - b.cents || a.nome.localeCompare(b.nome, 'pt-BR');

// Passe tem 100 níveis no jogo (a API do CounterFlame informa totalLevels 50; decisão do operador em 12/11/2026)
const BP_NIVEIS = 100;
// Arsenal Pass: os tickets são em sequência. Só o próximo da conta fica disponível (nenhum → Ticket 1; tem N → Ticket N+1;
// tem todos → nenhum) e só um por vez: com outro ticket já pago ou com Pix em aberto, nenhum fica disponível (decisão do operador, 12/11/2026).
// O nº vem do código do bot (ap_N) ou, se não der, do nome ("Ticket N"); sem nº, o ticket nunca é vendido.
function ticketNum(p) {
  const m = /^ap_(\d+)$/i.exec(p.code || '') || /ticket\s*(\d+)/i.exec(p.nome || '');
  return m ? Number(m[1]) : null;
}
const ticketEmCurso = (gameId) => db.prepare(`SELECT COUNT(*) n FROM orders o JOIN products p ON p.key=o.product
  WHERE o.game_id=? AND o.status IN ('pending','paid') AND p.tipo='arsenal'`).get(String(gameId)).n > 0;
function arsenalReason(p, d, gameId) {
  const ap = d.arsenalPass;
  if (!ap || !Number.isInteger(ap.tickets) || !Number.isInteger(ap.maxTickets)) return 'Não foi possível conferir o Arsenal Pass dessa conta. Fale com o suporte.';
  if (ap.tickets >= ap.maxTickets) return 'Essa conta já tem todos os tickets do Arsenal Pass.';
  if (ticketNum(p) !== ap.tickets + 1) return `Para essa conta, o próximo é o Ticket ${ap.tickets + 1}.`;
  if (gameId != null && ticketEmCurso(gameId)) return 'Essa conta já tem um ticket do Arsenal Pass em andamento. Aguarde a entrega (ou pague/cancele o Pix em aberto) antes do próximo.';
  return null;
}
// Níveis do passe: o nível do jogo + níveis já pagos/com Pix em aberto (ainda não entregues) nunca passam de BP_NIVEIS
const ehNivel = (p) => !!p.niveis && p.tipo !== 'arsenal';
const niveisEmCurso = (gameId) => db.prepare(`SELECT COALESCE(SUM(p.niveis),0) n FROM orders o JOIN products p ON p.key=o.product
  WHERE o.game_id=? AND o.status IN ('pending','paid') AND p.niveis>0 AND p.tipo<>'arsenal'`).get(String(gameId)).n;
// quantos níveis ainda cabem na conta (null = a API não informou o passe)
function niveisLivres(d, gameId) {
  const lv = d.battlePass?.level;
  if (!Number.isInteger(lv)) return null;
  return Math.max(0, BP_NIVEIS - lv - (gameId != null ? niveisEmCurso(gameId) : 0));
}
function blockReason(p, d, gameId) {
  const bp = d.battlePass;
  if (ehNivel(p)) {
    const livres = niveisLivres(d, gameId);
    if (livres === null) return 'Não foi possível conferir o passe dessa conta. Fale com o suporte.';
    if (p.niveis > livres) return livres ? `Essa conta só pode receber mais ${livres} nível(is) do passe.` : 'Essa conta já está no nível máximo do passe.';
  }
  if (p.tipo === 'gold' && bp?.gold) return 'Essa conta já tem o Gold Pass.';
  if (p.tipo === 'arsenal') { const why = arsenalReason(p, d, gameId); if (why) return why; }
  if (p.tipo === 'wildfire' && d.wildfireLevel > 0) return 'Essa conta já tem progresso na Wildfire. Fale com o suporte.';
  return null;
}

// Carrinho: além das regras de cada item, as regras do conjunto (o jogo aplica tudo na mesma conta).
// Repetir o mesmo item só vale para Coins e níveis do passe (decisão do operador, 12/11/2026).
const CARRINHO_MAX = 10;
const repetivel = (p) => !p.tipo; // Coins e níveis (tipo '')
function blockReasonCarrinho(itens, d, gameId) {
  for (const p of itens) { const why = blockReason(p, d, gameId); if (why) return `${p.nome}: ${why}`; }
  const vistos = new Set();
  for (const p of itens) {
    if (!repetivel(p) && vistos.has(p.key)) return `${p.nome} só pode entrar uma vez no carrinho.`;
    vistos.add(p.key);
  }
  if (itens.filter((p) => p.tipo === 'gold').length > 1) return 'O Gold Pass só pode entrar uma vez no carrinho.';
  const niveis = itens.reduce((a, p) => a + (ehNivel(p) ? p.niveis : 0), 0);
  const livres = niveisLivres(d, gameId);
  if (niveis && livres !== null && niveis > livres) return `Essa conta só pode receber mais ${livres} nível(is) do passe e o pedido tem ${niveis}.`;
  if (itens.filter((p) => p.tipo === 'arsenal').length > 1) return 'Só um ticket do Arsenal Pass por pedido.';
  return null;
}

// Limites em 24h acompanham o produto mais caro (lê o catálogo atual a cada uso; fica aqui porque PRODUCTS é recarregável)
const maxPriceCents = () => Math.max(0, ...Object.values(PRODUCTS).filter((p) => p.ativo).map((p) => p.cents || 0));
// ---- Mercado Pago: antifraude, reembolso e sincronização do pagamento: src/mercadopago.js ----
// (notifyPaid/tgAviso/refundKb/orderEv/avisoFaixa/brlTxt são declarados mais abaixo: vão como funções que repassam)
const { RISK, lc, fp, isBlocked, orderBlocked, unblockClient, paid24, riskOf, podeReembolsar, reembolsar, _setRefundCaller, bloqAuto, syncPayment } = initMercadoPago({ env, MP_URL, db, findOrder, mpHeaders, chkOf: (o) => chkOf(o),
  brlTxt: (c) => brlTxt(c), notifyPaid: (o) => notifyPaid(o), tgAviso: (...a) => tgAviso(...a), refundKb: (o) => refundKb(o),
  orderEv: (...a) => orderEv(...a), avisoFaixa: (o) => avisoFaixa(o), maxPriceCents: () => maxPriceCents(), emailCarrinho: (cid) => emailCarrinho(cid) });
const brlTxt = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
// ---------- Entrega assistida pelo Telegram ----------
// Aviso de pago vem com botões: abrir o bot do CounterFlame já com produto+ID, e "Já entreguei"
// (pede confirmação). Só o operador (TG_CHAT_ID) pode usar os botões. Lê os toques por long polling
// (getUpdates) — sem webhook, sem endpoint público novo.
const donateLink = (o) => {
  const code = o.prod_code || PRODUCTS[o.product]?.code;
  return code ? `https://t.me/CounterFlameDonate_bot?start=s_${code}_${o.game_id}` : '';
};
// ---------- Pagamento automático (conferência, 1 toque, entrega automática): src/autopay.js ----------
let receiptChecker = invoicePaid;            // trocável nos testes
const _setReceiptChecker = (fn) => { receiptChecker = fn || invoicePaid; };
// (paidKeyboard/tgFalha/paidText/tgIncerto/setMotivo/stopping são declarados mais abaixo: vão como funções que repassam)
const { vigiaPagamentos, resolverIncerto, conferirAtraso, chkOn, _setInvoiceChecker, _setInvoicePayer, getSetting, setSetting, autopayMode, autopayOn, autoMode, autopayMax, autopayDay, autopay24, canAutopay, canApprove, carrinhoAprovavel, aprovarCarrinho, autopay, chkOf, chkLine, conferir, saldoLine } = initAutopay({ env, db, PRODUCTS, riskOf, starsOf, STARS_LOW, starsFila, REAL, starsEff, syncStarsReal,
  sessionDown, markDelivered, paidKeyboard: (o) => paidKeyboard(o), tgFalha: (...a) => tgFalha(...a), paidText: (o) => paidText(o),
  tgIncerto: (...a) => tgIncerto(...a), setMotivo: (...a) => setMotivo(...a), stopping: () => stopping, getPlayer, ticketNum, BP_NIVEIS, receiptOf: (m, e) => receiptChecker(m, e) });
// ---- Avisos de pedido no Telegram (mensagem, botões, edições, toques): src/telegram.js ----
const { refundKb, tgDesbloqueado, paidKeyboard, handleTgUpdate, tgPoll, paidText, tgEntregue, tgAviso, notifyPaid, tgIncerto, tgFalha } = initAvisos({ db, riskOf, podeReembolsar, reembolsar, bloqAuto, brlTxt, donateLink, starsOf, starsShortMsg, markDelivered, canAutopay, canApprove, carrinhoAprovavel, aprovarCarrinho, autopay, chkOf, chkLine, conferir, saldoLine });
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

// ---- Login do painel (senha + código pelo Telegram, sessão, anti-brute-force, middleware admin): src/login.js ----
const { admin, getCookie, adminFails, challenges, rotasLogin } = initLogin({ env, db, safeEq, limit });

// ---- E-mail ao cliente (Resend; e-mail de pedido entregue): src/email.js ----
const { sendMail, deliveredEmail, carrinhoEntregueEmail } = initEmail({ env, PRODUCTS, esc });
// Carrinho: um e-mail só, quando nenhum item está mais pendente/pago (todos entregues, ou parte entregue e o resto
// cancelado/devolvido). Chamado na entrega, no reembolso e na varredura de 5 min; a marca no carrinho garante 1 envio.
function emailCarrinho(cid) {
  const its = db.prepare('SELECT * FROM orders WHERE carrinho_id=? ORDER BY id').all(cid);
  if (!its.length || its.some((o) => ['pending', 'paid'].includes(o.status)) || !its.some((o) => o.status === 'delivered')) return false;
  if (!db.prepare('UPDATE carrinhos SET mail_entregue=? WHERE id=? AND mail_entregue IS NULL').run(Date.now(), cid).changes) return false;
  const car = db.prepare('SELECT * FROM carrinhos WHERE id=?').get(cid);
  const m = carrinhoEntregueEmail(car, its);
  sendMail(car.email, m.subject, m.html, m.text); // em segundo plano
  return true;
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
// imagem da prévia do cupom (gerada por node docs/kit/gen-og.mjs --cupons): só se existir para ESTE desconto
const ogCupom = (c) => {
  const f = `og-cupom/${c.code.toLowerCase()}-${String(c.desconto_pct).replace('.', '_')}.jpg`;
  return /^og-cupom\/[a-z0-9_-]+\.jpg$/.test(f) && fs.existsSync(path.join('public', 'img', f)) ? `${SITE_URL}/img/${f}` : null;
};
const prodsPublic = () => Object.entries(PRODUCTS).filter(([, p]) => p.ativo).sort(([, a], [, b]) => ordemVitrine(a, b))
  .map(([key, p]) => ({ key, nome: p.nome, cents: p.cents, stars: p.stars, cat: categoria(p), img: p.img || `/img/${key}.jpg`, rep: repetivel(p), nv: ehNivel(p) ? p.niveis : 0 }));
app.get(['/', '/index.html'], (req, res) => {
  const home = homeHtml(INDEX_HTML, prodsPublic());
  const c = req.query.cupom ? getCoupon(req.query.cupom) : null;
  if (!c) return res.type('html').set('Cache-Control', 'no-cache').send(home);
  const t = c.desconto_pct > 0 ? `${String(c.desconto_pct).replace('.', ',')}% OFF com o cupom ${c.code} — Recarga Flame` : `Cupom ${c.code} — Recarga Flame`;
  const d = `Coins e passes do CounterFlame no Pix com o cupom ${c.code}. Entrega automática em até 10 minutos, só com o ID da conta.`;
  const img = ogCupom(c);
  let html = home
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(t)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(d)}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${SITE_URL}/?cupom=${encodeURIComponent(c.code)}">`);
  if (img) {
    html = html.replace(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${esc(img)}">`)
      .replace(/<meta property="og:image:alt" content="[^"]*">/, `<meta property="og:image:alt" content="${esc(t)}">`);
  }
  res.type('html').set('Cache-Control', 'no-cache').send(html);
});
// páginas de conteúdo (SEO); a de Coins recebe a tabela de preços dos produtos ativos
const PAGES_SEO = Object.fromEntries(['onde-encontrar-id-counterflame', 'comprar-coins-counterflame', 'gold-pass-counterflame', 'colecao-wildfire-counterflame', 'item-nao-chegou-counterflame', 'e-seguro-comprar-coins-counterflame']
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
    const why = blockReason(p, player, req.params.id);
    if (why) blocked[key] = why;
  }
  // niveis: quantos níveis do passe ainda cabem (a loja trava o carrinho nisso; null = desconhecido, o servidor decide)
  res.json({ nickname: player.nickname, avatar: `/api/player/${encodeURIComponent(req.params.id)}/avatar`, blocked, niveis: niveisLivres(player, req.params.id) });
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

// ---- Checkout (pedido + Pix, status, cancelar, webhook do MP, lembretes/expiração do Pix): src/checkout.js ----
// (orderEv é declarado mais abaixo: vai como função que repassa)
const { remindPending, expirePending, criarPix, emailRecusado, pixAbertos, cancelarPendente } = initCheckout({ env, db, app, PRODUCTS, MP_URL, mpHeaders, limit, findOrder, getCoupon, priceWith, validId,
  getPlayer, blockReason, devOf, isBlocked, lc, RISK, paid24, fp, starNow, orderEv: (...a) => orderEv(...a), syncPayment, entregaState, safeEq,
  brlTxt, esc, sendMail, emailCarrinho: (cid) => emailCarrinho(cid) });
// ---- Carrinho (vários itens, um Pix; cada item é um pedido): src/carrinho.js ----
initCarrinho({ db, app, PRODUCTS, limit, getCoupon, priceWith, validId, getPlayer, blockReasonCarrinho, CARRINHO_MAX, devOf, isBlocked, lc, RISK,
  paid24, fp, starNow, orderEv: (...a) => orderEv(...a), syncPayment, entregaState, criarPix, emailRecusado, pixAbertos, cancelarPendente });

// ---------- Funil (estatística própria, sem serviço externo) ----------
// Etapas: visit → lookup (ID buscado) → select (item escolhido) → pix → paid → delivered.
// Contamos APARELHOS distintos (cookie aleatório cf_dev; sem cookie, IP embaralhado). Robôs/prévias de link não
// rodam o JS da página, e agentes conhecidos de robô são ignorados.
const EV_CLIENT = new Set(['visit', 'lookup', 'select', 'cart']); // cart: pôs o 2º item no pedido
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
    tgSend(`📩 Suporte #${tid} — ${assunto}\nDe: ${email}\n${pedLine}\n\n${msg.slice(0, 600)}${msg.length > 600 ? '…' : ''}\n\nResponda pelo e-mail (Gmail).`, 'suporte'),
  ]);
  db.prepare('UPDATE support_tickets SET mail_ok=?, tg_ok=? WHERE id=?').run(mailOk ? 1 : 0, tgOk ? 1 : 0, tid);
  if (!mailOk && !tgOk) return res.status(502).json({ error: `Não conseguimos enviar agora. Tente de novo em instantes ou escreva para ${SUPPORT_TO}.` });
  res.json({ ok: true, id: tid });
});

rotasLogin(app); // /login, /login/senha, /login/codigo, /logout: src/login.js

function painelOrders() {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  // carrinho: posição de cada item ("2/3") e quantos itens dá para aprovar juntos
  const carIds = {};
  for (const o of rows.slice().reverse()) if (o.carrinho_id) (carIds[o.carrinho_id] ||= []).push(o.id);
  const aprov = {};
  return rows.map((o) => {
    const ids = o.carrinho_id ? carIds[o.carrinho_id] : null;
    if (o.carrinho_id && o.status === 'paid' && !(o.carrinho_id in aprov)) aprov[o.carrinho_id] = carrinhoAprovavel(o.carrinho_id).length;
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
      car: ids ? { id: o.carrinho_id, pos: ids.indexOf(o.id) + 1, n: ids.length, aprov: aprov[o.carrinho_id] || 0 } : null,
    };
  });
}
app.get('/api/admin/orders', admin, (req, res) => res.json(painelOrders()));
rotasStars({ app, admin, guard, chkOn, autopayOn, autopayMode, autopayMax, autopayDay, autopay24 });
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
// carrinho em REVISAR: aprova uma vez e paga os itens que podem ser pagos (tetos/saldo conferidos com a soma)
app.post('/api/admin/carrinhos/:id/aprovar', admin, async (req, res) => {
  if (!guard(req, res)) return;
  const r = await aprovarCarrinho(Number(req.params.id));
  res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: r.why });
});
app.post('/api/admin/orders/:id/autopay', admin, async (req, res) => {
  if (!guard(req, res)) return;
  const r = await autopay(Number(req.params.id));
  res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: r.why });
});
// ---------- Resumo diário no Telegram (00h, horário de Brasília: o dia que acabou de terminar, inteiro) ----------
const spDay = (ms = Date.now()) => new Date(ms - 3 * 3600_000).toISOString().slice(0, 10); // dia local (UTC-3)
function dailySummary(day = spDay()) {
  const L = (col) => `date(${col}, '-3 hours')`;
  const vendas = db.prepare(`SELECT o.*, o.com_pct AS comissao_pct FROM orders o
    WHERE o.paid_at IS NOT NULL AND o.status IN ('paid','delivered') AND ${L('o.paid_at')} = ?`).all(day);
  let fat = 0, lucro = 0, com = 0;
  const pctOf = makePartnerCtx().pctOf;
  for (const o of vendas) {
    const l = orderProfit(o), c = o.coupon ? Math.max(0, l) * (pctOf(o) / 100) : 0;
    fat += o.cents; lucro += l - c; com += c;
  }
  // comissões: as do dia (estimadas: no plano de metas a faixa do mês ainda pode subir) e o total a reservar (= quadro do painel)
  const reserva = reservaAtual();
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
    com > 0 || reserva.total > 0 ? `🤝 Comissões do dia ${brlTxt(Math.round(com))} (estimado) · reserva total ${brlTxt(reserva.total)}` : null,
    fila ? `⏳ ${fila} pedido${fila === 1 ? '' : 's'} na fila agora${problemas ? ` (🚨 ${problemas} incerto${problemas === 1 ? '' : 's'})` : ''}` : '✅ Fila vazia',
    `⭐ ${gastoDia}★ gastos no dia · saldo ${e.n ? e.s + '★' : 'não configurado'}`
      + (autonomia != null ? ` · dura ~${autonomia < 1 ? 'menos de 1 dia' : Math.floor(autonomia) + (Math.floor(autonomia) === 1 ? ' dia' : ' dias')} no ritmo atual (${Math.round(porDia)}★/dia)` : '')
      + (e.n && e.s < STARS_LOW ? ' · 🔻 BAIXO' : ''),
    estornos ? `⚠️ ${estornos} estorno/cancelamento após pagamento nos últimos 7 dias` : null,
    fcLine(starsForecast()),
  ].filter(Boolean).join('\n');
}
// dispara 1x por dia logo após a meia-noite com o resumo do dia anterior (sobrevive a reinício: guarda o último dia resumido)
function summaryTick() {
  const ontem = spDay(Date.now() - 86_400_000);
  if (getSetting('summary_day', '') >= ontem) return;
  setSetting('summary_day', ontem);
  tgSend(dailySummary(ontem), 'resumo');
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
    if (cur.tg_msg) tgApi('editMessageText', { chat_id: orderDest(cur).chat_id, message_id: cur.tg_msg, disable_web_page_preview: true,
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
  // painel: só scripts do próprio site (sem script embutido nem onclick no HTML) — um nick/e-mail malicioso
  // que escapasse do escape não executa nada aqui
  res.set('Content-Security-Policy', PAINEL_CSP);
  res.send(painelHtml(data));
});

// JS do painel: só com sessão (quem não entrou não vê o código do painel)
const PAINEL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
const PAINEL_JS = fs.readFileSync(path.join('views', 'painel.client.js'), 'utf8');
app.get('/painel/app.js', admin, (req, res) => {
  res.set('Cache-Control', 'private, no-cache');
  res.type('application/javascript').send(PAINEL_JS);
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
      return { ...r, cat: categoria(r), ativo: !!r.ativo, img: r.img || `/img/${r.key}.jpg`, lucro: Math.round(l), margem: r.cents ? l / r.cents : 0 };
    }).sort(ordemVitrine); // mesma ordem da loja
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
const { makePartnerCtx, freezeClosedMonths, freezeTick, avisoFaixa, fechamentoMsg, fechamentoTick, primeiroDiaUtil, enviarExtratos, extratoEmail, reservaAtual } = initParceiros({ env, db, app, admin, guard, limit, orderProfit, normCode, RESERVED_CODES, validCode, logCup, tiersTxtS, diffCup, SITE_URL, esc, brlTxt, REAL, getSetting, setSetting, tgSend, sendMail });
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
  // Pix gerados/pagos: um carrinho (vários itens) é um Pix só
  const gen = db.prepare(`SELECT COUNT(DISTINCT COALESCE('c' || carrinho_id, 'o' || id)) n,
    COUNT(DISTINCT CASE WHEN paid_at IS NOT NULL THEN COALESCE('c' || carrinho_id, 'o' || id) END) pagos FROM orders
    WHERE mp_id IS NOT NULL AND ${local('created_at')} BETWEEN ? AND ?`).get(from, to);
  // carrinhos vendidos no período (itens vendidos que vieram de carrinho)
  const carSet = new Set(ok.filter((o) => o.carrinho_id).map((o) => o.carrinho_id));
  const itensCar = ok.filter((o) => o.carrinho_id);
  const carrinhos = { n: carSet.size, itens: itensCar.length, cents: itensCar.reduce((a, o) => a + o.cents, 0),
    compras: ok.length - itensCar.length + carSet.size };
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
  const funil = { etapas, cupons: grupo('coupon'), origens: grupo('src'), carrinho: uniq(evRows, 'cart') };
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
    pixGerados: gen.n || 0, pixPagos: gen.pagos || 0, carrinhos,
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
  // endereço malformado (robôs testando %c0 etc.) ou JSON inválido: erro do cliente, uma linha no log em vez do stack
  if (err?.status >= 400 && err.status < 500) {
    console.error(`Requisição inválida ${err.status}: ${req.method} ${String(req.originalUrl).slice(0, 120)} (${err.message})`);
    return res.status(err.status).json({ error: 'Requisição inválida.' });
  }
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

// ---------- Erros não tratados ----------
// Promise rejeitada sem catch: no Node 24 derrubaria o processo (e um pagamento em andamento viraria "incerto").
// Registra, avisa no tópico Sistema (no máximo 1 aviso a cada 10 min) e segue no ar.
// Exceção não capturada: o estado do processo não é confiável — registra, avisa e sai pelo desligamento seguro
// (espera o pagamento em andamento); o pm2 sobe de novo.
let ultimoAvisoErro = 0;
function erroNaoTratado(tipo, e, { agora = Date.now(), forcar = false } = {}) {
  console.error(`${tipo}:`, e);
  if (!forcar && agora - ultimoAvisoErro < 10 * 60_000) return false;
  ultimoAvisoErro = agora;
  const msg = String(e?.stack || e?.message || e).split('\n').slice(0, 3).join('\n').slice(0, 300);
  tgSend(`🐞 Erro não tratado na loja (${tipo}):\n${msg}\n\nDetalhes: pm2 logs cf-teste --err`, 'sistema').catch(() => {});
  return true;
}

// Sobe o servidor só quando executado diretamente (não durante os testes).
if (process.env.NODE_ENV !== 'test') {
  // Só aceita conexões da própria máquina (nginx). Ninguém fala com o Node direto,
  // mesmo se o firewall mudar — assim não dá pra forjar X-Forwarded-For e burlar rate limits.
  const server = app.listen(env.PORT || 3000, '127.0.0.1', () => console.log('Loja no ar'));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => gracefulStop({ server }));
  process.on('unhandledRejection', (e) => erroNaoTratado('unhandledRejection', e));
  process.on('uncaughtException', (e) => { erroNaoTratado('uncaughtException', e, { forcar: true }); setTimeout(() => gracefulStop({ server, exit: (c) => process.exit(c || 1) }), 1500); });
  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) tgPoll(); // botões do aviso de pago
  if (realOn()) { syncStarsReal(true); setInterval(() => syncStarsReal(true), 5 * 60_000); } // saldo real a cada 5 min
  setInterval(summaryTick, 60_000); // resumo diário à 00h (do dia que terminou)
  // virada do mês: congela as faixas do mês fechado; 1º dia útil: comissões a pagar no Telegram
  setInterval(() => { try { freezeTick(); fechamentoTick(); } catch (e) { console.error('fechamento', e.message); } }, 60_000);
}

refreshStarCost(false); // custo por Star a partir das recargas (depois de tudo declarado)

export { vigiaPagamentos, erroNaoTratado, gracefulStop, _resetStopping, app, db, makePartnerCtx, freezeClosedMonths, fechamentoMsg, fechamentoTick, primeiroDiaUtil, enviarExtratos, extratoEmail, _setRefundCaller, reembolsar, remindPending, starsForecast, riskOf, RISK, refreshStarCost, handleTgUpdate, entregaState, dailySummary, summaryTick, _setReceiptChecker, _setStarsReader, _setInvoiceChecker, _setInvoicePayer, conferir, autopay, resolverIncerto, conferirAtraso, syncStarsReal, loadProducts, PRODUCTS, adminFails, challenges, expirePending, deliveredEmail, sendMail, floorCents, profitCents };
