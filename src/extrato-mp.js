// Extrato do Mercado Pago (Relatório de liberações): cada movimento da conta — pagamento recebido, reservas, saques,
// rendimento e o que foge disso (retenção por denúncia/MED, devolução, contestação). A API de pagamentos não mostra
// retenção: o pagamento segue "aprovado" (caso do carrinho 11, 17/11/2026: R$ 125,80 retidos às 07:00 e liberados
// às 13:02 como reserve_for_debt_payment). Só leitura: pede o relatório, baixa o CSV e compara.
// Usado pela checagem diária (server.js) e por tools/extrato-mp.mjs (sob demanda).
import fs from 'node:fs';
import path from 'node:path';

const MP = 'https://api.mercadopago.com';
// movimentos de rotina da conta; qualquer outro tipo vira alerta
export const NORMAIS = new Set(['payment', 'reserve_for_payment', 'reserve_for_payout', 'payout', 'asset_management', '']);
export const PASTA = 'backups/extrato-mp';
const NOMES = {
  reserve_for_debt_payment: 'retenção para pagar dívida (denúncia/MED)', reserve_for_dispute: 'retenção por reclamação',
  refund: 'devolução ao pagador', chargeback: 'contestação (chargeback)', mediation: 'mediação', dispute: 'disputa',
};
export const nomeMov = (d) => NOMES[d] || d;

// CSV do relatório → [{ DATE, SOURCE_ID, DESCRIPTION, NET_CREDIT_AMOUNT, NET_DEBIT_AMOUNT, … }]
export function lerCsv(txt) {
  const linhas = String(txt || '').split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) return [];
  const sep = linhas[0].includes(';') ? ';' : ',';
  const tira = (s) => s.trim().replace(/^"|"$/g, '');
  const cab = linhas[0].split(sep).map((c) => tira(c).toUpperCase());
  return linhas.slice(1).map((l) => Object.fromEntries(l.split(sep).map((v, i) => [cab[i], tira(v)])));
}
const num = (v) => Number(String(v || '0').replace(',', '.')) || 0;
// chave única de um movimento (para não alertar 2 vezes)
export const chaveMov = (r) => [r.DATE, r.SOURCE_ID, r.DESCRIPTION, r.NET_CREDIT_AMOUNT, r.NET_DEBIT_AMOUNT].join('|');

