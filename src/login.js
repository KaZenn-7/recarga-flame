// Login do painel: senha + código de 6 dígitos pelo Telegram + sessão (cookie cf_sess, tabela admin_sessions),
// anti-brute-force por IP e o middleware admin que protege o painel e a API /api/admin.
import crypto from 'node:crypto';
import { tgSend } from './telegram.js';
import { LOGIN_HTML } from '../views/login.js';

export function initLogin({ env, db, safeEq, limit, guard }) {
// Anti-brute-force no admin: janela deslizante por IP, conta só FALHAS.
// Login correto sempre passa (não é bloqueado nem conta), então o operador
// nunca fica trancado fora mesmo que um atacante martele o mesmo IP.
const ADMIN_MAX_FAILS = 20;
const ADMIN_WINDOW = 15 * 60_000;
const adminFails = new Map(); // ip -> [timestamps de falha]
function tooManyFails(ip) {
  const now = Date.now();
  const arr = (adminFails.get(ip) || []).filter((t) => now - t < ADMIN_WINDOW);
  adminFails.set(ip, arr);
  return arr.length >= ADMIN_MAX_FAILS;
}
function noteFail(ip) {
  const arr = adminFails.get(ip) || [];
  arr.push(Date.now());
  adminFails.set(ip, arr);
}
// limpeza periódica pra não vazar memória
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of adminFails) {
    const keep = arr.filter((t) => now - t < ADMIN_WINDOW);
    if (keep.length) adminFails.set(ip, keep); else adminFails.delete(ip);
  }
}, ADMIN_WINDOW).unref();

// ---------- Login do painel: senha + código pelo Telegram + sessão ----------
// Sessão deslizante: vale 30 dias sem uso e renova sozinha a cada uso (no máx. 1×/h),
// com teto de 90 dias desde o login — depois disso, senha + código de novo.
const SESSION_TTL = 30 * 86400_000;
const SESSION_MAX = 90 * 86400_000;
const SESSION_RENEW = 3600_000;
const CODE_TTL = 5 * 60_000;       // código vale 5 min
const CODE_MAX_TRIES = 5;          // por desafio
const COOKIE = 'cf_sess';
const hashHex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const challenges = new Map(); // id -> { codeHash, exp, tries, ip }
// aparelho em poucas palavras, a partir do User-Agent (ex.: "iPhone · Chrome")
function uaCurto(ua) {
  ua = String(ua || '');
  const so = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'aparelho desconhecido';
  const nav = /EdgA?\/|Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : '';
  return nav ? `${so} · ${nav}` : so;
}

function getCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function sessionOk(req) {
  const tok = getCookie(req, COOKIE);
  if (!tok || !/^[A-Za-z0-9_-]{43}$/.test(tok)) return false;
  const row = db.prepare('SELECT created_at, expires_at FROM admin_sessions WHERE id_hash=?').get(hashHex(tok));
  if (!row || row.expires_at <= Date.now()) return false;
  return { tok, ...row };
}
// Renova a sessão em uso (prazo e cookie), sem passar do teto desde o login.
function renewSession(s, res) {
  const now = Date.now();
  const exp = Math.min(now + SESSION_TTL, s.created_at + SESSION_MAX);
  if (exp - s.expires_at < SESSION_RENEW) return;
  db.prepare('UPDATE admin_sessions SET expires_at=? WHERE id_hash=?').run(exp, hashHex(s.tok));
  res.append('Set-Cookie', `${COOKIE}=${s.tok}; Max-Age=${Math.floor((exp - now) / 1000)}; ${cookieAttrs()}`);
}
// Lax, não Strict: no iPhone (Safari e Chrome, ambos WebKit) o cookie Strict não vai ao recarregar ou abrir /painel pela
// barra/aba, e o operador caía no login a cada F5. Lax segue sem mandar o cookie em POST/fetch de outro site (as ações do
// painel ainda exigem mesma origem ou x-painel) e as rotas GET do admin só leem.
const cookieAttrs = () => `Path=/; HttpOnly; SameSite=Lax${env.NODE_ENV === 'test' ? '' : '; Secure'}`;

setInterval(() => {
  const now = Date.now();
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now);
  for (const [id, c] of challenges) if (c.exp < now) challenges.delete(id);
}, 10 * 60_000).unref();

