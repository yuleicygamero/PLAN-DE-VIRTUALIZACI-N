/*
 * Motor de la plataforma Plan de Virtualización.
 * Renderiza las vistas dentro de los contenedores que monta <App/> con los servicios
 * que recibe: db (cliente de la API .NET, src/api/db.js), downloads y canWrite
 * (false para usuarios de solo lectura).
 */
import * as XLSX from 'xlsx';

let started = false;
export function startPlan({ db, downloads, canWrite }) {
  if (started) return;
  started = true;
const LEVELS=[
 {id:'pregrado',name:'Pregrado',short:'PRE',vias:['por_definir','reestructuracion','cero'],def:'por_definir',color:'var(--l-pre)'},
 {id:'especializacion',name:'Especializaciones',short:'ESP',vias:['cero','reestructuracion','por_definir'],def:'cero',color:'var(--l-esp)'},
 {id:'maestria',name:'Maestrías',short:'MAE',vias:['reestructuracion','cero','por_definir'],def:'reestructuracion',color:'var(--l-mae)'},
 {id:'doctorado',name:'Doctorado',short:'DOC',vias:['por_definir','reestructuracion','cero'],def:'por_definir',color:'var(--l-doc)'},
 {id:'distancia',name:'A distancia',short:'DIS',vias:['por_definir','virtual','cero','reestructuracion'],def:'por_definir',color:'var(--l-dis)'}];
const LV=Object.fromEntries(LEVELS.map(l=>[l.id,l]));
const VIAS={por_definir:'Sin definir',reestructuracion:'Reestructuración',cero:'Desde cero',virtual:'Tomada de virtual'};
const VIA_COLOR={reestructuracion:'var(--l-mae)',cero:'var(--l-pre)',virtual:'var(--l-dis)',por_definir:'var(--st-no)'};
const STATUS={no_iniciado:'No iniciado',en_proceso:'En proceso',virtualizado:'Virtualizado'};
const ST_COLOR={no_iniciado:'var(--st-no)',en_proceso:'var(--st-pro)',virtualizado:'var(--st-ok)'};
const MONTHS=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

const S={db:null,dl:null,loaded:{programs:false},programs:new Map(),courses:new Map(),
  tab:'resumen',prog:null,lvlFilter:'all',search:'',sel:new Set(),editing:null,editVal:'',confirmDel:null,
  addVals:{},tcFilter:'',canWrite:canWrite!==false,deferred:false};

/* ---------- utils ---------- */
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9ñ ]+/g,' ').replace(/\s+/g,' ').trim();
const clean=s=>String(s??'').replace(/\s+/g,' ').trim();
const pct=(a,b)=>b?Math.round(a*100/b):0;
function semNum(s){
  s=String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const d=s.match(/\d+/); if(d){const n=+d[0];return n>0&&n<=20?n:0}
  const ord={primer:1,primero:1,segundo:2,tercer:3,tercero:3,cuarto:4,quinto:5,sexto:6,septimo:7,octavo:8,noveno:9,decimo:10};
  for(const k in ord) if(new RegExp('\\b'+k+'\\b').test(s)) return ord[k];
  const r=s.match(/\b(x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/);
  return r?{i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10}[r[1]]:0;
}
const pd=s=>{if(!s)return null;const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d)};
const today=()=>{const t=new Date();return new Date(t.getFullYear(),t.getMonth(),t.getDate())};
const fmtD=s=>{const d=pd(s);return d?`${d.getDate()} ${MONTHS[d.getMonth()]}`:'—'};
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const days=(a,b)=>Math.round((b-a)/864e5);
function toast(msg){const r=document.getElementById('toast-root');r.innerHTML=`<div class="toast" role="status">${esc(msg)}</div>`;clearTimeout(toast.t);toast.t=setTimeout(()=>r.innerHTML='',3200)}
async function pool(items,fn,n=4,onStep){let i=0,done=0;const run=async()=>{while(i<items.length){const it=items[i++];await fn(it);done++;onStep&&onStep(done)}};await Promise.all(Array.from({length:Math.min(n,items.length)},run))}
function stackBar(counts,total){total=total||1;return `<div class="stack">${['virtualizado','en_proceso'].map(k=>`<i style="width:${counts[k]*100/total}%;background:${ST_COLOR[k]}"></i>`).join('')}</div>`}

/* ---------- derived data ---------- */
function derive(list){
  const keys=new Map();
  for(const c of (list||[...S.courses.values()].filter(x=>!x.linked))){
    let g=keys.get(c.key); if(!g){g={key:c.key,name:c.name,ids:[],progs:new Set(),manual:false};keys.set(c.key,g)}
    g.ids.push(c.id); g.progs.add(c.programId); if(c.tc) g.manual=true;
  }
  const isTC=c=>{const g=keys.get(c.key);return !!g&&(g.progs.size>1||g.manual)};
  return {keys,isTC};
}
function emptyCounts(){return {total:0,no_iniciado:0,en_proceso:0,virtualizado:0,via:{por_definir:0,reestructuracion:0,cero:0,virtual:0}}}
function countOf(list){const c=emptyCounts();for(const x of list){c.total++;c[x.status]=(c[x.status]||0)+1;c.via[x.via]=(c.via[x.via]||0)+1}return c}
const uniqC=list=>{const m=new Map();for(const x of list)if(!m.has(x.key))m.set(x.key,x);return [...m.values()]};
const coursesOf=pid=>[...S.courses.values()].filter(c=>c.programId===pid);
const progsByLevel=(lv,all)=>[...S.programs.values()].filter(p=>p.level===lv&&!p.escalaOnly&&(all||!p.hidden)).sort((a,b)=>a.order-b.order);
const escalaProgs=()=>[...S.programs.values()].filter(p=>p.escala||p.escalaOnly).sort((a,b)=>a.name.localeCompare(b.name,'es'));
const visProgs=()=>[...S.programs.values()].filter(p=>!p.hidden&&!p.escalaOnly);
const isVis=c=>{const p=S.programs.get(c.programId);return !!p&&!p.hidden&&!p.escalaOnly};
function semestersOf(p,list){const set=new Set();for(let i=1;i<=(+p.semesters||0);i++)set.add(i);(list||coursesOf(p.id)).forEach(c=>set.add(+c.semester||1));return [...set].sort((a,b)=>a-b)}
/* ---------- render ---------- */
let rq=0;
function schedule(){if(rq)return;rq=requestAnimationFrame(()=>{rq=0;render()})}
function render(){
  const a=document.activeElement;
  if(a&&a.type==='date'&&document.getElementById('main').contains(a)){S.deferred=true;return}
  const fid=a&&a.id, ss=a&&a.selectionStart, se=a&&a.selectionEnd;
  document.querySelectorAll('#tabs .tab').forEach(b=>b.setAttribute('aria-selected',b.dataset.tab===S.tab));
  document.getElementById('export-btn').hidden=!S.dl;
  const m=document.getElementById('main');
  if(!S.db){m.innerHTML=`<div class="notice">No hay conexión con el servidor de la plataforma. Revisa que la API esté en ejecución.</div>`;return}
  if(!S.loaded.programs){m.innerHTML=`<div class="notice">Cargando programas y asignaturas…</div>`;return}
  for(const c of S.courses.values()){c.level=S.programs.get(c.programId)?.level;if(c.linked){const src=c.srcCid&&S.courses.get(c.srcCid);c._src=src?c.srcCid:'';c.status=src?src.status:(c.ownStatus||'no_iniciado')}}
  const D=derive();
  const nh=[...S.programs.values()].filter(p=>p.hidden).length;document.getElementById('tab-ocultos').textContent=nh?`Ocultos (${nh})`:'Ocultos';
  const plTop=m.querySelector('.plist')?.scrollTop??S.plistTop??0;
  m.innerHTML=S.tab==='resumen'?vResumen(derive([...S.courses.values()].filter(isVis))):S.tab==='programas'?vProgramas(D):S.tab==='cronograma'?vCrono(D):S.tab==='inicios'?vInicios():S.tab==='ocultos'?vOcultos():vTronco(derive([...S.courses.values()].filter(isVis)));
  const plEl=m.querySelector('.plist');if(plEl){plEl.scrollTop=plTop;S.plistTop=plTop;plEl.onscroll=()=>{S.plistTop=plEl.scrollTop}}
  renderBulk();
  if(fid){const el=document.getElementById(fid);if(el&&el!==document.activeElement){el.focus();try{if(ss!=null)el.setSelectionRange(ss,se)}catch(e){}}}
}

function vResumen(D){
  const all=[...S.courses.values()].filter(x=>isVis(x)&&!x.linked); const U=LEVELS.flatMap(L=>uniqC(all.filter(x=>x.level===L.id))); const c=countOf(U);
  const expected=visProgs().reduce((a,p)=>a+(p.expected||0),0);
  const tcGroups=[...D.keys.values()].filter(g=>g.progs.size>1||g.manual).length;
  let html=`<div class="section-head"><div><div class="eyebrow">Avance general</div><h2>${visProgs().length} programas · ${new Set(visProgs().map(p=>p.level)).size} niveles de formación</h2></div></div>
  <div class="kpis" style="margin-top:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">
    <div class="kpi" style="--kc:var(--l-esp)"><small># Asignaturas</small><b class="num">${c.total}</b><small>tronco común contado una vez por nivel</small></div>
    <div class="kpi" style="--kc:var(--l-mae)"><small>Tronco común</small><b class="num">${tcGroups}</b><small>se cuentan una sola vez</small></div>
    <div class="kpi" style="--kc:var(--st-no)"><small><i class="dot" style="background:var(--st-no)"></i>No iniciadas</small><b class="num">${c.no_iniciado}</b><small>${pct(c.no_iniciado,c.total)}%</small></div>
    <div class="kpi" style="--kc:var(--st-pro)"><small><i class="dot" style="background:var(--st-pro)"></i>En proceso</small><b class="num">${c.en_proceso}</b><small>${pct(c.en_proceso,c.total)}%</small></div>
    <div class="kpi" style="--kc:var(--st-ok)"><small><i class="dot" style="background:var(--st-ok)"></i>Virtualizadas</small><b class="num">${c.virtualizado}</b><small>${pct(c.virtualizado,c.total)}% del total</small></div>
  </div>`;
  html+=`<div class="section"><div class="section-head"><h2>Por nivel</h2><div class="legend"><span><i style="background:var(--st-ok)"></i>Virtualizado</span><span><i style="background:var(--st-pro)"></i>En proceso</span><span><i style="background:var(--st-no)"></i>No iniciado</span></div></div><div class="levels">`;
  for(const L of LEVELS){
    const ps=progsByLevel(L.id); const list=all.filter(x=>x.level===L.id); const lc=countOf(uniqC(list));
    const exp=ps.reduce((a,p)=>a+(p.expected||0),0);
    html+=`<div class="lvl" style="--lc:${L.color}">
      <div class="lvl-head"><h3>${L.name}</h3><span class="muted" style="white-space:nowrap">${ps.length} ${ps.length===1?'programa':'programas'}</span></div>
      <div class="lvl-big"><b class="num">${lc.total}</b><span class="muted">asignaturas</span></div>
      ${stackBar(lc,lc.total)}
      <div class="legend"><span class="num">${lc.virtualizado} virtualizadas</span><span class="num">${lc.en_proceso} en proceso</span><span class="num">${lc.no_iniciado} sin iniciar</span></div>
      <div class="vias">${L.vias.map(v=>`<span>${VIAS[v]}</span><span>${lc.via[v]||0}</span>`).join('')}</div>
    </div>`;
  }
  html+=`</div></div>`;
  const eps=escalaProgs();if(eps.length){const ec=countOf(uniqC([...S.courses.values()].filter(c=>!c.linked&&eps.some(p=>p.id===c.programId))));
    html+=`<div class="section"><div class="section-head"><h2>Escala Latam</h2><span class="muted" style="font-size:12px">Programas compartidos con Escala Latam · no se suman al avance general</span></div>
    <div class="lvl" style="--lc:var(--l-esc);max-width:520px">
      <div class="lvl-head"><h3>Escala Latam</h3><span class="muted" style="white-space:nowrap">${eps.length} programas</span></div>
      <div class="lvl-big"><b class="num">${ec.total}</b><span class="muted">asignaturas en total</span></div>
      ${stackBar(ec,ec.total)}
      <div class="legend"><span class="num" style="color:var(--st-ok)">${ec.virtualizado} virtualizadas</span><span class="num" style="color:var(--st-pro)">${ec.en_proceso} en proceso</span><span class="num">${ec.no_iniciado} sin iniciar</span><span class="num">${pct(ec.virtualizado,ec.total)}% de avance</span></div>
    </div></div>`}
  html+=`<div class="section"><div class="section-head"><h2>Por programa</h2>${lvlChips()}</div><div class="tbl-wrap"><table>
   <thead><tr><th>Programa</th><th>Nivel</th><th class="n"># Asignaturas</th><th class="n">Desde cero</th><th class="n">Reestruc.</th><th class="n">De virtual</th><th class="n">Sin vía</th><th class="n">No inic.</th><th class="n">En proceso</th><th class="n">Virtualiz.</th><th>Avance</th></tr></thead><tbody>`;
  for(const L of LEVELS){ if(S.lvlFilter!=='all'&&S.lvlFilter!==L.id)continue;
    for(const p of progsByLevel(L.id)){const pc=countOf(coursesOf(p.id));
      html+=`<tr class="click" data-open="${p.id}"><td style="min-width:240px">${esc(p.name)}</td><td><span class="lv-tag" style="--lc:${L.color}">${L.short}</span></td>
      <td class="n">${pc.total}</td><td class="n">${pc.via.cero}</td><td class="n">${pc.via.reestructuracion}</td><td class="n">${pc.via.virtual}</td><td class="n" style="${pc.via.por_definir?'color:var(--danger)':''}">${pc.via.por_definir}</td>
      <td class="n">${pc.no_iniciado}</td><td class="n">${pc.en_proceso}</td><td class="n">${pc.virtualizado}</td>
      <td><div class="prog-bar">${stackBar(pc,pc.total)}<span class="num muted" style="font-size:12px;min-width:34px;text-align:right">${pct(pc.virtualizado,pc.total)}%</span></div></td></tr>`;}
  }
  html+=`</tbody></table></div></div>`;
  return html;
}
function lvlChips(){return `<div class="filters">${[['all','Todos'],...LEVELS.map(l=>[l.id,l.name])].map(([k,n])=>`<button class="chip" data-lvl="${k}" aria-pressed="${S.lvlFilter===k}">${n}</button>`).join('')}</div>`}

