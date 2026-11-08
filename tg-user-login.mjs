// Login da conta de usuário SEPARADA da operação (rodar no seu terminal SSH, não no chat):
//   cd ~/cf-teste-deploy && node tg-user-login.mjs
// Pede telefone, código do Telegram e a senha da verificação em 2 etapas; salva a sessão em
// .tg_user_session (0600). Nada é impresso além do nome da conta e do saldo de Stars.
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { makeClient, SESSION_FILE, starsToInt } from './tg-user.js';

const apiId = Number(process.env.TG_API_ID);
const apiHash = String(process.env.TG_API_HASH || '');
if (!apiId || !/^[0-9a-f]{32}$/.test(apiHash)) {
  console.error('Faltam TG_API_ID e TG_API_HASH no .env (crie em https://my.telegram.org → API development tools, logado na conta SEPARADA).');
  process.exit(1);
}
const rl = readline.createInterface({ input: stdin, output: stdout });
if (fs.existsSync(SESSION_FILE)) {
  const a = (await rl.question('Já existe uma sessão salva. Substituir? (s/N) ')).trim().toLowerCase();
  if (a !== 's') { rl.close(); process.exit(0); }
}
// senha sem eco no terminal
async function askHidden(q) {
  stdout.write(q);
  const old = rl._writeToOutput;
  rl._writeToOutput = () => {};
  const v = await rl.question('');
  rl._writeToOutput = old;
  stdout.write('\n');
  return v;
}
const { Api } = await import('telegram');
const client = await makeClient(apiId, apiHash, '');
await client.start({
  phoneNumber: async () => (await rl.question('Telefone da conta SEPARADA (com +55): ')).trim(),
  phoneCode: async () => (await rl.question('Código que chegou no Telegram: ')).trim(),
  password: async () => askHidden('Senha da verificação em 2 etapas: '),
  onError: (e) => console.error('Erro:', e.message),
});
const me = await client.getMe();
const st = await client.invoke(new Api.payments.GetStarsStatus({ peer: new Api.InputPeerSelf() }));
console.log(`\nLogado como ${me.firstName || ''}${me.username ? ' (@' + me.username + ')' : ''} · saldo ${starsToInt(st.balance)}★`);
const ok = (await rl.question('É a conta SEPARADA da operação (não a pessoal)? Salvar sessão? (s/N) ')).trim().toLowerCase();
if (ok === 's') {
  fs.writeFileSync(SESSION_FILE, client.session.save(), { mode: 0o600 });
  fs.chmodSync(SESSION_FILE, 0o600);
  console.log('Sessão salva. Reinicie a loja: pm2 restart cf-teste');
} else {
  await client.invoke(new Api.auth.LogOut());
  console.log('Nada salvo; sessão encerrada no Telegram.');
}
rl.close();
await client.disconnect();
process.exit(0);
