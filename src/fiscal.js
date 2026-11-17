// Fiscal (Fase 1 de fiscal/plano-intermediacao.md): compras de USDT, USDT gasto nas compras de Stars (gastar USDT é
// alienação de cripto), relatório mensal e CSVs para o contador. Os pedidos vêm de orders, com o custo da Star
// congelado na venda (star_cost). Nada aqui muda preço, checkout ou o que o cliente vê.
// relatorioMes/gerarArquivos só leem o banco: tools/relatorio-fiscal.mjs os usa com o banco em modo leitura.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TIPOS_USDT = ['p2p', 'nacional', 'estrangeira', 'carteira_propria'];
export const DECRIPTO_CENTS = 3_500_000; // R$ 35 mil/mês sem exchange brasileira (IN RFB 2.291/2025)
// faixas do Simples (Anexo III): limite superior da RBT12 em centavos e a alíquota nominal
const FAIXAS = [[18_000_000, 6], [36_000_000, 11.2], [72_000_000, 13.5], [180_000_000, 16], [360_000_000, 21], [480_000_000, 33]];

const msOf = (t) => (typeof t === 'number' ? t : Date.parse(String(t).replace(' ', 'T') + 'Z'));
const brt = (t) => new Date(msOf(t) - 3 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
export const mesAtual = (now = Date.now()) => new Date(now - 3 * 3600_000).toISOString().slice(0, 7);
export const mesAnterior = (m) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm - 2, 1)).toISOString().slice(0, 7); };
const reais = (c) => (c / 100).toFixed(2);
const brl = (c) => 'R$ ' + (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "dd/mm/aaaa hh:mm" (Brasília) → 'AAAA-MM-DD HH:MM:SS' UTC; vazio → null (agora); inválido → undefined
export function dataBRT(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return undefined;
  const [d, mo, y, h, mi] = [+m[1], +m[2], +m[3], m[4] == null ? 12 : +m[4], +(m[5] || 0)];
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi)); // confere se a data existe (31/02 vira março)
  if (local.getUTCDate() !== d || local.getUTCMonth() !== mo - 1 || h > 23 || mi > 59) return undefined;
  const ms = local.getTime() + 3 * 3600_000; // Brasília (UTC−3) → UTC
  if (ms > Date.now() + 60_000 || ms < Date.UTC(2020, 0, 1)) return undefined;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Cotação USDT/BRL de mercado (Binance, candle de 1 min) no instante ms. null se não conseguir.
export async function cotacaoBinance(ms) {
  try {
    const u = `https://api.binance.com/api/v3/klines?symbol=USDTBRL&interval=1m&startTime=${Math.floor(ms - 60_000)}&limit=1`;
    const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const k = (await r.json())?.[0];
    const v = Number(k?.[4]);
    return v > 0 ? { cotacao: v, fonte: 'binance USDTBRL 1m' } : null;
  } catch { return null; }
}

// Livro do USDT em ordem de data: compras entram, cada uso (compra de Stars paga em USDT) sai pelo custo médio
// ponderado do saldo. Uso sem cotação vale pelo custo (ganho 0). semLastro = USDT gasto sem compra registrada.
export function usdtLivro(db) {
  const compras = db.prepare('SELECT * FROM usdt_compras').all().map((c) => ({ ...c, k: 0 }));
  const usos = db.prepare('SELECT * FROM stars_purchases WHERE usdt > 0').all().map((u) => ({ ...u, k: 1 }));
  const ev = [...compras, ...usos].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.k - b.k || a.id - b.id));
  let saldo = 0, custo = 0, semLastro = 0; // custo em centavos do saldo
  const out = [];
  for (const e of ev) {
    if (!e.k) { saldo += e.usdt; custo += e.cents; continue; }
    const medio = saldo > 1e-9 ? custo / saldo : null;
    const coberto = Math.min(e.usdt, Math.max(0, saldo));
    // parte sem compra registrada: usa o valor em R$ informado na compra de Stars (proporcional)
    const custoUso = Math.round((medio ? coberto * medio : 0) + (e.usdt - coberto) * (e.cents / e.usdt));
    semLastro += e.usdt - coberto;
    saldo -= coberto; custo -= medio ? coberto * medio : 0;
    if (saldo < 1e-9) { saldo = 0; custo = 0; }
    const valor = e.cotacao ? Math.round(e.usdt * e.cotacao * 100) : custoUso;
    out.push({ ...e, custoUso, valor, ganho: valor - custoUso });
  }
  return { usos: out, saldo, custoMedio: saldo > 1e-9 ? custo / saldo : null, semLastro };
}

