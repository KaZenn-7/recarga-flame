// JS do painel do operador (servido só com sessão, em /painel/app.js). Arquivo JS comum: pode usar crase e ${}.
// ORDERS (pedidos iniciais) vem num <script> inline do views/painel.js.
let STARS=null;const NOST=new Set();
const CATS={'':'Coins',wildfire:'Coleções',arsenal:'Passes',gold:'Passes'};
const LABEL={pending:'Pendentes',paid:'Na fila',delivered:'Entregues',cancelled:'Cancelados',reversed:'Estornados'};
const BADGE={pending:'Pendente',paid:'Pago',delivered:'Entregue',cancelled:'Cancelado',reversed:'Estornado'};
const TABS=['paid','pending','delivered','cancelled','reversed'];
const brl=c=>(c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let cur=location.hash.slice(1)||'paid',q='';
if(!TABS.includes(cur))cur='paid';

function count(s){return ORDERS.filter(o=>o.status===s).length}
function renderTabs(){
  document.getElementById('tabs').innerHTML=TABS.filter(s=>s!=='reversed'||count(s)).map(s=>
    `<button class="tab ${s===cur?'on':''}" data-s="${s}">${LABEL[s]}<span class="c">${count(s)}</span></button>`).join('');
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{cur=b.dataset.s;location.hash=cur;render();});
}
function card(o){
  const tl=[];
  if(o.created)tl.push('Criado '+o.created);
  if(o.paid)tl.push('Pago '+o.paid);
  if(o.delivered)tl.push('Entregue '+o.delivered);
  let acts='';
  if(o.status==='paid'){
    acts=`<div class="acts">${o.tg?`<a class="a-tg" href="${esc(o.tg)}" target="_blank" rel="noopener" onclick="backFrom=${o.id}">Abrir no Telegram · ${o.stars}★</a>`:''}
      <button class="a-ok" onclick="deliver(${o.id})">Marcar entregue</button></div>`;
  }
  if(o.status==='paid'&&o.canPay&&o.canPay.ok)acts=acts.replace('<div class="acts">','<div class="acts"><button class="a-pay" onclick="payNow('+o.id+',this)">⭐ Pagar '+o.stars+'★</button>');
  else if(o.status==='paid'&&o.canApprove)acts=acts.replace('<div class="acts">','<div class="acts"><button class="a-pay" onclick="approveNow('+o.id+',this)">✅ Aprovar e pagar</button>');
  const apb=o.status!=='paid'?(o.ap==='incerto'?'<div class="chk">Pagamento automático ficou incerto — resolvido manualmente.</div>':''):
    o.ap==='incerto'?'<div class="chk diverge">🚨 Pagamento incerto: '+esc((o.apInfo&&o.apInfo.erro)||'')+'. <button class="rechk" onclick="verifyPay('+o.id+',this)">🔍 verificar cobrança</button></div>':
    o.ap==='paying'?'<div class="chk wait">⏳ Pagando no bot…</div>':
    o.ap==='erro'?'<div class="chk erro">Pagamento não feito: '+esc((o.apInfo&&o.apInfo.erro)||'')+' — pague de novo ou entregue na mão e toque em Marcar entregue.</div>':
    o.ap==='sent'?'<div class="chk ok">⭐ Pago no bot ('+((o.apInfo&&o.apInfo.stars)||'')+'★)'+(o.apInfo&&o.apInfo.botReply?' · '+esc(o.apInfo.botReply):'')+'</div>':'';
  if(o.blocked)acts='<div class="acts"><span class="blk">🚫 Cliente bloqueado</span><button class="a-unb" onclick="unblock('+o.id+')">Desbloquear</button></div>';
  // reembolso: pago e não entregue
  const rf=o.refund==='done'?'<div class="chk ok">💸 Reembolsado ('+brl(o.cents)+') pelo Mercado Pago</div>':
    o.refund==='erro'?'<div class="chk erro">Reembolso não concluído — pode tentar de novo (não devolve em dobro).</div>':
    o.status==='cancelled'&&o.refundable?'<div class="chk diverge">💸 Pago e não entregue: o cliente deve ser reembolsado.</div>':'';
  if(o.refundable&&o.status==='paid')acts+='<div class="refrow"><button class="lnk" onclick="refundNow('+o.id+',this)">cancelar e reembolsar</button></div>';
  else if(o.refundable)acts=(acts||'<div class="acts"></div>').replace('</div>','<button class="a-ref" onclick="refundNow('+o.id+',this)">💸 Reembolsar '+brl(o.cents)+'</button></div>');
  const ck=o.chk;
  const chk=o.status!=='paid'||!o.chkOn?'':'<div class="chk '+(ck?ck.status:'wait')+'">'+(
    !ck?'🔎 Conferindo no bot do CF…':
    ck.status==='ok'?'🔎 Conferido no bot: <b>'+ck.stars+'★</b> · '+esc(ck.account)+' · '+esc(ck.produto||'')+' ✅':
    ck.status==='diverge'?'❌ Conferência não bateu: '+esc(ck.motivo):
    '⚠ Conferência falhou: '+esc(ck.motivo))+
    ' <button class="rechk" onclick="recheck('+o.id+',this)">conferir de novo</button></div>';
  const risk=(o.risk&&o.risk.length)?'<div class="risk"><b>⚠ Revisar antes de entregar</b>'+o.risk.map(function(r){return '<span>· '+esc(r)+'</span>';}).join('')+'</div>':'';
  return `<div class="card${NEWS.has(o.id)?' new':''}">
    <div class="chead"><span class="bdg ${o.status}">${BADGE[o.status]}</span>${NEWS.has(o.id)?'<span class="newtag">NOVO</span>':''}${waitTag(o)}${NOST.has(o.id)?'<span class="nost">SEM STARS</span>':''}<span class="oid">#${o.id}</span></div>
    <div class="body">
      <img class="av" src="/api/player/${esc(o.gameId)}/avatar" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="info">
        <div class="pn">${esc(o.nome)}${o.cup?'<span class="cuptag">'+esc(o.cup)+'</span>':''}</div>
        <div class="nk">${esc(o.nick)}</div>
        <div class="meta">ID <b class="mono">${esc(o.gameId)}</b> · ${esc(o.email)}</div>
      </div>
      <div class="price"><div class="v mono">${brl(o.cents)}</div><div class="s">${o.stars}★ Stars</div></div>
    </div>
    ${tl.length?`<div class="times">${tl.map(t=>'<span>'+esc(t)+'</span>').join('')}</div>`:''}
    ${chk}${apb}${rf}${risk}${acts}
  </div>`;
}
function render(){
  renderTabs();
  let items=ORDERS.filter(o=>o.status===cur);
  if(cur==='paid')items=items.slice().sort(function(a,b){return a.id-b.id;}); // fila: mais antigo primeiro
  NOST.clear();
  if(STARS&&STARS.configurado){let acc=0;ORDERS.filter(function(o){return o.status==='paid';}).sort(function(a,b){return a.id-b.id;})
    .forEach(function(o){acc+=o.stars;if(acc>STARS.saldo)NOST.add(o.id);});}
  renderSbar();
  if(q){const s=q.toLowerCase();items=items.filter(o=>o.nick.toLowerCase().includes(s)||o.gameId.includes(s)||('#'+o.id).includes(s)||String(o.id)===s);}
  document.getElementById('viewPed').innerHTML=items.length?items.map(card).join(''):
    `<div class="empty">Nenhum pedido ${LABEL[cur].toLowerCase()}${q?' para "'+esc(q)+'"':''}.</div>`;
}
// ---- saldo de Stars ----
const fmtN=function(n){return Number(n).toLocaleString('pt-BR');};
async function loadStars(){
  try{STARS=await api('/api/admin/stars');}catch(e){return;}
  const b=$$('stBtn');b.textContent='★ '+(STARS.configurado?fmtN(STARS.saldo):'?');
  b.classList.toggle('no',!STARS.configurado||STARS.fila>STARS.saldo);
  b.classList.toggle('lo',STARS.configurado&&STARS.fila<=STARS.saldo&&STARS.saldo<STARS.low);
  if(VIEW==='pedidos')render();
  if($$('smodal').classList.contains('on'))renderStars();
}
function renderSbar(){
  const box=$$('sbarBox');box.textContent='';
  if(VIEW!=='pedidos'||!STARS)return;
  let msg='';
  if(!STARS.configurado)msg='Informe seu saldo de Stars para a loja avisar quando faltar.';
  else if(STARS.fila>STARS.saldo)msg='Faltam '+fmtN(STARS.fila-STARS.saldo)+'★ para entregar a fila ('+fmtN(STARS.fila)+'★, saldo '+fmtN(STARS.saldo)+'★).';
  else if(STARS.saldo<STARS.low)msg='Saldo de Stars baixo: '+fmtN(STARS.saldo)+'★.';
  if(!msg)return;
  const d=el('div','sbar');d.appendChild(el('span',null,msg));
  const bt=el('button',null,STARS.configurado?'Recarregar':'Informar saldo');bt.onclick=openStars;d.appendChild(bt);box.appendChild(d);
}
function openStars(){$$('smodal').classList.add('on');renderStars();loadStars();}
function closeStars(){$$('smodal').classList.remove('on');}
function renderStars(){
  const B=$$('sBody');B.textContent='';if(!STARS){B.appendChild(el('div','empty','Carregando…'));return;}
  B.appendChild(el('div','sbig',STARS.configurado?fmtN(STARS.saldo)+'★':'—'));
  if(STARS.real){
    const R=STARS.real;let t;
    if(R.ativo)t='📡 Lido da conta do Telegram às '+new Date(R.at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})+' (atualiza a cada 5 min)';
    else if(R.err)t='⚠ Leitura do Telegram falhou ('+R.err+'). Usando o saldo manual.';
    else t='Lendo saldo do Telegram…';
    B.appendChild(el('div','ssub'+(R.err?' serr':''),t));
  }
  const F=STARS.previsao;
  if(F&&STARS.configurado){
    const fc=el('div','fcast'+(F.comprar?' buy':''));
    const dd=function(s){return s.split('-').reverse().slice(0,2).join('/');};
    fc.appendChild(el('b',null,F.comprar?('🛒 Compre ~'+fmtN(F.comprar)+'★'+(F.custo?' (≈ '+brlFromCents(F.custo)+')':'')+(F.ate?' até '+dd(F.ate):'')):'✅ Stars em dia'));
    fc.appendChild(el('span',null,F.ritmo?('Ritmo '+fmtN(F.ritmo)+'★/dia (7 dias) · dura ~'+Math.max(0,Math.floor(F.dias))+' dias · reserva '+fmtN(F.reserva)+'★'+(F.comprar?' · cobre '+F.alvo+' dias':'')):('Sem entregas nos últimos 7 dias · reserva mínima '+fmtN(F.reserva)+'★')));
    B.appendChild(fc);
  }
  let sub=STARS.configurado?'Fila a entregar: '+fmtN(STARS.fila)+'★ · aviso abaixo de '+fmtN(STARS.low)+'★':'Ainda não configurado. Confira no Telegram e informe o saldo atual.';
  sub+=' · custo por Star: R$ '+STARS.custoAtual.toFixed(4).replace('.',',')+(STARS.custoFonte==='recargas'?' (média das compras que formam o saldo; vale para os novos pedidos)':' (padrão — registre suas compras de Stars para atualizar)');
  B.appendChild(el('div','ssub',sub));
  if(STARS.autopay){
    const A=STARS.autopay,row=el('div','aprow'),tx=el('div');
    tx.appendChild(el('b',null,'Entrega com Stars'));
    tx.appendChild(el('span',null,'até '+fmtN(A.max)+'★ por pedido · '+fmtN(A.usado24h)+' de '+fmtN(A.dia)+'★ usados em 24h'));
    const seg=el('div','seg');
    [['0','Desligado'],['1','1 toque'],['2','Automático']].forEach(function(m){
      const bt=el('button',A.mode===m[0]?'on':'',m[1]);
      bt.onclick=async function(){
        if(A.mode===m[0])return;
        if(m[0]==='2'&&!confirm('Ligar a entrega AUTOMÁTICA?\n\nA loja vai pagar sozinha, sem você tocar, todo pedido com conferência ✅, sem REVISAR, dentro dos tetos e com saldo. Os outros ficam para entrega manual e você é avisado no Telegram.'))return;
        if(m[0]==='1'&&!confirm('Ligar o pagamento com 1 toque?\n\nO botão Pagar aparece só em pedidos com conferência ✅, sem REVISAR e dentro dos tetos. Cada pagamento pede confirmação.'))return;
        try{await api('/api/admin/autopay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:m[0]})});await loadStars();refreshOrders(false);}catch(e){alert(e.message);}
      };
      seg.appendChild(bt);
    });
    row.style.flexDirection='column';row.style.alignItems='stretch';
    row.appendChild(tx);row.appendChild(seg);
    // tetos editáveis
    const lims=el('div','lims');
    const fld=function(lbl,val){const w=el('label',null,lbl);const i=document.createElement('input');i.inputMode='numeric';i.value=String(val);w.appendChild(i);lims.appendChild(w);return i;};
    const iMax=fld('Máximo por pedido (★)',A.max),iDia=fld('Máximo em 24h (★)',A.dia);
    const sv=el('button',null,'Salvar limites');
    sv.onclick=async function(){
      const num=function(i){return parseInt(String(i.value).replace(/[^0-9]/g,''),10);};
      try{await api('/api/admin/autopay/limites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({max:num(iMax),dia:num(iDia)})});await loadStars();refreshOrders(false);}
      catch(e){alert(e.message);}
    };
    lims.appendChild(sv);row.appendChild(lims);B.appendChild(row);
  }
  const a=el('div','sacts');
  const b1=el('button','pri','+ Registrar compra');b1.onclick=addRecarga;
  const b2=STARS.real?el('button',null,'↻ Ler agora'):el('button',null,STARS.configurado?'Conferir saldo':'Informar saldo');
  b2.onclick=STARS.real?syncNow:conferir;
  a.appendChild(b1);a.appendChild(b2);B.appendChild(a);
  // compras de Stars: só custo, não mexem no saldo
  B.appendChild(el('div','ssec','Compras de Stars (custo)'));
  if(!STARS.compras||!STARS.compras.length)B.appendChild(el('div','ssub','Nenhuma compra registrada. Registre cada compra de Stars com o valor pago — não altera o saldo.'));
  else{
    const tc=el('table','smov');
    STARS.compras.forEach(function(p){
      const tr=document.createElement('tr');
      tr.appendChild(el('td','m',p.data));
      tr.appendChild(el('td',null,fmtN(p.stars)+'★ por '+brlFromCents(p.cents)+(p.nota?' · '+p.nota:'')));
      tr.appendChild(el('td','n','R$ '+p.unit.toFixed(4).replace('.',',')+'/★'));
      const td=document.createElement('td');const u=el('button','undo','apagar');u.onclick=function(){delCompra(p);};td.appendChild(u);
      tr.appendChild(td);tc.appendChild(tr);
    });
    B.appendChild(tc);
  }
  if(!STARS.movs.length)return;
  B.appendChild(el('div','ssec','Movimentos do saldo'));
  const t=el('table','smov');
  const NM={recarga:'Recarga',ajuste:'Ajuste',entrega:'Entrega'};
  STARS.movs.forEach(function(m){
    const tr=document.createElement('tr');
    tr.appendChild(el('td','m',m.data));
    tr.appendChild(el('td',null,NM[m.kind]+(m.order_id?' #'+m.order_id:'')+(m.nota?' · '+m.nota:'')+(m.cents?' · '+brlFromCents(m.cents):'')));
    tr.appendChild(el('td','n '+(m.delta>0?'p':''),(m.delta>0?'+':'')+fmtN(m.delta)+'★'));
    const td=document.createElement('td');
    if(m.kind==='ajuste'&&!STARS.real){const u=el('button','undo','apagar');u.onclick=function(){delMov(m.id,m.delta);};td.appendChild(u);}
    tr.appendChild(td);t.appendChild(tr);
  });
  B.appendChild(t);
}
async function syncNow(){
  try{STARS=await api('/api/admin/stars/sync',{method:'POST'});renderStars();loadStars();}catch(e){alert(e.message);}
}
async function postStars(body){
  try{await api('/api/admin/stars',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await loadStars();}
  catch(e){alert(e.message);}
}
function addRecarga(){
  const v=prompt('Quantas Stars você comprou?\n\n(Só para calcular o custo — o saldo continua vindo do Telegram.)','');if(v==null)return;
  const st=parseInt(v.replace(/[^0-9]/g,''),10);if(!(st>0)){alert('Quantidade inválida.');return;}
  const c=prompt('Quanto você pagou por esses '+st+'★, em R$? (atualiza o custo por Star dos próximos pedidos)','');if(c==null)return;
  let t=c.replace(/[^0-9,.]/g,'');if(t.indexOf(',')>=0)t=t.split('.').join('').replace(',','.');
  const cents=t?Math.round(parseFloat(t)*100):0;
  if(!(cents>0)){alert('Informe o valor pago.');return;}
  postStars({kind:'compra',stars:st,cents:cents,nota:''});
}
function conferir(){
  const v=prompt('Qual o saldo de Stars que aparece agora no Telegram?',STARS&&STARS.configurado?String(STARS.saldo):'');if(v==null)return;
  const n=parseInt(v.replace(/[^0-9]/g,''),10);if(!(n>=0)){alert('Saldo inválido.');return;}
  postStars({kind:'ajuste',saldo_real:n});
}
async function delCompra(p){
  if(!confirm('Apagar a compra de '+fmtN(p.stars)+'★ por '+brlFromCents(p.cents)+'? O custo por Star é recalculado.'))return;
  try{await api('/api/admin/stars/compras/'+p.id,{method:'DELETE'});await loadStars();}catch(e){alert(e.message);}
}
async function delMov(id,delta){
  if(!confirm('Apagar este movimento de '+(delta>0?'+':'')+fmtN(delta)+'★?'))return;
  try{await api('/api/admin/stars/'+id,{method:'DELETE'});await loadStars();}catch(e){alert(e.message);}
}

// tempo de espera do pago (prazo prometido: 1h)
function waitTag(o){
  if(o.status!=='paid'||!o.paidTs)return '';
  const m=Math.max(0,Math.floor((Date.now()-o.paidTs)/60000));
  const t=m<60?m+' min':m<1440?Math.floor(m/60)+'h'+String(m%60).padStart(2,'0'):Math.floor(m/1440)+(m<2880?' dia':' dias');
  return '<span class="wait '+(m>=50?'w3':m>=30?'w2':'')+'" title="Tempo desde o pagamento">⏱ '+t+'</span>';
}
// voltou do Telegram depois de tocar em "Abrir no Telegram": pergunta se entregou
let backFrom=null;
function askBack(){
  if(!backFrom)return;const o=ORDERS.find(function(x){return x.id===backFrom;});
  if(!o||o.status!=='paid'){backFrom=null;return;}
  $$('bbtxt').textContent='Entregou o pedido #'+o.id+' ('+o.nome+' para '+o.nick+')?';
  $$('backbar').classList.add('on');
}
function closeBack(){backFrom=null;$$('backbar').classList.remove('on');}
async function yesBack(){const id=backFrom;closeBack();if(id)await deliver(id,true);}
async function deliver(id,fromBack){
  const ob=ORDERS.find(function(x){return x.id===id;});
  const rk=ob&&ob.risk&&ob.risk.length?'\n\n⚠ REVISAR: '+ob.risk.join('; ')+'\n\nConfira no app do Mercado Pago se o Pix caiu e quem pagou. Na dúvida, fale com o cliente antes.':'';
  if((!fromBack||rk)&&!confirm('Confirmar entrega do pedido #'+id+'?'+rk))return;
  const r=await fetch('/painel/'+id+'/entregue',{method:'POST',headers:{'x-painel':'1'}});
  if(r.ok){const o=ORDERS.find(x=>x.id===id);NEWS.delete(id);loadStars();if(o){o.status='delivered';o.delivered=new Date().toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}render();}
  else alert('Não foi possível marcar como entregue.');
}
document.getElementById('q').oninput=e=>{q=e.target.value.trim();render();};

// ---- atualização automática dos pedidos ----
const NEWS=new Set();let VIEW='pedidos',syncing=false,unseen=0;
function hhmm(){return new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}
async function refreshOrders(manual){
  if(syncing)return;syncing=true;
  try{
    const r=await fetch('/api/admin/orders',{headers:{'x-painel':'1'}});
    if(r.status===401){location.href='/login';return;}
    if(!r.ok)throw new Error();
    const list=await r.json();
    const known=new Set(ORDERS.filter(function(o){return o.status==='paid';}).map(function(o){return o.id;}));
    let fresh=0;
    list.forEach(function(o){if(o.status==='paid'&&!known.has(o.id)){NEWS.add(o.id);fresh++;}});
    ORDERS.length=0;list.forEach(function(o){ORDERS.push(o);});
    if(fresh&&document.hidden){unseen+=fresh;document.title='('+unseen+') Painel — Recarga Flame';}
    if(VIEW==='pedidos')render();
    loadStars();
    $$('sync').textContent='Atualizado às '+hhmm()+' · atualiza sozinho a cada 15 s';
  }catch(e){
    $$('sync').textContent='Sem conexão às '+hhmm()+' · tentando de novo…';
    if(manual)alert('Não foi possível atualizar os pedidos.');
  }finally{syncing=false;}
}
setInterval(function(){if(!document.hidden)refreshOrders(false);},15000);
document.addEventListener('visibilitychange',function(){
  if(!document.hidden){unseen=0;document.title='Painel — Recarga Flame';askBack();refreshOrders(false);}
});
async function refundNow(id,btn){
  const o=ORDERS.find(function(x){return x.id===id;});if(!o)return;
  if(!confirm((o.status==='paid'?'CANCELAR E REEMBOLSAR':'REEMBOLSAR')+' o pedido #'+id+'?\n\nDevolve '+brl(o.cents)+' ao cliente pelo Mercado Pago ('+o.nick+', ID '+o.gameId+'). O pedido não será entregue. Não dá para desfazer.'))return;
  btn.disabled=true;btn.textContent='Reembolsando…';
  try{await api('/api/admin/orders/'+id+'/reembolsar',{method:'POST'});alert('Reembolsado: '+brl(o.cents)+' devolvidos pelo Mercado Pago.');}
  catch(e){alert(e.message);}
  refreshOrders(false);
}
async function approveNow(id,btn){
  const o=ORDERS.find(function(x){return x.id===id;});if(!o)return;
  if(!confirm('APROVAR E PAGAR o pedido #'+id+'?\n\nEm revisão por: '+(o.risk||[]).join('; ')+'\n\nSó aprove se conferiu o Pix de '+brl(o.cents)+' no app do Mercado Pago.\n\nVai pagar '+o.stars+'★ da conta separada: '+o.nome+' para '+o.nick+' (ID '+o.gameId+').'))return;
  btn.disabled=true;btn.textContent='Pagando…';
  try{const r=await api('/api/admin/orders/'+id+'/aprovar',{method:'POST'});alert('Aprovado, pago ('+r.stars+'★) e marcado como entregue.'+(r.botReply?'\n\nBot do CF: '+r.botReply:''));}
  catch(e){alert(e.message);}
  refreshOrders(false);loadStars();
}
async function payNow(id,btn){
  const o=ORDERS.find(function(x){return x.id===id;});if(!o)return;
  if(!confirm('Pagar '+o.stars+'★ da conta separada no bot do CounterFlame?\n\n'+o.nome+' para '+o.nick+' (ID '+o.gameId+')\n\nA fatura é conferida de novo antes de pagar.'))return;
  btn.disabled=true;btn.textContent='Pagando…';
  try{const r=await api('/api/admin/orders/'+id+'/autopay',{method:'POST'});alert('Pago ('+r.stars+'★) e marcado como entregue.'+(r.botReply?'\n\nBot do CF: '+r.botReply:''));}
  catch(e){alert(e.message);}
  refreshOrders(false);loadStars();
}
async function verifyPay(id,btn){
  btn.disabled=true;btn.textContent='verificando…';
  try{
    const r=await api('/api/admin/orders/'+id+'/verify',{method:'POST'});
    if(r.cobrado){
      if(confirm('FOI COBRADO: a fatura deste pedido no bot do CounterFlame (mensagem '+r.fatura+') tem recibo de pagamento de '+r.stars+'★.\n\nConfira se o item chegou na conta do cliente. Marcar o pedido #'+id+' como entregue (o cliente recebe o e-mail)?'))
        await api('/api/admin/orders/'+id+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'entregue'})});
    }else{
      if(confirm('NÃO foi cobrado: '+(r.semFatura?'a tentativa falhou antes de chegar à fatura':'a fatura deste pedido (mensagem '+r.fatura+') não tem recibo de pagamento')+'.\n\nLiberar uma nova tentativa (o botão Pagar volta)? Se preferir, entregue na mão e toque em Marcar entregue.'))
        await api('/api/admin/orders/'+id+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'liberar'})});
    }
  }catch(e){alert(e.message);}
  refreshOrders(false);loadStars();
}
async function recheck(id,btn){
  btn.disabled=true;btn.textContent='conferindo…';
  try{await api('/api/admin/orders/'+id+'/check',{method:'POST'});}catch(e){alert(e.message);}
  refreshOrders(false);
}
async function unblock(id){
  if(!confirm('Desbloquear o cliente do pedido #'+id+' (ID, e-mail, aparelho e conta que pagou)? Ele volta a poder comprar.'))return;
  try{await api('/api/admin/orders/'+id+'/unblock',{method:'POST'});refreshOrders(false);}
  catch(e){alert(e.message);}
}
function refreshView(){
  if(VIEW==='pedidos')refreshOrders(true);
  else if(VIEW==='produtos')loadProds();
  else if(VIEW==='cupons'){loadCups();loadRep();}
  else loadAna();
}

