// Dashboard styles: white, black and greys only. No accent colour, no gradients, no shadows.
// Emphasis comes from weight and contrast, not colour.

export const STYLE = `
:root{--fg:#111;--fg2:#333;--muted:#666;--line:#e4e4e4;--line2:#efefef;--side:#fafafa;--hover:#f0f0f0;--soft:#f5f5f5;color-scheme:light}
*{box-sizing:border-box}
html,body{margin:0}
body{background:#fff;color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--fg)}
:focus-visible{outline:2px solid #111;outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

.app{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh;background:linear-gradient(to right,var(--side) 220px,#fff 220px)}
aside{background:var(--side);border-right:1px solid var(--line);padding:20px 12px;display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh}
.brand{padding:0 10px 24px;font-weight:700;font-size:15px;letter-spacing:-.01em}
nav{display:flex;flex-direction:column;gap:1px}
nav a{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:6px;color:var(--fg2);text-decoration:none}
nav a svg{width:17px;height:17px;flex:none;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
nav a:hover{background:var(--hover);color:var(--fg)}
nav a[aria-current=page]{background:#e9e9e9;color:var(--fg);font-weight:600}
.count{margin-left:auto;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.count:empty{display:none}
.side-foot{margin-top:auto;border-top:1px solid var(--line);padding:12px 10px 0;font-size:12px;color:var(--muted);display:grid;gap:4px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;border:1px solid #888;margin-right:6px;vertical-align:1px}
.dot.on{background:#111;border-color:#111}

main{min-width:0}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 36px;border-bottom:1px solid var(--line);background:#fff;position:sticky;top:0;z-index:5}
.top h1{font-size:20px;margin:0;font-weight:600;letter-spacing:-.01em}
.top p{margin:2px 0 0;color:var(--muted);font-size:13px}
.top p:empty{display:none}
.content{padding:24px 36px 56px;max-width:1240px}
#tasks:empty{display:none}
.task{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:10px 36px;border-bottom:1px solid var(--line);background:var(--soft);font-size:13px}
.task .label{font-weight:500;display:inline-flex;align-items:center;gap:8px}
.task .bar{flex:1;max-width:320px}
.task .num{color:var(--muted);font-variant-numeric:tabular-nums}
.task.done{background:#fff}
@media (max-width:860px){.task{padding:10px 16px}.task .bar{max-width:none;min-width:120px}}

.card{border:1px solid var(--line);border-radius:8px;background:#fff;margin-bottom:16px;overflow:hidden}
.card-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}
.card-h h2{font-size:14px;margin:0;font-weight:600}
.card-b{padding:16px}
.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--line);border-radius:8px;margin-bottom:16px;overflow:hidden}
.kpi{padding:14px 18px;border-left:1px solid var(--line)}
.kpi:first-child{border-left:0}
.kpi .v{font-size:26px;font-weight:600;letter-spacing:-.02em;line-height:1.2;font-variant-numeric:tabular-nums}
.kpi .l{color:var(--muted);font-size:12.5px}
.cols{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:16px}

.btn{font:inherit;font-weight:500;border-radius:6px;padding:6px 12px;border:1px solid #d0d0d0;background:#fff;color:var(--fg);cursor:pointer;min-height:32px;display:inline-flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;white-space:nowrap}
.btn:hover{background:var(--soft)}
.btn.primary{background:#111;color:#fff;border-color:#111}
.btn.primary:hover{background:#333;border-color:#333}
.btn.sm{padding:3px 10px;min-height:28px;font-size:13px}
.btn.ghost{border-color:transparent;background:transparent;color:var(--muted)}
.btn.ghost:hover{background:var(--hover);color:var(--fg)}
.btn[disabled]{opacity:.5;cursor:progress}
.row-actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;align-items:center}

.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{font-size:12px;font-weight:500;color:var(--muted);text-align:left;padding:8px 16px;border-bottom:1px solid var(--line);background:#fafafa;white-space:nowrap}
td{padding:12px 16px;border-bottom:1px solid var(--line2);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
.t{font-weight:500;color:var(--fg)}
a.t{text-decoration:underline;text-decoration-color:#c4c4c4;text-underline-offset:3px}
a.t:hover{text-decoration-color:#111}
.sub{color:var(--muted);font-size:12.5px}
.why{max-width:460px;color:var(--fg2)}

.badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;border-radius:4px;padding:1px 7px;background:var(--soft);color:var(--fg2);white-space:nowrap;border:1px solid var(--line)}
.badge.warn{background:#fff;border-color:#111;color:#111;font-weight:500}
.badge.ok,.badge.info{background:var(--soft)}
.badge.bad{background:#fff;color:#111;border-color:#888}
.spin{width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.score{display:inline-grid;place-items:center;min-width:36px;height:24px;border-radius:4px;font-weight:600;font-size:13px;font-variant-numeric:tabular-nums;border:1px solid transparent}
.score.hi{background:#111;color:#fff}
.score.mid{background:#fff;color:#111;border-color:#111}
.score.lo{background:var(--soft);color:#555}

.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;padding:2px;background:var(--soft)}
.seg button{font:inherit;border:0;background:transparent;padding:4px 12px;border-radius:4px;color:#555;cursor:pointer}
.seg button[aria-pressed=true]{background:#fff;color:#111;font-weight:500;box-shadow:0 0 0 1px var(--line)}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:14px}
input[type=text],input[type=search],input[type=number],input[type=time],input[type=password],select,textarea{font:inherit;padding:7px 10px;border:1px solid #cfcfcf;border-radius:6px;background:#fff;color:var(--fg);max-width:100%}
input[type=search]{min-width:260px}
input[type=file]{font:inherit;max-width:100%}
input[type=checkbox],input[type=radio]{accent-color:#111}
textarea.code{width:100%;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:10px 0}

.banner{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;border:1px solid var(--line);background:var(--soft);border-radius:8px;padding:10px 14px;margin-bottom:14px}
.empty{padding:32px 16px;text-align:center;color:var(--muted)}
.empty b{display:block;color:var(--fg);font-weight:500;margin-bottom:2px}
.note-warn,.note-ok{background:var(--soft);border-left:3px solid #111;border-radius:0 6px 6px 0;padding:10px 12px;color:#111}
.note-ok{border-left-color:#aaa}
.note-warn ul,.note-ok ul{margin:6px 0 0;padding-left:18px}
.lrow{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line2)}
.lrow:last-child{border-bottom:0}
.board{display:grid;grid-template-columns:repeat(6,minmax(160px,1fr));gap:12px;overflow-x:auto;padding:16px}
.col h3{font-size:12px;font-weight:500;color:var(--muted);margin:0 0 8px;display:flex;justify-content:space-between}
.mini{border:1px solid var(--line);border-radius:6px;padding:10px;margin-bottom:8px;background:#fff}
.bar{height:6px;background:#ececec;border-radius:3px;overflow:hidden;min-width:80px}
.bar>i{display:block;height:100%;background:#111}

dialog#review{border:0;border-left:1px solid var(--line);padding:0;margin:0 0 0 auto;height:100vh;max-height:100vh;width:min(720px,100vw);max-width:100vw;color:var(--fg)}
dialog::backdrop{background:rgba(0,0,0,.2)}
.ph{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:16px 24px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;z-index:1}
.ph h2{margin:0;font-size:16px;font-weight:600}
.pb{padding:20px 24px;display:grid;gap:22px}
.pf{position:sticky;bottom:0;background:#fff;border-top:1px solid var(--line);padding:12px 24px;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
h3.sec{font-size:13px;font-weight:600;margin:0 0 8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.diff{border:1px solid var(--line);border-radius:6px;overflow:hidden}
.diff .d{padding:10px 12px;border-bottom:1px solid var(--line2);font-size:13px}
.diff .d:last-child{border-bottom:0}
.diff .tag{font-size:11px;font-weight:600;color:#555;margin-bottom:3px}
.diff .before{color:#666;text-decoration:line-through;margin-bottom:3px}
.d.dropped .txt{color:#666}
.letter{white-space:pre-wrap;border:1px solid var(--line);border-radius:6px;padding:12px;margin-top:8px;font-size:13px}
.steps{display:grid;gap:12px}
.stepbox{border:1px solid var(--line);border-radius:8px;padding:14px 16px}

.chat{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:16px;height:calc(100vh - 130px);min-height:460px}
.thread{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:8px;min-height:0;background:#fff}
.msgs{flex:1;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:14px}
.msg{max-width:80%;white-space:pre-wrap;line-height:1.55}
.msg.me{align-self:flex-end;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:8px 12px}
.msg.ai{align-self:flex-start}
.who{font-size:12px;color:var(--muted);margin-bottom:2px}
.composer{border-top:1px solid var(--line);padding:12px;display:flex;gap:8px;align-items:flex-end}
.composer textarea{flex:1;resize:none;min-height:40px;max-height:160px}
.jobcard{border:1px solid var(--line);border-radius:6px;padding:10px 12px;display:flex;justify-content:space-between;gap:12px;align-items:flex-start;max-width:640px}
.ask{border:1px solid var(--line);border-radius:6px;padding:12px;background:var(--soft);max-width:640px;white-space:pre-wrap}
.notes ul{list-style:none;margin:0;padding:0}
.notes li{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line2);font-size:13px}

.set{display:grid;grid-template-columns:240px minmax(0,1fr);gap:28px;padding:22px 0;border-bottom:1px solid var(--line)}
.set:first-child{padding-top:4px}
.set h2{font-size:14px;margin:0 0 4px;font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.hint{color:var(--muted);font-size:13px;margin:0}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:12px}
label.f{display:grid;gap:6px;font-weight:500;font-size:13px}
.inline{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.status{font-size:13px;color:var(--muted);min-height:20px}
.status.bad{color:#111;font-weight:600}
.radio{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line);border-radius:6px;padding:12px;margin-bottom:8px;cursor:pointer}
.radio input{margin-top:3px}
ol.how{margin:0 0 12px;padding-left:20px;color:var(--fg2)}
code{background:var(--soft);border-radius:3px;padding:1px 5px;font-size:12.5px}

@media (max-width:1100px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.kpi:nth-child(4){border-left:0}.kpi:nth-child(n+4){border-top:1px solid var(--line)}.cols{grid-template-columns:1fr}.chat{grid-template-columns:1fr;height:auto}.chat .notes{display:none}.msgs{max-height:62vh}}
@media (max-width:860px){.app{grid-template-columns:1fr;background:#fff}aside{position:sticky;top:0;z-index:6;height:auto;flex-direction:row;align-items:center;padding:8px 10px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line)}.brand{padding:0 10px 0 4px}.side-foot{display:none}nav{flex-direction:row}nav a{white-space:nowrap}.top{position:static;padding:14px 16px}.content{padding:16px 16px 40px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi{border-left:0;border-top:1px solid var(--line)}.kpi:nth-child(-n+2){border-top:0}.kpi:nth-child(even){border-left:1px solid var(--line)}.set{grid-template-columns:1fr;gap:10px}.hide-sm{display:none}input[type=search]{min-width:0;width:100%}th,td{padding:10px 12px}
table.stack thead{display:none}table.stack,table.stack tbody,table.stack tr,table.stack td{display:block;width:100%}table.stack tr{padding:12px 14px;border-bottom:1px solid var(--line)}table.stack tbody tr:last-child{border-bottom:0}table.stack td{border:0;padding:3px 0}table.stack td.why{max-width:none}table.stack td:nth-child(2) .sub{display:inline;margin-left:6px}table.stack .row-actions{justify-content:flex-start;margin-top:6px}}
`