// volume cripto do mês (centavos): compras de USDT + valor dos usos. Conservador para o limite da DeCripto.
export function volumeCripto(db, mes, livro = usdtLivro(db)) {
  const compras = db.prepare('SELECT created_at, cents FROM usdt_compras').all().filter((c) => brt(c.created_at).startsWith(mes)).reduce((a, c) => a + c.cents, 0);
  const usos = livro.usos.filter((u) => brt(u.created_at).startsWith(mes)).reduce((a, u) => a + u.valor, 0);
  return { compras, usos, total: compras + usos };
}

// ---- pedidos de um mês (pela data do pagamento) ----
const reembolsado = (o) => o.refund_state === 'done' || o.status === 'reversed';
const comprado = (o) => !!o.delivered_at || o.status === 'paid'; // pacote comprado (ou a comprar) em nome do cliente
const STATUS = (o) => (o.refund_state === 'done' ? 'reembolsado' : o.status === 'reversed' ? 'estornado' : o.status === 'delivered' ? 'entregue' : o.status === 'paid' ? 'pendente' : o.status);
function pedidosMes(db, mes) {
  return db.prepare('SELECT * FROM orders WHERE paid_at IS NOT NULL ORDER BY paid_at, id').all().filter((o) => brt(o.paid_at).startsWith(mes)).map((o) => {
    const repasse = comprado(o) ? Math.round((o.prod_stars || 0) * (o.star_cost || 0) * 100) : 0;
    const reemb = reembolsado(o) && !o.delivered_at ? o.cents : 0;
    let prova = '';
    try { const i = JSON.parse(o.autopay_info || '{}'); prova = [i.botReply && String(i.botReply).split('\n').map((x) => x.trim()).filter(Boolean).join(' / ').slice(0, 240), i.account && 'conta ' + i.account, i.txId && 'tx ' + i.txId, i.recibo && 'recibo ' + i.recibo].filter(Boolean).join(' | '); } catch { /* sem prova */ }
    if (!prova && o.delivered_at) prova = 'entregue ' + brt(o.delivered_at) + (o.entrega_via ? ' (' + o.entrega_via + ')' : '');
    return { o, repasse, reemb, taxa: o.cents - repasse - reemb, prova };
  });
}
const somaMes = (db, mes) => pedidosMes(db, mes).reduce((a, p) => ({ recebido: a.recebido + p.o.cents, reemb: a.reemb + p.reemb, repasse: a.repasse + p.repasse, taxa: a.taxa + p.taxa }), { recebido: 0, reemb: 0, repasse: 0, taxa: 0 });

// ---- CSV ----
const cel = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (cab, linhas) => [cab.join(','), ...linhas.map((l) => l.map(cel).join(','))].join('\n') + '\n';

function faixa(rbt12) { const i = FAIXAS.findIndex(([lim]) => rbt12 <= lim); return i < 0 ? 'acima do limite do Simples (R$ 4,8 mi)' : `${i + 1}ª faixa do Anexo III (${String(FAIXAS[i][1]).replace('.', ',')}% nominal, até ${brl(FAIXAS[i][0])})`; }

// simulador da skill contador-loja (opcional: só se existir nesta máquina)
function simular(receitaAnualCents, root) {
  const py = path.join(root, '.claude/skills/contador-loja/scripts/simulador.py');
  if (!fs.existsSync(py)) return null;
  try { return execFileSync('python3', [py, '--receita-anual', reais(receitaAnualCents), '--atividade', 'servico-anexo-iii'], { timeout: 15_000, encoding: 'utf8' }).trim(); }
  catch (e) { return 'simulador falhou: ' + String(e.message).slice(0, 120); }
}

