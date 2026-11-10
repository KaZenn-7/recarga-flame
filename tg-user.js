// Conta de usuário do Telegram (conta SEPARADA da operação) via MTProto/GramJS.
// Hoje: SÓ leitura do saldo de Stars. Nenhuma mensagem é enviada e nada é pago por aqui.
//
// A sessão (.tg_user_session, 0600) dá controle TOTAL da conta — trate como senha:
// nunca imprimir, nunca commitar, nunca pôr no backup. Para revogar: Telegram → Configurações →
// Dispositivos → encerrar a sessão "Recarga Flame". Login: `node tg-user-login.mjs` (no terminal).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const SESSION_FILE = process.env.TG_USER_SESSION_PATH || path.join(DIR, '.tg_user_session');

export function userConfig(env = process.env) {
  // testes NUNCA usam a conta real (o .env real é carregado pelo dotenv e a sessão existe em disco)
  if (env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test') return { ok: false, apiId: 0, apiHash: '', session: '' };
  const apiId = Number(env.TG_API_ID);
  const apiHash = String(env.TG_API_HASH || '');
  let session = '';
  try { session = fs.readFileSync(SESSION_FILE, 'utf8').trim(); } catch { /* sem login */ }
  return { ok: !!(apiId && /^[0-9a-f]{32}$/.test(apiHash) && session), apiId, apiHash, session };
}

// cliente GramJS com identificação fixa (aparece em "Dispositivos" do Telegram)
export async function makeClient(apiId, apiHash, session) {
  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions/index.js');
  const c = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3, deviceModel: 'Recarga Flame (VPS)', appVersion: '1.0', systemVersion: 'Linux',
    // FLOOD_WAIT até 2 min: a biblioteca espera e repete sozinha (o pedido recusado por flood não foi executado)
    floodSleepThreshold: 120,
  });
  c.setLogLevel('error');
  return c;
}

let client = null;
let connecting = null;
async function getClient(env) {
  const cfg = userConfig(env);
  if (!cfg.ok) throw new Error('conta de usuário não configurada');
  if (client?.connected) return client;
  if (!connecting) {
    connecting = (async () => {
      const c = await makeClient(cfg.apiId, cfg.apiHash, cfg.session);
      await c.connect();
      if (!(await c.checkAuthorization())) throw new Error('sessão expirada ou revogada — refaça o login');
      client = c;
      return c;
    })().finally(() => { connecting = null; });
  }
  return connecting;
}

export const starsToInt = (b) => (b && typeof b === 'object' && 'amount' in b ? Number(b.amount.toString()) : Number(b?.toString?.() ?? b));

// saldo de Stars da conta logada (inteiro)
export async function readStarsBalance(env = process.env) {
  const { Api } = await import('telegram');
  const c = await getClient(env);
  const r = await c.invoke(new Api.payments.GetStarsStatus({ peer: new Api.InputPeerSelf() }));
  const n = starsToInt(r.balance);
  if (!Number.isFinite(n)) throw new Error('resposta inesperada do Telegram');
  return n;
}

// ---- Conferência da fatura e pagamento (1 por vez, para não misturar respostas) ----
// O bot do CF responde ao deep link com "<produto>\n\nAccount: <nick>" + fatura em Stars (MessageMediaInvoice, XTR).
export const CF_BOT = 'CounterFlameDonate_bot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

async function fetchInvoice(c, startParam) {
  const { Api } = await import('telegram');
  const { generateRandomLong } = await import('telegram/Helpers.js');
  const before = (await c.getMessages(CF_BOT, { limit: 1 }))[0]?.id || 0;
  await c.invoke(new Api.messages.StartBot({ bot: CF_BOT, peer: CF_BOT, randomId: generateRandomLong(), startParam }));
  let lastText = '';
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const msgs = (await c.getMessages(CF_BOT, { limit: 8 })).filter((m) => m.id > before && !m.out).reverse();
    const texts = msgs.filter((m) => m.message).map((m) => m.message);
    if (texts.length) lastText = texts.at(-1);
    const inv = msgs.find((m) => m.media?.className === 'MessageMediaInvoice');
    if (inv) {
      const info = texts.find((t) => /Account:/i.test(t)) || '';
      return {
        msgId: inv.id,
        currency: inv.media.currency,
        stars: Number(inv.media.totalAmount?.toString()),
        desc: String(inv.media.description || '').slice(0, 120),
        produto: info.split('\n')[0].trim().slice(0, 120),
        account: (/Account:\s*(.+)/i.exec(info)?.[1] || '').trim().slice(0, 64),
      };
    }
  }
  throw new Error(lastText ? `o bot respondeu sem fatura: "${lastText.slice(0, 100)}"` : 'o bot não respondeu em 15 s');
}

// Conferência: NÃO paga.
export function checkInvoice(startParam, env = process.env) {
  return serial(async () => fetchInvoice(await getClient(env), startParam));
}

