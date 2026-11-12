// Painel: login com código pelo Telegram, sessão, produtos (CRUD e validações) e rate limit do admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupStore, mock, tgSent, lastCode, base, adminFails, db, COOKIE, login, freshIP, postJ, adm, pagar } from './helpers.js';

setupStore();

test('admin exige autenticação', async () => {
  const r = await fetch(base + '/api/admin/products');
  assert.equal(r.status, 401);
});

test('cria produto com credencial válida', async () => {
  const r = await fetch(base + '/api/admin/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1' },
    body: JSON.stringify({ key: 'novo1', nome: 'Novo', cents: 500, stars: 5, code: 'n_1', ativo: true }),
  });
  assert.equal(r.status, 200);
});

test('rejeita chave inválida', async () => {
  const r = await fetch(base + '/api/admin/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1' },
    body: JSON.stringify({ key: 'IN VÁLIDO!', nome: 'x', cents: 100, code: 'y' }),
  });
  assert.equal(r.status, 400);
});

test('rejeita img maliciosa (javascript:)', async () => {
  const r = await fetch(base + '/api/admin/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1' },
    body: JSON.stringify({ key: 'evil1', nome: 'x', cents: 100, code: 'y', img: 'javascript:alert(1)' }),
  });
  assert.equal(r.status, 400);
});

test('rejeita preço inválido', async () => {
  const r = await fetch(base + '/api/admin/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1' },
    body: JSON.stringify({ key: 'cheap1', nome: 'x', cents: 0, code: 'y' }),
  });
  assert.equal(r.status, 400);
});

