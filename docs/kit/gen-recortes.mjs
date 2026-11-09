// Recorta as imagens dos produtos (fundo escuro → transparente) para o kit de divulgação.
// Saída: docs/kit/img/<key>.png. Uso: node docs/kit/gen-recortes.mjs [keys...]
// Só serve para imagens com o objeto isolado sobre fundo escuro (não para as de Coins grandes, que ocupam o quadro todo).
// Alfa = brilho do pixel (o fundo ~#141418 some, brilho e reflexos ficam) × um degradê radial que apaga as bordas.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../public/img');
const OUT = path.join(HERE, 'img');
const keys = process.argv.slice(2).length ? process.argv.slice(2) : ['c1000', 'c3000', 'c5000', 'gold', 'wildfire', 'bp1', 'bp5', 'bp10', 'bp25'];
fs.mkdirSync(OUT, { recursive: true });

const M = 'max(max(r(X,Y),g(X,Y)),b(X,Y))';
const lum = `clip((${M}-30)*255/45,0,255)`;                              // fundo (≤30) transparente; ≥75 opaco
const fade = 'clip((1-hypot(X-W/2,Y-H/2)/(W/2))/0.18,0,1)';              // apaga cantos e bordas
for (const k of keys) {
  const out = path.join(OUT, `${k}.png`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(SRC, `${k}.jpg`),
    '-vf', `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${lum}*${fade}'`, out]);
  console.log('ok', out);
}