// ---- views ----
function setView(v){
  const ped=v==='pedidos',prod=v==='produtos',cup=v==='cupons',ana=v==='analytics';
  VIEW=v;if(ped){NEWS.clear();render();}
  document.getElementById('navPed').classList.toggle('on',ped);
  document.getElementById('navProd').classList.toggle('on',prod);
  document.getElementById('navCup').classList.toggle('on',cup);
  document.getElementById('navAna').classList.toggle('on',ana);
  document.getElementById('hdrPed').style.display=ped?'':'none';
  document.getElementById('viewPed').style.display=ped?'':'none';
  document.getElementById('viewProd').style.display=prod?'':'none';
  document.getElementById('viewCup').style.display=cup?'':'none';
  document.getElementById('hdrCup').style.display=cup?'':'none';if(cup)setCupTab(CUPTAB);
  document.getElementById('viewAna').style.display=ana?'':'none';
  document.getElementById('htitle').textContent=ped?'Painel de pedidos':prod?'Produtos':cup?'Cupons':'Analytics';
  if(prod)loadProds();
  if(cup){loadCups();loadRep();loadTiers();}
  if(ana)loadAna();
}

// ---- CRUD produtos ----
let PRODS=[];
const brlFromCents=c=>(c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
async function api(url,opt){
  const o=opt||{}; o.headers=Object.assign({'x-painel':'1'},o.headers||{});
  const r=await fetch(url,o); let j={}; try{j=await r.json();}catch{}
  if(!r.ok)throw new Error(j.error||'Erro na operação.');
  return j;
}
async function loadProds(){
  document.getElementById('prodList').innerHTML='<div class="empty">Carregando…</div>';
  try{PRODS=await api('/api/admin/products');renderProds();}
  catch(e){document.getElementById('prodList').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
function catName(p){
  if(p.niveis>0&&!p.tipo)return 'Níveis de Passe';
  return CATS[p.tipo||'']||'Coins';
}
function renderProds(){
  document.getElementById('prodList').innerHTML=PRODS.map(p=>`
    <div class="prow ${p.ativo?'':'pinact'}">
      <img src="${esc(p.img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="pi">
        <div class="nm">${esc(p.nome)}</div>
        <div class="sub">${esc(catName(p))} · chave <b>${esc(p.key)}</b> · cód <b>${esc(p.code)}</b> · ${p.stars}★</div>
      </div>
      <div class="rt">
        <div class="pr">${brlFromCents(p.cents)}</div>
        <div class="mg ${p.margem<0?'neg':p.margem<0.15?'low':''}" title="lucro por venda e margem, com o custo atual da Star">lucro ${brlFromCents(p.lucro)} · ${Math.round(p.margem*100)}%${p.margem<0?' · PREJUÍZO':''}</div>
        <button class="sw ${p.ativo?'on':''}" title="Ativo na loja" onclick="toggle('${esc(p.key)}')"></button>
        <div class="ops"><button onclick="openForm('${esc(p.key)}')">Editar</button><button class="del" onclick="delProd('${esc(p.key)}','${esc(p.nome)}')">Excluir</button></div>
      </div>
    </div>`).join('')||'<div class="empty">Nenhum produto. Crie o primeiro.</div>';
}
async function toggle(key){
  try{const r=await api('/api/admin/products/'+key+'/ativo',{method:'PATCH'});
    const p=PRODS.find(x=>x.key===key);if(p)p.ativo=r.ativo;renderProds();}
  catch(e){alert(e.message);}
}
async function delProd(key,nome){
  if(!confirm('Excluir o produto "'+nome+'"?\n\nPedidos antigos não são afetados.'))return;
  try{await api('/api/admin/products/'+key,{method:'DELETE'});PRODS=PRODS.filter(x=>x.key!==key);renderProds();}
  catch(e){alert(e.message);}
}
let editKey=null;
const $$=id=>document.getElementById(id);
function openForm(key){
  editKey=key||null;
  const p=key?PRODS.find(x=>x.key===key):null;
  $$('mtitle').textContent=p?'Editar produto':'Novo produto';
  $$('f_key').value=p?p.key:''; $$('f_key').disabled=!!p;
  $$('f_nome').value=p?p.nome:''; $$('f_preco').value=p?(p.cents/100).toFixed(2).replace('.',','):'';
  $$('f_stars').value=p?p.stars:''; $$('f_code').value=p?p.code:'';
  $$('f_tipo').value=p?(p.tipo||''):''; $$('f_niveis').value=p?(p.niveis||0):0;
  $$('f_img').value=p?(p.img||''):'';
  $$('f_ativo').classList.toggle('on',p?!!p.ativo:true);
  $$('merr').textContent='';
  mgPrev();
  $$('modal').classList.add('on');
}
function closeForm(){$$('modal').classList.remove('on');}
// prévia do lucro/margem enquanto edita preço ou Stars (custo atual da Star + taxa do MP)
function mgPrev(){
  const cents=Math.round(parseFloat(($$('f_preco').value||'').replace('.','').replace(',','.'))*100),st=parseInt($$('f_stars').value||'0',10);
  const box=$$('f_mg');
  if(!(cents>0)||!STARS){box.textContent='';box.className='mgprev';return;}
  const cost=STARS.custoAtual,fee=STARS.taxaMP||0.0099,l=cents-st*cost*100-cents*fee,m=l/cents;
  box.className='mgprev '+(m<0?'neg':m<0.15?'low':'');
  box.textContent='Lucro '+brlFromCents(Math.round(l))+' · margem '+Math.round(m*100)+'%'+(m<0?' · PREJUÍZO':'')+' · Star R$ '+cost.toFixed(4).replace('.',',');
}
$$('f_preco').addEventListener('input',mgPrev);$$('f_stars').addEventListener('input',mgPrev);
$$('modal').onclick=e=>{if(e.target.id==='modal')closeForm();};
async function saveForm(){
  $$('merr').textContent=''; const btn=$$('msave'); btn.disabled=true;
  const centsNum=Math.round(parseFloat(($$('f_preco').value||'').replace('.','').replace(',','.'))*100);
  const payload={
    key:$$('f_key').value.trim(), nome:$$('f_nome').value.trim(),
    cents:centsNum, stars:$$('f_stars').value||0, code:$$('f_code').value.trim(),
    tipo:$$('f_tipo').value, niveis:$$('f_niveis').value||0,
    img:$$('f_img').value.trim(), ativo:$$('f_ativo').classList.contains('on'),
  };
  try{
    if(editKey)await api('/api/admin/products/'+editKey,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    else await api('/api/admin/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    closeForm(); await loadProds();
  }catch(e){$$('merr').textContent=e.message;}
  finally{btn.disabled=false;}
}


// ---- cupons ----
let CUPS=[],editCup=null,REP_DUE=0,CUPTAB='cupons';
try{const t=localStorage.getItem('cupTab');if(t==='cupons'||t==='comissoes'||t==='metas')CUPTAB=t;}catch(e){}
function renderCupTabs(){
  const T=[['cupons','Cupons',CUPS.length],['comissoes','Comissões',REP_DUE||null],['metas','Metas padrão',null]];
  $$('cupTabs').innerHTML=T.map(function(x){return '<button class="tab '+(x[0]===CUPTAB?'on':'')+'" data-t="'+x[0]+'">'+x[1]+(x[2]!=null?'<span class="c">'+x[2]+'</span>':'')+'</button>';}).join('');
  $$('cupTabs').querySelectorAll('.tab').forEach(function(b){b.onclick=function(){setCupTab(b.dataset.t);};});
}
function setCupTab(t){
  CUPTAB=t;try{localStorage.setItem('cupTab',t);}catch(e){}
  $$('secCup').style.display=t==='cupons'?'':'none';$$('secCom').style.display=t==='comissoes'?'':'none';$$('secMeta').style.display=t==='metas'?'':'none';
  renderCupTabs();scrollTo(0,0);
}
const pct=n=>String(n).replace('.',',')+'%';
async function loadCups(){
  try{CUPS=await api('/api/admin/coupons');renderCups();}
  catch(e){$$('cupList').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
function renderCups(){
  renderCupTabs();if(TIERS.length)renderTiers();
  $$('cupList').innerHTML=CUPS.map(function(c){
    return '<div class="prow cup"><div class="pi"><div class="nm mono">'+esc(c.code)+(c.ativo?'<span class="cuptag">ATIVO</span>':'<span class="cuptag off">INATIVO</span>')+'</div>'+
      '<div class="sub">desconto <b>'+pct(c.desconto_pct)+'</b> · '+(c.plano==='fixo'?'comissão fixa <b>'+pct(c.comissao_pct)+'</b> do lucro':'<b>plano de metas</b>'+(c.tiers?' (faixas próprias)':''))+(c.nota?' · '+esc(c.nota):'')+'</div>'+
      '<div class="sub mono">'+esc(location.origin+'/?cupom='+c.code)+'</div></div>'+
      '<div class="rt"><button class="sw '+(c.ativo?'on':'')+'" title="Ativar/desativar" data-tog="'+esc(c.code)+'"></button>'+
      '<div class="ops"><button data-copy="'+esc(c.code)+'">Copiar link</button><button data-edit="'+esc(c.code)+'">Editar</button><button class="del" data-del="'+esc(c.code)+'">Excluir</button></div></div></div>';
  }).join('')||'<div class="empty">Nenhum cupom ainda.</div>';
  $$('cupList').querySelectorAll('[data-copy]').forEach(function(b){b.onclick=function(){copyCup(b.dataset.copy);};});
  $$('cupList').querySelectorAll('[data-edit]').forEach(function(b){b.onclick=function(){openCup(b.dataset.edit);};});
  $$('cupList').querySelectorAll('[data-tog]').forEach(function(b){b.onclick=function(){togCup(b.dataset.tog);};});
  $$('cupList').querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(){delCup(b.dataset.del);};});
}
async function delCup(code){
  if(!confirm('Excluir o cupom '+code+'? O link dele para de dar desconto. Isso não pode ser desfeito.'))return;
  try{await api('/api/admin/coupons/'+encodeURIComponent(code),{method:'DELETE'});loadCups();loadRep();}
  catch(e){alert(e.message);}
}
async function togCup(code){
  const c=CUPS.find(function(x){return x.code===code;});if(!c)return;
  try{await api('/api/admin/coupons/'+code,{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({desconto_pct:c.desconto_pct,comissao_pct:c.comissao_pct,nota:c.nota,ativo:!c.ativo,plano:c.plano,ids_proprios:c.ids_proprios||''})});
    c.ativo=!c.ativo;renderCups();}
  catch(e){alert(e.message);}
}
function copyCup(code){const u=location.origin+'/?cupom='+code;
  (navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(function(){alert('Link copiado: '+u);},function(){prompt('Copie o link:',u);});}
function perRange(){
  const v=$$('repPer').value,d=new Date(new Date().toLocaleString('en-US',{timeZone:'America/Sao_Paulo'}));
  const f=function(x){return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');};
  if(v==='all')return '';
  const m=v==='m1'?d.getMonth()-1:d.getMonth();
  return '?from='+f(new Date(d.getFullYear(),m,1))+'&to='+f(new Date(d.getFullYear(),m+1,0));
}
// ---- faixas do plano de metas ----
let TIERS=[];const REP_OPEN=new Set();
function tiersResumo(){return TIERS.map(function(t,i){return String(t.pct).replace('.',',')+'%'+(i?' a partir de '+brlFromCents(t.min):'');}).join(' · ');}
function irParaFaixas(){closeCup();setCupTab('metas');}
let TNEXT=null;
const mesNome=function(m){return ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][+m.slice(5)-1]+'/'+m.slice(0,4);};
function proxMes(){const d=new Date(new Date().toLocaleString('en-US',{timeZone:'America/Sao_Paulo'}));const n=new Date(d.getFullYear(),d.getMonth()+1,1);return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0');}
function tiersTxt(T){return T.map(function(t,i){return String(t.pct).replace('.',',')+'%'+(i?' a partir de '+brlFromCents(t.min):'');}).join(' · ');}
function usamPadrao(){return CUPS.filter(function(c){return c.plano!=='fixo'&&!c.tiers;}).map(function(c){return c.code+(c.ativo?'':' (inativo)');});}
async function loadTiers(){try{TIERS=await api('/api/admin/tiers');try{TNEXT=(await api('/api/admin/tiers/agendado')).agendado;}catch(e){TNEXT=null;}renderTiers();}catch(e){$$('tiersBox').textContent=e.message;}}
async function cancelNext(){if(!confirm('Cancelar a mudança de faixas agendada para '+mesNome(TNEXT.mes)+'?'))return;
  try{await api('/api/admin/tiers/agendado',{method:'DELETE'});TNEXT=null;renderTiers();}catch(e){alert(e.message);}}
function renderTiers(){
  const B=$$('tiersBox');B.textContent='';
  const d=el('div','tcard');
  d.appendChild(el('div','ttl','Metas padrão · faixas de comissão (para cupons do plano de metas sem faixas próprias)'));
  d.appendChild(el('p','hint','Faturamento do parceiro no mês → % do lucro em TODAS as vendas do mês. Quem atinge uma faixa começa o mês seguinte uma faixa abaixo. Meses fechados nunca mudam.'));
  const us=usamPadrao();d.appendChild(el('p','hint','Usam estas faixas: '+(us.length?us.join(', '):'nenhum parceiro')+'. Quem tem faixas próprias não muda.'));
  if(TNEXT){const ag=el('div','metabox');ag.appendChild(el('span',null,'Agendado para '+mesNome(TNEXT.mes)+': '+tiersTxt(TNEXT.tiers)));const cb=el('button',null,'Cancelar');cb.type='button';cb.onclick=cancelNext;ag.appendChild(cb);d.appendChild(ag);}
  const t=el('table','ttab tt');const h=el('tr');['Vendas no mês a partir de','Comissão',''].forEach(function(x){h.appendChild(el('th',null,x));});t.appendChild(h);
  TIERS.forEach(function(x,i){
    const tr=el('tr');
    const a=document.createElement('input');a.inputMode='decimal';a.value=(x.min/100).toFixed(2).replace('.',',');a.dataset.k='min';if(i===0){a.disabled=true;a.value='0,00';}
    const b=document.createElement('input');b.inputMode='decimal';b.value=String(x.pct).replace('.',',');b.dataset.k='pct';
    const td1=el('td');td1.appendChild(el('span',null,'R$ '));td1.appendChild(a);const td2=el('td');td2.appendChild(b);td2.appendChild(el('span',null,' %'));
    const td3=el('td');if(i>0){const rm=el('button','undo','remover');rm.onclick=function(){TIERS.splice(i,1);renderTiers();};td3.appendChild(rm);}
    tr.appendChild(td1);tr.appendChild(td2);tr.appendChild(td3);t.appendChild(tr);
  });
  d.appendChild(t);
  const ops=el('div','ops');
  const add=el('button',null,'+ faixa');add.onclick=function(){const l=TIERS[TIERS.length-1];TIERS.push({min:l.min+100000,pct:l.pct+5});renderTiers();};
  if(TIERS.length<6){ops.appendChild(add);d.appendChild(ops);}
  const ops2=el('div','ops col');
  const sv2=el('button','sec','Aplicar já');sv2.onclick=function(){saveTiers('agora');};
  const sv=el('button','pri','Salvar a partir de '+mesNome(proxMes()));sv.onclick=function(){saveTiers('proximo');};
  ops2.appendChild(sv);ops2.appendChild(sv2);d.appendChild(ops2);
  const lgd=document.createElement('details');lgd.className='clog';lgd.appendChild(el('summary',null,'Histórico das faixas padrão'));
  const lgb=el('div','hint');lgd.appendChild(lgb);lgd.ontoggle=function(){if(lgd.open)logInto(lgb,'*');};d.appendChild(lgd);
  B.appendChild(d);
}
async function saveTiers(quando){
  const rows=$$('tiersBox').querySelectorAll('table tr');const out=[];
  const num=function(v){let t=String(v).replace(/[^0-9,.]/g,'');if(t.indexOf(',')>=0)t=t.split('.').join('').replace(',','.');return parseFloat(t);};
  rows.forEach(function(r,i){if(!i)return;const ins=r.querySelectorAll('input');out.push({min:Math.round(num(ins[0].value)*100)||0,pct:num(ins[1].value)});});
  const us=usamPadrao(),quem='Afeta: '+(us.length?us.join(', '):'nenhum parceiro')+'.';
  if(!confirm(quando==='proximo'?'Agendar as novas faixas para '+mesNome(proxMes())+'? Até lá continuam as de hoje. '+quem:
    'Aplicar as novas faixas JÁ, inclusive nas vendas deste mês? '+quem+' O acordo prevê aviso de 7 dias antes de mudar as faixas.'))return;
  try{TIERS=await api('/api/admin/tiers'+(quando==='proximo'?'?quando=proximo':''),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(out)});
    try{TNEXT=(await api('/api/admin/tiers/agendado')).agendado;}catch(e){TNEXT=null;}
    renderTiers();loadRep();alert(quando==='proximo'?'Faixas agendadas para '+mesNome(TNEXT?TNEXT.mes:proxMes())+'.':'Faixas salvas.');}
  catch(e){alert(e.message);}
}
async function loadRep(){
  $$('repBox').innerHTML='<div class="empty">Carregando…</div>';
  try{const r=await api('/api/admin/coupons/report'+perRange());
    REP_DUE=r.cupons.filter(function(c){return c.saldo>=c.minimo;}).length;renderCupTabs();
    $$('repBox').innerHTML=r.cupons.map(function(c){
      const st=c.saldo>0?(c.saldo<c.minimo?'<span class="due low">'+brlFromCents(c.saldo)+' · acumula</span>':'<span class="due">a pagar '+brlFromCents(c.saldo)+'</span>'):
        c.saldo<0?'<span class="due">crédito '+brlFromCents(-c.saldo)+'</span>':'<span class="ok">em dia ✓</span>';
      const pays=c.pagamentos.map(function(p){
        return '<tr><td>'+esc(p.data.split('-').reverse().join('/'))+'</td><td>'+(p.ref?mesNome(p.ref):'—')+'</td><td>'+brlFromCents(p.cents)+'</td><td style="text-align:left">'+esc(p.nota)+'</td>'+
          '<td><button class="undo" data-undo="'+p.id+'" data-v="'+esc(brlFromCents(p.cents))+'">desfazer</button></td></tr>';
      }).join('');
      const M=c.mesAtual;
      const meta=M?('<div class="meta"><div class="mt"><b>'+M.pct+'%</b> este mês'+(M.ating<M.garant?' · garantida pelo mês anterior':'')+' · faturado <b>'+brlFromCents(M.faturamento)+'</b> · comissão estimada <b>'+brlFromCents(M.comissao)+'</b></div>'+
        (M.prox?'<div class="pg"><i style="width:'+Math.min(100,Math.round(M.faturamento/M.prox.min*100))+'%"></i></div><div class="mt2">faltam <b>'+brlFromCents(M.prox.falta)+'</b> para '+M.prox.pct+'% em todas as vendas do mês</div>':'<div class="mt2">faixa máxima ✓</div>')+'</div>'):'';
      return '<details class="rep" data-code="'+esc(c.code)+'"'+(REP_OPEN.has(c.code)?' open':'')+'><summary class="top"><span class="mono">'+esc(c.code)+'</span>'+st+'</summary>'+meta+
        '<div class="nums"><span><b>'+c.visitas+'</b> visitas pelo link</span><span><b>'+c.pedidos+'</b> vendas</span>'+
        '<span>conversão <b>'+(c.conversao==null?'—':Math.round(c.conversao*100)+'%')+'</b></span></div>'+
        '<div class="nums"><span>faturado <b>'+brlFromCents(c.faturado)+'</b></span>'+
        '<span>descontos <b>'+brlFromCents(c.desconto)+'</b></span><span>lucro <b>'+brlFromCents(c.lucro)+'</b></span>'+
        '<span>comissão <b>'+brlFromCents(c.comissao)+'</b></span><span>fica para a loja <b>'+brlFromCents(c.lucroLoja)+'</b></span></div>'+
        '<div class="tot"><span>a pagar (meses fechados) <b>'+brlFromCents(Math.max(0,c.saldo))+'</b></span><span>este mês (estimado) <b>'+brlFromCents(c.mesCom)+'</b></span>'+(c.saldo>0&&c.saldo<c.minimo?'<span>abaixo do mínimo de '+brlFromCents(c.minimo)+': acumula</span>':'')+'</div>'+
        '<div class="tot"><span>ganho total <b>'+brlFromCents(c.total)+'</b></span><span>já pago <b>'+brlFromCents(c.pago)+'</b></span><span>'+(c.plano==='fixo'?'fixo: '+pct(c.comissao_pct)+' do lucro':'plano de metas')+'</span></div>'+
        (c.parceiro&&(c.parceiro.nome||c.parceiro.pix)?'<div class="nums">'+(c.parceiro.nome?'<span>parceiro <b>'+esc(c.parceiro.nome)+'</b></span>':'')+(c.parceiro.pix?'<span>Pix <b class="mono">'+esc(c.parceiro.pix)+'</b></span>':'<span>Pix não cadastrado</span>')+'</div>':'<div class="nums"><span>dados do parceiro não cadastrados (Cupons → Editar)</span></div>')+
        '<div class="ops">'+(c.parceiro&&c.parceiro.pix?'<button data-cpix="'+esc(c.parceiro.pix)+'">Copiar Pix</button>':'')+(c.parceiro&&c.parceiro.email?'<button data-ext="'+esc(c.code)+'">Prévia do extrato</button>':'')+'<button data-pay="'+esc(c.code)+'" data-saldo="'+Math.max(0,c.saldo)+'">Registrar pagamento</button>'+
        (c.linkParceiro?'<button data-plink="'+esc(c.linkParceiro)+'">Copiar link do parceiro</button>':'')+'</div>'+
        (c.linkParceiro?'<div class="plk">Página do parceiro (só leitura, sem lucro/margem) · <button class="undo" data-pnew="'+esc(c.code)+'">gerar novo link</button></div>':'')+
        (pays?'<details><summary>Pagamentos feitos ('+c.pagamentos.length+')</summary><table class="ttab"><tr><th>Data</th><th>Ref.</th><th>Valor</th><th style="text-align:left">Obs.</th><th></th></tr>'+pays+'</table></details>':'')+
        '</details>';
    }).join('')||'<div class="empty" style="padding:24px">Nenhuma venda com cupom ainda.</div>';
    $$('repBox').querySelectorAll('details.rep').forEach(function(d){d.ontoggle=function(){if(d.open)REP_OPEN.add(d.dataset.code);else REP_OPEN.delete(d.dataset.code);};});
    $$('repBox').querySelectorAll('[data-ext]').forEach(function(b){b.onclick=function(){window.open('/api/admin/coupons/'+encodeURIComponent(b.dataset.ext)+'/extrato','_blank','noopener');};});
    $$('repBox').querySelectorAll('[data-cpix]').forEach(function(b){b.onclick=function(){const v=b.dataset.cpix;
      (navigator.clipboard?navigator.clipboard.writeText(v):Promise.reject()).then(function(){alert('Chave Pix copiada.');},function(){prompt('Copie a chave Pix:',v);});};});
    $$('repBox').querySelectorAll('[data-pay]').forEach(function(b){b.onclick=function(){payCup(b.dataset.pay,Number(b.dataset.saldo));};});
    $$('repBox').querySelectorAll('[data-plink]').forEach(function(b){b.onclick=function(){const u=b.dataset.plink;
      (navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(function(){alert('Link do parceiro copiado. Envie só para ele — quem tiver o link vê os números da parceria.');},function(){prompt('Copie o link do parceiro:',u);});};});
    $$('repBox').querySelectorAll('[data-pnew]').forEach(function(b){b.onclick=async function(){
      if(!confirm('Gerar um novo link para '+b.dataset.pnew+'? O link atual deixa de funcionar na hora.'))return;
      try{await api('/api/admin/coupons/'+b.dataset.pnew+'/ptoken',{method:'POST'});loadRep();}catch(e){alert(e.message);}};});
    $$('repBox').querySelectorAll('[data-undo]').forEach(function(b){b.onclick=function(){undoPay(b.dataset.undo,b.dataset.v);};});
  }catch(e){$$('repBox').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
async function payCup(code,saldo){
  const v=prompt('Quanto você pagou para '+code+'? (R$)',saldo>0?(saldo/100).toFixed(2).replace('.',','):'');
  if(v==null)return;
  let t=v.replace(/[^0-9,.]/g,'');
  if(t.indexOf(',')>=0)t=t.split('.').join('').replace(',','.');
  const cents=Math.round(parseFloat(t)*100);
  if(!(cents>0)){alert('Valor inválido.');return;}
  const pm=proxMes(),py=+pm.slice(0,4),pmm=+pm.slice(5),am=pmm<=2?new Date(py-1,pmm+9,1):new Date(py,pmm-3,1);
  const def=String(am.getMonth()+1).padStart(2,'0')+'/'+am.getFullYear();
  const rv=prompt('Referente a qual mês? (mm/aaaa)',def);
  if(rv==null)return;
  const mm=[''].concat(String(rv).trim().split('/'));if(mm.length!==3||!/^[0-9]{1,2}$/.test(mm[1])||!/^[0-9]{4}$/.test(mm[2])||+mm[1]<1||+mm[1]>12){alert('Mês inválido. Use mm/aaaa, ex.: '+def);return;}
  const ref=mm[2]+'-'+mm[1].padStart(2,'0');
  const nota=prompt('Observação (opcional), ex.: Pix 07/11','');
  if(nota==null)return;
  try{await api('/api/admin/coupons/'+code+'/payouts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cents:cents,nota:nota,ref_mes:ref})});loadRep();}
  catch(e){alert(e.message);}
}
async function undoPay(id,v){
  if(!confirm('Desfazer o pagamento de '+v+'? Ele volta para o saldo a pagar.'))return;
  try{await api('/api/admin/payouts/'+id,{method:'DELETE'});loadRep();}
  catch(e){alert(e.message);}
}
function openCup(code){
  editCup=code||null;const c=code?CUPS.find(function(x){return x.code===code;}):null;
  $$('ctitle').textContent=c?'Editar cupom':'Novo cupom';
  $$('c_code').value=c?c.code:'';$$('c_code').disabled=!!c;
  $$('c_desc').value=c?String(c.desconto_pct).replace('.',','):'5';
  $$('c_com').value=c?String(c.comissao_pct).replace('.',','):'30';
  $$('c_plano').value=c&&c.plano==='fixo'?'fixo':'metas';$$('c_ids').value=c?(c.ids_proprios||''):'';
  CT=null;try{CT=c&&c.tiers?JSON.parse(c.tiers):null;}catch(e){CT=null;}
  $$('c_tmode').value=CT?'proprias':'padrao';cupPlano();cupTmode();
  $$('c_nota').value=c?(c.nota||''):'';
  $$('c_pnome').value=c?(c.parceiro_nome||''):'';$$('c_pcanal').value=c?(c.parceiro_canal||''):'';$$('c_ppix').value=c?(c.parceiro_pix||''):'';$$('c_pemail').value=c?(c.parceiro_email||''):'';
  $$('c_ativo').classList.toggle('on',c?!!c.ativo:true);
  $$('cerr').textContent='';cupLink();cupAtivoTxt();cupLog(c?c.code:null);$$('cmodal').classList.add('on');
}
let CT=null; // faixas próprias do cupom em edição (null = padrão)
function cupTmode(){
  const prop=$$('c_tmode').value==='proprias';
  if(prop&&!CT)CT=TIERS.map(function(t){return {min:t.min,pct:t.pct};});
  $$('c_tpad').style.display=prop?'none':'';$$('c_tprop').style.display=prop?'':'none';
  if(prop)renderCT();
}
function renderCT(){
  const B=$$('c_tprop');B.textContent='';
  const t=el('table','ttab tt');const h=el('tr');['Vendas no mês a partir de','Comissão',''].forEach(function(x){h.appendChild(el('th',null,x));});t.appendChild(h);
  CT.forEach(function(x,i){
    const tr=el('tr');
    const a=document.createElement('input');a.inputMode='decimal';a.value=i?(x.min/100).toFixed(2).replace('.',','):'0,00';a.disabled=!i;
    a.oninput=function(){x.min=Math.round(numBR(a.value)*100)||0;};
    const b=document.createElement('input');b.inputMode='decimal';b.dataset.k='pct';b.value=String(x.pct).replace('.',',');b.oninput=function(){x.pct=numBR(b.value);};
    const td1=el('td');td1.appendChild(el('span',null,'R$ '));td1.appendChild(a);const td2=el('td');td2.appendChild(b);td2.appendChild(el('span',null,' %'));
    const td3=el('td');if(i){const rm=el('button','undo','remover');rm.type='button';rm.onclick=function(){CT.splice(i,1);renderCT();};td3.appendChild(rm);}
    tr.appendChild(td1);tr.appendChild(td2);tr.appendChild(td3);t.appendChild(tr);
  });
  B.appendChild(t);
  if(CT.length<6){const ad=el('button','addt','+ faixa');ad.type='button';ad.onclick=function(){const l=CT[CT.length-1];CT.push({min:l.min+100000,pct:l.pct+5});renderCT();};B.appendChild(ad);}
}
function numBR(v){let t=String(v).replace(/[^0-9,.]/g,'');if(t.indexOf(',')>=0)t=t.split('.').join('').replace(',','.');return parseFloat(t);}
function cupPlano(){const fixo=$$('c_plano').value==='fixo';$$('c_com_fg').style.display=fixo?'':'none';$$('c_metas_fg').style.display=fixo?'none':'';
  $$('c_metas_txt').textContent=TIERS.length?tiersResumo():'carregando faixas…';if(!TIERS.length)loadTiers().then(function(){$$('c_metas_txt').textContent=tiersResumo();});}
function cupAtivoTxt(){$$('c_ativo_txt').textContent=$$('c_ativo').classList.contains('on')?'Ativo — já pode ser usado':'Inativo — o link não dá desconto';}
function cupLink(){$$('c_link').textContent=location.origin+'/?cupom='+($$('c_code').value.trim().toUpperCase()||'CODIGO');}
$$('c_code').oninput=cupLink;
function closeCup(){$$('cmodal').classList.remove('on');}
function fmtTs(ts){try{return new Date(ts.replace(' ','T')+'Z').toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'});}catch(e){return ts;}}
async function logInto(box,code){box.textContent='Carregando…';
  try{const L=await api('/api/admin/cupons-log?code='+encodeURIComponent(code));
    box.innerHTML=L.length?L.map(function(r){return '<div class="lg"><span>'+esc(fmtTs(r.data))+'</span>'+esc(r.acao)+'</div>';}).join(''):'Nenhuma alteração registrada ainda.';}
  catch(e){box.textContent=e.message;}}
function cupLog(code){const d=$$('c_logbox');d.style.display=code?'':'none';d.open=false;d.ontoggle=function(){if(d.open)logInto($$('c_log'),code);};}
$$('cmodal').onclick=function(e){if(e.target.id==='cmodal')closeCup();};
async function saveCup(){
  $$('cerr').textContent='';const b=$$('csave');b.disabled=true;
  const num=function(id){return Number(($$(id).value||'0').replace(',','.'));};
  const payload={code:$$('c_code').value.trim(),desconto_pct:num('c_desc'),comissao_pct:num('c_com'),nota:$$('c_nota').value.trim(),ativo:$$('c_ativo').classList.contains('on'),
    plano:$$('c_plano').value,ids_proprios:$$('c_ids').value.trim(),
    parceiro_nome:$$('c_pnome').value.trim(),parceiro_canal:$$('c_pcanal').value.trim(),parceiro_pix:$$('c_ppix').value.trim(),parceiro_email:$$('c_pemail').value.trim(),
    tiers:$$('c_plano').value==='metas'&&$$('c_tmode').value==='proprias'&&CT?CT:null};
  try{
    if(editCup)await api('/api/admin/coupons/'+editCup,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    else await api('/api/admin/coupons',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    closeCup();await loadCups();loadRep();
  }catch(e){$$('cerr').textContent=e.message;}
  finally{b.disabled=false;}
}


// ---- analytics ----
let anaP='d30';
function ymd(x){return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');}
function spNow(){return new Date(new Date().toLocaleString('en-US',{timeZone:'America/Sao_Paulo'}));}
function anaRange(p){
  const d=spNow(),Y=d.getFullYear(),M=d.getMonth(),D=d.getDate();
  if(p==='d0')return [ymd(d),ymd(d)];
  if(p==='d7')return [ymd(new Date(Y,M,D-6)),ymd(d)];
  if(p==='d30')return [ymd(new Date(Y,M,D-29)),ymd(d)];
  if(p==='m0')return [ymd(new Date(Y,M,1)),ymd(d)];
  if(p==='m1')return [ymd(new Date(Y,M-1,1)),ymd(new Date(Y,M,0))];
  return [null,null];
}
document.querySelectorAll('#anaPer button').forEach(function(b){b.onclick=function(){
  anaP=b.dataset.p;document.querySelectorAll('#anaPer button').forEach(function(x){x.classList.toggle('on',x===b);});loadAna();};});
function el(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
function kpi(l,v,sub){const k=el('div','kpi');k.appendChild(el('div','l',l));k.appendChild(el('div','v',v));if(sub)k.appendChild(el('div','s',sub));return k;}
const brlC=function(c){return brlFromCents(Math.round(c));};
async function loadAna(){
  const body=$$('anaBody');body.classList.add('loading');
  const r=anaRange(anaP);const qs=r[0]?('?from='+r[0]+'&to='+r[1]):'';
  let a;try{a=await api('/api/admin/analytics'+qs);}catch(e){body.classList.remove('loading');body.textContent=e.message;return;}
  body.classList.remove('loading');body.textContent='';
  const conv=a.pixGerados?Math.round(a.pixPagos/a.pixGerados*100)+'%':'—';
  const k=el('div','kpis');
  k.appendChild(kpi('Vendas',String(a.vendas),a.comCupom?(a.comCupom+' com cupom'):null));
  k.appendChild(kpi('Faturado',brlC(a.faturado)));
  k.appendChild(kpi('Ticket médio',a.vendas?brlC(a.ticket):'—'));
  k.appendChild(kpi('Lucro estimado',brlC(a.lucro),a.comissao?('após '+brlC(a.comissao)+' de comissão'):'Stars + taxa MP descontadas'));
  k.appendChild(kpi('Conversão do Pix',conv,a.pixGerados?(a.pixPagos+' pagos de '+a.pixGerados+' gerados'):'nenhum Pix gerado'));
  k.appendChild(kpi('Entrega (mediana)',a.entregaMedianaMin==null?'—':fmtMin(a.entregaMedianaMin),
    a.entregaAte1h==null?'nenhuma entrega':(Math.round(a.entregaAte1h*100)+'% em até 1h · '+a.entregas+' entregas')));
  body.appendChild(k);
  if(a.estornos){const w=el('div','ccard');w.appendChild(el('h4',null,'⚠ '+a.estornos+(a.estornos>1?' estornos':' estorno')+' no período'));
    w.appendChild(el('p','sub','Pedidos pagos que voltaram (MED/chargeback). Não entram nas vendas acima.'));body.appendChild(w);}
  if(a.funil)body.appendChild(funnelCard(a.funil));
  if(a.entregaTipos)body.appendChild(entregaCard(a));
  if(a.porHora)body.appendChild(picoCard(a));
  if(a.clientes)body.appendChild(clientesCard(a.clientes));
  body.appendChild(dayChart(a,r));
  body.appendChild(prodRank(a.produtos));
}
// horários e dias de pico: colunas por hora (vendas) + barras por dia da semana
function picoCard(a){
  const DIAS=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
  const card=el('div','ccard');card.style.position='relative';card.appendChild(el('h4',null,'Horários e dias de pico'));
  const tot=a.porHora.reduce(function(s,h){return s+h.n;},0);
  if(!tot){card.appendChild(el('p','sub','Sem vendas no período'));return card;}
  let hMax=a.porHora[0];a.porHora.forEach(function(h){if(h.n>hMax.n)hMax=h;});
  let dMax=a.porSemana[0];a.porSemana.forEach(function(d){if(d.n>dMax.n)dMax=d;});
  card.appendChild(el('p','sub','Pico às '+hMax.h+'h ('+hMax.n+(hMax.n===1?' venda':' vendas')+') · melhor dia: '+DIAS[dMax.d].toLowerCase()+' · horário de Brasília'));
  // colunas por hora
  const wrap=el('div','chart');card.appendChild(wrap);const tip=el('div','tip');card.appendChild(tip);
  const W=Math.max(260,($$('anaBody').clientWidth||560)-26),H=140,L=8,B=20,T=16,pw=W-L-8,ph=H-B-T;
  const max=Math.max(1,hMax.n);
  const NS='http://www.w3.org/2000/svg';const svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 '+W+' '+H);
  svg.setAttribute('role','img');svg.setAttribute('aria-label','Vendas por hora do dia');
  function sv(tag,at){const e=document.createElementNS(NS,tag);for(const k in at)e.setAttribute(k,at[k]);return e;}
  svg.appendChild(sv('line',{x1:L,x2:L+pw,y1:T+ph,y2:T+ph,class:'grid'}));
  const slot=pw/24,bw=Math.min(24,Math.max(3,slot-3));
  a.porHora.forEach(function(d,i){
    const x=L+slot*i+(slot-bw)/2,h=d.n?Math.max(2,ph*d.n/max):0,y=T+ph-h,r4=Math.min(4,h,bw/2);
    const hit=sv('rect',{x:L+slot*i,y:T,width:slot,height:ph,class:'hit',tabindex:'0'});hit.setAttribute('aria-label',d.h+'h: '+d.n+' vendas');svg.appendChild(hit);
    svg.appendChild(sv('path',{class:'col',d:h?('M'+x+','+(T+ph)+'V'+(y+r4)+'Q'+x+','+y+' '+(x+r4)+','+y+'H'+(x+bw-r4)+'Q'+(x+bw)+','+y+' '+(x+bw)+','+(y+r4)+'V'+(T+ph)+'Z'):''}));
    if(i%3===0){const t=sv('text',{x:x+bw/2,y:H-5,'text-anchor':'middle'});t.textContent=d.h+'h';svg.appendChild(t);}
    if(d===hMax){const t=sv('text',{x:x+bw/2,y:y-4,'text-anchor':'middle',class:'lbl'});t.textContent=String(d.n);svg.appendChild(t);}
    function show(){tip.textContent='';tip.appendChild(el('b',null,d.n+(d.n===1?' venda':' vendas')));tip.appendChild(el('span',null,d.h+'h–'+(d.h+1)+'h · '+brlC(d.cents)));
      tip.style.display='block';const cx=(x+bw/2)/W*wrap.clientWidth+12;tip.style.left=Math.min(cx,card.clientWidth-tip.offsetWidth-8)+'px';tip.style.top='34px';}
    hit.addEventListener('pointermove',show);hit.addEventListener('focus',show);
    hit.addEventListener('pointerleave',function(){tip.style.display='none';});hit.addEventListener('blur',function(){tip.style.display='none';});
  });
  wrap.appendChild(svg);
  // dias da semana
  const dm=Math.max(1,dMax.n),box=el('div','rank');box.style.marginTop='12px';
  [1,2,3,4,5,6,0].forEach(function(i){const d=a.porSemana[i];
    const r=el('div','rk'),t=el('div','top');t.appendChild(el('span',null,DIAS[i]));
    t.appendChild(el('span',null,d.n+(d.n===1?' venda':' vendas')+(d.n?' · '+brlC(d.cents):'')));r.appendChild(t);
    const tr=el('div','track'),b=el('div','bar');b.style.width=(d.n?Math.max(1,d.n/dm*100):0)+'%';tr.appendChild(b);r.appendChild(tr);box.appendChild(r);});
  card.appendChild(box);
  const det=el('details');det.appendChild(el('summary',null,'Ver tabela por hora'));const tb=el('table','ttab');
  const hr=el('tr');['Hora','Vendas','Faturado'].forEach(function(x){hr.appendChild(el('th',null,x));});tb.appendChild(hr);
  a.porHora.filter(function(d){return d.n;}).forEach(function(d){const tr=el('tr');[d.h+'h–'+(d.h+1)+'h',String(d.n),brlC(d.cents)].forEach(function(c){tr.appendChild(el('td',null,c));});tb.appendChild(tr);});
  det.appendChild(tb);card.appendChild(det);
  return card;
}
// clientes pelo ID do jogo
function clientesCard(c){
  const card=el('div','ccard');card.appendChild(el('h4',null,'Clientes'));
  if(!c.total){card.appendChild(el('p','sub','Sem vendas no período'));return card;}
  card.appendChild(el('p','sub','contados pelo ID do jogo · "voltaram" = já tinham comprado antes do período'));
  const k=el('div','kpis');k.style.marginBottom='8px';
  k.appendChild(kpi('Clientes',String(c.total),c.novos+' novos · '+c.voltaram+' voltaram'));
  k.appendChild(kpi('Compraram 2+ vezes',c.recompra==null?'—':Math.round(c.recompra*100)+'%','no histórico todo'));
  k.appendChild(kpi('Intervalo entre compras',c.intervaloDias==null?'—':(c.intervaloDias<1?'< 1 dia':String(c.intervaloDias).replace('.',',')+' dias'),'mediana'));
  card.appendChild(k);
  const det=el('details');det.appendChild(el('summary',null,'Melhores clientes do período'));const tb=el('table','ttab');
  const hr=el('tr');['Cliente','Compras','Total','Última'].forEach(function(x){hr.appendChild(el('th',null,x));});tb.appendChild(hr);
  c.top.forEach(function(x){const tr=el('tr');
    const td=el('td');td.appendChild(el('div',null,x.nick));const sm=el('div',null,'ID '+x.id);sm.style.color='var(--dim)';sm.style.fontSize='11px';td.appendChild(sm);tr.appendChild(td);
    [x.compras+(x.comprasTotal>x.compras?' ('+x.comprasTotal+' no total)':''),brlC(x.total),x.ultima.split('-').reverse().slice(0,2).join('/')].forEach(function(v){tr.appendChild(el('td',null,v));});
    tb.appendChild(tr);});
  det.appendChild(tb);card.appendChild(det);
  return card;
}
// como os pedidos foram entregues e por que não foram automáticos
function entregaCard(a){
  const NOMES={auto:'Automática (sem toque)',aprovado:'Aprovada por você',toque:'1 toque',manual:'Manual'};
  const card=el('div','ccard');card.appendChild(el('h4',null,'Como os pedidos foram entregues'));
  const tot=a.entregaTipos.reduce(function(s,t){return s+t.n;},0);
  card.appendChild(el('p','sub',tot?(tot+(tot===1?' entrega':' entregas')+' no período · tempo = mediana do pagamento à entrega'):'Sem entregas no período'));
  if(!tot)return card;
  const box=el('div','rank');
  a.entregaTipos.filter(function(t){return t.n;}).forEach(function(t){
    const r=el('div','rk'),tp=el('div','top');tp.appendChild(el('span',null,NOMES[t.tipo]));
    tp.appendChild(el('span',null,t.n+' · '+Math.round(t.n/tot*100)+'%'+(t.medianaMin!=null?' · '+fmtMin(t.medianaMin):'')));r.appendChild(tp);
    const tr=el('div','track'),b=el('div','bar');b.style.width=Math.max(1,t.n/tot*100)+'%';tr.appendChild(b);r.appendChild(tr);box.appendChild(r);
  });
  card.appendChild(box);
  if(a.motivos&&a.motivos.length){
    card.appendChild(el('p','sub','Por que não foram automáticos:'));
    const t=el('table','ttab');t.style.fontSize='12.5px';
    a.motivos.forEach(function(m){const tr=document.createElement('tr');tr.appendChild(el('td',null,m.motivo));tr.appendChild(el('td',null,String(m.n)));t.appendChild(tr);});
    card.appendChild(t);
  }
  return card;
}
// funil de compra: aparelhos distintos por etapa (estatística própria da loja)
function funnelCard(f){
  const NOMES={visit:'Visitaram a loja',lookup:'Buscaram o ID',select:'Escolheram um item',pix:'Geraram o Pix',paid:'Pagaram',delivered:'Receberam'};
  const card=el('div','ccard');card.appendChild(el('h4',null,'Funil de compra'));
  const base=f.etapas[0].n;
  card.appendChild(el('p','sub',base?'aparelhos distintos em cada etapa · % sobre quem visitou':'Sem visitas registradas no período (o funil começou a ser medido em 08/11/2026)'));
  if(!base&&!f.etapas.some(function(e){return e.n;}))return card;
  const box=el('div','rank');
  f.etapas.forEach(function(e,i){
    const r=el('div','rk'),t=el('div','top');
    t.appendChild(el('span',null,NOMES[e.ev]));
    const prev=i?f.etapas[i-1].n:0;
    t.appendChild(el('span',null,e.n+(base?' · '+Math.round(e.n/base*100)+'%':'')+(i&&prev?' (de '+prev+': '+Math.round(e.n/prev*100)+'%)':'')));
    r.appendChild(t);
    const tr=el('div','track'),b=el('div','bar');b.style.width=(base?Math.max(1,e.n/base*100):0)+'%';tr.appendChild(b);r.appendChild(tr);
    box.appendChild(r);
  });
  card.appendChild(box);
  const tab=function(titulo,rows,rot){
    const d=document.createElement('details');d.appendChild(el('summary',null,titulo));
    const t=el('table','ttab'),h=document.createElement('tr');
    [rot,'Visitas','Pix','Pagos','Conversão'].forEach(function(x){h.appendChild(el('th',null,x));});t.appendChild(h);
    rows.forEach(function(x){const tr=document.createElement('tr');
      [x.k==='—'?'(sem '+rot.toLowerCase()+')':x.k,String(x.visit),String(x.pix),String(x.paid),x.visit?Math.round(x.paid/x.visit*100)+'%':'—'].forEach(function(c){tr.appendChild(el('td',null,c));});
      t.appendChild(tr);});
    d.appendChild(t);return d;
  };
  card.appendChild(tab('Por cupom',f.cupons,'Cupom'));
  card.appendChild(tab('Por origem',f.origens,'Origem'));
  return card;
}
function fmtMin(m){return m<60?(m+' min'):(Math.floor(m/60)+'h'+(m%60?String(m%60).padStart(2,'0'):''));}
function niceMax(v){if(v<=0)return 100;const p=Math.pow(10,Math.floor(Math.log10(v))),n=v/p;return (n<=1?1:n<=2?2:n<=5?5:10)*p;}
function dayChart(a,r){
  const card=el('div','ccard');card.appendChild(el('h4',null,'Faturamento por dia'));
  // série contínua (dias sem venda = 0); período "Tudo": do 1º dia com venda até hoje
  const map={};a.porDia.forEach(function(d){map[d.date]=d;});
  let start=r[0]||(a.porDia[0]&&a.porDia[0].date),end=r[1]||ymd(spNow());
  let days=[];
  if(start){const s0=new Date(start+'T12:00:00'),e0=new Date(end+'T12:00:00');
    for(let t=new Date(s0);t<=e0;t.setDate(t.getDate()+1))days.push(map[ymd(t)]||{date:ymd(t),n:0,cents:0});}
  let unit='dia';
  if(days.length>62){ // agrega por mês
    const m={};days.forEach(function(d){const k=d.date.slice(0,7);(m[k]=m[k]||{date:k,n:0,cents:0});m[k].n+=d.n;m[k].cents+=d.cents;});
    days=Object.keys(m).sort().map(function(k){return m[k];});unit='mês';card.firstChild.textContent='Faturamento por mês';}
  card.appendChild(el('p','sub',days.length?('Total '+brlC(a.faturado)+' · passe o dedo/mouse nas colunas'):'Sem vendas no período'));
  if(!days.length)return card;
  const wrap=el('div','chart');card.appendChild(wrap);const tip=el('div','tip');card.appendChild(tip);
  const W=Math.max(260,($$('anaBody').clientWidth||560)-26),H=170,L=44,B=22,T=14,pw=Math.max(W-L-4,100),ph=H-B-T;
  const max=niceMax(Math.max.apply(null,days.map(function(d){return d.cents;})));
  const NS='http://www.w3.org/2000/svg';const svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 '+W+' '+H);
  svg.setAttribute('role','img');svg.setAttribute('aria-label','Faturamento por '+unit+', '+days.length+' períodos');
  function sv(tag,at){const e=document.createElementNS(NS,tag);for(const k in at)e.setAttribute(k,at[k]);return e;}
  [0,0.5,1].forEach(function(f){const y=T+ph-ph*f;svg.appendChild(sv('line',{x1:L,x2:L+pw,y1:y,y2:y,class:'grid'}));
    const t=sv('text',{x:L-6,y:y+3.5,'text-anchor':'end'});t.textContent=compactBRL(max*f);svg.appendChild(t);});
  const slot=pw/days.length,bw=Math.min(24,Math.max(2,slot-2));
  let iMax=0;days.forEach(function(d,i){if(d.cents>days[iMax].cents)iMax=i;});
  const every=Math.ceil(days.length/7);
  days.forEach(function(d,i){
    const x=L+slot*i+(slot-bw)/2,h=d.cents?Math.max(2,ph*d.cents/max):0,y=T+ph-h;
    const hit=sv('rect',{x:L+slot*i,y:T,width:slot,height:ph,class:'hit',tabindex:'0'});
    hit.setAttribute('aria-label',lbl(d)+': '+brlC(d.cents)+', '+d.n+' vendas');
    svg.appendChild(hit);
    // coluna: 4px arredondado em cima, reta na base
    const r4=Math.min(4,h,bw/2);
    svg.appendChild(sv('path',{class:'col',d:h?('M'+x+','+(T+ph)+'V'+(y+r4)+'Q'+x+','+y+' '+(x+r4)+','+y+'H'+(x+bw-r4)+'Q'+(x+bw)+','+y+' '+(x+bw)+','+(y+r4)+'V'+(T+ph)+'Z'):''}));
    if(i%every===0||i===days.length-1){const t=sv('text',{x:x+bw/2,y:H-6,'text-anchor':'middle'});t.textContent=short(d);svg.appendChild(t);}
    if(i===iMax&&d.cents){const t=sv('text',{x:x+bw/2,y:y-4,'text-anchor':'middle',class:'lbl'});t.textContent=compactBRL(d.cents);svg.appendChild(t);}
    function show(){tip.textContent='';tip.appendChild(el('b',null,brlC(d.cents)));tip.appendChild(el('span',null,lbl(d)+' · '+d.n+(d.n===1?' venda':' vendas')));
      tip.style.display='block';const cx=(x+bw/2)/W*wrap.clientWidth+12;
      tip.style.left=Math.min(cx,card.clientWidth-tip.offsetWidth-8)+'px';tip.style.top='34px';}
    hit.addEventListener('pointermove',show);hit.addEventListener('focus',show);
    hit.addEventListener('pointerleave',function(){tip.style.display='none';});hit.addEventListener('blur',function(){tip.style.display='none';});
  });
  wrap.appendChild(svg);
  // tabela (acessível, sem depender do hover)
  const det=el('details');det.appendChild(el('summary',null,'Ver tabela'));const tb=el('table','ttab');
  const hr=el('tr');['Período','Vendas','Faturado'].forEach(function(h){hr.appendChild(el('th',null,h));});tb.appendChild(hr);
  days.filter(function(d){return d.n;}).forEach(function(d){const tr=el('tr');tr.appendChild(el('td',null,lbl(d)));tr.appendChild(el('td',null,String(d.n)));tr.appendChild(el('td',null,brlC(d.cents)));tb.appendChild(tr);});
  det.appendChild(tb);card.appendChild(det);
  return card;
}
function lbl(d){return d.date.length===7?(d.date.slice(5,7)+'/'+d.date.slice(0,4)):(d.date.slice(8,10)+'/'+d.date.slice(5,7));}
function short(d){return d.date.length===7?d.date.slice(5,7)+'/'+d.date.slice(2,4):d.date.slice(8,10)+'/'+d.date.slice(5,7);}
function compactBRL(c){const v=c/100;return v>=1000?('R$'+(v/1000).toFixed(v>=10000?0:1).replace('.',',')+'k'):('R$'+Math.round(v));}
function prodRank(list){
  const card=el('div','ccard');card.appendChild(el('h4',null,'Produtos que mais dão lucro'));
  card.appendChild(el('p','sub','lucro no período (após Stars, taxa do MP e comissão de cupom) · margem = lucro ÷ faturado'));
  if(!list.length){card.appendChild(el('p','sub','Sem vendas no período'));return card;}
  const top=list.slice(0,8),max=Math.max(1,top[0].lucro),box=el('div','rank');
  top.forEach(function(p){const r=el('div','rk'),t=el('div','top');t.appendChild(el('span',null,p.nome));
    t.appendChild(el('span',null,brlC(p.lucro)+' · '+Math.round(p.margem*100)+'% · '+p.n+(p.n===1?' venda':' vendas')));r.appendChild(t);
    const tr=el('div','track'),b=el('div','bar');b.style.width=Math.max(1,Math.max(0,p.lucro)/max*100)+'%';tr.appendChild(b);r.appendChild(tr);box.appendChild(r);});
  const d=document.createElement('details');d.appendChild(el('summary',null,'Ver tabela'));
  const tb=el('table','ttab'),h=document.createElement('tr');
  ['Produto','Vendas','Faturado','Lucro','Margem'].forEach(function(x){h.appendChild(el('th',null,x));});tb.appendChild(h);
  list.forEach(function(p){const tr=document.createElement('tr');
    [p.nome,String(p.n),brlC(p.cents),brlC(p.lucro),Math.round(p.margem*100)+'%'].forEach(function(c){tr.appendChild(el('td',null,c));});tb.appendChild(tr);});
  d.appendChild(tb);card.appendChild(d);
  card.appendChild(box);
  if(list.length>8)card.appendChild(el('p','sub','+ '+(list.length-8)+' outros produtos'));
  return card;
}

render();
$$('smodal').onclick=function(e){if(e.target.id==='smodal')closeStars();};
loadStars();

