#!/usr/bin/env node
// Procura no YouTube canais brasileiros que fazem vídeo de CounterFlame (ou "CS2/CS mobile", como a comunidade chama), para prospecção de parceiros.
//   node --env-file=.env tools/caca-criadores.mjs [--dias 90] [--sem-telegram]
// Sem API e sem login: lê a página pública de busca e a página de cada canal (dados em ytInitialData).
// Poucas requisições, com pausa entre elas (~80 por execução). Se o YouTube mudar a página, o script avisa e para.
// Guarda o histórico em data/criadores.json e a lista completa em data/criadores.csv (fora do git).
// O Instagram vem das descrições dos próprios canais: o Instagram não permite busca sem login.
// Manda no Telegram (tópico "parcerias", se configurado) só os canais NOVOS desde a última execução.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const STATE = path.join(DATA, 'criadores.json');
const CSV = path.join(DATA, 'criadores.csv');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DIAS = Number(arg('--dias', 90));
const PAGINAS = 3; // por termo: 1ª página + 2 continuações (~60 vídeos)
const QUERIES = ['counterflame', 'counter flame', 'counterflame mobile', 'counter flame cs2 mobile', 'counterflame skins', 'counterflame gameplay',
  // termos que a comunidade usa para o jogo; só contam vídeos de CS no celular que não citam outro jogo
  'cs2 mobile', 'cs mobile', 'cs2 celular', 'cs go mobile', 'counter strike mobile', 'cs2 android', 'cs2 mobile gameplay'];
const CF = /counter\s?flame/i;
const CS_MOBILE = /\b(cs\s?2|cs:?\s?go|cs|counter[\s-]?strike)\b[^|]{0,40}\b(mobile|celular|android|ios)\b|\b(mobile|celular|android)\b[^|]{0,40}\b(cs\s?2|cs:?\s?go|counter[\s-]?strike)\b/i;
const OUTRO_JOGO = /standoff|\bso\s?2\b|critical ops|free\s?fire|blood strike|pubg|call of duty|\bcodm?\b|valorant|warzone|roblox|minecraft|fortnite|project\s?a|forward assault|bullet force|restrike/i;
const CHEAT = /\b(cheat|hack|aimbot|wallhack|mod\s?menu|esp)\b/i;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const PT = /\b(você|voce|não|nao|pra|como|grátis|gratis|ganhar|melhor|atualização|atualizacao|inscreva|inscritos|canal|jogando|partida|faca|caixa|abrindo|novo|nova|vídeo|video|contato|parcerias?|negócios|negocios|seja|membro)\b/gi;
const EN = /\b(the|best|how to|subscribe|for business|business inquiries|my|with|new update)\b/gi;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let reqs = 0;

async function get(url) {
  if (reqs++) await sleep(1200 + Math.random() * 800);
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`YouTube respondeu ${r.status}`);
  return r.text();
}
function initialData(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) throw new Error('página do YouTube sem ytInitialData (mudou o formato ou pediu verificação)');
  return JSON.parse(m[1]);
}
function walk(o, key, out = []) {
  if (Array.isArray(o)) for (const v of o) walk(v, key, out);
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === key) out.push(v); walk(v, key, out); }
  return out;
}
const txt = (t) => (t?.simpleText ?? (t?.runs || []).map((r) => r.text).join('')) || '';
const num = (s) => { // "22.118 visualizações", "4,73 mil inscritos", "1,2 mi"
  const m = String(s).replace(/ /g, ' ').match(/([\d.,]+)\s*(mil|mi|bi)?/i);
  if (!m) return null;
  const mult = { mil: 1e3, mi: 1e6, bi: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  const n = mult > 1 ? Number(m[1].replace(/\./g, '').replace(',', '.')) : Number(m[1].replace(/[.,]/g, ''));
  return Math.round(n * mult);
};
const diasAtras = (s) => { // "há 5 dias", "há 2 semanas", "há 3 meses", "Transmitido há 1 ano"
  const m = String(s).match(/(\d+)\s*(segundo|minuto|hora|dia|semana|m[eê]s|meses|ano)/i);
  if (!m) return null;
  const u = m[2].toLowerCase();
  return Number(m[1]) * (u.startsWith('dia') ? 1 : u.startsWith('semana') ? 7 : u.startsWith('m') && u !== 'minuto' ? 30 : u.startsWith('ano') ? 365 : 0);
};
const chunksVideos = (data) => walk(data, 'videoRenderer').map((v) => ({
  id: v.videoId, titulo: txt(v.title), snippet: (v.detailedMetadataSnippets || []).map((s) => txt(s.snippetText)).join(' '),
  canal: v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId, canalNome: txt(v.ownerText),
  dias: diasAtras(txt(v.publishedTimeText)), views: num(txt(v.viewCountText)) || 0,
}));
const insta = (t) => {
  const s = String(t);
  const hs = [...s.matchAll(/instagram\.com\/([A-Za-z0-9_.]{2,30})/gi), ...s.matchAll(/\b(?:instagram|insta|ig)\b\s*[:\-–]?\s*@?([A-Za-z0-9_.]{2,30})/gi)]
    .map((m) => m[1].replace(/\.$/, '').toLowerCase());
  return [...new Set(hs)].filter((h) => !['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'com', 'e', 'do', 'da'].includes(h));
};
const emails = (t) => [...new Set(String(t).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])].map((e) => e.toLowerCase());
const score = (t, re) => (String(t).match(re) || []).length;

async function buscar(q) {
  const html = await get(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIIBQ%253D%253D&hl=pt-BR&gl=BR`); // filtro: este ano
  const data = initialData(html);
  const out = chunksVideos(data);
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const ver = html.match(/"clientVersion":"([^"]+)"/)?.[1];
  let token = walk(data, 'continuationCommand')[0]?.token;
  for (let p = 1; p < PAGINAS && token && key && ver; p++) {
    await sleep(1200 + Math.random() * 800); reqs++;
    const r = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${key}&prettyPrint=false`, {
      method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'pt', gl: 'BR' } }, continuation: token }),
    });
    if (!r.ok) break;
    const j = await r.json();
    out.push(...chunksVideos(j));
    token = walk(j, 'continuationCommand')[0]?.token;
  }
  return out;
}

