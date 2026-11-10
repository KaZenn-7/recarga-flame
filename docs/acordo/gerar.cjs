#!/usr/bin/env node
// Gera o acordo de parceria (.docx) da Recarga Flame.
//
//   node docs/acordo/gerar.cjs --modelo                       → modelo em branco com faixas e preços de hoje (docs/acordo/gerados/)
//   node docs/acordo/gerar.cjs --cupom AQUILA [opções]        → acordo preenchido com os dados do cupom (docs/acordo/gerados/)
//
// Opções (o que o banco não sabe; se faltar, fica [EM AMARELO] no documento):
//   --nome "Nome do parceiro"   --canal "Canal/perfil"   --pix "chave Pix"   --responsavel "Seu nome"
//   --sem-responsavel (só "Recarga Flame", sem "representada por")   --minimo 20  --aviso 7  (padrões da loja)   --data 09/11/2026 (padrão: hoje)   --out caminho.docx
//
// Lê loja.db só para leitura. Os acordos gerados têm a chave Pix do parceiro: ficam em docs/acordo/gerados/ (fora do git).
const fs = require('fs');
const path = require('path');
const { buildAcordo, TIERS_PADRAO } = require('./acordo.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'gerados');
const MP_FEE = 0.0099;
const EXEMPLOS = ['c10000', 'gold', 'c100000']; // produtos usados nos exemplos (se existirem e estiverem ativos)

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (k === 'modelo' || k === 'sem-responsavel') o[k] = true;
    else o[k] = argv[++i];
  }
  return o;
}
const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10).split('-').reverse().join('/');
const validTiers = (t) => Array.isArray(t) && t.length >= 1 && t.length <= 6 && t[0].min === 0
  && t.every((x, i) => Number.isInteger(x.min) && x.pct >= 0 && x.pct <= 100 && (!i || (x.min > t[i - 1].min && x.pct >= t[i - 1].pct)));

// mesmo cálculo do server.js (calcStarCost): custo das Stars que estão no saldo agora, das compras mais novas para as mais antigas
function starCost(db) {
  const saldo = Math.max(1, db.prepare('SELECT COALESCE(SUM(delta),0) s FROM stars_ledger').get().s);
  const recs = db.prepare('SELECT stars, cents FROM stars_purchases WHERE cents > 0 AND stars > 0 ORDER BY created_at DESC, id DESC').all();
  if (!recs.length) return 0.0875;
  let falta = saldo, st = 0, c = 0;
  for (const r of recs) { const usa = Math.min(falta, r.stars); st += usa; c += usa * (r.cents / r.stars); falta -= usa; if (falta <= 0) break; }
  return c / st / 100;
}

async function main() {
  const o = args(process.argv.slice(2));
  const num = (k, def) => (o[k] === undefined ? def : Number(String(o[k]).replace(',', '.')));
  const db = require(path.join(ROOT, 'node_modules', 'better-sqlite3'))(path.join(ROOT, 'loja.db'), { readonly: true, fileMustExist: true });

  let globais = TIERS_PADRAO;
  try { const t = JSON.parse(db.prepare("SELECT v FROM settings WHERE k='tiers'").get()?.v || ''); if (validTiers(t)) globais = t; } catch { /* padrão */ }
  const star = starCost(db);
  const exemplosDe = (desconto) => ({
    data: hoje(), star,
    linhas: EXEMPLOS.map((k) => db.prepare('SELECT nome, cents, stars FROM products WHERE key=? AND ativo=1').get(k)).filter(Boolean).map((p) => {
      const piso = Math.ceil((p.stars * star * 100) / (1 - MP_FEE));
      const paga = Math.min(p.cents, Math.max(Math.round(p.cents * (1 - desconto / 100)), piso));
      return { nome: p.nome, paga, lucro: Math.round(paga - p.stars * star * 100 - paga * MP_FEE) };
    }),
  });

  let d, out;
  if (o.modelo) {
    d = { modelo: true, plano: 'metas', tiers: globais, exemplos: exemplosDe(5) };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    out = o.out || path.join(OUT_DIR, `Modelo - Acordo de parceria - ${hoje().split('/').reverse().join('-')}.docx`);
  } else {
    const code = String(o.cupom || '').trim().toUpperCase();
    if (!code) throw new Error('use --cupom CÓDIGO ou --modelo');
    const c = db.prepare('SELECT * FROM coupons WHERE code=?').get(code);
    if (!c) throw new Error(`cupom ${code} não existe. Cupons: ${db.prepare('SELECT code FROM coupons').all().map((r) => r.code).join(', ')}`);
    let proprias = null;
    try { const t = JSON.parse(c.tiers || ''); if (validTiers(t)) proprias = t; } catch { /* usa as globais */ }
    const tiers = proprias || globais;
    d = {
      cupom: c.code, desconto: c.desconto_pct, plano: c.plano === 'fixo' ? 'fixo' : 'metas', comissaoFixa: c.comissao_pct, tiers,
      tiersProprias: !!proprias && JSON.stringify(proprias) !== JSON.stringify(globais),
      // o que não vier por parâmetro sai dos dados do parceiro cadastrados no cupom (painel)
      parceiroNome: o.nome || c.parceiro_nome || null, canal: o.canal || c.parceiro_canal || null, chavePix: o.pix || c.parceiro_pix || null, responsavel: o.responsavel || null,
      semResponsavel: !!o['sem-responsavel'], minimo: Math.round(num('minimo', 20) * 100), avisoDias: num('aviso', 7),
      data: o.data || hoje(), geradoEm: hoje(), exemplos: exemplosDe(c.desconto_pct),
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    out = o.out || path.join(OUT_DIR, `Acordo de parceria - ${c.code} - ${hoje().split('/').reverse().join('-')}.docx`);
    const falta = [['nome', d.parceiroNome], ['canal', d.canal], ['pix', d.chavePix], ...(d.semResponsavel ? [] : [['responsavel', d.responsavel]])]
      .filter(([, x]) => !x).map(([k]) => k);
    console.log(JSON.stringify({ cupom: c.code, ativo: !!c.ativo, plano: d.plano, desconto: c.desconto_pct,
      comissao: d.plano === 'fixo' ? c.comissao_pct : tiers.map((x) => x.pct), tiersProprias: d.tiersProprias,
      star: Number(star.toFixed(4)), emAmarelo: falta }));
  }
  db.close();
  fs.writeFileSync(out, await buildAcordo(d));
  console.log('ok', out);
}

main().catch((e) => { console.error('erro:', e.message); process.exit(1); });
