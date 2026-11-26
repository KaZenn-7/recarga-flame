// Página de manutenção da loja (ligada/desligada no painel). Quem abre o link do pedido (#pedido= / #carrinho=) vê a
// situação do próprio pedido, para não ficar preocupado. HTML/JS inline (hash do script vai para a CSP no server.js).
export const MANUTENCAO_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0e0e10">
<meta name="robots" content="noindex"><title>Em manutenção — Recarga Flame</title><link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png"><link rel="icon" type="image/png" sizes="192x192" href="/img/icon-192.png"><link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<style>
:root{--bg:#0e0e10;--panel:#161618;--line:#2a2a2e;--txt:#f4f4f5;--mut:#9b9ba3;--orange:#ff5a1f;--green:#3fb950;--gold:#e3b341}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--txt);font:15px/1.55 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;padding:16px}
.box{width:100%;max-width:440px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px 22px;text-align:center}
.mark{width:48px;height:48px;border-radius:11px;display:block;margin:0 auto 16px}
h1{font-size:21px;margin:0 0 8px}p{margin:0 0 14px;color:var(--mut)}
ul{list-style:none;padding:0;margin:18px 0;text-align:left;display:grid;gap:10px}
li{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:11px 13px;font-size:14px;color:var(--txt)}
li b{display:block;margin-bottom:2px}li span{color:var(--mut);font-size:13.5px}
.ped{margin:18px 0 6px;padding:13px;border-radius:10px;border:1px solid rgba(63,185,80,.4);background:rgba(63,185,80,.1);font-size:14px;text-align:left}
.ped.esp{border-color:rgba(227,179,65,.4);background:rgba(227,179,65,.1)}.hide{display:none}
a{color:var(--orange);font-weight:600;text-decoration:none}.foot{font-size:13px;margin:18px 0 0}
.av{margin:20px 0 4px;padding:16px 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);text-align:left}
.av b{display:block;font-size:15px;margin-bottom:4px}.av p{font-size:13px;margin:0 0 12px}
.av form{display:flex;gap:8px}.av input{flex:1;min-width:0;padding:12px;border:1px solid var(--line);background:var(--panel);color:var(--txt);border-radius:9px;font:inherit}
.av input:focus{outline:0;border-color:#45454c}.av button{padding:12px 16px;border:0;border-radius:9px;background:var(--orange);color:#160a04;font:inherit;font-weight:700;cursor:pointer;white-space:nowrap}
.av button:disabled{opacity:.55}.av .msg{font-size:13px;margin:10px 0 0;min-height:0}.av .ok{color:var(--green)}.av .er{color:#f85149}
</style></head><body><main class="box"><img class="mark" src="/img/brand-mark.png" alt="" width="48" height="48">
<h1>Estamos em manutenção 🛠️</h1>
<p>A Recarga Flame está passando por uma manutenção rápida para ficar ainda melhor. Voltamos em breve!</p>
<div id="ped" class="ped hide" role="status"></div>
<ul>
<li><b>✅ Seu pedido está garantido</b><span>Se você já pagou, fique tranquilo: todo pedido pago será entregue assim que a manutenção terminar. Não precisa fazer nada.</span></li>
<li><b>🚫 Não pague de novo</b><span>Se o Pix já foi pago, não pague outra vez: isso não acelera a entrega.</span></li>
<li><b>🎮 Não mexa nas coins do jogo</b><span>Enquanto o item não chegar, evite comprar ou vender skins, para a entrega cair certinho na sua conta.</span></li>
</ul>
<section class="av" id="av"><b>📩 Quer saber quando voltarmos?</b><p>Deixe seu e-mail e avisamos assim que a loja reabrir. É um aviso único, e o e-mail é apagado depois.</p>
<form id="avf"><input id="ave" type="email" inputmode="email" autocomplete="email" placeholder="seu@email.com" maxlength="120" required aria-label="Seu e-mail"><button id="avb">Avisar-me</button></form>
<div class="msg" id="avm" role="status"></div></section>
<p class="foot">Dúvidas? <a href="/suporte">Fale com o suporte</a></p>
</main>
<script>
(function(){
  var f=document.getElementById('avf'),e=document.getElementById('ave'),b=document.getElementById('avb'),msg=document.getElementById('avm');
  f.addEventListener('submit',function(ev){
    ev.preventDefault();b.disabled=true;msg.className='msg';msg.textContent='Enviando…';
    fetch('/api/avisar-volta',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e.value.trim()})})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,j:j};});})
      .then(function(x){
        if(x.ok){f.style.display='none';msg.className='msg ok';msg.textContent='✅ Pronto! Vamos te avisar em '+e.value.trim()+' quando a loja voltar.';}
        else{b.disabled=false;msg.className='msg er';msg.textContent=(x.j&&x.j.error)||'Não deu certo. Tente de novo.';}
      }).catch(function(){b.disabled=false;msg.className='msg er';msg.textContent='Sem conexão. Tente de novo.';});
  });
})();
(function(){
  var m=/^#(pedido|carrinho)=([A-Za-z0-9_-]{8,80})$/.exec(location.hash||'');if(!m)return;
  var box=document.getElementById('ped');
  fetch('/api/'+(m[1]==='carrinho'?'carrinho/':'orders/')+m[2]).then(function(r){return r.ok?r.json():null;}).then(function(o){
    if(!o)return;
    var st=o.status,n=o.id?'Pedido #'+o.id:'Seu pedido',t;
    if(st==='delivered')t='✅ '+n+': entregue! Entre de novo no jogo para ver.';
    else if(st==='paid')t='💚 '+n+': pagamento confirmado. Será entregue assim que a manutenção terminar.';
    else if(st==='pending'){t='⏳ '+n+': ainda não recebemos o Pix. Se você já pagou, a confirmação chega sozinha e o item será entregue.';box.className='ped esp';}
    else return;
    box.textContent=t;box.classList.remove('hide');
  }).catch(function(){});
})();
</script></body></html>`;
