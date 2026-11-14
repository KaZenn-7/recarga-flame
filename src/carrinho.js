// Carrinho: vários itens num Pix só. Cada item vira um pedido (orders) com carrinho_id — entrega automática,
// conferência no bot, reembolso, comissão e avisos continuam por item, como no pedido avulso. O carrinho guarda
// o Pix único (token = external_reference no Mercado Pago) e o total.
// Rotas: POST /api/carrinho (cria), GET /api/carrinho/:token (status de cada item), POST /api/carrinho/:token/cancel.
import crypto from 'node:crypto';

export function initCarrinho({ db, app, PRODUCTS, limit, getCoupon, priceWith, validId, getPlayer, blockReasonCarrinho, CARRINHO_MAX,
  devOf, isBlocked, lc, RISK, paid24, fp, starNow, orderEv, syncPayment, entregaState, criarPix, emailRecusado, pixAbertos, cancelarPendente }) {
const findCar = db.prepare('SELECT * FROM carrinhos WHERE token = ?');
const itensDe = (cid) => db.prepare('SELECT * FROM orders WHERE carrinho_id=? ORDER BY id').all(cid);
// status que o cliente vê (igual ao pedido avulso): pago e não entregue → refund/refunded
const stCliente = (o) => (o.status === 'cancelled' && o.paid_at ? (o.refund_state === 'done' ? 'refunded' : 'refund') : o.status);
// situação do carrinho como um todo
function stCarrinho(sts) {
  if (sts.every((s) => s === 'pending')) return 'pending';
  if (sts.every((s) => s === 'cancelled')) return 'cancelled';
  if (sts.every((s) => s === 'delivered')) return 'delivered';
  if (sts.includes('paid')) return 'paid';          // ainda entregando algum item
  return sts.includes('delivered') ? 'parcial' : sts[0]; // terminou, mas nem tudo foi entregue
}

app.post('/api/carrinho', limit(5), async (req, res) => {
  const { itens: keys, gameId, email, coupon: couponIn } = req.body ?? {};
  if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ error: 'Carrinho vazio.' });
  if (keys.length > CARRINHO_MAX) return res.status(400).json({ error: `O carrinho aceita até ${CARRINHO_MAX} itens.` });
  const prods = [];
  for (const k of keys) {
    const p = typeof k === 'string' && Object.hasOwn(PRODUCTS, k) ? PRODUCTS[k] : null;
    if (!p?.ativo) return res.status(400).json({ error: 'Produto inválido.' });
    prods.push({ key: k, ...p });
  }
  let coupon = null;
  if (couponIn) {
    coupon = getCoupon(couponIn);
    if (!coupon) return res.status(400).json({ error: 'Cupom inválido ou expirado.', field: 'coupon' });
  }
  if (!validId(String(gameId))) return res.status(400).json({ error: 'ID inválido.' });
  if (typeof email !== 'string' || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }
  const player = await getPlayer(gameId);
  if (!player) return res.status(404).json({ error: 'Conta não encontrada.' });
  const reason = blockReasonCarrinho(prods, player, gameId);
  if (reason) return res.status(409).json({ error: reason });
  const device = devOf(req);
  if (isBlocked(gameId, email, device)) return res.status(403).json({ error: 'Não foi possível concluir esta compra. Fale com o suporte.' });
  if (pixAbertos(gameId, email) >= RISK.pend) return res.status(429).json({ error: 'Você já tem Pix em aberto. Pague ou cancele antes de gerar outro.' });
  const precos = prods.map((p) => priceWith(p, coupon)); // preço SEMPRE calculado no servidor, item a item
  const total = precos.reduce((a, c) => a + c, 0);
  if (paid24(gameId, email) + total > RISK.cap) {
    return res.status(409).json({ error: 'Limite diário de compras atingido para esta conta. Fale com o suporte para compras maiores.' });
  }

  const token = crypto.randomUUID();
  const ipH = fp('ip:' + req.ip), star = starNow();
  const ins = db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, prod_nome, prod_stars, prod_code,
      coupon, list_cents, discount_cents, com_pct, device, ip_h, star_cost, carrinho_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const { cid, itens } = db.transaction(() => {
    const cid = Number(db.prepare('INSERT INTO carrinhos (token, cents, game_id, email, coupon) VALUES (?, ?, ?, ?, ?)')
      .run(token, total, String(gameId), email, coupon?.code || null).lastInsertRowid);
    const itens = prods.map((p, i) => {
      const tk = crypto.randomUUID();
      const id = Number(ins.run(tk, p.key, precos[i], String(gameId), player.nickname, email, p.nome, p.stars, p.code,
        coupon?.code || null, p.cents, p.cents - precos[i], coupon ? coupon.comissao_pct : null, device, ipH, star, cid).lastInsertRowid);
      return { id, token: tk, product: p.key, nome: p.nome, cents: precos[i] };
    });
    return { cid, itens };
  })();

  const { r, pay, tx, expiresAt } = await criarPix({ cents: total, ref: token, email,
    // aparece no app do banco/MP: os nº dos pedidos e o ID ajudam a achar a compra no suporte
    description: `Pedidos ${itens.map((it) => '#' + it.id).join(', ')} - ${itens.length} itens CounterFlame - ID ${gameId} - Recarga Flame` });
  if (!r.ok || !tx?.qr_code) {
    console.error('Erro no Mercado Pago (carrinho):', pay);
    db.prepare("UPDATE orders SET status='cancelled' WHERE carrinho_id=?").run(cid);
    if (emailRecusado(r, pay)) {
      return res.status(400).json({ error: 'O Mercado Pago não aceitou esse e-mail. Confira se está digitado certo (ex.: @gmail.com).', field: 'email' });
    }
    return res.status(502).json({ error: 'Não foi possível gerar o Pix. Tente de novo em instantes.' });
  }
  db.transaction(() => {
    db.prepare('UPDATE carrinhos SET mp_id=?, qr=?, qr_b64=?, expires_at=? WHERE id=?').run(String(pay.id), tx.qr_code, tx.qr_code_base64, expiresAt, cid);
    db.prepare('UPDATE orders SET mp_id=?, expires_at=? WHERE carrinho_id=?').run(String(pay.id), expiresAt, cid);
  })();
  for (const it of itens) orderEv({ id: it.id, device, coupon: coupon?.code || null }, 'pix');
  res.json({ token, id: cid, expiresAt, cents: total, coupon: coupon?.code || null, qr: tx.qr_code, qrBase64: tx.qr_code_base64, itens });
});