// movimentos fora da rotina, com o pedido da loja de origem (SOURCE_ID = nº do pagamento no MP)
export function incomuns(rows, db) {
  const porPag = (id) => {
    if (!id || !db) return null;
    const o = db.prepare('SELECT id, nickname, game_id, carrinho_id FROM orders WHERE mp_id=? ORDER BY id').all(String(id));
    if (!o.length) return null;
    return { pedidos: o.map((x) => x.id), carrinho: o[0].carrinho_id || null, conta: o[0].nickname, gameId: o[0].game_id };
  };
  return rows.filter((r) => !NORMAIS.has(String(r.DESCRIPTION || '').trim()))
    .map((r) => ({ quando: r.DATE, pagamento: r.SOURCE_ID, tipo: r.DESCRIPTION, credito: num(r.NET_CREDIT_AMOUNT),
      debito: num(r.NET_DEBIT_AMOUNT), chave: chaveMov(r), origem: porPag(r.SOURCE_ID) }));
}
const brl = (v) => 'R$ ' + v.toFixed(2).replace('.', ',');
const hora = (d) => { const x = new Date(d); return isNaN(x) ? d : x.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
export function textoMov(m) {
  const sentido = m.debito ? `−${brl(m.debito)} (saiu do saldo)` : `+${brl(m.credito)} (voltou para o saldo)`;
  const o = m.origem ? `pedido${m.origem.pedidos.length > 1 ? 's' : ''} ${m.origem.pedidos.map((x) => '#' + x).join(', ')}${m.origem.carrinho ? ` (carrinho ${m.origem.carrinho})` : ''} · ${m.origem.conta} · ID ${m.origem.gameId}` : 'sem pedido da loja';
  return `${hora(m.quando)} · ${nomeMov(m.tipo)} · ${sentido}\npagamento ${m.pagamento} · ${o}`;
}

// ---- API do relatório (só leitura da conta; pedir relatório não mexe em dinheiro) ----
export function mpRelatorio(token, fetchFn = fetch) {
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const iso = (d) => new Date(d).toISOString().slice(0, 19) + 'Z';
  return {
    async pedir(de, ate) {
      const r = await fetchFn(`${MP}/v1/account/release_report`, { method: 'POST', headers: h, body: JSON.stringify({ begin_date: iso(de), end_date: iso(ate) }) });
      if (r.status !== 202 && !r.ok) throw new Error('relatório não aceito: HTTP ' + r.status);
      return r.json();
    },
    async lista() {
      const r = await fetchFn(`${MP}/v1/account/release_report/list`, { headers: h });
      if (!r.ok) throw new Error('lista de relatórios: HTTP ' + r.status);
      return r.json();
    },
    async baixar(nome) {
      const r = await fetchFn(`${MP}/v1/account/release_report/${encodeURIComponent(nome)}`, { headers: h });
      if (!r.ok) throw new Error('baixar relatório: HTTP ' + r.status);
      return r.text();
    },
  };
}
// o relatório pedido já está pronto? → nome do arquivo novo (que não estava na lista antes de pedir). Não dá para usar a
// data (o MP grava date_created com o fuso errado: hora UTC marcada como -04:00) nem o id (o que o MP devolve ao pedir
// não é o mesmo da lista) — 19/11/2026.
export const nomes = (lista) => new Set((Array.isArray(lista) ? lista : []).map((x) => x.file_name).filter(Boolean));
// o MP não gera de novo um período (dia inteiro) que já tem relatório no mesmo dia: aceita o pedido e não cria arquivo.
// Sem arquivo novo, vale o relatório pronto mais recente que cobre os dias pedidos.
const dia = (d) => new Date(new Date(d).getTime() - 3 * 3600_000).toISOString().slice(0, 10);
export const cobre = (lista, de, ate) => (Array.isArray(lista) ? lista : [])
  .filter((x) => x.file_name && (!x.status || x.status === 'enabled') && x.begin_date && x.end_date
    && dia(x.begin_date) <= dia(de) && dia(new Date(x.end_date).getTime() - 1000) >= dia(ate))
  .sort((a, b) => String(b.file_name).localeCompare(String(a.file_name)))[0]?.file_name || null;
export const prontoNovo = (lista, antes) => (Array.isArray(lista) ? lista : [])
  .filter((x) => x.file_name && !antes.has(x.file_name) && (!x.status || x.status === 'enabled'))
  .sort((a, b) => String(b.file_name).localeCompare(String(a.file_name)))[0]?.file_name || null;
export function guardar(nome, txt, raiz = process.cwd()) {
  const dir = path.join(raiz, PASTA);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dst = path.join(dir, String(nome).replace(/[^\w.-]/g, '_'));
  fs.writeFileSync(dst, txt, { mode: 0o600 });
  return dst;
}

// ---- checagem diária: às 8h30 pede o extrato dos últimos 3 dias e avisa no tópico Alertas o que fugir da rotina ----
export function initExtratoMp({ env, db, tgSend, getSetting, setSetting, fetchFn = fetch, raiz = process.cwd() }) {
  const api = mpRelatorio(env.MP_ACCESS_TOKEN, fetchFn);
  const hojeSP = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  let rodando = null;
  async function checar({ dias = 3, esperaMs = 30 * 60_000, passoMs = 60_000 } = {}) {
    const t0 = Date.now();
    const antes = nomes(await api.lista());
    const de = Date.now() - dias * 86_400_000, ate = Date.now();
    await api.pedir(de, ate);
    let nome = null, lista = [];
    while (!nome && Date.now() - t0 < esperaMs) {
      await new Promise((r) => setTimeout(r, passoMs));
      lista = await api.lista();
      nome = prontoNovo(lista, antes);
    }
    nome ||= cobre(lista, de, ate);
    if (!nome) throw new Error('o relatório não ficou pronto em ' + Math.round(esperaMs / 60_000) + ' min');
    const txt = await api.baixar(nome);
    guardar(nome, txt, raiz);
    const vistos = new Set(JSON.parse(getSetting('extrato_vistos', '[]')));
    const novos = incomuns(lerCsv(txt), db).filter((m) => !vistos.has(m.chave));
    for (const m of novos) {
      tgSend(`🏦 Movimento fora da rotina no Mercado Pago\n${textoMov(m)}${m.debito ? '\nSe for denúncia/MED: o valor fica retido até a análise; a prova de entrega está no pedido.' : ''}`, 'alertas');
      vistos.add(m.chave);
    }
    setSetting('extrato_vistos', JSON.stringify([...vistos].slice(-500)));
    return { arquivo: nome, novos: novos.length };
  }
  function extratoTick(agora = new Date()) {
    const sp = new Date(agora.getTime() - 3 * 3600_000);
    if (sp.getUTCHours() * 60 + sp.getUTCMinutes() < 8 * 60 + 30) return;
    if (getSetting('extrato_dia', '') === hojeSP() || rodando) return;
    setSetting('extrato_dia', hojeSP());
    rodando = checar().catch((e) => { console.error('extrato MP:', e.message); tgSend(`⚠️ Não consegui ler o extrato do Mercado Pago hoje: ${String(e.message).slice(0, 120)}`, 'sistema'); })
      .finally(() => { rodando = null; });
  }
  return { checarExtrato: checar, extratoTick };
}