async function canal(id) {
  const data = initialData(await get(`https://www.youtube.com/channel/${id}?hl=pt-BR&gl=BR`));
  const md = data.metadata?.channelMetadataRenderer || {};
  const s = JSON.stringify(data.header || {});
  const insc = s.match(/"content":"([^"]{0,30}inscrit[^"]{0,10})"/i)?.[1];
  return { nome: md.title, desc: md.description || '', url: md.vanityChannelUrl ? md.vanityChannelUrl.replace('http://www.', 'https://') : `https://youtube.com/channel/${id}`, inscritos: insc ? num(insc) : null };
}

function parceirosAtuais() {
  try {
    const require = createRequire(path.join(ROOT, 'package.json'));
    const db = require('better-sqlite3')(path.join(ROOT, 'loja.db'), { readonly: true });
    const rows = db.prepare("SELECT code, COALESCE(parceiro_canal,'') canal FROM coupons").all();
    db.close();
    return rows.flatMap((r) => [r.code, r.canal]).map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((s) => s.length >= 4);
  } catch { return []; }
}

function telegram(text, file) {
  const { TG_BOT_TOKEN: tk, TG_CHAT_ID: chat } = process.env;
  if (!tk || !chat) return Promise.resolve();
  let dest = { chat_id: chat };
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools/tg-destino.cjs'), 'parcerias'], { encoding: 'utf8' }).trim();
    if (out) { const [c, t] = out.split(' '); dest = { chat_id: c, message_thread_id: t }; }
  } catch { /* chat privado */ }
  const fd = new FormData();
  for (const [k, v] of Object.entries(dest)) fd.append(k, v);
  fd.append('caption', text.slice(0, 1024));
  fd.append('document', new Blob([fs.readFileSync(file)], { type: 'text/csv' }), path.basename(file));
  return fetch(`https://api.telegram.org/bot${tk}/sendDocument`, { method: 'POST', body: fd }).then((r) => r.json())
    .then((j) => { if (!j.ok) console.error('Telegram:', j.description); });
}