function vProgramas(D){
  if(!S.prog||!S.programs.has(S.prog)) S.prog=visProgs().sort((a,b)=>a.order-b.order)[0]?.id;
  if(!S.prog) return `<div class="notice">Todos los programas están ocultos. Puedes mostrarlos desde la pestaña Ocultos.</div>`;
  const p=S.programs.get(S.prog); const L=LV[p.level];
  const q=norm(S.search);
  let list=`<div class="plist"><input id="psearch" type="search" placeholder="Buscar programa…" value="${esc(S.search)}" aria-label="Buscar programa"><div class="filters" style="margin:4px 0 2px">${[['all','Todos'],...LEVELS.filter(l=>progsByLevel(l.id).length).map(l=>[l.id,l.name]),...(escalaProgs().length?[['escala','Escala Latam']]:[])].map(([k,n])=>`<button class="chip" data-plvl="${k}" aria-pressed="${(S.plvl||'all')===k}">${n}</button>`).join('')}</div><div class="filters" style="margin:4px 0 2px">${[['all','Todas'],['Virtual','Virtual'],['Presencial','Presencial'],['Ambas','Ambas']].map(([k,n])=>`<button class="chip" data-pmod="${k}" aria-pressed="${(S.pmod||'all')===k}">${n}</button>`).join('')}</div>`;
  const MODS=['Virtual','Presencial','Ambas'];const modOf=x=>MODS.find(m=>norm(m)===norm(x.modalidad))||'';
  for(const lv of LEVELS){if(S.plvl&&S.plvl!=='all'&&S.plvl!==lv.id)continue;const ps=progsByLevel(lv.id).filter(x=>(!q||norm(x.name).includes(q))&&(!S.pmod||S.pmod==='all'||modOf(x)===S.pmod)); if(!ps.length)continue;
    list+=`<div class="pgroup"><div class="eyebrow"><span>${lv.name}</span><span>${ps.length}</span></div>`;
    const ordered=[...MODS,''].flatMap(m=>ps.filter(x=>modOf(x)===m));let lastMod=null;
    for(const x of ordered){const xc=countOf(coursesOf(x.id));const m=modOf(x);
      if(m!==lastMod){lastMod=m;list+=`<div class="msub"><span>${lv.name} ${m?m.toLowerCase():'· sin modalidad'}</span><span>${ordered.filter(y=>modOf(y)===m).length}</span></div>`}
      list+=`<button class="pitem" data-prog="${x.id}" aria-current="${x.id===p.id}"><span class="nm">${esc(x.name)}</span><span class="meta"><span class="num">${xc.total}</span>${stackBar(xc,xc.total)}<span class="num">${pct(xc.virtualizado,xc.total)}%</span></span></button>`}
    list+=`</div>`}
  if(!S.plvl||S.plvl==='all'||S.plvl==='escala'){const es=escalaProgs().filter(x=>(!q||norm(x.name).includes(q))&&(!S.pmod||S.pmod==='all'||modOf(x)===S.pmod));
    if(es.length){list+=`<div class="pgroup"><div class="eyebrow"><span>Escala Latam</span><span>${es.length}</span></div>`;
      for(const x of es){const xc=countOf(coursesOf(x.id));list+=`<button class="pitem" data-prog="${x.id}" aria-current="${x.id===p.id&&S.plvl==='escala'}"><span class="nm">${esc(x.name)}</span><span class="meta"><span class="lv-tag" style="--lc:${x.escalaOnly?'var(--l-esc)':LV[x.level].color};padding:1px 5px">${x.escalaOnly?'SOLO ESCALA':LV[x.level].short}</span><span class="num">${xc.total}</span>${stackBar(xc,xc.total)}<span class="num">${pct(xc.virtualizado,xc.total)}%</span></span></button>`}
      list+=`</div>`}}
  list+=`</div>`;
  const sel=`<div class="psel field" style="margin-bottom:12px"><label for="psel">Programa</label><select id="psel">${LEVELS.map(lv=>`<optgroup label="${lv.name}">${progsByLevel(lv.id).map(x=>`<option value="${x.id}" ${x.id===p.id?'selected':''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}</select></div>`;
  const cl=coursesOf(p.id); const pc=countOf(cl); const sems=semestersOf(p,cl);
  let body=`<div class="phead" style="--lc:${L.color}">
    <div class="phead-row"><div><div class="eyebrow">${L.name}${p.modalidad?` · <span style="color:var(--muted)">${esc(p.modalidad)}</span>`:''}</div><h2>${esc(p.name)}</h2></div>
      <div class="actions"><button class="btn primary" data-act="import">Subir plan de estudios</button>${p.escalaOnly?'':`<button class="btn" data-act="escala">${p.escala?'Quitar de Escala Latam':'Añadir a Escala Latam'}</button>`}<button class="btn" data-act="hide">${p.hidden?'Mostrar programa':'Ocultar programa'}</button></div></div>${p.escala||p.escalaOnly?`<div class="pill soon" style="align-self:flex-start">${p.escalaOnly?'Programa solo de Escala Latam · no se suma al avance general':'También en Escala Latam · el avance se replica allá'}</div>`:''}${p.hidden?'<div class="pill none" style="align-self:flex-start">Programa oculto · no se cuenta en el resumen</div>':''}
    <div class="facts">
      <div class="fact"><b>${pc.total}</b><small>asignaturas</small></div>
      <div class="fact"><b style="color:var(--st-ok)">${pc.virtualizado}</b><small>virtualizadas</small></div>
      <div class="fact"><b style="color:var(--st-pro)">${pc.en_proceso}</b><small>en proceso</small></div>
      <div class="fact"><b>${pc.no_iniciado}</b><small>sin iniciar</small></div>
      <div class="fact"><b>${cl.filter(c=>!c.linked&&D.isTC(c)).length}</b><small>tronco común</small></div>${cl.some(c=>c.linked)?`<div class="fact"><b>${cl.filter(c=>!c.linked).length} <span class="muted" style="font-size:13px">+ ${cl.filter(c=>c.linked).length} tomadas</span></b><small>a producir + tomadas de otros programas</small></div>`:''}
      ${p.expectedTC!=null?`<div class="fact"><b class="muted">${esc(p.expectedDisc)} + ${esc(p.expectedTC)}</b><small>disciplinar + TC (conteo inicial)</small></div>`:''}
    </div>
    <div class="facts">
      <label class="field">Semestres<input type="number" min="1" max="12" id="p-sems" value="${esc(p.semesters||'')}" placeholder="${sems.length||'—'}" style="width:90px"></label>
      <label class="field">Vía por defecto<select id="p-via">${L.vias.map(v=>`<option value="${v}" ${p.defaultVia===v?'selected':''}>${VIAS[v]}</option>`).join('')}</select></label>
    </div>
    <div class="facts" style="padding-top:12px;border-top:1px solid var(--line)">
      <label class="field">Inicio de producción<input type="date" id="p-prod" value="${esc(p.prodStart||'')}"></label>
      <label class="field">Inicio del programa (clases)<input type="date" id="p-class" value="${esc(p.classStart||'')}"></label>
      <label class="field">Semestres a producir<input type="number" min="1" max="14" id="p-nsem" value="${esc(p.semsToProduce||'')}" placeholder="${sems.length||'—'}" style="width:110px"></label>
      ${(()=>{const r=progPlan(p);return `<div class="fact" style="align-self:center"><span class="pill ${r.cls}">${r.txt}</span><small style="margin-top:4px">${r.c.virtualizado}/${r.c.total} asignaturas listas de S1 a S${r.n}</small></div>`})()}
    </div></div>`;
  if(!sems.length) body+=`<div class="notice" style="margin-top:14px">Este programa aún no tiene asignaturas. Usa <b>Subir plan de estudios</b> para cargar un Excel o CSV, o pegar el listado; también puedes indicar el número de semestres y agregar asignaturas a mano.</div>`;
  for(const s of sems){
    const sl=cl.filter(c=>(c.semester||1)===s).sort((a,b)=>a.name.localeCompare(b.name,'es'));
    const sc=countOf(sl);
    const allSel=sl.length&&sl.every(c=>S.sel.has(c.id));
    body+=`<section class="sem"><div class="sem-head">
      <h3>Semestre ${s}</h3>
      ${p.semsToProduce?(s<=p.semsToProduce?'<span class="pill soon">Se produce en esta fase</span>':'<span class="pill none">Fuera de esta fase</span>'):''}
      <div class="sp"><span class="num muted" style="font-size:12px">${sc.virtualizado}/${sc.total} virtualizadas</span>
      <select class="sel" data-semvia="${s}" aria-label="Vía para todo el semestre"><option value="">Vía para todo el semestre…</option>${L.vias.map(v=>`<option value="${v}">${VIAS[v]}</option>`).join('')}</select></div>
    </div><div style="overflow-x:auto"><table><thead><tr><th style="width:34px"><input type="checkbox" data-selsem="${s}" ${allSel?'checked':''} aria-label="Seleccionar semestre ${s}"></th><th>Asignatura</th><th style="width:170px">Vía</th><th style="width:330px">Estado <span style="text-transform:none;letter-spacing:0;font-weight:500">· un clic</span></th><th style="width:130px"></th></tr></thead><tbody>`;
    for(const c of sl){
      const tc=D.isTC(c); const g=D.keys.get(c.key);
      const others=tc?[...g.progs].filter(x=>x!==p.id).map(x=>S.programs.get(x)?.name||x):[];
      const tip=others.length?'También en: '+others.join(' · '):c.tcSrc?'Marcada en el plan de estudios como '+(c.tcSrc==='duplicado'?'duplicado':'tronco común'):'Marcada manualmente como tronco común';
      const nameCell=S.editing===c.id?`<input id="edit-name" value="${esc(S.editVal)}" aria-label="Nombre de la asignatura">`:`${c.slot?`<span class="slot">${esc(c.slot)}</span>`:''}<span>${esc(c.name)}</span>${c.linked?`<span class="slot" style="background:var(--accent-soft);color:var(--accent)" title="No se contabiliza en el nivel: el avance se toma del programa de origen">Tomada de ${esc(S.programs.get(c.srcPid)?.name||'otro programa')}${c._src?'':' · sin enlace'}</span>`:''}${tc&&!c.linked?`<span class="tc ${others.length?'':'man'}" title="${esc(tip)}">TRONCO COMÚN${others.length?' · '+(others.length+1):''}</span>`:''}`;
      body+=`<tr class="crow" data-id="${c.id}"><td><input type="checkbox" data-sel="${c.id}" ${S.sel.has(c.id)?'checked':''} aria-label="Seleccionar"></td>
      <td><div class="cname">${nameCell}</div></td>
      <td>${c.linked?'<span class="muted" style="font-size:12px">Tomada de virtual</span>':`<select class="sel via" data-via="${c.id}" data-v="${esc(c.via)}" aria-label="Vía">${L.vias.concat(L.vias.includes(c.via)?[]:[c.via]).map(v=>`<option value="${esc(v)}" ${c.via===v?'selected':''}>${esc(VIAS[v]||v)}</option>`).join('')}</select>`}</td>
      <td><div class="stseg" role="group" aria-label="Estado">${Object.entries(STATUS).map(([k,n])=>`<button data-setst="${c.id}" data-val="${k}" aria-pressed="${c.status===k}" style="--c:${ST_COLOR[k]}">${n}</button>`).join('')}</div></td>
      <td><div class="rowact ${S.editing===c.id||S.confirmDel===c.id?'on':''}">${S.editing===c.id?`<button class="icon-btn" data-save="${c.id}">Guardar</button><button class="icon-btn" data-cancel>Cancelar</button>`:
        S.confirmDel===c.id?`<button class="icon-btn danger" data-del="${c.id}">¿Eliminar?</button><button class="icon-btn" data-cancel>No</button>`:
        `<button class="icon-btn" data-edit="${c.id}" title="Editar nombre">Editar</button><button class="icon-btn" data-tcman="${c.id}" title="${c.tc?'Quitar marca manual de tronco común':'Marcar como tronco común'}">${c.tc?'−TC':'+TC'}</button><button class="icon-btn danger" data-askdel="${c.id}" title="Eliminar">✕</button>`}</div></td></tr>`;
    }
    body+=`<tr class="addrow"><td></td><td colspan="4"><input id="add-${s}" data-add="${s}" placeholder="+ Agregar asignatura al semestre ${s} (Enter para guardar)" value="${esc(S.addVals[s]||'')}"></td></tr></tbody></table></div></section>`;
  }
  body+=`<div style="margin-top:14px"><button class="btn" data-act="addsem">+ Agregar semestre</button></div>`;
  return `<div class="pv">${list}<div style="min-width:0">${sel}${body}</div></div>`;
}

function renderBulk(){
  const r=document.getElementById('bulk-root');
  const ids=[...S.sel].filter(id=>S.courses.has(id));
  if(S.tab!=='programas'||!ids.length){r.innerHTML='';return}
  r.innerHTML=`<div class="bulk"><b class="num">${ids.length}</b> seleccionadas
   <select id="bulk-via" aria-label="Cambiar vía"><option value="">Cambiar vía…</option>${Object.entries(VIAS).map(([k,n])=>`<option value="${k}">${n}</option>`).join('')}</select>
   <select id="bulk-st" aria-label="Cambiar estado"><option value="">Cambiar estado…</option>${Object.entries(STATUS).map(([k,n])=>`<option value="${k}">${n}</option>`).join('')}</select>
   <button class="btn" data-bulkdel>${S.confirmDel==='bulk'?'Confirmar eliminación':'Eliminar'}</button><button class="btn" data-bulkclear>Limpiar</button></div>`;
}

function progPlan(p){
  const all=coursesOf(p.id);const n=p.semsToProduce||Math.max(0,...all.map(c=>c.semester||1),p.semesters||0)||0;
  const cl=all.filter(c=>(c.semester||1)<=n);const c=countOf(cl);const t=today();const ps=pd(p.prodStart),cs=pd(p.classStart);
  let cls='none',txt='Sin fechas';
  if(c.total&&c.virtualizado===c.total){cls='done';txt='Listo'}
  else if(cs&&cs<t){cls='late';txt='Vencido'}
  else if(ps&&ps<=t){const d=cs?days(t,cs):null;cls=d!=null&&d<=30?'late':'now';txt=d!=null?`En producción · faltan ${d} d`:'En producción'}
  else if(ps){cls='soon';txt=`Producción inicia en ${days(t,ps)} d`}
  else if(cs){cls='soon';txt=`Clases en ${days(t,cs)} d`}
  return {n,c,cls,txt,missing:c.total-c.virtualizado};
}
function saveProg(pid,patch){const p=S.programs.get(pid);S.programs.set(pid,{...p,...patch});schedule();S.db.doc('programs/'+pid).update(patch).catch(fail)}
const DOW=['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];const MONTHS_L=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
function cronoItems(){const items=[];for(const L of LEVELS){if(S.lvlFilter!=='all'&&S.lvlFilter!==L.id)continue;for(const p of progsByLevel(L.id)){items.push({p,L,r:progPlan(p),a:pd(p.prodStart),b:pd(p.classStart)})}}return items}
function cronoEvents(items){const ev=[];for(const i of items){if(i.a)ev.push({d:i.a,kind:'prod',i});if(i.b)ev.push({d:i.b,kind:'class',i})}return ev}
function vCrono(D){
  const t=today();const items=cronoItems();
  const sched=items.filter(i=>i.a||i.b);const unsched=items.filter(i=>!i.a&&!i.b);
  const view=S.cview||'gantt';
  let h=`<div class="section-head"><div><div class="eyebrow">Programación de producción</div><h2>Cronograma</h2></div>${lvlChips()}</div>
  <div class="kpis" style="margin-top:12px;grid-template-columns:repeat(4,minmax(0,1fr))">
   <div class="kpi"><small>Programas con fechas</small><b class="num">${sched.length}</b><small>de ${items.length}</small></div>
   <div class="kpi"><small><i class="dot" style="background:var(--st-pro)"></i>En producción</small><b class="num">${items.filter(i=>i.r.txt.startsWith('En producción')).length}</b><small>programas</small></div>
   <div class="kpi"><small>Por iniciar producción</small><b class="num">${items.filter(i=>i.r.txt.startsWith('Producción inicia')).length}</b><small>programas</small></div>
   <div class="kpi"><small><i class="dot" style="background:var(--danger)"></i>Vencidos</small><b class="num">${items.filter(i=>i.r.txt==='Vencido').length}</b><small>clases iniciadas sin terminar</small></div></div>
  <div class="section-head" style="margin-top:24px"><div class="seg" role="group" aria-label="Vista"><button data-cview="gantt" aria-pressed="${view==='gantt'}">Diagrama de Gantt</button><button data-cview="cal" aria-pressed="${view==='cal'}">Calendario</button></div>
  <div class="legend"><span><i style="background:var(--accent)"></i>Inicio de producción</span><span><i style="background:var(--st-ok)"></i>Inicio de clases</span></div></div>`;
  h+=view==='cal'?calHtml(sched):ganttHtml(sched);
  if(unsched.length)h+=`<div class="section"><h3>Sin fechas (${unsched.length})</h3><div class="list" style="max-height:360px;overflow:auto">${unsched.map(i=>`<div class="li" data-open="${i.p.id}"><div class="t"><b>${esc(i.p.name)}</b><small>${i.L.name}${i.p.modalidad?' · '+esc(i.p.modalidad):''}</small></div><span class="pill none">Sin fechas</span></div>`).join('')}</div></div>`;
  return h;
}
function ganttHtml(sched){
  const t=today();let mn=null,mx=null;sched.forEach(i=>[i.a,i.b].forEach(d=>{if(d){mn=!mn||d<mn?d:mn;mx=!mx||d>mx?d:mx}}));
  let start=new Date(Math.min(+(mn||t),+t));start=new Date(start.getFullYear(),start.getMonth(),1);
  let end=new Date(Math.max(+(mx||t),+new Date(t.getFullYear(),11,31)));end=new Date(end.getFullYear(),end.getMonth()+1,0);
  const span=end-start+864e5;const pos=d=>(d-start)*100/span;
  const months=[];for(let d=new Date(start);d<=end;d=new Date(d.getFullYear(),d.getMonth()+1,1))months.push(new Date(d));
  const grid=months.map(m=>`<div class="g-month" style="left:${pos(m)}%;width:${(new Date(m.getFullYear(),m.getMonth()+1,1)-m)*100/span}%"><span>${MONTHS[m.getMonth()]} ${String(m.getFullYear()).slice(2)}</span></div>`).join('');
  const gridNo=grid.replace(/<span>.*?<\/span>/g,'');const todayLine=`<div class="g-today" style="left:${pos(t)}%"></div>`;
  const key=i=>i.a?+i.a:(i.b?+i.b+1e13:9e15);
  const list=[...sched].sort((x,y)=>key(x)-key(y)||x.p.name.localeCompare(y.p.name,'es'));
  let h=`<div class="section" style="margin-top:14px"><div class="tbl-wrap"><div class="gantt"><div class="g-row g-head"><div class="g-label"><span class="eyebrow">Programa · ordenado por inicio de producción</span></div><div class="g-track">${grid}${todayLine}</div></div>`;
  if(!list.length)h+=`<div style="padding:20px" class="muted">Aún no hay fechas. Asígnalas en la pestaña <b>Inicio de clases</b> o en el encabezado de cada programa.</div>`;
  for(const i of list){const pr=i.r.c.total?i.r.c.virtualizado*100/i.r.c.total:0;let mark='';
    if(i.a&&i.b){const l=pos(i.a),w=Math.max(pos(new Date(+i.b+864e5))-l,.8);mark=`<div class="bar" data-open="${i.p.id}" style="--lc:${i.L.color};left:${l}%;width:${w}%;top:9px" title="${esc(i.p.name)}\nProducción: ${fmtD(i.p.prodStart)} · Clases: ${fmtD(i.p.classStart)}\n${i.r.txt}"><i style="width:${pr}%"></i><span>${fmtD(i.p.prodStart)} → ${fmtD(i.p.classStart)}</span></div>`}
    else{const d=i.a||i.b;const k=i.a?'prod':'class';mark=`<div class="gm ${k}" data-open="${i.p.id}" style="left:${pos(d)}%" title="${esc(i.p.name)}\n${i.a?'Inicio de producción':'Inicio de clases'}: ${fmtD(i.a?i.p.prodStart:i.p.classStart)}"><b></b><span>${i.a?'Prod.':'Clases'} ${fmtD(i.a?i.p.prodStart:i.p.classStart)}</span></div>`}
    h+=`<div class="g-row"><div class="g-label"><span class="nm" data-open="${i.p.id}"><span class="lv-tag" style="--lc:${i.L.color};margin-right:6px">${i.L.short}</span>${esc(i.p.name)}</span><span class="muted" style="font-size:11px">S1–S${i.r.n} · ${i.r.c.virtualizado}/${i.r.c.total} listas</span></div><div class="g-track" style="height:40px">${gridNo}${todayLine}${mark}</div></div>`}
  return h+`</div></div></div>`;
}
function calHtml(sched){
  const t=today();const mode=S.cmode||'month';const cur=S.cdate?new Date(S.cdate):new Date(t);
  const ev=cronoEvents(sched);const byDay=new Map();ev.forEach(e=>{const k=iso(e.d);if(!byDay.has(k))byDay.set(k,[]);byDay.get(k).push(e)});
  let title='';if(mode==='month')title=`${MONTHS_L[cur.getMonth()]} ${cur.getFullYear()}`;else if(mode==='year')title=`${cur.getFullYear()}`;else{const ws=new Date(cur);ws.setDate(cur.getDate()-cur.getDay());const we=new Date(+ws+6*864e5);title=`${ws.getDate()} ${MONTHS[ws.getMonth()]} – ${we.getDate()} ${MONTHS[we.getMonth()]} ${we.getFullYear()}`}
  let h=`<div class="section" style="margin-top:14px"><div class="cal"><div class="cal-bar"><div class="actions"><button class="btn" data-cnav="-1" aria-label="Anterior">‹</button><button class="btn" data-cnav="1" aria-label="Siguiente">›</button><button class="btn" data-cnav="0">Hoy</button></div><h3 class="cal-title">${title}</h3>
  <div class="seg"><button data-cmode="year" aria-pressed="${mode==='year'}">Año</button><button data-cmode="month" aria-pressed="${mode==='month'}">Mes</button><button data-cmode="week" aria-pressed="${mode==='week'}">Semana</button></div></div>`;
  const chip=e=>`<div class="cev ${e.kind}" data-open="${e.i.p.id}" title="${esc(e.i.p.name)} · ${e.kind==='prod'?'Inicio de producción':'Inicio de clases'}">${e.kind==='prod'?'Prod.':'Clases'} · ${esc(e.i.p.name)}</div>`;
  const cell=(d,other,max)=>{const k=iso(d);const es=byDay.get(k)||[];const isT=+d===+t;const wk=d.getDay()===0||d.getDay()===6;
    return `<div class="cday ${other?'other':''} ${isT?'today':''}"><div class="cnum"><span class="${wk?'wkend':''}">${d.getDate()}</span>${es.length?`<span class="cbadge">${es.length}</span>`:''}</div>${es.slice(0,max).map(chip).join('')}${es.length>max?`<button class="cmore" data-cday="${k}">+${es.length-max} más</button>`:''}</div>`};
  if(mode==='month'){const first=new Date(cur.getFullYear(),cur.getMonth(),1);const st=new Date(first);st.setDate(1-first.getDay());
    h+=`<div class="cgrid"><div class="cdow">${DOW.map(x=>`<div>${x}</div>`).join('')}</div><div class="cweeks">`;
    for(let w=0;w<6;w++){h+=`<div class="cweek">`;for(let k=0;k<7;k++){const d=new Date(st.getFullYear(),st.getMonth(),st.getDate()+w*7+k);h+=cell(d,d.getMonth()!==cur.getMonth(),3)}h+=`</div>`}
    h+=`</div></div>`}
  else if(mode==='week'){const ws=new Date(cur.getFullYear(),cur.getMonth(),cur.getDate()-cur.getDay());
    h+=`<div class="cgrid"><div class="cdow">${DOW.map((x,k)=>{const d=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+k);return `<div>${x} ${d.getDate()}</div>`}).join('')}</div><div class="cweeks"><div class="cweek tall">`;
    for(let k=0;k<7;k++){const d=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+k);h+=cell(d,false,99)}h+=`</div></div></div>`}
  else{h+=`<div class="cyear">`;for(let m=0;m<12;m++){const first=new Date(cur.getFullYear(),m,1);const st=new Date(first);st.setDate(1-first.getDay());
      const n=ev.filter(e=>e.d.getFullYear()===cur.getFullYear()&&e.d.getMonth()===m).length;
      h+=`<div class="cmini" data-cgo="${cur.getFullYear()}-${m}"><div class="cmini-h"><b>${MONTHS_L[m]}</b>${n?`<span class="cbadge">${n}</span>`:''}</div><div class="cmini-g">${DOW.map(x=>`<span class="muted">${x[0]}</span>`).join('')}`;
      for(let k=0;k<42;k++){const d=new Date(st.getFullYear(),st.getMonth(),st.getDate()+k);const es=byDay.get(iso(d))||[];const o=d.getMonth()!==m;
        h+=`<span class="${o?'o':''} ${+d===+t?'t':''} ${!o&&es.length?(es.some(e=>e.kind==='class')?'hc':'hp'):''}">${d.getDate()}</span>`}
      h+=`</div></div>`}h+=`</div>`}
  return h+`</div></div>`;
}
function openDay(k){const d=pd(k);const es=cronoEvents(cronoItems()).filter(e=>iso(e.d)===k);
  openModal(`<div class="modal-h"><div><div class="eyebrow">Eventos del día</div><h2>${d.getDate()} de ${MONTHS_L[d.getMonth()].toLowerCase()} de ${d.getFullYear()}</h2></div><button class="btn ghost" data-close>Cerrar</button></div><div class="modal-b"><div class="list">${es.map(e=>`<div class="li" data-open="${e.i.p.id}"><div class="t"><b>${esc(e.i.p.name)}</b><small>${e.i.L.name} · ${e.kind==='prod'?'Inicio de producción':'Inicio de clases'}</small></div><span class="pill ${e.i.r.cls}">${e.i.r.txt}</span></div>`).join('')}</div></div>`);
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=closeModal)}

function vTronco(D){
  const q=norm(S.tcFilter);
  const groups=[...D.keys.values()].filter(g=>(g.progs.size>1||g.manual)&&(!q||g.key.includes(q))).sort((a,b)=>b.progs.size-a.progs.size||a.name.localeCompare(b.name,'es'));
  const total=[...D.keys.values()].filter(g=>g.progs.size>1||g.manual);
  const rows=total.reduce((a,g)=>a+g.ids.length,0);
  let html=`<div class="section-head"><div><div class="eyebrow">Asignaturas compartidas</div><h2>Tronco común detectado</h2><p class="muted" style="margin:4px 0 0;max-width:70ch">Se marca como tronco común toda asignatura cuyo nombre se repite en más de un programa (sin importar tildes ni mayúsculas), o que marcaste a mano. Se produce una sola vez: al cambiar su estado aquí se actualiza en todos los programas.</p></div>
  <input id="tcsearch" type="search" placeholder="Filtrar…" value="${esc(S.tcFilter)}" class="search-in"></div>
  <div class="kpis" style="margin-top:12px;grid-template-columns:repeat(3,minmax(0,1fr))"><div class="kpi"><small>Asignaturas de tronco común</small><b class="num">${total.length}</b></div><div class="kpi"><small>Apariciones en planes</small><b class="num">${rows}</b></div><div class="kpi"><small>Cursos que se ahorran</small><b class="num">${rows-total.length}</b><small>por producirse una sola vez</small></div></div>`;
  if(!groups.length) return html+`<div class="notice" style="margin-top:16px">${total.length?'Ningún resultado para ese filtro.':'Aún no hay asignaturas repetidas. Aparecerán aquí a medida que subas los planes de estudio.'}</div>`;
  html+=`<div class="section"><div class="tbl-wrap"><table><thead><tr><th>Asignatura</th><th>Programas</th><th class="n">Veces</th><th>Estado conjunto</th><th style="width:170px">Cambiar en todos</th></tr></thead><tbody>`;
  for(const g of groups){const cs=g.ids.map(id=>S.courses.get(id));const cc=countOf(cs);
    const agg=cc.virtualizado===cc.total?'virtualizado':(cc.en_proceso||cc.virtualizado)?'en_proceso':'no_iniciado';
    html+=`<tr><td style="min-width:200px">${esc(cs[0].name)}</td><td style="min-width:260px">${[...g.progs].map(pid=>{const p=S.programs.get(pid);return `<span class="lv-tag" style="--lc:${LV[p?.level]?.color};margin:2px 4px 2px 0;font-family:var(--f-body);text-transform:none;letter-spacing:0;font-weight:500;cursor:pointer" data-open="${pid}">${esc(p?.name||pid)}</span>`}).join('')}</td>
    <td class="n">${g.ids.length}</td><td><span class="pill ${agg==='virtualizado'?'done':agg==='en_proceso'?'now':'none'}">${STATUS[agg]}</span> <span class="muted num" style="font-size:12px">${cc.virtualizado}/${cc.total}</span></td>
    <td><select class="sel" data-tcst="${esc(g.key)}"><option value="">Estado…</option>${Object.entries(STATUS).map(([k,n])=>`<option value="${k}">${n}</option>`).join('')}</select></td></tr>`}
  return html+`</tbody></table></div></div>`;
}

/* ---------- hidden programs ---------- */
function toggleHidden(pid){const p=S.programs.get(pid);if(!p)return;const h=!p.hidden;S.programs.set(pid,{...p,hidden:h});
  if(h&&S.prog===pid&&S.tab==='programas'){S.prog=null}
  schedule();toast(h?`${p.name} quedó oculto`:`${p.name} vuelve a contarse en el resumen`);
  S.db.doc('programs/'+pid).update({hidden:h}).catch(fail)}
/* ---------- class start dates ---------- */
const MODS2=['Virtual','Presencial','Ambas'];const modOf2=x=>MODS2.find(m=>norm(m)===norm(x.modalidad))||'';
function startProgs(){return visProgs().filter(p=>(!S.ilvl||S.ilvl==='all'||p.level===S.ilvl)&&(!S.imod||S.imod==='all'||modOf2(p)===S.imod)).sort((a,b)=>LEVELS.findIndex(l=>l.id===a.level)-LEVELS.findIndex(l=>l.id===b.level)||a.order-b.order)}
function bulkStart(){
  const prod=document.getElementById('ib-prod').value,cls=document.getElementById('ib-class').value,n=+document.getElementById('ib-n').value||0;
  if(!prod&&!cls&&!n){toast('Indica al menos una fecha o el número de semestres.');return}
  const patch={};if(prod)patch.prodStart=prod;if(cls)patch.classStart=cls;if(n)patch.semsToProduce=Math.min(14,n);
  const ps=startProgs();ps.forEach(p=>saveProg(p.id,patch));toast(`Datos aplicados a ${ps.length} programas`);
}
function vInicios(){
  const ps=startProgs();const t=today();
  const rows=ps.map(p=>({p,r:progPlan(p)}));
  const up=rows.filter(e=>e.p.classStart&&pd(e.p.classStart)>=t).sort((a,b)=>a.p.classStart.localeCompare(b.p.classStart));
  const chips=(attr,cur,opts)=>`<div class="filters">${opts.map(([k,n])=>`<button class="chip" data-${attr}="${k}" aria-pressed="${(cur||'all')===k}">${n}</button>`).join('')}</div>`;
  let h=`<div class="section-head"><div><div class="eyebrow">Calendario académico</div><h2>Inicio de clases</h2><p class="muted" style="margin:4px 0 0;max-width:72ch">Por programa: cuándo inicia la producción, cuándo inician clases y cuántos semestres deben estar virtualizados (del 1 al número que indiques).</p></div></div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">${chips('ilvl',S.ilvl,[['all','Todos los niveles'],...LEVELS.filter(l=>progsByLevel(l.id).length).map(l=>[l.id,l.name])])}${chips('imod',S.imod,[['all','Todas'],['Virtual','Virtual'],['Presencial','Presencial'],['Ambas','Ambas']])}</div>
  <div class="kpis" style="margin-top:16px;grid-template-columns:repeat(4,minmax(0,1fr))">
   <div class="kpi"><small>Programas en la vista</small><b class="num">${ps.length}</b><small>${rows.filter(e=>e.p.classStart).length} con fecha de clases</small></div>
   <div class="kpi"><small>Próximo inicio de clases</small><b class="num" style="font-size:22px">${up[0]?fmtD(up[0].p.classStart)+' '+pd(up[0].p.classStart).getFullYear():'—'}</b><small>${up[0]?esc(up[0].p.name):'sin fechas próximas'}</small></div>
   <div class="kpi"><small><i class="dot" style="background:var(--danger)"></i>Urgentes o vencidos</small><b class="num">${rows.filter(e=>e.r.cls==='late').length}</b><small>30 días o menos sin terminar</small></div>
   <div class="kpi"><small>Asignaturas por terminar</small><b class="num">${rows.reduce((a,e)=>a+(e.p.classStart?e.r.missing:0),0)}</b><small>en programas con fecha</small></div></div>
  <div class="section"><div class="phead" style="flex-direction:row;flex-wrap:wrap;align-items:flex-end;gap:12px">
   <label class="field">Inicio de producción<input type="date" id="ib-prod"></label>
   <label class="field">Inicio de clases<input type="date" id="ib-class"></label>
   <label class="field">Semestres a producir<input type="number" id="ib-n" min="1" max="14" placeholder="Ej: 2" style="width:120px"></label>
   <button class="btn primary" data-ibulk>Aplicar a los ${ps.length} programas filtrados</button>
   <span class="muted" style="font-size:12px;flex-basis:100%">Los campos vacíos no se cambian. Luego puedes ajustar cada programa en la tabla.</span></div></div>
  <div class="section"><div class="tbl-wrap"><table><thead><tr><th>Programa</th><th>Inicio de producción</th><th>Inicio de clases</th><th>Semestres a producir</th><th>Avance</th><th>Estado</th></tr></thead><tbody>`;
  let last='';
  for(const {p,r} of rows){const L=LV[p.level];
    if(p.level!==last){last=p.level;h+=`<tr><td colspan="6" style="background:var(--accent-soft);font-weight:700;font-size:12px">${L.name}</td></tr>`}
    h+=`<tr><td style="min-width:220px"><a href="#" data-open="${p.id}" style="color:inherit;font-weight:600">${esc(p.name)}</a><div class="muted" style="font-size:11.5px">${p.modalidad?esc(p.modalidad)+' · ':''}${semestersOf(p).length} semestres en el plan</div></td>
    <td><input type="date" class="search-in" style="padding:5px 8px;font-size:12px" data-ifield="${p.id}|prodStart" value="${esc(p.prodStart||'')}"></td>
    <td><input type="date" class="search-in" style="padding:5px 8px;font-size:12px" data-ifield="${p.id}|classStart" value="${esc(p.classStart||'')}"></td>
    <td><input type="number" min="1" max="14" class="search-in" style="padding:5px 8px;font-size:12px;width:80px" data-ifield="${p.id}|semsToProduce" value="${esc(p.semsToProduce||'')}" placeholder="${r.n||'—'}"></td>
    <td style="min-width:150px"><div class="prog-bar">${stackBar(r.c,r.c.total)}<span class="num muted" style="font-size:12px;white-space:nowrap">${r.c.virtualizado}/${r.c.total}</span></div></td>
    <td><span class="pill ${r.cls}">${r.txt}</span></td></tr>`}
  return h+`</tbody></table></div></div>`;
}

function vOcultos(){
  const hs=[...S.programs.values()].filter(p=>p.hidden).sort((a,b)=>a.order-b.order);
  let h=`<div class="section-head"><div><div class="eyebrow">Programas ocultos</div><h2>${hs.length} ${hs.length===1?'programa oculto':'programas ocultos'}</h2><p class="muted" style="margin:4px 0 0;max-width:70ch">Los programas ocultos no aparecen en la lista de programas ni se cuentan en el resumen, el cronograma o el tronco común. Sus asignaturas se conservan.</p></div></div>`;
  if(!hs.length)return h+`<div class="notice" style="margin-top:16px">No hay programas ocultos. Para ocultar uno, ábrelo en Programas y asignaturas y usa <b>Ocultar programa</b>.</div>`;
  h+=`<div class="section"><div class="list">`;
  for(const p of hs){const L=LV[p.level];const n=coursesOf(p.id).length;
    h+=`<div class="li" style="cursor:default"><div class="t"><b>${esc(p.name)}</b><small>${L?.name||''}${p.modalidad?' · '+esc(p.modalidad):''} · ${n} asignaturas</small></div><div class="actions"><button class="btn" data-open="${p.id}">Ver</button><button class="btn primary" data-show="${p.id}">Mostrar</button></div></div>`}
  return h+`</div></div>`;
}

/* ---------- writes ---------- */
/* Courses live in one document per program: pc/<programId> = {courses:{<id>:{...}}} */
const PC=new Set();const Q={};
const newCid=()=>'c'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
function enqueue(pid,fn){const prev=Q[pid]||Promise.resolve();const n=prev.then(fn,fn);Q[pid]=n.catch(()=>{});return n}
function writeCourses(pid,map){
  if(!Object.keys(map).length)return Promise.resolve();
  return enqueue(pid,async()=>{const ref=S.db.doc('pc/'+pid);
    if(!PC.has(pid)){const g=await ref.get();if(!g.exists){await ref.set({programId:pid,courses:map});PC.add(pid);return}PC.add(pid)}
    await ref.update({courses:map});});
}
async function updMany(ids,patch){
  const by={};const ts=new Date().toISOString();
  for(const id of ids){const c=S.courses.get(id);if(!c)continue;(by[c.programId]=by[c.programId]||{})[id]={...patch,updatedAt:ts}}
  await Promise.all(Object.entries(by).map(([pid,m])=>writeCourses(pid,m).catch(fail)));
}
const upd=(id,patch)=>updMany([id],patch);
const FAIL_MSG={permission_denied:'Tu usuario es de solo lectura: no puede modificar el plan.',invalid_argument:'El servidor rechazó el cambio porque los datos no son válidos.',not_found:'El documento ya no existe. Recarga la página.',rate_limited:'Demasiados cambios seguidos. Espera un momento e inténtalo de nuevo.',unavailable:'No hay conexión con el servidor. El cambio no se guardó.',unauthenticated:'Tu sesión expiró. Vuelve a iniciar sesión.',csrf:'La página quedó desactualizada. Recárgala e inténtalo de nuevo.'};
function fail(e){console.error(e);toast(FAIL_MSG[e&&e.code]||'No se pudo guardar el cambio. Inténtalo de nuevo.')}
function tcSiblings(id){const c=S.courses.get(id);if(!c)return [id];const D=derive();return D.isTC(c)?D.keys.get(c.key).ids:[id]}
async function setField(ids,field,val){
  if(field==='status'||field==='via'){const own=[],extra=[];ids.forEach(id=>{const c=S.courses.get(id);if(c&&c.linked){if(field==='status'){if(c._src)extra.push(...tcSiblings(c._src));else{S.courses.set(id,{...c,ownStatus:val,status:val});updMany([id],{ownStatus:val})}}}else own.push(id)});ids=[...new Set([...own,...extra])];if(!ids.length){schedule();return}}
  const patch={[field]:val}; if(field==='via'&&val==='virtual') patch.status='virtualizado';
  ids.forEach(id=>{const c=S.courses.get(id);if(c)S.courses.set(id,{...c,...patch})}); schedule();
  await updMany(ids,patch);
}
function courseData(pid,name,sem,via,extra){
  const p=S.programs.get(pid);name=clean(name);
  return {name,key:norm(name),semester:sem,via:via||p.defaultVia||'por_definir',status:via==='virtual'?'virtualizado':'no_iniciado',tc:false,createdAt:new Date().toISOString(),...(extra||{})};
}
async function addCourses(pid,list){
  const map={};for(const x of list){if(!clean(x.name))continue;map[newCid()]=courseData(pid,x.name,x.sem,x.via,x.extra)}
  try{await writeCourses(pid,map)}catch(e){fail(e);throw e}
  return Object.keys(map).length;
}
const addCourse=(pid,name,sem,via,extra)=>addCourses(pid,[{name,sem,via,extra}]);

/* ---------- events ---------- */
document.getElementById('tabs').addEventListener('click',e=>{const b=e.target.closest('.tab');if(!b)return;S.tab=b.dataset.tab;S.confirmDel=null;S.editing=null;render();window.scrollTo(0,0)});
document.getElementById('export-btn').addEventListener('click',exportXlsx);
document.getElementById('import-all-btn').addEventListener('click',()=>openImportAll());
const main=document.getElementById('main');
main.addEventListener('focusout',()=>{if(S.deferred){S.deferred=false;setTimeout(schedule,0)}});
document.addEventListener('click',e=>{
  const t=e.target;
  const open=t.closest('[data-open]'); if(open&&!t.closest('select,input,button:not([data-open])')){e.preventDefault();if(document.querySelector('.modal-bg'))closeModal();S.prog=open.dataset.open;S.tab='programas';S.sel.clear();render();window.scrollTo(0,0);return}
  const lv=t.closest('[data-lvl]'); if(lv){S.lvlFilter=lv.dataset.lvl;render();return}
  const cv=t.closest('[data-cview]'); if(cv){S.cview=cv.dataset.cview;render();return}
  const cm=t.closest('[data-cmode]'); if(cm){S.cmode=cm.dataset.cmode;render();return}
  const cn=t.closest('[data-cnav]'); if(cn){const n=+cn.dataset.cnav;const mode=S.cmode||'month';let d=S.cdate?new Date(S.cdate):today();
    if(n===0)d=today();else if(mode==='month')d=new Date(d.getFullYear(),d.getMonth()+n,1);else if(mode==='week')d=new Date(+d+n*7*864e5);else d=new Date(d.getFullYear()+n,0,1);S.cdate=+d;render();return}
  const cg=t.closest('[data-cgo]'); if(cg){const [y,m]=cg.dataset.cgo.split('-').map(Number);S.cdate=+new Date(y,m,1);S.cmode='month';render();return}
  const cd=t.closest('[data-cday]'); if(cd){openDay(cd.dataset.cday);return}
  const il=t.closest('[data-ilvl]'); if(il){S.ilvl=il.dataset.ilvl;render();return}
  const im=t.closest('[data-imod]'); if(im){S.imod=im.dataset.imod;render();return}
  if(t.closest('[data-ibulk]')){bulkStart();return}
  const pm=t.closest('[data-pmod]'); if(pm){S.pmod=pm.dataset.pmod;render();return}
  const pl=t.closest('[data-plvl]'); if(pl){S.plvl=pl.dataset.plvl;if(S.plvl==='escala'){const cur=S.programs.get(S.prog);if(!cur||!(cur.escala||cur.escalaOnly)){S.prog=escalaProgs()[0]?.id;S.sel.clear()}}else if(S.plvl!=='all'){const cur=S.programs.get(S.prog);if(!cur||cur.level!==S.plvl||cur.escalaOnly){S.prog=progsByLevel(S.plvl)[0]?.id;S.sel.clear()}}render();return}
  const pi=t.closest('[data-prog]'); if(pi){S.prog=pi.dataset.prog;S.sel.clear();S.editing=null;S.confirmDel=null;render();window.scrollTo(0,0);return}
  const a=t.closest('[data-act]'); if(a){({import:openImport,addsem:addSemester,hide:()=>toggleHidden(S.prog),escala:()=>{const pp=S.programs.get(S.prog);saveProg(S.prog,{escala:!pp.escala});toast(pp.escala?'Quitado de Escala Latam':'Añadido a Escala Latam')}})[a.dataset.act]();return}
  const sh=t.closest('[data-show]'); if(sh){toggleHidden(sh.dataset.show);return}
  const sb=t.closest('[data-setst]'); if(sb){const id=sb.dataset.setst,v=sb.dataset.val;if(S.courses.get(id)?.status!==v)setField(tcSiblings(id),'status',v);return}
  if(t.closest('[data-edit]')){const id=t.closest('[data-edit]').dataset.edit;S.editing=id;S.editVal=S.courses.get(id).name;S.confirmDel=null;render();const el=document.getElementById('edit-name');el&&el.focus();return}
  if(t.closest('[data-save]')){saveEdit();return}
  if(t.closest('[data-cancel]')){S.editing=null;S.confirmDel=null;render();return}
  if(t.closest('[data-askdel]')){S.confirmDel=t.closest('[data-askdel]').dataset.askdel;render();return}
  if(t.closest('[data-del]')){const id=t.closest('[data-del]').dataset.del;S.confirmDel=null;updMany([id],{deleted:true});S.courses.delete(id);S.sel.delete(id);schedule();return}
  if(t.closest('[data-tcman]')){const id=t.closest('[data-tcman]').dataset.tcman;const c=S.courses.get(id);const D=derive();const ids=c.tc?D.keys.get(c.key).ids:[id];setField(ids,'tc',!c.tc);return}
  if(t.closest('[data-bulkclear]')){S.sel.clear();S.confirmDel=null;render();return}
  if(t.closest('[data-bulkdel]')){if(S.confirmDel!=='bulk'){S.confirmDel='bulk';renderBulk();return}
    const ids=[...S.sel];S.confirmDel=null;S.sel.clear();const pr=updMany(ids,{deleted:true});ids.forEach(id=>S.courses.delete(id));schedule();pr.then(()=>toast(`${ids.length} asignaturas eliminadas`));return}
});
document.addEventListener('change',e=>{
  const t=e.target, d=t.dataset;
  if(d.via){setField(tcSiblings(d.via),'via',t.value);t.blur();return}
  if(d.st){setField(tcSiblings(d.st),'status',t.value);t.blur();return}
  if(d.sel){t.checked?S.sel.add(d.sel):S.sel.delete(d.sel);S.confirmDel=null;render();return}
  if(d.selsem){const s=+d.selsem;coursesOf(S.prog).filter(c=>(c.semester||1)===s).forEach(c=>t.checked?S.sel.add(c.id):S.sel.delete(c.id));render();return}
  if(d.semvia&&t.value){const s=+d.semvia;const ids=coursesOf(S.prog).filter(c=>(c.semester||1)===s).map(c=>c.id);setField(ids,'via',t.value).then(()=>toast(`Vía aplicada a ${ids.length} asignaturas del semestre ${s}`));t.value='';t.blur();return}
  if(d.tcst&&t.value){const D=derive();const g=D.keys.get(d.tcst);if(g)setField(g.ids,'status',t.value);t.value='';t.blur();return}
  if(t.id==='bulk-via'&&t.value){const ids=[...S.sel];setField(ids,'via',t.value).then(()=>toast(`Vía actualizada en ${ids.length} asignaturas`));return}
  if(t.id==='bulk-st'&&t.value){const ids=[...S.sel];setField(ids,'status',t.value).then(()=>toast(`Estado actualizado en ${ids.length} asignaturas`));return}
  if(t.id==='p-sems'){const n=Math.max(0,Math.min(12,+t.value||0));S.programs.set(S.prog,{...S.programs.get(S.prog),semesters:n});schedule();S.db.doc('programs/'+S.prog).update({semesters:n}).catch(fail);return}
  if(t.id==='p-prod'||t.id==='p-class'||t.id==='p-nsem'){const f={'p-prod':'prodStart','p-class':'classStart','p-nsem':'semsToProduce'}[t.id];saveProg(S.prog,{[f]:f==='semsToProduce'?(Math.max(0,Math.min(14,+t.value||0))||null):t.value});return}
  if(d.ifield){const [pid,f]=d.ifield.split('|');saveProg(pid,{[f]:f==='semsToProduce'?(Math.max(0,Math.min(14,+t.value||0))||null):t.value});return}
  if(t.id==='p-via'){S.programs.set(S.prog,{...S.programs.get(S.prog),defaultVia:t.value});S.db.doc('programs/'+S.prog).update({defaultVia:t.value}).catch(fail);return}
  if(t.id==='psel'){S.prog=t.value;S.sel.clear();render();return}
});
document.addEventListener('input',e=>{
  const t=e.target;
  if(t.id==='psearch'){S.search=t.value;render();return}
  if(t.id==='tcsearch'){S.tcFilter=t.value;render();return}
  if(t.id==='edit-name'){S.editVal=t.value;return}
  if(t.dataset.add){S.addVals[t.dataset.add]=t.value;return}
});
document.addEventListener('keydown',e=>{
  const t=e.target;
  if(t.id==='edit-name'){if(e.key==='Enter')saveEdit();if(e.key==='Escape'){S.editing=null;render()}return}
  if(t.dataset&&t.dataset.add&&e.key==='Enter'){const s=+t.dataset.add;const v=clean(t.value);if(!v)return;
    S.addVals[s]='';t.value='';addCourse(S.prog,v,s).then(()=>toast('Asignatura agregada')).catch(()=>{});}
  if(e.key==='Escape'&&document.querySelector('.modal-bg'))closeModal();
});
function saveEdit(){const id=S.editing;const v=clean(S.editVal);S.editing=null;if(!v){render();return}
  const c=S.courses.get(id);S.courses.set(id,{...c,name:v,key:norm(v)});schedule();upd(id,{name:v,key:norm(v)})}
function addSemester(){const p=S.programs.get(S.prog);const n=Math.min(12,Math.max(p.semesters||0,...semestersOf(p))+1);S.programs.set(p.id,{...p,semesters:n});schedule();S.db.doc('programs/'+p.id).update({semesters:n}).catch(fail)}

/* ---------- modal helpers ---------- */
function openModal(html){document.getElementById('modal-root').innerHTML=`<div class="modal-bg" data-bg><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const bg=document.querySelector('[data-bg]');bg.addEventListener('mousedown',e=>{if(e.target===bg)closeModal()})}
function closeModal(){if(S.impAll&&S.impAll.busy)return;document.getElementById('modal-root').innerHTML='';S.imp=null;S.impAll=null}

/* ---------- import ---------- */
function openImport(){
  const p=S.programs.get(S.prog);
  S.imp={pid:p.id,rows:null,sheets:[],sheet:0,wb:null,cfg:null,preview:[],src:'file',via:p.defaultVia||'por_definir'};
  drawImport();
}
function drawImport(){
  const I=S.imp,p=S.programs.get(I.pid),L=LV[p.level];
  let b='';
  if(!I.rows){
    b=`<div class="seg" role="group"><button data-src="file" aria-pressed="${I.src==='file'}">Archivo Excel / CSV</button><button data-src="paste" aria-pressed="${I.src==='paste'}">Pegar listado</button></div>`;
    b+=I.src==='file'?`<label class="drop" id="drop"><input type="file" id="imp-file" accept=".xlsx,.xls,.csv,.ods"><b>Arrastra aquí el plan de estudios o haz clic para elegirlo</b><span class="muted">Excel (.xlsx, .xls), CSV u ODS. Sirve una tabla con columnas (Semestre, Asignatura…), un listado con filas “Semestre I”, “Semestre II”… o una matriz con un semestre por columna.</span></label>`
     :`<textarea id="imp-paste" placeholder="Pega una asignatura por línea. Ejemplos:&#10;Semestre 1&#10;Fundamentos de administración&#10;Matemáticas básicas&#10;Semestre 2&#10;Contabilidad general&#10;&#10;o con columnas separadas por tabulador o punto y coma:&#10;1;Fundamentos de administración&#10;2;Contabilidad general"></textarea><div><button class="btn primary" id="imp-parse">Leer listado</button></div>`;
  }else{
    const c=I.cfg; const hdr=I.rows[c.headerRow]||[]; const width=Math.max(...I.rows.slice(0,200).map(r=>r.length),1);
    const colOpt=(sel,none)=>(none?`<option value="-1" ${sel<0?'selected':''}>${none}</option>`:'')+Array.from({length:width},(_,j)=>`<option value="${j}" ${sel===j?'selected':''}>Col ${String.fromCharCode(65+(j%26))}${hdr[j]?' · '+esc(String(hdr[j]).slice(0,28)):''}</option>`).join('');
    const inc=I.preview.filter(r=>r.include);
    b=`<div class="cfg">
      ${I.sheets.length>1?`<label class="field">Hoja<select id="imp-sheet">${I.sheets.map((s,i)=>`<option value="${i}" ${i===I.sheet?'selected':''}>${esc(s)}</option>`).join('')}</select></label>`:''}
      <label class="field">Formato<select id="imp-mode"><option value="cols" ${c.mode==='cols'?'selected':''}>Tabla / listado</option><option value="matrix" ${c.mode==='matrix'?'selected':''}>Un semestre por columna</option></select></label>
      <label class="field">Fila de encabezado<input type="number" id="imp-hdr" min="0" value="${c.headerRow+1}" title="0 = sin encabezado"></label>
      ${c.mode==='cols'?`<label class="field">Columna de asignatura<select id="imp-name">${colOpt(c.nameCol)}</select></label>
      <label class="field">Columna de semestre<select id="imp-sem">${colOpt(c.semCol,'Detectar por filas “Semestre …”')}</select></label>`:''}
      <label class="field">Vía para todas<select id="imp-via">${L.vias.map(v=>`<option value="${v}" ${I.via===v?'selected':''}>${VIAS[v]}</option>`).join('')}</select></label>
    </div>
    <div class="muted" style="font-size:12.5px"><b class="num" style="color:var(--ink)">${inc.length}</b> asignaturas a importar en <b style="color:var(--ink)">${new Set(inc.map(r=>r.sem)).size}</b> semestres · ${I.preview.filter(r=>r.dup).length} ya existen en el programa (desmarcadas) · ${inc.filter(r=>r.tcm.length).length} coinciden con otros programas → tronco común</div>
    <div class="pv-tbl"><table><thead><tr><th><input type="checkbox" id="imp-all" ${I.preview.length&&I.preview.every(r=>r.include)?'checked':''} aria-label="Todas"></th><th>Sem.</th><th>Asignatura</th><th>Vía</th><th>Observación</th></tr></thead><tbody>
    ${I.preview.map((r,i)=>`<tr class="${r.include?'':'dim'}"><td><input type="checkbox" data-pi="${i}" ${r.include?'checked':''} aria-label="Incluir"></td><td><input type="number" min="1" max="12" data-ps="${i}" value="${r.sem}"></td><td><input type="text" data-pn="${i}" value="${esc(r.name)}" aria-label="Nombre"></td>
      <td><select class="sel" data-pv="${i}">${L.vias.map(v=>`<option value="${v}" ${r.via===v?'selected':''}>${VIAS[v]}</option>`).join('')}</select></td>
      <td style="font-size:12px">${r.dup?'<span class="pill none">Ya existe</span>':''}${r.tcm.length?`<span class="tc" title="${esc('También en: '+r.tcm.join(' · '))}">TRONCO COMÚN · ${r.tcm.length+1}</span>`:''}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">No se encontraron asignaturas con esta configuración. Prueba otra columna o formato.</td></tr>'}
    </tbody></table></div>`;
  }
  openModal(`<div class="modal-h"><div><div class="eyebrow">Subir plan de estudios</div><h2>${esc(p.name)}</h2></div><button class="btn ghost" data-close>Cerrar</button></div>
   <div class="modal-b">${b}</div>
   <div class="modal-f"><span id="imp-prog" class="muted num" style="margin-right:auto;font-size:12px"></span>${I.rows?'<button class="btn" id="imp-back">Elegir otro archivo</button>':''}<button class="btn" data-close>Cancelar</button>${I.rows?`<button class="btn primary" id="imp-go" ${I.preview.some(r=>r.include)?'':'disabled'}>Importar ${I.preview.filter(r=>r.include).length} asignaturas</button>`:''}</div>`);
  wireImport();
}
function wireImport(){
  const I=S.imp,M=document.querySelector('.modal');
  M.querySelectorAll('[data-close]').forEach(b=>b.onclick=closeModal);
  M.querySelectorAll('[data-src]').forEach(b=>b.onclick=()=>{I.src=b.dataset.src;drawImport()});
  const f=document.getElementById('imp-file');
  if(f){const drop=document.getElementById('drop');
    f.onchange=()=>f.files[0]&&readFile(f.files[0]);
    drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over')});
    drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
    drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');const fl=e.dataTransfer.files[0];fl&&readFile(fl)});}
  const pb=document.getElementById('imp-parse');
  if(pb)pb.onclick=()=>{const txt=document.getElementById('imp-paste').value;if(!txt.trim())return;
    I.rows=txt.split(/\r?\n/).map(l=>l.split(/\t|;|\|/).map(clean));I.sheets=[];I.cfg=detect(I.rows);buildPreview();drawImport()};
  const back=document.getElementById('imp-back'); if(back)back.onclick=()=>{I.rows=null;drawImport()};
  const on=(id,fn)=>{const el=document.getElementById(id);if(el)el.onchange=()=>{fn(el);buildPreview();drawImport()}};
  on('imp-sheet',el=>{I.sheet=+el.value;I.rows=sheetRows(I.wb,I.sheet);I.cfg=detect(I.rows)});
  on('imp-mode',el=>{I.cfg.mode=el.value});
  on('imp-hdr',el=>{I.cfg.headerRow=Math.max(-1,(+el.value||0)-1)});
  on('imp-name',el=>{I.cfg.nameCol=+el.value});
  on('imp-sem',el=>{I.cfg.semCol=+el.value});
  on('imp-via',el=>{I.via=el.value});
  const all=document.getElementById('imp-all'); if(all)all.onchange=()=>{I.preview.forEach(r=>r.include=all.checked);drawImport()};
  M.querySelectorAll('[data-pi]').forEach(el=>el.onchange=()=>{I.preview[+el.dataset.pi].include=el.checked;drawImport()});
  M.querySelectorAll('[data-ps]').forEach(el=>el.onchange=()=>{I.preview[+el.dataset.ps].sem=Math.max(1,+el.value||1)});
  M.querySelectorAll('[data-pn]').forEach(el=>el.onchange=()=>{I.preview[+el.dataset.pn].name=clean(el.value)});
  M.querySelectorAll('[data-pv]').forEach(el=>el.onchange=()=>{I.preview[+el.dataset.pv].via=el.value});
  const go=document.getElementById('imp-go'); if(go)go.onclick=runImport;
}
function sheetRows(wb,i){const ws=wb.Sheets[wb.SheetNames[i]];return XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:false,blankrows:false}).map(r=>r.map(clean))}
function readFile(file){
  if(typeof XLSX==='undefined'){toast('No se pudo cargar el lector de Excel. Usa la opción Pegar listado.');return}
  const fr=new FileReader();fr.onload=()=>{try{const wb=XLSX.read(new Uint8Array(fr.result),{type:'array'});const I=S.imp;I.wb=wb;I.sheets=wb.SheetNames;I.sheet=0;I.rows=sheetRows(wb,0);I.cfg=detect(I.rows);buildPreview();drawImport()}catch(e){console.error(e);toast('No se pudo leer el archivo. Verifica que sea Excel o CSV.')}};
  fr.readAsArrayBuffer(file);
}
const SEMRX=/semestre|nivel|periodo|período|ciclo/i;
const SECRX=/^(semestre|nivel|periodo|período|ciclo)\b|^(primer|primero|segundo|tercer|tercero|cuarto|quinto|sexto|s[eé]ptimo|octavo|noveno|d[eé]cimo|[ivx]+|\d{1,2})\s*(er|ro|do|to|vo|no|mo|°|º|\.)?\s*(semestre|nivel|periodo|período|ciclo)\b/i;
function detect(rows){
  const lim=Math.min(rows.length,40);
  for(let i=0;i<lim;i++){const r=rows[i];const n=r.findIndex(c=>/^(nombre (de la )?)?(asignatura|curso|materia|espacio)s?\b|asignatura|espacio acad/i.test(c)&&c.length<60);
    if(n>=0)return {mode:'cols',headerRow:i,nameCol:n,semCol:r.findIndex((c,j)=>j!==n&&SEMRX.test(c)&&c.length<30)}}
  for(let i=0;i<lim;i++){const cnt=rows[i].filter(c=>(SECRX.test(c)&&semNum(c))||/^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i.test(c)).length;if(cnt>=2)return {mode:'matrix',headerRow:i,nameCol:0,semCol:-1}}
  const width=Math.max(...rows.map(r=>r.length),1);let best=0,bs=-1;
  for(let j=0;j<width;j++){const s=rows.reduce((a,r)=>a+((r[j]||'').length>4&&isNaN(+r[j])&&!SEMRX.test(r[j])?1:0),0);if(s>bs){bs=s;best=j}}
  let semCol=-1;for(let j=0;j<width;j++){if(j===best)continue;const s=rows.filter(r=>/^\d{1,2}$/.test(r[j]||'')&&+r[j]<=12).length;if(s>rows.length*.5){semCol=j;break}}
  return {mode:'cols',headerRow:-1,nameCol:best,semCol};
}
const validName=n=>n.length>=3&&!/^[\d.,\s%]+$/.test(n)&&!/^(sub)?total|^cr[eé]ditos|^horas|^asignaturas?$|^nombre|^c[oó]digo$|^tipo|^componente|^requisito/i.test(n)&&!(SECRX.test(n)&&semNum(n)&&n.length<40);
function buildPreview(){
  const I=S.imp,c=I.cfg,rows=I.rows,p=S.programs.get(I.pid);
  const out=[];let cur=1;
  if(c.mode==='matrix'){const h=rows[c.headerRow]||[];const sbf=h.map(x=>semNum(x)||0);
    for(let i=c.headerRow+1;i<rows.length;i++)rows[i].forEach((cell,j)=>{if(sbf[j]&&validName(cell))out.push({name:cell,sem:sbf[j]})});
  }else{
    for(let i=c.headerRow+1;i<rows.length;i++){const r=rows[i];const ne=r.filter(x=>x).length;
      if(c.semCol<0){const sec=r.find(x=>SECRX.test(x)&&semNum(x)&&x.length<40);if(sec&&ne<=3){cur=semNum(sec);continue}}
      else{const n=semNum(r[c.semCol]);if(n)cur=n}
      const name=clean(r[c.nameCol]);if(validName(name))out.push({name,sem:cur});}
  }
  const existing=new Set(coursesOf(p.id).map(x=>x.key));
  const other=new Map();for(const x of S.courses.values())if(x.programId!==p.id){if(!other.has(x.key))other.set(x.key,new Set());other.get(x.key).add(S.programs.get(x.programId)?.name||'')}
  const seen=new Set();
  I.preview=out.map(r=>{const k=norm(r.name)+'|'+r.sem;const dup=existing.has(norm(r.name))||seen.has(k);seen.add(k);return {...r,via:I.via,include:!dup,dup,tcm:[...(other.get(norm(r.name))||[])]}});
}
async function runImport(){
  const I=S.imp;const rows=I.preview.filter(r=>r.include&&r.name);const pid=I.pid;
  const go=document.getElementById('imp-go');go.disabled=true;const pr=document.getElementById('imp-prog');
  let ok=0;pr.textContent=`Guardando ${rows.length}…`;
  try{ok=await addCourses(pid,rows.map(r=>({name:r.name,sem:r.sem,via:r.via})))}catch(e){}
  const p=S.programs.get(pid);const maxS=Math.max(...rows.map(r=>r.sem),0);
  if(maxS>(p.semesters||0)){S.db.doc('programs/'+pid).update({semesters:maxS}).catch(()=>{})}
  closeModal();toast(`${ok} asignaturas importadas en ${p.name}`);
}


/* ---------- consolidated import (one Excel, all programs) ---------- */
const LEVEL_OF=n=>{n=norm(n);return /pregrado/.test(n)?'pregrado':/especializ/.test(n)?'especializacion':/maestr/.test(n)?'maestria':/doctor/.test(n)?'doctorado':/distancia/.test(n)?'distancia':null};
const STOPW=new Set(['especializacion','esp','maestria','doctorado','en','de','del','la','las','los','el','y','con','enfasis','a','distancia','virtual','programa','para']);
const toks=s=>new Set(norm(s).split(' ').filter(w=>w&&!STOPW.has(w)).map(w=>w.length>4?w.replace(/s$/,''):w));
function parseConsolidated(wb){
  const out=[],sheets=[];
  for(const sn of wb.SheetNames){
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[sn],{header:1,defval:'',raw:false,blankrows:false}).map(r=>r.map(clean));
    let h=-1;for(let i=0;i<Math.min(rows.length,15);i++){const r=rows[i].map(norm);if(r.includes('asignatura')&&r.includes('programa')){h=i;break}}
    if(h<0)continue;
    const H=rows[h].map(norm);const col=(...ns)=>{for(const n of ns){const i=H.indexOf(n);if(i>=0)return i}return -1};
    const c={mod:col('modalidad'),prog:col('programa'),prog2:col('programa 2'),asig:col('asignatura'),elec:col('nombre electiva','nombre de la electiva','electiva'),sem:col('semestre'),tc:H.findIndex(x=>/tronco comun/.test(x)),nivel:col('nivel')};
    let mod='',prog='',sem=0,n=0;const lvS=LEVEL_OF(sn);
    for(let i=h+1;i<rows.length;i++){const r=rows[i];
      if(c.mod>=0&&r[c.mod])mod=r[c.mod];
      if(c.prog>=0&&r[c.prog])prog=r[c.prog];
      const a=r[c.asig];if(!a)continue;
      const sv=parseInt(r[c.sem]);if(sv>0)sem=sv;
      const el=c.elec>=0?r[c.elec]:'';const isEl=!!el&&!/^no aplica$/i.test(el);
      const tv=c.tc>=0?norm(r[c.tc]):'';
      const pr=prog||(c.prog2>=0?r[c.prog2]:'');if(!pr)continue;
      out.push({level:lvS||LEVEL_OF(c.nivel>=0?r[c.nivel]:'')||'pregrado',modalidad:mod,program:pr,slot:isEl?a:'',name:isEl?el:a,semester:Math.min(sem||1,14),tc:tv==='si'?'si':tv==='duplicado'?'duplicado':''});n++;
    }
    sheets.push({name:sn,count:n});
  }
  return {rows:out,sheets};
}
function groupRows(rows){
  const gm=new Map();
  for(const r of rows){const k=r.level+'|'+[...toks(r.program)].sort().join(' ');
    if(!gm.has(k))gm.set(k,{key:k,level:r.level,program:clean(r.program),modalidad:r.modalidad,rows:[],el:0,tc:0,include:true,target:'new'});
    const g=gm.get(k);g.rows.push(r);if(r.slot)g.el++;if(r.tc)g.tc++;}
  const groups=[...gm.values()];
  const progs=[...S.programs.values()],pairs=[];
  groups.forEach((g,gi)=>{const A=toks(g.program);progs.filter(p=>p.level===g.level).forEach(p=>{const B=toks(p.name);let k=0;A.forEach(x=>B.has(x)&&k++);const j=k/(A.size+B.size-k||1);if(j>=.5)pairs.push({gi,pid:p.id,j})})});
  pairs.sort((a,b)=>b.j-a.j);const uG=new Set(),uP=new Set();
  for(const x of pairs){if(uG.has(x.gi)||uP.has(x.pid))continue;uG.add(x.gi);uP.add(x.pid);groups[x.gi].target=x.pid}
  const ord=Object.fromEntries(LEVELS.map((l,i)=>[l.id,i]));
  return groups.sort((a,b)=>ord[a.level]-ord[b.level]);
}
function openImportAll(){
  if(!S.db){toast('Abre la plataforma con tu cuenta para poder importar.');return}
  S.impAll={groups:null,busy:false,done:0,total:0};drawImportAll();
}
function drawImportAll(){
  const I=S.impAll;let b='',f='';
  if(!I.groups){
    b=`<p class="muted" style="margin:0;max-width:70ch">Sube el Excel consolidado de planes de estudio. Se lee cada hoja (Pregrado, Especializaciones, Maestrías, Doctorado…) y de cada fila se toman el programa, la modalidad, la asignatura, el nombre de la electiva, el semestre y si es tronco común. Los estados, prioridades y demás columnas se ignoran.</p>
    <label class="drop" id="drop-all"><input type="file" id="imp-all-file" accept=".xlsx,.xls,.ods"><b>Arrastra aquí el Excel o haz clic para elegirlo</b><span class="muted">Las asignaturas que ya estén cargadas en un programa no se duplican.</span></label>`;
  }else if(I.busy||I.finished){
    const pc=I.total?Math.round(I.done*100/I.total):100;
    b=`<div style="display:flex;flex-direction:column;gap:10px;padding:10px 0"><b>${I.finished?'Importación terminada':'Importando asignaturas…'}</b><div class="progress"><i style="width:${pc}%"></i></div><span class="muted num">${I.done} de ${I.total} asignaturas guardadas${I.skipped?` · ${I.skipped} ya existían y se omitieron`:''}${I.errors?` · ${I.errors} con error`:''}</span>${I.busy?'<span class="muted" style="font-size:12px">Deja esta ventana abierta hasta que termine.</span>':''}</div>`;
    f=I.finished?'<button class="btn primary" data-close>Listo</button>':'';
  }else{
    const inc=I.groups.filter(g=>g.include);const nAs=inc.reduce((a,g)=>a+g.rows.length,0);
    const opts=g=>`<option value="new" ${g.target==='new'?'selected':''}>+ Crear programa nuevo</option>`+LEVELS.map(l=>`<optgroup label="${l.name}">${progsByLevel(l.id).map(p=>`<option value="${p.id}" ${g.target===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</optgroup>`).join('');
    b=`<div class="muted" style="font-size:12.5px">Se leyeron ${I.sheets.map(x=>`<b style="color:var(--ink)">${esc(x.name)}</b> (${x.count})`).join(' · ')}. Revisa a qué programa de la plataforma va cada uno; los que no coinciden se crearán como programas nuevos.</div>
    <div class="pv-tbl map-tbl"><table><thead><tr><th><input type="checkbox" id="ia-all" ${I.groups.every(g=>g.include)?'checked':''} aria-label="Todos"></th><th>Programa en el Excel</th><th class="n">Asig.</th><th class="n">Electivas</th><th class="n">T. común</th><th>Va a</th></tr></thead><tbody>
    ${I.groups.map((g,i)=>`<tr class="${g.include?'':'dim'}"><td><input type="checkbox" data-gi="${i}" ${g.include?'checked':''} aria-label="Incluir"></td>
      <td style="min-width:240px"><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="lv-tag" style="--lc:${LV[g.level].color}">${LV[g.level].short}</span>${esc(g.program)}${g.modalidad?`<span class="mod">${esc(g.modalidad)}</span>`:''}</div></td>
      <td class="n">${g.rows.length}</td><td class="n">${g.el}</td><td class="n">${g.tc}</td>
      <td><select class="sel" data-gt="${i}" style="${g.target==='new'?'color:var(--accent)':''}">${opts(g)}</select></td></tr>`).join('')}
    </tbody></table></div>`;
    f=`<span class="muted" style="margin-right:auto;font-size:12px">${inc.length} programas · ${nAs} asignaturas · ${inc.filter(g=>g.target==='new').length} programas nuevos</span><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ia-go" ${inc.length?'':'disabled'}>Importar</button>`;
  }
  const existing=document.querySelector('.modal-b[data-all]');
  if(existing&&(I.busy||I.finished)){existing.innerHTML=b;document.querySelector('.modal-f').innerHTML=f;wireImportAll();return}
  openModal(`<div class="modal-h"><div><div class="eyebrow">Importar planes de estudio</div><h2>Excel consolidado</h2></div>${I.busy?'':'<button class="btn ghost" data-close>Cerrar</button>'}</div><div class="modal-b" data-all>${b}</div><div class="modal-f">${f||'<button class="btn" data-close>Cancelar</button>'}</div>`);
  wireImportAll();
}
function wireImportAll(){
  const I=S.impAll,M=document.querySelector('.modal');
  M.querySelectorAll('[data-close]').forEach(x=>x.onclick=()=>{if(!I.busy)closeModal()});
  const f=document.getElementById('imp-all-file');
  if(f){const d=document.getElementById('drop-all');const go=file=>{
      if(typeof XLSX==='undefined'){toast('No se pudo cargar el lector de Excel. Recarga la página.');return}
      const fr=new FileReader();fr.onload=()=>{try{const wb=XLSX.read(new Uint8Array(fr.result),{type:'array'});const r=parseConsolidated(wb);
        if(!r.rows.length){toast('No encontré hojas con columnas Programa y Asignatura.');return}
        I.sheets=r.sheets;I.groups=groupRows(r.rows);drawImportAll()}catch(e){console.error(e);toast('No se pudo leer el archivo.')}};fr.readAsArrayBuffer(file)};
    f.onchange=()=>f.files[0]&&go(f.files[0]);
    d.addEventListener('dragover',e=>{e.preventDefault();d.classList.add('over')});d.addEventListener('dragleave',()=>d.classList.remove('over'));
    d.addEventListener('drop',e=>{e.preventDefault();d.classList.remove('over');e.dataTransfer.files[0]&&go(e.dataTransfer.files[0])});}
  const all=document.getElementById('ia-all');if(all)all.onchange=()=>{I.groups.forEach(g=>g.include=all.checked);drawImportAll()};
  M.querySelectorAll('[data-gi]').forEach(el=>el.onchange=()=>{I.groups[+el.dataset.gi].include=el.checked;drawImportAll()});
  M.querySelectorAll('[data-gt]').forEach(el=>el.onchange=()=>{I.groups[+el.dataset.gt].target=el.value;drawImportAll()});
  const go=document.getElementById('ia-go');if(go)go.onclick=runImportAll;
}
function newProgramId(lv,name){const base=lv.slice(0,3)+'-'+norm(name).replace(/ /g,'-').slice(0,40);let id=base,k=2;while(S.programs.has(id))id=base+'-'+k++;return id}
async function runImportAll(){
  const I=S.impAll;I.busy=true;I.done=0;I.skipped=0;I.errors=0;
  const groups=I.groups.filter(g=>g.include);let order=Math.max(0,...[...S.programs.values()].map(p=>p.order||0));
  // 1) resolve target programs (create new ones), merging groups sent to the same program
  const byTarget=new Map();
  for(const g of groups){let pid=g.target;
    if(pid==='new'){pid=newProgramId(g.level,g.program);const maxS=Math.max(...g.rows.map(r=>r.semester));
      const doc={name:g.program,level:g.level,modalidad:g.modalidad||'',expected:null,expectedDisc:null,expectedTC:null,semesters:maxS,defaultVia:LV[g.level].def,order:++order,plan:{}};
      S.programs.set(pid,{id:pid,...doc});try{await S.db.doc('programs/'+pid).set(doc)}catch(e){fail(e);I.busy=false;drawImportAll();return}}
    if(!byTarget.has(pid))byTarget.set(pid,[]);byTarget.get(pid).push(...g.rows);
    if(g.modalidad&&!S.programs.get(pid).modalidad){S.programs.get(pid).modalidad=g.modalidad;S.db.doc('programs/'+pid).update({modalidad:g.modalidad}).catch(()=>{})}}
  // 2) build course list, skipping duplicates
  const jobs=[];
  for(const [pid,rows] of byTarget){const p=S.programs.get(pid);
    const have=new Set(coursesOf(pid).map(c=>c.key+'|'+c.semester));const seen=new Set();let maxS=p.semesters||0;
    for(const r of rows){const k=norm(r.name)+'|'+r.semester;if(have.has(k)||seen.has(k)){I.skipped++;continue}seen.add(k);maxS=Math.max(maxS,r.semester);
      jobs.push({pid,name:r.name,sem:r.semester,extra:{slot:r.slot||'',modalidad:r.modalidad||'',tc:!!r.tc,tcSrc:r.tc||''}})}
    if(maxS>(p.semesters||0)){p.semesters=maxS;S.db.doc('programs/'+pid).update({semesters:maxS}).catch(()=>{})}
    }
  I.total=jobs.length;drawImportAll();
  const byP={};jobs.forEach(j=>(byP[j.pid]=byP[j.pid]||[]).push(j));
  for(const [pid,list] of Object.entries(byP)){try{await addCourses(pid,list)}catch(e){I.errors+=list.length}I.done+=list.length;drawImportAll()}
  I.busy=false;I.finished=true;drawImportAll();schedule();
}

/* ---------- export ---------- */
async function exportXlsx(){
  if(!S.dl||typeof XLSX==='undefined')return;
  const D=derive();const rows=[];
  for(const L of LEVELS)for(const p of progsByLevel(L.id)){const cl=coursesOf(p.id).sort((a,b)=>(a.semester-b.semester)||a.name.localeCompare(b.name,'es'));
    for(const c of cl){const pl=(p.plan||{})[c.semester]||{};rows.push({'Nivel':L.name,'Modalidad':p.modalidad||'','Programa':p.name,'Semestre':c.semester,'Asignatura':c.slot||c.name,'Nombre electiva':c.slot?c.name:'','Vía':VIAS[c.via],'Estado':STATUS[c.status],'Tronco común':D.isTC(c)?'Sí':'No','Inicio producción':p.prodStart||'','Inicio de clases':p.classStart||''})}}
  const crono=[];for(const L of LEVELS)for(const p of progsByLevel(L.id)){const r=progPlan(p);crono.push({'Nivel':L.name,'Modalidad':p.modalidad||'','Programa':p.name,'Inicio de producción':p.prodStart||'','Inicio de clases':p.classStart||'','Semestres a producir':r.n,'Asignaturas':r.c.total,'Virtualizadas':r.c.virtualizado,'Faltan':r.missing,'Estado':r.txt})}
  const res=[];for(const L of LEVELS)for(const p of progsByLevel(L.id)){const pc=countOf(coursesOf(p.id));res.push({'Nivel':L.name,'Programa':p.name,'Asignaturas':pc.total,'Desde cero':pc.via.cero,'Reestructuración':pc.via.reestructuracion,'Tomada de virtual':pc.via.virtual,'Sin definir':pc.via.por_definir,'No iniciado':pc.no_iniciado,'En proceso':pc.en_proceso,'Virtualizado':pc.virtualizado})}
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(res),'Resumen');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows.length?rows:[{'Asignatura':'(sin asignaturas cargadas)'}]),'Asignaturas');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(crono),'Cronograma');

  const data=XLSX.write(wb,{type:'array',bookType:'xlsx'});
  try{await S.dl.save({filename:`plan_virtualizacion_${iso(today())}.xlsx`,data});}catch(e){if(e&&e.code!=='declined')toast('No se pudo generar la descarga.')}
}

/* ---------- course subscriptions: one small collection per level+semester ---------- */
function applyPC(pid,data){
  for(const [id,c] of S.courses)if(c.programId===pid)S.courses.delete(id);
  if(!data)return;
  for(const [id,c] of Object.entries(data.courses||{})){if(!c||c.deleted||!c.name)continue;S.courses.set(id,{...c,id,programId:pid,semester:+c.semester||1})}
}

/* ---------- boot ---------- */
S.dl=downloads||null;
S.db=db||null;
document.body.dataset.readonly=S.canWrite?'':'1';
if(!db){render();return}
db.collection('programs').onSnapshot(snap=>{S.programs=new Map(snap.docs.map(d=>[d.id,{id:d.id,...d.data()}]));S.loaded.programs=true;schedule()},e=>{console.error(e);toast('Se perdió la conexión con los programas. Recarga la página.')});
db.collection('pc').onSnapshot(snap=>{for(const ch of snap.docChanges()){PC.add(ch.doc.id);applyPC(ch.doc.id,ch.type==='removed'?null:ch.doc.data())}S.loaded.courses=true;schedule()},e=>{console.error(e);toast('Se perdió la conexión con las asignaturas. Recarga la página.')});

}
