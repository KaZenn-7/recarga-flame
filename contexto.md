# Projeto: revenda de itens do CounterFlame

**Última atualização:** 5 de novembro de 2026
**Status:** site escrito, mas ainda não testado nem publicado.

## Como usar este documento

Este arquivo resume uma conversa anterior. Para continuar, considere estas informações como ponto de partida, mas confirme preços, taxas, regras de plataformas e APIs, porque podem ter mudado. Responda em português do Brasil.

## 1. Resumo

O dono do projeto revende itens do CounterFlame, um jogo tático 5v5 para Android e iOS inspirado no CS2. O jogo não é oficial da Valve.

A loja oficial entrega os itens usando o ID da conta, mas aceita apenas cartões russos ou Telegram Stars. Muitos brasileiros não têm cartão russo, não usam Telegram ou não sabem comprar por ele. A revenda resolve isso com pagamento em reais via Pix.

## 2. Situação atual

- **Vendas:** 2 a 5 por dia.
- **Origem dos clientes:** WhatsApp.
- **Divulgação:** ele é admin autorizado a vender na comunidade do youtuber "aquilagado", divulga a tabela lá e atende no privado.
- **Parceria possível:** divulgar uma plataforma própria com o youtuber.
- **Recebimento atual:** Pix sem taxa.
- **Recebimento planejado:** Pix pelo Mercado Pago.
- **Saldo médio:** 1.500 a 2.000 Stars.
- **Custo atual por Star:** R$ 0,0875.

## 3. Operação manual atual

### Recarga de Stars

1. Compra USDT na carteira Walt, antiga wallet do Telegram.
2. Usa a carteira conectada ao Fragment.
3. Escolhe a quantidade de Stars e paga em USDT.

### Venda

1. Recebe o pedido no WhatsApp.
2. Pede o ID do jogo e envia a chave Pix.
3. Confirma o pagamento.
4. Abre `https://counterflame.com/en/donate`.
5. Informa o ID, escolhe o produto e seleciona Telegram Stars.
6. O site abre o bot `@CounterFlameDonate_bot`.
7. Paga com Stars, e o cliente recebe o item.

## 4. Produtos, custos e preços

- O custo considera R$ 0,0875 por Star.
- A margem líquida considera 0,99% de taxa de Pix.
- `*` indica preço sugerido, porque o item estava sem preço na planilha.
- A taxa ainda precisa ser confirmada no painel do Mercado Pago.

| Produto | Stars | Custo | Venda | Margem bruta | Margem líquida | Código do link | Link |
|---|---:|---:|---:|---:|---:|---|---|
| 1.000 Coins | 26 | R$ 2,28 | R$ 3,50 | 35,0% | 34,0% | `c_1000` | Confirmado |
| 3.000 Coins | 53 | R$ 4,64 | R$ 7,00 | 33,8% | 32,8% | `c_3000` | Confirmado |
| 5.000 Coins | 86 | R$ 7,53 | R$ 10,00 | 24,8% | 23,8% | `c_5000` | Presumido |
| 10.000 Coins | 171 | R$ 14,96 | R$ 19,00 | 21,3% | 20,3% | `c_10000` | Presumido |
| 30.000 Coins | 471 | R$ 41,21 | R$ 55,00 | 25,1% | 24,1% | `c_30000` | Presumido |
| 50.000 Coins | 771 | R$ 67,46 | R$ 90,00 | 25,0% | 24,1% | `c_50000` | Presumido |
| 100.000 Coins | 1.499 | R$ 131,16 | R$ 172,50 | 24,0% | 23,0% | `c_100000` | Presumido |
| 200.000 Coins | 2.908 | R$ 254,45 | R$ 335,00 | 24,0% | 23,1% | `c_200000` | Presumido |
| Coleção Wildfire | 544 | R$ 47,60 | R$ 60,00 | 20,7% | 19,7% | `wf_0` | Confirmado |
| Arsenal Pass | 136 | R$ 11,90 | R$ 18,99 | 37,3% | 36,3% | `ap_1` | Confirmado |
| Gold Pass | 271 | R$ 23,71 | R$ 34,99 | 32,2% | 31,2% | `gp_1` | Confirmado |
| 1 Pass Level | 35 | R$ 3,06 | R$ 4,49* | 31,8% | 30,8% | `bp_1` | Confirmado |
| 5 Pass Levels | 135 | R$ 11,81 | R$ 15,99* | 26,1% | 25,1% | `bp_5` | Confirmado |
| 10 Pass Levels | 226 | R$ 19,78 | R$ 26,99* | 26,7% | 25,7% | `bp_10` | Presumido |
| 25 Pass Levels | 499 | R$ 43,66 | R$ 58,99* | 26,0% | 25,0% | `bp_25` | Presumido |

