import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, MIGRATIONS } from '../src/db.js';

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

test('migrações: banco novo recebe o esquema completo e a versão final', () => {
  const db = new Database(':memory:');
  assert.equal(migrate(db, { starCost: 0.1 }), MIGRATIONS.at(-1).v);
  for (const t of ['orders', 'products', 'coupons', 'coupon_payouts', 'coupon_log', 'stars_ledger', 'stars_purchases', 'settings', 'blocked', 'partner_months', 'admin_sessions', 'events', 'support_tickets']) {
    assert.ok(tables(db).includes(t), t);
  }
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  for (const c of ['star_cost', 'refund_at', 'remind_at', 'autopay']) assert.ok(cols.includes(c), c);
});

test('migrações: rodar de novo não faz nada; versões já aplicadas são puladas', () => {
  const db = new Database(':memory:');
  migrate(db, { starCost: 0.1 });
  let ran = 0;
  const v = migrate(db, { starCost: 0.1 }, [...MIGRATIONS, { v: MIGRATIONS.length + 1, nome: 'x', up() { ran++; } }]);
  assert.equal(v, MIGRATIONS.length + 1);
  migrate(db, { starCost: 0.1 }, [...MIGRATIONS, { v: MIGRATIONS.length + 1, nome: 'x', up() { ran++; } }]);
  assert.equal(ran, 1);
});

test('migrações: falha no meio desfaz tudo da migração e não avança a versão', () => {
  const db = new Database(':memory:');
  migrate(db, { starCost: 0.1 });
  const v0 = db.pragma('user_version', { simple: true });
  const bad = { v: v0 + 1, nome: 'ruim', up(d) { d.exec('CREATE TABLE tmp_x (a)'); throw new Error('falhou'); } };
  assert.throws(() => migrate(db, {}, [...MIGRATIONS, bad]), /falhou/);
  assert.equal(db.pragma('user_version', { simple: true }), v0);
  assert.ok(!tables(db).includes('tmp_x'));
});

test('migração base em banco antigo: recargas viram compras, custo e ptoken preenchidos', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, product TEXT NOT NULL, cents INTEGER NOT NULL, game_id TEXT NOT NULL, nickname TEXT NOT NULL, email TEXT NOT NULL, mp_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, paid_at TEXT, delivered_at TEXT)");
  db.exec("INSERT INTO orders (token, product, cents, game_id, nickname, email) VALUES ('t','c1',100,'1','n','e@x')");
  db.exec("CREATE TABLE stars_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, delta INTEGER NOT NULL, cents INTEGER, order_id INTEGER UNIQUE, nota TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  db.exec("INSERT INTO stars_ledger (kind, delta, cents) VALUES ('recarga', 1000, 9000), ('ajuste', 5, NULL)");
  db.exec("CREATE TABLE coupons (code TEXT PRIMARY KEY, desconto_pct REAL NOT NULL DEFAULT 0, comissao_pct REAL NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1, nota TEXT DEFAULT '', created_at TEXT)");
  db.exec("INSERT INTO coupons (code) VALUES ('ABC')");
  migrate(db, { starCost: 0.0875 });
  assert.equal(db.prepare('SELECT star_cost FROM orders').get().star_cost, 0.0875);
  assert.deepEqual(db.prepare('SELECT stars, cents FROM stars_purchases').all(), [{ stars: 1000, cents: 9000 }]);
  assert.deepEqual(db.prepare('SELECT kind FROM stars_ledger').all(), [{ kind: 'ajuste' }]);
  const c = db.prepare('SELECT plano, ptoken FROM coupons').get();
  assert.equal(c.plano, 'metas'); assert.match(c.ptoken, /^[A-Za-z0-9_-]{24}$/);
});

test('migração 5: índices das consultas de pedido/visita (e o antifraude usa o índice)', () => {
  const db = new Database(':memory:');
  migrate(db, { starCost: 0.1 });
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
  for (const i of ['orders_game', 'orders_email', 'orders_status', 'orders_coupon', 'events_dev']) assert.ok(idx.includes(i), i);
  const plano = (sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');
  assert.match(plano("SELECT * FROM orders WHERE game_id='1'"), /orders_game/);
  assert.match(plano("SELECT * FROM orders WHERE lower(email)='a@b.c'"), /orders_email/);
  assert.match(plano("SELECT src FROM events WHERE dev='x' AND ev='visit'"), /events_dev/);
});