function admin(req, res, next) {
  const s = sessionOk(req);
  if (s) { renewSession(s, res); return next(); }
  // página do painel: manda pro login; API: 401
  if (req.method === 'GET' && req.path === '/painel') return res.redirect(302, '/login');
  res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
}

  // rotas /login, /login/senha, /login/codigo e /logout (registradas no ponto original do server.js)
  function rotasLogin(app) {
  // Passo 1: senha. Correta → manda código pelo Telegram e devolve um desafio.
  // Senha correta sempre passa (operador nunca fica trancado fora); erradas contam no anti-brute-force.
  app.post('/login/senha', limit(30), async (req, res) => {
    const ip = req.ip;
    const { user, pass } = req.body ?? {};
    const ok = safeEq(String(user ?? ''), env.ADMIN_USER) & safeEq(String(pass ?? ''), env.ADMIN_PASS);
    if (!ok) {
      if (tooManyFails(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
      noteFail(ip);
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const id = crypto.randomBytes(24).toString('base64url');
    challenges.set(id, { codeHash: hashHex(code), exp: Date.now() + CODE_TTL, tries: 0, ip });
    const sent = await tgSend(`🔐 Código de acesso ao painel: ${code}\nVale 5 minutos. IP: ${ip} · ${uaCurto(req.get('user-agent'))}\nSe não foi você, troque a senha do admin.`, 'privado'); // nunca no grupo
    if (!sent) { challenges.delete(id); return res.status(502).json({ error: 'Não foi possível enviar o código pelo Telegram.' }); }
    res.json({ challenge: id });
  });

  // Passo 2: código. Certo → cria sessão (cookie HttpOnly/Secure/SameSite=Lax, 30 dias renováveis, teto 90).
  app.post('/login/codigo', limit(30), (req, res) => {
    const ip = req.ip;
    const { challenge, code } = req.body ?? {};
    const c = typeof challenge === 'string' ? challenges.get(challenge) : null;
    if (!c || c.exp < Date.now()) {
      if (c) challenges.delete(challenge);
      return res.status(401).json({ error: 'Código expirado. Entre com a senha de novo.', restart: true });
    }
    const given = String(code ?? '').trim();
    if (/^\d{6}$/.test(given) && safeEq(hashHex(given), c.codeHash)) {
      challenges.delete(challenge); // uso único
      const tok = crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO admin_sessions (id_hash, created_at, expires_at, ip, ua) VALUES (?,?,?,?,?)')
        .run(hashHex(tok), Date.now(), Date.now() + SESSION_TTL, ip, String(req.get('user-agent') || '').slice(0, 200));
      res.set('Set-Cookie', `${COOKIE}=${tok}; Max-Age=${SESSION_TTL / 1000}; ${cookieAttrs()}`);
      return res.json({ ok: true });
    }
    noteFail(ip);
    if (++c.tries >= CODE_MAX_TRIES) {
      challenges.delete(challenge);
      return res.status(401).json({ error: 'Código incorreto várias vezes. Entre com a senha de novo.', restart: true });
    }
    res.status(401).json({ error: `Código incorreto. Restam ${CODE_MAX_TRIES - c.tries} tentativas.` });
  });

  app.post('/logout', (req, res) => {
    const tok = getCookie(req, COOKIE);
    if (tok) db.prepare('DELETE FROM admin_sessions WHERE id_hash=?').run(hashHex(tok));
    res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieAttrs()}`);
    res.json({ ok: true });
  });

  // Sessões ativas (celular perdido, login que não foi você): lista e encerra. O id exposto é o começo do hash do token.
  const sid = (h) => h.slice(0, 16);
  app.get('/api/admin/sessoes', admin, (req, res) => {
    const atual = hashHex(getCookie(req, COOKIE) || '');
    res.json(db.prepare('SELECT id_hash, created_at, expires_at, ip, ua FROM admin_sessions WHERE expires_at > ? ORDER BY created_at DESC').all(Date.now())
      .map((s) => ({ id: sid(s.id_hash), desde: s.created_at, ate: s.expires_at, ip: s.ip, aparelho: uaCurto(s.ua), atual: s.id_hash === atual })));
  });
  app.post('/api/admin/sessoes/encerrar', admin, (req, res) => {
    if (!guard(req, res)) return;
    const atual = hashHex(getCookie(req, COOKIE) || '');
    const { id, outras } = req.body ?? {};
    let n = 0;
    if (outras) n = db.prepare('DELETE FROM admin_sessions WHERE id_hash <> ?').run(atual).changes;
    else if (typeof id === 'string' && /^[0-9a-f]{16}$/.test(id)) {
      if (id === sid(atual)) return res.status(400).json({ error: 'Para sair desta sessão, use "Sair".' });
      n = db.prepare("DELETE FROM admin_sessions WHERE substr(id_hash, 1, 16) = ?").run(id).changes;
    } else return res.status(400).json({ error: 'Sessão inválida.' });
    res.json({ ok: true, encerradas: n });
  });

  app.get('/login', (req, res) => {
    if (sessionOk(req)) return res.redirect(302, '/painel');
    res.send(LOGIN_HTML);
  });
  }

  return { admin, getCookie, adminFails, challenges, rotasLogin };
}
