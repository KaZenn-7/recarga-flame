// Preparação comum dos testes da loja: ambiente de teste, APIs externas falsas (MP, Telegram, CounterFlame, Resend),
// loja num banco temporário e funções auxiliares. Cada arquivo *.test.js roda num processo próprio, com loja e banco próprios:
// chame setupStore() no topo do arquivo; dados que o arquivo precisa antes dos testes vão em setupStore(async () => { ... }).
// Runner nativo do Node (node --test), sem dependências novas.
import { before, after, beforeEach } from 'node:test';
import fs from 'node:fs';

// --- ambiente de teste: definido ANTES de importar o server ---
const TEST_DB = `/tmp/cf-test-${process.pid}-${Date.now()}.db`;
process.env.NODE_ENV = 'test';
process.env.DB_PATH = TEST_DB;
process.env.TG_TOPICS_FILE = TEST_DB + '.topicos.json'; // grupo com tópicos do teste (cada arquivo de teste tem o seu)
process.env.MP_ACCESS_TOKEN = 'TEST-token-fake';
process.env.MP_WEBHOOK_SECRET = 'segredo-teste';
process.env.ADMIN_USER = 'admin_test';
process.env.ADMIN_PASS = 'senha_test_longa';
process.env.PUBLIC_URL = 'http://localhost:0';
process.env.CF_BASE = 'https://counterflame.test';
process.env.STARS_LOW = '500'; // os testes de saldo baixo usam o limite antigo
process.env.TG_BOT_TOKEN = 'tg-fake';
process.env.TG_CHAT_ID = '42';
process.env.RESEND_API_KEY = 're_fake';
process.env.MAX_PENDING_PIX = '99'; // testes antigos geram vários Pix p/ o mesmo ID; o teste antifraude reduz