async function main() {
  // 1) vídeos recentes que citam CounterFlame
  const porCanal = new Map();
  const vistosVid = new Set();
  for (const q of QUERIES) {
    for (const v of await buscar(q)) {
      if (!v.canal || vistosVid.has(v.id)) continue;
      vistosVid.add(v.id);
      if (v.dias == null || v.dias > DIAS) continue;
      const t = v.titulo + ' ' + v.snippet;
      const cf = CF.test(t);
      if (CHEAT.test(t) || (!cf && !(CS_MOBILE.test(t) && !OUTRO_JOGO.test(t)))) continue;
      const c = porCanal.get(v.canal) || { videos: 0, views: 0, dias: 9999, texto: '', titulos: [], cf: 0 };
      if (cf) c.cf++;
      c.videos++; c.views += v.views; c.dias = Math.min(c.dias, v.dias);
      c.texto += ' ' + v.titulo + ' ' + v.snippet;
      if (c.titulos.length < 2) c.titulos.push(v.titulo);
      porCanal.set(v.canal, c);
    }
  }
  // 2) página de cada canal (só os novos ou sem dado há mais de 30 dias)
  fs.mkdirSync(DATA, { recursive: true });
  const prev = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { vistos: {} };
  const hoje = new Date().toISOString().slice(0, 10);
  const parceiros = parceirosAtuais();
  const canais = [];
  for (const [id, c] of porCanal) {
    const old = prev.vistos[id];
    const cache = old && old.atualizado && (Date.now() - Date.parse(old.atualizado)) < 30 * 864e5;
    let ch = cache ? { nome: old.nome, desc: old._desc || '', url: old.url, inscritos: old.inscritos } : null;
    if (!ch) { try { ch = await canal(id); } catch { await sleep(8000); try { ch = await canal(id); } catch (e) { console.error('canal', id, e.message); continue; } } }
    const pt = score(c.texto + ' ' + ch.desc, PT) - score(c.texto + ' ' + ch.desc, EN);
    if (pt < 2) continue; // sem sinal de português
    const norm = String(ch.nome).toLowerCase().replace(/[^a-z0-9]/g, '');
    canais.push({
      id, nome: ch.nome, url: ch.url, inscritos: ch.inscritos, videos_cf: c.videos, media_views_cf: Math.round(c.views / c.videos),
      ultimo_video_dias: c.dias, fonte: c.cf ? 'counterflame' : 'cs mobile', instagram: insta(ch.desc).join(' '), email: emails(ch.desc).join(' '), sinal_pt: pt,
      parceiro: norm.length >= 4 && parceiros.some((p) => norm.includes(p) || p.includes(norm)), exemplo: c.titulos[0] || '',
      atualizado: cache ? old.atualizado : hoje, _desc: ch.desc.slice(0, 1000),
    });
  }
  canais.sort((a, b) => b.media_views_cf * Math.min(b.videos_cf, 5) - a.media_views_cf * Math.min(a.videos_cf, 5));

  // 3) histórico e saída
  const novos = canais.filter((c) => !prev.vistos[c.id] && !c.parceiro);
  for (const c of canais) prev.vistos[c.id] = { ...c, visto_em: prev.vistos[c.id]?.visto_em || hoje };
  prev.ultima_execucao = hoje;
  fs.writeFileSync(STATE, JSON.stringify(prev, null, 1));
  const cols = ['nome', 'url', 'inscritos', 'fonte', 'videos_cf', 'media_views_cf', 'ultimo_video_dias', 'instagram', 'email', 'sinal_pt', 'parceiro', 'visto_em', 'exemplo'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const todos = Object.values(prev.vistos).sort((a, b) => b.media_views_cf - a.media_views_cf);
  fs.writeFileSync(CSV, '﻿' + [cols.join(';'), ...todos.map((c) => cols.map((k) => q(k === 'parceiro' ? (c[k] ? 'sim' : '') : c[k])).join(';'))].join('\n'));

  const n = (x) => (x == null ? '?' : x >= 1e6 ? (x / 1e6).toFixed(1).replace('.', ',') + ' mi' : x >= 1000 ? (x / 1000).toFixed(x >= 1e4 ? 0 : 1).replace('.', ',') + ' mil' : String(x));
  const linhas = novos.slice(0, 12).map((c) => `• ${c.nome} — ${n(c.inscritos)} inscr., ${c.videos_cf} víd.${c.fonte === 'cs mobile' ? ' (cs mobile)' : ''}, ~${n(c.media_views_cf)} views${c.instagram ? ', IG @' + c.instagram.split(' ')[0] : ''}`);
  const msg = `🔎 Criadores de CounterFlame (YouTube, últimos ${DIAS} dias)\n${canais.length} canais BR encontrados, ${novos.length} novos.\n\n${linhas.join('\n') || 'Nenhum canal novo desde a última busca.'}\n\nLista completa no CSV.`;
  console.log(msg.replace(/\n\n/g, '\n'), `\n(${reqs} requisições ao YouTube)`);
  if (!process.argv.includes('--sem-telegram') && novos.length) await telegram(msg, CSV);
}

main().catch((e) => { console.error('erro:', e.message); process.exit(1); });
