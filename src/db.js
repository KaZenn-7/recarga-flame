// Banco (SQLite): migrações numeradas. A versão aplicada fica em PRAGMA user_version.
// Cada migração roda UMA vez, numa transação (se falhar, nada dela fica e a loja não sobe).
// Mudar o banco = acrescentar uma nova entrada NO FIM com v = última + 1. Nunca editar nem reordenar uma
// migração que já foi aplicada em produção.
//
// A migração 1 ("base") é o esquema que a loja criava a cada inicialização até 10/11/2026 (CREATE IF NOT EXISTS,
// colunas novas e ajustes de dados antigos), na mesma ordem. Tudo nela é idempotente: no banco de produção (que já
// tinha tudo) não muda nada além de marcar a versão 1; num banco novo cria tudo.
import crypto from 'node:crypto';

const hasCol = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
const addCols = (db, t, cols) => {
  for (const col of cols) if (!hasCol(db, t, col.split(' ')[0])) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`);
};

export const MIGRATIONS = [
  { v: 1, nome: 'base', up(db, { starCost }) {
    // ---- pedidos ----
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
    // snapshot do produto no momento da compra (sobrevive a edição/exclusão do produto)
    addCols(db, 'orders', ['prod_nome TEXT', 'prod_stars INTEGER', 'prod_code TEXT', 'qr TEXT', 'qr_b64 TEXT', 'expires_at INTEGER']);
    // ---- produtos (o catálogo inicial é semeado pelo server.js se a tabela estiver vazia) ----
    db.exec(`CREATE TABLE IF NOT EXISTS products (
  key TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  cents INTEGER NOT NULL,
  stars INTEGER NOT NULL DEFAULT 0,
  code TEXT NOT NULL,
  tipo TEXT DEFAULT '',
  niveis INTEGER DEFAULT 0,
  img TEXT DEFAULT '',
  ativo INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
)`);
    // ---- cupons ----
    addCols(db, 'orders', ['coupon TEXT', 'list_cents INTEGER', 'discount_cents INTEGER DEFAULT 0', 'com_pct REAL']);
    db.exec(`CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  desconto_pct REAL NOT NULL DEFAULT 0,
  comissao_pct REAL NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1,
  nota TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
    // % de comissão fica gravado no pedido: editar o cupom depois não muda o que já foi ganho.
    db.exec(`UPDATE orders SET com_pct = (SELECT comissao_pct FROM coupons WHERE code = orders.coupon)
  WHERE coupon IS NOT NULL AND com_pct IS NULL`);
    // pagamentos de comissão feitos ao dono do cupom (saldo = comissão ganha − pagos)
    db.exec(`CREATE TABLE IF NOT EXISTS coupon_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  cents INTEGER NOT NULL,
  nota TEXT DEFAULT '',
  paid_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
    addCols(db, 'coupon_payouts', ['ref_mes TEXT']); // mês que o pagamento cobre (AAAA-MM)
    // registro de alterações de cupons, faixas e pagamentos (code '*' = faixas padrão). Nunca guarda Pix nem e-mail.
    db.exec('CREATE TABLE IF NOT EXISTS coupon_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT CURRENT_TIMESTAMP, code TEXT NOT NULL, acao TEXT NOT NULL)');
    // ---- Stars: livro-caixa do saldo e compras (só custo) ----
    db.exec(`CREATE TABLE IF NOT EXISTS stars_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- ajuste | entrega  (legado: recarga, migrada p/ stars_purchases)
  delta INTEGER NOT NULL,        -- + entra, − sai
  cents INTEGER,                 -- legado
  order_id INTEGER UNIQUE,       -- entrega: 1 desconto por pedido
  nota TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
    db.exec(`CREATE TABLE IF NOT EXISTS stars_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, stars INTEGER NOT NULL, cents INTEGER NOT NULL, nota TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
    // "recargas" antigas do livro-caixa viram compras e saem do saldo (o alinhamento com o Telegram corrige)
    for (const r of db.prepare("SELECT * FROM stars_ledger WHERE kind='recarga'").all()) {
      if (r.cents > 0 && r.delta > 0) db.prepare('INSERT INTO stars_purchases (stars, cents, nota, created_at) VALUES (?,?,?,?)').run(r.delta, r.cents, r.nota || '', r.created_at);
      db.prepare('DELETE FROM stars_ledger WHERE id=?').run(r.id);
    }
    // ---- autopay / configurações ----
    db.exec('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)');
    // ---- antifraude ----
    db.exec(`CREATE TABLE IF NOT EXISTS blocked (
  kind TEXT NOT NULL, value TEXT NOT NULL, reason TEXT DEFAULT '', order_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (kind, value)
)`);
    addCols(db, 'orders', ['device TEXT', 'ip_h TEXT', 'payer_doc TEXT', 'payer_acct TEXT', 'tg_msg INTEGER', 'chk TEXT', 'autopay TEXT', 'autopay_info TEXT', 'autopay_at INTEGER', 'star_cost REAL', 'approved_at INTEGER', 'entrega_via TEXT', 'manual_motivo TEXT', 'refund_state TEXT', 'refund_info TEXT', 'refund_at INTEGER']);
    // pedidos antigos (antes do custo automático) ficam com o custo padrão da época
    db.prepare('UPDATE orders SET star_cost=? WHERE star_cost IS NULL').run(starCost);
    // ---- parceiros (plano de metas, dados do parceiro, link privado) ----
    addCols(db, 'coupons', ["plano TEXT DEFAULT 'metas'", 'ids_proprios TEXT', 'ptoken TEXT', 'tiers TEXT', // tiers: faixas próprias (JSON) ou NULL = padrão
      'parceiro_nome TEXT', 'parceiro_canal TEXT', 'parceiro_pix TEXT', 'parceiro_email TEXT']);
    db.exec("UPDATE coupons SET plano='metas' WHERE plano IS NULL");
    for (const c of db.prepare('SELECT code FROM coupons WHERE ptoken IS NULL').all()) {
      db.prepare('UPDATE coupons SET ptoken=? WHERE code=?').run(crypto.randomBytes(18).toString('base64url'), c.code);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS partner_months (
  code TEXT NOT NULL, mes TEXT NOT NULL, ating INTEGER NOT NULL, idx INTEGER NOT NULL, pct REAL NOT NULL,
  PRIMARY KEY (code, mes)
)`);
    // ---- lembretes de Pix ----
    addCols(db, 'orders', ['remind_at INTEGER', 'expired_mail INTEGER']);
    // ---- login do painel ----
    db.exec(`CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, ua TEXT
)`);
    // ---- analytics ----
    db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT CURRENT_TIMESTAMP,
  dev TEXT NOT NULL, ev TEXT NOT NULL, coupon TEXT, src TEXT, order_id INTEGER
)`);
    db.exec('CREATE INDEX IF NOT EXISTS events_ts ON events(ts)');
    // ---- suporte ----
    db.exec(`CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  email TEXT, assunto TEXT, msg TEXT, order_id INTEGER, game_id TEXT, ip_h TEXT, mail_ok INTEGER, tg_ok INTEGER
)`);
  } },
];

// Aplica as migrações pendentes, em ordem. Devolve a versão final.
export function migrate(db, ctx = {}, list = MIGRATIONS) {
  const cur = db.pragma('user_version', { simple: true });
  const max = list.at(-1)?.v ?? 0;
  if (cur > max) console.error(`Banco na versão ${cur}, mas este código só conhece até ${max} (código mais antigo que o banco?)`);
  for (const m of list) {
    if (m.v <= cur) continue;
    db.transaction(() => { m.up(db, ctx); db.pragma(`user_version = ${Number(m.v)}`); })();
    console.log(`Banco: migração ${m.v} (${m.nome}) aplicada`);
  }
  return db.pragma('user_version', { simple: true });
}
