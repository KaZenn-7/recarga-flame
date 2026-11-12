// Artes do Instagram @recargaflame: carrosséis fixos (1080×1350) e capas dos destaques (1080×1920).
// Uso: node docs/kit/gen-insta.mjs <pasta-de-saída>
// Preços lidos da loja rodando (127.0.0.1:3102/api/products); prints do fluxo de docs/kit/telas, recortes de docs/kit/img.
// Mesmo motor do gen-og.mjs: Chromium headless do Playwright + ffmpeg (JPG).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMG = `file://${ROOT}/public/img`;
const CUT = `file://${ROOT}/docs/kit/img`;
const TELA = `file://${ROOT}/docs/kit/telas`;
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`;
const OUT = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('uso: node gen-insta.mjs <pasta-de-saída>'); process.exit(1); }

const prods = await (await fetch('http://127.0.0.1:3102/api/products')).json();
const P = Object.fromEntries(prods.map((p) => [p.key, p]));
const brl = (c) => 'R$ ' + (c / 100).toFixed(2).replace('.', ',');
const hoje = new Date().toLocaleDateString('pt-BR');

const css = `*{box-sizing:border-box;margin:0}
body{width:1080px;height:1350px;overflow:hidden;font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#f4f4f5;background:#0e0e10;
  background-image:radial-gradient(circle at 15% 8%,rgba(255,90,31,.26),rgba(255,90,31,0) 45%),radial-gradient(circle at 90% 95%,rgba(255,90,31,.16),rgba(255,90,31,0) 45%);
  display:flex;flex-direction:column;padding:64px 72px 56px}
