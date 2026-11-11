// Parceiros: cupons no painel, plano de metas (comissão por faixa), fechamento mensal, extrato por e-mail
// e página privada do parceiro. Separado do server.js sem mudar o código: o server chama initParceiros no mesmo
// ponto em que este trecho ficava (cria as tabelas e registra as rotas na mesma ordem) e passa o que é compartilhado.
// O corpo fica sem recuo extra de propósito: é o trecho original do server.js, linha por linha.
import crypto from 'node:crypto';

export function initParceiros({ env, db, app, admin, guard, limit, orderProfit, normCode, RESERVED_CODES, validCode, logCup, tiersTxtS, diffCup, SITE_URL, esc, brlTxt, REAL, getSetting, setSetting, tgSend, sendMail }) {
// ---- Cupons (painel) ----
function parseCoupon(b, codeFixed) {
  const code = normCode(codeFixed ?? b.code);
  const desconto = Number(b.desconto_pct);
  const comissao = Number(b.comissao_pct);
  if (!validCode(code)) return { err: 'Código inválido (A-Z, 0-9, _ ou -, 3 a 20 caracteres).' };
  if (codeFixed == null && RESERVED_CODES.has(code)) return { err: `O código ${code} é reservado (é uma página do site, o link curto não funcionaria). Escolha outro.` };
  if (!Number.isFinite(desconto) || desconto < 0 || desconto > 50) return { err: 'Desconto deve ser de 0 a 50%.' };
  if (!Number.isFinite(comissao) || comissao < 0 || comissao > 100) return { err: 'Comissão deve ser de 0 a 100% do lucro.' };
  const plano = b.plano === 'fixo' ? 'fixo' : 'metas';
  const ids = String(b.ids_proprios || '').split(/[\s,;]+/).filter(Boolean);
  if (ids.some((x) => !/^\d{1,12}$/.test(x)) || ids.length > 20) return { err: 'IDs do próprio parceiro: só números, separados por vírgula (até 20).' };
  let tiers = null; // faixas próprias do parceiro; null = usa as padrão
  if (b.tiers) {
    const t = (typeof b.tiers === 'string' ? JSON.parse(b.tiers) : b.tiers).map((x) => ({ min: Math.round(Number(x.min)), pct: Number(x.pct) }));
    if (!validTiers(t)) return { err: 'Faixas do parceiro inválidas: a 1ª começa em R$ 0; metas e % crescentes; de 1 a 6 faixas.' };
    tiers = JSON.stringify(t);
  }
  const txt = (v, n) => String(v ?? '').trim().slice(0, n);
  const parceiro = { parceiro_nome: txt(b.parceiro_nome, 80), parceiro_canal: txt(b.parceiro_canal, 80), parceiro_pix: txt(b.parceiro_pix, 120), parceiro_email: txt(b.parceiro_email, 120).toLowerCase() };
  if (parceiro.parceiro_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parceiro.parceiro_email)) return { err: 'E-mail do parceiro inválido.' };
  return { code, desconto_pct: desconto, comissao_pct: comissao, ativo: b.ativo ? 1 : 0, nota: String(b.nota || '').trim().slice(0, 80), plano, ids_proprios: ids.join(', '), tiers, ...parceiro };
}
app.get('/api/admin/coupons', admin, (req, res) => {
  res.json(db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all().map((c) => ({ ...c, ativo: !!c.ativo })));
});
app.post('/api/admin/coupons', admin, (req, res) => {
  if (!guard(req, res)) return;
  let c;
  try { c = parseCoupon(req.body ?? {}); } catch { return res.status(400).json({ error: 'Faixas do parceiro inválidas.' }); }
  if (c.err) return res.status(400).json({ error: c.err });
  if (db.prepare('SELECT 1 FROM coupons WHERE code=?').get(c.code)) return res.status(409).json({ error: 'Já existe um cupom com esse código.' });
  db.prepare(`INSERT INTO coupons (code, desconto_pct, comissao_pct, ativo, nota, plano, ids_proprios, tiers, ptoken, parceiro_nome, parceiro_canal, parceiro_pix, parceiro_email)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(c.code, c.desconto_pct, c.comissao_pct, c.ativo, c.nota, c.plano, c.ids_proprios, c.tiers, crypto.randomBytes(18).toString('base64url'),
      c.parceiro_nome, c.parceiro_canal, c.parceiro_pix, c.parceiro_email);
  logCup(c.code, `criado: desconto ${String(c.desconto_pct).replace('.', ',')}%, plano ${c.plano}${c.tiers ? ', faixas próprias' : ''}${c.ativo ? '' : ', inativo'}`);
  res.json({ ok: true });
});
app.put('/api/admin/coupons/:code', admin, (req, res) => {
  if (!guard(req, res)) return;
  const atual = db.prepare('SELECT * FROM coupons WHERE code=?').get(normCode(req.params.code));
  if (!atual) return res.status(404).json({ error: 'Cupom não encontrado.' });
  // campos que não vierem mantêm o valor atual (edição parcial nunca troca o plano sem querer)
  let c;
  const keep = { plano: atual.plano, ids_proprios: atual.ids_proprios, tiers: atual.tiers, parceiro_nome: atual.parceiro_nome, parceiro_canal: atual.parceiro_canal,
    parceiro_pix: atual.parceiro_pix, parceiro_email: atual.parceiro_email };
  try { c = parseCoupon({ ...keep, ...(req.body ?? {}) }, req.params.code); }
  catch { return res.status(400).json({ error: 'Faixas do parceiro inválidas.' }); }
  if (c.err) return res.status(400).json({ error: c.err });
  freezeClosedMonths(makePartnerCtx()); // meses fechados ficam com as faixas que valiam neles
  db.prepare(`UPDATE coupons SET desconto_pct=?, comissao_pct=?, ativo=?, nota=?, plano=?, ids_proprios=?, tiers=?,
    parceiro_nome=?, parceiro_canal=?, parceiro_pix=?, parceiro_email=? WHERE code=?`)
    .run(c.desconto_pct, c.comissao_pct, c.ativo, c.nota, c.plano, c.ids_proprios, c.tiers, c.parceiro_nome, c.parceiro_canal, c.parceiro_pix, c.parceiro_email, c.code);
  logCup(c.code, diffCup(atual, c));
  res.json({ ok: true });
});
// Excluir só cupom sem histórico: com venda paga/entregue ou pagamento registrado, o certo é desativar
// (a comissão e os pagamentos do parceiro dependem do cupom).
app.delete('/api/admin/coupons/:code', admin, (req, res) => {
  if (!guard(req, res)) return;
  const code = normCode(req.params.code);
  if (!db.prepare('SELECT 1 FROM coupons WHERE code=?').get(code)) return res.status(404).json({ error: 'Cupom não encontrado.' });
  const vendas = db.prepare("SELECT COUNT(*) n FROM orders WHERE coupon=? AND status IN ('paid','delivered')").get(code).n;
  const pagos = db.prepare('SELECT COUNT(*) n FROM coupon_payouts WHERE code=?').get(code).n;
  if (vendas || pagos) return res.status(409).json({ error: `O cupom ${code} tem ${vendas} venda(s) e ${pagos} pagamento(s) registrados. Para manter o histórico de comissões, desative em vez de excluir.` });
  db.transaction(() => {
    db.prepare('DELETE FROM partner_months WHERE code=?').run(code);
    db.prepare('DELETE FROM coupons WHERE code=?').run(code);
  })();
  logCup(code, 'excluído');
  res.json({ ok: true });
});
// ---------- Plano de metas dos parceiros ----------
// Comissão = % do LUCRO; a faixa sai do FATURAMENTO do parceiro no mês (vendas pagas/entregues, fora compras do
// próprio parceiro) e vale para TODAS as vendas do mês. Faixa garantida: quem atingiu uma faixa começa o mês
// seguinte uma faixa abaixo (só no mês seguinte). Meses fechados ficam congelados (partner_months), então editar
// as faixas não muda comissão passada. Cupom com plano 'fixo' usa o % do pedido (com_pct), como antes.
// parceiro_*: dados do parceiro para o acordo e o pagamento (só no painel; o Pix nunca vai para a página do parceiro)
const TIERS_DEF = [{ min: 0, pct: 30 }, { min: 150000, pct: 35 }, { min: 400000, pct: 40 }, { min: 1000000, pct: 45 }];
function getTiers() {
  try { const t = JSON.parse(getSetting('tiers', '')); if (validTiers(t)) return t; } catch { /* padrão */ }
  return TIERS_DEF;
}
function validTiers(t) {
  if (!Array.isArray(t) || t.length < 1 || t.length > 6 || t[0].min !== 0) return false;
  for (let i = 0; i < t.length; i++) {
    if (!Number.isInteger(t[i].min) || t[i].min < 0 || !(t[i].pct >= 0 && t[i].pct <= 100)) return false;
    if (i && (t[i].min <= t[i - 1].min || t[i].pct < t[i - 1].pct)) return false;
  }
  return true;
}
const curMes = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
const mesOf = (paidAt) => localDay(paidAt).slice(0, 7);
const prevMes = (m) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm - 2, 1)).toISOString().slice(0, 7); };
const tierIdx = (fat, tiers) => tiers.reduce((acc, t, k) => (fat >= t.min ? k : acc), 0);
const proprios = (c) => new Set(String(c?.ids_proprios || '').split(/[\s,;]+/).filter(Boolean));
// Contexto de cálculo (cache por requisição): faturamento por mês e faixa de cada mês de cada parceiro
function buildPartnerCtx() {
  const padrao = getTiers(), cur = curMes();
  const cupons = Object.fromEntries(db.prepare('SELECT * FROM coupons').all().map((c) => [c.code, c]));
  const cache = {};
  // faixas do parceiro: próprias (se definidas e válidas) ou as padrão
  const tiersOf = (code) => { try { const t = JSON.parse(cupons[code]?.tiers || 'null'); if (validTiers(t)) return t; } catch { /* padrão */ } return padrao; };
  const dados = (code) => {
    if (cache[code]) return cache[code];
    const c = cupons[code], own = proprios(c);
    const vendas = db.prepare(`SELECT * FROM orders WHERE coupon=? AND status IN ('paid','delivered') AND paid_at IS NOT NULL`).all(code)
      .filter((o) => !own.has(String(o.game_id)));
    const porMes = {};
    for (const o of vendas) { const m = mesOf(o.paid_at); porMes[m] = (porMes[m] || 0) + o.cents; }
    return (cache[code] = { c, own, vendas, porMes, info: {} });
  };
  const info = (code, mes) => {
    const d = dados(code);
    if (d.info[mes]) return d.info[mes];
    const tiers = tiersOf(code);
    let r = mes < cur ? db.prepare('SELECT ating, idx, pct FROM partner_months WHERE code=? AND mes=?').get(code, mes) : null;
    if (!r) {
      const ating = tierIdx(d.porMes[mes] || 0, tiers);
      const ant = prevMes(mes);
      // faixa ATINGIDA (por faturamento) no mês anterior: congelada se o mês já fechou
      const antAting = d.porMes[ant] ? (db.prepare('SELECT ating FROM partner_months WHERE code=? AND mes=?').get(code, ant)?.ating ?? tierIdx(d.porMes[ant], tiers)) : 0;
      const garant = d.porMes[ant] ? Math.max(0, antAting - 1) : 0;
      const idx = Math.max(ating, garant);
      r = { ating, idx, pct: tiers[idx].pct, garant };
      if (mes < cur) db.prepare('INSERT OR IGNORE INTO partner_months (code, mes, ating, idx, pct) VALUES (?,?,?,?,?)').run(code, mes, ating, idx, r.pct);
    }
    return (d.info[mes] = r);
  };
  // % de comissão de um pedido (0 se for compra do próprio parceiro)
  const pctOf = (o) => {
    if (!o.coupon) return 0;
    const c = cupons[o.coupon];
    if (!c || c.plano === 'fixo') return o.com_pct || 0;
    if (proprios(c).has(String(o.game_id))) return 0;
    return info(o.coupon, mesOf(o.paid_at)).pct;
  };
  return { tiers: padrao, tiersOf, cur, cupons, dados, info, pctOf };
}
// Contexto de cálculo; antes, aplica faixas padrão agendadas cujo mês chegou.
function makePartnerCtx() { rollTiers(); return buildPartnerCtx(); }
const nextMes = (m) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm, 1)).toISOString().slice(0, 7); };
// Faixas padrão agendadas para um mês futuro (settings.tiers_next = {mes, tiers}); null se não houver.
function tiersNext() {
  try { const n = JSON.parse(getSetting('tiers_next', 'null')); if (n && /^\d{4}-\d{2}$/.test(n.mes) && validTiers(n.tiers)) return n; } catch { /* nada agendado */ }
  return null;
}
// Chegou o mês das faixas agendadas: congela os meses fechados com as faixas ANTIGAS e só então troca.
function rollTiers() {
  const n = tiersNext();
  if (!n || curMes() < n.mes) return;
  freezeClosedMonths(buildPartnerCtx());
  setSetting('tiers', JSON.stringify(n.tiers));
  db.prepare("DELETE FROM settings WHERE k='tiers_next'").run();
  logCup('*', `faixas agendadas entraram em vigor em ${nomeMesBR(n.mes)}: ${tiersTxtS(n.tiers)}`);
}
// Grava (partner_months) a faixa de todo mês fechado com venda que ainda não foi gravado, do mais antigo
// para o mais novo (a faixa garantida de um mês depende do anterior). Mês gravado não muda mais.
function freezeClosedMonths(ctx) {
  for (const c of Object.values(ctx.cupons)) {
    if (c.plano === 'fixo') continue;
    for (const m of Object.keys(ctx.dados(c.code).porMes).sort()) if (m < ctx.cur) ctx.info(c.code, m);
  }
}
// Na virada do mês: congela o mês que fechou com as faixas que valiam nele.
function freezeTick() {
  const m = curMes();
  if (getSetting('frozen_mes', '') === m) return;
  freezeClosedMonths(makePartnerCtx());
  setSetting('frozen_mes', m);
}
// resumo do mês atual de um parceiro do plano de metas (para painel, página do parceiro e aviso de faixa)
function mesAtual(ctx, code) {
  const d = ctx.dados(code), m = ctx.cur, inf = ctx.info(code, m);
  const fat = d.porMes[m] || 0;
  const doMes = d.vendas.filter((o) => mesOf(o.paid_at) === m);
  const comissao = Math.round(doMes.reduce((a, o) => a + Math.max(0, orderProfit(o)) * inf.pct / 100, 0));
  const tiers = ctx.tiersOf(code);
  const prox = tiers[inf.idx + 1] || null;
  return { mes: m, vendas: doMes.length, faturamento: fat, pct: inf.pct, idx: inf.idx, ating: inf.ating, garant: inf.garant,
    garantidaPct: inf.garant > 0 ? tiers[inf.garant].pct : null, proprias: tiers !== ctx.tiers,
    prox: prox ? { pct: prox.pct, min: prox.min, falta: Math.max(0, prox.min - fat) } : null, comissao };
}
// aviso no Telegram quando um parceiro sobe de faixa com uma venda paga
function avisoFaixa(o) {
  try {
    if (!o.coupon) return;
    const ctx = makePartnerCtx(), c = ctx.cupons[o.coupon];
    if (!c || c.plano === 'fixo' || proprios(c).has(String(o.game_id))) return;
    const d = ctx.dados(o.coupon), fat = d.porMes[ctx.cur] || 0;
    const tiers = ctx.tiersOf(o.coupon);
    const antes = tierIdx(fat - o.cents, tiers), agora = tierIdx(fat, tiers);
    const garant = ctx.info(o.coupon, ctx.cur).garant;
    if (agora > antes && agora > garant) {
      tgSend(`🎯 Parceiro ${o.coupon} bateu a meta de ${brlTxt(tiers[agora].min)} no mês → comissão de ${tiers[agora].pct}% do lucro em TODAS as vendas do mês (faturado até agora: ${brlTxt(fat)}).`);
    }
  } catch (e) { console.error('avisoFaixa', e.message); }
}

// Relatório: só pedidos pagos/entregues (cancelado/estornado não gera comissão).
// Período (datas locais, ex.: ?from=2026-11-01&to=2026-11-30) vale para os números de venda;
// ganho total, já pago e saldo são sempre de todo o histórico.
const localDay = (t) => new Date(new Date(t.replace(' ', 'T') + 'Z').getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const comOf = (o, pctOf) => Math.max(0, orderProfit(o)) * (pctOf(o) / 100);
app.get('/api/admin/coupons/report', admin, (req, res) => {
  const ctx = makePartnerCtx();
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = re.test(req.query.from || '') ? req.query.from : '0000-01-01';
  const to = re.test(req.query.to || '') ? req.query.to : '9999-12-31';
  const pctNow = Object.fromEntries(db.prepare('SELECT code, comissao_pct FROM coupons').all().map((c) => [c.code, c.comissao_pct]));
  const by = {};
  const get = (code) => (by[code] ||= { code, comissao_pct: pctNow[code] ?? 0, plano: ctx.cupons[code]?.plano || 'metas', pedidos: 0, faturado: 0, desconto: 0, lucro: 0, comissao: 0, total: 0, fechado: 0, mesCom: 0, pago: 0, pagamentos: [] });
  const rows = db.prepare(`SELECT * FROM orders WHERE coupon IS NOT NULL AND status IN ('paid','delivered') AND paid_at IS NOT NULL`).all();
  for (const o of rows) {
    const r = get(o.coupon);
    const c = comOf(o, ctx.pctOf);
    r.total += c;
    if (mesOf(o.paid_at) < ctx.cur) r.fechado += c; else r.mesCom += c; // a pagar = só meses fechados
    const d = localDay(o.paid_at);
    if (d < from || d > to) continue;
    r.pedidos++; r.faturado += o.cents; r.desconto += o.discount_cents || 0;
    r.lucro += orderProfit(o); r.comissao += c;
  }
  // visitas pelo link do cupom no período (funil: aparelhos distintos) — também aparece cupom ainda sem venda
  for (const v of db.prepare(`SELECT coupon, COUNT(DISTINCT dev) n FROM events WHERE ev='visit' AND coupon IS NOT NULL
      AND date(ts, '-3 hours') BETWEEN ? AND ? GROUP BY coupon`).all(from, to)) {
    if (pctNow[v.coupon] !== undefined) get(v.coupon).visitas = v.n;
  }
  for (const p of db.prepare('SELECT * FROM coupon_payouts ORDER BY paid_at DESC, id DESC').all()) {
    const r = get(p.code);
    r.pago += p.cents;
    r.pagamentos.push({ id: p.id, cents: p.cents, nota: p.nota || '', data: localDay(p.paid_at), ref: p.ref_mes || null });
  }
  const list = Object.values(by).map((r) => {
    const total = Math.round(r.total);
    const lucro = Math.round(r.lucro), comissao = Math.round(r.comissao);
    return { ...r, lucro, comissao, lucroLoja: lucro - comissao, visitas: r.visitas || 0,
      conversao: r.visitas ? r.pedidos / r.visitas : null, total, fechado: Math.round(r.fechado), mesCom: Math.round(r.mesCom),
      saldo: Math.round(r.fechado) - r.pago, minimo: PAYOUT_MIN,
      mesAtual: r.plano === 'fixo' || !ctx.cupons[r.code] ? null : mesAtual(ctx, r.code),
      linkParceiro: ctx.cupons[r.code]?.ptoken ? `${SITE_URL}/parceiro/${ctx.cupons[r.code].ptoken}` : null,
      parceiro: { nome: ctx.cupons[r.code]?.parceiro_nome || '', pix: ctx.cupons[r.code]?.parceiro_pix || '', email: !!ctx.cupons[r.code]?.parceiro_email } };
  });
  // cupons do plano de metas sem venda ainda também aparecem (mostram a faixa e a meta)
  for (const c of Object.values(ctx.cupons)) {
    if (by[c.code] || c.plano === 'fixo' || !c.ativo) continue;
    list.push({ code: c.code, comissao_pct: c.comissao_pct, plano: c.plano, pedidos: 0, faturado: 0, desconto: 0, lucro: 0, comissao: 0,
      lucroLoja: 0, visitas: 0, conversao: null, total: 0, fechado: 0, mesCom: 0, pago: 0, saldo: 0, minimo: PAYOUT_MIN, pagamentos: [], mesAtual: mesAtual(ctx, c.code),
      linkParceiro: c.ptoken ? `${SITE_URL}/parceiro/${c.ptoken}` : null });
  }
  res.json({ from, to, cupons: list.sort((a, b) => b.saldo - a.saldo || b.faturado - a.faturado) });
});
// faixas do plano de metas (editáveis no painel); valores em centavos
app.get('/api/admin/tiers', admin, (req, res) => res.json(getTiers()));
app.put('/api/admin/tiers', admin, (req, res) => {
  if (!guard(req, res)) return;
  const t = (Array.isArray(req.body) ? req.body : []).map((x) => ({ min: Math.round(Number(x.min)), pct: Number(x.pct) }));
  if (!validTiers(t)) return res.status(400).json({ error: 'Faixas inválidas: a 1ª começa em R$ 0; metas e % crescentes; de 1 a 6 faixas.' });
  // ?quando=proximo: agenda para o mês que vem (o mês atual segue com as faixas de hoje)
  if (req.query.quando === 'proximo') {
    setSetting('tiers_next', JSON.stringify({ mes: nextMes(curMes()), tiers: t }));
    logCup('*', `faixas padrão agendadas p/ ${nomeMesBR(nextMes(curMes()))}: ${tiersTxtS(t)}`);
    return res.json(getTiers());
  }
  freezeClosedMonths(makePartnerCtx()); // meses fechados ficam com as faixas que valiam neles
  logCup('*', `faixas padrão aplicadas já: ${tiersTxtS(getTiers())} → ${tiersTxtS(t)}`);
  setSetting('tiers', JSON.stringify(t));
  res.json(t);
});
app.get('/api/admin/tiers/agendado', admin, (req, res) => res.json({ agendado: tiersNext() }));
// registro de alterações de um cupom (?code=X) ou das faixas padrão (?code=*)
app.get('/api/admin/cupons-log', admin, (req, res) => {
  const code = req.query.code === '*' ? '*' : normCode(req.query.code);
  res.json(db.prepare('SELECT ts, acao FROM coupon_log WHERE code=? ORDER BY id DESC LIMIT 100').all(code).map((r) => ({ data: r.ts, acao: r.acao })));
});
app.delete('/api/admin/tiers/agendado', admin, (req, res) => {
  if (!guard(req, res)) return;
  const n = tiersNext();
  db.prepare("DELETE FROM settings WHERE k='tiers_next'").run();
  if (n) logCup('*', `agendamento p/ ${nomeMesBR(n.mes)} cancelado`);
  res.json({ ok: true });
});
// gera um novo link do parceiro (o antigo para de funcionar)
app.post('/api/admin/coupons/:code/ptoken', admin, (req, res) => {
  if (!guard(req, res)) return;
  const r = db.prepare('UPDATE coupons SET ptoken=? WHERE code=?').run(crypto.randomBytes(18).toString('base64url'), normCode(req.params.code));
  if (r.changes) logCup(normCode(req.params.code), 'link do parceiro trocado (o anterior parou de funcionar)');
  res.status(r.changes ? 200 : 404).json(r.changes ? { ok: true } : { error: 'Cupom não encontrado.' });
});

// ---------- Fechamento mensal das comissões (Telegram, 1º dia útil a partir das 9h) ----------
// Paga-se no 1º dia útil a comissão dos meses JÁ FECHADOS; abaixo do mínimo acumula para o mês seguinte.
const PAYOUT_MIN = Number(env.PAYOUT_MIN_CENTS ?? 2000);
const FECH_HOUR = Number(env.FECH_HOUR ?? 9);
const nomeMesBR = (m) => ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][+m.slice(5) - 1] + '/' + m.slice(0, 4);
// 1º dia útil do mês ('AAAA-MM'): pula sábado, domingo, 1º/jan e 1º/mai (feriados que caem no dia 1)
function primeiroDiaUtil(mes) {
  for (let d = 1; ; d++) {
    const dd = String(d).padStart(2, '0'), wd = new Date(`${mes}-${dd}T12:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6 || ['01-01', '05-01'].includes(`${mes.slice(5)}-${dd}`)) continue;
    return d;
  }
}
function fechamentoMsg() {
  const ctx = makePartnerCtx(), fech = {}, pago = {};
  for (const o of db.prepare("SELECT * FROM orders WHERE coupon IS NOT NULL AND status IN ('paid','delivered') AND paid_at IS NOT NULL").all()) {
    if (mesOf(o.paid_at) < ctx.cur) fech[o.coupon] = (fech[o.coupon] || 0) + comOf(o, ctx.pctOf);
  }
  for (const p of db.prepare('SELECT code, SUM(cents) s FROM coupon_payouts GROUP BY code').all()) pago[p.code] = p.s;
  const pagar = [], acumula = [], credito = [];
  for (const c of [...new Set([...Object.keys(fech), ...Object.keys(pago)])].sort()) {
    const s = Math.round(fech[c] || 0) - (pago[c] || 0);
    if (s >= PAYOUT_MIN) pagar.push([c, s]); else if (s > 0) acumula.push([c, s]); else if (s < 0) credito.push([c, -s]);
  }
  if (!pagar.length && !acumula.length && !credito.length) return null;
  const L = (a) => a.map(([c, s]) => `• ${c}${ctx.cupons[c]?.parceiro_nome ? ` (${ctx.cupons[c].parceiro_nome})` : ''}: ${brlTxt(s)}`).join('\n');
  return [
    `💸 Comissões dos parceiros — fechamento de ${nomeMesBR(prevMes(ctx.cur))}`,
    pagar.length ? `Pagar hoje por Pix (total ${brlTxt(pagar.reduce((a, [, s]) => a + s, 0))}):\n${L(pagar)}` : '✅ Nenhum parceiro atingiu o mínimo para pagamento.',
    acumula.length ? `Abaixo do mínimo de ${brlTxt(PAYOUT_MIN)} (acumula para o próximo mês):\n${L(acumula)}` : null,
    credito.length ? `Crédito (pago a mais; abate dos próximos):\n${L(credito)}` : null,
    pagar.length ? 'Depois de pagar, registre cada Pix no painel → Cupons → Comissões → Registrar pagamento.' : null,
  ].filter(Boolean).join('\n\n');
}
// 1x por mês (guarda o mês enviado; sobrevive a reinício). Sem nada a pagar/acumular, não manda nada.
function fechamentoTick(now = Date.now()) {
  const loc = new Date(now - 3 * 3600_000), mes = loc.toISOString().slice(0, 7), du = primeiroDiaUtil(mes);
  if (getSetting('fechamento_mes', '') === mes) return false;
  if (loc.getUTCDate() < du || (loc.getUTCDate() === du && loc.getUTCHours() < FECH_HOUR)) return false;
  setSetting('fechamento_mes', mes);
  freezeClosedMonths(makePartnerCtx());
  const msg = fechamentoMsg();
  if (msg) tgSend(msg);
  enviarExtratos(prevMes(mes)).catch((e) => console.error('extratos', e.message));
  return !!msg;
}