// Relatório de um mês (AAAA-MM): markdown, CSVs e resumo em números.
export function relatorioMes(db, mes, { root = process.cwd(), simulador = true } = {}) {
  const peds = pedidosMes(db, mes);
  const t = somaMes(db, mes);
  const livro = usdtLivro(db);
  const usosMes = livro.usos.filter((u) => brt(u.created_at).startsWith(mes));
  const comprasUsdt = db.prepare('SELECT * FROM usdt_compras ORDER BY created_at, id').all().filter((c) => brt(c.created_at).startsWith(mes));
  const starsMes = db.prepare('SELECT * FROM stars_purchases ORDER BY created_at, id').all().filter((s) => brt(s.created_at).startsWith(mes));
  const vol = volumeCripto(db, mes, livro);
  const ganho = usosMes.reduce((a, u) => a + u.ganho, 0);
  // RBT12: receita dos 12 meses ANTERIORES ao mês (regra do Simples), pelos dois modelos
  let m = mes, rbtRev = 0, rbtInt = 0;
  for (let i = 0; i < 12; i++) { m = mesAnterior(m); const s = somaMes(db, m); rbtRev += s.recebido - s.reemb; rbtInt += s.taxa; }
  const recRev = t.recebido - t.reemb;
  const tiposUsados = [...new Set(comprasUsdt.map((c) => c.tipo))];
  const semBR = !tiposUsados.length || tiposUsados.some((x) => x !== 'nacional');

  const L = [];
  L.push(`# Relatório fiscal ${mes}`, '', `Gerado em ${brt(Date.now())} (Brasília) a partir do banco da loja. Estimativa para conferência: não substitui a apuração do contador.`, '');
  L.push('## Pedidos', '', '| | R$ |', '|---|---|',
    `| Total recebido dos clientes (${peds.length} pedidos) | ${brl(t.recebido)} |`,
    `| Reembolsos/estornos | ${brl(t.reemb)} |`,
    `| Repasses (custo dos pacotes comprados em nome dos clientes) | ${brl(t.repasse)} |`,
    `| Taxas (recebido − repasse − reembolso) | ${brl(t.taxa)} |`, '');
  L.push('## Receita bruta pelos dois modelos', '', '| Modelo | Mês | RBT12 (12 meses anteriores) | Faixa pela RBT12 |', '|---|---|---|---|',
    `| Revenda (hoje) | ${brl(recRev)} | ${brl(rbtRev)} | ${faixa(rbtRev)} |`,
    `| Intermediação (só a taxa; depende de CNPJ + parecer) | ${brl(t.taxa)} | ${brl(rbtInt)} | ${faixa(rbtInt)} |`, '');
  if (rbtRev > FAIXAS[0][0] * 0.8) L.push(`⚠️ RBT12 da revenda acima de 80% da 1ª faixa (${brl(FAIXAS[0][0])}).`, '');
  L.push('## Cripto (USDT)', '',
    `- Compras de USDT no mês: ${comprasUsdt.length} (${brl(vol.compras)}).`,
    `- USDT gasto em Stars: ${usosMes.reduce((a, u) => a + u.usdt, 0).toFixed(2)} USDT, valor de alienação ${brl(vol.usos)}.`,
    `- Ganho/perda líquido: ${brl(ganho)}.`,
    `- Volume do mês (compras + usos): ${brl(vol.total)} de ${brl(DECRIPTO_CENTS)}.`);
  if (semBR && vol.total > DECRIPTO_CENTS) L.push('- ⚠️ **Passou de R$ 35 mil sem exchange brasileira: DeCripto do mês é obrigatória** (prazo: último dia útil do mês seguinte; confirmar com o contador).');
  if (usosMes.some((u) => !u.cotacao)) L.push(`- ${usosMes.filter((u) => !u.cotacao).length} uso(s) sem cotação de mercado: valem pelo custo (ganho 0).`);
  if (livro.semLastro > 0.005) L.push(`- ⚠️ ${livro.semLastro.toFixed(2)} USDT gastos sem compra de USDT registrada (no histórico todo): registre as compras com comprovante.`);
  const starsSemUsdt = starsMes.filter((s) => !(s.usdt > 0)).length;
  if (starsSemUsdt) L.push(`- ${starsSemUsdt} compra(s) de Stars no mês sem o USDT informado.`);
  L.push('- Lembrete: com USDT em exchange/carteira estrangeira, o ganho líquido anual paga 15% (declaração anual).', '');
  if (simulador) {
    const sRev = simular(recRev * 12, root), sInt = simular(t.taxa * 12, root);
    if (sRev) L.push('## Simulador (mês × 12)', '', `Obs.: o MEI não se aplica a esta atividade (CNAE 7490-1/04).${mes === mesAtual() ? ' Mês ainda em curso: a anualização fica subestimada.' : ''}`, '', '### Revenda', '', '```', sRev, '```', '', '### Intermediação', '', '```', sInt, '```', '');
  }

  const pedidos = csv(['pedido_id', 'data_hora_brt', 'mp_payment_id', 'valor_pago_cliente_brl', 'id_jogo_cliente', 'pacote', 'stars_gastas', 'custo_repasse_brl', 'taxa_intermediacao_brl', 'status_entrega', 'prova_entrega', 'reembolso_brl', 'data_reembolso', 'aceite_termos_versao'],
    peds.map(({ o, repasse, reemb, taxa, prova }) => [o.id, brt(o.paid_at), o.mp_id, reais(o.cents), o.game_id, o.prod_nome || o.product, comprado(o) ? o.prod_stars : 0, reais(repasse), reais(taxa), STATUS(o), prova,
      reemb ? reais(reemb) : '', reemb && o.refund_at ? brt(o.refund_at) : '', '']));
  const compras_usdt = csv(['id', 'data_hora_brt', 'plataforma', 'tipo_plataforma', 'brl_pago', 'usdt_recebido', 'custo_brl_por_usdt', 'comprovante'],
    comprasUsdt.map((c) => [c.id, brt(c.created_at), c.plataforma, c.tipo, reais(c.cents), c.usdt, (c.cents / 100 / c.usdt).toFixed(4), c.comprovante]));
  const porId = Object.fromEntries(usosMes.map((u) => [u.id, u]));
  const compras_stars = csv(['id', 'data_hora_brt', 'usdt_gasto', 'custo_brl_usdt_gasto', 'cotacao_brl_usdt_no_uso', 'fonte_cotacao', 'valor_alienacao_brl', 'ganho_perda_brl', 'stars_recebidas', 'custo_brl_por_star', 'comprovante'],
    starsMes.map((s) => { const u = porId[s.id]; return [s.id, brt(s.created_at), u ? u.usdt : '', u ? reais(u.custoUso) : '', u?.cotacao ?? '', u?.cotacao_fonte ?? '', u ? reais(u.valor) : '', u ? reais(u.ganho) : '', s.stars, (s.cents / 100 / s.stars).toFixed(5), s.comprovante || s.nota || '']; }));

  return { md: L.join('\n'), csv: { pedidos, compras_usdt, compras_stars },
    resumo: { mes, pedidos: peds.length, recebido: t.recebido, reemb: t.reemb, repasse: t.repasse, taxa: t.taxa, rbtRev, rbtInt, cripto: vol.total, ganho, decripto: semBR && vol.total > DECRIPTO_CENTS } };
}

