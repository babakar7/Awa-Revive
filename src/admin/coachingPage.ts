import {
  TIME_PRESETS_MIN,
  DEFAULT_DURATION_MIN,
  fmtSlotTime,
} from "../domain/classPlanningRules.js";
import type { ClassPlanSchedule, ClassPlanSlot } from "../domain/classPlanningRepo.js";

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
  ${inlineForm("/admin/coaching/import-wix", "Importer depuis Wix", "", "Créer un brouillon depuis la semaine réelle Wix (cours Reformer et Mat) ?", "act act--sm act--ghost")}
</div>
${data.showNewForm ? `<div class="card"><form method="post" action="/admin/coaching" style="display:flex;gap:.5rem;flex-wrap:wrap"><input name="name" required placeholder="Nom du scénario" style="flex:1;min-width:220px"><button class="act" type="submit">Créer</button></form></div>` : ""}

<div id="savebar" class="savebar">
  <span>Modifications non enregistrées</span>
  <button class="act" onclick="coachingSave()">Enregistrer</button>
</div>

<div class="section-header"><div><span class="eyebrow">Charge par coach</span><h2>${esc(current.name)} ${scheduleBadge(current)}</h2></div></div>
<div id="coachtotals" class="card coaching-totals"></div>
<p id="conflictwarn" style="display:none"></p>

<div class="card board-wrap">
  <p class="muted" style="margin:.1rem 0 .7rem">Cliquez « + Ajouter » pour créer un cours, une carte pour la modifier, ou glissez-la vers un autre jour. Couleur = niveau (vert Foundation · orange Sculpt · rouge Intense).</p>
  <div id="board" class="board"></div>
</div>

<form method="post" action="/admin/coaching/${esc(current.id)}/grid" id="gridform" style="display:none"><input type="hidden" name="grid" id="gridinput"></form>

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
  // Deterministic coach colour (dark enough for white text on the dot). Same
  // coach → same colour everywhere; stable across reloads.
  var COACH_COLORS = ["#2b6fb0","#3f8f5a","#c2404f","#b5701f","#7c547d","#0f8a8a","#8a5a2b","#55408f","#b03a86","#4a6b1f"];
  function coachColor(name){ var n=norm(name), h=0; for(var i=0;i<n.length;i++){ h=(h*31 + n.charCodeAt(i))>>>0; } return n ? COACH_COLORS[h % COACH_COLORS.length] : "#1f2b45"; }
  function conflictKey(s){ return s.wd+":"+s.s+":"+String(s.co).trim().toLowerCase(); }
  function markDirty(){ if(!dirty){ dirty=true; document.getElementById("savebar").style.display="flex"; } }

  function render(){
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

  window.coachingSave = function(){
    var slots = ST.slots.map(function(s){ return { weekday:s.wd, start_min:s.s, duration_min:s.d, coach_name:s.co, class_name:s.cl, coach_wix_id:s.coId, class_wix_id:s.clId }; });
    document.getElementById("gridinput").value = JSON.stringify({ slots: slots });
    dirty = false;
    document.getElementById("gridform").submit();
  };

  window.addEventListener("beforeunload", function(ev){ if(dirty){ ev.preventDefault(); ev.returnValue=""; } });
  document.addEventListener("keydown", function(ev){ if(ev.key==="Escape" && editK!==null){ ev.preventDefault(); slClose(); } });
  render();
})();
</script>`;
}