**Wildfire 1:** o link usa `w_1`, mas o produto ainda não tem custo em Stars nem preço.

### Fórmulas

- **Custo:** Stars × custo por Star.
- **Preço sugerido:** custo ÷ (1 − margem-alvo − taxa).
- **Lucro por unidade:** preço × (1 − taxa) − custo.

### Sugestões anteriores de preço

Estas sugestões buscavam 25% de margem antes da taxa de Pix e ainda não foram adotadas:

- Wildfire: R$ 63,49
- 10.000 Coins: R$ 19,99
- 100.000 Coins: R$ 174,90
- 200.000 Coins: R$ 339,90

## 5. Decisões

1. Fazer um site simples em vez de um bot no WhatsApp.
2. Usar o WhatsApp para divulgação e suporte.
3. Usar modelo semiautomático, com a compra final em Stars confirmada manualmente.
4. Não fazer o 100% automático com o volume atual.
5. Manter a recarga de Stars manual.
6. Usar Mercado Pago em vez de Asaas. A taxa de R$ 1,99 do Asaas tornaria os produtos baratos pouco lucrativos ou deficitários.
7. Se houver parceria com o youtuber, usar cupom ou link exclusivo, com acordo por escrito.
8. Como referência, 20% do lucro de comissão reduziria uma margem de 25% para 20%.

## 6. Descobertas técnicas

### API do usuário

A página de compra chama `GET /api/users/:id`. Esse endereço não é documentado publicamente e pode mudar.

Estrutura observada:

```json
{
  "success": true,
  "data": {
    "nickname": "exemplo",
    "avatar_url": "/api/users/ID/avatar",
    "wildfireLevel": 0,
    "arsenalPass": {
      "tickets": 0,
      "maxTickets": 5
    },
    "battlePass": {
      "gold": false,
      "level": 0,
      "totalLevels": 50
    }
  }
}
```

Regras de uso:

- Fazer apenas consultas necessárias para um pedido.
- Nunca percorrer IDs em sequência.
- Usar e guardar só os dados necessários.
- Manter uma alternativa manual caso a API mude.

No teste, `avatar_url` mostrou `749125`, enquanto o link usava `749127`. Se a consulta foi do `749127`, é preciso verificar se a API retornou a conta certa.

### Links do bot

Formato observado:

```text
https://t.me/CounterFlameDonate_bot?start=s_<codigo>_<ID>
```

Exemplos confirmados:

- 1.000 Coins: `s_c_1000_<ID>`
- 3.000 Coins: `s_c_3000_<ID>`
- Wildfire 1: `s_w_1_<ID>`
- Wildfire completa: `s_wf_0_<ID>`
- Arsenal Pass 1: `s_ap_1_<ID>`
- Gold Pass: `s_gp_1_<ID>`
- 1 nível: `s_bp_1_<ID>`
- 5 níveis: `s_bp_5_<ID>`

Antes de pagar qualquer pedido, conferir produto, ID e valor em Stars.

### Automação total

A API do Telegram permite que contas de usuário paguem com Stars por `payments.sendStarsForm`, e a pessoa poderia iniciar o bot pelo link. Isso não foi escolhido porque exigiria guardar a sessão do Telegram em servidor e uma mudança no bot poderia gerar compras erradas.

## 7. Fluxo planejado do site

1. O cliente escolhe o produto e informa o ID.
2. O servidor valida o ID e consulta a conta.
3. O site mostra o nick para confirmação.
4. O cliente informa o e-mail e recebe o Pix.
5. O Mercado Pago confirma o pagamento.
6. O pedido aparece no painel protegido.
7. O painel cria o link do bot.
8. O operador abre o link, confere os dados e paga com Stars.
9. O operador marca o pedido como entregue.
10. O cliente vê o status atualizado.

### Status dos pedidos

- `pending`: aguardando Pix.
- `paid`: pago e aguardando entrega.
- `delivered`: entregue.
- `cancelled`: cancelado, expirado ou devolvido antes da entrega.
- `reversed`: estornado depois da entrega.

## 8. Riscos

### Telegram

