// Site: páginas públicas, suporte, prévia do link, avatar, robots/sitemap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupStore, mock, tgSent, mailSent, avatarCalls, base, db, freshIP, postJ, adm, pagar } from './helpers.js';

setupStore();

test('página "Como funciona": responde em /como-funciona e a loja aponta para ela', async () => {
  const r = await fetch(base + '/como-funciona');
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Como funciona<\/h1>/); assert.match(h, /href="\/perguntas-frequentes"/);
  const f = await fetch(base + '/perguntas-frequentes');
  assert.equal(f.status, 200);
  const fh = await f.text();
  assert.match(fh, /<h1>Perguntas frequentes<\/h1>/); assert.match(fh, /FAQPage/);
  // rodapé igual nas 3 páginas, marcando a página atual
  const loja = await (await fetch(base + '/')).text();
  for (const [p, cur] of [[loja, null], [h, '/como-funciona'], [fh, '/perguntas-frequentes']]) {
    assert.match(p, /<footer class="ft">/);
    assert.match(p, /<a href="\/suporte"( aria-current="page")?>Precisa de ajuda\?<\/a>/); // ajuda → página de suporte
    if (cur) assert.ok(p.includes(`href="${cur}" aria-current="page"`));
  }
});

test('termos de uso e política de privacidade: no ar, linkados no rodapé e no aceite do Pix', async () => {
  const t = await (await fetch(base + '/termos-de-uso')).text();
  assert.match(t, /<h1>Termos de uso<\/h1>/);
  assert.match(t, /reembolso só é possível quando o item não foi entregue/);
  assert.match(t, /inclusive se o ID foi digitado errado/);
  const p = await (await fetch(base + '/politica-de-privacidade')).text();
  assert.match(p, /<h1>Política de privacidade<\/h1>/); assert.match(p, /LGPD/);
  const loja = await (await fetch(base + '/')).text();
  assert.match(loja, /class="terms">Ao gerar o Pix você concorda/);
  for (const pg of [loja, t, p]) assert.match(pg, /class="ft-docs">© 2026 Recarga Flame · <a href="\/termos-de-uso">/);
});