test('brute-force bloqueia após 20 falhas, mas senha correta sempre passa', async () => {
  const post = (b) => fetch(base + '/login/senha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let got429 = false;
  for (let i = 0; i < 25; i++) {
    const r = await post({ user: 'admin_test', pass: 'ERRADA' });
    if (r.status === 429) got429 = true;
  }
  assert.ok(got429, 'esperava 429 após várias falhas');
  const ok = await post({ user: 'admin_test', pass: 'senha_test_longa' }); // mesmo IP
  assert.equal(ok.status, 200, 'senha correta não pode ser bloqueada junto');
  adminFails.clear();
});

test('painel sem sessão redireciona para /login; API dá 401', async () => {
  const r = await fetch(base + '/painel', { redirect: 'manual' });
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/login');
  assert.equal((await fetch(base + '/painel/app.js')).status, 401); // JS do painel só com sessão
  assert.equal((await fetch(base + '/api/admin/products', { headers: { Cookie: 'cf_sess=' + 'x'.repeat(43) } })).status, 401);
});

test('senha correta só não basta: sem o código não há sessão', async () => {
  const r = await postJ('/login/senha', { user: 'admin_test', pass: 'senha_test_longa' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.match(tgSent.at(-1).text, /Código de acesso/);
  assert.equal(tgSent.at(-1).chat_id, '42');
});

test('código é de uso único e trava após 5 erros', async () => {
  const { challenge } = await (await postJ('/login/senha', { user: 'admin_test', pass: 'senha_test_longa' })).json();
  const code = lastCode();
  const ok = await postJ('/login/codigo', { challenge, code });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await postJ('/login/codigo', { challenge, code })).status, 401, 'reuso tem que falhar');
  const c2 = (await (await postJ('/login/senha', { user: 'admin_test', pass: 'senha_test_longa' })).json()).challenge;
  const certo = lastCode();
  const errado = certo === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await postJ('/login/codigo', { challenge: c2, code: errado });
  assert.equal((await postJ('/login/codigo', { challenge: c2, code: certo })).status, 401, 'desafio tem que morrer após 5 erros');
  adminFails.clear();
});

test('sair invalida a sessão', async () => {
  const ck = await login();
  assert.equal((await fetch(base + '/api/admin/products', { headers: { Cookie: ck } })).status, 200);
  await fetch(base + '/logout', { method: 'POST', headers: { Cookie: ck } });
  assert.equal((await fetch(base + '/api/admin/products', { headers: { Cookie: ck } })).status, 401);
});

test('sessão do painel: 30 dias, renova com o uso e tem teto de 90 dias desde o login', async () => {
  const ck = await login();
  const DIA = 86400_000, sid = (await import('node:crypto')).createHash('sha256').update(ck.split('=')[1]).digest('hex');
  const row = () => db.prepare('SELECT created_at, expires_at FROM admin_sessions WHERE id_hash=?').get(sid);
  assert.ok(Math.abs(row().expires_at - Date.now() - 30 * DIA) < 60_000, 'nasce com 30 dias');
  // uso logo após o login: não reescreve a sessão
  const r0 = await fetch(base + '/api/admin/products', { headers: { Cookie: ck, ...freshIP() } });
  assert.equal(r0.status, 200); assert.equal(r0.headers.get('set-cookie'), null);
  // 10 dias depois sem uso: o próximo acesso estica de volta para 30 dias
  db.prepare('UPDATE admin_sessions SET created_at=?, expires_at=? WHERE id_hash=?').run(Date.now() - 10 * DIA, Date.now() + 20 * DIA, sid);
  const r1 = await fetch(base + '/api/admin/products', { headers: { Cookie: ck, ...freshIP() } });
  assert.match(r1.headers.get('set-cookie'), /Max-Age=259\d{4}; Path=\/; HttpOnly; SameSite=Strict/);
  assert.ok(Math.abs(row().expires_at - Date.now() - 30 * DIA) < 60_000);
  // perto do teto: não passa de 90 dias desde o login
  db.prepare('UPDATE admin_sessions SET created_at=?, expires_at=? WHERE id_hash=?').run(Date.now() - 85 * DIA, Date.now() + 2 * DIA, sid);
  await fetch(base + '/api/admin/products', { headers: { Cookie: ck, ...freshIP() } });
  assert.ok(Math.abs(row().expires_at - (row().created_at + 90 * DIA)) < 1000);
  // vencida: 401
  db.prepare('UPDATE admin_sessions SET expires_at=? WHERE id_hash=?').run(Date.now() - 1, sid);
  assert.equal((await fetch(base + '/api/admin/products', { headers: { Cookie: ck, ...freshIP() } })).status, 401);
});

test('painel: lista de pedidos para atualização automática exige sessão', async () => {
  assert.equal((await fetch(base + '/api/admin/orders')).status, 401);
  mock.approve = true;
  await pagar((await (await postJ('/api/orders', { product: 'c1000', gameId: '303032', email: 'pl@x.com' })).json()).token);
  const list = await (await adm('GET', '/api/admin/orders')).json();
  assert.ok(Array.isArray(list) && list.length > 0);
  assert.ok(list.some((o) => o.status === 'paid'));
  assert.ok('nick' in list[0] && 'tg' in list[0]);
});

test('vitrine: Coins, Coleções, Battle Pass (Gold Pass primeiro, depois níveis), Arsenal Pass; dentro de cada uma, preço crescente', async () => {
  const H = { Cookie: COOKIE, 'x-painel': '1', 'Content-Type': 'application/json' };
  // produto novo barato no fim da tabela: tem de aparecer no começo da categoria dele
  const r = await fetch(base + '/api/admin/products', { method: 'POST', headers: H,
    body: JSON.stringify({ key: 'ap_teste', nome: 'Ticket 0 - Arsenal Pass', code: 'AP0', cents: 100, stars: 1, tipo: 'arsenal', niveis: 1, ativo: true }) });
  assert.equal(r.status, 200, await r.clone().text());
  const loja = await (await fetch(base + '/api/products')).json();
  const ORD = ['Coins', 'Coleções', 'Battle Pass', 'Arsenal Pass'];
  for (let i = 1; i < loja.length; i++) {
    const a = loja[i - 1], b = loja[i];
    assert.ok(ORD.indexOf(a.cat) < ORD.indexOf(b.cat) || (a.cat === b.cat && (a.key === 'gold' || a.cents <= b.cents)), `${a.key} antes de ${b.key}`);
  }
  assert.equal(loja.find((p) => p.key === 'gold').cat, 'Battle Pass');
  assert.equal(loja.filter((p) => p.cat === 'Battle Pass')[0].key, 'gold'); // Gold Pass primeiro, mesmo sendo mais caro que níveis
  assert.equal(loja.find((p) => p.key === 'bp1')?.cat ?? 'Battle Pass', 'Battle Pass');
  assert.equal(loja.filter((p) => p.cat === 'Arsenal Pass')[0].key, 'ap_teste');
  const adminList = (await (await fetch(base + '/api/admin/products', { headers: H })).json()).filter((p) => p.ativo).map((p) => p.key);
  assert.deepEqual(adminList, loja.map((p) => p.key)); // painel na mesma ordem da loja
  await fetch(base + '/api/admin/products/ap_teste', { method: 'DELETE', headers: H });
});
