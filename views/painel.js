// Painel do operador (pedidos, produtos, cupons, analytics, Stars): HTML e CSS. O JS fica em views/painel.client.js.
// `data` = JSON dos pedidos já escapado (< → \\u003c) pelo servidor.
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
.nav button{flex:1 1 0;min-width:0;white-space:nowrap;border:0;background:transparent;color:var(--mut);font:inherit;font-weight:700;padding:12px 4px;border-bottom:2px solid transparent;cursor:pointer}
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
.cartag{display:inline-block;margin-left:7px;font-size:10.5px;font-weight:700;padding:2px 6px;border-radius:5px;background:rgba(255,90,31,.14);color:var(--orange);vertical-align:2px}
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
@media(max-width:480px){.prow.cup{flex-wrap:wrap}.prow.cup .pi{flex:1 1 100%}.prow.cup .rt{flex:1;flex-direction:row;align-items:center;justify-content:space-between}.prow.cup .ops button{white-space:nowrap;padding:7px 9px}}
.sbar{margin:10px 14px 0;padding:10px 12px;border-radius:9px;background:rgba(227,179,65,.12);border:1px solid rgba(227,179,65,.4);font-size:13px;display:flex;align-items:center;gap:10px}
.sbar span{flex:1}.sbar button{border:0;border-radius:7px;padding:7px 10px;font:inherit;font-size:13px;font-weight:700;background:var(--gold);color:#160a04;cursor:pointer}
.nost{display:inline-block;margin-left:7px;font-size:10.5px;font-weight:700;padding:2px 6px;border-radius:5px;background:rgba(227,179,65,.18);color:var(--gold);vertical-align:1px}
.serr{color:var(--red)}
.fcast{border:1px solid rgba(63,185,80,.35);background:rgba(63,185,80,.07);border-radius:10px;padding:10px 12px;margin:0 0 12px}
.fcast.buy{border-color:rgba(227,179,65,.45);background:rgba(227,179,65,.08)}
.fcast b{display:block;font-size:14px;margin-bottom:2px}.fcast span{font-size:12px;color:var(--mut)}
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
.a-ref{background:var(--panel2);color:var(--red);border:1px solid rgba(248,81,73,.4)!important}
.refrow{text-align:right;padding:6px 14px 0}.refrow .lnk{background:none;border:0;color:var(--dim);font:inherit;font-size:12px;text-decoration:underline;cursor:pointer;padding:0}
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
.rep .meta{margin-top:8px;padding:9px 10px;border-radius:9px;background:rgba(255,90,31,.07);border:1px solid rgba(255,90,31,.3);font-size:12.5px;color:var(--mut)}
.rep .meta b{color:var(--txt)}.rep .meta .mt b:first-child{color:var(--orange);font-size:15px}
.rep .pg{height:7px;background:var(--bg);border-radius:99px;overflow:hidden;margin:7px 0 4px}.rep .pg i{display:block;height:100%;background:var(--orange)}
.tiers .addt{margin-top:8px;width:100%;border:1px dashed var(--line);background:none;color:var(--mut);border-radius:8px;padding:8px;font:inherit;font-weight:700;cursor:pointer}
.metabox{display:flex;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 10px;font-size:12.5px;color:var(--mut)}
.metabox span{flex:1}.metabox button{flex-shrink:0;border:1px solid var(--orange);background:none;color:var(--orange);border-radius:7px;padding:6px 10px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}
.tiers .tcard{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:10px 12px;margin-bottom:12px}
.tiers .ttl{font-weight:700;font-size:14px}.tiers .hint{margin:8px 0}
.tiers .tt{font-size:13px}.tiers .tt th{font-size:12px;font-weight:600}.tiers .tt td{white-space:nowrap}
.tiers .tt input{width:96px;padding:7px 8px;border:1px solid var(--line);background:var(--bg);color:var(--txt);border-radius:7px;font:inherit;font-size:13px}
.tiers .tt input[data-k="pct"]{width:54px}.tiers .undo{background:none;border:0;color:var(--red);font:inherit;font-size:12px;cursor:pointer;padding:0}
.tiers .tt td{vertical-align:middle}.tiers .ops{display:flex;gap:8px;margin-top:10px}
.tiers .ops.col{flex-direction:column}.clog{margin:10px 0 4px;font-size:12.5px}.clog summary{cursor:pointer;color:var(--mut);font-weight:600}.clog .lg{padding:6px 0;border-top:1px solid var(--line);color:var(--txt)}.clog .lg span{display:block;color:var(--dim);font-size:11.5px}
.tiers .ops button.pri{white-space:nowrap;background:var(--orange);color:#160a04;border-color:var(--orange)}.tiers .metabox{margin:0 0 10px}.rep .top .due.low{color:var(--mut);font-weight:600}
.tiers .ops button{flex:1;border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:8px;padding:9px;font:inherit;font-weight:700;cursor:pointer}
.rep .plk{font-size:11.5px;color:var(--dim);margin-top:6px}.rep .ops{flex-wrap:wrap}
.resv{background:var(--panel);border:1px solid var(--gold);border-radius:11px;padding:12px 14px;margin-bottom:12px}
.resv .l{font-size:12.5px;color:var(--mut)}.resv .v{font-size:24px;font-weight:800;color:var(--gold);line-height:1.25;margin-top:2px}
.resv .s{font-size:12.5px;color:var(--mut);margin-top:6px;line-height:1.5}.resv .s b{color:var(--txt)}
.rep .tot{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--mut);margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}.rep .tot b{color:var(--txt)}
.rep .ops{display:flex;gap:6px;margin-top:10px}
.rep .ops button{border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:7px;padding:7px 11px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.rep .top .ok{color:var(--green)}
.rep>summary.top{list-style:none;cursor:pointer;color:var(--txt);align-items:center;gap:10px}.rep>summary.top::-webkit-details-marker{display:none}
.rep>summary.top .mono{flex:1}.rep>summary.top::after{content:'▾';color:var(--mut);font-size:13px;transition:transform .15s}
.rep[open]>summary.top::after{transform:rotate(180deg)}.rep[open]>summary.top{padding-bottom:4px}
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
.srow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14px}.srow small{color:var(--mut);font-size:12px}.srow .esta{color:var(--green);font-size:12px;font-weight:700}
</style></head><body>
<header>
  <div class="htop"><img class="mark" src="/img/brand-mark.png" alt="" width="26" height="26"><b id="htitle">Painel</b><button class="rf st" id="stBtn" data-act="openStars" title="Saldo de Stars">★ …</button><button class="rf" id="rfBtn" style="margin-left:6px" data-act="refreshView">Atualizar</button><button class="rf" style="margin-left:6px" data-act="openSess" title="Sessões ativas" aria-label="Sessões ativas">🔒</button><button class="rf" style="margin-left:6px" data-act="logout">Sair</button></div>
  <div class="nav">
    <button id="navPed" class="on" data-act="setView" data-v="pedidos">Pedidos</button>
    <button id="navProd" data-act="setView" data-v="produtos">Produtos</button>
    <button id="navCup" data-act="setView" data-v="cupons">Cupons</button>
    <button id="navAna" data-act="setView" data-v="analytics">Analytics</button>
  </div>
  <div id="hdrPed">
    <div class="tabs" id="tabs"></div>
    <div class="search"><input id="q" placeholder="Buscar por nick, ID ou nº do pedido…" autocomplete="off"></div>
    <div class="sync" id="sync">Atualiza sozinho a cada 15 s</div>
  </div>
  <div id="hdrCup" style="display:none"><div class="tabs" id="cupTabs"></div></div>
</header>
<div id="sbarBox"></div>
<main id="viewPed"></main>
<div class="modal" id="smodal">
  <div class="sheet">
    <h3>Saldo de Stars</h3>
    <div id="sBody"><div class="empty">Carregando…</div></div>
    <div class="mbtns"><button class="cancel" data-act="closeStars">Fechar</button></div>
  </div>
</div>
<div class="modal" id="sessmodal">
  <div class="sheet">
    <h3>Sessões ativas</h3>
    <div id="sessBody"><div class="empty">Carregando…</div></div>
    <div class="mbtns"><button class="cancel" data-act="closeSess">Fechar</button></div>
  </div>
</div>
<div id="backbar" role="dialog" aria-live="polite"><p id="bbtxt"></p><div class="bb"><button class="n" data-act="closeBack">Ainda não</button><button class="y" data-act="yesBack">✅ Sim, marcar entregue</button></div></div>
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
    <div id="secMeta"><div class="tiers" id="tiersBox"></div></div>
    <div id="secCom"><div class="rephead"><b>Comissões</b><select id="repPer" data-change="loadRep"><option value="m0">Este mês</option><option value="m1">Mês passado</option><option value="all">Tudo</option></select></div>
    <div id="resBox"></div><div id="repBox"><div class="empty">Carregando…</div></div>
    <p class="hint" style="margin:8px 2px 18px">Conta só pedidos pagos ou entregues. Lucro = valor pago − Stars (custo) − taxa do MP. Comissão = % do lucro: no plano de metas, a faixa do mês (pelo faturamento do parceiro) vale para todas as vendas do mês; no plano fixo, o % do dia da venda. O período muda só a primeira linha. <b>A pagar</b> = comissão dos meses já fechados − pagamentos registrados (pago no 1º dia útil; abaixo do mínimo, acumula). O mês atual aparece como estimado.</p></div>
    <div id="secCup"><button class="newbtn" data-act="openCup">+ Novo cupom</button>
    <div id="cupList" style="margin-top:12px"></div></div>
  </div>
</main>
<div class="modal" id="cmodal">
  <div class="sheet">
    <h3 id="ctitle">Novo cupom</h3>
    <div class="fg"><label>Código</label><input id="c_code" placeholder="ex.: AQUILA" autocomplete="off" style="text-transform:uppercase"><div class="hint">A-Z, 0-9, _ ou -. Link: <span class="mono" id="c_link"></span></div></div>
    <div class="frow">
      <div class="fg"><label>Desconto ao cliente (%)</label><input id="c_desc" inputmode="decimal" placeholder="5"></div>
      <div class="fg"><label>Plano de comissão</label><select id="c_plano" data-change="cupPlano"><option value="metas">Metas (faixas)</option><option value="fixo">Fixo (%)</option></select></div>
    </div>
    <div class="fg" id="c_com_fg"><label>Comissão fixa (% do lucro)</label><input id="c_com" inputmode="decimal" placeholder="20"></div>
    <div class="fg" id="c_metas_fg"><label>Faixas deste parceiro</label>
      <select id="c_tmode" data-change="cupTmode"><option value="padrao">Usar as faixas padrão</option><option value="proprias">Faixas próprias deste parceiro</option></select>
      <div id="c_tpad" class="metabox" style="margin-top:8px"><span id="c_metas_txt"></span><button type="button" data-act="irParaFaixas">Editar padrão</button></div>
      <div id="c_tprop" class="tiers" style="margin-top:8px"></div>
      <div class="hint">Faixas próprias valem só para este parceiro; as padrão valem para todos que as usam. Meses fechados não mudam.</div></div>
    <div class="fg"><label>IDs do próprio parceiro (não contam)</label><input id="c_ids" inputmode="numeric" placeholder="ex.: 749125, 1310329" autocomplete="off"><div class="hint">Compras feitas nesses IDs não contam para a meta nem geram comissão.</div></div>
    <div class="fg"><label>Nota (opcional)</label><input id="c_nota" placeholder="ex.: youtuber aquilagado" autocomplete="off"></div>
    <div class="fg"><label>Dados do parceiro (para o acordo e o pagamento)</label>
      <div class="frow"><input id="c_pnome" placeholder="Nome" autocomplete="off"><input id="c_pcanal" placeholder="Canal ou perfil" autocomplete="off"></div>
      <div class="frow" style="margin-top:8px"><input id="c_ppix" placeholder="Chave Pix" autocomplete="off"><input id="c_pemail" type="email" placeholder="E-mail" autocomplete="off"></div>
      <div class="hint">Ficam só no painel. A chave Pix nunca aparece na página do parceiro.</div></div>
    <details class="clog" id="c_logbox"><summary>Histórico de alterações</summary><div id="c_log" class="hint">Carregando…</div></details>
    <label class="fchk"><button type="button" class="sw" id="c_ativo" data-act="swCup"></button><span id="c_ativo_txt">Ativo — já pode ser usado</span></label>
    <p class="merr" id="cerr"></p>
    <div class="mbtns"><button class="cancel" data-act="closeCup">Cancelar</button><button class="save" id="csave" data-act="saveCup">Salvar</button></div>
  </div>
</div>
<main id="viewProd" style="display:none">
  <div class="padd"><button class="newbtn" data-act="openForm">+ Novo produto</button></div>
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
    <div class="fg"><label>Imagem (URL/caminho)</label><input id="f_img" placeholder="/img/c1000.webp" autocomplete="off"></div>
    <label class="fchk"><button type="button" class="sw" id="f_ativo" data-act="sw"></button><span>Ativo (aparece na loja)</span></label>
    <p class="merr" id="merr"></p>
    <div class="mbtns"><button class="cancel" data-act="closeForm">Cancelar</button><button class="save" id="msave" data-act="saveForm">Salvar</button></div>
  </div>
</div>
<script type="application/json" id="ordersData">${data}</script>
<script src="/painel/app.js"></script>
</body></html>`;
