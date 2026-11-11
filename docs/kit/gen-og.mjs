// Prévia de link (Open Graph, 1200×630) da loja: o que aparece ao colar o link no WhatsApp/Telegram/Discord.
// Uso: node docs/kit/gen-og.mjs <arquivo.jpg>
//   ex.: node docs/kit/gen-og.mjs public/img/og-v2.jpg
// Mesmo visual do kit (produtos recortados de docs/kit/img, marca de public/img). Chromium headless do Playwright + ffmpeg (JPG).
// Ao trocar a imagem, use um NOME NOVO (og-v3.jpg…) e atualize o og:image das páginas: os apps guardam a prévia pelo endereço.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out || !/\.jpe?g$/i.test(out)) { console.error('uso: node gen-og.mjs <arquivo.jpg>'); process.exit(1); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMG = `file://${ROOT}/public/img`;
const CUT = `file://${ROOT}/docs/kit/img`;
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`;

const css = `*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#f4f4f5;background:#0e0e10;
  background-image:radial-gradient(circle at 18% 45%,rgba(255,90,31,.30),rgba(255,90,31,0) 52%),radial-gradient(circle at 78% 50%,rgba(255,90,31,.16),rgba(255,90,31,0) 45%);
  display:flex;align-items:center;justify-content:space-between;padding:0 30px 0 70px}
.brand{display:flex;align-items:center;gap:20px}.brand img{width:86px;height:86px;border-radius:18px}
.brand b{font-size:56px;letter-spacing:-.02em}.brand span{color:#ff5a1f}
h1{font-size:44px;line-height:1.18;font-weight:800;margin:34px 0 26px;letter-spacing:-.01em}
.pill{font-size:24px;font-weight:600;color:#c9c9cf;margin-top:12px}
.prods{display:flex;flex-wrap:wrap;justify-content:center;width:600px;gap:10px 6px}
.prods img{width:196px;height:196px;object-fit:contain;filter:drop-shadow(0 18px 28px rgba(0,0,0,.6))}`;
const body = `<div>
  <div class="brand"><img src="${IMG}/brand-mark.png"><b>Recarga <span>Flame</span></b></div>
  <h1>Coins e passes do<br>CounterFlame no Pix</h1>
  <div class="pill">⚡ Entrega automática em até 10 min</div>
  <div class="pill">🔒 Só o ID da conta, sem senha</div>
</div>
<div class="prods">${['c200000', 'gold', 'arsenal', 'wildfire', 'bp25'].map((k) => `<img src="${CUT}/${k}.png">`).join('')}</div>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
const html = path.join(tmp, 'og.html'), png = path.join(tmp, 'og.png');
fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
execFileSync(CHROME, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
  '--window-size=1200,630', '--virtual-time-budget=3000', `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-q:v', '3', path.resolve(out)]);
fs.rmSync(tmp, { recursive: true });
console.log('ok', path.resolve(out), fs.statSync(out).size, 'bytes');