// ---------- Extrato mensal do parceiro por e-mail (junto com o fechamento) ----------
// Mostra só o que a página do parceiro mostra (vendas, faturado, faixa, comissão, a receber) — nunca lucro ou custos.
const PARC_FROM = env.MAIL_FROM_PARCERIAS || 'parcerias@recargaflame.com.br';
function mesParceiro(ctx, c, mes) {
  const d = ctx.dados(c.code), doMes = d.vendas.filter((o) => mesOf(o.paid_at) === mes);
  const fixo = c.plano === 'fixo', pct = fixo ? null : ctx.info(c.code, mes).pct;
  const com = Math.round(doMes.reduce((a, o) => a + Math.max(0, orderProfit(o)) * (fixo ? (o.com_pct || 0) : pct) / 100, 0));
  return { vendas: doMes.length, fat: d.porMes[mes] || 0, pct: fixo ? c.comissao_pct : pct, com };
}
// a receber = comissão dos meses fechados − pagamentos (igual ao painel)
function saldoFechado(ctx, code) {
  const ganho = ctx.dados(code).vendas.filter((o) => mesOf(o.paid_at) < ctx.cur).reduce((a, o) => a + comOf(o, ctx.pctOf), 0);
  return Math.round(ganho) - db.prepare('SELECT COALESCE(SUM(cents),0) s FROM coupon_payouts WHERE code=?').get(code).s;
}
function extratoEmail(ctx, c, mes) {
  const m = mesParceiro(ctx, c, mes), saldo = saldoFechado(ctx, c.code), nm = nomeMesBR(mes);
  const link = `${SITE_URL}/parceiro/${c.ptoken}`, nome = c.parceiro_nome || c.code;
  const status = saldo >= PAYOUT_MIN ? `O pagamento de ${brlTxt(saldo)} é feito por Pix no 1º dia útil do mês, na chave cadastrada.`
    : saldo > 0 ? `Você tem ${brlTxt(saldo)} a receber. Como é menos que ${brlTxt(PAYOUT_MIN)}, o valor acumula para o próximo pagamento.`
      : 'Está tudo em dia: não há valor pendente.';
  const subject = `Seu extrato de ${nm} — cupom ${c.code}`;
  const linhas = [['Vendas com o cupom', String(m.vendas)], ['Faturado', brlTxt(m.fat)],
    [c.plano === 'fixo' ? 'Comissão fixa' : 'Faixa do mês', `${String(m.pct).replace('.', ',')}%`], ['Comissão do mês', brlTxt(m.com)], ['A receber agora', brlTxt(Math.max(0, saldo))]];
  const text = [`Olá, ${nome}!`, '', `Extrato de ${nm} do cupom ${c.code}:`, ...linhas.map(([k, v]) => `- ${k}: ${v}`), '', status, '',
    `Acompanhe tudo, atualizado na hora: ${link}`, '', 'Dúvidas? É só responder este e-mail.', 'Equipe de Parcerias · Recarga Flame'].join('\n');
  const td = 'padding:11px 14px;border-top:1px solid #2a2a2e';
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0e0e10;padding:24px 12px;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#161618;border:1px solid #2a2a2e;border-radius:14px">
<tr><td style="padding:22px 22px 6px"><img src="${SITE_URL}/img/brand-mark.png" width="36" height="36" alt="" style="border-radius:8px;vertical-align:middle">
<span style="font-size:17px;font-weight:700;vertical-align:middle;margin-left:8px">Recarga <span style="color:#ff5a1f">Flame</span></span></td></tr>
<tr><td style="padding:14px 22px 4px"><h1 style="margin:0 0 8px;font-size:20px">Seu extrato de ${nm}</h1>
<p style="margin:0;color:#9b9ba3;font-size:14px;line-height:1.55">Olá, <b style="color:#f4f4f5">${esc(nome)}</b>! Aqui está o resumo do cupom <b style="color:#f4f4f5">${esc(c.code)}</b> no mês.</p></td></tr>
<tr><td style="padding:16px 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0e0e10;border:1px solid #2a2a2e;border-radius:10px;font-size:14px">
${linhas.map(([k, v], i) => `<tr><td style="${i ? td : 'padding:11px 14px'};color:#9b9ba3">${k}</td><td align="right" style="${i ? td : 'padding:11px 14px'};font-weight:700">${esc(v)}</td></tr>`).join('')}
</table>
<p style="margin:14px 0 0;font-size:14px;line-height:1.55">${esc(status)}</p></td></tr>
<tr><td style="padding:0 22px 20px"><a href="${link}" style="display:block;text-align:center;background:#ff5a1f;color:#160a04;font-weight:700;text-decoration:none;padding:13px;border-radius:9px">Ver minha página de parceiro</a></td></tr>
<tr><td style="padding:0 22px 22px;color:#6c6c74;font-size:12.5px;line-height:1.5">Dúvidas sobre a parceria? É só responder este e-mail.<br>
O link da sua página é pessoal: não compartilhe.<br><br>Equipe de Parcerias · Recarga Flame</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text };
}
// manda o extrato do mês fechado a cada parceiro com e-mail cadastrado que teve venda ou tem saldo; avisa no Telegram
async function enviarExtratos(mes) {
  const ctx = makePartnerCtx(), ok = [], falha = [];
  for (const c of Object.values(ctx.cupons)) {
    if (!c.parceiro_email || !c.ptoken) continue;
    if (!mesParceiro(ctx, c, mes).vendas && !saldoFechado(ctx, c.code)) continue; // nada a contar
    const e = extratoEmail(ctx, c, mes);
    (await sendMail(c.parceiro_email, e.subject, e.html, e.text, PARC_FROM, PARC_FROM) ? ok : falha).push(c.code);
  }
  if (ok.length || falha.length) {
    tgSend(`📧 Extrato de ${nomeMesBR(mes)} por e-mail: ${[ok.length ? 'enviado para ' + ok.join(', ') : '', falha.length ? '⚠️ falhou para ' + falha.join(', ') : ''].filter(Boolean).join(' · ')}`);
  }
  return { ok, falha };
}
// prévia do extrato no painel (mesmo e-mail que o parceiro recebe; padrão: mês passado)
app.get('/api/admin/coupons/:code/extrato', admin, (req, res) => {
  const ctx = makePartnerCtx(), c = ctx.cupons[normCode(req.params.code)];
  if (!c) return res.status(404).json({ error: 'Cupom não encontrado.' });
  const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.mes || '')) ? req.query.mes : prevMes(ctx.cur);
  res.set('Cache-Control', 'no-store').type('html').send(extratoEmail(ctx, c, mes).html);
});

