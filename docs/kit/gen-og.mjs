// Prévia de link (Open Graph, 1200×630): o que aparece ao colar o link no WhatsApp/Telegram/Discord.
// Uso:
//   node docs/kit/gen-og.mjs <arquivo.jpg>                 → prévia geral da loja (ex.: public/img/og-v2.jpg)
//   node docs/kit/gen-og.mjs <arquivo.jpg> <CUPOM> <DESC%>  → prévia do link de um cupom
//   node docs/kit/gen-og.mjs --cupons                      → gera a prévia de cada cupom ATIVO que ainda não tem
//     (public/img/og-cupom/<cupom>-<desconto>.jpg; a loja usa no link curto do cupom se existir — ver ogCupom no server.js)
// Mesmo visual do kit (produtos recortados de docs/kit/img, marca de public/img). Chromium headless do Playwright + ffmpeg (JPG).
// Prévia geral: ao trocar a imagem, use um NOME NOVO (og-v3.jpg…) e atualize o og:image das páginas — os apps guardam
// a prévia pelo endereço. As de cupom já mudam de nome quando o desconto muda.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMG = `file://${ROOT}/public/img`;
const CUT = `file://${ROOT}/docs/kit/img`;
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`;
// nome do arquivo da prévia de um cupom (o server.js monta o mesmo nome)
export const ogCupomFile = (code, pct) => `${String(code).toLowerCase()}-${String(pct).replace('.', '_')}.jpg`;

const css = `*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#f4f4f5;background:#0e0e10;
  background-image:radial-gradient(circle at 18% 45%,rgba(255,90,31,.30),rgba(255,90,31,0) 52%),radial-gradient(circle at 78% 50%,rgba(255,90,31,.16),rgba(255,90,31,0) 45%);
  display:flex;align-items:center;justify-content:space-between;padding:0 30px 0 70px}
.brand{display:flex;align-items:center;gap:20px}.brand img{width:86px;height:86px;border-radius:18px}
.brand b{font-size:56px;letter-spacing:-.02em}.brand span{color:#ff5a1f}
h1{font-size:44px;line-height:1.18;font-weight:800;margin:34px 0 26px;letter-spacing:-.01em}
.pill{font-size:24px;font-weight:600;color:#c9c9cf;margin-top:12px}
.prods{display:flex;flex-wrap:wrap;justify-content:center;width:600px;gap:10px 6px}
.prods img{width:196px;height:196px;object-fit:contain;filter:drop-shadow(0 18px 28px rgba(0,0,0,.6))}
.brand.sm img{width:64px;height:64px;border-radius:14px}.brand.sm b{font-size:42px}
.off{font-size:104px;font-weight:900;line-height:.95;letter-spacing:-.04em;color:#ff5a1f;margin-top:26px;text-shadow:0 10px 40px rgba(255,90,31,.35)}
.com{font-size:30px;font-weight:700;margin:10px 0 12px}
.cup{display:inline-block;font-size:44px;font-weight:900;letter-spacing:.12em;border:4px dashed #ff5a1f;border-radius:16px;background:rgba(255,90,31,.08);padding:4px 26px}
.link{display:inline-block;font-size:28px;font-weight:800;background:#ff5a1f;color:#160a04;border-radius:16px;padding:10px 24px;margin-top:22px}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const prods = `<div class="prods">${['c200000', 'gold', 'arsenal', 'wildfire', 'bp25'].map((k) => `<img src="${CUT}/${k}.png">`).join('')}</div>`;
const geral = `<div>
  <div class="brand"><img src="${IMG}/brand-mark.png"><b>Recarga <span>Flame</span></b></div>
  <h1>Coins e passes do<br>CounterFlame no Pix</h1>
  <div class="pill">⚡ Entrega automática em até 10 min</div>
  <div class="pill">🔒 Só o ID da conta, sem senha</div>
</div>${prods}`;
const cupom = (code, pct) => `<div>
  <div class="brand sm"><img src="${IMG}/brand-mark.png"><b>Recarga <span>Flame</span></b></div>
  <div class="off">${esc(String(pct).replace('.', ','))}% OFF</div>
  <div class="com">com o cupom</div>
  <div class="cup">${esc(code)}</div>
  <div><div class="link">recargaflame.com.br/${esc(code.toLowerCase())}</div></div>
</div>${prods}`;

function render(out, body) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
  const html = path.join(tmp, 'og.html'), png = path.join(tmp, 'og.png');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
  execFileSync(CHROME, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--window-size=1200,630', '--virtual-time-budget=3000', `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-q:v', '3', path.resolve(out)]);
  fs.rmSync(tmp, { recursive: true });
  console.log('ok', path.resolve(out), fs.statSync(out).size, 'bytes');
}

const [a1, a2, a3] = process.argv.slice(2);
if (a1 === '--cupons') {
  const Database = createRequire(path.join(ROOT, 'package.json'))('better-sqlite3');
  const db = new Database(path.join(ROOT, 'loja.db'), { readonly: true });
  const dir = path.join(ROOT, 'public/img/og-cupom');
  for (const c of db.prepare('SELECT code, desconto_pct FROM coupons WHERE ativo=1 AND desconto_pct > 0 ORDER BY code').all()) {
    const f = path.join(dir, ogCupomFile(c.code, c.desconto_pct));
    if (fs.existsSync(f)) { console.log('já existe', f); continue; }
    render(f, cupom(c.code, c.desconto_pct));
  }
} else if (a1 && /\.jpe?g$/i.test(a1)) {
  if (a2 && !(/^[A-Z0-9_-]{3,20}$/i.test(a2) && Number(a3) > 0)) { console.error('cupom/desconto inválidos'); process.exit(1); }
  render(a1, a2 ? cupom(a2.toUpperCase(), Number(a3)) : geral);
} else {
  console.error('uso: node gen-og.mjs <arquivo.jpg> [CUPOM DESCONTO%]  |  node gen-og.mjs --cupons'); process.exit(1);
}
