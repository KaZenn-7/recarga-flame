// Checkout: criar o pedido e o Pix no Mercado Pago, status do pedido (página do cliente), cancelar o Pix,
// webhook do MP (assinatura conferida) e lembretes/expiração do Pix pendente.
import crypto from 'node:crypto';

export function initCheckout({ env, db, app, PRODUCTS, MP_URL, mpHeaders, limit, findOrder, getCoupon, priceWith, validId, getPlayer, blockReason,
  devOf, isBlocked, lc, RISK, paid24, fp, starNow, orderEv, syncPayment, entregaState, safeEq, brlTxt, esc, sendMail }) {
// Expiração automática: pendente com Pix vencido (+5 min de folga) é conferido no MP
// uma última vez (pega pagamento atrasado) e, se seguir pendente, vira cancelled.
// Pedidos antigos sem expires_at usam created_at + 35 min.
// ---------- Lembretes de Pix (e-mail transacional sobre o próprio pedido) ----------
// 1) faltando ≤ 10 min para vencer: "seu Pix vence em X min" (1x)  2) venceu sem pagar: "gere um novo Pix" (1x).
// Nunca se o cliente já fez um pedido mais novo (mesmo ID ou e-mail) — ele já voltou por conta própria.
const hasNewer = (o) => !!db.prepare('SELECT 1 FROM orders WHERE id > ? AND (game_id=? OR lower(email)=?)').get(o.id, o.game_id, lc(o.email));
function pixMail(o, kind, mins) {
  const nome = o.prod_nome || PRODUCTS[o.product]?.nome || o.product;
  const valor = brlTxt(o.cents);
  const link = `${env.PUBLIC_URL}/#pedido=${o.token}`;
  const vence = kind === 'lembrete';
  const subject = vence ? `Seu Pix vence em ${mins} min — pedido #${o.id}` : `Seu Pix expirou — pedido #${o.id}`;
  const title = vence ? `Seu Pix vence em ${mins} minutos ⏳` : 'Seu Pix expirou';
  const p1 = vence
    ? `Seu pedido de <b style="color:#f4f4f5">${esc(nome)}</b> (${valor}) para <b style="color:#f4f4f5">${esc(o.nickname)}</b> ainda está aguardando o pagamento. Pague antes de vencer para receber em até 10 minutos.`
    : `O Pix do pedido de <b style="color:#f4f4f5">${esc(nome)}</b> (${valor}) para <b style="color:#f4f4f5">${esc(o.nickname)}</b> venceu sem pagamento — nada foi cobrado. Se ainda quiser, gere um novo Pix em um toque.`;
  const btn = vence ? 'Abrir o Pix' : 'Gerar novo Pix';
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0e0e10;padding:24px 12px;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#161618;border:1px solid #2a2a2e;border-radius:14px">
<tr><td style="padding:22px 22px 6px"><img src="${env.PUBLIC_URL}/img/brand-mark.png" width="36" height="36" alt="" style="border-radius:8px;vertical-align:middle">
<span style="font-size:17px;font-weight:700;vertical-align:middle;margin-left:8px">Recarga <span style="color:#ff5a1f">Flame</span></span></td></tr>
<tr><td style="padding:14px 22px 4px"><h1 style="margin:0 0 8px;font-size:20px">${title}</h1>
<p style="margin:0;color:#9b9ba3;font-size:14px;line-height:1.55">${p1}</p></td></tr>
<tr><td style="padding:18px 22px 20px"><a href="${link}" style="display:block;text-align:center;background:#ff5a1f;color:#160a04;font-weight:700;text-decoration:none;padding:13px;border-radius:9px">${btn}</a></td></tr>
<tr><td style="padding:0 22px 22px;color:#6c6c74;font-size:12.5px;line-height:1.5">${vence ? 'Se você já pagou, pode ignorar este e-mail — a confirmação é automática.<br><br>' : ''}Pedido #${o.id} · conta ID ${esc(o.game_id)}. Dúvidas? É só responder este e-mail.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`${title}`, '', vence ? `Seu pedido de ${nome} (${valor}) para ${o.nickname} ainda aguarda o pagamento.` : `O Pix do pedido de ${nome} (${valor}) venceu sem pagamento — nada foi cobrado.`,
    `${btn}: ${link}`, vence ? 'Se já pagou, ignore este e-mail.' : '', `Pedido #${o.id} · ID ${o.game_id}`].join('\n');
  return { subject, html, text };
}
async function remindPending() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM orders WHERE status='pending' AND mp_id IS NOT NULL AND remind_at IS NULL
    AND expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ? LIMIT 30`).all(now + 60_000, now + 10 * 60_000);
  let sent = 0;
  for (const o of rows) {
    db.prepare('UPDATE orders SET remind_at=? WHERE id=?').run(now, o.id); // marca antes: nunca repete
    if (hasNewer(o) || !o.email) continue;
    try { await syncPayment(o.mp_id); } catch { continue; }
    if (db.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status !== 'pending') continue;
    const m = pixMail(o, 'lembrete', Math.max(1, Math.round((o.expires_at - now) / 60_000)));
    if (await sendMail(o.email, m.subject, m.html, m.text)) sent++;
  }
  return sent;
}
if (env.NODE_ENV !== 'test') setInterval(() => remindPending().catch((e) => console.error('remindPending', e)), 60_000).unref();

async function expirePending() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM orders WHERE status='pending' AND (
      (expires_at IS NOT NULL AND expires_at < ?) OR
      (expires_at IS NULL AND created_at < datetime('now','-35 minutes'))) LIMIT 50`).all(now - 5 * 60_000);
  for (const o of rows) {
    try { if (o.mp_id) await syncPayment(o.mp_id); } catch (e) { console.error('expirePending sync', o.id, e.message); continue; }
    const r = db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'").run(o.id);
    // venceu sem pagar (não foi o cliente que cancelou): avisa 1x, se ele não voltou por conta própria
    if (r.changes && o.mp_id && o.email && !o.expired_mail && !hasNewer(o)) {
      db.prepare('UPDATE orders SET expired_mail=1 WHERE id=?').run(o.id);
      const m = pixMail(o, 'expirou');
      sendMail(o.email, m.subject, m.html, m.text);
    }
  }
  return rows.length;
}
if (env.NODE_ENV !== 'test') setInterval(() => expirePending().catch((e) => console.error('expirePending', e)), 5 * 60_000).unref();