// ---------- Página do parceiro (link privado, só leitura; nunca mostra lucro, margem ou custos) ----------
app.get('/parceiro/:token', limit(30), (req, res) => {
  const tk = String(req.params.token || '');
  const c = /^[A-Za-z0-9_-]{20,40}$/.test(tk) ? db.prepare('SELECT * FROM coupons WHERE ptoken=?').get(tk) : null;
  res.set('X-Robots-Tag', 'noindex, nofollow').set('Cache-Control', 'no-store');
  if (!c) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Link inválido</title><p style="font-family:sans-serif;padding:24px">Link inválido ou desativado.</p>');
  const ctx = makePartnerCtx();
  const T = ctx.tiersOf(c.code); // faixas deste parceiro (próprias ou padrão)
  const d = ctx.dados(c.code);
  const meses = [...new Set([...Object.keys(d.porMes), ctx.cur])].sort().reverse();
  const linhaMes = (m) => {
    const inf = ctx.info(c.code, m);
    const pct = c.plano === 'fixo' ? null : inf.pct;
    const doMes = d.vendas.filter((o) => mesOf(o.paid_at) === m);
    const raw = doMes.reduce((a, o) => a + Math.max(0, orderProfit(o)) * (c.plano === 'fixo' ? (o.com_pct || 0) : pct) / 100, 0);
    return { m, vendas: doMes.length, fat: d.porMes[m] || 0, pct: pct ?? c.comissao_pct, com: Math.round(raw), raw };
  };
  const hist = meses.map(linhaMes);
  const atual = c.plano === 'fixo' ? null : mesAtual(ctx, c.code);
  const ganho = Math.round(hist.reduce((a, h) => a + h.raw, 0)); // arredonda só o total (igual ao painel)
  const fechado = Math.round(hist.filter((h) => h.m < ctx.cur).reduce((a, h) => a + h.raw, 0)); // meses fechados
  const doMes = hist.find((h) => h.m === ctx.cur)?.com || 0;
  const agendado = T === ctx.tiers ? tiersNext() : null; // faixas padrão mudam no mês que vem (aviso ao parceiro)
  // visitas pelo link (aparelhos distintos, como no funil do painel): mês atual e total
  const visQ = (extra) => db.prepare(`SELECT COUNT(DISTINCT dev) n FROM events WHERE ev='visit' AND coupon=?${extra}`);
  const vis = { mes: visQ(" AND strftime('%Y-%m', ts, '-3 hours')=?").get(c.code, ctx.cur).n, total: visQ('').get(c.code).n };
  const vendasMes = hist.find((h) => h.m === ctx.cur)?.vendas || 0;
  const pagos = db.prepare('SELECT cents, nota, paid_at, ref_mes FROM coupon_payouts WHERE code=? ORDER BY paid_at DESC').all(c.code);
  const pago = pagos.reduce((a, p) => a + p.cents, 0);
  const nomeMes = (m) => { const [y, mm] = m.split('-'); return ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][+mm - 1] + '/' + y; };
  const link = `${SITE_URL}/${c.code.toLowerCase()}`;
  const barra = atual?.prox ? Math.min(100, Math.round((atual.faturamento - T[atual.ating].min) / (atual.prox.min - T[atual.ating].min) * 100)) : 100;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Parceiro ${esc(c.code)} — Recarga Flame</title>
<link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png">
<style>
:root{--bg:#0e0e10;--panel:#161618;--line:#2a2a2e;--txt:#f4f4f5;--mut:#9b9ba3;--dim:#6c6c74;--orange:#ff5a1f;--green:#3fb950}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,Arial,sans-serif}
.w{max-width:520px;margin:0 auto;padding:18px 18px 40px}.bar{display:flex;align-items:center;gap:10px;padding-bottom:14px;border-bottom:1px solid var(--line);margin-bottom:18px}
.bar img{width:30px;height:30px;border-radius:7px}.bar b span{color:var(--orange)}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);font-size:13px;margin:0 0 16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.big{font-size:30px;font-weight:800}.big small{font-size:14px;color:var(--mut);font-weight:600}
.k{display:grid;grid-template-columns:1fr 1fr;gap:10px}.k div{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px}
.k span{display:block;font-size:12px;color:var(--mut)}.k b{font-size:19px}
.prog{height:10px;background:var(--bg);border-radius:99px;overflow:hidden;margin:10px 0 6px}.prog i{display:block;height:100%;background:var(--orange)}
table{width:100%;border-collapse:collapse;font-size:13.5px}td,th{padding:7px 4px;border-top:1px solid var(--line);text-align:right}td:first-child,th:first-child{text-align:left}th{color:var(--mut);font-weight:600}
.cur{color:var(--orange);font-weight:700}.link{font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all;color:var(--orange)}
.note{font-size:12px;color:var(--dim)}.note a{color:var(--orange)}
@media(max-width:400px){table{font-size:12px}td,th{padding:6px 2px}}
.off{border-color:var(--orange);background:rgba(255,90,31,.08)}
</style></head><body><div class="w">
<div class="bar"><img src="/img/brand-mark.png" alt=""><b>Recarga <span>Flame</span></b></div>
<h1>Parceiro ${esc(c.code)}</h1><p class="sub">Seu link: <span class="link">${esc(link)}</span> · cupom <b>${esc(c.code)}</b> (${String(c.desconto_pct).replace('.', ',')}% de desconto para o cliente)</p>
${c.ativo ? '' : `<div class="card off">⚠️ <b>O cupom ${esc(c.code)} está desativado no momento.</b> O link não dá desconto e não há novas vendas com ele. Seu histórico e o que você tem a receber continuam aqui.</div>`}
${atual ? `<div class="card"><div class="note">Este mês (${nomeMes(atual.mes)})</div>
<div class="big">${atual.pct}% <small>de comissão${atual.garantidaPct && atual.idx === atual.garant && atual.ating < atual.garant ? ' · faixa garantida pelo mês anterior' : ''}</small></div>
<div class="k" style="margin-top:10px"><div><span>Vendas</span><b>${atual.vendas}</b></div><div><span>Faturado</span><b>${brlTxt(atual.faturamento)}</b></div>
<div><span>Comissão estimada</span><b>${brlTxt(atual.comissao)}</b></div><div><span>Próxima faixa</span><b>${atual.prox ? atual.prox.pct + '%' : 'máxima ✓'}</b></div></div>
${atual.prox ? `<div class="prog"><i style="width:${barra}%"></i></div><div class="note">Faltam <b style="color:var(--txt)">${brlTxt(atual.prox.falta)}</b> em vendas este mês para ${atual.prox.pct}% em todas as vendas do mês.</div>` : ''}
</div>
<div class="card"><b>Faixas de comissão</b><table><tr><th>Vendas no mês</th><th>Comissão</th></tr>
${T.map((t, i) => `<tr${i === atual.idx ? ' class="cur"' : ''}><td>${i === 0 ? (T[1] ? 'até ' + brlTxt(T[1].min) : 'qualquer valor') : 'a partir de ' + brlTxt(t.min)}</td><td>${t.pct}%</td></tr>`).join('')}
</table><p class="note" style="margin:8px 0 0">A faixa atingida vale para todas as vendas do mês. Quem atinge uma faixa começa o mês seguinte uma faixa abaixo. Contam vendas pagas e entregues; compras canceladas, reembolsadas ou estornadas não contam.</p>${agendado ? `<p class="note" style="margin:6px 0 0;color:var(--orange)">A partir de ${nomeMes(agendado.mes)} as faixas passam a ser: ${agendado.tiers.map((t, i) => `${t.pct}%${i ? ' a partir de ' + brlTxt(t.min) : ''}`).join(' · ')}.</p>` : ''}</div>` : `<div class="card"><div class="big">${String(c.comissao_pct).replace('.', ',')}% <small>de comissão fixa</small></div></div>`}
<div class="card"><div class="note">Seu link em ${nomeMes(ctx.cur)}</div><div class="k" style="margin-top:8px"><div><span>Visitas</span><b>${vis.mes}</b></div><div><span>Conversão</span><b>${vis.mes ? Math.round(vendasMes / vis.mes * 100) + '%' : '—'}</b></div></div>
<p class="note" style="margin:8px 0 0">Visitas = aparelhos diferentes que abriram seu link ou usaram o cupom (${vis.total} desde o início). Conversão = vendas do mês ÷ visitas do mês.</p></div>
<div class="card"><b>Histórico</b><table><tr><th>Mês</th><th>Vendas</th><th>Faturado</th><th>Faixa</th><th>Comissão</th></tr>
${hist.map((h) => `<tr><td>${nomeMes(h.m)}</td><td>${h.vendas}</td><td>${brlTxt(h.fat)}</td><td>${h.pct}%</td><td>${brlTxt(h.com)}</td></tr>`).join('')}
</table></div>
<div class="card"><div class="k"><div><span>Total ganho</span><b>${brlTxt(ganho)}</b></div><div><span>Já recebido</span><b>${brlTxt(pago)}</b></div></div>
<p style="margin:10px 0 0">A receber (meses fechados): <b>${brlTxt(Math.max(0, fechado - pago))}</b></p>
${doMes ? `<p class="note" style="margin:4px 0 0">Este mês, em andamento: ${brlTxt(doMes)} (estimado; entra no pagamento do 1º dia útil do mês que vem).</p>` : ''}
${pagos.length ? `<table style="margin-top:8px"><tr><th>Pagamento</th><th>Valor</th></tr>${pagos.map((p) => `<tr><td>${localDay(p.paid_at).split('-').reverse().join('/')}${p.ref_mes ? ' · ref. ' + nomeMes(p.ref_mes) : ''}${p.nota ? ' · ' + esc(p.nota) : ''}</td><td>${brlTxt(p.cents)}</td></tr>`).join('')}</table>` : ''}</div>
<p class="note">Atualizado agora. Dúvidas: <a href="/como-funciona">como funciona</a> · <a href="/perguntas-frequentes">perguntas frequentes</a> · <a href="mailto:suporte@recargaflame.com.br">suporte@recargaflame.com.br</a></p>
</div></body></html>`;
  res.type('html').send(html);
});

app.post('/api/admin/coupons/:code/payouts', admin, (req, res) => {
  if (!guard(req, res)) return;
  const code = normCode(req.params.code);
  if (!db.prepare('SELECT 1 FROM coupons WHERE code=?').get(code)) return res.status(404).json({ error: 'Cupom não encontrado.' });
  const cents = Math.round(Number(req.body?.cents));
  if (!Number.isInteger(cents) || cents <= 0 || cents > 10_000_000) return res.status(400).json({ error: 'Valor inválido.' });
  const nota = String(req.body?.nota || '').trim().slice(0, 80);
  const ref = String(req.body?.ref_mes || '');
  if (ref && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ref) || ref > curMes())) return res.status(400).json({ error: 'Mês de referência inválido.' });
  const r = db.prepare('INSERT INTO coupon_payouts (code, cents, nota, ref_mes) VALUES (?,?,?,?)').run(code, cents, nota, ref || prevMes(curMes()));
  logCup(code, `pagamento registrado: ${brlTxt(cents)} (ref. ${nomeMesBR(ref || prevMes(curMes()))})`);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
app.delete('/api/admin/payouts/:id', admin, (req, res) => {
  if (!guard(req, res)) return;
  const p = db.prepare('SELECT * FROM coupon_payouts WHERE id=?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Pagamento não encontrado.' });
  db.prepare('DELETE FROM coupon_payouts WHERE id=?').run(p.id);
  logCup(p.code, `pagamento desfeito: ${brlTxt(p.cents)}${p.ref_mes ? ` (ref. ${nomeMesBR(p.ref_mes)})` : ''}`);
  res.json({ ok: true });
});


return { makePartnerCtx, freezeClosedMonths, freezeTick, avisoFaixa, fechamentoMsg, fechamentoTick, primeiroDiaUtil, enviarExtratos, extratoEmail };
}