test('suporte: formulário valida, vincula o pedido pelo link e envia e-mail (Responder → cliente) + Telegram', async () => {
  const sup = (b) => fetch(base + '/api/suporte', { method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() }, body: JSON.stringify(b) });
  const pg = await fetch(base + '/suporte');
  assert.equal(pg.status, 200);
  const pgTxt = await pg.text(); // formulário + botão do WhatsApp com mensagem pronta (o que foi preenchido)
  assert.match(pgTxt, /id="wa" type="button" aria-label="Falar pelo WhatsApp"/); // botão com o ícone, ao lado de Enviar
  assert.ok(pgTxt.includes("'https://wa.me/5511954854560?text='+encodeURIComponent(t)"));
  assert.ok(!pgTxt.includes('95485-4560')); // sem o número visível
  assert.match(await (await fetch(base + '/')).text(), /id="supWa" href="https:\/\/wa\.me\/5511954854560/);
  // telas depois do pagamento: destaque, linha do tempo e resumo do pedido
  const home = await (await fetch(base + '/')).text();
  for (const id of ['hero', 'trk', 'resumo', 'e4t']) assert.match(home, new RegExp(`id="${id}"`));
  assert.match(home, /Entregando na sua conta/); assert.match(home, /Entrega pela nossa equipe/);
  assert.equal((await sup({ email: 'x', assunto: 'outro', msg: 'mensagem longa o bastante' })).status, 400);
  assert.equal((await sup({ email: 'a@b.com', assunto: 'hack', msg: 'mensagem longa o bastante' })).status, 400);
  assert.equal((await sup({ email: 'a@b.com', assunto: 'outro', msg: 'curta' })).status, 400);
  // robô (campo invisível): finge sucesso e não envia nada
  const m0 = mailSent.length;
  assert.equal((await sup({ email: 'a@b.com', assunto: 'outro', msg: 'mensagem de robô aqui', site: 'x' })).status, 200);
  assert.equal(mailSent.length, m0);
  // com o link do pedido: pedido verificado, status e alerta de e-mail diferente
  mock.approve = true;
  const p = await (await postJ('/api/orders', { product: 'c1000', gameId: '171711', email: 'dono@x.com' })).json();
  await pagar(p.token);
  const r = await sup({ email: 'outro@x.com', assunto: 'naochegou', msg: 'Paguei e <b>não</b> chegou ainda.', token: p.token, pedido: '999', gameId: '1' });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  const m = mailSent.at(-1);
  assert.deepEqual(m.to, ['suporte@recargaflame.com.br']);
  assert.equal(m.reply_to, 'outro@x.com');
  assert.match(m.subject, new RegExp(`\\[Suporte #${id}\\] Meu pedido não chegou — pedido #${p.id}`));
  assert.match(m.text, new RegExp(`Pedido #${p.id} \\(verificado\\).*ID 171711`));
  assert.match(m.text, /e-mail diferente do usado no pedido/);
  assert.ok(m.html.includes('&#60;b&#62;não&#60;/b&#62;')); // HTML do cliente escapado
  assert.ok(tgSent.some((t) => t.text.includes(`📩 Suporte #${id}`)));
  // sem link: número informado não é tratado como verificado
  await sup({ email: 'c@d.com', assunto: 'duvida', msg: 'Vocês vendem passe de batalha?', pedido: '#55' });
  assert.match(mailSent.at(-1).text, /Pedido informado: #55 \(não verificado\)/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM support_tickets').get().n, 2);
});

test('prévia do link: tags Open Graph; link de cupom ativo mostra o desconto', async () => {
  const h = await (await fetch(base + '/')).text();
  assert.match(h, /<meta property="og:image" content="https:\/\/recargaflame\.com\.br\/img\/og-v2\.jpg">/);
  assert.match(h, /og:title" content="Recarga Flame — Coins e passes/);
  assert.equal((await adm('POST', '/api/admin/coupons', { code: 'AQUILA', desconto_pct: 5, comissao_pct: 20, ativo: true })).status, 200);
  const c = await (await fetch(base + '/?cupom=aquila')).text();
  assert.match(c, /og:title" content="5% OFF com o cupom AQUILA — Recarga Flame"/);
  assert.match(c, /og:url" content="https:\/\/recargaflame\.com\.br\/\?cupom=AQUILA"/);
  // imagem própria do cupom (public/img/og-cupom/aquila-5.jpg, gerada pelo gen-og.mjs) com o desconto certo
  assert.match(c, /og:image" content="https:\/\/recargaflame\.com\.br\/img\/og-cupom\/aquila-5\.jpg"/);
  assert.match(c, /og:image:alt" content="5% OFF com o cupom AQUILA — Recarga Flame"/);
  assert.equal((await fetch(base + '/img/og-cupom/aquila-5.jpg')).status, 200);
  // desconto mudou (sem imagem nova ainda) → imagem geral, nunca um desconto errado
  assert.equal((await adm('PUT', '/api/admin/coupons/AQUILA', { desconto_pct: 7, comissao_pct: 20, ativo: true })).status, 200);
  const c7 = await (await fetch(base + '/?cupom=aquila')).text();
  assert.match(c7, /og:title" content="7% OFF com o cupom AQUILA/);
  assert.match(c7, /og:image" content="https:\/\/recargaflame\.com\.br\/img\/og-v2\.jpg"/);
  const off = await (await fetch(base + '/?cupom=OFF1')).text(); // desativado → prévia padrão
  assert.match(off, /og:title" content="Recarga Flame — Coins e passes/);
  for (const p of ['/como-funciona', '/perguntas-frequentes', '/suporte', '/termos-de-uso', '/politica-de-privacidade'])
    assert.match(await (await fetch(base + p)).text(), /og:image/, p);
});

test('avatar: sem foto → imagem padrão em cache e o CounterFlame não é consultado de novo', async () => {
  const get = () => fetch(base + '/api/player/888777/avatar', { headers: freshIP() });
  const n = avatarCalls.length;
  const r = await get();
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(r.headers.get('cache-control'), /max-age=21600/);
  await get(); await get();
  assert.equal(avatarCalls.length, n + 1); // só a 1ª consultou o CounterFlame
  const ok = await fetch(base + '/api/player/749125/avatar', { headers: freshIP() });
  assert.equal(ok.headers.get('content-type'), 'image/jpeg'); assert.match(ok.headers.get('cache-control'), /max-age=3600/);
});

test('robots.txt e sitemap.xml', async () => {
  const r = await (await fetch(base + '/robots.txt')).text();
  assert.match(r, /Disallow: \/painel/); assert.match(r, /Sitemap: https:\/\/recargaflame\.com\.br\/sitemap\.xml/);
  const s = await fetch(base + '/sitemap.xml');
  assert.equal(s.status, 200);
  const x = await s.text();
  for (const p of ['/como-funciona', '/perguntas-frequentes', '/termos-de-uso']) assert.ok(x.includes('https://recargaflame.com.br' + p));
  assert.ok(!x.includes('/painel'));
});

test('endereço malformado (robô): 400 com mensagem curta, não 500', async () => {
  const r = await fetch(base + '/parceiro/%c0');
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'Requisição inválida.' });
});
