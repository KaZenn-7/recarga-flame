// Banner animado de parceiro (loop de 3 cenas: marca → cupom → desconto).
// Saída: <cupom>-banner-animado.mp4 (1920×1080, 9 s em loop, H.264) e <cupom>-banner-animado.gif (560×315, ≈2,5 MB).
// Uso: node docs/kit/gen-anim.mjs <CUPOM> <DESCONTO%> <pasta>
//   ex.: node docs/kit/gen-anim.mjs IANSO2 5 /tmp/kit-ianso2
// Como funciona: a animação é CSS pausado; cada quadro é um screenshot do Chromium headless com o tempo
// fixado por #t=<segundos>; o ffmpeg junta os quadros.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const [codeIn, pctIn, outDir] = process.argv.slice(2);
if (!codeIn || !pctIn || !outDir) { console.error('uso: node gen-anim.mjs <CUPOM> <DESCONTO%> <pasta>'); process.exit(1); }
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
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#0e0e10;font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#f4f4f5}
/* todas as animações pausadas; o tempo vem de --t (segundos) */
*{animation-duration:${DUR}s!important;animation-iteration-count:infinite;animation-timing-function:ease-in-out;
  animation-play-state:paused!important;animation-delay:calc(var(--t,0) * -1s)!important;animation-fill-mode:both}
.glow{position:absolute;width:1400px;height:1400px;border-radius:50%;left:260px;top:-160px;
  background:radial-gradient(circle,rgba(255,90,31,.34),rgba(255,90,31,0) 60%);animation-name:orb}
@keyframes orb{0%{transform:translate(-220px,40px)}50%{transform:translate(220px,-40px)}100%{transform:translate(-220px,40px)}}
.scene{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;opacity:0}
.s1{animation-name:s1}.s2{animation-name:s2}.s3{animation-name:s3}
@keyframes s1{0%{opacity:0;transform:translateY(40px) scale(.97)}5%{opacity:1;transform:none}29%{opacity:1;transform:none}34%{opacity:0;transform:translateY(-40px) scale(1.02)}100%{opacity:0}}
@keyframes s2{0%,33%{opacity:0;transform:translateY(40px) scale(.97)}38%{opacity:1;transform:none}62%{opacity:1;transform:none}67%{opacity:0;transform:translateY(-40px) scale(1.02)}100%{opacity:0}}
@keyframes s3{0%,66%{opacity:0;transform:translateY(40px) scale(.97)}71%{opacity:1;transform:none}95%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-40px) scale(1.02)}}
.mark{width:230px;height:230px;border-radius:48px;box-shadow:0 30px 90px rgba(255,90,31,.35)}
.name{font-size:150px;font-weight:900;letter-spacing:-.03em;margin-top:40px}.name span{color:#ff5a1f}
.tag{font-size:52px;color:#c9c9cf;font-weight:600;margin-top:18px}
.lead{font-size:64px;font-weight:700;color:#c9c9cf}
.cup{font-size:210px;font-weight:900;letter-spacing:.1em;padding:20px 80px;border:10px dashed #ff5a1f;border-radius:40px;background:rgba(255,90,31,.08);margin-top:30px}
.link{display:inline-block;font-size:64px;font-weight:800;background:#ff5a1f;color:#160a04;padding:20px 54px;border-radius:26px;margin-top:56px}
.off{font-size:360px;font-weight:900;line-height:.9;letter-spacing:-.05em;color:#ff5a1f;text-shadow:0 20px 80px rgba(255,90,31,.45);animation-name:pop}
@keyframes pop{0%,68%{transform:scale(.85)}74%{transform:scale(1.04)}78%,100%{transform:scale(1)}}
.sub3{font-size:60px;font-weight:700;margin-top:26px}
.mini{position:absolute;left:60px;bottom:50px;display:flex;align-items:center;gap:16px;font-size:40px;font-weight:800;opacity:.85}
.mini img{width:60px;height:60px;border-radius:14px}.mini span{color:#ff5a1f}
</style></head><body>
<div class="glow"></div>
<div class="scene s1"><img class="mark" src="${IMG}/brand-mark.png"><div class="name">Recarga <span>Flame</span></div>
  <div class="tag">Coins e passes do CounterFlame no Pix</div></div>
<div class="scene s2"><div class="lead">Use o cupom</div><div class="cup">${esc(CODE)}</div><div class="link">${LINK}</div></div>
<div class="scene s3"><div class="off">${PCT}% OFF</div><div class="sub3">no Pix · entrega em até 10 minutos</div><div class="link">${LINK}</div></div>
<div class="mini"><img src="${IMG}/brand-mark.png">Recarga <span>Flame</span></div>
<script>document.documentElement.style.setProperty('--t', (location.hash.match(/t=([\\d.]+)/)||[])[1]||0)</script>
</body></html>`;

// a marca pequena no canto não aparece na cena da marca (redundante)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-'));
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(tmp, 'banner.html');
fs.writeFileSync(file, html.replace('.mini{', '.mini{animation-name:mini;').replace('</style>',
  '@keyframes mini{0%,30%{opacity:0}36%,95%{opacity:.85}100%{opacity:0}}</style>'));

const run = promisify(execFile);
const total = DUR * FPS;
let next = 0, done = 0;
async function worker() {
  for (;;) {
    const i = next++; if (i >= total) return;
    const t = (i / FPS).toFixed(3);
    await run(CHROME, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
      `--window-size=${W},${H}`, '--virtual-time-budget=1500', `--screenshot=${path.join(tmp, `f${String(i).padStart(4, '0')}.png`)}`,
      `file://${file}#t=${t}`], { timeout: 60000 });
    if (++done % 50 === 0) console.log(`quadros: ${done}/${total}`);
  }
}
await Promise.all(Array.from({ length: Math.min(6, os.cpus().length) }, worker));

const base = path.join(outDir, `${CODE.toLowerCase()}-banner-animado`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(tmp, 'f%04d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', `${base}.mp4`]);
// GIF leve (≈2,5 MB) para WhatsApp/Discord: 12 fps, 560 px, 64 cores
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${base}.mp4`,
  '-vf', 'fps=12,scale=560:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  '-loop', '0', `${base}.gif`]);
// prévia: um quadro do meio de cada cena
for (const [n, t] of [['marca', 1.5], ['cupom', 4.5], ['desconto', 7.5]]) {
  fs.copyFileSync(path.join(tmp, `f${String(Math.round(t * FPS)).padStart(4, '0')}.png`), `${base}-previa-${n}.png`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok', `${base}.mp4`, `${base}.gif`);
