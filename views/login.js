// Página de login do painel (senha → código pelo Telegram). HTML/JS inline.
export const LOGIN_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0e0e10">
<meta name="robots" content="noindex"><title>Entrar — Painel Recarga Flame</title><link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png"><link rel="icon" type="image/png" sizes="192x192" href="/img/icon-192.png"><link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<style>
:root{--bg:#0e0e10;--panel:#161618;--line:#2a2a2e;--txt:#f4f4f5;--mut:#9b9ba3;--orange:#ff5a1f;--red:#f85149}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--txt);font:15px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;padding:16px}
.box{width:100%;max-width:360px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px 20px}
.mark{width:40px;height:40px;border-radius:9px;display:block;margin-bottom:14px}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 18px;color:var(--mut);font-size:13.5px}
label{display:block;font-size:12.5px;color:var(--mut);margin:12px 0 5px}
input{width:100%;padding:12px;border:1px solid var(--line);background:var(--bg);color:var(--txt);border-radius:9px;font:inherit}
input:focus{outline:0;border-color:#45454c}#code{font-size:24px;letter-spacing:.4em;text-align:center;font-family:ui-monospace,Menlo,monospace}
button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:9px;background:var(--orange);color:#160a04;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.5}.link{background:transparent;color:var(--mut);margin-top:8px;font-weight:600}
.err{color:var(--red);font-size:13px;min-height:18px;margin:12px 0 0;text-align:center}.hide{display:none}
</style></head><body><div class="box"><img class="mark" src="/img/brand-mark.png" alt="" width="40" height="40">
<form id="f1"><h1>Painel</h1><p>Entre com usuário e senha.</p>
<label for="user">Usuário</label><input id="user" autocomplete="username" required>
<label for="pass">Senha</label><input id="pass" type="password" autocomplete="current-password" required>
<button id="b1">Continuar</button></form>
<form id="f2" class="hide"><h1>Código de acesso</h1><p>Enviamos um código de 6 dígitos pelo Telegram. Ele vale 5 minutos.</p>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
<button id="b2">Entrar</button><button type="button" class="link" id="again">Voltar e reenviar</button></form>
<p class="err" id="err"></p></div>
<script>
const $=id=>document.getElementById(id);let ch=null;
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});let j={};try{j=await r.json();}catch{}return{ok:r.ok,j};}
function step(n){$('f1').classList.toggle('hide',n!==1);$('f2').classList.toggle('hide',n!==2);(n===1?$('pass'):$('code')).focus();}
$('f1').onsubmit=async e=>{e.preventDefault();$('err').textContent='';$('b1').disabled=true;
  const{ok,j}=await post('/login/senha',{user:$('user').value,pass:$('pass').value});$('b1').disabled=false;
  if(!ok){$('err').textContent=j.error||'Erro.';return;}ch=j.challenge;$('code').value='';step(2);};
$('f2').onsubmit=async e=>{e.preventDefault();$('err').textContent='';$('b2').disabled=true;
  const{ok,j}=await post('/login/codigo',{challenge:ch,code:$('code').value});$('b2').disabled=false;
  if(ok){location.href='/painel';return;}$('err').textContent=j.error||'Erro.';if(j.restart){$('pass').value='';step(1);}};
$('again').onclick=()=>{$('err').textContent='';step(1);};
</script></body></html>`;