body.story{height:1920px;align-items:center;justify-content:center;padding:0}
.top{display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:16px}.brand img{width:64px;height:64px;border-radius:14px}
.brand b{font-size:38px;letter-spacing:-.02em}.brand span{color:#ff5a1f}
.n{font-size:26px;font-weight:700;color:#6c6c74;letter-spacing:.06em}
main{flex:1;display:flex;flex-direction:column;justify-content:center}
h1{font-size:88px;line-height:1.04;font-weight:900;letter-spacing:-.035em}
h1 em{font-style:normal;color:#ff5a1f}
h2{font-size:64px;line-height:1.08;font-weight:900;letter-spacing:-.03em}
.step{display:inline-flex;align-items:center;justify-content:center;width:84px;height:84px;border-radius:24px;background:#ff5a1f;color:#160a04;font-size:50px;font-weight:900;margin-bottom:26px}
.sub{font-size:36px;line-height:1.35;color:#b4b4bb;margin-top:22px;font-weight:500}
.sub b{color:#f4f4f5}
.foot{display:flex;align-items:center;justify-content:space-between;font-size:28px;font-weight:700;color:#9b9ba3;border-top:2px solid #2a2a2e;padding-top:26px}
.foot b{color:#ff5a1f}
.shot{width:600px;margin:40px auto 0;border-radius:34px;border:3px solid #2a2a2e;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6);position:relative}
.shot img{width:600px;display:block}
.prods{display:flex;justify-content:center;gap:0;margin-top:56px}
.prods img{width:210px;height:210px;object-fit:contain;filter:drop-shadow(0 18px 28px rgba(0,0,0,.6));margin:0 -8px}
.swipe{font-size:30px;font-weight:800;color:#ff5a1f;margin-top:56px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:40px}
.it{display:flex;align-items:center;gap:18px;background:#161618;border:2px solid #2a2a2e;border-radius:24px;padding:14px 22px}
.it img{width:96px;height:96px;object-fit:contain;filter:drop-shadow(0 8px 12px rgba(0,0,0,.5))}
.it .nm{font-size:28px;font-weight:700;line-height:1.15}.it .pr{font-size:34px;font-weight:900;color:#ff5a1f;margin-top:4px;font-family:ui-monospace,Menlo,Consolas,monospace}
.note{font-size:24px;color:#6c6c74;margin-top:24px;text-align:center}
.idimg{width:100%;border-radius:22px;border:3px solid #2a2a2e;margin-top:46px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
ol{list-style:none;padding:0;margin-top:44px;display:flex;flex-direction:column;gap:30px}
ol li{display:flex;gap:26px;align-items:flex-start;font-size:36px;line-height:1.3;color:#b4b4bb}
ol li i{flex:none;display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:18px;background:#ff5a1f;color:#160a04;font-style:normal;font-weight:900;font-size:36px}
ol li b{color:#f4f4f5;display:block}
.alert{margin-top:44px;border:3px solid #ff5a1f;background:rgba(255,90,31,.08);border-radius:26px;padding:30px 34px;font-size:34px;line-height:1.35;color:#d4d4d8}
.alert b{color:#ff5a1f}
.cta{display:inline-block;font-size:40px;font-weight:900;background:#ff5a1f;color:#160a04;border-radius:22px;padding:18px 34px;margin-top:40px}
.hl{width:820px;height:820px;border-radius:50%;background:radial-gradient(circle at 50% 40%,#2a1408,#120a06 70%);border:10px solid #ff5a1f;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;box-shadow:0 0 140px rgba(255,90,31,.35)}
.hl svg{width:360px;height:360px;stroke:#ff5a1f;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}`;

const top = (n, t) => `<div class="top"><div class="brand"><img src="${IMG}/brand-mark.png"><b>Recarga <span>Flame</span></b></div><div class="n">${n}/${t}</div></div>`;
const foot = '<div class="foot"><span>recargaflame.com.br</span><b>@recargaflame</b></div>';
// recorte de um print do celular (800×1720): mostra de y0 a y1 (px originais)
const shot = (f, y0, y1) => `<div class="shot" style="height:${Math.round((y1 - y0) * 0.75)}px"><img src="${TELA}/${f}" style="margin-top:-${Math.round(y0 * 0.75)}px"></div>`;
const it = (k, nome, de = '') => `<div class="it"><img src="${CUT}/${k}.png"><div><div class="nm">${nome || P[k].nome}</div><div class="pr">${de ? '<small style="font-size:22px;color:#9b9ba3;font-family:Segoe UI,Roboto,sans-serif">a partir de </small>' : ''}${brl(P[k].cents)}</div></div></div>`;
const slide = (n, t, body) => `${top(n, t)}<main>${body}</main>${foot}`;

const posts = {
  'como-comprar': [
    `<h1>Como comprar na <em>Recarga Flame</em></h1><p class="sub">Coins, passes e coleções do CounterFlame no Pix, <b>em 4 passos</b>.</p>
     <div class="prods">${['c200000', 'gold', 'wildfire', 'bp25'].map((k) => `<img src="${CUT}/${k}.png">`).join('')}</div><div class="swipe">Arraste para o lado →</div>`,
    `<div class="step">1</div><h2>Informe o ID da sua conta</h2><p class="sub">Toque em <b>Buscar conta</b>: aparecem o nick e a foto. Confira se é a sua.</p>${shot('1-id.png', 190, 1100)}`,
    `<div class="step">2</div><h2>Escolha o produto</h2><p class="sub">Coins, Gold Pass, Arsenal Pass, coleções e níveis de passe.</p>${shot('2-catalogo.png', 230, 1180)}`,
    `<div class="step">3</div><h2>Pague com Pix</h2><p class="sub">QR Code ou copia e cola, pelo <b>Mercado Pago</b>. A confirmação é automática.</p>${shot('4-pix.png', 230, 1130)}`,
    `<div class="step">4</div><h2>Receba na conta</h2><p class="sub">Entrega automática em <b>até 10 minutos</b>, a qualquer hora.</p>${shot('5-entregue.png', 230, 900)}<div style="text-align:center"><div class="cta">Link na bio</div></div>`,
  ],
  'onde-achar-id': [
    `<h1>Onde fica o seu <em>ID</em> no CounterFlame?</h1><p class="sub">É o número da sua conta. Com ele a gente entrega o item, <b>sem senha</b>.</p>
     <img class="idimg" src="${IMG}/help-id.jpg"><div class="swipe">Arraste para o lado →</div>`,
    `<h2>Passo a passo</h2><ol>
      <li><i>1</i><div><b>Abra o CounterFlame</b>Espere carregar a tela inicial.</div></li>
      <li><i>2</i><div><b>Olhe o card do perfil, no topo</b>Fica ao lado do botão Home, com seu nick e sua foto.</div></li>
      <li><i>3</i><div><b>Anote o número abaixo do nick</b>Esse é o seu ID. Só os números, sem espaços.</div></li>
     </ol><img class="idimg" src="${IMG}/help-id.jpg">`,
    `<h2>A gente <em style="font-style:normal;color:#ff5a1f">nunca</em> pede senha</h2>
     <p class="sub">Para recarregar basta o ID. A Recarga Flame nunca pede <b>senha, login ou código de verificação</b>. Se alguém pedir em nosso nome, é golpe.</p>
     <div class="alert"><b>Confira o nick antes de pagar.</b> O item é entregue na conta do ID informado.</div>
     <div style="text-align:center"><div class="cta">Link na bio</div></div>`,
  ],
  precos: [
    `<h2>Coins do CounterFlame <em style="font-style:normal;color:#ff5a1f">no Pix</em></h2>
     <div class="grid">${['c1000', 'c3000', 'c5000', 'c10000', 'c30000', 'c50000', 'c100000', 'c200000'].filter((k) => P[k]).map((k) => it(k)).join('')}</div>
     <p class="note">Preços de ${hoje}. Confira sempre no site. →</p>`,
    `<h2>Passes e coleções</h2>
     <div class="grid">${[['gold'], ['wildfire'], ['arsenal', 'Arsenal Pass', 1], ['bp1'], ['bp5', '5 níveis de passe'], ['bp10', '10 níveis de passe'], ['bp25', '25 níveis de passe']]
       .filter(([k]) => P[k]).map(([k, n, de]) => it(k, n || (k === 'bp1' ? '1 nível de passe' : undefined), de)).join('')}</div>
     <p class="note">Preços de ${hoje}. Confira sempre no site.</p><div style="text-align:center"><div class="cta" style="margin-top:22px">Link na bio</div></div>`,
  ],
};

// capas dos destaques (ícones de linha desenhados à mão, 24×24)
const ICON = {
  comprar: '<path d="M3 4h2.5l2.2 11h10.6l2-8H6.6"/><circle cx="9.5" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/>',
  precos: '<path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8a1.4 1.4 0 0 1 0 2l-7 7a1.4 1.4 0 0 1-2 0z"/><circle cx="8" cy="8" r="1.6"/>',
  entregas: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  seguro: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  suporte: '<path d="M4 5.5h16v10H9l-5 4z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01" stroke-width="2.6"/>',
  parceiros: '<path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1-4.5-4.2 6.1-.8z"/>',
};

function render(file, w, h, body, cls = '') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insta-'));
  const html = path.join(tmp, 'a.html'), png = path.join(tmp, 'a.png');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body class="${cls}">${body}</body></html>`);
  execFileSync(CHROME, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--window-size=${w},${h}`, '--virtual-time-budget=3000', `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-q:v', '2', file]);
  fs.rmSync(tmp, { recursive: true });
  console.log('ok', file);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [nome, slides] of Object.entries(posts)) {
  slides.forEach((s, i) => render(path.join(OUT, `post-${nome}-${i + 1}.jpg`), 1080, 1350, slide(i + 1, slides.length, s)));
}
for (const [nome, svg] of Object.entries(ICON)) {
  render(path.join(OUT, `destaque-${nome}.jpg`), 1080, 1920, `<div class="hl"><svg viewBox="0 0 24 24">${svg}</svg></div>`, 'story');
}
