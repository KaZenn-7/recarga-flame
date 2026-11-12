// E-mail ao cliente (Resend, API HTTP — sem dependência nova): envio e o e-mail de pedido entregue.

// "1.000 Coins ×3, Gold Pass": itens do carrinho agrupados pelo nome, na ordem em que aparecem
export function resumoItens(itens, nomeDe) {
  const g = new Map();
  for (const o of itens) { const n = nomeDe(o); g.set(n, (g.get(n) || 0) + 1); }
  return [...g].map(([n, q]) => (q > 1 ? `${n} ×${q}` : n)).join(', ');
}

export function initEmail({ env, PRODUCTS, esc }) {
// Desligado enquanto RESEND_API_KEY não estiver no .env. Falha de envio nunca quebra o fluxo.
// Remetente: MAIL_FROM (padrão pedidos@recargaflame.com.br); respostas vão para MAIL_REPLY_TO (suporte@…).
const MAIL_FROM = env.MAIL_FROM || 'pedidos@recargaflame.com.br';
const MAIL_REPLY_TO = env.MAIL_REPLY_TO || 'suporte@recargaflame.com.br';
async function sendMail(to, subject, html, text, replyTo = MAIL_REPLY_TO, fromAddr = MAIL_FROM) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Recarga Flame <${fromAddr}>`, reply_to: replyTo,
        to: [to], subject, html, text,
      }),
    });
    if (!r.ok) console.error('Resend respondeu', r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.error('Falha ao enviar e-mail:', e.message); return false; }
}

function deliveredEmail(o) {
  const nome = o.prod_nome || PRODUCTS[o.product]?.nome || o.product;
  const valor = (o.cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const site = env.PUBLIC_URL;
  const link = `${site}/#pedido=${o.token}`;
  const subject = `Pedido #${o.id} entregue — ${nome}`;
  const text = [
    `Olá, ${o.nickname}!`, '',
    `Seu pedido #${o.id} (${nome}, ${valor}) foi entregue na conta ID ${o.game_id}.`,
    'Abra o CounterFlame para conferir.', '',
    `Acompanhar o pedido: ${link}`,
    'Algum problema? É só responder este e-mail (suporte@recargaflame.com.br).', '',
    'Recarga Flame — revenda independente, sem vínculo com a Valve nem com a equipe oficial do CounterFlame.',
  ].join('\n');
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0e0e10;padding:24px 12px;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#161618;border:1px solid #2a2a2e;border-radius:14px">
<tr><td style="padding:22px 22px 6px"><img src="${site}/img/brand-mark.png" width="36" height="36" alt="" style="border-radius:8px;vertical-align:middle">
<span style="font-size:17px;font-weight:700;vertical-align:middle;margin-left:8px">Recarga <span style="color:#ff5a1f">Flame</span></span></td></tr>
<tr><td style="padding:14px 22px 4px"><h1 style="margin:0 0 8px;font-size:20px">Pedido entregue ✅</h1>
<p style="margin:0;color:#9b9ba3;font-size:14px;line-height:1.55">Olá, <b style="color:#f4f4f5">${esc(o.nickname)}</b>! Seu pedido já está na sua conta. Abra o CounterFlame para conferir.</p></td></tr>
<tr><td style="padding:16px 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0e0e10;border:1px solid #2a2a2e;border-radius:10px;font-size:14px">
<tr><td style="padding:12px 14px;color:#9b9ba3">Pedido</td><td align="right" style="padding:12px 14px;font-weight:700">#${o.id}</td></tr>
<tr><td style="padding:12px 14px;color:#9b9ba3;border-top:1px solid #2a2a2e">Produto</td><td align="right" style="padding:12px 14px;font-weight:700;border-top:1px solid #2a2a2e">${esc(nome)}</td></tr>
<tr><td style="padding:12px 14px;color:#9b9ba3;border-top:1px solid #2a2a2e">Conta</td><td align="right" style="padding:12px 14px;border-top:1px solid #2a2a2e">${esc(o.nickname)} · ID ${esc(o.game_id)}</td></tr>
<tr><td style="padding:12px 14px;color:#9b9ba3;border-top:1px solid #2a2a2e">Valor</td><td align="right" style="padding:12px 14px;font-weight:700;border-top:1px solid #2a2a2e">${valor}</td></tr>
</table></td></tr>
<tr><td style="padding:0 22px 20px"><a href="${link}" style="display:block;text-align:center;background:#ff5a1f;color:#160a04;font-weight:700;text-decoration:none;padding:13px;border-radius:9px">Ver pedido</a></td></tr>
<tr><td style="padding:0 22px 22px;color:#6c6c74;font-size:12.5px;line-height:1.5">Algum problema? É só responder este e-mail ou escrever para
<a href="mailto:suporte@recargaflame.com.br" style="color:#9b9ba3">suporte@recargaflame.com.br</a>.<br><br>
Recarga Flame é uma revenda independente, sem vínculo com a Valve nem com a equipe oficial do CounterFlame.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text };
}
// Carrinho: UM e-mail quando todos os itens terminaram (entregues ou não), com a situação de cada um.
function carrinhoEntregueEmail(car, itens) {
  const nomeDe = (o) => o.prod_nome || PRODUCTS[o.product]?.nome || o.product;
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const site = env.PUBLIC_URL;
  const link = `${site}/#carrinho=${car.token}`;
  const o0 = itens[0];
  const entregues = itens.filter((o) => o.status === 'delivered');
  const todos = entregues.length === itens.length;
  const nums = itens.map((o) => '#' + o.id).join(', ');
  const st = (o) => (o.status === 'delivered' ? 'Entregue'
    : `Não entregue — ${brl(o.cents)} ${o.refund_state === 'done' ? 'devolvidos' : 'serão devolvidos'} via Pix`);
  const subject = todos ? `Pedidos ${nums} entregues — ${resumoItens(itens, nomeDe)}`
    : `Pedidos ${nums}: ${entregues.length} de ${itens.length} itens entregues`;
  const intro = todos ? 'Seus itens já estão na sua conta. Abra o CounterFlame para conferir.'
    : 'Parte dos itens já está na sua conta. Os que não puderam ser entregues aparecem abaixo, e o valor deles é devolvido via Pix para a conta que pagou — você não precisa fazer nada.';
  const text = [
    `Olá, ${o0.nickname}!`, '', intro, '',
    ...itens.map((o) => `• #${o.id} ${nomeDe(o)} (${brl(o.cents)}): ${st(o)}`), '',
    `Conta: ${o0.nickname} · ID ${o0.game_id} · total pago ${brl(car.cents)}`,
    `Acompanhar: ${link}`,
    'Algum problema? É só responder este e-mail (suporte@recargaflame.com.br).', '',
    'Recarga Flame — revenda independente, sem vínculo com a Valve nem com a equipe oficial do CounterFlame.',
  ].join('\n');
  const linha = (o, i) => `<tr><td style="padding:12px 14px;${i ? 'border-top:1px solid #2a2a2e;' : ''}"><b>${esc(nomeDe(o))}</b><br>
<span style="font-size:12.5px;color:${o.status === 'delivered' ? '#3fb950' : '#f85149'}">${o.status === 'delivered' ? '✅ ' : ''}${esc(st(o))} · #${o.id}</span></td>
<td align="right" style="padding:12px 14px;font-weight:700;white-space:nowrap;${i ? 'border-top:1px solid #2a2a2e;' : ''}">${brl(o.cents)}</td></tr>`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0e0e10;padding:24px 12px;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#161618;border:1px solid #2a2a2e;border-radius:14px">
<tr><td style="padding:22px 22px 6px"><img src="${site}/img/brand-mark.png" width="36" height="36" alt="" style="border-radius:8px;vertical-align:middle">
<span style="font-size:17px;font-weight:700;vertical-align:middle;margin-left:8px">Recarga <span style="color:#ff5a1f">Flame</span></span></td></tr>
<tr><td style="padding:14px 22px 4px"><h1 style="margin:0 0 8px;font-size:20px">${todos ? 'Pedido entregue ✅' : 'Entrega parcial'}</h1>
<p style="margin:0;color:#9b9ba3;font-size:14px;line-height:1.55">Olá, <b style="color:#f4f4f5">${esc(o0.nickname)}</b>! ${intro}</p></td></tr>
<tr><td style="padding:16px 22px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0e0e10;border:1px solid #2a2a2e;border-radius:10px;font-size:14px">
${itens.map(linha).join('\n')}
<tr><td style="padding:12px 14px;color:#9b9ba3;border-top:1px solid #2a2a2e">Total pago · conta ${esc(o0.nickname)} · ID ${esc(o0.game_id)}</td><td align="right" style="padding:12px 14px;font-weight:700;border-top:1px solid #2a2a2e">${brl(car.cents)}</td></tr>
</table></td></tr>
<tr><td style="padding:14px 22px 20px"><a href="${link}" style="display:block;text-align:center;background:#ff5a1f;color:#160a04;font-weight:700;text-decoration:none;padding:13px;border-radius:9px">Ver pedido</a></td></tr>
<tr><td style="padding:0 22px 22px;color:#6c6c74;font-size:12.5px;line-height:1.5">Algum problema? É só responder este e-mail ou escrever para
<a href="mailto:suporte@recargaflame.com.br" style="color:#9b9ba3">suporte@recargaflame.com.br</a>.<br><br>
Recarga Flame é uma revenda independente, sem vínculo com a Valve nem com a equipe oficial do CounterFlame.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text };
}
  return { sendMail, deliveredEmail, carrinhoEntregueEmail, MAIL_FROM, MAIL_REPLY_TO };
}
