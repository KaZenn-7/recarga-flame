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

// Fatura já aberta no chat (a da conferência): mesma forma que fetchInvoice, ou null se não serve (não é fatura, já tem
// recibo, ou falta a mensagem "Account:" logo antes). Evita abrir uma 2ª fatura igual para o mesmo pedido (17/11/2026).
async function invoiceById(c, msgId) {
  const [inv] = await c.getMessages(CF_BOT, { ids: [msgId] });
  if (!inv || inv.out || inv.media?.className !== 'MessageMediaInvoice' || inv.media.receiptMsgId) return null;
  const [txt] = await c.getMessages(CF_BOT, { ids: [msgId - 1] });
  const info = String(txt?.message || '');
  if (!/Account:/i.test(info)) return null;
  return {
    msgId: inv.id, currency: inv.media.currency, stars: Number(inv.media.totalAmount?.toString()),
    desc: String(inv.media.description || '').slice(0, 120), produto: info.split('\n')[0].trim().slice(0, 120),
    account: (/Account:\s*(.+)/i.exec(info)?.[1] || '').trim().slice(0, 64), reusada: true,
  };
}

// Conferência: NÃO paga.
export function checkInvoice(startParam, env = process.env) {
  return serial(async () => fetchInvoice(await getClient(env), startParam));
}

// O GramJS repete sozinho um pedido que volta com erro interno do Telegram (ServerError/RPC_CALL_FAIL), 2 s depois
// (client/users.js invoke, requestRetries=5). No pagamento isso gera o FORM_SUBMIT_DUPLICATE: o 1º envio cobrou mas
// ficou sem recibo e o CounterFlame não entregou (7 casos, 13–17/11/2026). O envio da cobrança roda com 1 tentativa
// só: o erro real fica registrado e nada é reenviado por cima do 1º (a conferência do recibo decide depois).
export async function semRepetir(c, fn) {
  const antes = c._requestRetries;
  c._requestRetries = 1;
  try { return await fn(); } finally { c._requestRetries = antes; }
}

// Intervalo mínimo entre duas cobranças (17/11/2026): 3 dos 7 FORM_SUBMIT_DUPLICATE vieram < 10 s depois da cobrança
// anterior (~8% de erro nesse caso × ~3% com 10 s ou mais). Medir por ~1 semana; ver docs/auditoria.
export const INTERVALO_MS = process.env.NODE_ENV === 'test' ? 0 : 10_000;
let ultimoEnvio = 0;
export const esperaEnvio = (ultimo, agora = Date.now(), min = INTERVALO_MS) => Math.max(0, ultimo + min - agora);

