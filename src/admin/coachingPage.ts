import {
  TIME_PRESETS_MIN,
  DEFAULT_DURATION_MIN,
  fmtSlotTime,
  levelFromClassName,
} from "../domain/classPlanningRules.js";
import type { ClassPlanSchedule, ClassPlanSlot } from "../domain/classPlanningRepo.js";

const WEEKDAYS_FULL = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const PRINT_COACH_COLORS = ["#2b6fb0", "#3f8f5a", "#c2404f", "#b5701f", "#7c547d", "#0f8a8a", "#8a5a2b", "#55408f", "#b03a86", "#4a6b1f"];
const LEVEL_COLORS: Record<string, string> = { foundation: "#3f8f5a", sculpt: "#d98a2b", intense: "#c2404f", other: "#8a7f92" };

function normName(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Distinct coaches sorted by rank (same colour assignment as the board). */
function coachColorMap(slots: ClassPlanSlot[]): Map<string, string> {
  const keys = [...new Set(slots.map((s) => normName(s.coach_name)).filter(Boolean))].sort();
  const map = new Map<string, string>();
  keys.forEach((k, i) => map.set(k, PRINT_COACH_COLORS[i % PRINT_COACH_COLORS.length]));
  return map;
}

/**
 * Body HTML for /admin/coaching — server-rendered chrome + a self-contained
 * vanilla board editor (no framework). A "scenario" holds a weekly grid of class
 * cards (time + coach + class). Purely a sandbox: nothing is pushed to Wix.
 * "Enregistrer" POSTs the whole board as JSON; the server re-validates.
 */

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** JSON as a safe inline <script> literal: neutralise "<" (→ </script>) and the
 *  two line separators JSON.stringify leaves raw but JS forbids in source. */
function jsonLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(new RegExp("\\u2028","g"), "\\u2028")
    .replace(new RegExp("\\u2029","g"), "\\u2029");
}

const BANNERS: Record<string, string> = {
  saved: "Planning enregistré.",
  created: "Nouveau scénario créé.",
  duplicated: "Scénario dupliqué.",
  renamed: "Scénario renommé.",
  published: "Scénario publié — c'est le scénario de référence.",
  deleted: "Scénario supprimé.",
  imported: "Semaine Wix importée dans un nouveau brouillon.",
};

export function coachingBanner(done?: string, err?: string): string {
  if (done && BANNERS[done])
    return `<div class="card success"><span class="ok">✓ ${esc(BANNERS[done])}</span></div>`;
  if (err) return `<div class="card warn">⚠️ ${esc(err)}</div>`;
  return "";
}

export interface CoachingPlanningData {
  schedules: ClassPlanSchedule[];
  current: ClassPlanSchedule | null;
  slots: ClassPlanSlot[];
  coachNames: string[];
  classNames: string[];
  banner: string;
  showNewForm?: boolean;
}

const scheduleBadge = (s: ClassPlanSchedule) =>
  s.status === "published"
    ? `<span class="badge badge--green">publié</span>`
    : `<span class="badge badge--gray">brouillon</span>`;