Os termos de Stars proíbem vender ou redistribuir Stars. A revenda dos itens é menos direta, mas continua sendo uma zona cinzenta. O Telegram pode reter ou debitar saldo em caso de violação, e as compras de Stars são finais.

### CounterFlame

Os termos de uso não foram encontrados, e também não foi encontrado um programa de revenda ou API oficial. Um site público aumenta a exposição da operação. Confirmar as regras antes de divulgar.

### Mercado Pago

Confirmar a taxa real e se a conta pode vender Coins e itens de jogos. A lista do Global Selling proíbe negociação de moeda virtual e violação de propriedade intelectual, mas ela pode ser diferente das regras de contas brasileiras. Não ocultar a descrição real da venda.

### Pix e fraude

O MED pode bloquear e devolver valores em casos de fraude. Sem saldo suficiente, bloqueios parciais podem ocorrer por até 90 dias. Como o item digital é entregue rapidamente, esse risco continua mesmo com o gateway.

Uma reportagem de setembro de 2026 disse que bancos podem cobrar pessoas físicas em atividade comercial após 30 recebimentos no mês ou pelo uso de QR Code dinâmico. Confirmar com o banco.

### Operação

- Pedidos grandes podem exceder o saldo: 200.000 Coins exige 2.908 Stars.
- O saldo atual pode acabar rapidamente após uma divulgação.
- O custo da Star muda e deve incluir todas as taxas.
- A conta do Telegram precisa de verificação em duas etapas.
- A frase de recuperação da carteira nunca deve ser compartilhada.

### Impostos

Falar com um contador sobre declaração, formalização e comissões da parceria.

## 9. Próximos passos

1. Confirmar as regras do CounterFlame.
2. Confirmar a taxa e a permissão no Mercado Pago.
3. Confirmar a regra de cobrança de Pix no banco.
4. Verificar a diferença de ID no `avatar_url`.
5. Testar os links presumidos sem pagar e ativar os produtos corretos.
6. Definir se `maxTickets` é mesmo o limite do Arsenal Pass.
7. Definir como a Wildfire funciona quando a conta já tem progresso.
8. Informar custo e preço da Wildfire 1.
9. Revisar preços considerando a taxa de 0,99%.
10. Atualizar a planilha com a taxa.
11. Criar uma planilha ou registro de vendas, se necessário.
12. Publicar com HTTPS e armazenamento persistente.
13. Configurar o webhook do Mercado Pago.
14. Fazer uma compra real de baixo valor.
15. Testar pagamento, painel, entrega e estorno.
16. Só depois falar com o youtuber sobre a parceria.

## 10. Instalação

```bash
npm init -y
npm pkg set type=module
npm i express@5 express-rate-limit better-sqlite3 dotenv
```

Crie o arquivo `.env`:

```env
MP_ACCESS_TOKEN=seu_token
MP_WEBHOOK_SECRET=sua_chave_do_webhook
ADMIN_USER=<usuário do painel>
ADMIN_PASS=<senha forte e única>
PUBLIC_URL=https://seudominio.com.br
```

Webhook do Mercado Pago:

- **Local:** Suas integrações > Webhooks
- **Evento:** Pagamentos
- **URL:** `https://seudominio.com.br/webhook/mercadopago`

Nunca publique o `.env` nem compartilhe tokens.

## 11. Código

### server.js