// Pagamento: confere a fatura de novo e paga SÓ se valor/moeda/conta baterem.
// Erros antes do envio têm e.safe = true (nada foi cobrado). Depois do envio, qualquer falha é "incerta".
// onInvoice(msgId) é chamado ANTES de cobrar: o servidor grava o nº da mensagem da fatura no pedido,
// que identifica este pagamento de forma única (ver invoicePaid).
export function payInvoice({ startParam, expectStars, expectAccount, onInvoice, reuseMsgId = null }, env = process.env) {
  return serial(async (ctx) => {
    const { Api } = await import('telegram');
    const safe = (msg) => Object.assign(new Error(msg), { safe: true });
    let c, inv, form, invoice;
    try {
      c = await getClient(env);
      // a fatura da conferência (se ainda serve) em vez de abrir outra igual; senão, fatura nova como antes
      inv = (reuseMsgId ? await invoiceById(c, reuseMsgId).catch(() => null) : null) || await fetchInvoice(c, startParam);
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
    const espera = esperaEnvio(ultimoEnvio);
    if (espera) await sleep(espera);               // dentro da fila: nenhuma outra cobrança passa na frente
    let saldoAntes = null;
    try { saldoAntes = await balanceOf(c); } catch { /* sem prova pelo saldo; segue pelo recibo */ }
    if (ctx.dead) throw safe('tempo esgotado antes de cobrar');
    const envioEm = Math.floor(Date.now() / 1000) - 2; // folga de relógio: cobranças deste envio têm date ≥ envioEm
    if (onInvoice) await onInvoice(inv.msgId, saldoAntes, envioEm);
    if (ctx.dead) throw safe('tempo esgotado antes de cobrar');
    ctx.sent = true; // daqui em diante, tempo esgotado = incerto
    let r;
    const t0 = Date.now();                          // diagnóstico: quanto o Telegram leva para responder a cobrança
    let envioMs = 0;
    try {
      r = await semRepetir(c, () => c.invoke(new Api.payments.SendStarsForm({ formId: form.formId, invoice }))); // ← COBRA (1 envio só)
      ultimoEnvio = Date.now();
      envioMs = ultimoEnvio - t0;
    } catch (e) {
      ultimoEnvio = Date.now();
      Object.assign(e, { envioMs: Date.now() - t0, esperaMs: espera });
      // com 1 tentativa só, erro interno do Telegram (ServerError/RPC_CALL_FAIL) chega como "Request was unsuccessful"
      if (/Request was unsuccessful/.test(String(e?.message))) e.errorMessage = 'TELEGRAM_INTERNO (erro interno do Telegram; envio não repetido)';
      // Erro DEPOIS do envio: a resposta pode ter se perdido e o pedido ter sido reenviado (o Telegram responde
      // FORM_SUBMIT_DUPLICATE). ENTREGA só se prova pelo recibo da fatura (o bot do CF responde "Done…" a ele).
      // 17/11/2026: nos 7 FORM_SUBMIT_DUPLICATE (#74…#217) o Telegram COBROU (histórico de Stars) mas a fatura ficou
      // sem recibo e o CounterFlame NÃO entregou nem registrou. Histórico/saldo só dizem se houve cobrança perdida.
      let paid = null;
      for (let i = 0; i < 15 && paid !== true; i++) { // até 30 s: dá tempo ao Telegram de concluir o 1º envio
        await sleep(2000);
        try { paid = (await receiptOf(c, inv.msgId)).paid; } catch { /* tenta de novo */ }
      }
      let saldoDepois = null, txId = null, cobrado = null;
      if (paid !== true) {
        try { const [t] = cobrancasCF(await lerHistorico(c, { desde: envioEm, paginas: 1 }), expectStars, envioEm); cobrado = !!t; txId = t?.id || null; } catch { /* sem histórico */ }
        if (saldoAntes != null) try { saldoDepois = await balanceOf(c); } catch { /* sem saldo */ }
      }
      const saldo = provaPeloSaldo(saldoAntes, saldoDepois, expectStars);
      const d = decideAfterSendError(e, paid, cobrado === true ? true : saldo);
      if (d === 'paid') return { stars: expectStars, account: inv.account, produto: inv.produto, botReply: '', recuperado: String(e?.errorMessage || e?.message || e).slice(0, 80) };
      if (d === 'safe') throw safe(`Telegram recusou: ${e.errorMessage}`);
      throw Object.assign(e, { saldoAntes, saldoDepois, txPerdida: txId });
    }
    if (r.className !== 'payments.PaymentResult') throw new Error(`resposta inesperada ao pagar (${r.className})`);
    // resposta do bot depois do pagamento (só informativo)
    let botReply = '';
    for (let i = 0; i < 6 && !botReply; i++) {
      await sleep(1500);
      const msgs = (await c.getMessages(CF_BOT, { limit: 6 })).filter((m) => m.id > before && !m.out && m.message);
      botReply = msgs.at(0)?.message?.slice(0, 200) || '';
    }
    return { stars: expectStars, account: inv.account, produto: inv.produto, botReply, envioMs, esperaMs: espera };
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
// ---- Conta separada (só leitura): ID e usuário — o CounterFlame precisa do ID para estornar (refundStarPayment) ----
export function contaPropria(env = process.env) {
  return serial(async () => {
    const me = await (await getClient(env)).getMe();
    return { id: me.id?.toString() || null, username: me.username || null };
  });
}

// ---- Mensagens do chat com o bot do CF (só leitura) ----
// Entre desde..ate (unix s), mais antigas primeiro: faturas, respostas ("Done… Order CF-…"), recibos. Serve para conferir
// se o bot confirmou um pedido pago (ex.: FORM_SUBMIT_DUPLICATE). Volta no máximo 30 páginas de 100 mensagens.
export function botMessages({ desde = 0, ate = 0 } = {}, env = process.env) {
  return serial(async () => {
    const c = await getClient(env);
    const out = []; let offsetId = 0;
    for (let page = 0; page < 30; page++) {
      const msgs = await c.getMessages(CF_BOT, { limit: 100, ...(offsetId ? { offsetId } : {}) });
      if (!msgs.length) break;
      for (const m of msgs) {
        if (ate && m.date > ate) continue;
        if (desde && m.date < desde) return out.reverse();
        const inv = m.media?.className === 'MessageMediaInvoice' ? m.media : null;
        out.push({ id: m.id, date: m.date, out: !!m.out, texto: String(m.message || '').slice(0, 400),
          fatura: inv ? { stars: Number(inv.totalAmount?.toString()), titulo: String(inv.title || '').slice(0, 80), recibo: inv.receiptMsgId || null } : null,
          acao: m.action?.className || null, respondeA: m.replyTo?.replyToMsgId || null });
      }
      offsetId = msgs.at(-1).id;
    }
    return out.reverse();
  });
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
// Erro ao enviar o pagamento: 'paid' (a fatura tem recibo = o CounterFlame registrou e entrega), 'safe' (sem recibo,
// recusa explícita 4xx que não é de duplicidade e nada indica cobrança = pode tentar de novo) ou 'incerto' (a
// conferência de 2 min decide). cobranca: true (histórico/saldo mostram cobrança), false, 'outro' ou null (sem leitura).
// Cobrança SEM recibo não é entrega (FORM_SUBMIT_DUPLICATE, 17/11/2026): fica 'incerto'.
export function decideAfterSendError(e, paid, cobranca = null) {
  if (paid === true) return 'paid';
  const msg = String(e?.errorMessage || '');
  if (cobranca === true || cobranca === 'outro') return 'incerto';
  if (paid === false && msg && e.code >= 400 && e.code < 500 && !/DUPLICATE/i.test(msg)) return 'safe';
  return 'incerto';
}
