// QR code do parceiro para vídeos (quem assiste na TV escaneia com o celular).
// Uso: node docs/kit/gen-qr.mjs <CUPOM> <DESCONTO%> <pasta> [src]   (src padrão: yt → aparece como "youtube" no funil)
// Saída:
//   <cupom>-qr.png          só o QR, 1200×1200, preto no branco (para quem edita o vídeo do seu jeito)
//   <cupom>-qr-card.png     cartão com QR + cupom + link, FUNDO TRANSPARENTE (arrastar para o canto do vídeo)
//   <cupom>-qr-overlay.png  1920×1080 transparente com o cartão no canto inferior direito (pronto para a timeline/OBS)
//   <cupom>-qr-previa.png   como fica sobre um quadro de exemplo
// O QR aponta para https://recargaflame.com.br/<cupom>?src=<src> — o link curto aplica o cupom e guarda a origem.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const [codeIn, pctIn, outDir, src = 'yt'] = process.argv.slice(2);
if (!codeIn || !pctIn || !outDir) { console.error('uso: node gen-qr.mjs <CUPOM> <DESCONTO%> <pasta> [src]'); process.exit(1); }
const CODE = codeIn.toUpperCase();
const PCT = String(pctIn).replace('.', ',');
const lower = CODE.toLowerCase();
const URL_ = `https://recargaflame.com.br/${lower}?src=${encodeURIComponent(src)}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMG = `file://${ROOT}/public/img`;
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`;
fs.mkdirSync(outDir, { recursive: true });

// QR: correção de erro M, margem padrão (4 módulos), preto no branco = melhor leitura à distância
const opts = { errorCorrectionLevel: 'M', margin: 4, color: { dark: '#000000', light: '#ffffff' } };
await QRCode.toFile(path.join(outDir, `${lower}-qr.png`), URL_, { ...opts, width: 1200 });
console.log('ok', path.join(outDir, `${lower}-qr.png`));
const svg = await QRCode.toString(URL_, { ...opts, type: 'svg', margin: 2 });

const shot = (name, w, h, css, body, transparent = true) => {
  const html = path.join(outDir, `${name}.html`);
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box;margin:0}
html,body{width:${w}px;height:${h}px;overflow:hidden;font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;${transparent ? 'background:transparent' : ''}}
.card{width:560px;background:#fff;border-radius:36px;padding:34px 38px 30px;text-align:center;color:#111;box-shadow:0 18px 60px rgba(0,0,0,.45);border:6px solid #ff5a1f}
.brand{display:flex;align-items:center;justify-content:center;gap:12px;font-weight:800;font-size:34px;letter-spacing:-.02em}
.brand img{width:48px;height:48px;border-radius:12px}.brand span{color:#ff5a1f}
.qr{width:460px;height:460px;margin:10px auto 6px}.qr svg{width:100%;height:100%;display:block}
.cta{font-size:30px;font-weight:800;line-height:1.15}
.cta small{display:block;font-size:22px;font-weight:600;color:#555;margin-top:6px}
.cup{display:inline-block;margin-top:16px;font-size:38px;font-weight:900;letter-spacing:.12em;border:4px dashed #ff5a1f;border-radius:14px;padding:4px 22px;color:#111}
.link{margin-top:14px;font-size:24px;font-weight:800;color:#ff5a1f}
${css}</style></head><body>${body}</body></html>`);
  const png = path.join(outDir, `${lower}-${name}.png`);
  execFileSync(CHROME, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    ...(transparent ? ['--default-background-color=00000000'] : []),
    `--window-size=${w},${h}`, '--virtual-time-budget=2000', `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  fs.rmSync(html);
  console.log('ok', png);
};

const card = `<div class="card">
  <div class="brand"><img src="${IMG}/brand-mark.png">Recarga <span>Flame</span></div>
  <div class="qr">${svg}</div>
  <div class="cta">Aponte a câmera do celular<small>${PCT}% OFF já aplicado com o cupom</small></div>
  <div class="cup">${CODE}</div>
  <div class="link">recargaflame.com.br/${lower}</div>
</div>`;

// cartão sozinho (com folga para a sombra)
shot('qr-card', 680, 1020, 'body{display:flex;align-items:center;justify-content:center}', card);
// 1920×1080 com o cartão no canto inferior direito, em escala para vídeo (QR ≈ 300 px de altura: lê bem na TV)
const corner = 'body{position:relative}.wrap{position:absolute;right:60px;bottom:50px;transform:scale(.72);transform-origin:bottom right}';
shot('qr-overlay', 1920, 1080, corner, `<div class="wrap">${card}</div>`);
// prévia sobre um quadro de exemplo
shot('qr-previa', 1920, 1080, `${corner}body{background:radial-gradient(circle at 35% 45%,#5a3a24,#1b1d24 60%,#0d0e12)}
  .demo{position:absolute;left:120px;top:120px;color:rgba(255,255,255,.35);font-size:64px;font-weight:800}`,
`<div class="demo">(seu vídeo aqui)</div><div class="wrap">${card}</div>`, false);
