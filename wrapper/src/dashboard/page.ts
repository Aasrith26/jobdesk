// The dashboard page: one self-contained HTML string. No CDN, no web fonts, no analytics: the only
// requests it makes are to the local server that served it (DSH-5). White, black and greys only.

import { STYLE } from "./style.ts"

const ICON: Record<string, string> = {
  overview: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  jobs: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  applications: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/><path d="m9 14 2 2 4-4"/>',
  assistant: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  inbox: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  insights: '<path d="M4 20V11M10 20V4M16 20v-8M21 20H3"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
}
const icon = (k: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[k]}</svg>`

const NAV: [string, string, string?][] = [
  ["overview", "Overview"],
  ["jobs", "Jobs", "c-jobs"],
  ["applications", "Applications", "c-apps"],
  ["assistant", "Assistant"],
  ["inbox", "Needs you", "c-inbox"],
  ["insights", "Insights"],
  ["settings", "Settings"],
]

export function renderPage(token: string): string {
  const nav = NAV.map(([id, label, count]) => `<a href="#${id}" id="nav-${id}" data-page="${id}">${icon(id)}<span>${label}</span>${count ? `<span class="count" id="${count}"></span>` : ""}</a>`).join("\n    ")
  const sections = NAV.map(([id, label]) => `<section id="p-${id}" aria-label="${label}" hidden></section>`).join("\n      ")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="jobdesk-token" content="${token}">
<meta name="color-scheme" content="light">
<title>jobdesk</title>
<style>
${STYLE}
</style>
</head>
<body>
<div class="app">
  <aside aria-label="Main">
    <div class="brand">jobdesk</div>
    <nav aria-label="Pages">
    ${nav}
    </nav>
    <div class="side-foot">
      <div id="bot-status"></div>
      <div id="budget"></div>
      <div id="live" aria-live="polite">Connecting...</div>
    </div>
  </aside>
  <main id="main">
    <header class="top">
      <div><h1 id="page-title">Overview</h1><p id="page-sub"></p></div>
      <div id="page-actions" class="inline"></div>
    </header>
    <div id="tasks" aria-live="polite"></div>
    <div class="content">
      ${sections}
    </div>
  </main>
</div>
<dialog id="review" aria-labelledby="rv-title"><div id="rv"></div></dialog>
<script>
(function(){
const token=document.querySelector('meta[name=jobdesk-token]').content;
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safeUrl=u=>/^https?:\\/\\//i.test(String(u||""))?esc(u):"#";
const fileHref=p=>'/file?path='+encodeURIComponent(p);
const PAGES={
  overview:['Overview',''],
  jobs:['Jobs',''],
  applications:['Applications',''],
  assistant:['Assistant','Actions wait for your yes.'],
  inbox:['Needs you',''],
  insights:['Insights',''],
  settings:['Settings','']
};
let S=null,setup=null,page='overview',jobsView='new',jobsQuery='',profileDirty=false,pairPoll=null;
let chatLog=[],chatNotes=[],chatLoaded=false,chatBusy=false;
let rv=null,rvMode='review',rvKit=null,rvPoll=null;

// ---------- helpers ----------
async function call(path,body){
  const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-jobdesk-token':token},body:JSON.stringify(body||{})});
  const j=await r.json().catch(()=>({}));
  return r.ok?j:Object.assign({failed:true},j);
}
function say(id,text,bad){const el=$(id);if(el){el.textContent=text||'';el.className='status'+(bad?' bad':'')}}
async function busyBtn(btn,label,work){const old=btn.innerHTML;btn.disabled=true;btn.textContent=label;try{return await work()}finally{if(btn.isConnected){btn.disabled=false;btn.innerHTML=old}}}
const scoreCls=n=>n>=70?'hi':n>=55?'mid':'lo';
const METHOD={full:'full score',quick:'quick score',keywords:'keywords'};
const appOf=k=>S&&S.preparing.find(a=>a.key===k);
function appBadge(a){
  if(!a)return '';
  if(a.stage==='drafting'&&a.running)return '<span class="badge info"><span class="spin" aria-hidden="true"></span>Writing CV</span>';
  if(a.stage==='ready')return '<span class="badge warn">Ready to review</span>';
  if(a.stage==='confirmed')return '<span class="badge info">Confirmed</span>';
  if(a.stage==='applied')return '<span class="badge ok">Applied</span>';
  if(a.stage==='failed')return '<span class="badge bad">Didn\\'t finish</span>';
  if(a.stage==='stopped')return '<span class="badge">Stopped</span>';
  return '<span class="badge">'+esc(a.stage)+'</span>';
}
function jobActions(j){
  const a=appOf(j.key);
  if(a&&a.review&&(a.stage==='ready'||a.stage==='confirmed'))return '<button class="btn sm primary" data-review="'+esc(j.key)+'">Review</button>';
  if(a&&(a.stage==='drafting'&&a.running))return appBadge(a);
  if(a&&a.stage==='applied')return appBadge(a);
  if(j.reaction==='skipped')return '<span class="badge">Skipped</span>';
  return '<button class="btn sm primary" data-apply="'+esc(j.key)+'">Apply</button><button class="btn sm ghost" data-skip="'+esc(j.key)+'" aria-label="Skip '+esc(j.title)+' at '+esc(j.company)+'">Skip</button>';
}
function fit(j){return j.score!=null?'<span class="score '+scoreCls(j.score)+'">'+esc(j.score)+'</span><div class="sub">'+esc(METHOD[j.method]||'')+'</div>':'<span class="sub">'+(j.fit?'keywords: '+esc(j.fit):'not scored')+'</span>'}

// ---------- navigation ----------
function go(p,remember){
  if(!PAGES[p])p='overview';
  page=p;
  document.querySelectorAll('nav a').forEach(a=>{if(a.dataset.page===p)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});
  Object.keys(PAGES).forEach(k=>{$('#p-'+k).hidden=k!==p});
  $('#page-title').textContent=PAGES[p][0];$('#page-sub').textContent=PAGES[p][1];
  $('#page-actions').innerHTML=(p==='overview'||p==='jobs')?'<button class="btn" id="scan-btn">Search now</button>':'';
  if(remember!==false){try{localStorage.setItem('jd-page',p)}catch(e){}}
  if(p==='settings')loadSetup(true);
  if(p==='assistant')loadChat();
  render();
}
document.addEventListener('click',e=>{const a=e.target.closest('nav a[data-page]');if(a){e.preventDefault();history.replaceState(null,'','#'+a.dataset.page);go(a.dataset.page)}});

// ---------- pages ----------
function overview(s){
  const fresh=s.jobs.filter(j=>j.fresh);
  const ready=s.preparing.filter(a=>a.stage==='ready'&&a.review);
  const k=[[fresh.length,'New jobs that fit'],[ready.length,'Ready to review'],[s.totals.applications,'Applications sent'],[s.buckets.Interview||0,'Interviews'],[s.attention.length,'Need you']];
  let h='<div class="kpis">'+k.map(x=>'<div class="kpi"><div class="v">'+esc(x[0])+'</div><div class="l">'+esc(x[1])+'</div></div>').join('')+'</div>';
  const next=[];
  s.preparing.filter(a=>a.stage==='drafting'&&a.running).forEach(a=>next.push('<div class="lrow"><div><div class="t">'+esc(a.role)+' at '+esc(a.company)+'</div><div class="sub">jobdesk is writing the CV and letter</div></div>'+appBadge(a)+'</div>'));
  ready.forEach(a=>next.push('<div class="lrow"><div><div class="t">'+esc(a.role)+' at '+esc(a.company)+'</div><div class="sub">CV and letter written. Nothing sent yet.</div></div><button class="btn sm primary" data-review="'+esc(a.key)+'">Review</button></div>'));
  s.attention.filter(i=>i.kind!=='review_ready').slice(0,4).forEach(i=>next.push('<div class="lrow"><div><div class="t">'+esc(i.title)+'</div><div class="sub">'+esc(i.action)+'</div></div><a class="btn sm" href="#inbox" data-goto="inbox">Open</a></div>'));
  h+='<div class="cols"><div class="card"><div class="card-h"><h2>Up next</h2></div>'+(next.length?next.join(''):'<div class="empty">Nothing waiting.</div>')+'</div>';
  h+='<div class="card"><div class="card-h"><h2>Ask</h2></div><div class="card-b"><form id="f-quick" class="inline"><label class="sr" for="quick-in">Ask the assistant</label><input id="quick-in" type="text" style="flex:1;min-width:0" placeholder="e.g. which applications need a follow-up?"><button class="btn primary" type="submit">Ask</button></form></div></div></div>';
  h+='<div class="card"><div class="card-h"><h2>New jobs</h2><a class="btn sm" href="#jobs" data-goto="jobs">See all</a></div>'+(fresh.length?jobTable(fresh.slice(0,5),true):'<div class="empty">'+(s.scoring.unscored?'None scored above your minimum. '+s.scoring.unscored+' jobs are not scored yet.':'None yet.')+'</div>')+'</div>';
  return h;
}
function jobTable(list,compact){
  return '<div class="scroll"><table class="stack"><thead><tr><th scope="col">Role</th><th scope="col">Fit</th><th scope="col">Why</th>'+(compact?'':'<th scope="col" class="hide-sm">Source</th>')+'<th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>'+
  list.map(j=>'<tr><td><a class="t" href="'+safeUrl(j.url)+'" target="_blank" rel="noopener noreferrer">'+esc(j.title)+'</a><div class="sub">'+esc(j.company)+(j.location?' · '+esc(j.location):'')+'</div></td>'+
  '<td>'+fit(j)+'</td><td class="why">'+esc(j.reason)+(j.gaps&&j.gaps.length?'<div class="sub">Gap: '+esc(j.gaps[0])+'</div>':'')+(j.ruled_out?'<div class="sub" style="color:var(--warn)">'+esc(j.ruled_out)+'</div>':'')+(j.flags.length?'<div class="sub" style="color:var(--bad)">'+j.flags.map(esc).join('<br>')+'</div>':'')+'</td>'+
  (compact?'':'<td class="hide-sm sub">'+esc(String(j.portal||'').replace(/-search$/,''))+'</td>')+'<td><div class="row-actions">'+jobActions(j)+'</div></td></tr>').join('')+'</tbody></table></div>';
}
function jobs(s){
  const fresh=s.jobs.filter(j=>j.fresh);
  let list=jobsView==='new'?fresh:s.jobs;
  const q=jobsQuery.trim().toLowerCase();
  if(q)list=list.filter(j=>(j.title+' '+j.company+' '+j.location).toLowerCase().indexOf(q)>=0);
  let h='<div class="toolbar"><div class="seg" role="group" aria-label="Which jobs"><button data-view="new" aria-pressed="'+(jobsView==='new')+'">New for you ('+fresh.length+')</button><button data-view="all" aria-pressed="'+(jobsView==='all')+'">Everything found ('+s.jobs.length+')</button></div><label class="sr" for="job-q">Filter jobs</label><input id="job-q" type="search" placeholder="Filter by role, company or place" value="'+esc(jobsQuery)+'"></div>';
  const scoring=(s.tasks||[]).find(t=>t.kind==='score'&&t.status==='running');
  if(scoring)h+='<div class="banner"><span>Scoring is running: '+scoring.done+' of '+(scoring.total||s.scoring.unscored)+' done. New fits appear here as they are scored.</span></div>';
  else if(s.scoring.unscored)h+='<div class="banner"><span>'+s.scoring.unscored+' job'+(s.scoring.unscored===1?' has':'s have')+' no fit score yet. Only scored jobs count as fits.</span><span class="inline"><span id="score-msg" class="status" role="status"></span><button class="btn sm primary" id="score-btn">Score them (about $'+s.scoring.estimate.toFixed(2)+')</button></span></div>';
  h+='<div class="card">'+(list.length?jobTable(list.slice(0,300),false):'<div class="empty">'+(jobsView==='new'?'No new jobs at or above your minimum fit ('+esc(s.config.min_fit)+').':'No jobs yet.')+'</div>')+'</div>';
  h+='<p class="hint">A quick score comes from the text the search found. A full score comes from /rank in Claude Code, which reads the whole posting.</p>';
  return h;
}
function applications(s){
  const STAGE_HINT={drafting:'Writing the CV and letter (5 to 15 minutes).',ready:'Written. Read what changed, then confirm.',confirmed:'Confirmed. Apply with one tap, then mark it applied.',applied:'Applied.',failed:'Didn\\'t finish.',stopped:'Stopped.'};
  let h='<div class="card"><div class="card-h"><h2>Prepared by jobdesk</h2></div>';
  h+=s.preparing.length?s.preparing.filter(a=>a.stage!=='applied').map(a=>'<div class="lrow"><div><div class="t">'+esc(a.role||'Job')+' at '+esc(a.company)+'</div><div class="sub">'+esc(a.note||STAGE_HINT[a.stage]||'')+'</div></div><div class="row-actions">'+appBadge(a)+(a.review&&a.stage!=='drafting'?'<button class="btn sm'+(a.stage==='ready'?' primary':'')+'" data-review="'+esc(a.key)+'">'+(a.stage==='confirmed'?'Open':'Review')+'</button>':'')+'</div></div>').join('')||'<div class="empty">Nothing in progress.</div>':'<div class="empty">None. Press Apply on a job to start one.</div>';
  h+='</div>';
  const order=["Drafted","Active","Interview","Offer","Hired","Rejected/Closed"];
  const label={Drafted:'Drafted',Active:'Sent',Interview:'Interview',Offer:'Offer',Hired:'Hired','Rejected/Closed':'Closed'};
  h+='<div class="card"><div class="card-h"><h2>Pipeline</h2><span class="sub">From your tracker</span></div><div class="board">'+order.map(b=>{const apps=s.applications.filter(a=>a.bucket===b);return '<div class="col"><h3><span>'+esc(label[b])+'</span><span>'+apps.length+'</span></h3>'+apps.map(a=>'<div class="mini"><div class="t">'+esc(a.company)+'</div><div class="sub">'+esc(a.role)+'</div><div class="sub">'+esc(a.date)+(a.fit?' · fit '+esc(a.fit):'')+'</div>'+(a.cv_exists?'<div><a href="'+fileHref(a.cv)+'" target="_blank" rel="noopener">CV</a>'+(a.cover_exists?' · <a href="'+fileHref(a.cover)+'" target="_blank" rel="noopener">Letter</a>':'')+'</div>':'')+'</div>').join('')+'</div>'}).join('')+'</div></div>';
  return h;
}
function inbox(s){
  if(!s.attention.length)return '<div class="card"><div class="empty">Nothing here.</div></div>';
  return '<div class="card">'+s.attention.map(i=>{
    let x='';
    if(i.kind==='review_ready'&&i.data&&i.data.key)x+='<button class="btn sm primary" data-review="'+esc(i.data.key)+'">Review</button>';
    if(i.kind==='unknown_question')x+='<form data-answer="'+esc(i.id)+'" class="inline"><label class="sr" for="ans-'+esc(i.id)+'">Your answer</label><input id="ans-'+esc(i.id)+'" type="text" name="answer" required placeholder="Your answer"><label class="sub"><input type="checkbox" name="sensitive"> Private</label><button class="btn sm primary" type="submit">Save</button></form>';
    if(i.data&&i.data.confirm_status&&i.data.company)x+='<button class="btn sm primary" data-confirm="'+esc(i.id)+'">Mark '+esc(i.data.company)+' as '+esc(i.data.confirm_status)+'</button>';
    if(i.data&&i.data.kit)x+='<a class="btn sm" href="'+fileHref(i.data.kit)+'" target="_blank" rel="noopener">Open kit</a>';
    if(i.data&&i.data.url)x+='<a class="btn sm" href="'+safeUrl(i.data.url)+'" target="_blank" rel="noopener noreferrer">Open link</a>';
    return '<div class="lrow" style="align-items:flex-start"><div><div class="t">'+esc(i.title)+(i.due?' <span class="badge warn">due '+esc(i.due)+'</span>':'')+'</div><div class="sub">'+esc(i.why)+'</div><div class="sub">'+esc(i.action)+'</div></div><div class="row-actions">'+x+'<button class="btn sm ghost" data-dismiss="'+esc(i.id)+'">Done</button></div></div>'}).join('')+'</div>';
}
function rateCard(title,rows){
  return '<div class="card"><div class="card-h"><h2>'+esc(title)+'</h2></div>'+(rows.length?'<div class="scroll"><table><thead><tr><th scope="col">Group</th><th scope="col">Sent</th><th scope="col">Replies</th><th scope="col">Reply rate</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.key)+'</td><td>'+r.applications+'</td><td>'+r.replies+'</td><td>'+(r.enough?'<div class="inline"><div class="bar" role="img" aria-label="'+Math.round(r.rate*100)+' percent"><i style="width:'+Math.round(r.rate*100)+'%"></i></div>'+Math.round(r.rate*100)+'%</div>':'<span class="sub">Needs 5 or more</span>')+'</td></tr>').join('')+'</tbody></table></div>':'<div class="empty">No applications sent yet.</div>')+'</div>';
}
function insights(s){
  const max=Math.max(1,...Object.values(s.seenByPortal));
  let h='<div class="kpis">'+[['$'+s.cost.spent.toFixed(2),'Spent this month'],['$'+s.cost.left.toFixed(2),'Left of $'+s.cost.budget],[s.totals.scraped,'Jobs found'],[s.totals.applications,'Applications sent'],[s.replyRateBySource.reduce((a,r)=>a+r.replies,0),'Replies']].map(x=>'<div class="kpi"><div class="v">'+esc(x[0])+'</div><div class="l">'+esc(x[1])+'</div></div>').join('')+'</div>';
  h+='<p class="hint" style="margin-bottom:12px">A reply is an interview, offer, hire or rejection. Silence does not count.</p>';
  h+=rateCard('By source',s.replyRateBySource)+rateCard('By channel',s.replyRateByChannel)+rateCard('By CV version',s.replyRateByCv);
  h+='<div class="card"><div class="card-h"><h2>Jobs found, by source</h2></div><div class="scroll"><table><tbody>'+Object.entries(s.seenByPortal).sort((a,b)=>b[1]-a[1]).map(e=>'<tr><td>'+esc(String(e[0]).replace(/-search$/,''))+'</td><td style="width:50%"><div class="bar" role="img" aria-label="'+e[1]+' jobs"><i style="width:'+Math.round(e[1]/max*100)+'%"></i></div></td><td>'+e[1]+'</td></tr>').join('')+'</tbody></table></div></div>';
  return h;
}

// ---------- settings ----------
const done=b=>b?'<span class="badge ok">Done</span>':'<span class="badge">To do</span>';
function settingsHtml(s){
  const t=s.telegram,d=s.schedule.daily,L=s.looking_for;
  let h='';
  if(!s.complete)h+='<div class="banner"><span>Finish the first two sections to start: your profile, and what you are looking for.</span></div>';
  h+='<div class="set"><div><h2>Profile '+done(s.steps.profile)+'</h2><p class="hint">Every CV, letter and fit score is built from this, and from nothing else.</p></div><div>';
  h+=s.profile.name?'<p style="margin-top:0">Profile for <strong>'+esc(s.profile.name)+'</strong>.</p>':'<p style="margin-top:0">Upload your resume. jobdesk drafts your profile from it, and you check the draft before anything is saved.</p>';
  h+='<form id="f-resume" class="inline"><label class="sr" for="resume-file">Resume file</label><input id="resume-file" type="file" name="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp" required><button class="btn" type="submit">Upload resume</button></form>';
  if(s.resumes.length)h+='<div class="card" style="margin-top:12px">'+s.resumes.slice(0,5).map(r=>'<div class="lrow"><div><div class="t">'+esc(r.name)+'</div><div class="sub">'+Math.round(r.size/1024)+' KB · '+esc(String(r.modified).slice(0,10))+'</div></div><div class="row-actions"><button class="btn sm primary" data-draft="'+esc(r.name)+'">Draft profile from this</button><button class="btn sm ghost" data-import="'+esc(r.name)+'">Copy word for word</button></div></div>').join('')+'</div>';
  h+='<p id="profile-msg" class="status" role="status"></p>';
  h+='<details id="profile-box"><summary>'+(s.profile.name?'See or edit your profile':'Or write your profile yourself')+'</summary><label class="sr" for="profile-text">Your profile</label><textarea id="profile-text" class="code" rows="18" spellcheck="true">'+esc(s.profile.text)+'</textarea><div id="profile-warn"></div><div class="inline"><button class="btn primary" id="profile-save">Save profile</button><span class="sub">Your previous profile is kept as a backup.</span></div></details></div></div>';
  h+='<div class="set"><div><h2>What you are looking for '+done(s.steps.looking_for)+'</h2><p class="hint">Used for searching and for scoring every job.</p></div><form id="f-look"><div class="fields"><label class="f">Kinds of jobs<input type="text" name="queries" value="'+esc(L.queries.join(', '))+'" placeholder="AI Engineer, Voice AI"></label><label class="f">Places<input type="text" name="locations" value="'+esc(L.locations.join(', '))+'" placeholder="Hyderabad, Bengaluru, Remote"></label><label class="f">Lowest fit score to show (0 to 100)<input type="number" name="min_fit" min="0" max="100" value="'+esc(L.min_fit)+'"></label></div><div class="inline"><button class="btn primary" type="submit">Save</button><span id="look-msg" class="status" role="status"></span></div></form></div>';
  h+='<div class="set"><div><h2>Phone (Telegram) '+done(s.steps.phone)+'</h2><p class="hint">Optional. Get new jobs and reviews on your phone, and reply in plain words.</p></div><div>';
  if(t.paired)h+='<p style="margin-top:0"><span class="dot'+(t.running?' on':'')+'"></span>Connected'+(t.username?' to <strong>@'+esc(t.username)+'</strong>':'')+'. '+(t.running?'The bot is on.':'The bot runs while jobdesk start is running.')+'</p><button class="btn" id="tg-unpair">Connect a different phone</button>';
  else if(t.running&&t.link)h+='<p style="margin-top:0">Your bot <strong>@'+esc(t.username)+'</strong> is on. Last step: open it on your phone and tap Start.</p><div class="inline"><a class="btn primary" href="'+safeUrl(t.link)+'" target="_blank" rel="noopener noreferrer">Open in Telegram</a><span class="sub">or send your bot <code>/start '+esc(t.code)+'</code></span></div><p class="status" role="status">Waiting for you to tap Start...</p>';
  else h+='<ol class="how"><li>In Telegram, open <strong>@BotFather</strong> and send <code>/newbot</code>.</li><li>Choose a name and a username for your bot.</li><li>Paste the token it gives you here.</li></ol>';
  if(!t.paired)h+='<form id="f-tg" class="inline"><label class="sr" for="tg-token">Bot token</label><input id="tg-token" type="password" name="token" autocomplete="off" placeholder="123456:ABC..." required style="min-width:min(320px,100%)"><button class="btn primary" type="submit">Connect</button></form>';
  h+='<p id="tg-msg" class="status'+(t.error?' bad':'')+'" role="status">'+esc(t.error||'')+'</p></div></div>';
  h+='<div class="set"><div><h2>Daily search '+done(s.steps.schedule)+'</h2><p class="hint">Optional. Runs while this computer is on and jobdesk is running.</p></div><form id="f-sched"><p style="margin-top:0" class="inline"><label class="inline"><input type="checkbox" name="search"'+(d.search?' checked':'')+'> Search for new jobs every day at</label><label class="sr" for="sched-time">Search time</label><input id="sched-time" type="time" name="time" value="'+esc(d.time)+'"></p><div class="fields"><label class="f">When a new job fits you<select name="apply"><option value="ask"'+(d.apply==='ask'?' selected':'')+'>Show it with an Apply button</option><option value="off"'+(d.apply==='off'?' selected':'')+'>Just list it</option><option value="auto"'+(d.apply==='auto'?' selected':'')+'>Write the CV and letter for strong fits</option></select></label><label class="f">Morning update on Telegram at<input type="time" name="digest_time" value="'+esc(s.schedule.digest_time)+'"></label></div><div class="inline"><button class="btn primary" type="submit">Save</button><span id="sched-msg" class="status" role="status"></span></div></form></div>';
  h+='<div class="set"><div><h2>How applying works</h2><p class="hint">You always see what changed and confirm first.</p></div><form id="f-send"><label class="radio"><input type="radio" name="level" value="L0"'+(s.sending==='L0'?' checked':'')+'><span><strong>Kit only</strong><br><span class="sub">You send every application. One tap opens the page, with your files and answers ready to copy.</span></span></label><label class="radio"><input type="radio" name="level" value="L1"'+(s.sending!=='L0'?' checked':'')+'><span><strong>Fill forms, I confirm each</strong><br><span class="sub">On Greenhouse, Lever and Ashby, jobdesk fills the form in your browser and waits for your Send. Sites that need a login always get the kit.</span></span></label><div class="inline"><button class="btn primary" type="submit">Save</button><span id="send-msg" class="status" role="status"></span></div></form></div>';
  h+='<div class="set"><div><h2>What the assistant remembers</h2><p class="hint">Things you told it. Remove anything that is wrong.</p></div><div id="notes-set"></div></div>';
  h+='<div class="set"><div><h2>This computer</h2><p class="hint">What is installed, and how to fix anything missing.</p></div><div><button class="btn" id="doctor">Check what is installed</button><div id="doctor-out" role="status"></div></div></div>';
  return h;
}
function notesHtml(){return chatNotes.length?'<ul>'+chatNotes.map((n,i)=>'<li><span>'+esc(n)+'</span><button class="btn sm ghost" data-forget="'+i+'" aria-label="Forget: '+esc(n)+'">Remove</button></li>').join('')+'</ul>':'<p class="hint">None.</p>'}
function editing(){const a=document.activeElement;return profileDirty||!!(a&&$('#p-settings').contains(a)&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))}
async function loadSetup(force){
  const r=await fetch('/api/setup');setup=await r.json();
  if(page==='settings'&&(force||!editing())){$('#p-settings').innerHTML=settingsHtml(setup);await loadNotes();applyProfileDraft()}
  const t=setup.telegram;
  $('#bot-status').innerHTML='<span class="dot'+(t.running&&t.paired?' on':'')+'"></span>'+(t.paired?(t.running?'Phone connected':'Phone paired, bot off'):'Phone not connected');
  const waiting=t.running&&!t.paired;
  if(waiting&&!pairPoll)pairPoll=setInterval(()=>loadSetup(),3000);
  if(!waiting&&pairPoll){clearInterval(pairPoll);pairPoll=null}
  return setup;
}
async function loadNotes(){const r=await fetch('/api/agent/history');const j=await r.json();chatNotes=j.notes||[];const el=$('#notes-set');if(el)el.innerHTML=notesHtml();const n=$('#notes-side');if(n)n.innerHTML=notesHtml();return j}

// ---------- assistant ----------
function chatItem(m){
  if(m.k==='me')return '<div class="msg me">'+esc(m.t)+'</div>';
  if(m.k==='ai')return '<div class="msg ai"><div class="who">Assistant'+(m.ch==='telegram'?' · on Telegram':'')+'</div>'+esc(m.t)+'</div>';
  if(m.k==='res')return '<div class="msg ai">'+esc(m.t)+(m.link?' <a href="'+esc(m.link.href)+'" target="_blank" rel="noopener">'+esc(m.link.label)+'</a>':'')+'</div>';
  if(m.k==='err')return '<div class="msg ai" style="color:var(--bad)">'+esc(m.t)+'</div>';
  if(m.k==='jobs')return m.jobs.map(j=>'<div class="jobcard"><div><a class="t" href="'+safeUrl(j.url)+'" target="_blank" rel="noopener noreferrer">'+esc(j.title)+'</a><div class="sub">'+esc(j.company)+(j.location?' · '+esc(j.location):'')+'</div>'+(j.reason?'<div class="sub" style="color:var(--fg2)">'+esc(j.reason)+'</div>':'')+'</div><div class="row-actions">'+(j.score!=null?'<span class="score '+scoreCls(j.score)+'">'+esc(j.score)+'</span>':'')+'<button class="btn sm primary" data-apply="'+esc(j.key)+'">Apply</button><button class="btn sm ghost" data-skip="'+esc(j.key)+'">Skip</button></div></div>').join('');
  if(m.k==='ask')return '<div class="ask">'+esc(m.q)+(m.done?'<div class="sub" style="margin-top:6px">'+esc(m.done)+'</div>':'<div class="row-actions" style="justify-content:flex-start;margin-top:8px"><button class="btn sm primary" data-yes="'+esc(m.id)+'">Yes</button><button class="btn sm" data-no="'+esc(m.id)+'">No</button></div>')+'</div>';
  if(m.k==='wait')return '<div class="msg ai sub"><span class="spin" aria-hidden="true" style="display:inline-block;margin-right:6px"></span>Thinking...</div>';
  return '';
}
function renderChat(){
  const el=$('#p-assistant');
  if(!el.innerHTML)el.innerHTML='<div class="chat"><div class="thread"><div class="msgs" id="msgs" aria-live="polite"></div><form class="composer" id="f-chat"><label class="sr" for="chat-in">Message</label><textarea id="chat-in" rows="1" placeholder="Message"></textarea><button class="btn primary" type="submit">Send</button></form></div><div class="card notes"><div class="card-h"><h2>Notes</h2></div><div class="card-b" id="notes-side"></div></div></div>';
  const m=$('#msgs');
  m.innerHTML=chatLog.length?chatLog.map(chatItem).join(''):'<div class="empty">No messages yet.</div>';
  m.scrollTop=m.scrollHeight;
  $('#notes-side').innerHTML=notesHtml();
}
async function loadChat(){
  if(!chatLoaded){
    const j=await loadNotes();
    chatLog=[];
    (j.turns||[]).forEach(t=>{chatLog.push({k:t.role==='user'?'me':'ai',t:t.text,ch:t.channel});if(t.jobs&&t.jobs.length)chatLog.push({k:'jobs',jobs:t.jobs})});
    (j.proposals||[]).forEach(p=>chatLog.push({k:'ask',id:p.id,q:p.question}));
    chatLoaded=true;
  }
  renderChat();
}
async function ask(text){
  if(chatBusy||!text.trim())return;
  chatBusy=true;chatLog.push({k:'me',t:text},{k:'wait'});renderChat();
  const j=await call('/api/agent/ask',{text:text});
  chatLog=chatLog.filter(m=>m.k!=='wait');
  if(j.failed)chatLog.push({k:'err',t:j.error||'Something went wrong.'});
  else{
    chatLog.push({k:'ai',t:j.reply});
    if(j.jobs&&j.jobs.length)chatLog.push({k:'jobs',jobs:j.jobs});
    (j.results||[]).forEach(r=>chatLog.push({k:'res',t:r.text,link:r.link}));
    (j.proposals||[]).forEach(p=>chatLog.push({k:'ask',id:p.id,q:p.question}));
    if(j.remembered&&j.remembered.length)loadNotes();
  }
  chatBusy=false;renderChat();load();
}

// ---------- review panel ----------
function panelHead(title,sub){return '<div class="ph"><div><h2 id="rv-title">'+esc(title)+'</h2><div class="sub">'+esc(sub)+'</div></div><button class="btn sm ghost" data-close aria-label="Close">Close</button></div>'}
function renderReview(){
  const r=rv.review;let h='';
  if(rvMode==='review'){
    const n=k=>r.changes.filter(c=>c.kind===k).length;
    h+=panelHead('Review: '+r.role+' at '+r.company,r.site+' · nothing has been sent');
    h+='<div class="pb">';
    if(r.warnings.length)h+='<div class="note-warn"><strong>Before you go on</strong><ul>'+r.warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></div>';
    h+=r.unsupported.length?'<div class="note-warn"><strong>Check these. They are not in your profile:</strong><ul>'+r.unsupported.map(u=>'<li>'+esc(u)+'</li>').join('')+'</ul></div>':r.check_error?'<div class="note-warn">The fact check did not run ('+esc(r.check_error)+'). Read the changes carefully.</div>':r.checked?'<div class="note-ok">Fact check passed: every changed line and the cover letter match your profile.</div>':'';
    h+='<div><h3 class="sec">What changed in your CV <span class="badge ok">'+n('new')+' added</span><span class="badge info">'+n('reworded')+' reworded</span><span class="badge">'+n('dropped')+' left out</span><span class="badge">'+r.unchanged+' unchanged</span></h3><p class="hint" style="margin-bottom:8px">Compared with '+esc(r.base)+'.</p>';
    h+=r.changes.length?'<div class="diff">'+r.changes.map(c=>'<div class="d '+c.kind+'"><div class="tag">'+(c.kind==='new'?'Added':c.kind==='reworded'?'Reworded':'Left out')+'</div>'+(c.kind==='reworded'?'<div class="before">'+esc(c.before)+'</div><div class="txt">'+esc(c.after)+'</div>':c.kind==='new'?'<div class="txt">'+esc(c.after)+'</div>':'<div class="txt">'+esc(c.before)+'</div>')+'</div>').join('')+'</div>':'<p class="hint">No changes: it is your resume as it is.</p>';
    h+='</div>';
    h+='<div><h3 class="sec">Files</h3><div class="inline">'+(r.cv.pdf_exists?'<a class="btn sm" href="'+fileHref(r.cv.pdf)+'" target="_blank" rel="noopener">Open CV (PDF)</a>':'<span class="sub">CV: '+esc(r.cv.tex)+'</span>')+(r.letter.pdf_exists?'<a class="btn sm" href="'+fileHref(r.letter.pdf)+'" target="_blank" rel="noopener">Open cover letter (PDF)</a>':r.letter.tex?'<span class="sub">Letter: '+esc(r.letter.tex)+'</span>':'')+'</div></div>';
    if(r.letter.text)h+='<details><summary><strong>Read the cover letter</strong></summary><div class="letter">'+esc(r.letter.text)+'</div></details>';
    h+='<div><h3 class="sec">What goes in the form</h3><div class="card" style="margin:0"><table><thead><tr><th scope="col">Field</th><th scope="col">Value</th><th scope="col" class="hide-sm">From</th></tr></thead><tbody>'+r.fields.map(f=>'<tr><td>'+esc(f.label)+'</td><td>'+esc(f.value)+'</td><td class="hide-sm sub">'+esc(f.source)+'</td></tr>').join('')+'</tbody></table></div></div>';
    h+='<p class="hint">'+esc(r.how_note)+'</p></div>';
    h+='<div class="pf"><button class="btn" data-later="'+esc(r.key)+'">Not now</button><button class="btn primary" data-confirm-apply="'+esc(r.key)+'">'+(r.how==='fill'?'Looks good, fill the form':'Looks good, apply')+'</button></div>';
  } else if(rvMode==='kit'){
    const k=rvKit;
    h+=panelHead('Apply to '+r.company,r.role+' on '+r.site);
    h+='<div class="pb"><div class="steps">';
    h+='<div class="stepbox"><h3 class="sec">1. Open the application page</h3><a class="btn primary" href="'+safeUrl(k.url)+'" target="_blank" rel="noopener noreferrer">Open the application page</a></div>';
    h+='<div class="stepbox"><h3 class="sec">2. Attach your files</h3>'+(k.files.length?k.files.map(f=>f.exists?'<div><a href="'+fileHref(f.path)+'" target="_blank" rel="noopener">'+esc(f.label)+'</a></div>':'<div class="sub">'+esc(f.label)+': not built yet ('+esc(f.path)+')</div>').join(''):'<p class="hint">No files.</p>')+'</div>';
    h+='<div class="stepbox"><h3 class="sec">3. Copy your answers</h3>'+(k.answers.length?'<table><tbody>'+k.answers.map((a,i)=>'<tr><td>'+esc(a.label)+'</td><td>'+esc(a.answer)+'</td><td><button class="btn sm" data-copy="'+i+'" aria-label="Copy '+esc(a.label)+'">Copy</button></td></tr>').join('')+'</tbody></table>':'<p class="hint">No saved answers yet.</p>')+'</div>';
    h+='<div class="stepbox"><h3 class="sec">4. When you have sent it</h3><p class="hint">Mark it applied, so follow-ups and your numbers stay right.</p></div>';
    if(k.warnings.length)h+='<div class="note-warn"><ul>'+k.warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></div>';
    h+='</div></div><div class="pf"><button class="btn" data-close>Close</button><button class="btn primary" data-applied="'+esc(r.key)+'">I have applied</button></div>';
  } else {
    const c=rv.sending;
    h+=panelHead('Filling the form: '+r.company,r.site+' · nothing is sent without your click');
    h+='<div class="pb">';
    if(!c)h+='<div class="empty"><span class="spin" aria-hidden="true" style="display:inline-block"></span><b style="margin-top:8px">Filling the form in your browser</b>A browser window opens. When every field is in, you will see it here.</div>';
    else{
      h+='<div class="card" style="margin:0"><table><thead><tr><th scope="col">Field</th><th scope="col">Value</th><th scope="col" class="hide-sm">From</th></tr></thead><tbody>'+c.fields.map(f=>'<tr><td>'+esc(f.label)+'</td><td>'+esc(f.value)+'</td><td class="hide-sm sub">'+esc(f.source)+'</td></tr>').join('')+'</tbody></table></div>';
      if(c.unknown.length)h+='<div class="note-warn"><strong>Questions only you can answer (left empty):</strong><ul>'+c.unknown.map(u=>'<li>'+esc(u)+'</li>').join('')+'</ul></div>';
      if(c.stops.length)h+='<div class="note-warn"><strong>Steps only you can do:</strong><ul>'+c.stops.map(u=>'<li>'+esc(u)+'</li>').join('')+'</ul></div>';
      if(c.flags.length)h+='<div class="note-warn"><ul>'+c.flags.map(u=>'<li>'+esc(u)+'</li>').join('')+'</ul></div>';
      if(c.screenshot)h+='<a href="'+fileHref(c.screenshot)+'" target="_blank" rel="noopener">See a screenshot of the form</a>';
    }
    h+='</div><div class="pf"><button class="btn" data-send="cancel" '+(c?'':'disabled')+'>Cancel</button><button class="btn primary" data-send="submit" '+(c&&c.submittable?'':'disabled')+'>Send application</button></div>';
  }
  $('#rv').innerHTML=h;
}
async function openReview(key){
  const r=await fetch('/api/apply/review?key='+encodeURIComponent(key));
  if(!r.ok){alert('There is no review for that job yet.');return}
  rv=await r.json();rv.key=key;
  rvMode=rv.sending?'fill':(rv.state&&rv.state.stage==='confirmed'&&rv.review.how==='kit')?'kit':'review';
  if(rvMode==='kit'){const j=await call('/api/apply/confirm',{id:key});if(!j.failed)rvKit=j.kit;else rvMode='review'}
  renderReview();
  const d=$('#review');if(!d.open)d.showModal();
}
function closeReview(){const d=$('#review');if(d.open)d.close();if(rvPoll){clearInterval(rvPoll);rvPoll=null}rv=null}
$('#review').addEventListener('close',()=>{if(rvPoll){clearInterval(rvPoll);rvPoll=null}});

// ---------- render & live updates ----------
// ---------- background tasks (scoring, searching, profile drafts) ----------
function seenIds(){try{return JSON.parse(localStorage.getItem('jd-tasks-seen')||'[]')}catch(e){return []}}
function markSeen(id){const s=seenIds();if(s.indexOf(id)<0){s.push(id);try{localStorage.setItem('jd-tasks-seen',JSON.stringify(s.slice(-50)))}catch(e){}}}
const STATUS={done:'Done',failed:'Failed',stopped:'Stopped',interrupted:'Interrupted'};
function tasksHtml(list){
  const seen=seenIds();
  return list.filter(t=>t.status==='running'||seen.indexOf(t.id)<0).map(t=>{
    if(t.status==='running'){
      const pct=t.total?Math.round(t.done/t.total*100):0;
      return '<div class="task"><span class="label"><span class="spin" aria-hidden="true"></span>'+esc(t.label)+'</span>'+(t.total>1?'<div class="bar" role="progressbar" aria-label="'+esc(t.label)+'" aria-valuemin="0" aria-valuemax="'+t.total+'" aria-valuenow="'+t.done+'"><i style="width:'+pct+'%"></i></div><span class="num">'+t.done+' of '+t.total+'</span>':'<span class="num">Running. You can leave this page.</span>')+(t.kind==='score'?'<button class="btn sm" data-stop="'+esc(t.id)+'">Stop</button>':'')+'</div>';
    }
    const open=t.kind==='profile'&&t.status==='done'?'<button class="btn sm primary" data-goto="settings">Open</button>':'';
    return '<div class="task done"><span class="label">'+esc(t.label)+': '+esc(STATUS[t.status]||t.status)+'</span><span class="num">'+esc(t.message||'')+'</span>'+open+'<button class="btn sm ghost" data-seen="'+esc(t.id)+'">Dismiss</button></div>';
  }).join('');
}
/** A finished profile draft lands in the editor the next time Settings is open, even after a reload. */
function applyProfileDraft(){
  if(!S||page!=='settings'||!$('#profile-text'))return;
  const t=S.tasks.find(x=>x.kind==='profile'&&x.status==='done'&&x.result);
  // Applied until it is saved or replaced, so leaving Settings and coming back never loses it.
  if(!t||seenIds().indexOf('draft:'+t.id)>=0||$('#profile-text').dataset.draft===t.id)return;
  $('#profile-text').dataset.draft=t.id;
  const r=t.result;
  $('#profile-box').open=true;$('#profile-text').value=r.markdown;profileDirty=true;
  $('#profile-warn').innerHTML=r.unsupported&&r.unsupported.length?'<div class="note-warn"><strong>Check these before saving. They may not be in your resume:</strong><ul>'+r.unsupported.map(u=>'<li>'+esc(u)+'</li>').join('')+'</ul></div>':'';
  say('#profile-msg','Draft ready (cost $'+(r.usd||0).toFixed(2)+'). Read it, fix anything wrong, then press Save profile. Nothing is saved until you do.');
}
function render(){
  if(!S)return;
  $('#tasks').innerHTML=tasksHtml(S.tasks||[]);
  applyProfileDraft();
  const fresh=S.jobs.filter(j=>j.fresh).length,ready=S.preparing.filter(a=>a.stage==='ready').length;
  $('#c-jobs').textContent=fresh||'';$('#c-apps').textContent=ready||'';$('#c-inbox').textContent=S.attention.length||'';
  $('#budget').textContent='$'+S.cost.left.toFixed(2)+' of $'+S.cost.budget+' left this month';
  if(page==='overview')$('#p-overview').innerHTML=overview(S);
  if(page==='jobs'){const a=document.activeElement,f=a&&a.id==='job-q',pos=f?a.selectionStart:0;$('#p-jobs').innerHTML=jobs(S);if(f){const q=$('#job-q');q.focus();q.setSelectionRange(pos,pos)}}
  if(page==='applications')$('#p-applications').innerHTML=applications(S);
  if(page==='inbox')$('#p-inbox').innerHTML=inbox(S);
  if(page==='insights')$('#p-insights').innerHTML=insights(S);
}
async function load(){
  const t0=performance.now();
  const r=await fetch('/api/state');S=await r.json();render();
  $('#live').textContent='Updated '+new Date().toLocaleTimeString()+' ('+Math.round(performance.now()-t0)+' ms)';
}
async function post(path,body){const j=await call(path,body);if(j.failed)alert(j.error||'Something went wrong.');await load();return j}

document.addEventListener('click',async e=>{
  const el=e.target.closest('button,a');if(!el)return;
  const ds=el.dataset;
  if(ds.goto){e.preventDefault();history.replaceState(null,'','#'+ds.goto);go(ds.goto);return}
  if(ds.dismiss)return post('/api/attention/resolve',{id:ds.dismiss,resolution:'done'});
  if(ds.confirm)return post('/api/attention/confirm',{id:ds.confirm});
  if(ds.view){jobsView=ds.view;render();return}
  if(ds.skip){await post('/api/jobs/skip',{id:ds.skip});el.closest('.jobcard')&&el.closest('.jobcard').remove();return}
  if(ds.apply){await busyBtn(el,'Starting...',async()=>{const j=await post('/api/apply/start',{id:ds.apply});if(!j.failed&&page==='assistant'){chatLog.push({k:'res',t:'Writing the CV and letter. The review will appear under Applications in 5 to 15 minutes. Nothing is sent until you confirm.'});renderChat()}});return}
  if(ds.review)return openReview(ds.review);
  if(ds.ask!==undefined){history.replaceState(null,'','#assistant');go('assistant');await loadChat();ask(ds.ask);return}
  if(ds.yes||ds.no){const id=ds.yes||ds.no;const m=chatLog.find(x=>x.k==='ask'&&x.id===id);const j=await call('/api/agent/confirm',{id:id,yes:!!ds.yes});if(m)m.done=j.failed?(j.error||'Expired.'):ds.yes?'Yes':'No';if(!j.failed&&ds.yes)chatLog.push({k:'res',t:j.text,link:j.link});renderChat();load();return}
  if(ds.forget!==undefined){await call('/api/agent/forget',{index:Number(ds.forget)});await loadNotes();return}
  if(ds.close!==undefined){closeReview();return}
  if(ds.later){await call('/api/apply/later',{id:ds.later});closeReview();load();return}
  if(ds.confirmApply){await busyBtn(el,'One moment...',async()=>{const j=await call('/api/apply/confirm',{id:ds.confirmApply});if(j.failed){alert(j.error);return}if(j.how==='kit'){rvKit=j.kit;rvMode='kit';renderReview()}else{rvMode='fill';rv.sending=null;renderReview();const key=ds.confirmApply;rvPoll=setInterval(async()=>{const r=await fetch('/api/apply/review?key='+encodeURIComponent(key));if(!r.ok)return;const x=await r.json();if(x.sending&&!rv.sending){rv.sending=x.sending;renderReview()}},2000)}load()});return}
  if(ds.copy!==undefined&&rvKit){const a=rvKit.answers[Number(ds.copy)];try{await navigator.clipboard.writeText(a.answer);el.textContent='Copied'}catch(err){el.textContent='Copy failed'}return}
  if(ds.applied){const j=await call('/api/apply/applied',{id:ds.applied});if(j.failed){alert(j.error);return}closeReview();load();return}
  if(ds.send){const j=await call('/api/apply/send',{id:rv.key,decision:ds.send});if(j.failed)alert(j.error);closeReview();load();return}
  // Long work starts a background task and returns at once; the strip under the header shows it on every page.
  if(el.id==='scan-btn'){el.disabled=true;await call('/api/jobs/scan',{});await load();return}
  if(el.id==='score-btn'){el.disabled=true;const j=await call('/api/jobs/score',{});if(j.failed)alert(j.error||'Scoring failed.');await load();return}
  if(ds.stop){el.disabled=true;el.textContent='Stopping...';await call('/api/tasks/stop',{id:ds.stop});await load();return}
  if(ds.seen){markSeen(ds.seen);render();return}
  if(ds.draft){
    el.disabled=true;
    const j=await call('/api/setup/profile/draft',{file:ds.draft});
    say('#profile-msg',j.failed?(j.error||'Could not start.'):'Drafting your profile. It takes a minute or two. You can leave this page: the draft will wait here.',j.failed);
    await load();return}
  if(ds.import&&confirm('Copy the text of '+ds.import+' into your profile as it is? Nothing is rewritten.')){const j=await call('/api/setup/profile/import',{file:ds.import});say('#profile-msg',j.failed?(j.error||'That did not work.'):'Added to your profile, word for word.',j.failed);profileDirty=false;await loadSetup(true);return}
  if(el.id==='profile-save'){await busyBtn(el,'Saving...',async()=>{const j=await call('/api/setup/profile/save',{markdown:$('#profile-text').value});if(j.failed){say('#profile-msg',j.error||'Could not save.',true);return}profileDirty=false;(S.tasks||[]).filter(x=>x.kind==='profile').forEach(x=>{markSeen('draft:'+x.id);markSeen(x.id)});await loadSetup(true);say('#profile-msg','Saved.'+(j.backup?' The old one is in '+j.backup+'.':''))});return}
  if(el.id==='tg-unpair'&&confirm('Disconnect this phone? You can connect again right after.')){const j=await call('/api/setup/telegram/unpair');if(j.failed)alert(j.error);await loadSetup(true);return}
  if(el.id==='doctor'){await busyBtn(el,'Checking...',async()=>{const r=await fetch('/api/doctor');const checks=await r.json();$('#doctor-out').innerHTML='<div class="card" style="margin-top:12px">'+checks.map(c=>'<div class="lrow" style="align-items:flex-start"><div><div class="t">'+esc(c.name)+'</div><div class="sub">'+esc(c.detail)+'</div>'+(!c.ok&&c.fix?'<div class="sub">To fix, run: <code>'+esc(c.fix)+'</code></div>':'')+'</div>'+(c.ok?'<span class="badge ok">OK</span>':'<span class="badge'+(c.required?' bad':'')+'">'+(c.required?'Needed':'Optional')+'</span>')+'</div>').join('')+'</div>'});return}
});
document.addEventListener('input',e=>{
  if(e.target.id==='profile-text')profileDirty=true;
  if(e.target.id==='job-q'){jobsQuery=e.target.value;render()}
});
document.addEventListener('keydown',e=>{if(e.target.id==='chat-in'&&e.key==='Enter'&&!e.shiftKey){e.preventDefault();const t=e.target.value;e.target.value='';ask(t)}});
document.addEventListener('submit',async e=>{
  const f=e.target.closest('form');if(!f)return;e.preventDefault();
  if(f.dataset.answer!==undefined){post('/api/attention/answer',{id:f.dataset.answer,answer:f.answer.value,sensitive:f.sensitive.checked});return}
  if(f.id==='f-chat'){const i=$('#chat-in');const t=i.value;i.value='';ask(t);return}
  if(f.id==='f-quick'){const t=$('#quick-in').value;if(!t.trim())return;history.replaceState(null,'','#assistant');go('assistant');await loadChat();ask(t);return}
  if(f.id==='f-resume'){const file=f.file.files[0];if(!file)return;const b=f.querySelector('button');await busyBtn(b,'Uploading...',async()=>{
    const fd=new FormData();fd.append('file',file);
    const r=await fetch('/api/setup/resume',{method:'POST',headers:{'x-jobdesk-token':token},body:fd});const j=await r.json().catch(()=>({}));
    if(!r.ok){say('#profile-msg',j.error||'Upload failed.',true);return}
    await loadSetup(true);
    say('#profile-msg',j.needsClaude?'Saved '+j.file+'. It is a scan or photo, so drafting the profile needs Claude to read it.':'Saved '+j.file+' ('+j.chars+' characters read). Next: Draft profile from this.')});return}
  if(f.id==='f-look'){const j=await call('/api/setup/looking-for',{queries:f.queries.value,locations:f.locations.value,min_fit:f.min_fit.value});if(!j.failed){await loadSetup(true);await load()}say('#look-msg',j.failed?(j.error||'Could not save.'):'Saved.',j.failed);return}
  if(f.id==='f-tg'){const b=f.querySelector('button');await busyBtn(b,'Connecting...',async()=>{const j=await call('/api/setup/telegram',{token:f.token.value});if(j.failed){say('#tg-msg',j.error||'That did not work.',true);return}await loadSetup(true)});return}
  if(f.id==='f-sched'){const j=await call('/api/setup/schedule',{search:f.search.checked,time:f.time.value,apply:f.apply.value,digest_time:f.digest_time.value});if(!j.failed)await loadSetup(true);say('#sched-msg',j.failed?(j.error||'Could not save.'):'Saved.',j.failed);return}
  if(f.id==='f-send'){const v=(f.querySelector('input[name=level]:checked')||{}).value;const j=await call('/api/settings/sending',{level:v});if(!j.failed)await loadSetup(true);say('#send-msg',j.failed?(j.error||'Could not save.'):'Saved.',j.failed);return}
});

// First visit: Settings until setup is done, then Overview. After that, the last page used.
let saved=null;try{saved=localStorage.getItem('jd-page')}catch(e){}
const fromHash=location.hash.slice(1);
loadSetup(true).then(s=>{go(PAGES[fromHash]?fromHash:saved&&PAGES[saved]?saved:s.complete?'overview':'settings',false)});
load();
window.addEventListener('hashchange',()=>{const h=location.hash.slice(1);if(PAGES[h]&&h!==page)go(h)});
const es=new EventSource('/events');
es.onmessage=()=>{load();loadSetup()};
es.onerror=()=>{$('#live').textContent='Reconnecting...'};
})();
</script>
</body>
</html>`
}
