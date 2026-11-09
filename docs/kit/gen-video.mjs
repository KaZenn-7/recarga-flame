// Vídeo de divulgação (~20 s, sem áudio) — vertical 1080×1920 (Shorts/Reels/TikTok) e horizontal 1920×1080 (YouTube).
// Uso: node docs/kit/gen-video.mjs <pasta> [CUPOM] [DESCONTO%] [src]
//   sem cupom: final com recargaflame.com.br e QR do site; com cupom: final com o desconto, o cupom e o QR do link curto.
// Roteiro: 0–3 s "Pagou, chegou." · 3–7 s produtos · 7–14 s passo a passo nas telas reais (gen-telas.mjs)
//          · 14–17 s 24h e sem senha · 17–20 s link + QR.
// Cada quadro: o tempo é aplicado por JS (render(t)) num único Chromium via DevTools e o PNG vai direto para o ffmpeg.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const [outDir, codeIn, pctIn = '5', src = 'yt'] = process.argv.slice(2);
if (!outDir) { console.error('uso: node gen-video.mjs <pasta> [CUPOM] [DESCONTO%] [src]'); process.exit(1); }
const CODE = codeIn ? codeIn.toUpperCase() : null;
const PCT = String(pctIn).replace('.', ',');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const IMG = `file://${ROOT}/public/img`, CUT = `file://${HERE}/img`, TELAS = `file://${HERE}/telas`;
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`;
const DUR = 20, FPS = 30;
fs.mkdirSync(outDir, { recursive: true });
for (const t of ['1-id', '2-catalogo', '4-pix', '5-entregue']) if (!fs.existsSync(path.join(HERE, 'telas', `${t}.png`))) throw new Error('faltam as telas: rode node docs/kit/gen-telas.mjs');

const LINK = CODE ? `recargaflame.com.br/${CODE.toLowerCase()}` : 'recargaflame.com.br';
const QR_URL = CODE ? `https://recargaflame.com.br/${CODE.toLowerCase()}?src=${encodeURIComponent(src)}` : 'https://recargaflame.com.br';
const qrSvg = await QRCode.toString(QR_URL, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } });
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const page = (V) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${V ? 1080 : 1920}px;height:${V ? 1920 : 1080}px;overflow:hidden;background:#0e0e10;font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#f4f4f5}
.glow{position:absolute;width:1500px;height:1500px;border-radius:50%;left:50%;top:50%;margin:-750px 0 0 -750px;background:radial-gradient(circle,rgba(255,90,31,.30),rgba(255,90,31,0) 60%)}
.sc{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;opacity:0}
.mini{position:absolute;display:flex;align-items:center;gap:14px;font-weight:800;${V ? 'top:90px;left:0;right:0;justify-content:center;font-size:40px' : 'left:60px;bottom:48px;font-size:36px'}}
.mini img{width:${V ? 58 : 52}px;height:${V ? 58 : 52}px;border-radius:14px}.mini span,.or{color:#ff5a1f}
h1{font-weight:900;letter-spacing:-.04em;line-height:.95}
.w{display:inline-block}
.sub{color:#c9c9cf;font-weight:700}
.prods{display:grid;gap:${V ? '40px 30px' : '30px'};grid-template-columns:repeat(${V ? 2 : 4},${V ? 420 : 380}px)}
.prod{display:flex;flex-direction:column;align-items:center}
.prod img{width:${V ? 360 : 330}px;height:${V ? 360 : 330}px;object-fit:contain;filter:drop-shadow(0 24px 36px rgba(0,0,0,.55))}
.prod b{font-size:${V ? 44 : 38}px;margin-top:6px}
.phone{position:absolute;width:${V ? 640 : 470}px;height:${V ? 1376 : 1010}px;border-radius:${V ? 76 : 58}px;background:#1b1b1f;padding:${V ? 18 : 14}px;
  box-shadow:0 40px 120px rgba(0,0,0,.6),0 0 0 3px #2c2c32;${V ? 'left:220px;top:440px' : 'right:250px;top:35px'}}
.scr{position:absolute;inset:${V ? 18 : 14}px;border-radius:${V ? 60 : 46}px;overflow:hidden;background:#0e0e10}
.scr img{position:absolute;inset:0;width:100%;height:auto}
.cap{position:absolute;${V ? 'left:0;right:0;top:190px;text-align:center' : 'left:150px;top:0;bottom:0;width:900px;display:flex;flex-direction:column;justify-content:center'}}
.cap div{position:absolute;${V ? 'left:0;right:0' : 'left:0;right:0;top:50%;transform:translateY(-50%)'};font-weight:900;letter-spacing:-.02em;font-size:${V ? 84 : 96}px;line-height:1.05}
.cap small{display:block;font-size:${V ? 40 : 44}px;color:#c9c9cf;font-weight:700;letter-spacing:0;margin-top:14px}
.num{display:inline-flex;align-items:center;justify-content:center;width:${V ? 96 : 104}px;height:${V ? 96 : 104}px;border-radius:50%;background:#ff5a1f;color:#160a04;margin-right:22px;font-size:${V ? 58 : 62}px;vertical-align:middle}
.badges{display:flex;flex-direction:column;gap:34px;align-items:stretch}
.badge{display:flex;align-items:center;gap:28px;background:#161618;border:3px solid #2a2a2e;border-radius:36px;padding:${V ? '34px 44px' : '30px 44px'};font-size:${V ? 62 : 66}px;font-weight:900;text-align:left}
.badge i{font-style:normal;font-size:${V ? 80 : 84}px}
.badge small{display:block;font-size:${V ? 34 : 36}px;color:#c9c9cf;font-weight:700}
.cta{display:flex;${V ? 'flex-direction:column;gap:46px' : 'flex-direction:row;gap:110px'};align-items:center}
.brand{display:flex;align-items:center;gap:22px;justify-content:${V ? 'center' : 'flex-start'}}.brand img{width:110px;height:110px;border-radius:26px}
.brand b{font-size:84px;letter-spacing:-.03em}
.link{display:inline-block;font-weight:900;background:#ff5a1f;color:#160a04;border-radius:28px;padding:22px 46px;font-size:${CODE ? (V ? 54 : 60) : (V ? 64 : 70)}px}
.off{font-weight:900;color:#ff5a1f;letter-spacing:-.04em;line-height:1;font-size:${V ? 150 : 140}px;text-shadow:0 14px 60px rgba(255,90,31,.4)}
.cup{display:inline-block;font-weight:900;letter-spacing:.12em;border:7px dashed #ff5a1f;border-radius:26px;background:rgba(255,90,31,.08);padding:6px 40px;font-size:${V ? 84 : 80}px}
.qrc{background:#fff;border-radius:34px;padding:22px;border:6px solid #ff5a1f;text-align:center;color:#111;font-weight:800;font-size:${V ? 32 : 30}px}
.qrc svg{width:${V ? 360 : 380}px;height:${V ? 360 : 380}px;display:block}
.nota{position:absolute;left:0;right:0;bottom:${V ? 80 : 26}px;text-align:center;color:#8a8a92;font-size:${V ? 24 : 22}px;font-weight:500;line-height:1.4}
</style></head><body>
<div class="glow" id="glow"></div>
<div class="mini" id="mini"><img src="${IMG}/brand-mark.png">Recarga <span>Flame</span></div>

<div class="sc" id="s1">
  <h1 style="font-size:${V ? 190 : 230}px"><span class="w" id="w1">Pagou,</span> <span class="w or" id="w2">chegou.</span></h1>
  <div class="sub" id="s1sub" style="font-size:${V ? 54 : 60}px;margin-top:40px">Itens de CounterFlame no Pix</div>
</div>

<div class="sc" id="s2">
  <div class="sub" id="s2t" style="font-size:${V ? 64 : 64}px;margin-bottom:${V ? 60 : 50}px;color:#f4f4f5;font-weight:900">Coins, passes e coleções</div>
  <div class="prods">
    ${[['c200000', 'Coins'], ['gold', 'Gold Pass'], ['wildfire', 'Coleções'], ['bp25', 'Níveis de Passe']].map(([k, n], i) => `<div class="prod" id="p${i}"><img src="${CUT}/${k}.png"><b>${n}</b></div>`).join('')}
  </div>
</div>

<div class="sc" id="s3" style="opacity:0">
  <div class="cap">
    <div id="c0"><span class="num">1</span>Coloque seu ID<small>Só o ID do jogo, sem senha</small></div>
    <div id="c1"><span class="num">2</span>Escolha o item<small>Preço fixo, direto no site</small></div>
    <div id="c2"><span class="num">3</span>Pague no Pix<small>Confirmação automática</small></div>
    <div id="c3"><span class="num">✓</span>Chegou!<small>Entrega automática em segundos*</small></div>
  </div>
  <div class="phone" id="phone"><div class="scr">
    <img id="t0" src="${TELAS}/1-id.png"><img id="t1" src="${TELAS}/2-catalogo.png"><img id="t2" src="${TELAS}/4-pix.png"><img id="t3" src="${TELAS}/5-entregue.png">
  </div></div>
</div>

<div class="sc" id="s4">
  <div class="badges">
    <div class="badge" id="b0"><i>🌙</i><div>24 horas por dia<small>Madrugada, fim de semana e feriado</small></div></div>
    <div class="badge" id="b1"><i>🔒</i><div>Só o ID, sem senha<small>Nunca pedimos login ou código</small></div></div>
    <div class="badge" id="b2"><i>⚡</i><div>Sem esperar vendedor<small>Pagou, chegou</small></div></div>
  </div>
</div>

<div class="sc" id="s5">
  <div class="cta">
    <div style="display:flex;flex-direction:column;gap:${V ? 34 : 38}px;align-items:${V ? 'center' : 'flex-start'}">
      <div class="brand" id="f0"><img src="${IMG}/brand-mark.png"><b>Recarga <span class="or">Flame</span></b></div>
      ${CODE ? `<div id="f1" style="text-align:${V ? 'center' : 'left'}"><div class="off">${PCT}% OFF</div><div style="font-size:${V ? 46 : 44}px;font-weight:800;margin:${V ? 10 : 8}px 0 ${V ? 20 : 16}px">com o cupom</div><div class="cup">${esc(CODE)}</div></div>`
    : `<div id="f1" class="sub" style="text-align:${V ? 'center' : 'left'};font-size:${V ? 54 : 56}px;color:#f4f4f5;font-weight:900">Coins, passes e coleções<br>com entrega automática 24h</div>`}
      <div id="f2"><div class="link">${esc(LINK)}</div></div>
    </div>
    <div class="qrc" id="f3">${qrSvg}<div style="margin-top:12px">Aponte a câmera</div></div>
  </div>
  <div class="nota" id="nota">*Pedidos com entrega automática. Alguns pedidos passam por verificação de segurança.<br>Revenda independente, sem vínculo com a Valve nem com a equipe do CounterFlame.</div>
</div>

<script>
const $=id=>document.getElementById(id);
const cl=x=>Math.max(0,Math.min(1,x));
const ease=x=>1-Math.pow(1-cl(x),3);                     // easeOutCubic
const back=x=>{x=cl(x);const c=1.6;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2);}; // leve "pulo"
const inn=(t,a,d=.45)=>ease((t-a)/d);                     // entra em a
const out=(t,b,d=.35)=>1-ease((t-b)/d);                   // sai em b
const vis=(t,a,b)=>Math.min(inn(t,a),out(t,b));
function set(id,o,y=0,s=1,x=0){const e=$(id);e.style.opacity=o;e.style.transform='translate('+x+'px,'+y+'px) scale('+s+')';}
window.render=function(t){
  $('glow').style.transform='translate('+Math.sin(t*.45)*220+'px,'+Math.cos(t*.35)*120+'px)';
  set('mini', t<2.8||t>16.8?0:Math.min(inn(t,2.8),out(t,16.6)));
  // 1. gancho
  set('s1',out(t,2.65)); const a=inn(t,.15,.4), b=inn(t,.75,.4);
  set('w1',a,(1-a)*60,.85+.15*back((t-.15)/.5)); set('w2',b,(1-b)*60,.85+.15*back((t-.75)/.5)); set('s1sub',inn(t,1.4),(1-inn(t,1.4))*30);
  // 2. produtos
  set('s2',vis(t,3,6.65)); set('s2t',inn(t,3.05),(1-inn(t,3.05))*30);
  for(let i=0;i<4;i++){const k=inn(t,3.25+i*.22,.5);set('p'+i,k,(1-k)*80,.7+.3*back((t-3.25-i*.22)/.6));$('p'+i).querySelector('img').style.transform='translateY('+Math.sin(t*2+i)*8+'px)';}
  // 3. passo a passo nas telas
  set('s3',vis(t,7,13.65)); const ph=inn(t,7,.6); set('phone',ph,(1-ph)*140);
  const T=[7,8.75,10.5,12.25,14];
  for(let i=0;i<4;i++){const o=i===3?inn(t,T[i],.35):Math.min(inn(t,T[i],.35),out(t,T[i+1]-.25,.3));
    $('t'+i).style.opacity=i===0?(t<T[1]?1:out(t,T[1]-.25,.3)):o;
    set('c'+i,i===0?Math.min(inn(t,7.3),out(t,T[1]-.25,.3)):o,${V ? '(1-o)*30' : '0'},1,${V ? '0' : '(1-o)*-40'});}
  // toque no catálogo: rola um pouco a lista
  $('t1').style.transform='translateY('+(-ease((t-9.4)/1)*220*${V ? 1 : 0.75})+'px)';
  // 4. vantagens
  set('s4',vis(t,14,16.65));
  for(let i=0;i<3;i++){const k=inn(t,14.1+i*.35,.5);set('b'+i,k,0,1,(1-k)*${V ? 120 : 160});}
  // 5. CTA
  set('s5',inn(t,17,.4));
  set('f0',inn(t,17.05),(1-inn(t,17.05))*40); set('f1',inn(t,17.3),(1-inn(t,17.3))*40,.9+.1*back((t-17.3)/.5));
  set('f2',inn(t,17.6),(1-inn(t,17.6))*40); set('f3',inn(t,17.8),0,.8+.2*back((t-17.8)/.6)); set('nota',inn(t,18.2));
};
render(0);
</script></body></html>`;

// ---- Chromium via DevTools ----
async function browser() {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-video-'));
  const proc = spawn(CHROME, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--remote-debugging-port=0', `--user-data-dir=${prof}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((ok, bad) => { let b = ''; proc.stderr.on('data', (d) => { b += d; const m = b.match(/DevTools listening on (ws:\S+)/); if (m) ok(m[1]); }); setTimeout(() => bad(new Error('chrome não abriu')), 15000); });
  const tgt = (await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`)).json()).find((x) => x.type === 'page');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((ok, bad) => { const id = ++seq; pend.set(id, (m) => (m.error ? bad(new Error(method + ': ' + m.error.message)) : ok(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  return { cdp, close: () => { ws.close(); proc.kill(); fs.rmSync(prof, { recursive: true, force: true }); } };
}

const nome = CODE ? CODE.toLowerCase() : 'recargaflame';
const { cdp, close } = await browser();
try {
  await cdp('Page.enable');
  for (const V of [true, false]) {
    const [W, H] = V ? [1080, 1920] : [1920, 1080];
    const file = path.join(outDir, `video-${V ? 'v' : 'h'}.html`);
    fs.writeFileSync(file, page(V));
    await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `file://${file}` });
    for (let i = 0; i < 100; i++) { const r = await cdp('Runtime.evaluate', { expression: "document.readyState==='complete' && [...document.images].every(i=>i.complete) && typeof render==='function'", returnByValue: true }); if (r.result.value) break; await new Promise((r) => setTimeout(r, 100)); }
    const mp4 = path.join(outDir, `${nome}-video-${V ? 'vertical' : 'horizontal'}.mp4`);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '19', '-preset', 'medium', '-movflags', '+faststart', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((ok, bad) => ff.on('close', (c) => (c ? bad(new Error('ffmpeg ' + c)) : ok())));
    const prev = { 1.6: 'gancho', 5.2: 'produtos', 8: 'passo1', 11.5: 'passo3', 13.3: 'entregue', 15.8: 'vantagens', 19.5: 'final' };
    for (let i = 0; i < DUR * FPS; i++) {
      const t = i / FPS;
      await cdp('Runtime.evaluate', { expression: `render(${t})` });
      const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
      const buf = Buffer.from(data, 'base64');
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      const k = Object.keys(prev).find((x) => Math.abs(Number(x) - t) < 1e-6);
      if (k) fs.writeFileSync(path.join(outDir, `${nome}-video-${V ? 'vertical' : 'horizontal'}-previa-${prev[k]}.jpg`), buf);
      if ((i + 1) % 150 === 0) console.log(`${V ? 'vertical' : 'horizontal'}: ${i + 1}/${DUR * FPS}`);
    }
    ff.stdin.end(); await done; fs.rmSync(file);
    console.log('ok', mp4);
  }
} finally { close(); }