// Status do carrinho e de cada item (quem tem o token = dono). Nunca devolve e-mail; QR só enquanto pode ser pago.
app.get('/api/carrinho/:token', async (req, res) => {
  const car = findCar.get(req.params.token);
  if (!car) return res.status(404).json({ error: 'Carrinho não encontrado.' });
  let itens = itensDe(car.id);
  if (car.mp_id && itens.some((o) => o.status === 'pending')) {
    await syncPayment(car.mp_id);
    itens = itensDe(car.id);
  }
  const sts = itens.map(stCliente);
  const status = stCarrinho(sts);
  res.json({
    status, id: car.id, cents: car.cents, gameId: car.game_id, nick: itens[0]?.nickname || '', coupon: car.coupon,
    avatar: `/api/player/${encodeURIComponent(car.game_id)}/avatar`,
    expiresAt: car.expires_at || null,
    qr: status === 'pending' ? car.qr || null : null, qrBase64: status === 'pending' ? car.qr_b64 || null : null,
    itens: itens.map((o, i) => ({ id: o.id, token: o.token, product: o.product, nome: o.prod_nome || PRODUCTS[o.product]?.nome || o.product,
      cents: o.cents, img: PRODUCTS[o.product]?.img || `/img/${o.product}.webp`, status: sts[i], entrega: entregaState(o) })),
  });
});

// Cancela o Pix do carrinho (todos os itens), do mesmo jeito que o pedido avulso
app.post('/api/carrinho/:token/cancel', limit(10), async (req, res) => {
  const car = findCar.get(req.params.token);
  if (!car) return res.status(404).json({ error: 'Carrinho não encontrado.' });
  const itens = itensDe(car.id);
  const pend = itens.find((o) => o.status === 'pending');
  if (pend) await cancelarPendente(pend);
  res.json({ status: stCarrinho(itensDe(car.id).map(stCliente)) });
});
}