// Grava fiscal/registros/AAAA-MM/*.csv e fiscal/relatorios/AAAA-MM.md (CSVs têm ID de jogo de clientes: 0600, fora do git)
export function gerarArquivos(db, mes, root = process.cwd(), opts = {}) {
  const r = relatorioMes(db, mes, { root, ...opts });
  const dReg = path.join(root, 'fiscal/registros', mes), dRel = path.join(root, 'fiscal/relatorios');
  fs.mkdirSync(dReg, { recursive: true, mode: 0o700 }); fs.mkdirSync(dRel, { recursive: true });
  for (const [k, v] of Object.entries(r.csv)) fs.writeFileSync(path.join(dReg, k + '.csv'), v, { mode: 0o600 });
  fs.writeFileSync(path.join(dRel, mes + '.md'), r.md + '\n', { mode: 0o600 });
  return { ...r, arquivos: { registros: dReg, relatorio: path.join(dRel, mes + '.md') } };
}

export const resumoMsg = (s) => `🧾 Relatório fiscal de ${s.mes.split('-').reverse().join('/')}\n`
  + `• Recebido: ${brl(s.recebido)} (${s.pedidos} pedidos)${s.reemb ? ` · reembolsos ${brl(s.reemb)}` : ''}\n`
  + `• Repasses: ${brl(s.repasse)} · taxas: ${brl(s.taxa)}\n`
  + `• RBT12: revenda ${brl(s.rbtRev)} · intermediação ${brl(s.rbtInt)}\n`
  + `• Cripto no mês: ${brl(s.cripto)} · ganho/perda ${brl(s.ganho)}`
  + (s.decripto ? '\n⚠️ Passou de R$ 35 mil sem exchange brasileira: DeCripto obrigatória (confirme com o contador).' : '')
  + `\n\nArquivos: fiscal/relatorios/${s.mes}.md e fiscal/registros/${s.mes}/`;

