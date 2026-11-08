// Faixa inferior animada com FUNDO TRANSPARENTE (para OBS/live): marca → cupom → desconto, 9 s em loop.
// Saída: <cupom>-faixa.webm (1920×1080, VP9 com alfa — OBS: Fonte de mídia, "Repetir")
//        <cupom>-faixa-previa.png (como fica sobre um fundo de exemplo)
// Uso: node docs/kit/gen-faixa.mjs <CUPOM> <DESCONTO%> <pasta>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const [codeIn, pctIn, outDir] = process.argv.slice(2);
if (!codeIn || !pctIn || !outDir) { console.error('uso: node gen-faixa.mjs <CUPOM> <DESCONTO%> <pasta>'); process.exit(1); }
const CODE = codeIn.toUpperCase();
const PCT = String(pctIn).replace('.', ',');
const LINK = `recargaflame.com.br/${CODE.toLowerCase()}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMG = `file://${ROOT}/public/img`;
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`;
const DUR = 9, FPS = 25, W = 1920, H = 1080;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:transparent;font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#f4f4f5}
*{animation-duration:${DUR}s!important;animation-iteration-count:infinite;animation-timing-function:ease-in-out;
  animation-play-state:paused!important;animation-delay:calc(var(--t,0) * -1s)!important;animation-fill-mode:both}
.bar{position:absolute;left:70px;bottom:70px;width:1180px;height:150px;display:flex;align-items:center;gap:28px;padding:0 34px 0 26px;
  background:rgba(14,14,16,.92);border:2px solid #2a2a2e;border-left:10px solid #ff5a1f;border-radius:22px;
  box-shadow:0 18px 50px rgba(0,0,0,.45),0 0 0 1px rgba(255,90,31,.12)}
.bar img{width:100px;height:100px;border-radius:22px;flex-shrink:0}
.slot{position:relative;flex:1;height:110px}
.sl{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;opacity:0}
.a{animation-name:a}.b{animation-name:b}.c{animation-name:c}
@keyframes a{0%{opacity:0;transform:translateY(22px)}5%{opacity:1;transform:none}29%{opacity:1;transform:none}34%{opacity:0;transform:translateY(-22px)}100%{opacity:0}}
@keyframes b{0%,33%{opacity:0;transform:translateY(22px)}38%{opacity:1;transform:none}62%{opacity:1;transform:none}67%{opacity:0;transform:translateY(-22px)}100%{opacity:0}}
@keyframes c{0%,66%{opacity:0;transform:translateY(22px)}71%{opacity:1;transform:none}95%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-22px)}}
.t1{font-size:58px;font-weight:900;letter-spacing:-.02em;line-height:1.05}.t1 span{color:#ff5a1f}
.t2{font-size:31px;color:#c9c9cf;font-weight:600;margin-top:6px}
.code{display:inline-block;font-weight:900;letter-spacing:.08em;border:4px dashed #ff5a1f;border-radius:12px;padding:0 16px;margin-left:12px;background:rgba(255,90,31,.1)}
.lk{color:#ff7a45}
</style></head><body>
<div class="bar"><img src="${IMG}/brand-mark.png"><div class="slot">
  <div class="sl a"><div class="t1">Recarga <span>Flame</span></div><div class="t2">Coins e passes do CounterFlame no Pix</div></div>
  <div class="sl b"><div class="t1">Use o cupom<span class="code" style="color:#f4f4f5">${esc(CODE)}</span></div><div class="t2 lk">${LINK}</div></div>
  <div class="sl c"><div class="t1"><span>${PCT}% OFF</span> no Pix</div><div class="t2">Entrega automática em até 10 min · <span class="lk">${LINK}</span></div></div>
</div></div>
<script>document.documentElement.style.setProperty('--t', (location.hash.match(/t=([\\d.]+)/)||[])[1]||0)</script>
</body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faixa-'));
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(tmp, 'faixa.html');
fs.writeFileSync(file, html);
const run = promisify(execFile);
const total = DUR * FPS;
let next = 0, done = 0;
async function worker() {
  for (;;) {
    const i = next++; if (i >= total) return;
    await run(CHROME, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
      '--default-background-color=00000000', `--window-size=${W},${H}`, '--virtual-time-budget=1500',
      `--screenshot=${path.join(tmp, `f${String(i).padStart(4, '0')}.png`)}`, `file://${file}#t=${(i / FPS).toFixed(3)}`], { timeout: 60000 });
    if (++done % 75 === 0) console.log(`quadros: ${done}/${total}`);
  }
}
await Promise.all(Array.from({ length: Math.min(6, os.cpus().length) }, worker));

const base = path.join(outDir, `${CODE.toLowerCase()}-faixa`);
// VP9 com canal alfa (yuva420p) — OBS e navegadores leem a transparência
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(tmp, 'f%04d.png'),
  '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '28', '-auto-alt-ref', '0', '-row-mt', '1', `${base}.webm`]);
// prévia: as 3 cenas empilhadas sobre um fundo de exemplo (gradiente "de jogo")
const pv = [1.5, 4.5, 7.5].map((t) => path.join(tmp, `f${String(Math.round(t * FPS)).padStart(4, '0')}.png`));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=0x2b4a6b:c1=0x6b4a2b:x0=0:y0=0:x1=${W}:y1=${H}:d=1`,
  ...pv.flatMap((p) => ['-i', p]),
  '-filter_complex', '[0:v]split=3[g0][g1][g2];[g0][1:v]overlay[o0];[g1][2:v]overlay[o1];[g2][3:v]overlay[o2];[o0][o1][o2]vstack=3,scale=960:-1',
  '-frames:v', '1', `${base}-previa.png`]);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok', `${base}.webm`, `${base}-previa.png`);
