// Parte TikTok da busca de criadores (usada por tools/caca-criadores.mjs). Sem API e sem login:
//  1) páginas Discover do TikTok (tiktok.com/discover/<termo>), abertas no Chromium headless do Playwright,
//     porque a lista de vídeos só aparece depois do JavaScript (a busca normal pede login/captcha);
//  2) página pública de cada vídeo (views, data, país de onde foi postado) e do perfil (seguidores, bio, link da bio).
// Fica só com vídeos postados do Brasil que falam do jogo. A lista de vídeos do perfil não abre sem login,
// então "videos_jogo" conta os vídeos do perfil que apareceram nas páginas Discover, somando as execuções
// anteriores (cada página mostra só ~16 vídeos, que mudam de uma semana para outra).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
export const TERMOS_TIKTOK = ['counter-flame', 'counterflame', 'cs-mobile', 'cs2-mobile', 'counter-flame-mobile', 'counterflame-baixar'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let reqs = 0;

const dados = (html) => {
  const m = html.match(/__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s);
  return m ? JSON.parse(m[1]).__DEFAULT_SCOPE__ || {} : {};
};
async function get(url) {
  await sleep(1500 + Math.random() * 1000); reqs++;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' } });
  if (!r.ok) throw new Error(`TikTok respondeu ${r.status}`);
  return r.text();
}
function discover(termo) {
  reqs++;
  const dom = execFileSync('timeout', ['90', CHROME, '--no-sandbox', '--disable-gpu', '--lang=pt-BR', `--user-agent=${UA}`,
    '--virtual-time-budget=20000', '--dump-dom', `https://www.tiktok.com/discover/${termo}`],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6 });
  return [...new Set([...dom.matchAll(/\/@([A-Za-z0-9_.]+)\/video\/(\d+)/g)].map((m) => `${m[1]}/${m[2]}`))];
}

// ctx: { dias, ehDoJogo(texto), cheat: RegExp, insta(texto), emails(texto), ehParceiro(nomes[]) }
export async function buscarTiktok(ctx) {
  if (!fs.existsSync(CHROME)) { console.error('TikTok: Chromium headless não encontrado, pulando'); return { perfis: [], reqs }; }
  const vids = new Map();
  for (const t of TERMOS_TIKTOK) {
    try { for (const k of discover(t)) if (!vids.has(k)) vids.set(k, t); } catch (e) { console.error('TikTok discover', t, e.message); }
    await sleep(3000);
  }
  const porPerfil = new Map();
  for (const k of vids.keys()) {
    const [u, id] = k.split('/');
    let it;
    try { it = dados(await get(`https://www.tiktok.com/@${u}/video/${id}`))['webapp.video-detail']?.itemInfo?.itemStruct; } catch (e) { console.error('TikTok vídeo', k, e.message); continue; }
    if (!it || it.locationCreated !== 'BR') continue; // só vídeos postados do Brasil
    const dias = Math.floor((Date.now() / 1000 - it.createTime) / 86400);
    if (dias > ctx.dias || !ctx.ehDoJogo(it.desc || '')) continue;
    const p = porPerfil.get(u) || { vids: [], exemplo: '' };
    p.vids.push({ id, criado: it.createTime, plays: Number(it.stats?.playCount) || 0, cf: /counter[\s-]?flame/i.test(it.desc) });
    if (!p.exemplo) p.exemplo = it.desc.replace(/#\S+/g, '').trim().slice(0, 120);
    porPerfil.set(u, p);
  }
  const perfis = [];
  for (const [u, p] of porPerfil) {
    let ui;
    try { ui = dados(await get(`https://www.tiktok.com/@${u}`))['webapp.user-detail']?.userInfo; } catch (e) { console.error('TikTok perfil', u, e.message); continue; }
    if (!ui) continue;
    const bio = ui.user.signature || '';
    if (ctx.cheat.test(bio) || /xitad|cheat|hack|\bxit/i.test(`${u} ${ui.user.nickname} ${bio}`)) continue;
    const link = ui.user.bioLink?.link || '';
    perfis.push({
      id: 'tt:' + u, rede: 'TikTok', nome: ui.user.nickname || u, url: `https://www.tiktok.com/@${u}`, inscritos: ui.stats?.followerCount ?? null,
      fonte: 'tiktok', instagram: ctx.insta(bio).join(' '), email: ctx.emails(bio).join(' '), email_oculto: false, outros_links: link, links: link ? [link] : [],
      pais: 'Brasil', sinal_pt: '', parceiro: ctx.ehParceiro([u, ui.user.nickname]), exemplo: p.exemplo, _desc: bio.slice(0, 1000), _vids: p.vids,
    });
  }
  return { perfis, reqs };
}

// Junta os vídeos desta execução com os já vistos (prev._vids) e recalcula as contagens dos últimos `dias`.
export function contarVideos(perfil, prevVids = [], dias) {
  const agora = Date.now() / 1000;
  const todos = [...prevVids.filter((v) => !perfil._vids.some((x) => x.id === v.id)), ...perfil._vids]
    .filter((v) => (agora - v.criado) / 86400 <= dias);
  const n = todos.length || 1;
  return {
    ...perfil, _vids: todos, videos_jogo: todos.length, videos_cf: todos.length, videos_com_nome_cf: todos.filter((v) => v.cf).length,
    media_views_cf: Math.round(todos.reduce((s, v) => s + v.plays, 0) / n),
    ultimo_video_dias: todos.length ? Math.min(...todos.map((v) => Math.floor((agora - v.criado) / 86400))) : null,
  };
}