function validSignature(req, id) {
  const parts = Object.fromEntries((req.get('x-signature') || '').split(',').map((s) => s.trim().split('=')));
  const manifest = `id:${id};request-id:${req.get('x-request-id')};ts:${parts.ts};`;
  const hash = crypto.createHmac('sha256', env.MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return safeEq(hash, parts.v1 || '');
}

app.post('/api/orders', limit(5), async (req, res) => {
  const { product, gameId, email, coupon: couponIn } = req.body ?? {};
  const p = Object.hasOwn(PRODUCTS, product) ? PRODUCTS[product] : null;
  if (!p?.ativo) return res.status(400).json({ error: 'Produto inválido.' });
  let coupon = null;
  if (couponIn) {
    coupon = getCoupon(couponIn);
    if (!coupon) return res.status(400).json({ error: 'Cupom inválido ou expirado.', field: 'coupon' });
  }
  const finalCents = priceWith(p, coupon); // preço SEMPRE calculado no servidor
  if (!validId(String(gameId))) return res.status(400).json({ error: 'ID inválido.' });
  if (typeof email !== 'string' || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }

  const player = await getPlayer(gameId);
  if (!player) return res.status(404).json({ error: 'Conta não encontrada.' });
  const reason = blockReason(p, player);
  if (reason) return res.status(409).json({ error: reason });
  const device = devOf(req);
  if (isBlocked(gameId, email, device)) return res.status(403).json({ error: 'Não foi possível concluir esta compra. Fale com o suporte.' });
  const pend = db.prepare("SELECT COUNT(*) n FROM orders WHERE (game_id=? OR lower(email)=?) AND status='pending'").get(String(gameId), lc(email)).n;
  if (pend >= RISK.pend) return res.status(429).json({ error: 'Você já tem Pix em aberto. Pague ou cancele antes de gerar outro.' });

  if (paid24(gameId, email) + finalCents > RISK.cap) {
    return res.status(409).json({ error: 'Limite diário de compras atingido para esta conta. Fale com o suporte para compras maiores.' });
  }
  const token = crypto.randomUUID();
  const ins = db.prepare(`INSERT INTO orders (token, product, cents, game_id, nickname, email, prod_nome, prod_stars, prod_code,
      coupon, list_cents, discount_cents, com_pct, device, ip_h, star_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(token, product, finalCents, String(gameId), player.nickname, email, p.nome, p.stars, p.code,
      coupon?.code || null, p.cents, p.cents - finalCents, coupon ? coupon.comissao_pct : null, device, fp('ip:' + req.ip), starNow());

  // Pix expira em 30 min. Formato exigido pelo MP: ISO com offset (ex: -03:00).
  const expiresAt = Date.now() + 30 * 60_000;
  const expira = (() => {
    const d = new Date(expiresAt);
    const off = -d.getTimezoneOffset(); // minutos; servidor em -03:00 => 180... usamos valor real
    const sign = off >= 0 ? '+' : '-';
    const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
    const tz = `${sign}${pad(off / 60)}:${pad(off % 60)}`;
    // monta a data no horário local do servidor
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
    return `${local}${tz}`;
  })();
  const r = await fetch(MP_URL, {
    method: 'POST',
    headers: { ...mpHeaders, 'Content-Type': 'application/json', 'X-Idempotency-Key': token },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      transaction_amount: finalCents / 100,
      // aparece para o cliente no app do banco/MP: nº do pedido e ID da conta ajudam a achar a compra no suporte
      description: `Pedido #${Number(ins.lastInsertRowid)} - ${p.nome} CounterFlame - ID ${gameId} - Recarga Flame`,
      payment_method_id: 'pix',
      external_reference: token,
      date_of_expiration: expira,
      payer: { email },
    }),
  });
  const pay = await r.json();
  const tx = pay.point_of_interaction?.transaction_data;
  if (!r.ok || !tx?.qr_code) {
    console.error('Erro no Mercado Pago:', pay);
    db.prepare("UPDATE orders SET status='cancelled' WHERE token=?").run(token);
    // e-mail recusado pelo MP (ex.: domínio inexistente como "gmail.con"): diz ao cliente o que corrigir
    if (r.status === 400 && /payer\.email/i.test(JSON.stringify(pay))) {
      return res.status(400).json({ error: 'O Mercado Pago não aceitou esse e-mail. Confira se está digitado certo (ex.: @gmail.com).', field: 'email' });
    }
    return res.status(502).json({ error: 'Não foi possível gerar o Pix. Tente de novo em instantes.' });
  }

  db.prepare('UPDATE orders SET mp_id=?, qr=?, qr_b64=?, expires_at=? WHERE token=?')
    .run(String(pay.id), tx.qr_code, tx.qr_code_base64, expiresAt, token);
  orderEv({ id: Number(ins.lastInsertRowid), device, coupon: coupon?.code || null }, 'pix');
  res.json({ token, id: Number(ins.lastInsertRowid), expiresAt, cents: finalCents, coupon: coupon?.code || null, qr: tx.qr_code, qrBase64: tx.qr_code_base64 });
});