const PAGE_CSS = `
.board-wrap{overflow-x:auto}
.board{display:grid;grid-template-columns:repeat(7,minmax(150px,1fr));gap:.5rem;min-width:1060px}
.board-col{background:#faf8fb;border:1px solid #eee;border-radius:10px;padding:.4rem;display:flex;flex-direction:column;min-height:150px}
.board-col--over{outline:2px dashed #7c547d;outline-offset:-2px}
.board-col-head{font-weight:600;font-size:.82rem;display:flex;justify-content:space-between;align-items:baseline;padding:.15rem .25rem .4rem}
.board-col-head .col-count{color:#8a7f92;font-weight:400;font-size:.72rem}
.slot-card{border-radius:8px;padding:.35rem .5rem;margin-bottom:.35rem;cursor:pointer;border:1px solid;border-left-width:4px;background:#fff}
.slot-card:focus{outline:2px solid #7c547d;outline-offset:1px}
.slot-card .slot-time{font-weight:700;font-size:.82rem}
.slot-card .slot-class{font-size:.8rem;color:#3a2f3b;margin:.05rem 0 .15rem}
.slot-card .slot-coach{display:flex;align-items:center;font-size:.75rem;color:#6c5a6d}
.slot--foundation{border-color:#cfe2d4;border-left-color:#3f8f5a}
.slot--sculpt{border-color:#f0dcc0;border-left-color:#d98a2b}
.slot--intense{border-color:#f2cfd4;border-left-color:#c2404f}
.slot--other{border-color:#ddd6e2;border-left-color:#8a7f92}
.slot--conflict{outline:2px solid #c2404f;outline-offset:1px}
.coach-dot{display:inline-flex;width:1.15rem;height:1.15rem;border-radius:50%;background:#1f2b45;color:#fff;font-size:.62rem;font-weight:700;align-items:center;justify-content:center;margin-right:.3rem;flex:0 0 auto}
.ct-dot{display:inline-block;width:.62rem;height:.62rem;border-radius:50%;margin-right:.35rem;background:#1f2b45;vertical-align:baseline}
.add-slot{margin-top:auto;width:100%;border:1px dashed #ccc;background:none;border-radius:8px;padding:.3rem;color:#8a7f92;cursor:pointer;font-size:.8rem}
.add-slot:hover{border-color:#7c547d;color:#7c547d}
.coaching-totals{display:flex;gap:.5rem;flex-wrap:wrap;font-size:.9rem;align-items:baseline}
.coaching-totals .ct-coach{cursor:pointer;padding:.12rem .45rem;border-radius:7px;border:1px solid transparent;user-select:none}
.coaching-totals .ct-coach b{color:#211921}
.coaching-totals .ct-coach:hover{background:#f0eaf1}
.coaching-totals .ct-coach.is-active{background:#7c547d;border-color:#7c547d;color:#fff}
.coaching-totals .ct-coach.is-active b{color:#fff}
.coaching-totals .ct-total{margin-left:auto;color:#8a7f92;font-size:.82rem}
.slot-preset{margin:.1rem}
#conflictwarn{color:#c2404f;font-size:.82rem;margin:.3rem 0 0}
.savebar.save--saved{background:#e7f4ec;border-color:#bfe0cb;color:#1f6b3a;font-weight:600}
.savebar.save--error{background:#fbe6e8;border-color:#f0c0c6;color:#a11c2c}
.savebar #savestatus{font-weight:600}
`;