// Pagamento: confere a fatura de novo e paga SÓ se valor/moeda/conta baterem.
// Erros antes do envio têm e.safe = true (nada foi cobrado). Depois do envio, qualquer falha é "incerta".
// onInvoice(msgId) é chamado ANTES de cobrar: o servidor grava o nº da mensagem da fatura no pedido,
// que identifica este pagamento de forma única (ver invoicePaid).
export function payInvoice({ startParam, expectStars, expectAccount, onInvoice }, env = process.env) {
  return serial(async () => {
    const { Api } = await import('telegram');
    const safe = (msg) => Object.assign(new Error(msg), { safe: true });
    let c, inv, form, invoice;
    try {
      c = await getClient(env);
      inv = await fetchInvoice(c, startParam);
      if (inv.currency !== 'XTR') throw safe(`moeda ${inv.currency}`);
      if (inv.stars !== expectStars) throw safe(`fatura de ${inv.stars}★, esperado ${expectStars}★`);
      if (String(inv.account).trim().toLowerCase() !== String(expectAccount).trim().toLowerCase()) throw safe(`conta "${inv.account}" ≠ "${expectAccount}"`);
      invoice = new Api.InputInvoiceMessage({ peer: await c.getInputEntity(CF_BOT), msgId: inv.msgId });
      form = await c.invoke(new Api.payments.GetPaymentForm({ invoice }));
      if (form.className !== 'payments.PaymentFormStars') throw safe(`formulário inesperado (${form.className})`);
      const total = (form.invoice?.prices || []).reduce((a, p) => a + Number(p.amount.toString()), 0);
      if (form.invoice?.currency !== 'XTR' || total !== expectStars) throw safe(`formulário cobra ${total} ${form.invoice?.currency}`);
    } catch (e) {
      if (e.safe) throw e;
      throw safe(String(e?.errorMessage || e?.message || e)); // nada foi enviado ainda
    }
    const before = inv.msgId;
    if (onInvoice) await onInvoice(inv.msgId);
    let r;
    try {
      r = await c.invoke(new Api.payments.SendStarsForm({ formId: form.formId, invoice })); // ← COBRA
    } catch (e) {
      // Erro DEPOIS do envio: a resposta pode ter se perdido e o pedido ter sido reenviado (o Telegram responde
      // FORM_SUBMIT_DUPLICATE mesmo tendo cobrado o 1º — incidente do pedido #17, 10/11/2026). A única prova é o
      // recibo da fatura: com recibo = pago; sem recibo + recusa explícita = nada cobrado; resto = incerto.
      let paid = null;
      for (let i = 0; i < 3 && paid == null; i++) {
        await sleep(2000);
        try { paid = (await receiptOf(c, inv.msgId)).paid; } catch { /* tenta de novo */ }
      }
      const d = decideAfterSendError(e, paid);
      if (d === 'paid') return { stars: expectStars, account: inv.account, produto: inv.produto, botReply: '', recuperado: String(e?.errorMessage || e?.message || e).slice(0, 80) };
      if (d === 'safe') throw safe(`Telegram recusou: ${e.errorMessage}`);
      throw e;
    }
    if (r.className !== 'payments.PaymentResult') throw new Error(`resposta inesperada ao pagar (${r.className})`);
    // resposta do bot depois do pagamento (só informativo)
    let botReply = '';
    for (let i = 0; i < 6 && !botReply; i++) {
      await sleep(1500);
      const msgs = (await c.getMessages(CF_BOT, { limit: 6 })).filter((m) => m.id > before && !m.out && m.message);
      botReply = msgs.at(0)?.message?.slice(0, 200) || '';
    }
    return { stars: expectStars, account: inv.account, produto: inv.produto, botReply };
  });
}

// ---- Verificação de cobrança (resolver "incerto") ----
// Cada pedido gera uma fatura nova (mensagem única no chat com o bot). Quando ela é paga, o Telegram liga o
// recibo a ELA: media.receiptMsgId na fatura e um MessageActionPaymentSent respondendo à fatura.
// Não depende de valor/horário (vários pedidos iguais não se confundem). Só leitura.
export function invoicePaid(msgId, env = process.env) {
  return serial(async () => receiptOf(await getClient(env), msgId));
}
// recibo da fatura msgId (usa um cliente já conectado; não passa pela fila — chamado de dentro do payInvoice)
async function receiptOf(c, msgId) {
  const [inv] = await c.getMessages(CF_BOT, { ids: [msgId] });
  if (!inv || inv.media?.className !== 'MessageMediaInvoice') throw new Error(`fatura ${msgId} não encontrada no chat com o bot`);
  if (inv.media.receiptMsgId) return { paid: true, receiptMsgId: inv.media.receiptMsgId };
  const recent = await c.getMessages(CF_BOT, { limit: 100, minId: msgId });
  const rc = recent.find((m) => m.action?.className === 'MessageActionPaymentSent' && m.replyTo?.replyToMsgId === msgId);
  return rc ? { paid: true, receiptMsgId: rc.id, date: rc.date } : { paid: false };
}
// Erro ao enviar o pagamento: 'paid' (fatura tem recibo), 'safe' (sem recibo e recusa explícita 4xx que não é
// de duplicidade = nada cobrado, pode tentar de novo) ou 'incerto' (resolver por "verificar cobrança").
export function decideAfterSendError(e, paid) {
  if (paid === true) return 'paid';
  const msg = String(e?.errorMessage || '');
  if (paid === false && msg && e.code >= 400 && e.code < 500 && !/DUPLICATE/i.test(msg)) return 'safe';
  return 'incerto';
}