// ---- rotas do painel e rotina mensal ----
export function initFiscal({ env, db, app, admin, guard, tgSend, getSetting, setSetting, refreshStarCost, cotacao = cotacaoBinance }) {
  let cot = cotacao;
  const root = env.FISCAL_DIR || process.cwd();
  // aviso no Telegram ao cruzar 80% e 100% do limite da DeCripto no mês (uma vez por nível)
  function avisoDecripto() {
    const mes = mesAtual(), v = volumeCripto(db, mes).total;
    const nivel = v > DECRIPTO_CENTS ? 2 : v > DECRIPTO_CENTS * 0.8 ? 1 : 0;
    const ja = getSetting('decripto_aviso', '');
    const jaNivel = ja.startsWith(mes) ? Number(ja.split(':')[1]) : 0;
    if (nivel <= jaNivel) return;
    setSetting('decripto_aviso', mes + ':' + nivel);
    tgSend(nivel === 2
      ? `⚠️ Cripto no mês passou de R$ 35 mil (${brl(v)}: compras de USDT + uso em Stars). Sem exchange brasileira, a DeCripto deste mês é obrigatória — avise o contador.`
      : `🔔 Cripto no mês em ${brl(v)} (80% do limite de R$ 35 mil da DeCripto).`, 'alertas');
  }
  function info() {
    const livro = usdtLivro(db), mes = mesAtual();
    const compras = db.prepare('SELECT * FROM usdt_compras ORDER BY created_at DESC, id DESC LIMIT 20').all()
      .map((c) => ({ id: c.id, data: brt(c.created_at), plataforma: c.plataforma, tipo: c.tipo, cents: c.cents, usdt: c.usdt, comprovante: c.comprovante || '' }));
    return { saldo: livro.saldo, custoMedio: livro.custoMedio, semLastro: livro.semLastro, compras, tipos: TIPOS_USDT,
      mes: { ...volumeCripto(db, mes, livro), limite: DECRIPTO_CENTS } };
  }
  const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
  const txt = (v, n = 120) => String(v ?? '').trim().slice(0, n);
  app.get('/api/admin/fiscal', admin, (req, res) => res.json(info()));
  app.post('/api/admin/fiscal/usdt', admin, (req, res) => {
    if (!guard(req, res)) return;
    const b = req.body ?? {};
    const plataforma = txt(b.plataforma, 60), tipo = String(b.tipo || ''), cents = Math.round(num(b.cents)), usdt = num(b.usdt), quando = dataBRT(b.data);
    if (!plataforma) return res.status(400).json({ error: 'Informe a plataforma (ex.: Binance P2P).' });
    if (!TIPOS_USDT.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido.' });
    if (!(cents > 0 && cents <= 100_000_000)) return res.status(400).json({ error: 'Informe quanto pagou (R$).' });
    if (!(usdt > 0 && usdt <= 1_000_000)) return res.status(400).json({ error: 'Quantidade de USDT inválida.' });
    if (quando === undefined) return res.status(400).json({ error: 'Data inválida (use dd/mm/aaaa hh:mm).' });
    db.prepare('INSERT INTO usdt_compras (created_at, plataforma, tipo, cents, usdt, comprovante) VALUES (COALESCE(?, CURRENT_TIMESTAMP),?,?,?,?,?)')
      .run(quando, plataforma, tipo, cents, usdt, txt(b.comprovante, 200));
    avisoDecripto();
    res.json(info());
  });
  app.delete('/api/admin/fiscal/usdt/:id', admin, (req, res) => {
    if (!guard(req, res)) return;
    const r = db.prepare('DELETE FROM usdt_compras WHERE id=?').run(Number(req.params.id));
    if (!r.changes) return res.status(404).json({ error: 'Compra não encontrada.' });
    res.json(info());
  });
  // compra de Stars paga em USDT: sem R$, o custo é o USDT gasto × custo médio do saldo de USDT
  app.post('/api/admin/fiscal/compra-stars', admin, async (req, res) => {
    if (!guard(req, res)) return;
    const b = req.body ?? {};
    const stars = Number(b.stars), usdt = num(b.usdt);
    if (!(Number.isInteger(stars) && stars > 0 && stars <= 1_000_000)) return res.status(400).json({ error: 'Quantidade de Stars inválida.' });
    if (!(usdt > 0 && usdt <= 1_000_000)) return res.status(400).json({ error: 'Quantidade de USDT inválida.' });
    let cents = Math.round(num(b.cents));
    if (!(cents > 0)) {
      const l = usdtLivro(db);
      if (!(l.saldo + 1e-6 >= usdt && l.custoMedio)) return res.status(400).json({ error: 'Saldo de USDT registrado não cobre esse gasto: informe o valor em R$ ou registre a compra de USDT antes.', semSaldo: true });
      cents = Math.round(usdt * l.custoMedio);
    }
    if (!(cents > 0 && cents <= 100_000_000)) return res.status(400).json({ error: 'Valor em R$ inválido.' });
    const c = await cot(Date.now());
    db.prepare('INSERT INTO stars_purchases (stars, cents, nota, usdt, cotacao, cotacao_fonte, comprovante) VALUES (?,?,?,?,?,?,?)')
      .run(stars, cents, txt(b.nota, 80), usdt, c?.cotacao ?? null, c?.fonte ?? null, txt(b.comprovante, 200));
    refreshStarCost(true);
    avisoDecripto();
    res.json({ ok: true, cents, cotacao: c?.cotacao ?? null });
  });
  // completar uma compra de Stars já registrada com o USDT gasto (cotação da data da compra)
  app.patch('/api/admin/stars/compras/:id', admin, async (req, res) => {
    if (!guard(req, res)) return;
    const p = db.prepare('SELECT * FROM stars_purchases WHERE id=?').get(Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'Compra não encontrada.' });
    const usdt = num(req.body?.usdt);
    if (!(usdt > 0 && usdt <= 1_000_000)) return res.status(400).json({ error: 'Quantidade de USDT inválida.' });
    const c = await cot(msOf(p.created_at));
    db.prepare('UPDATE stars_purchases SET usdt=?, cotacao=?, cotacao_fonte=?, comprovante=? WHERE id=?')
      .run(usdt, c?.cotacao ?? null, c?.fonte ?? null, txt(req.body?.comprovante, 200) || p.comprovante || '', p.id);
    res.json({ ok: true, cotacao: c?.cotacao ?? null });
  });
  // dia 1º (Brasília): relatório do mês que terminou, arquivos em fiscal/ e resumo no Telegram.
  // Primeira execução só marca o mês anterior como feito (não gera relatório de meses sem registros).
  function fiscalTick(now = Date.now()) {
    const ant = mesAnterior(mesAtual(now)), feito = getSetting('fiscal_mes', '');
    if (feito >= ant) return null;
    setSetting('fiscal_mes', ant);
    if (!feito) return null;
    const r = gerarArquivos(db, ant, root);
    tgSend(resumoMsg(r.resumo), 'resumo');
    return r;
  }
  const _setCotacao = (fn) => { cot = fn || cotacao; };
  return { fiscalTick, avisoDecripto, _setCotacao };
}