// --- mock de fetch: intercepta só APIs externas; localhost passa direto ---
const realFetch = globalThis.fetch;
// estado do Mercado Pago falso (os testes mudam estes campos)
export const mock = {
  approve: true,   // status devolvido pelo MP: approved (true) ou pending
  status: null,    // força um status na consulta (ex.: 'refunded')
  payer: null,     // dados do pagador devolvidos pelo MP (CPF/conta)
  lastBody: null,  // corpo do último pagamento criado no MP
  tgFailChat: null, // chat_id em que o Telegram falso recusa tudo
  refunds: [],     // reembolsos pedidos ao MP ({ url, body, key })
};
export const cfCalls = [];              // consultas de conta ao CounterFlame
export const tgSent = [];               // mensagens enviadas ao Telegram
export const mailSent = [];             // e-mails enviados ao Resend
export const tgCalls = [];               // todas as chamadas à API do bot ({ method, body })
export const avatarCalls = [];           // chamadas ao avatar do CounterFlame
export const lastCode = () => (tgSent.at(-1)?.text.match(/\b(\d{6})\b/) || [])[1];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  // Resend (e-mail ao cliente)
  if (u === 'https://api.resend.com/emails') {
    mailSent.push({ auth: opts.headers.Authorization, ...JSON.parse(opts.body) });
    return new Response('{"id":"x"}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Telegram (código de login, notificações)
  if (u.startsWith('https://api.telegram.org/')) {
    const method = u.split('/').pop(), body = JSON.parse(opts.body);
    tgCalls.push({ method, body });
    // chat que "não aceita" mensagens (ex.: bot removido do grupo): testa a volta para o chat privado
    if (mock.tgFailChat && String(body.chat_id) === String(mock.tgFailChat)) {
      return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was kicked' }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'sendMessage') tgSent.push(body);
    const result = method === 'sendMessage'
      ? { message_id: 700 + tgCalls.length, chat: { id: Number(body.chat_id) }, ...(body.message_thread_id ? { message_thread_id: body.message_thread_id } : {}) }
      : method === 'createForumTopic' ? { message_thread_id: 300 + tgCalls.length, name: body.name } : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // avatar do CounterFlame
  if (u.startsWith('https://counterflame.test/') && u.includes('/avatar')) {
    avatarCalls.push(u);
    if (u.includes('/888777/')) return new Response('', { status: 404 }); // conta sem avatar
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  // player do CounterFlame
  if (u.startsWith('https://counterflame.test/api/users/')) {
    cfCalls.push(u);
    if (u.includes('/999999')) return new Response('{}', { status: 404 });
    if (u.endsWith('/400400')) return new Response('{}', { status: 400 }); // ID que o jogo não aceita
    if (u.endsWith('/429429')) return new Response('{}', { status: 429 }); // limite do CounterFlame
    return new Response(JSON.stringify({
      success: true,
      data: { nickname: 'jogador_teste', wildfireLevel: 0,
        arsenalPass: { tickets: Number(/\/33300(\d)$/.exec(u)?.[1] || 0), maxTickets: 5 }, // 33300N: conta com N tickets
        battlePass: { gold: u.includes('/555555'), level: u.includes('/444096') ? 96 : 0, totalLevels: 50 } }, // 444096: conta no nível 96
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // criar pagamento no Mercado Pago
  if (u === 'https://api.mercadopago.com/v1/payments' && opts?.method === 'POST') {
    mock.lastBody = JSON.parse(opts.body);
    if (mock.lastBody.payer.email.endsWith('.cokc')) {
      return new Response(JSON.stringify({ message: 'payer.email must be a valid email', status: 400, cause: [{ description: 'payer.email must be a valid email' }] }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 123456, status: 'pending',
      point_of_interaction: { transaction_data: { qr_code: 'PIXCODE', qr_code_base64: 'BASE64' } },
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  // cancelar pagamento no MP: só cancela se ainda não foi aprovado
  if (u.startsWith('https://api.mercadopago.com/v1/payments/') && opts?.method === 'PUT') {
    if (mock.approve) {
      return new Response(JSON.stringify({ message: 'Payment already approved' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 123456, status: 'cancelled' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // reembolso no MP (integral: corpo {}; parcial: { amount })
  if (u.startsWith('https://api.mercadopago.com/v1/payments/') && u.endsWith('/refunds') && opts?.method === 'POST') {
    mock.refunds.push({ url: u, body: JSON.parse(opts.body || '{}'), key: opts.headers['X-Idempotency-Key'] });
    return new Response(JSON.stringify({ id: 9000 + mock.refunds.length, status: 'approved' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  // consultar pagamento no MP (usado por syncPayment)
  if (u.startsWith('https://api.mercadopago.com/v1/payments/')) {
    return new Response(JSON.stringify({
      status: mock.status ?? (mock.approve ? 'approved' : 'pending'),
      transaction_amount: (mock.lastBody?.transaction_amount) ?? 3.5,
      external_reference: mock.lastBody?.external_reference,
      ...(mock.payer || {}),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts); // localhost e demais
};

let server;
export let SRV, app, base, adminFails, expirePending, db, remindPending, starsForecast, riskOf, _setRefundCaller, RISK, handleTgUpdate, _setStarsReader, _setInvoiceChecker, conferir, _setInvoicePayer, _setReceiptChecker, dailySummary, summaryTick;
export let COOKIE = '';
export async function login() {
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() }, body: JSON.stringify(b) });
  const r1 = await post('/login/senha', { user: 'admin_test', pass: 'senha_test_longa' });
  const { challenge } = await r1.json();
  const r2 = await post('/login/codigo', { challenge, code: lastCode() });
  return (r2.headers.get('set-cookie') || '').split(';')[0];
}
// cada chamada ganha um IP único via X-Forwarded-For para não compartilhar baldes de rate-limit
let ipSeq = 0;
// espera uma condição ficar verdadeira (até 3 s) — evita testes que dependem de tempo fixo
export const ateQue = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('condição não atingida em ' + ms + ' ms'); await new Promise((r) => setTimeout(r, 10)); } };
export const freshIP = () => ({ 'X-Forwarded-For': `10.0.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` });

export function setupStore(prepare) {
  before(async () => {
    const mod = await import('../server.js?test=' + Date.now());
    SRV = mod; app = mod.app; adminFails = mod.adminFails; expirePending = mod.expirePending; db = mod.db; remindPending = mod.remindPending; starsForecast = mod.starsForecast; riskOf = mod.riskOf; _setRefundCaller = mod._setRefundCaller; RISK = mod.RISK; handleTgUpdate = mod.handleTgUpdate; _setStarsReader = mod._setStarsReader; _setInvoiceChecker = mod._setInvoiceChecker; conferir = mod.conferir; _setInvoicePayer = mod._setInvoicePayer; _setReceiptChecker = mod._setReceiptChecker; dailySummary = mod.dailySummary; summaryTick = mod.summaryTick;
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
    process.env.PUBLIC_URL = base; // para checagens same-origin
    COOKIE = await login();
    if (prepare) await prepare(); // dentro do mesmo before: a loja já está no ar
  });

  after(() => {
    server?.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(process.env.TG_TOPICS_FILE); } catch {}
  });

  // cada teste começa com o rate-limit do admin zerado (evita contaminação entre testes)
  beforeEach(() => { adminFails?.clear(); });
}

export const postJ = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...freshIP() }, body: JSON.stringify(b) });
export const adm = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, 'x-painel': '1' }, body: body && JSON.stringify(body) });
export const pedir = async (product, gameId, email) => postJ('/api/orders', { product, gameId, email });
export const pagar = async (token) => fetch(base + '/api/orders/' + token, { headers: freshIP() }); // consulta → syncPayment → paid
export const webhookMP = async () => {
  const crypto = await import('node:crypto');
  const v1 = crypto.createHmac('sha256', 'segredo-teste').update('id:123456;request-id:r1;ts:1;').digest('hex');
  return fetch(base + '/webhook/mercadopago?type=payment&data.id=123456', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-request-id': 'r1', 'x-signature': `ts=1,v1=${v1}` }, body: '{}' });
};
export const pagadorX = {
  // o MP devolve o CNPJ dele mesmo em payer.identification: não pode virar bloqueio
  payer: { identification: { type: 'CNPJ', number: '10573521000191' } },
  point_of_interaction: { transaction_data: { bank_info: { payer: { long_name: 'Banco X', branch: '1', account_id: 987654 } } } },
};
export const OP = 42; // TG_CHAT_ID do teste
export const cb = (data, msgId, from = OP) => handleTgUpdate({ update_id: 1, callback_query: {
  id: 'cq' + Math.random(), data, from: { id: from }, message: { message_id: msgId, chat: { id: from } } } });
export const lastCall = (m) => tgCalls.filter((c) => c.method === m).at(-1);
