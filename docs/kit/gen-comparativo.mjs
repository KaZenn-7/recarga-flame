// Imagem "Recarga Flame × venda manual" no estilo do kit: post 1080×1350 e story 1080×1920.
// Uso: node docs/kit/gen-comparativo.mjs <pasta-de-saída> [CUPOM] [DESCONTO%]
//   sem cupom: rodapé com recargaflame.com.br; com cupom: rodapé com o cupom e o link curto do parceiro.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [outDir, codeIn, pctIn = '5'] = process.argv.slice(2);
if (!outDir) { console.error('uso: node gen-comparativo.mjs <pasta> [CUPOM] [DESCONTO%]'); process.exit(1); }
const CODE = codeIn ? codeIn.toUpperCase() : null;
const PCT = String(pctIn).replace('.', ',');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMG = `file://${ROOT}/public/img`;
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`;
fs.mkdirSync(outDir, { recursive: true });
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// [item, Recarga Flame, venda manual] — mesmo conteúdo da tabela de docs/parcerias/proposta-youtuber.md
const ROWS = [
  ['⚡ Entrega', 'Automática, em segundos*', 'Quando o vendedor responder'],
  ['🌙 Horário', '24h, todos os dias', 'Só com vendedor online'],
  ['💸 Pagamento', 'Pix confirmado sozinho', 'Mandar comprovante e esperar'],
  ['🧾 Preço', 'Fixo no site', 'Combinado na conversa'],
  ['🔒 Sua conta', 'Só o ID, sem senha', 'Às vezes pedem login'],
  ['📦 Pedido', 'Página do pedido + e\u2011mail', 'Perguntar no chat'],
  ['🛟 Se não entregar', 'Reembolso do Pix', 'Depende do vendedor'],
];

const BASE = `*{box-sizing:border-box;margin:0}
body{font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#f4f4f5;background:#0e0e10;overflow:hidden;
  display:flex;flex-direction:column;align-items:center;justify-content:space-between;text-align:center}
.brand{display:flex;align-items:center;gap:18px;justify-content:center}.brand img{border-radius:16px}.brand b{letter-spacing:-.02em}.brand span{color:#ff5a1f}
h1{font-weight:900;letter-spacing:-.03em;line-height:1.05}h1 span{color:#ff5a1f}
.sub{color:#c9c9cf;font-weight:600}
table{width:100%;border-collapse:separate;border-spacing:0 12px;text-align:left}
th{font-weight:800;color:#c9c9cf;padding:0 22px}
th.rf{color:#ff5a1f}
td{background:#161618;border-top:2px solid #2a2a2e;border-bottom:2px solid #2a2a2e;padding:0 22px;font-weight:600;line-height:1.2}
td:first-child{border-left:2px solid #2a2a2e;border-radius:20px 0 0 20px;color:#c9c9cf;font-weight:700;white-space:nowrap}
td:last-child{border-right:2px solid #2a2a2e;border-radius:0 20px 20px 0;color:#8a8a92}
td.rf{background:rgba(255,90,31,.12);border-color:rgba(255,90,31,.55);color:#fff;font-weight:800}
td.rf::before{content:"✓ ";color:#ff5a1f;font-weight:900}
td.mn::before{content:"✕ ";color:#6b6b73;font-weight:900}
.cup{display:inline-block;font-weight:900;letter-spacing:.12em;border:4px dashed #ff5a1f;border-radius:18px;background:rgba(255,90,31,.08)}
.link{display:inline-block;font-weight:800;background:#ff5a1f;color:#160a04;border-radius:20px}
.nota{color:#8a8a92;font-weight:500}`;

const brand = (img, font) => `<div class="brand"><img src="${IMG}/brand-mark.png" style="width:${img}px;height:${img}px"><b style="font-size:${font}px">Recarga <span>Flame</span></b></div>`;
const table = (fs_, rowH) => `<table style="font-size:${fs_}px"><thead><tr><th></th><th class="rf" style="font-size:${fs_ + 4}px">Recarga Flame</th><th style="font-size:${fs_ + 4}px">Venda manual</th></tr></thead><tbody>
  ${ROWS.map(([a, b, c]) => `<tr style="height:${rowH}px"><td>${esc(a)}</td><td class="rf">${esc(b)}</td><td class="mn">${esc(c)}</td></tr>`).join('')}</tbody></table>`;
const footer = (fsLink, fsCup) => (CODE
  ? `<div><div style="font-size:${fsCup * 0.62}px;font-weight:700">${PCT}% OFF com o cupom <span class="cup" style="font-size:${fsCup}px;padding:6px 26px;margin-left:10px">${esc(CODE)}</span></div>
     <div class="link" style="font-size:${fsLink}px;padding:16px 38px;margin-top:22px">recargaflame.com.br/${esc(CODE.toLowerCase())}</div></div>`
  : `<div class="link" style="font-size:${fsLink}px;padding:16px 38px">recargaflame.com.br</div>`);
const nota = (fs_) => `<div class="nota" style="font-size:${fs_}px">*Pedidos com entrega automática. Alguns pedidos passam por verificação de segurança.<br>Revenda independente, sem vínculo com a Valve nem com a equipe do CounterFlame.</div>`;

const pages = {
  comparativo: [1080, 1350, `body{width:1080px;height:1350px;padding:60px 50px 44px;
    background-image:radial-gradient(circle at 50% 30%,rgba(255,90,31,.22),rgba(255,90,31,0) 55%)}`,
    `<div>${brand(64, 42)}<h1 style="font-size:66px;margin-top:22px">Pagou, <span>chegou.</span></h1>
       <div class="sub" style="font-size:28px;margin-top:10px">Sem esperar vendedor ficar online ou responder</div></div>
     ${table(27, 94)}
     <div>${footer(36, 40)}<div style="margin-top:20px">${nota(17)}</div></div>`],
  'comparativo-story': [1080, 1920, `body{width:1080px;height:1920px;padding:170px 50px 250px;
    background-image:radial-gradient(circle at 50% 30%,rgba(255,90,31,.24),rgba(255,90,31,0) 55%)}`,
    `<div>${brand(76, 50)}<h1 style="font-size:88px;margin-top:30px">Pagou, <span>chegou.</span></h1>
       <div class="sub" style="font-size:34px;margin-top:14px">Sem esperar vendedor ficar online<br>ou responder</div></div>
     ${table(27, 104)}
     <div>${footer(44, 50)}<div style="margin-top:26px">${nota(20)}</div></div>`],
};

for (const [name, [w, h, css, body]] of Object.entries(pages)) {
  const html = path.join(outDir, `${name}.html`);
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE}${css}</style></head><body>${body}</body></html>`);
  const png = path.join(outDir, `${CODE ? CODE.toLowerCase() + '-' : ''}${name}.png`);
  execFileSync(CHROME, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--window-size=${w},${h}`, '--virtual-time-budget=3000', `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  fs.rmSync(html);
  console.log('ok', png);
}
