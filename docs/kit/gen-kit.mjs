// Kit de divulgação de parceiro: post 1080×1080, story 1080×1920 e banner 1920×1080.
// Uso: node docs/kit/gen-kit.mjs <CUPOM> <DESCONTO%> <pasta-de-saída>
//   ex.: node docs/kit/gen-kit.mjs IANSO2 5 /tmp/kit-ianso2
// Usa as imagens de public/img e o Chromium headless do Playwright (cache do usuário).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [codeIn, pctIn, outDir] = process.argv.slice(2);
if (!codeIn || !pctIn || !outDir) { console.error('uso: node gen-kit.mjs <CUPOM> <DESCONTO%> <pasta>'); process.exit(1); }
const CODE = codeIn.toUpperCase();
const PCT = String(pctIn).replace('.', ',');
const LINK = `recargaflame.com.br/${CODE.toLowerCase()}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMG = `file://${ROOT}/public/img`;
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`;
fs.mkdirSync(outDir, { recursive: true });
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BASE = `*{box-sizing:border-box;margin:0}
body{font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#f4f4f5;background:#0e0e10;overflow:hidden}
.brand{display:flex;align-items:center;gap:18px}.brand img{border-radius:16px}.brand b{letter-spacing:-.02em}.brand span{color:#ff5a1f}
.sub{color:#c9c9cf;font-weight:600}
.prods img{border-radius:26px;border:2px solid #2a2a2e;object-fit:cover;box-shadow:0 18px 50px rgba(0,0,0,.55);display:block}
.off{font-weight:900;line-height:.95;letter-spacing:-.04em;color:#ff5a1f;text-shadow:0 10px 40px rgba(255,90,31,.35)}
.off small{display:block;letter-spacing:0;color:#f4f4f5;font-weight:700;margin-top:10px}
.cup{display:inline-block;font-weight:900;letter-spacing:.12em;border:4px dashed #ff5a1f;border-radius:18px;background:rgba(255,90,31,.08)}
.link{display:inline-block;font-weight:800;background:#ff5a1f;color:#160a04;border-radius:20px}
.pills{display:flex;gap:14px;flex-wrap:wrap}
.pills span{color:#c9c9cf;border:2px solid #2a2a2e;background:#161618;border-radius:99px}`;
const brand = (img, font) => `<div class="brand"><img src="${IMG}/brand-mark.png" style="width:${img}px;height:${img}px"><b style="font-size:${font}px">Recarga <span>Flame</span></b></div>`;
const prods = (keys, size, cols) => `<div class="prods" style="display:grid;grid-template-columns:repeat(${cols},${size}px);gap:22px;justify-content:center">${keys.map((k) => `<img src="${IMG}/${k}.jpg" style="width:${size}px;height:${size}px">`).join('')}</div>`;
const pills = (fs_, center) => `<div class="pills" style="${center ? 'justify-content:center;' : ''}">${['⚡ Entrega automática em até 10 min', '🔒 Só o ID, sem senha'].map((p) => `<span style="font-size:${fs_}px;padding:10px 22px">${p}</span>`).join('')}</div>`;

const pages = {
  post: [1080, 1080, `body{width:1080px;height:1080px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;text-align:center;padding:64px 70px 60px;
    background-image:radial-gradient(circle at 50% 38%,rgba(255,90,31,.32),rgba(255,90,31,0) 55%)}`,
    `<div>${brand(76, 50)}<div class="sub" style="font-size:32px;margin-top:14px">Coins e passes do CounterFlame no Pix</div></div>
     ${prods(['c100000', 'gold', 'arsenal'], 200, 3)}
     <div><div class="off" style="font-size:150px">${PCT}% OFF<small style="font-size:38px">com o cupom</small></div>
       <div class="cup" style="margin-top:20px;font-size:46px;padding:12px 36px">${esc(CODE)}</div></div>
     <div><div class="link" style="font-size:44px;padding:18px 40px">${LINK}</div><div style="margin-top:22px">${pills(25, true)}</div></div>`],
  story: [1080, 1920, `body{width:1080px;height:1920px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;text-align:center;padding:180px 80px 280px;
    background-image:radial-gradient(circle at 50% 42%,rgba(255,90,31,.32),rgba(255,90,31,0) 55%)}`,
    `<div>${brand(76, 50)}<div class="sub" style="font-size:40px;margin-top:22px">Coins e passes do CounterFlame no Pix</div></div>
     <div style="margin:40px 0 30px">${prods(['c100000', 'gold', 'arsenal', 'wildfire'], 240, 2)}</div>
     <div><div class="off" style="font-size:180px">${PCT}% OFF<small style="font-size:48px">com o cupom</small></div>
       <div class="cup" style="margin-top:30px;font-size:60px;padding:12px 36px">${esc(CODE)}</div></div>
     <div><div class="link" style="font-size:${LINK.length > 28 ? 50 : 56}px;padding:18px 40px">${LINK}</div><div style="margin-top:34px">${pills(32, true)}</div></div>`],
  banner: [1920, 1080, `body{width:1920px;height:1080px;display:flex;align-items:center;justify-content:space-between;padding:90px 120px;
    background-image:radial-gradient(circle at 30% 50%,rgba(255,90,31,.30),rgba(255,90,31,0) 50%)}`,
    `<div style="display:flex;flex-direction:column;gap:34px;max-width:900px">
       ${brand(90, 60)}
       <div class="sub" style="font-size:44px">Coins, passes e coleções do CounterFlame no Pix</div>
       <div style="display:flex;align-items:flex-end;gap:34px"><div class="off" style="font-size:190px">${PCT}% OFF</div></div>
       <div style="display:flex;align-items:center;gap:22px"><span style="font-size:40px;font-weight:700">com o cupom</span>
         <div class="cup" style="font-size:58px;padding:8px 34px">${esc(CODE)}</div></div>
       <div><div class="link" style="font-size:54px;padding:18px 40px">${LINK}</div></div>
       ${pills(30, false)}
     </div>
     ${prods(['c100000', 'gold', 'arsenal', 'wildfire'], 300, 2)}`],
};

for (const [name, [w, h, css, body]] of Object.entries(pages)) {
  const html = path.join(outDir, `${name}.html`);
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE}${css}</style></head><body>${body}</body></html>`);
  const png = path.join(outDir, `${CODE.toLowerCase()}-${name}.png`);
  execFileSync(CHROME, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--window-size=${w},${h}`, '--virtual-time-budget=3000', `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  fs.rmSync(html);
  console.log('ok', png);
}