```js
import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';

const env = process.env;
for (const k of ['MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'ADMIN_USER', 'ADMIN_PASS', 'PUBLIC_URL']) {
  if (!env[k]) throw new Error(`Faltou ${k} no .env`);
}
const CF_BASE = env.CF_BASE || 'https://counterflame.com';
const MP_URL = 'https://api.mercadopago.com/v1/payments';

// ativo: false = link ainda não confirmado; o produto não aparece na loja
const PRODUCTS = {
  c1000: { nome: '1.000 Coins', cents: 350, stars: 26, code: 'c_1000', ativo: true },
  c3000: { nome: '3.000 Coins', cents: 700, stars: 53, code: 'c_3000', ativo: true },
  c5000: { nome: '5.000 Coins', cents: 1000, stars: 86, code: 'c_5000', ativo: false },
  c10000: { nome: '10.000 Coins', cents: 1900, stars: 171, code: 'c_10000', ativo: false },
  c30000: { nome: '30.000 Coins', cents: 5500, stars: 471, code: 'c_30000', ativo: false },
  c50000: { nome: '50.000 Coins', cents: 9000, stars: 771, code: 'c_50000', ativo: false },
  c100000: { nome: '100.000 Coins', cents: 17250, stars: 1499, code: 'c_100000', ativo: false },
  c200000: { nome: '200.000 Coins', cents: 33500, stars: 2908, code: 'c_200000', ativo: false },
  wildfire: { nome: 'Coleção Wildfire', cents: 6000, stars: 544, code: 'wf_0', ativo: true, tipo: 'wildfire' },
  arsenal: { nome: 'Arsenal Pass', cents: 1899, stars: 136, code: 'ap_1', ativo: true, tipo: 'arsenal' },
  gold: { nome: 'Gold Pass', cents: 3499, stars: 271, code: 'gp_1', ativo: true, tipo: 'gold' },
  bp1: { nome: '1 Pass Level', cents: 449, stars: 35, code: 'bp_1', ativo: true, niveis: 1 },
  bp5: { nome: '5 Pass Levels', cents: 1599, stars: 135, code: 'bp_5', ativo: true, niveis: 5 },
  bp10: { nome: '10 Pass Levels', cents: 2699, stars: 226, code: 'bp_10', ativo: false, niveis: 10 },
  bp25: { nome: '25 Pass Levels', cents: 5899, stars: 499, code: 'bp_25', ativo: false, niveis: 25 },
};

const db = new Database(env.DB_PATH || 'loja.db');
db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  product TEXT NOT NULL,
  cents INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  email TEXT NOT NULL,
  mp_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  delivered_at TEXT
)`);
const findOrder = db.prepare('SELECT * FROM orders WHERE token = ?');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const validId = (id) => /^\d{1,12}$/.test(id);
const limit = (max) => rateLimit({ windowMs: 60_000, limit: max, standardHeaders: true, legacyHeaders: false });
const mpHeaders = { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` };

async function getPlayer(id) {
  const r = await fetch(`${CF_BASE}/api/users/${id}`, { signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`CounterFlame respondeu ${r.status}`);
  const j = await r.json();
  return j.success && j.data?.nickname ? j.data : null;
}

function blockReason(p, d) {
  const bp = d.battlePass;
  const ap = d.arsenalPass;
  if (p.niveis && bp && bp.level + p.niveis > bp.totalLevels) return 'Essa conta não tem níveis suficientes disponíveis.';
  if (p.tipo === 'gold' && bp?.gold) return 'Essa conta já tem o Gold Pass.';
  if (p.tipo === 'arsenal' && ap && ap.tickets >= ap.maxTickets) return 'Essa conta atingiu o limite do Arsenal Pass.';
  if (p.tipo === 'wildfire' && d.wildfireLevel > 0) return 'Essa conta já tem progresso na Wildfire. Fale com o suporte.';
  return null;
}

async function syncPayment(mpId) {
  const r = await fetch(`${MP_URL}/${encodeURIComponent(mpId)}`, { headers: mpHeaders, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return;
  const pay = await r.json();
  const o = findOrder.get(pay.external_reference);
  if (!o) return;

  if (pay.status === 'approved' && Math.round(pay.transaction_amount * 100) === o.cents) {
    db.prepare("UPDATE orders SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(o.id);
  } else if (['cancelled', 'rejected', 'refunded', 'charged_back'].includes(pay.status)) {
    db.prepare(`UPDATE orders SET status = CASE status WHEN 'delivered' THEN 'reversed' ELSE 'cancelled' END
      WHERE id=? AND status IN ('pending','paid','delivered')`).run(o.id);
  }
}

function validSignature(req, id) {
  const parts = Object.fromEntries((req.get('x-signature') || '').split(',').map((s) => s.trim().split('=')));
  const manifest = `id:${id};request-id:${req.get('x-request-id')};ts:${parts.ts};`;
  const hash = crypto.createHmac('sha256', env.MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return safeEq(hash, parts.v1 || '');
}

function admin(req, res, next) {
  const raw = Buffer.from((req.get('authorization') || '').split(' ')[1] || '', 'base64').toString();
  const [user, pass] = raw.split(/:(.*)/s);
  const okUser = safeEq(user, env.ADMIN_USER);
  const okPass = safeEq(pass, env.ADMIN_PASS);
  if (okUser && okPass) return next();
  res.set('WWW-Authenticate', 'Basic realm="painel"').sendStatus(401);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));
app.use('/api', limit(120));

app.get('/api/products', (req, res) => {
  res.json(Object.entries(PRODUCTS)
    .filter(([, p]) => p.ativo)
    .map(([key, p]) => ({ key, nome: p.nome, cents: p.cents })));
});

app.get('/api/player/:id', limit(15), async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'ID inválido.' });
  const player = await getPlayer(req.params.id);
  if (!player) return res.status(404).json({ error: 'Conta não encontrada.' });
  res.json({ nickname: player.nickname });
});

app.post('/api/orders', limit(5), async (req, res) => {
  const { product, gameId, email } = req.body ?? {};
  const p = Object.hasOwn(PRODUCTS, product) ? PRODUCTS[product] : null;
  if (!p?.ativo) return res.status(400).json({ error: 'Produto inválido.' });
  if (!validId(String(gameId))) return res.status(400).json({ error: 'ID inválido.' });
  if (typeof email !== 'string' || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }

  const player = await getPlayer(gameId);
  if (!player) return res.status(404).json({ error: 'Conta não encontrada.' });
  const reason = blockReason(p, player);
  if (reason) return res.status(409).json({ error: reason });

  const token = crypto.randomUUID();
  db.prepare('INSERT INTO orders (token, product, cents, game_id, nickname, email) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, product, p.cents, String(gameId), player.nickname, email);

  // Expira em 30 minutos, no fuso de Brasília
  const expira = new Date(Date.now() + 30 * 60_000 - 3 * 3_600_000).toISOString().replace('Z', '-03:00');
  const r = await fetch(MP_URL, {
    method: 'POST',
    headers: { ...mpHeaders, 'Content-Type': 'application/json', 'X-Idempotency-Key': token },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      transaction_amount: p.cents / 100,
      description: `${p.nome} - CounterFlame (revenda independente)`,
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
    return res.status(502).json({ error: 'Não foi possível gerar o Pix.' });
  }

  db.prepare('UPDATE orders SET mp_id=? WHERE token=?').run(String(pay.id), token);
  res.json({ token, qr: tx.qr_code, qrBase64: tx.qr_code_base64 });
});

app.get('/api/orders/:token', async (req, res) => {
  let o = findOrder.get(req.params.token);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status === 'pending' && o.mp_id) {
    await syncPayment(o.mp_id);
    o = findOrder.get(req.params.token);
  }
  res.json({ status: o.status });
});

app.post('/webhook/mercadopago', async (req, res) => {
  const type = req.query.type ?? req.body?.type;
  const id = String(req.query['data.id'] ?? req.body?.data?.id ?? '');
  if (type !== 'payment') return res.sendStatus(200);
  if (!/^\d+$/.test(id) || !validSignature(req, id)) return res.sendStatus(401);
  await syncPayment(id);
  res.sendStatus(200);
});

app.get('/painel', admin, (req, res) => {
  const rows = db.prepare("SELECT * FROM orders WHERE status IN ('paid','reversed') ORDER BY id").all();
  const lista = rows.map((o) => {
    const p = PRODUCTS[o.product];
    if (o.status === 'reversed') {
      return `<p>⚠️ Pedido #${o.id} estornado após a entrega: ${esc(p.nome)}, ${esc(o.nickname)}</p>`;
    }
    const link = `https://t.me/CounterFlameDonate_bot?start=s_${p.code}_${o.game_id}`;
    return `<section>
      <h3>#${o.id} - ${esc(p.nome)}</h3>
      <p>Conta: ${esc(o.nickname)} (ID ${esc(o.game_id)})<br>Confira no bot: ${p.stars} Stars</p>
      <a href="${esc(link)}" target="_blank" rel="noopener">Abrir no Telegram</a>
      <form method="post" action="/painel/${o.id}/entregue"><button>Marcar como entregue</button></form>
    </section>`;
  }).join('') || '<p>Nenhum pedido na fila.</p>';

  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Painel</title><style>body{font:16px system-ui;max-width:560px;margin:auto;padding:16px}
    section{border:1px solid #ccc;border-radius:8px;padding:12px;margin:12px 0}a,button{display:block;width:100%;padding:12px;margin-top:8px;box-sizing:border-box;text-align:center;font:inherit}</style>
    <h1>Pedidos pagos</h1>${lista}`);
});

app.post('/painel/:id/entregue', admin, (req, res) => {
  if (req.get('origin') !== new URL(env.PUBLIC_URL).origin) return res.sendStatus(403);
  db.prepare("UPDATE orders SET status='delivered', delivered_at=CURRENT_TIMESTAMP WHERE id=? AND status='paid'")
    .run(Number(req.params.id));
  res.redirect(303, '/painel');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente.' });
});

app.listen(env.PORT || 3000, () => console.log('Loja no ar'));
```

### public/index.html

```html
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recarga CounterFlame</title>
<style>
body{font:16px system-ui;max-width:460px;margin:auto;padding:20px;background:#101216;color:#eee}
input,select,button{width:100%;padding:12px;margin:6px 0;border-radius:8px;border:1px solid #444;font:inherit;box-sizing:border-box}
button{background:#f05a28;color:#fff;border:0;font-weight:700}
img{width:100%;max-width:260px;display:block;margin:12px auto;background:#fff}
.oculto{display:none}small{color:#aaa}#erro{color:#ff8a80}
</style>
</head>
<body>
<h1>Recarga CounterFlame</h1>
<small>Revenda independente. Esta não é a loja oficial do jogo.</small>

<div id="pedido">
  <select id="produto"></select>
  <input id="gameId" inputmode="numeric" placeholder="ID da conta no jogo">
  <button id="buscar">Buscar conta</button>
  <div id="conta" class="oculto">
    <p>Conta encontrada: <b id="nick"></b></p>
    <input id="email" type="email" placeholder="Seu e-mail">
    <button id="pagar">Essa é minha conta, gerar Pix</button>
  </div>
  <p id="erro"></p>
</div>

<div id="pix" class="oculto">
  <h2 id="status">Aguardando pagamento</h2>
  <img id="qr" alt="QR Code Pix">
  <input id="codigo" readonly>
  <button id="copiar">Copiar código Pix</button>
</div>

<script>
const $ = (id) => document.getElementById(id);
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function api(url, opt) {
  const r = await fetch(url, opt);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Erro. Tente novamente.');
  return j;
}

async function iniciar() {
  for (const p of await api('/api/products')) {
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = `${p.nome} - ${brl(p.cents)}`;
    $('produto').append(o);
  }
}

$('gameId').oninput = () => $('conta').classList.add('oculto');

$('buscar').onclick = async () => {
  $('erro').textContent = '';
  try {
    const id = $('gameId').value.trim();
    const { nickname } = await api(`/api/player/${encodeURIComponent(id)}`);
    $('nick').textContent = nickname;
    $('conta').classList.remove('oculto');
  } catch (e) { $('erro').textContent = e.message; }
};

$('pagar').onclick = async () => {
  $('erro').textContent = '';
  $('pagar').disabled = true;
  try {
    const pedido = await api('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: $('produto').value,
        gameId: $('gameId').value.trim(),
        email: $('email').value.trim(),
      }),
    });
    $('qr').src = `data:image/png;base64,${pedido.qrBase64}`;
    $('codigo').value = pedido.qr;
    $('pedido').classList.add('oculto');
    $('pix').classList.remove('oculto');
    acompanhar(pedido.token);
  } catch (e) {
    $('erro').textContent = e.message;
    $('pagar').disabled = false;
  }
};

$('copiar').onclick = async () => {
  await navigator.clipboard.writeText($('codigo').value);
  $('copiar').textContent = 'Código copiado';
};

function acompanhar(token) {
  const textos = {
    pending: 'Aguardando pagamento',
    paid: 'Pagamento confirmado! Sua entrega está na fila.',
    delivered: 'Entregue! Abra o jogo para conferir.',
    cancelled: 'Pagamento cancelado ou expirado.',
    reversed: 'Pagamento estornado.',
  };
  const timer = setInterval(async () => {
    try {
      const { status } = await api(`/api/orders/${token}`);
      $('status').textContent = textos[status] || status;
      if (status !== 'pending') {
        $('qr').classList.add('oculto');
        $('codigo').classList.add('oculto');
        $('copiar').classList.add('oculto');
      }
      if (['delivered', 'cancelled', 'reversed'].includes(status)) clearInterval(timer);
    } catch {}
  }, 10000);
}

iniciar().catch((e) => { $('erro').textContent = e.message; });
</script>
</body>
</html>
```

## 12. Referências

- CounterFlame: https://counterflame.com/en
- Termos de Telegram Stars: https://telegram.org/tos/stars
- Método `payments.sendStarsForm`: https://core.telegram.org/method/payments.sendStarsForm
- Pix no Mercado Pago: https://www.mercadopago.com.br/developers/en/docs/checkout-api-payments/integration-configuration/integrate-pix
- Webhooks do Mercado Pago: https://mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
- Atividades proibidas no Mercado Pago Global Selling: https://global-selling.mercadopago.com/help/18572
