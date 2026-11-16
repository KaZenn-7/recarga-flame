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
  return balanceOf(await getClient(env));
}
async function balanceOf(c) {
  const { Api } = await import('telegram');
  const r = await c.invoke(new Api.payments.GetStarsStatus({ peer: new Api.InputPeerSelf() }));
  const n = starsToInt(r.balance);
  if (!Number.isFinite(n)) throw new Error('resposta inesperada do Telegram');
  return n;
}
// Prova pelo saldo (incidentes #116, #128 e #181, 15–16/11/2026): nos 5 FORM_SUBMIT_DUPLICATE registrados o saldo
// caiu EXATAMENTE o valor da fatura logo depois, mas o recibo nunca foi achado (receiptOf). Queda igual ao valor
// = cobrado (true); saldo igual = não cobrou, até agora (false); outra diferença (compra, outro gasto) = 'outro';
// sem as duas leituras = null. Só true é prova de cobrança; só false permite dizer "nada cobrado".
export function provaPeloSaldo(antes, depois, stars) {
  if (antes == null || depois == null || !Number.isFinite(antes) || !Number.isFinite(depois)) return null;
  if (antes - depois === stars) return true;
  if (antes === depois) return false;
  return 'outro';
}

// ---- Conferência da fatura e pagamento (1 por vez, para não misturar respostas) ----
// O bot do CF responde ao deep link com "<produto>\n\nAccount: <nick>" + fatura em Stars (MessageMediaInvoice, XTR).
export const CF_BOT = 'CounterFlameDonate_bot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fila com tempo limite por tarefa: uma chamada travada (rede caiu, TIMEOUT do GramJS) não pode parar todas as
// entregas. Esgotado o tempo, a fila segue e a tarefa recebe ctx.dead = true: o pagamento confere isso logo antes de
// cobrar e desiste. O erro de tempo é "safe" (nada cobrado) se a cobrança não foi enviada; se foi, é incerto (o
// recibo é conferido sozinho depois). JOB_MS cobre o FLOOD_WAIT de até 2 min que a biblioteca espera sozinha.
export const JOB_MS = 180_000;
export function makeSerial(ms = JOB_MS) {
  let chain = Promise.resolve();
  return (fn) => {
    const job = () => {
      const ctx = { dead: false, sent: false };
      let t;
      const limite = new Promise((_, rej) => {
        t = setTimeout(() => {
          ctx.dead = true;
          rej(Object.assign(new Error(`o Telegram não respondeu em ${Math.round(ms / 1000)} s`), { safe: !ctx.sent, timeout: true }));
        }, ms);
        t.unref?.();
      });
      return Promise.race([Promise.resolve().then(() => fn(ctx)), limite]).finally(() => clearTimeout(t));
    };
    const p = chain.then(job, job); chain = p.catch(() => {}); return p;
  };
}
const serial = makeSerial();

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
  return serial(async (ctx) => {
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
    let saldoAntes = null;
    try { saldoAntes = await balanceOf(c); } catch { /* sem prova pelo saldo; segue pelo recibo */ }
    if (ctx.dead) throw safe('tempo esgotado antes de cobrar');
    const envioEm = Math.floor(Date.now() / 1000) - 2; // folga de relógio: cobranças deste envio têm date ≥ envioEm
    if (onInvoice) await onInvoice(inv.msgId, saldoAntes, envioEm);
    if (ctx.dead) throw safe('tempo esgotado antes de cobrar');
    ctx.sent = true; // daqui em diante, tempo esgotado = incerto
    let r;
    try {
      r = await c.invoke(new Api.payments.SendStarsForm({ formId: form.formId, invoice })); // ← COBRA
    } catch (e) {
      // Erro DEPOIS do envio: a resposta pode ter se perdido e o pedido ter sido reenviado (o Telegram responde
      // FORM_SUBMIT_DUPLICATE mesmo tendo cobrado o 1º — pedidos #17, #116, #128, #181). Provas: a cobrança no
      // histórico de Stars (para o bot do CF, valor exato, depois do envio — dentro da fila nenhum outro pagamento
      // acontece no meio), o recibo da fatura ou a queda EXATA do saldo. Por ~12 s.
      let paid = null, saldoDepois = null, prova = null, txId = null;
      for (let i = 0; i < 6 && prova == null; i++) {
        await sleep(2000);
        try {
          const [t] = cobrancasCF(await lerHistorico(c, { desde: envioEm, paginas: 1 }), expectStars, envioEm);
          if (t) { prova = 'historico'; txId = t.id; }
        } catch { /* segue pelas outras provas */ }
        if (prova == null) try { const rc = await receiptOf(c, inv.msgId); if (rc.paid) prova = 'recibo'; else paid = false; } catch { /* tenta de novo */ }
        if (prova == null && saldoAntes != null) {
          try { saldoDepois = await balanceOf(c); if (provaPeloSaldo(saldoAntes, saldoDepois, expectStars) === true) prova = 'saldo'; } catch { /* tenta de novo */ }
        }
      }
      const d = decideAfterSendError(e, prova ? true : paid, provaPeloSaldo(saldoAntes, saldoDepois, expectStars));
      if (d === 'paid') return { stars: expectStars, account: inv.account, produto: inv.produto, botReply: '', prova: prova || 'recibo', ...(txId ? { txId } : {}), recuperado: String(e?.errorMessage || e?.message || e).slice(0, 80) };
      if (d === 'safe') throw safe(`Telegram recusou: ${e.errorMessage}`);
      throw Object.assign(e, { saldoAntes, saldoDepois });
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

// ---- Histórico de Stars (só leitura) ----
// Saídas da conta, mais recentes primeiro, entre desde..ate (unix s). Serve para achar o ID de uma transação (disputa
// no @BotFather) e casar com a fatura: msgId é a mensagem da fatura paga no chat com o bot. Até 10 páginas de 50.
export function starsTransactions(q = {}, env = process.env) {
  return serial(async () => lerHistorico(await getClient(env), q));
}
async function lerHistorico(c, { desde = 0, ate = 0, limite = 200, paginas = 10 } = {}) {
  const { Api } = await import('telegram');
  const out = []; let offset = '';
  for (let page = 0; page < paginas; page++) {
    const r = await c.invoke(new Api.payments.GetStarsTransactions({ outbound: true, peer: new Api.InputPeerSelf(), offset, limit: 50 }));
    const nomes = new Map((r.users || []).map((u) => [String(u.id), u.username || null]));
    for (const t of r.history || []) {
      if (ate && t.date > ate) continue;
      if (desde && t.date < desde) return out;
      const uid = t.peer?.peer?.userId;
      out.push({ id: t.id, stars: starsToInt(t.stars), date: t.date, bot: uid != null ? nomes.get(String(uid)) || String(uid) : null,
        msgId: t.msgId ?? null, title: t.title || null, refund: !!t.refund, pending: !!t.pending, failed: !!t.failed });
      if (out.length >= limite) return out;
    }
    if (!r.nextOffset) break;
    offset = r.nextOffset;
  }
  return out;
}
// Cobranças do bot do CF de exatamente `stars`, concluídas (não falha/estorno/pendente), com data em desde..ate
export const cobrancasCF = (tx, stars, desde, ate) => tx.filter((t) => t.bot === CF_BOT && t.stars === -stars
  && !t.failed && !t.refund && !t.pending && t.date >= desde && (!ate || t.date <= ate));

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
// Erro ao enviar o pagamento: 'paid' (recibo ou queda exata do saldo), 'safe' (sem recibo, recusa explícita 4xx que
// não é de duplicidade e o saldo não mudou — ou não deu para ler — = nada cobrado, pode tentar de novo) ou 'incerto'.
// saldo: resultado de provaPeloSaldo (true = caiu o valor, false = não mudou, 'outro' = mudou outro valor, null = sem leitura)
export function decideAfterSendError(e, paid, saldo = null) {
  if (paid === true || saldo === true) return 'paid';
  const msg = String(e?.errorMessage || '');
  if (saldo === 'outro') return 'incerto';
  if (paid === false && msg && e.code >= 400 && e.code < 500 && !/DUPLICATE/i.test(msg)) return 'safe';
  return 'incerto';
}