export function renderCoachingPlanning(data: CoachingPlanningData): string {
  const { schedules, current, slots, coachNames, classNames } = data;

  const header = `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Studio</span><h2>Planning des cours</h2><p>Bac à sable pour composer des scénarios de planning coaching. Rien n'est envoyé à Wix — recopiez le scénario choisi dans Wix Bookings à la main.</p></div></header>`;

  if (schedules.length === 0 || !current) {
    return `${data.banner}
${header}
<div class="card"><div class="empty"><b>Aucun scénario</b><p>Créez un premier scénario vide, ou importez la semaine réelle depuis Wix pour partir d'une base.</p></div>
<div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin-top:.6rem">
  <form method="post" action="/admin/coaching" style="display:flex;gap:.5rem;flex:1;min-width:220px">
    <input name="name" required placeholder="Nom du scénario (ex. Rentrée septembre)" style="flex:1">
    <button class="act" type="submit">Créer</button>
  </form>
  <form method="post" action="/admin/coaching/import-wix" class="inline" data-confirm="Créer un brouillon depuis la semaine réelle Wix (cours Reformer et Mat) ?"><button class="act act--ghost" type="submit">Importer depuis Wix</button></form>
</div></div>`;
  }

  const selector = schedules
    .map((s) => `<option value="${esc(s.id)}"${s.id === current.id ? " selected" : ""}>${esc(s.name)}${s.status === "published" ? " (publié)" : ""}</option>`)
    .join("");

  const isDraft = current.status === "draft";
  const inlineForm = (action: string, label: string, extra = "", confirm?: string, cls = "act act--sm") =>
    `<form method="post" action="${esc(action)}" class="inline"${confirm ? ` data-confirm="${esc(confirm)}"` : ""}>${extra}<button class="${cls}" type="submit">${esc(label)}</button></form>`;

  const stateJson = jsonLiteral({
    scheduleId: current.id,
    slots: slots.map((s, i) => ({
      k: i,
      wd: s.weekday,
      s: s.start_min,
      d: s.duration_min,
      co: s.coach_name,
      cl: s.class_name,
      coId: s.coach_wix_id,
      clId: s.class_wix_id,
    })),
    coaches: coachNames,
    classes: classNames,
    presets: TIME_PRESETS_MIN,
    defaultDur: DEFAULT_DURATION_MIN,
  });

  const coachOptions = coachNames.map((n) => `<option value="${esc(n)}"></option>`).join("");
  const classOptions = classNames.map((n) => `<option value="${esc(n)}"></option>`).join("");
  const presetButtons = TIME_PRESETS_MIN.map(
    (m) => `<button type="button" class="act act--sm act--ghost slot-preset" onclick="slPreset(${m})">${esc(fmtSlotTime(m))}</button>`,
  ).join("");

  return `${data.banner}
<style>${PAGE_CSS}</style>
${header}

<div class="card cluster planning-toolbar">
  <form method="get" action="/admin/coaching" style="margin:0">
    <select name="s" onchange="this.form.submit()">${selector}</select>
  </form>
  ${scheduleBadge(current)}
  ${inlineForm("/admin/coaching/duplicate", "Dupliquer", `<input type="hidden" name="source_id" value="${esc(current.id)}"><input type="hidden" name="name" value="Copie de ${esc(current.name)}">`)}
  ${inlineForm(`/admin/coaching/${current.id}/rename`, "Renommer", `<input name="name" value="${esc(current.name)}" style="width:11rem">`)}
  ${isDraft ? inlineForm(`/admin/coaching/${current.id}/publish`, "Publier", "", `Publier « ${current.name} » ? Il deviendra le scénario de référence.`) : ""}
  ${isDraft ? inlineForm(`/admin/coaching/${current.id}/delete`, "Supprimer", "", `Supprimer « ${current.name} » ?`, "act act--sm act--danger") : ""}
  <a class="act act--sm act--ghost" href="/admin/coaching?new=1">Nouveau</a>
  <a class="act act--sm act--ghost" href="/admin/coaching/${esc(current.id)}/print" target="_blank">Télécharger / Imprimer</a>
  ${inlineForm("/admin/coaching/import-wix", "Importer depuis Wix", "", "Créer un brouillon depuis la semaine réelle Wix (cours Reformer et Mat) ?", "act act--sm act--ghost")}
</div>
${data.showNewForm ? `<div class="card"><form method="post" action="/admin/coaching" style="display:flex;gap:.5rem;flex-wrap:wrap"><input name="name" required placeholder="Nom du scénario" style="flex:1;min-width:220px"><button class="act" type="submit">Créer</button></form></div>` : ""}

<div id="savebar" class="savebar">
  <span id="savestatus">Enregistrement automatique activé</span>
  <button class="act act--sm act--ghost" onclick="coachingSave()">Enregistrer maintenant</button>
</div>

<div class="section-header"><div><span class="eyebrow">Charge par coach</span><h2>${esc(current.name)} ${scheduleBadge(current)}</h2></div></div>
<div id="coachtotals" class="card coaching-totals"></div>
<p id="conflictwarn" style="display:none"></p>

<div class="card board-wrap">
  <p class="muted" style="margin:.1rem 0 .7rem">Cliquez « + Ajouter » pour créer un cours, une carte pour la modifier, ou glissez-la vers un autre jour. Couleur = niveau (vert Foundation · orange Sculpt · rouge Intense).</p>
  <div id="board" class="board"></div>
</div>


<datalist id="coachlist">${coachOptions}</datalist>
<datalist id="classlist">${classOptions}</datalist>

<div id="slededitor" class="planning-dialog" role="dialog" aria-modal="true" aria-labelledby="sltitle">
  <div class="planning-dialog-panel">
    <div id="sltitle" style="font-weight:600;margin-bottom:.6rem"></div>
    <label style="display:block;margin-bottom:.5rem">Heure de début<input type="time" id="sl_start" step="300" style="width:100%"></label>
    <div style="display:flex;gap:.2rem;flex-wrap:wrap;margin-bottom:.7rem">${presetButtons}</div>
    <label style="display:block;margin-bottom:.5rem">Cours<input id="sl_class" list="classlist" placeholder="ex. Pilates Reformer (Sculpt)" style="width:100%"></label>
    <label style="display:block;margin-bottom:.5rem">Coach<input id="sl_coach" list="coachlist" placeholder="ex. Serena" style="width:100%"></label>
    <label style="display:block;margin-bottom:.7rem">Durée (min)<input type="number" id="sl_dur" min="15" max="240" step="5" value="${DEFAULT_DURATION_MIN}" style="width:100%"></label>
    <div style="display:flex;gap:.5rem;justify-content:flex-end">
      <button type="button" id="sl_delete" onclick="slDelete()" class="act act--sm act--danger">Supprimer</button>
      <button type="button" onclick="slClose()" class="act act--sm act--ghost">Annuler</button>
      <button type="button" class="act" onclick="slOk()" style="padding:.4rem .9rem">OK</button>
    </div>
  </div>
</div>

<script>
(function(){
  var ST = ${stateJson};
  var DAYS = ["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"];
  var nextK = ST.slots.reduce(function(m,s){ return Math.max(m, s.k+1); }, 0);
  var dirty = false, editK = null, editWd = 0, lastFocus = null;
  var filterCoach = null;      // lowercase coach key, or null = show everyone
  var filterCoachName = "";    // display name of the filtered coach

  function pad(n){ return (n<10?"0":"")+n; }
  function fmt(x){ return Math.floor(x/60)+"h"+pad(x%60); }
  function toTime(x){ return pad(Math.floor(x/60))+":"+pad(x%60); }
  function toMin(v){ if(!v) return null; var p=v.split(":"); return (+p[0])*60+(+p[1]); }
  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
  function norm(s){ return String(s).normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").toLowerCase(); }
  function levelOf(name){ var n=norm(name); if(n.indexOf("foundation")>=0) return "foundation"; if(n.indexOf("sculpt")>=0) return "sculpt"; if(n.indexOf("intense")>=0) return "intense"; return "other"; }
  function initial(name){ var t=String(name).trim(); return t ? t[0].toUpperCase() : "?"; }
  // Distinct colour per coach (dark enough for white text on the dot). Assigned
  // by rank over the coaches present, so no two ever share a colour (until the
  // palette runs out); rebuilt each render, same for the card and the legend.
  var COACH_COLORS = ["#2b6fb0","#3f8f5a","#c2404f","#b5701f","#7c547d","#0f8a8a","#8a5a2b","#55408f","#b03a86","#4a6b1f"];
  var colorMap = {};
  function buildColorMap(){
    var keys = {};
    ST.slots.forEach(function(s){ var k=norm(s.co); if(k) keys[k]=1; });
    if(filterCoach) keys[filterCoach]=1; // keep a pinned 0-course coach coloured
    colorMap = {};
    Object.keys(keys).sort().forEach(function(k,i){ colorMap[k]=COACH_COLORS[i % COACH_COLORS.length]; });
  }
  function coachColor(name){ return colorMap[norm(name)] || "#1f2b45"; }
  function conflictKey(s){ return s.wd+":"+s.s+":"+String(s.co).trim().toLowerCase(); }
  var saveTimer=null, saving=false, pendingAgain=false, savedHideTimer=null;
  function setSave(state, msg){
    var bar=document.getElementById("savebar"), st=document.getElementById("savestatus");
    if(savedHideTimer){ clearTimeout(savedHideTimer); savedHideTimer=null; }
    bar.style.display="flex"; bar.className="savebar save--"+state;
    if(state==="pending") st.textContent="Modification en attente…";
    else if(state==="saving") st.textContent="Enregistrement…";
    else if(state==="saved"){ st.textContent="✓ Enregistré"; savedHideTimer=setTimeout(function(){ if(!dirty) bar.style.display="none"; }, 1600); }
    else if(state==="error") st.textContent="⚠️ Non enregistré : "+(msg||"échec")+" — corrigez pour réessayer";
  }
  function scheduleAutosave(){ if(saveTimer) clearTimeout(saveTimer); setSave("pending"); saveTimer=setTimeout(function(){ doAutosave(); }, 900); }
  function doAutosave(){
    if(saveTimer){ clearTimeout(saveTimer); saveTimer=null; }
    if(saving){ pendingAgain=true; return; }
    saving=true; setSave("saving");
    var slots = ST.slots.map(function(s){ return { weekday:s.wd, start_min:s.s, duration_min:s.d, coach_name:s.co, class_name:s.cl, coach_wix_id:s.coId, class_wix_id:s.clId }; });
    var body = "ajax=1&grid="+encodeURIComponent(JSON.stringify({ slots: slots }));
    fetch("/admin/coaching/"+ST.scheduleId+"/grid", { method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body:body, credentials:"same-origin" })
      .then(function(r){ return r.json().catch(function(){ return { ok:false, error:"réponse invalide" }; }); })
      .then(function(j){ saving=false;
        if(j && j.ok){ dirty=false; setSave("saved"); }
        else { setSave("error", j && j.error); }
        if(pendingAgain){ pendingAgain=false; scheduleAutosave(); }
      })
      .catch(function(){ saving=false; setSave("error","réseau"); if(pendingAgain){ pendingAgain=false; scheduleAutosave(); } });
  }
  function markDirty(){ dirty=true; scheduleAutosave(); }

  function render(){
    buildColorMap();
    var board = document.getElementById("board"); board.innerHTML="";
    // conflict counts
    var counts = {};
    ST.slots.forEach(function(s){ var k=conflictKey(s); counts[k]=(counts[k]||0)+1; });
    for(var wd=0; wd<7; wd++){
      (function(wd){
        var col = document.createElement("div"); col.className="board-col"; col.setAttribute("data-wd",wd);
        var mine = ST.slots.filter(function(s){ return s.wd===wd && (!filterCoach || String(s.co).trim().toLowerCase()===filterCoach); }).sort(function(a,b){ return a.s-b.s; });
        var head = document.createElement("div"); head.className="board-col-head";
        head.innerHTML = "<span>"+DAYS[wd].slice(0,3)+"</span><span class='col-count'>"+mine.length+" cours</span>";
        col.appendChild(head);
        mine.forEach(function(s){
          var card = document.createElement("div");
          card.className = "slot-card slot--"+levelOf(s.cl) + (counts[conflictKey(s)]>1 ? " slot--conflict" : "");
          card.setAttribute("draggable","true"); card.setAttribute("data-k",s.k); card.setAttribute("tabindex","0");
          card.innerHTML = "<div class='slot-time'>"+fmt(s.s)+"</div>"+
            "<div class='slot-class'>"+esc(s.cl)+"</div>"+
            "<div class='slot-coach'><span class='coach-dot' style='background:"+coachColor(s.co)+"'>"+esc(initial(s.co))+"</span>"+esc(s.co)+"</div>";
          card.addEventListener("click", function(){ slOpen(wd, s.k); });
          card.addEventListener("keydown", function(ev){ if(ev.key==="Enter"||ev.key===" "){ ev.preventDefault(); slOpen(wd, s.k); } });
          card.addEventListener("dragstart", function(ev){ ev.dataTransfer.setData("text/plain", String(s.k)); });
          col.appendChild(card);
        });
        var add = document.createElement("button");
        add.type="button"; add.className="add-slot"; add.textContent="+ Ajouter";
        add.addEventListener("click", function(){ slOpen(wd, null); });
        col.appendChild(add);
        col.addEventListener("dragover", function(ev){ ev.preventDefault(); col.classList.add("board-col--over"); });
        col.addEventListener("dragleave", function(){ col.classList.remove("board-col--over"); });
        col.addEventListener("drop", function(ev){
          ev.preventDefault(); col.classList.remove("board-col--over");
          var k = parseInt(ev.dataTransfer.getData("text/plain"),10);
          var slot = ST.slots.find(function(x){ return x.k===k; });
          if(slot && slot.wd!==wd){ slot.wd=wd; markDirty(); render(); }
        });
        board.appendChild(col);
      })(wd);
    }
    renderTotals(counts);
  }

  function renderTotals(counts){
    var by = {};
    ST.slots.forEach(function(s){ var key=String(s.co).trim().toLowerCase(); if(!by[key]) by[key]={name:String(s.co).trim(), key:key, n:0}; by[key].n++; });
    var arr = Object.keys(by).map(function(k){ return by[k]; }).sort(function(a,b){ return b.n-a.n; });
    // A filtered coach with zero classes left would vanish from the banner; keep
    // it pinned so you can always click it again to clear the filter.
    if(filterCoach && !by[filterCoach]) arr.push({ name: filterCoachName, key: filterCoach, n: 0 });
    var el = document.getElementById("coachtotals"); el.innerHTML="";
    if(!arr.length){ el.innerHTML = "<span class='muted'>Aucun cours pour l'instant.</span>"; }
    arr.forEach(function(c){
      var span = document.createElement("span");
      span.className = "ct-coach" + (filterCoach===c.key ? " is-active" : "");
      span.innerHTML = "<span class='ct-dot' style='background:"+coachColor(c.name)+"'></span>"+esc(c.name)+" <b>"+c.n+"</b>";
      span.title = filterCoach===c.key ? "Revoir tous les coachs" : ("Voir uniquement le planning de "+c.name);
      span.addEventListener("click", function(){
        if(filterCoach===c.key){ filterCoach=null; filterCoachName=""; }
        else { filterCoach=c.key; filterCoachName=c.name; }
        render();
      });
      el.appendChild(span);
    });
    var tot = document.createElement("span"); tot.className="ct-total";
    tot.textContent = filterCoach ? ("Planning de "+filterCoachName+" — cliquez son nom pour tout revoir") : ("Total : "+ST.slots.length+" cours/sem.");
    el.appendChild(tot);
    var nbConflict = 0; for(var k in counts){ if(counts[k]>1) nbConflict++; }
    var warn = document.getElementById("conflictwarn");
    if(nbConflict>0){ warn.style.display="block"; warn.textContent = "⚠️ "+nbConflict+" conflit(s) : un même coach a deux cours en même temps. À corriger avant d'enregistrer."; }
    else warn.style.display="none";
  }

  // ----- editor -----
  window.slPreset = function(min){ document.getElementById("sl_start").value = toTime(min); };
  function slOpen(wd, k){
    lastFocus = document.activeElement;
    editWd = wd; editK = k;
    var slot = (k!=null) ? ST.slots.find(function(x){ return x.k===k; }) : null;
    document.getElementById("sltitle").textContent = (slot ? "Modifier" : "Ajouter") + " — " + DAYS[wd];
    var last = ST.slots[ST.slots.length-1];
    document.getElementById("sl_start").value = toTime(slot ? slot.s : (last ? last.s : 555));
    document.getElementById("sl_class").value = slot ? slot.cl : (last ? last.cl : "");
    document.getElementById("sl_coach").value = slot ? slot.co : (filterCoach ? filterCoachName : (last ? last.co : ""));
    document.getElementById("sl_dur").value = slot ? slot.d : ST.defaultDur;
    document.getElementById("sl_delete").style.display = slot ? "" : "none";
    document.getElementById("slededitor").style.display = "flex";
    document.getElementById("sl_class").focus();
  }
  window.slClose = function(){ document.getElementById("slededitor").style.display="none"; editK=null; if(lastFocus&&lastFocus.focus) lastFocus.focus(); };
  window.slDelete = function(){ if(editK!=null){ ST.slots = ST.slots.filter(function(x){ return x.k!==editK; }); markDirty(); render(); } slClose(); };
  window.slOk = function(){
    var s = toMin(document.getElementById("sl_start").value);
    var cl = document.getElementById("sl_class").value.trim();
    var co = document.getElementById("sl_coach").value.trim();
    var d = parseInt(document.getElementById("sl_dur").value,10);
    if(s==null){ alert("Heure de début requise."); return; }
    if(!cl || !co){ alert("Cours et coach obligatoires."); return; }
    if(cl.length>80 || co.length>80){ alert("Nom trop long (max 80 caractères)."); return; }
    if(!(d>=15 && d<=240)){ d = ST.defaultDur; }
    if(editK!=null){
      var slot = ST.slots.find(function(x){ return x.k===editK; });
      slot.wd=editWd; slot.s=s; slot.cl=cl; slot.co=co; slot.d=d;
    } else {
      ST.slots.push({ k: nextK++, wd: editWd, s: s, d: d, co: co, cl: cl, coId: null, clId: null });
    }
    markDirty(); render(); slClose();
  };

  window.coachingSave = function(){ doAutosave(); };

  window.addEventListener("beforeunload", function(ev){ if(dirty){ ev.preventDefault(); ev.returnValue=""; } });
  document.addEventListener("keydown", function(ev){ if(ev.key==="Escape" && editK!==null){ ev.preventDefault(); slClose(); } });
  render();
})();
</script>`;
}

