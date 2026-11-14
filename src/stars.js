// Stars: custo da Star (compras registradas), saldo (real da conta separada ou livro-caixa), entrega
// (markDelivered desconta a entrega), previsão de compra e as rotas do painel de Stars.
// STAR_NOW (custo atual) vive aqui: fora daqui, leia com starNow().
import { userConfig, readStarsBalance } from '../tg-user.js';
import { tgSend } from './telegram.js';

export function initStars({ env, db, PRODUCTS, brlTxt, orderEv, deliveredEmail, sendMail, emailCarrinho, tgEntregue }) {
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
const starsOf = (o) => o.prod_stars || PRODUCTS[o.product]?.stars || 0;
// ---------- Saldo de Stars (livro-caixa manual) ----------
// O saldo real da conta do operador não é legível por API (Bot API só vê o saldo do bot; ler a conta
// exigiria sessão do Telegram no servidor — recusado no contexto.md). Então: entrega desconta sozinha,
// "confere o saldo" (ou a leitura real da conta faz isso sozinha). Compras de Stars NÃO entram aqui: ficam em
// stars_purchases, só para o custo — nunca alteram o saldo.
const STARS_LOW = Number(env.STARS_LOW ?? 1500); // abaixo disso: aviso de saldo baixo (pico de 11/11/2026: 2.946★ num dia; 1.500 ≈ meio dia de pico)
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
      + (prej.length ? `\n⚠️ Vendendo NO PREJUÍZO com o custo novo: ${prej.join('; ')}. Ajuste os preços no painel.` : ''), 'resumo');
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
  if (o.carrinho_id) emailCarrinho(o.carrinho_id); // carrinho: um e-mail só, quando todos os itens terminarem
  else { const m = deliveredEmail(o); sendMail(o.email, m.subject, m.html, m.text); } // em segundo plano
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
const starNow = () => STAR_NOW;

// rotas do painel (registradas pelo server.js na posição de antes; dependem do autopay, criado depois)
function rotasStars({ app, admin, guard, chkOn, autopayOn, autopayMode, autopayMax, autopayDay, autopay24 }) {
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
}

return { STAR_COST, MP_FEE, costCents, floorCents, profitCents, orderProfit, starNow, starsOf, STARS_LOW, refreshStarCost, starsSaldo, starsFila,
  REAL, realOn, realFresh, starsEff, syncStarsReal, sessionDown, _setStarsReader, starsShortMsg, markDelivered, starsForecast, fcLine, rotasStars };
}
