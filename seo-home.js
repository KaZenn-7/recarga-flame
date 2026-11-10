// Home renderizada no servidor para buscadores: vitrine de preços (HTML estático, sem precisar do ID)
// e dados estruturados (Organization, WebSite e a lista de produtos com preço) a partir dos produtos ativos.
// Os marcadores <!--VITRINE--> e <!--LDJSON--> ficam em public/index.html.

const SITE = 'https://recargaflame.com.br';
const ORD = ['Coins', 'Coleções', 'Passes', 'Níveis de Passe'];
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const brl = (c) => 'R$ ' + (c / 100).toFixed(2).replace('.', ',');

// prods: [{ key, nome, cents, cat, img }] (mesmo formato de /api/products)
export function vitrineHtml(prods) {
  const g = {};
  for (const p of prods) (g[p.cat] ||= []).push(p);
  const cats = Object.keys(g).sort((a, b) => (ORD.indexOf(a) + 1 || 99) - (ORD.indexOf(b) + 1 || 99));
  if (!cats.length) return '';
  return `<section class="vit" id="precos" aria-labelledby="vit-t">
    <h2 id="vit-t">Produtos e preços</h2>
    <p class="sub">Preços no Pix. Para comprar, digite seu ID acima. <a href="/comprar-coins-counterflame">Preço por 1.000 Coins</a>.</p>
${cats.map((c) => `    <div class="cat"><h3>${escH(c)}</h3><ul class="vgrid">${g[c].map((p) =>
    `<li><img src="${escH(p.img)}" alt="${escH(p.nome)}" width="64" height="64" loading="lazy"><span class="n">${escH(p.nome)}</span><span class="p mono">${brl(p.cents)}</span></li>`).join('')}</ul></div>`).join('\n')}
  </section>`;
}

export function ldJson(prods) {
  const org = { '@type': 'Organization', '@id': SITE + '/#org', name: 'Recarga Flame', url: SITE + '/', logo: SITE + '/img/icon-192.png', email: 'suporte@recargaflame.com.br' };
  const site = { '@type': 'WebSite', '@id': SITE + '/#site', name: 'Recarga Flame', url: SITE + '/', inLanguage: 'pt-BR', publisher: { '@id': SITE + '/#org' } };
  const list = {
    '@type': 'ItemList', name: 'Produtos e preços', itemListElement: prods.map((p, i) => ({
      '@type': 'ListItem', position: i + 1, item: {
        '@type': 'Product', name: p.nome + ' — CounterFlame', category: p.cat, image: SITE + p.img,
        description: `${p.nome} do CounterFlame entregue na sua conta pelo ID, pago com Pix.`,
        offers: { '@type': 'Offer', price: (p.cents / 100).toFixed(2), priceCurrency: 'BRL', availability: 'https://schema.org/InStock', url: SITE + '/#precos', seller: { '@id': SITE + '/#org' } },
      },
    })),
  };
  // "<" escapado: nada dentro do JSON consegue fechar a tag <script>
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': [org, site, list] }).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

export function homeHtml(indexHtml, prods) {
  return indexHtml.replace('<!--VITRINE-->', () => vitrineHtml(prods)).replace('<!--LDJSON-->', () => ldJson(prods));
}

// Tabela de pacotes de Coins (página /comprar-coins-counterflame), com preço por 1.000 Coins.
export function coinsTable(prods) {
  const rows = prods.filter((p) => p.cat === 'Coins').map((p) => ({ p, n: Number(String(p.nome).replace(/\D/g, '')) || 0 }))
    .sort((a, b) => a.n - b.n);
  if (!rows.length) return '<p class="tip">Veja os pacotes disponíveis na <a href="/#precos">loja</a>.</p>';
  return `<table class="tbl"><thead><tr><th>Pacote</th><th>Preço</th><th>Por 1.000</th></tr></thead><tbody>${rows.map(({ p, n }) =>
    `<tr><td><span class="pk"><img src="${escH(p.img)}" alt="" width="28" height="28" loading="lazy"><b>${escH(p.nome)}</b></span></td><td><b>${brl(p.cents)}</b></td><td>${n ? brl(Math.round(p.cents * 1000 / n)) : '—'}</td></tr>`).join('')}</tbody></table>`;
}

// Tabela de níveis de passe, com preço por nível.
export function niveisTable(prods) {
  const rows = prods.filter((p) => p.cat === 'Níveis de Passe').map((p) => ({ p, n: Number(String(p.nome).replace(/\D/g, '')) || 0 }))
    .sort((a, b) => a.n - b.n);
  if (!rows.length) return '';
  return `<table class="tbl"><thead><tr><th>Pacote</th><th>Preço</th><th>Por nível</th></tr></thead><tbody>${rows.map(({ p, n }) =>
    `<tr><td><span class="pk"><img src="${escH(p.img)}" alt="" width="28" height="28" loading="lazy"><b>${escH(p.nome)}</b></span></td><td><b>${brl(p.cents)}</b></td><td>${n ? brl(Math.round(p.cents / n)) : '—'}</td></tr>`).join('')}</tbody></table>`;
}

// Marcadores: <!--TABELA_COINS-->, <!--TABELA_NIVEIS-->, <!--PRECO:key--> e <!--LD_PRODUTO:key--> (Product + Offer).
export function pageHtml(html, prods) {
  const byKey = Object.fromEntries(prods.map((p) => [p.key, p]));
  return html
    .replace('<!--TABELA_COINS-->', () => coinsTable(prods))
    .replace('<!--TABELA_NIVEIS-->', () => niveisTable(prods))
    .replace(/<!--PRECO:([a-z0-9_]+)-->/g, (_, k) => (byKey[k] ? brl(byKey[k].cents) : 'consulte na loja'))
    .replace(/<!--LD_PRODUTO:([a-z0-9_]+)-->/g, (_, k) => {
      const p = byKey[k];
      if (!p) return '';
      const json = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'Product', name: p.nome + ' — CounterFlame', image: SITE + p.img,
        description: `${p.nome} do CounterFlame entregue na sua conta pelo ID, pago com Pix.`,
        offers: { '@type': 'Offer', price: (p.cents / 100).toFixed(2), priceCurrency: 'BRL', availability: 'https://schema.org/InStock', url: SITE + '/', seller: { '@type': 'Organization', name: 'Recarga Flame' } },
      }).replace(/</g, '\\u003c');
      return `<script type="application/ld+json">${json}</script>`;
    });
}