app.get('/api/orders/:token', async (req, res) => {
  let o = findOrder.get(req.params.token);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status === 'pending' && o.mp_id) {
    await syncPayment(o.mp_id);
    o = findOrder.get(req.params.token);
  }
  const entrega = entregaState(o);
  const st = o.status === 'cancelled' && o.paid_at ? (o.refund_state === 'done' ? 'refunded' : 'refund') : o.status; // pago e não entregue
  if (req.query.full !== '1') return res.json({ status: st, entrega });
  // Dados para reabrir o pedido pelo link (quem tem o token = dono do pedido).
  // Nunca devolve e-mail. QR só enquanto o Pix pode ser pago.
  const pending = o.status === 'pending';
  res.json({
    status: st, entrega, id: o.id, product: o.product, nome: o.prod_nome || PRODUCTS[o.product]?.nome || o.product,
    cents: o.cents, gameId: o.game_id, nick: o.nickname,
    avatar: `/api/player/${encodeURIComponent(o.game_id)}/avatar`,
    img: PRODUCTS[o.product]?.img || `/img/${o.product}.jpg`,
    expiresAt: o.expires_at || null,
    qr: pending ? o.qr || null : null, qrBase64: pending ? o.qr_b64 || null : null,
  });
});

// Cliente cancela o próprio Pix pendente (só quem tem o token do pedido).
// Cancela DE VERDADE no Mercado Pago, para o QR antigo não poder mais ser pago
// (evita pagamento em dobro ao trocar de produto). Se o MP recusar — ex.: já foi
// pago — sincroniza com o MP e devolve o status real; pedido pago nunca é cancelado aqui.
app.post('/api/orders/:token/cancel', limit(10), async (req, res) => {
  const o = findOrder.get(req.params.token);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status !== 'pending') return res.json({ status: o.status });
  let cancelled = !o.mp_id; // sem Pix no MP: nada a cancelar lá
  if (o.mp_id) {
    const r = await fetch(`${MP_URL}/${encodeURIComponent(o.mp_id)}`, {
      method: 'PUT',
      headers: { ...mpHeaders, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ status: 'cancelled' }),
    });
    const j = await r.json().catch(() => ({}));
    cancelled = r.ok && j.status === 'cancelled';
    if (!cancelled) await syncPayment(o.mp_id);
  }
  if (cancelled) db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'").run(o.id);
  res.json({ status: findOrder.get(o.token).status });
});

app.post('/webhook/mercadopago', async (req, res) => {
  const type = req.query.type ?? req.body?.type;
  const id = String(req.query['data.id'] ?? req.body?.data?.id ?? '');
  if (type !== 'payment') return res.sendStatus(200);
  if (!/^\d+$/.test(id) || !validSignature(req, id)) return res.sendStatus(401);
  await syncPayment(id);
  res.sendStatus(200);
});

return { remindPending, expirePending };
}
