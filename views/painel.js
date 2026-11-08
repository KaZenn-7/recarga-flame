// Painel do operador (pedidos, produtos, cupons, analytics, Stars). Página única com JS inline.
// `data` = JSON dos pedidos já escapado (< → \\u003c) pelo servidor.
// ATENÇÃO: o JS do painel vive dentro deste template literal — nada de crase nem ${ sem escapar.
export const painelHtml = (data) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0e0e10">
<meta name="format-detection" content="telephone=no"><meta name="format-detection" content="date=no,address=no,email=no">
<title>Painel — Recarga Flame</title><link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png"><link rel="icon" type="image/png" sizes="192x192" href="/img/icon-192.png"><link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<style>
:root{--bg:#0e0e10;--panel:#161618;--panel2:#1c1c1f;--line:#2a2a2e;--txt:#f4f4f5;--mut:#9b9ba3;--dim:#6c6c74;--orange:#ff5a1f;--green:#3fb950;--red:#f85149;--gold:#e3b341;--blue:#4493f8}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{font:15px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;margin:0;background:var(--bg);color:var(--txt)}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
header{position:sticky;top:0;z-index:9;background:rgba(14,14,16,.95);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.htop{display:flex;align-items:center;gap:10px;padding:14px 16px}
.mark{width:26px;height:26px;border-radius:6px;display:block}
.htop b{font-size:15px}.htop .rf{margin-left:auto;font-size:13px;color:var(--mut);background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:6px 11px;cursor:pointer}
.tabs{display:flex;gap:4px;padding:0 10px 10px;overflow-x:auto}
.tab{flex-shrink:0;border:0;background:transparent;color:var(--mut);font:inherit;font-weight:600;padding:8px 12px;border-radius:7px;cursor:pointer;white-space:nowrap}
.tab.on{background:var(--panel);color:var(--txt)}
.tab .c{display:inline-block;min-width:18px;margin-left:5px;padding:0 5px;font-size:12px;font-weight:700;border-radius:99px;background:var(--panel2);color:var(--mut)}
.tab.on .c{background:var(--orange);color:#160a04}
.search{padding:10px 16px}.search input{width:100%;padding:10px 13px;border:1px solid var(--line);background:var(--panel);color:var(--txt);border-radius:8px;font:inherit}
.search input::placeholder{color:var(--dim)}.search input:focus{outline:0;border-color:#45454c}
main{max-width:620px;margin:0 auto;padding:6px 16px 48px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:14px;margin-bottom:11px}
.chead{display:flex;align-items:center;gap:7px;margin-bottom:11px}
.bdg{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:3px 8px;border-radius:5px}
.bdg.pending{background:rgba(227,179,65,.14);color:var(--gold)}.bdg.paid{background:rgba(68,147,248,.14);color:var(--blue)}
.bdg.delivered{background:rgba(63,185,80,.14);color:var(--green)}.bdg.cancelled{background:rgba(155,155,163,.12);color:var(--mut)}.bdg.reversed{background:rgba(248,81,73,.14);color:var(--red)}
.oid{margin-left:auto;color:var(--dim);font-weight:700}
.body{display:flex;gap:13px}
.av{width:56px;height:56px;border-radius:9px;object-fit:cover;background:#242428;flex-shrink:0}
.info{min-width:0;flex:1}.info .pn{font-weight:700;font-size:15px}
.info .nk{color:var(--txt);margin-top:2px}.info .meta{font-size:12.5px;color:var(--mut);margin-top:4px;word-break:break-all}
.info .meta b{color:var(--txt)}
.price{text-align:right;flex-shrink:0}.price .v{font-weight:800;font-size:16px}.price .s{font-size:11.5px;color:var(--gold);margin-top:2px}
.times{font-size:12px;color:var(--dim);margin-top:11px;padding-top:11px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:4px 14px}
.acts{display:flex;gap:8px;margin-top:11px}
.acts a,.acts button{flex:1;text-align:center;text-decoration:none;padding:11px;border-radius:8px;font:inherit;font-weight:700;cursor:pointer;border:0}
.a-tg{background:#229ED9;color:#fff}.a-ok{background:var(--green);color:#06240f}
.empty{text-align:center;color:var(--dim);padding:70px 16px}
/* nav topo */
.nav{display:flex;gap:4px;padding:0 10px}
.nav button{flex:1;border:0;background:transparent;color:var(--mut);font:inherit;font-weight:700;padding:12px;border-bottom:2px solid transparent;cursor:pointer}
.nav button.on{color:var(--txt);border-bottom-color:var(--orange)}
/* produtos */
.padd{padding:12px 16px}
.newbtn{width:100%;padding:13px;border:1px dashed var(--line);background:var(--panel);color:var(--orange);border-radius:10px;font:inherit;font-weight:700;cursor:pointer}
.prow{display:flex;gap:12px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px;margin-bottom:10px}
.prow img{width:52px;height:52px;border-radius:8px;object-fit:cover;background:#242428;flex-shrink:0}
.prow .pi{flex:1;min-width:0}.prow .pi .nm{font-weight:700}.prow .pi .sub{font-size:12.5px;color:var(--mut);margin-top:2px;word-break:break-all}
.prow .pi .sub b{color:var(--txt)}
.prow .rt{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0}
.prow .pr{font-weight:800;font-family:ui-monospace,Menlo,monospace}
.sw{position:relative;width:42px;height:24px;border-radius:99px;background:#33333a;cursor:pointer;transition:.15s;border:0;flex-shrink:0}
.sw.on{background:var(--green)}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.15s}
.sw.on::after{left:20px}
.prow .ops{display:flex;gap:6px}
.prow .ops button{border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:7px;padding:7px 11px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.prow .ops .del{color:var(--red);border-color:rgba(248,81,73,.3)}
.pinact{opacity:.55}
.prow .mg{font-size:12px;color:var(--green);margin-top:-4px;font-weight:600;white-space:nowrap}.prow .mg.low{color:var(--gold)}.prow .mg.neg{color:var(--red)}
.mgprev{font-size:12.5px;color:var(--green);margin:-4px 0 12px;font-weight:600;min-height:16px}.mgprev.low{color:var(--gold)}.mgprev.neg{color:var(--red)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.chips button{flex-shrink:0;border:1px solid var(--line);background:var(--panel);color:var(--mut);font:inherit;font-size:13px;font-weight:600;padding:7px 11px;border-radius:99px;cursor:pointer}
.chips button.on{background:var(--txt);color:var(--bg);border-color:var(--txt)}
#anaBody.loading{opacity:.5;transition:opacity .15s}
.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:9px;margin-bottom:12px}
@media(min-width:560px){.kpis{grid-template-columns:repeat(3,1fr)}}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:11px 12px;min-width:0}
.kpi .l{font-size:12px;color:var(--mut)}.kpi .v{font-size:20px;font-weight:700;margin-top:2px;line-height:1.2}
.kpi .s{font-size:11.5px;color:var(--dim);margin-top:3px}
.ccard{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px 12px 10px;margin-bottom:12px;position:relative}
.ccard h4{margin:0 0 2px;font-size:14px}.ccard .sub{font-size:12px;color:var(--mut);margin:0 0 8px}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.chart .col{fill:#f05420}.chart .hit{fill:transparent;cursor:pointer;outline:none}
.chart .hit:hover+.col,.chart .hit:focus+.col{fill:#ff7a4d}
.chart .grid{stroke:#2a2a2e;stroke-width:1}.chart text{fill:#9b9ba3;font-size:10.5px;font-family:inherit}
.chart .lbl{fill:#f4f4f5;font-weight:700}
.tip{position:absolute;pointer-events:none;background:#0e0e10;border:1px solid #45454c;border-radius:8px;padding:7px 9px;font-size:12px;white-space:nowrap;display:none;z-index:5}
.tip b{display:block;font-size:14px;color:var(--txt)}.tip span{color:var(--mut)}
.rank{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.rk .top{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}.rk .top span:first-child{color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk .top span:last-child{color:var(--mut);flex-shrink:0}
.rk .track{height:10px;margin-top:4px}.rk .bar{height:10px;background:#f05420;border-radius:0 4px 4px 0;min-width:2px}
.ccard details{margin-top:8px;font-size:12.5px}.ccard summary{cursor:pointer;color:var(--mut)}
.ttab{width:100%;border-collapse:collapse;margin-top:6px;font-variant-numeric:tabular-nums}
.ttab td,.ttab th{padding:5px 4px;border-top:1px solid var(--line);text-align:right}.ttab td:first-child,.ttab th:first-child{text-align:left}
.ttab th{color:var(--mut);font-weight:600}
.cuptag.off{background:rgba(248,81,73,.14);color:var(--red)}
.cuptag{display:inline-block;margin-left:7px;font-size:10.5px;font-weight:700;padding:2px 6px;border-radius:5px;background:rgba(63,185,80,.14);color:var(--green);vertical-align:2px}
.rephead{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.rephead select{background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:7px;padding:6px 9px;font:inherit;font-size:13px}
.rep{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px 14px;margin-bottom:9px}
.rep .top{display:flex;justify-content:space-between;font-weight:700}.rep .top .due{color:var(--gold)}
.rep .nums{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--mut);margin-top:6px}.rep .nums b{color:var(--txt)}
.hint{font-size:11.5px;color:var(--dim)}
.sync{font-size:11px;color:var(--dim);padding:0 14px 7px}
.htop .st{color:var(--gold);font-weight:700}.htop .st.lo{color:#160a04;background:var(--gold);border-color:var(--gold)}.htop .st.no{color:#fff;background:var(--red);border-color:var(--red)}
@media(max-width:400px){#htitle{display:none}}
.sbar{margin:10px 14px 0;padding:10px 12px;border-radius:9px;background:rgba(227,179,65,.12);border:1px solid rgba(227,179,65,.4);font-size:13px;display:flex;align-items:center;gap:10px}
.sbar span{flex:1}.sbar button{border:0;border-radius:7px;padding:7px 10px;font:inherit;font-size:13px;font-weight:700;background:var(--gold);color:#160a04;cursor:pointer}
.nost{display:inline-block;margin-left:7px;font-size:10.5px;font-weight:700;padding:2px 6px;border-radius:5px;background:rgba(227,179,65,.18);color:var(--gold);vertical-align:1px}
.serr{color:var(--red)}
.ssec{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:16px 0 6px;font-weight:700}
.sbig{font-size:34px;font-weight:800;line-height:1.1;color:var(--gold)}.ssub{font-size:13px;color:var(--mut);margin:4px 0 14px}
.sacts{display:flex;gap:8px;margin-bottom:14px}.sacts button{flex:1;padding:11px;border-radius:9px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);font:inherit;font-weight:700;cursor:pointer}
.sacts .pri{background:var(--orange);color:#160a04;border-color:var(--orange)}
.smov{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
.smov td{padding:6px 4px;border-top:1px solid var(--line)}.smov td.n{text-align:right;font-weight:700}.smov .p{color:var(--green)}.smov .m{color:var(--mut)}
.smov .undo{background:none;border:0;color:var(--red);font:inherit;font-size:12px;cursor:pointer;padding:0}
.wait{margin-left:auto;margin-right:8px;font-size:11.5px;font-weight:700;color:var(--mut)}
.wait.w2{color:var(--gold)}.wait.w3{color:var(--red)}
#backbar{position:fixed;left:0;right:0;bottom:0;z-index:40;background:var(--panel);border-top:1px solid var(--line);padding:12px 14px calc(12px + env(safe-area-inset-bottom));display:none;box-shadow:0 -8px 24px rgba(0,0,0,.45)}
#backbar.on{display:block}#backbar p{margin:0 0 9px;font-size:14px}#backbar .bb{display:flex;gap:8px}
#backbar button{flex:1;padding:12px;border-radius:9px;border:0;font:inherit;font-weight:700;cursor:pointer}
#backbar .y{background:var(--green);color:#06240f}#backbar .n{background:var(--panel2);color:var(--mut);border:1px solid var(--line)}
.chk{margin:10px 14px 0;padding:8px 11px;border-radius:8px;font-size:12.5px;background:var(--panel2);border:1px solid var(--line);color:var(--mut)}
.chk.ok{background:rgba(63,185,80,.1);border-color:rgba(63,185,80,.35);color:var(--txt)}
.chk.diverge{background:rgba(248,81,73,.1);border-color:rgba(248,81,73,.4);color:var(--txt)}
.chk.erro{background:rgba(227,179,65,.1);border-color:rgba(227,179,65,.4);color:var(--txt)}
.a-pay{background:var(--gold);color:#160a04}
.lims{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px}
.lims label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--mut);font-weight:600}
.lims input{width:100%;padding:9px 10px;border:1px solid var(--line);background:var(--bg);color:var(--txt);border-radius:8px;font:inherit;font-size:14px}
.lims button{grid-column:1/-1;padding:10px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:8px;font:inherit;font-weight:700;cursor:pointer}
.seg{display:flex;gap:4px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:3px}
.seg button{flex:1;border:0;background:none;color:var(--mut);font:inherit;font-size:13px;font-weight:700;padding:8px 4px;border-radius:7px;cursor:pointer}
.seg button.on{background:var(--txt);color:var(--bg)}
.aprow{display:flex;align-items:center;gap:10px;margin:0 0 14px;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg)}
.aprow div{flex:1;font-size:13px}.aprow b{display:block;font-size:14px}.aprow span{color:var(--mut)}
.rechk{background:none;border:0;color:var(--blue);font:inherit;font-size:12px;cursor:pointer;padding:0;margin-left:4px}
.risk{margin:10px 14px 0;padding:9px 11px;border-radius:8px;background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.35);font-size:12.5px}
.risk b{display:block;color:var(--red);margin-bottom:2px}.risk span{display:block;color:var(--txt)}
.blk{flex:1;align-self:center;color:var(--red);font-size:13px;font-weight:700}
.a-unb{border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:9px;padding:11px 14px;font:inherit;font-weight:700;cursor:pointer}
.card.new{border-color:var(--orange);box-shadow:0 0 0 1px var(--orange) inset}
.newtag{display:inline-block;margin-left:7px;font-size:10.5px;font-weight:700;padding:2px 6px;border-radius:5px;background:var(--orange);color:#160a04;vertical-align:1px}
.rep .tot{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--mut);margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}.rep .tot b{color:var(--txt)}
.rep .ops{display:flex;gap:6px;margin-top:10px}
.rep .ops button{border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:7px;padding:7px 11px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.rep .top .ok{color:var(--green)}
.rep details{margin-top:8px;font-size:12.5px}.rep summary{cursor:pointer;color:var(--mut)}
.rep .undo{background:none;border:0;color:var(--red);font:inherit;font-size:12px;cursor:pointer;padding:0}
/* modal */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:flex-end;justify-content:center;z-index:50}
.modal.on{display:flex}
.sheet{background:var(--panel);border:1px solid var(--line);border-radius:16px 16px 0 0;width:100%;max-width:560px;max-height:92vh;overflow:auto;padding:20px 18px calc(20px + env(safe-area-inset-bottom))}
.sheet h3{margin:0 0 16px;font-size:17px}
.fg{margin-bottom:13px}.fg label{display:block;font-size:12.5px;color:var(--mut);margin-bottom:5px}
.fg input,.fg select{width:100%;padding:11px 12px;border:1px solid var(--line);background:var(--bg);color:var(--txt);border-radius:8px;font:inherit}
.fg input:focus,.fg select:focus{outline:0;border-color:#45454c}
.fg .hint{font-size:11.5px;color:var(--dim);margin-top:4px}
.frow{display:flex;gap:11px}.frow .fg{flex:1}
.fchk{display:flex;align-items:center;gap:10px;margin:4px 0 16px}
.fchk span{font-size:14px}
.mbtns{display:flex;gap:9px;margin-top:6px}
.mbtns button{flex:1;padding:13px;border:0;border-radius:9px;font:inherit;font-weight:700;cursor:pointer}
.mbtns .save{background:var(--orange);color:#160a04}.mbtns .cancel{background:var(--panel2);color:var(--mut);border:1px solid var(--line)}
.merr{color:var(--red);font-size:13px;margin-top:10px;min-height:16px;text-align:center}
</style></head><body>
<header>
  <div class="htop"><img class="mark" src="/img/brand-mark.png" alt="" width="26" height="26"><b id="htitle">Painel</b><button class="rf st" id="stBtn" onclick="openStars()" title="Saldo de Stars">★ …</button><button class="rf" id="rfBtn" style="margin-left:6px" onclick="refreshView()">Atualizar</button><button class="rf" style="margin-left:6px" onclick="fetch('/logout',{method:'POST'}).then(()=>location.href='/login')">Sair</button></div>
  <div class="nav">
    <button id="navPed" class="on" onclick="setView('pedidos')">Pedidos</button>
    <button id="navProd" onclick="setView('produtos')">Produtos</button>
    <button id="navCup" onclick="setView('cupons')">Cupons</button>
    <button id="navAna" onclick="setView('analytics')">Analytics</button>
  </div>
  <div id="hdrPed">
    <div class="tabs" id="tabs"></div>
    <div class="search"><input id="q" placeholder="Buscar por nick, ID ou nº do pedido…" autocomplete="off"></div>
    <div class="sync" id="sync">Atualiza sozinho a cada 15 s</div>
  </div>
</header>
<div id="sbarBox"></div>
<main id="viewPed"></main>
<div class="modal" id="smodal">
  <div class="sheet">
    <h3>Saldo de Stars</h3>
    <div id="sBody"><div class="empty">Carregando…</div></div>
    <div class="mbtns"><button class="cancel" onclick="closeStars()">Fechar</button></div>
  </div>
</div>
<div id="backbar" role="dialog" aria-live="polite"><p id="bbtxt"></p><div class="bb"><button class="n" onclick="closeBack()">Ainda não</button><button class="y" onclick="yesBack()">✅ Sim, marcar entregue</button></div></div>
<main id="viewAna" style="display:none">
  <div class="padd">
    <div class="chips" id="anaPer" role="group" aria-label="Período">
      <button data-p="d0">Hoje</button><button data-p="d7">7 dias</button><button data-p="d30" class="on">30 dias</button>
      <button data-p="m0">Este mês</button><button data-p="m1">Mês passado</button><button data-p="all">Tudo</button>
    </div>
    <div id="anaBody"><div class="empty">Carregando…</div></div>
  </div>
</main>
<main id="viewCup" style="display:none">
  <div class="padd">
    <div class="rephead"><b>Comissões</b><select id="repPer" onchange="loadRep()"><option value="m0">Este mês</option><option value="m1">Mês passado</option><option value="all">Tudo</option></select></div>
    <div id="repBox"><div class="empty">Carregando…</div></div>
    <p class="hint" style="margin:8px 2px 18px">Conta só pedidos pagos ou entregues. Lucro = valor pago − Stars (custo) − taxa do MP. Comissão = % do lucro, com o % que valia no dia da venda. O período muda só a primeira linha; <b>a pagar</b> = ganho total − pagamentos registrados.</p>
    <button class="newbtn" onclick="openCup()">+ Novo cupom</button>
  </div>
  <div id="cupList" class="padd" style="padding-top:0"></div>
</main>
<div class="modal" id="cmodal">
  <div class="sheet">
    <h3 id="ctitle">Novo cupom</h3>
    <div class="fg"><label>Código</label><input id="c_code" placeholder="ex.: AQUILA" autocomplete="off" style="text-transform:uppercase"><div class="hint">A-Z, 0-9, _ ou -. Link: <span class="mono" id="c_link"></span></div></div>
    <div class="frow">
      <div class="fg"><label>Desconto ao cliente (%)</label><input id="c_desc" inputmode="decimal" placeholder="5"></div>
      <div class="fg"><label>Comissão (% do lucro)</label><input id="c_com" inputmode="decimal" placeholder="20"></div>
    </div>
    <div class="fg"><label>Nota (opcional)</label><input id="c_nota" placeholder="ex.: youtuber aquilagado" autocomplete="off"></div>
    <label class="fchk"><button type="button" class="sw" id="c_ativo" onclick="this.classList.toggle('on');cupAtivoTxt()"></button><span id="c_ativo_txt">Ativo — já pode ser usado</span></label>
    <p class="merr" id="cerr"></p>
    <div class="mbtns"><button class="cancel" onclick="closeCup()">Cancelar</button><button class="save" id="csave" onclick="saveCup()">Salvar</button></div>
  </div>
</div>
<main id="viewProd" style="display:none">
  <div class="padd"><button class="newbtn" onclick="openForm()">+ Novo produto</button></div>
  <div id="prodList" class="padd" style="padding-top:0"></div>
</main>

<div class="modal" id="modal">
  <div class="sheet">
    <h3 id="mtitle">Novo produto</h3>
    <div class="fg"><label>Chave (identificador único)</label><input id="f_key" placeholder="ex.: c1000" autocomplete="off"><div class="hint">Só a-z, 0-9 e _. Não pode mudar depois de criado.</div></div>
    <div class="fg"><label>Nome exibido</label><input id="f_nome" placeholder="ex.: 1.000 Coins" autocomplete="off"></div>
    <div class="frow">
      <div class="fg"><label>Preço (R$)</label><input id="f_preco" inputmode="decimal" placeholder="3,50" autocomplete="off"></div>
      <div class="fg"><label>Stars (interno)</label><input id="f_stars" inputmode="numeric" placeholder="26" autocomplete="off"></div>
    </div>
    <div class="mgprev" id="f_mg"></div>
    <div class="fg"><label>Código do link Telegram</label><input id="f_code" placeholder="ex.: c_1000" autocomplete="off"><div class="hint">Vira s_&lt;código&gt;_&lt;ID&gt; no link do bot.</div></div>
    <div class="frow">
      <div class="fg"><label>Tipo (regra de bloqueio)</label><select id="f_tipo">
        <option value="">Nenhum (Coins)</option>
        <option value="wildfire">Wildfire</option>
        <option value="arsenal">Arsenal Pass</option>
        <option value="gold">Gold Pass</option>
      </select></div>
      <div class="fg"><label>Níveis de passe</label><input id="f_niveis" inputmode="numeric" placeholder="0" autocomplete="off"><div class="hint">0 se não for nível.</div></div>
    </div>
    <div class="fg"><label>Imagem (URL/caminho)</label><input id="f_img" placeholder="/img/c1000.jpg" autocomplete="off"></div>
    <label class="fchk"><button type="button" class="sw" id="f_ativo" onclick="this.classList.toggle('on')"></button><span>Ativo (aparece na loja)</span></label>
    <p class="merr" id="merr"></p>
    <div class="mbtns"><button class="cancel" onclick="closeForm()">Cancelar</button><button class="save" id="msave" onclick="saveForm()">Salvar</button></div>
  </div>
</div>
<script>
const ORDERS=${data};
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
    \`<button class="tab \${s===cur?'on':''}" data-s="\${s}">\${LABEL[s]}<span class="c">\${count(s)}</span></button>\`).join('');
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{cur=b.dataset.s;location.hash=cur;render();});
}
function card(o){
  const tl=[];
  if(o.created)tl.push('Criado '+o.created);
  if(o.paid)tl.push('Pago '+o.paid);
  if(o.delivered)tl.push('Entregue '+o.delivered);
  let acts='';
  if(o.status==='paid'){
    acts=\`<div class="acts">\${o.tg?\`<a class="a-tg" href="\${esc(o.tg)}" target="_blank" rel="noopener" onclick="backFrom=\${o.id}">Abrir no Telegram · \${o.stars}★</a>\`:''}
      <button class="a-ok" onclick="deliver(\${o.id})">Marcar entregue</button></div>\`;
  }
  if(o.status==='paid'&&o.canPay&&o.canPay.ok)acts=acts.replace('<div class="acts">','<div class="acts"><button class="a-pay" onclick="payNow('+o.id+',this)">⭐ Pagar '+o.stars+'★</button>');
  else if(o.status==='paid'&&o.canApprove)acts=acts.replace('<div class="acts">','<div class="acts"><button class="a-pay" onclick="approveNow('+o.id+',this)">✅ Aprovar e pagar</button>');
  const apb=o.status!=='paid'?(o.ap==='incerto'?'<div class="chk">Pagamento automático ficou incerto — resolvido manualmente.</div>':''):
    o.ap==='incerto'?'<div class="chk diverge">🚨 Pagamento incerto: '+esc((o.apInfo&&o.apInfo.erro)||'')+'. <button class="rechk" onclick="verifyPay('+o.id+',this)">🔍 verificar cobrança</button></div>':
    o.ap==='paying'?'<div class="chk wait">⏳ Pagando no bot…</div>':
    o.ap==='erro'?'<div class="chk erro">Pagamento não feito: '+esc((o.apInfo&&o.apInfo.erro)||'')+' — pague de novo ou entregue na mão e toque em Marcar entregue.</div>':
    o.ap==='sent'?'<div class="chk ok">⭐ Pago no bot ('+((o.apInfo&&o.apInfo.stars)||'')+'★)'+(o.apInfo&&o.apInfo.botReply?' · '+esc(o.apInfo.botReply):'')+'</div>':'';
  if(o.blocked)acts='<div class="acts"><span class="blk">🚫 Cliente bloqueado</span><button class="a-unb" onclick="unblock('+o.id+')">Desbloquear</button></div>';
  const ck=o.chk;
  const chk=o.status!=='paid'||!o.chkOn?'':'<div class="chk '+(ck?ck.status:'wait')+'">'+(
    !ck?'🔎 Conferindo no bot do CF…':
    ck.status==='ok'?'🔎 Conferido no bot: <b>'+ck.stars+'★</b> · '+esc(ck.account)+' · '+esc(ck.produto||'')+' ✅':
    ck.status==='diverge'?'❌ Conferência não bateu: '+esc(ck.motivo):
    '⚠ Conferência falhou: '+esc(ck.motivo))+
    ' <button class="rechk" onclick="recheck('+o.id+',this)">conferir de novo</button></div>';
  const risk=(o.risk&&o.risk.length)?'<div class="risk"><b>⚠ Revisar antes de entregar</b>'+o.risk.map(function(r){return '<span>· '+esc(r)+'</span>';}).join('')+'</div>':'';
  return \`<div class="card\${NEWS.has(o.id)?' new':''}">
    <div class="chead"><span class="bdg \${o.status}">\${BADGE[o.status]}</span>\${NEWS.has(o.id)?'<span class="newtag">NOVO</span>':''}\${waitTag(o)}\${NOST.has(o.id)?'<span class="nost">SEM STARS</span>':''}<span class="oid">#\${o.id}</span></div>
    <div class="body">
      <img class="av" src="/api/player/\${esc(o.gameId)}/avatar" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="info">
        <div class="pn">\${esc(o.nome)}\${o.cup?'<span class="cuptag">'+esc(o.cup)+'</span>':''}</div>
        <div class="nk">\${esc(o.nick)}</div>
        <div class="meta">ID <b class="mono">\${esc(o.gameId)}</b> · \${esc(o.email)}</div>
      </div>
      <div class="price"><div class="v mono">\${brl(o.cents)}</div><div class="s">\${o.stars}★ Stars</div></div>
    </div>
    \${tl.length?\`<div class="times">\${tl.map(t=>'<span>'+esc(t)+'</span>').join('')}</div>\`:''}
    \${chk}\${apb}\${risk}\${acts}
  </div>\`;
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
    \`<div class="empty">Nenhum pedido \${LABEL[cur].toLowerCase()}\${q?' para "'+esc(q)+'"':''}.</div>\`;
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
        if(m[0]==='2'&&!confirm('Ligar a entrega AUTOMÁTICA?\\n\\nA loja vai pagar sozinha, sem você tocar, todo pedido com conferência ✅, sem REVISAR, dentro dos tetos e com saldo. Os outros ficam para entrega manual e você é avisado no Telegram.'))return;
        if(m[0]==='1'&&!confirm('Ligar o pagamento com 1 toque?\\n\\nO botão Pagar aparece só em pedidos com conferência ✅, sem REVISAR e dentro dos tetos. Cada pagamento pede confirmação.'))return;
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
  const v=prompt('Quantas Stars você comprou?\\n\\n(Só para calcular o custo — o saldo continua vindo do Telegram.)','');if(v==null)return;
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
  const rk=ob&&ob.risk&&ob.risk.length?'\\n\\n⚠ REVISAR: '+ob.risk.join('; ')+'\\n\\nConfira no app do Mercado Pago se o Pix caiu e quem pagou. Na dúvida, fale com o cliente antes.':'';
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
async function approveNow(id,btn){
  const o=ORDERS.find(function(x){return x.id===id;});if(!o)return;
  if(!confirm('APROVAR E PAGAR o pedido #'+id+'?\\n\\nEm revisão por: '+(o.risk||[]).join('; ')+'\\n\\nSó aprove se conferiu o Pix de '+brl(o.cents)+' no app do Mercado Pago.\\n\\nVai pagar '+o.stars+'★ da conta separada: '+o.nome+' para '+o.nick+' (ID '+o.gameId+').'))return;
  btn.disabled=true;btn.textContent='Pagando…';
  try{const r=await api('/api/admin/orders/'+id+'/aprovar',{method:'POST'});alert('Aprovado, pago ('+r.stars+'★) e marcado como entregue.'+(r.botReply?'\\n\\nBot do CF: '+r.botReply:''));}
  catch(e){alert(e.message);}
  refreshOrders(false);loadStars();
}
async function payNow(id,btn){
  const o=ORDERS.find(function(x){return x.id===id;});if(!o)return;
  if(!confirm('Pagar '+o.stars+'★ da conta separada no bot do CounterFlame?\\n\\n'+o.nome+' para '+o.nick+' (ID '+o.gameId+')\\n\\nA fatura é conferida de novo antes de pagar.'))return;
  btn.disabled=true;btn.textContent='Pagando…';
  try{const r=await api('/api/admin/orders/'+id+'/autopay',{method:'POST'});alert('Pago ('+r.stars+'★) e marcado como entregue.'+(r.botReply?'\\n\\nBot do CF: '+r.botReply:''));}
  catch(e){alert(e.message);}
  refreshOrders(false);loadStars();
}
async function verifyPay(id,btn){
  btn.disabled=true;btn.textContent='verificando…';
  try{
    const r=await api('/api/admin/orders/'+id+'/verify',{method:'POST'});
    if(r.cobrado){
      if(confirm('FOI COBRADO: a fatura deste pedido no bot do CounterFlame (mensagem '+r.fatura+') tem recibo de pagamento de '+r.stars+'★.\\n\\nConfira se o item chegou na conta do cliente. Marcar o pedido #'+id+' como entregue (o cliente recebe o e-mail)?'))
        await api('/api/admin/orders/'+id+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'entregue'})});
    }else{
      if(confirm('NÃO foi cobrado: '+(r.semFatura?'a tentativa falhou antes de chegar à fatura':'a fatura deste pedido (mensagem '+r.fatura+') não tem recibo de pagamento')+'.\\n\\nLiberar uma nova tentativa (o botão Pagar volta)? Se preferir, entregue na mão e toque em Marcar entregue.'))
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
  document.getElementById('viewAna').style.display=ana?'':'none';
  document.getElementById('htitle').textContent=ped?'Painel de pedidos':prod?'Produtos':cup?'Cupons':'Analytics';
  if(prod)loadProds();
  if(cup){loadCups();loadRep();}
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
  document.getElementById('prodList').innerHTML=PRODS.map(p=>\`
    <div class="prow \${p.ativo?'':'pinact'}">
      <img src="\${esc(p.img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="pi">
        <div class="nm">\${esc(p.nome)}</div>
        <div class="sub">\${esc(catName(p))} · chave <b>\${esc(p.key)}</b> · cód <b>\${esc(p.code)}</b> · \${p.stars}★</div>
      </div>
      <div class="rt">
        <div class="pr">\${brlFromCents(p.cents)}</div>
        <div class="mg \${p.margem<0?'neg':p.margem<0.15?'low':''}" title="lucro por venda e margem, com o custo atual da Star">lucro \${brlFromCents(p.lucro)} · \${Math.round(p.margem*100)}%\${p.margem<0?' · PREJUÍZO':''}</div>
        <button class="sw \${p.ativo?'on':''}" title="Ativo na loja" onclick="toggle('\${esc(p.key)}')"></button>
        <div class="ops"><button onclick="openForm('\${esc(p.key)}')">Editar</button><button class="del" onclick="delProd('\${esc(p.key)}','\${esc(p.nome)}')">Excluir</button></div>
      </div>
    </div>\`).join('')||'<div class="empty">Nenhum produto. Crie o primeiro.</div>';
}
async function toggle(key){
  try{const r=await api('/api/admin/products/'+key+'/ativo',{method:'PATCH'});
    const p=PRODS.find(x=>x.key===key);if(p)p.ativo=r.ativo;renderProds();}
  catch(e){alert(e.message);}
}
async function delProd(key,nome){
  if(!confirm('Excluir o produto "'+nome+'"?\\n\\nPedidos antigos não são afetados.'))return;
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
let CUPS=[],editCup=null;
const pct=n=>String(n).replace('.',',')+'%';
async function loadCups(){
  try{CUPS=await api('/api/admin/coupons');renderCups();}
  catch(e){$$('cupList').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
function renderCups(){
  $$('cupList').innerHTML=CUPS.map(function(c){
    return '<div class="prow"><div class="pi"><div class="nm mono">'+esc(c.code)+(c.ativo?'<span class="cuptag">ATIVO</span>':'<span class="cuptag off">INATIVO</span>')+'</div>'+
      '<div class="sub">desconto <b>'+pct(c.desconto_pct)+'</b> · comissão <b>'+pct(c.comissao_pct)+'</b> do lucro'+(c.nota?' · '+esc(c.nota):'')+'</div>'+
      '<div class="sub mono">'+esc(location.origin+'/?cupom='+c.code)+'</div></div>'+
      '<div class="rt"><button class="sw '+(c.ativo?'on':'')+'" title="Ativar/desativar" data-tog="'+esc(c.code)+'"></button>'+
      '<div class="ops"><button data-copy="'+esc(c.code)+'">Copiar link</button><button data-edit="'+esc(c.code)+'">Editar</button></div></div></div>';
  }).join('')||'<div class="empty">Nenhum cupom ainda.</div>';
  $$('cupList').querySelectorAll('[data-copy]').forEach(function(b){b.onclick=function(){copyCup(b.dataset.copy);};});
  $$('cupList').querySelectorAll('[data-edit]').forEach(function(b){b.onclick=function(){openCup(b.dataset.edit);};});
  $$('cupList').querySelectorAll('[data-tog]').forEach(function(b){b.onclick=function(){togCup(b.dataset.tog);};});
}
async function togCup(code){
  const c=CUPS.find(function(x){return x.code===code;});if(!c)return;
  try{await api('/api/admin/coupons/'+code,{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({desconto_pct:c.desconto_pct,comissao_pct:c.comissao_pct,nota:c.nota,ativo:!c.ativo})});
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
async function loadRep(){
  $$('repBox').innerHTML='<div class="empty">Carregando…</div>';
  try{const r=await api('/api/admin/coupons/report'+perRange());
    $$('repBox').innerHTML=r.cupons.map(function(c){
      const st=c.saldo>0?'<span class="due">a pagar '+brlFromCents(c.saldo)+'</span>':
        c.saldo<0?'<span class="due">crédito '+brlFromCents(-c.saldo)+'</span>':'<span class="ok">em dia ✓</span>';
      const pays=c.pagamentos.map(function(p){
        return '<tr><td>'+esc(p.data.split('-').reverse().join('/'))+'</td><td>'+brlFromCents(p.cents)+'</td><td style="text-align:left">'+esc(p.nota)+'</td>'+
          '<td><button class="undo" data-undo="'+p.id+'" data-v="'+esc(brlFromCents(p.cents))+'">desfazer</button></td></tr>';
      }).join('');
      return '<div class="rep"><div class="top"><span class="mono">'+esc(c.code)+'</span>'+st+'</div>'+
        '<div class="nums"><span><b>'+c.visitas+'</b> visitas pelo link</span><span><b>'+c.pedidos+'</b> vendas</span>'+
        '<span>conversão <b>'+(c.conversao==null?'—':Math.round(c.conversao*100)+'%')+'</b></span></div>'+
        '<div class="nums"><span>faturado <b>'+brlFromCents(c.faturado)+'</b></span>'+
        '<span>descontos <b>'+brlFromCents(c.desconto)+'</b></span><span>lucro <b>'+brlFromCents(c.lucro)+'</b></span>'+
        '<span>comissão <b>'+brlFromCents(c.comissao)+'</b></span><span>fica para a loja <b>'+brlFromCents(c.lucroLoja)+'</b></span></div>'+
        '<div class="tot"><span>ganho total <b>'+brlFromCents(c.total)+'</b></span><span>já pago <b>'+brlFromCents(c.pago)+'</b></span><span>hoje '+pct(c.comissao_pct)+' do lucro</span></div>'+
        '<div class="ops"><button data-pay="'+esc(c.code)+'" data-saldo="'+Math.max(0,c.saldo)+'">Registrar pagamento</button></div>'+
        (pays?'<details><summary>Pagamentos feitos ('+c.pagamentos.length+')</summary><table class="ttab"><tr><th>Data</th><th>Valor</th><th style="text-align:left">Obs.</th><th></th></tr>'+pays+'</table></details>':'')+
        '</div>';
    }).join('')||'<div class="empty" style="padding:24px">Nenhuma venda com cupom ainda.</div>';
    $$('repBox').querySelectorAll('[data-pay]').forEach(function(b){b.onclick=function(){payCup(b.dataset.pay,Number(b.dataset.saldo));};});
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
  const nota=prompt('Observação (opcional), ex.: Pix 07/11','');
  if(nota==null)return;
  try{await api('/api/admin/coupons/'+code+'/payouts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cents:cents,nota:nota})});loadRep();}
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
  $$('c_com').value=c?String(c.comissao_pct).replace('.',','):'20';
  $$('c_nota').value=c?(c.nota||''):'';
  $$('c_ativo').classList.toggle('on',c?!!c.ativo:true);
  $$('cerr').textContent='';cupLink();cupAtivoTxt();$$('cmodal').classList.add('on');
}
function cupAtivoTxt(){$$('c_ativo_txt').textContent=$$('c_ativo').classList.contains('on')?'Ativo — já pode ser usado':'Inativo — o link não dá desconto';}
function cupLink(){$$('c_link').textContent=location.origin+'/?cupom='+($$('c_code').value.trim().toUpperCase()||'CODIGO');}
$$('c_code').oninput=cupLink;
function closeCup(){$$('cmodal').classList.remove('on');}
$$('cmodal').onclick=function(e){if(e.target.id==='cmodal')closeCup();};
async function saveCup(){
  $$('cerr').textContent='';const b=$$('csave');b.disabled=true;
  const num=function(id){return Number(($$(id).value||'0').replace(',','.'));};
  const payload={code:$$('c_code').value.trim(),desconto_pct:num('c_desc'),comissao_pct:num('c_com'),nota:$$('c_nota').value.trim(),ativo:$$('c_ativo').classList.contains('on')};
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
  body.appendChild(dayChart(a,r));
  body.appendChild(prodRank(a.produtos));
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

</script>
</body></html>`;