// ---------- print / download (mobile-friendly, per-day lists) ----------

function coachDot(color: string): string {
  return `<span class="cdot" style="background:${color}"></span>`;
}

/** Ordered list of a day's courses (time — class · coach), sorted by time. */
function dayList(daySlots: ClassPlanSlot[], colors: Map<string, string>, withCoach: boolean): string {
  return daySlots
    .slice()
    .sort((a, b) => a.start_min - b.start_min)
    .map((s) => {
      const lvl = levelFromClassName(s.class_name);
      const coach = withCoach ? ` ${coachDot(colors.get(normName(s.coach_name)) ?? "#1f2b45")}<span class="co">${esc(s.coach_name)}</span>` : "";
      return `<li><span class="t">${esc(fmtSlotTime(s.start_min))}</span><span class="cl" style="border-color:${LEVEL_COLORS[lvl]}">${esc(s.class_name)}</span>${coach}</li>`;
    })
    .join("");
}

/**
 * Standalone, phone-readable schedule page (print / save as PDF). Shows the whole
 * week as per-day lists (global) or, when a coach is given, only that coach's
 * courses. A print button triggers the browser's "Save as PDF".
 */
export function renderCoachingPrint(
  current: ClassPlanSchedule,
  slots: ClassPlanSlot[],
  coachFilter: string | null,
): string {
  const colors = coachColorMap(slots);
  const coaches = [...new Set(slots.map((s) => s.coach_name.trim()).filter(Boolean))].sort(
    (a, b) => slots.filter((s) => s.coach_name.trim() === b).length - slots.filter((s) => s.coach_name.trim() === a).length,
  );
  const filterKey = coachFilter ? normName(coachFilter) : null;
  const shown = filterKey ? slots.filter((s) => normName(s.coach_name) === filterKey) : slots;
  const filterName = filterKey ? coaches.find((c) => normName(c) === filterKey) ?? coachFilter : null;

  const chip = (href: string, label: string, active: boolean, color?: string) =>
    `<a class="chip${active ? " chip--on" : ""}" href="${esc(href)}">${color ? coachDot(color) : ""}${esc(label)}</a>`;
  const nav = `<div class="nav no-print">
    ${chip(`/admin/coaching/${current.id}/print`, "Vue globale", !filterKey)}
    ${coaches.map((c) => chip(`/admin/coaching/${current.id}/print?coach=${encodeURIComponent(c)}`, `${c} (${slots.filter((s) => s.coach_name.trim() === c).length})`, filterKey === normName(c), colors.get(normName(c)))).join("")}
  </div>`;

  // Global view = per-day lists with coach; single-coach view = that coach's days.
  const daySections = WEEKDAYS_FULL.map((label, wd) => {
    const ds = shown.filter((s) => s.weekday === wd);
    if (ds.length === 0) return "";
    return `<section class="day"><h2>${label} <span class="n">${ds.length}</span></h2><ul>${dayList(ds, colors, true)}</ul></section>`;
  }).join("");

  const heading = filterName ? `Planning de ${esc(filterName)}` : "Planning global";
  const subtitle = filterName
    ? `${shown.length} cours/semaine`
    : `${slots.length} cours/semaine · ${coaches.length} coach${coaches.length > 1 ? "s" : ""}`;

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(heading)} — ${esc(current.name)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#211921;background:#f6f3f7;margin:0;padding:1rem;max-width:640px;margin:0 auto}
  h1{font-size:1.25rem;margin:.2rem 0 0}
  .sub{color:#6c5a6d;font-size:.85rem;margin:.1rem 0 .8rem}
  .nav{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem}
  .chip{display:inline-flex;align-items:center;text-decoration:none;font-size:.82rem;color:#3a2f3b;background:#fff;border:1px solid #e0d8e4;border-radius:20px;padding:.28rem .7rem}
  .chip--on{background:#211921;color:#fff;border-color:#211921}
  .cdot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;margin-right:.35rem;flex:0 0 auto}
  .btn{display:inline-block;background:#7c547d;color:#fff;border:none;border-radius:9px;padding:.6rem 1.1rem;font-size:.95rem;cursor:pointer;text-decoration:none}
  .day{background:#fff;border:1px solid #eee;border-radius:12px;padding:.6rem .8rem;margin-bottom:.7rem}
  .day h2{font-size:1rem;margin:.1rem 0 .5rem;display:flex;align-items:center;gap:.5rem}
  .day h2 .n{font-size:.72rem;font-weight:600;color:#8a7f92;background:#f0eaf1;border-radius:10px;padding:.05rem .5rem}
  ul{list-style:none;margin:0;padding:0}
  li{display:flex;align-items:center;gap:.5rem;padding:.35rem 0;border-top:1px solid #f2eef4;font-size:.9rem}
  li:first-child{border-top:none}
  .t{font-weight:700;min-width:3.1rem}
  .cl{border-left:3px solid #8a7f92;padding-left:.5rem;flex:1}
  .co{color:#3a2f3b}
  .empty{color:#8a7f92;padding:1rem;text-align:center;background:#fff;border-radius:12px}
  @media print{ body{background:#fff;padding:0;max-width:none} .no-print{display:none} .day{break-inside:avoid;border-color:#ddd} }
</style></head><body>
<div class="no-print" style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;margin-bottom:.6rem">
  <a class="btn" href="#" onclick="window.print();return false">⤓ Enregistrer en PDF / Imprimer</a>
</div>
<h1>${esc(heading)}</h1>
<p class="sub">${esc(current.name)}${current.status === "published" ? " · référence" : " · brouillon"} — ${esc(subtitle)}</p>
${nav}
${daySections || `<div class="empty">Aucun cours à afficher.</div>`}
</body></html>`;
}
