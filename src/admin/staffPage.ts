import {
  BREAK_END_MIN,
  BREAK_START_MIN,
  WEEKDAYS_FR,
  fmtDuration,
  fmtMin,
  weeklyTotalMinutes,
  workedMinutes,
} from "../domain/staffPlanningRules.js";
import type { PlanningStaff, StaffSchedule, StaffShift } from "../domain/staffPlanningRepo.js";

/**
 * Body HTML for /admin/staff — server-rendered chrome + a self-contained vanilla
 * grid editor (no framework). The grid state lives client-side; "Enregistrer"
 * POSTs the whole grid as JSON. The print page is a standalone document.
 */

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const ROLE_ABBR: Record<string, string> = { accueil: "acc", bar: "bar", entretien: "ent" };

const BANNERS: Record<string, string> = {
  saved: "Grille enregistrée.",
  created: "Nouveau planning créé.",
  duplicated: "Planning dupliqué.",
  renamed: "Planning renommé.",
  published: "Planning publié — c'est le planning de référence.",
  deleted: "Planning supprimé.",
  "phone-saved": "Numéro enregistré.",
  "phone-cleared": "Numéro retiré.",
  "contact-added": "Employée ajoutée.",
  "contact-removed": "Employée retirée de l'équipe.",
};

export function staffBanner(done?: string, err?: string): string {
  if (done && BANNERS[done])
    return `<div class="card success"><span class="ok">✓ ${esc(BANNERS[done])}</span></div>`;
  if (done && done.startsWith("sent:"))
    return `<div class="card success"><span class="ok">✓ Planning envoyé à ${esc(done.slice(5))}.</span></div>`;
  if (done && done.startsWith("sent-all:")) {
    const [, ok, nophone, noshift] = done.split(":");
    let msg = `${ok} planning(s) envoyé(s)`;
    if (Number(nophone) > 0) msg += ` · ${nophone} sans numéro`;
    if (Number(noshift) > 0) msg += ` · ${noshift} sans horaires`;
    return `<div class="card success"><span class="ok">✓ ${esc(msg)}.</span></div>`;
  }
  if (err === "no-phone")
    return `<div class="card warn">⚠️ Cette employée n'a pas de numéro WhatsApp. Ajoute-le dans le <a href="/admin/notifications#contacts">répertoire staff</a>.</div>`;
  if (err) return `<div class="card warn">⚠️ ${esc(err)}</div>`;
  return "";
}

export interface StaffPlanningData {
  schedules: StaffSchedule[];
  current: StaffSchedule | null;
  shifts: StaffShift[];
  staff: PlanningStaff[];
  banner: string;
}

const scheduleBadge = (s: StaffSchedule) =>
  s.status === "published"
    ? `<span class="badge badge--green">publié</span>`
    : `<span class="badge badge--gray">brouillon</span>`;

export type StaffGridCells = Record<string, { s: number; e: number }>;

/** Mutates the browser grid so the target becomes an independent copy of the source week. */
export function copyEmployeeWeek(
  cells: StaffGridCells,
  sourceId: string,
  targetId: string,
): boolean {
  if (!sourceId || !targetId || sourceId === targetId) return false;
  const sourceWeek = Array.from({ length: 7 }, (_, weekday) => {
    const source = cells[`${sourceId}:${weekday}`];
    return source ? { s: source.s, e: source.e } : null;
  });
  for (let weekday = 0; weekday < 7; weekday += 1) {
    delete cells[`${targetId}:${weekday}`];
    const source = sourceWeek[weekday];
    if (source) cells[`${targetId}:${weekday}`] = { s: source.s, e: source.e };
  }
  return true;
}

export function renderStaffPlanning(data: StaffPlanningData): string {
  const { schedules, current, shifts, staff } = data;

  if (schedules.length === 0 || !current) {
    return `${data.banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Studio</span><h2>Planning de l’équipe</h2><p>Créez un premier scénario hebdomadaire pour organiser l’accueil, le bar et l’entretien.</p></div></header>
<div class="card"><div class="empty"><b>Aucun planning</b><p>Donnez un nom au premier scénario pour commencer.</p></div>
<form method="post" action="/admin/staff" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
  <input name="name" required placeholder="Nom du planning (ex. Semaine type)" style="flex:1;min-width:220px">
  <button class="act" type="submit">Créer un planning</button>
</form></div>`;
  }

  const selector = schedules
    .map((s) => `<option value="${esc(s.id)}"${s.id === current.id ? " selected" : ""}>${esc(s.name)}${s.status === "published" ? " (publié)" : ""}</option>`)
    .join("");

  const isDraft = current.status === "draft";
  const stateJson = JSON.stringify({
    scheduleId: current.id,
    staff: staff.map((p) => ({ id: p.id, name: p.name, role: p.role, hasPhone: !!p.phone })),
    cells: Object.fromEntries(shifts.map((sh) => [`${sh.staff_id}:${sh.weekday}`, { s: sh.start_min, e: sh.end_min }])),
  }).replace(/</g, "\\u003c");

  const inlineForm = (action: string, label: string, extra = "", confirm?: string) =>
    `<form method="post" action="${esc(action)}" class="inline"${confirm ? ` data-confirm="${esc(confirm)}"` : ""}>${extra}<button class="act act--sm" type="submit">${esc(label)}</button></form>`;

  return `${data.banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Studio</span><h2>Planning de l’équipe</h2><p>Testez les rotations, publiez le scénario de référence et envoyez à chacune son planning.</p></div><div class="page-header-actions"><a class="act act--ghost" href="/admin/staff/${esc(current.id)}/print" target="_blank">Imprimer</a>${inlineForm(`/admin/staff/${current.id}/send-all`, "Envoyer à toutes", "", `Envoyer « ${current.name} »${isDraft ? " (brouillon)" : ""} à toutes les employées ?`)}</div></header>

<div class="card cluster planning-toolbar">
  <form method="get" action="/admin/staff" style="margin:0">
    <select name="s" onchange="this.form.submit()" >${selector}</select>
  </form>
  ${scheduleBadge(current)}
  ${inlineForm("/admin/staff/duplicate", "Dupliquer", `<input type="hidden" name="source_id" value="${esc(current.id)}"><input type="hidden" name="name" value="Copie de ${esc(current.name)}">`)}
  ${inlineForm(`/admin/staff/${current.id}/rename`, "Renommer", `<input name="name" value="${esc(current.name)}" style="width:11rem">`)}
  ${isDraft ? inlineForm(`/admin/staff/${current.id}/publish`, "Publier", "", `Publier « ${current.name} » ? Il remplacera le planning de référence.`) : ""}
  ${isDraft ? inlineForm(`/admin/staff/${current.id}/delete`, "Supprimer", "", `Supprimer « ${current.name} » ?`) : ""}
  <a class="act act--sm act--ghost" href="/admin/staff?new=1">Nouveau planning</a>
</div>
${(data as any).showNewForm ? `<div class="card"><form method="post" action="/admin/staff" style="display:flex;gap:.5rem;flex-wrap:wrap"><input name="name" required placeholder="Nom du planning" style="flex:1;min-width:220px"><button class="act" type="submit">Créer</button></form></div>` : ""}

<div id="savebar" class="savebar">
  <span>Modifications non enregistrées</span>
  <button class="act" onclick="staffSave()">Enregistrer</button>
</div>

<div class="section-header"><div><span class="eyebrow">Rotation hebdomadaire</span><h2>${esc(current.name)} ${scheduleBadge(current)}</h2></div></div>
<div class="card table-wrap">
  <p class="muted">Cliquez une case ou utilisez Entrée pour saisir l’horaire. « Copier depuis… » remplace toute la semaine d’une employée, jours de repos compris. Le glisser-déposer copie un seul créneau. Les totaux déduisent la pause 13h30–14h30.</p>
  <table id="staffgrid" style="min-width:720px"><thead><tr><th>Employée</th>${WEEKDAYS_FR.map((d) => `<th style="text-align:center">${d.slice(0, 3)}</th>`).join("")}<th class="right">Heures</th></tr></thead>
  <tbody id="gridbody"></tbody>
  <tfoot><tr id="gridfoot" class="muted"></tr></tfoot></table>
</div>
<div class="section-header"><div><span class="eyebrow">Répertoire</span><h2>L’équipe</h2></div><span class="badge badge--gray">${staff.length}</span></div>
<div class="card" style="overflow-x:auto">
  <p class="muted" style="margin:.1rem 0 .7rem">Gérez ici les employées et leurs numéros WhatsApp, puis envoyez à chacune son planning (« ${esc(current.name)} »). L’ajout ou le retrait d’une employée s’applique à tous les scénarios.</p>
  <table style="min-width:560px"><thead><tr><th>Employée</th><th>Numéro WhatsApp</th><th class="right">Envoi</th><th></th></tr></thead><tbody>
  ${
    staff.length
      ? staff
          .map(
            (p) => `<tr>
<td><b>${esc(p.name)}</b> <span class="muted">${esc(p.role)}</span></td>
<td><form method="post" action="/admin/staff/contact/${esc(p.id)}/phone" style="display:flex;gap:.35rem;align-items:center;margin:0">
  <input name="phone" value="${esc(p.phone)}" placeholder="77 123 45 67" style="width:11rem">
  <button class="act act--sm act--ghost" type="submit">Enregistrer</button>
</form></td>
<td class="right">${
              p.phone
                ? `<form method="post" action="/admin/staff/${esc(current.id)}/send/${esc(p.id)}" class="inline" data-confirm="Envoyer son planning à ${esc(p.name)} ?"><button class="act act--sm" type="submit">Envoyer</button></form>`
                : `<span class="muted">Ajoutez d’abord un numéro</span>`
            }</td>
<td class="right"><form method="post" action="/admin/staff/contact/${esc(p.id)}/delete" class="inline" data-confirm="Retirer ${esc(p.name)} de l’équipe ? Ses horaires seront supprimés de tous les plannings."><button class="act act--sm act--danger" type="submit">Retirer</button></form></td>
</tr>`,
          )
          .join("")
      : `<tr><td colspan="4" class="muted">Aucune employée. Ajoute-la ci-dessous.</td></tr>`
  }
  </tbody></table>
  <form method="post" action="/admin/staff/contact" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end;margin-top:.8rem;border-top:1px solid #eee;padding-top:.8rem">
    <label style="flex:1;min-width:140px">Nouvelle employée<input name="name" required placeholder="Prénom" style="width:100%"></label>
    <label>Rôle<select name="role"><option value="accueil">accueil</option><option value="bar">bar</option><option value="entretien">entretien</option></select></label>
    <label style="min-width:150px">Numéro <span class="muted">(optionnel)</span><input name="phone" placeholder="77 123 45 67" style="width:100%"></label>
    <button class="act" type="submit">Ajouter</button>
  </form>
</div>

<form method="post" action="/admin/staff/${esc(current.id)}/grid" id="gridform" style="display:none"><input type="hidden" name="grid" id="gridinput"></form>

<div id="celleditor" class="planning-dialog" role="dialog" aria-modal="true" aria-labelledby="editortitle">
  <div class="planning-dialog-panel">
    <div id="editortitle" style="font-weight:600;margin-bottom:.6rem"></div>
    <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.6rem">
      <label style="flex:1">Début<input type="time" id="ed_start" step="300" style="width:100%"></label>
      <label style="flex:1">Fin<input type="time" id="ed_end" step="300" style="width:100%"></label>
    </div>
    <div id="ed_presets" style="display:flex;gap:.3rem;flex-wrap:wrap;margin-bottom:.7rem"></div>
    <div style="display:flex;gap:.5rem;justify-content:flex-end">
      <button type="button" onclick="edRepos()" class="act act--sm act--ghost">Repos</button>
      <button type="button" onclick="edClose()" class="act act--sm act--ghost">Annuler</button>
      <button type="button" class="act" onclick="edOk()" style="padding:.4rem .9rem">OK</button>
    </div>
  </div>
</div>

<div id="copyweek" class="planning-dialog" role="dialog" aria-modal="true" aria-labelledby="copyweektitle" aria-describedby="copyweekhelp">
  <div class="planning-dialog-panel">
    <span class="eyebrow">Copie hebdomadaire</span>
    <h2 id="copyweektitle" class="planning-dialog-title">Copier une semaine</h2>
    <p id="copyweekhelp" class="muted">Choisissez l’employée dont les horaires doivent servir de modèle.</p>
    <label for="copyweeksource">Copier les horaires de
      <select id="copyweeksource" onchange="copyWeekPreview()"></select>
    </label>
    <div class="planning-copy-warning">
      <b id="copyweeksummary">Les 7 jours seront remplacés.</b>
      <span>Les horaires actuels de la destinataire seront effacés, jours de repos compris.</span>
    </div>
    <div class="planning-dialog-actions">
      <button type="button" onclick="copyWeekClose()" class="act act--sm act--ghost">Annuler</button>
      <button type="button" class="act" onclick="copyWeekConfirm()">Remplacer la semaine</button>
    </div>
  </div>
</div>

<script>
(function(){
  var ST = JSON.parse("${stateJson.replace(/"/g, '\\"')}");
  var BS = ${BREAK_START_MIN}, BE = ${BREAK_END_MIN};
  var DAYS = ["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"];
  var dirty = false, editKey = null, lastGridFocus = null;
  var copyTargetId = null, lastCopyFocus = null;

  function pad(n){ return (n<10?"0":"")+n; }
  function fmt(x){ return Math.floor(x/60)+"h"+pad(x%60); }
  function dur(x){ return Math.floor(x/60)+"h"+pad(x%60); }
  function worked(s,e){ if(e<=BE) return e-s; return (e-s) - Math.max(0, Math.min(e,BE)-Math.max(s,BS)); }
  function toMin(v){ if(!v) return null; var p=v.split(":"); return (+p[0])*60+(+p[1]); }
  function toTime(x){ return pad(Math.floor(x/60))+":"+pad(x%60); }
  ${copyEmployeeWeek.toString()}

  function markDirty(){ if(!dirty){ dirty=true; document.getElementById("savebar").style.display="flex"; } }

  function render(){
    var body = document.getElementById("gridbody"); body.innerHTML="";
    ST.staff.forEach(function(p){
      var tr = document.createElement("tr");
      var tot = 0;
      var copyDisabled = ST.staff.length < 2;
      var tds = "<td class='staff-person'><b>"+esc(p.name)+"</b> <span class='muted'>"+esc(p.role)+"</span>"+
        "<button type='button' class='act act--sm act--ghost copy-week-btn' data-copy-target='"+esc(p.id)+"'"+
        (copyDisabled ? " disabled title='Ajoutez une autre employée pour copier une semaine'" : "")+">Copier depuis…</button></td>";
      for(var wd=0; wd<7; wd++){
        var c = ST.cells[p.id+":"+wd];
        if(c){ tot += worked(c.s,c.e); }
        tds += "<td style='text-align:center;cursor:pointer' data-k='"+p.id+":"+wd+"' onclick='edOpen(\\""+p.id+"\\","+wd+")'>"+
          (c ? "<span class='chip' draggable='true' data-k='"+p.id+":"+wd+"' style='display:inline-block;background:#eef4ef;border:1px solid #cfe2d4;border-radius:6px;padding:.12rem .38rem;font-size:.875rem;white-space:nowrap'>"+fmt(c.s)+"–"+fmt(c.e)+"</span>" : "<span class='muted'>—</span>")+
          "</td>";
      }
      tds += "<td style='text-align:right;font-weight:600'>"+dur(tot)+"</td>";
      tr.innerHTML = tds;
      body.appendChild(tr);
    });
    // footer headcount per day per role
    var foot = "<td>Effectif</td>";
    for(var d=0; d<7; d++){
      var cnt = {accueil:0,bar:0,entretien:0};
      ST.staff.forEach(function(p){ if(ST.cells[p.id+":"+d]) cnt[p.role]=(cnt[p.role]||0)+1; });
      foot += "<td style='text-align:center'>"+cnt.accueil+" acc · "+cnt.bar+" bar · "+cnt.entretien+" ent</td>";
    }
    foot += "<td></td>";
    document.getElementById("gridfoot").innerHTML = foot;
    wireDnd();
    wireCopyButtons();
  }

  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }

  // ----- drag & drop = copy -----
  function wireDnd(){
    document.querySelectorAll("#gridbody .chip").forEach(function(ch){
      ch.addEventListener("dragstart", function(ev){ ev.dataTransfer.setData("text/plain", ch.getAttribute("data-k")); });
    });
    document.querySelectorAll("#gridbody td[data-k]").forEach(function(td){
      td.setAttribute("role","button");td.setAttribute("tabindex","0");
      td.addEventListener("keydown", function(ev){
        if(ev.key==="Enter"||ev.key===" "){
          ev.preventDefault();var key=td.getAttribute("data-k").split(":");edOpen(key[0],parseInt(key[1],10));
        }
      });
      td.addEventListener("dragover", function(ev){ ev.preventDefault(); });
      td.addEventListener("drop", function(ev){
        ev.preventDefault();
        var from = ev.dataTransfer.getData("text/plain");
        var src = ST.cells[from]; if(!src) return;
        ST.cells[td.getAttribute("data-k")] = { s: src.s, e: src.e };
        markDirty(); render();
      });
    });
  }

  // ----- full-week copy (current client-side grid, including unsaved edits) -----
  function wireCopyButtons(){
    document.querySelectorAll("#gridbody .copy-week-btn:not([disabled])").forEach(function(button){
      button.addEventListener("click", function(){ copyWeekOpen(button.getAttribute("data-copy-target")); });
    });
  }

  function staffById(id){ return ST.staff.find(function(p){ return p.id===id; }); }

  function focusCopyButton(id){
    document.querySelectorAll("#gridbody .copy-week-btn").forEach(function(button){
      if(button.getAttribute("data-copy-target")===id){ button.focus(); }
    });
  }

  window.copyWeekOpen = function(targetId){
    var target = staffById(targetId); if(!target || ST.staff.length<2) return;
    copyTargetId = targetId;
    lastCopyFocus = document.activeElement;
    document.getElementById("copyweektitle").textContent = "Remplacer la semaine de " + target.name;
    var select = document.getElementById("copyweeksource");
    select.innerHTML = "";
    ST.staff.forEach(function(person){
      if(person.id===targetId) return;
      var option = document.createElement("option");
      option.value = person.id;
      option.textContent = person.name + " — " + person.role;
      select.appendChild(option);
    });
    copyWeekPreview();
    document.getElementById("copyweek").style.display = "flex";
    select.focus();
  };

  window.copyWeekPreview = function(){
    var sourceId = document.getElementById("copyweeksource").value;
    var source = staffById(sourceId);
    var workedDays = 0;
    for(var wd=0; wd<7; wd++){ if(ST.cells[sourceId+":"+wd]) workedDays++; }
    document.getElementById("copyweeksummary").textContent = source
      ? source.name + " : " + workedDays + " jour" + (workedDays===1 ? " travaillé" : "s travaillés") + " à copier."
      : "Choisissez une employée source.";
  };

  window.copyWeekClose = function(restoreFocus){
    document.getElementById("copyweek").style.display = "none";
    copyTargetId = null;
    if(restoreFocus!==false && lastCopyFocus && lastCopyFocus.focus) lastCopyFocus.focus();
    lastCopyFocus = null;
  };

  window.copyWeekConfirm = function(){
    var targetId = copyTargetId;
    var sourceId = document.getElementById("copyweeksource").value;
    if(!targetId || !sourceId || targetId===sourceId) return;

    if(!copyEmployeeWeek(ST.cells, sourceId, targetId)) return;
    copyWeekClose(false);
    markDirty();
    render();
    focusCopyButton(targetId);
  };

  // ----- cell editor -----
  window.edOpen = function(id, wd){
    lastGridFocus = document.activeElement;
    editKey = id+":"+wd;
    var p = ST.staff.find(function(x){ return x.id===id; });
    document.getElementById("editortitle").textContent = p.name + " — " + DAYS[wd];
    var c = ST.cells[editKey];
    document.getElementById("ed_start").value = c ? toTime(c.s) : "09:00";
    document.getElementById("ed_end").value = c ? toTime(c.e) : "17:00";
    // presets = distinct shifts already in the grid
    var seen = {}, pres = [];
    Object.keys(ST.cells).forEach(function(k){ var v=ST.cells[k], key=v.s+"-"+v.e; if(!seen[key]){ seen[key]=1; pres.push(v); } });
    document.getElementById("ed_presets").innerHTML = pres.slice(0,6).map(function(v){
      return "<button type='button' onclick='edPreset("+v.s+","+v.e+")' class='act act--sm act--ghost'>"+fmt(v.s)+"–"+fmt(v.e)+"</button>";
    }).join("");
    document.getElementById("celleditor").style.display="flex";
    document.getElementById("ed_start").focus();
  };
  window.edPreset = function(s,e){ document.getElementById("ed_start").value=toTime(s); document.getElementById("ed_end").value=toTime(e); };
  window.edClose = function(){ document.getElementById("celleditor").style.display="none"; editKey=null;if(lastGridFocus&&lastGridFocus.focus)lastGridFocus.focus(); };
  window.edRepos = function(){ if(editKey){ delete ST.cells[editKey]; markDirty(); render(); } edClose(); };
  window.edOk = function(){
    var s = toMin(document.getElementById("ed_start").value), e = toMin(document.getElementById("ed_end").value);
    if(s==null||e==null||s>=e){ alert("Horaire invalide (le début doit précéder la fin)."); return; }
    ST.cells[editKey] = { s: s, e: e }; markDirty(); render(); edClose();
  };

  window.staffSave = function(){
    var shifts = Object.keys(ST.cells).map(function(k){ var p=k.split(":"), v=ST.cells[k]; return { staff_id:p[0], weekday:+p[1], start_min:v.s, end_min:v.e }; });
    document.getElementById("gridinput").value = JSON.stringify({ shifts: shifts });
    dirty = false;
    document.getElementById("gridform").submit();
  };

  window.addEventListener("beforeunload", function(ev){ if(dirty){ ev.preventDefault(); ev.returnValue=""; } });
  document.addEventListener("keydown", function(ev){
    if(ev.key!=="Escape") return;
    if(copyTargetId){ ev.preventDefault();copyWeekClose(); }
    else if(editKey){ ev.preventDefault();edClose(); }
  });
  render();
})();
</script>`;
}

// ---------- print ----------

export function renderStaffPrint(current: StaffSchedule, shifts: StaffShift[], staff: PlanningStaff[]): string {
  const byKey = new Map(shifts.map((s) => [`${s.staff_id}:${s.weekday}`, s]));
  const rows = staff
    .map((p) => {
      const cells = WEEKDAYS_FR.map((_, wd) => {
        const s = byKey.get(`${p.id}:${wd}`);
        return `<td class="c">${s ? `${fmtMin(s.start_min)} – ${fmtMin(s.end_min)}` : `<span class="r">repos</span>`}</td>`;
      }).join("");
      const total = weeklyTotalMinutes(shifts.filter((s) => s.staff_id === p.id));
      return `<tr><td class="n"><b>${esc(p.name)}</b><div class="ro">${esc(p.role)}</div></td>${cells}<td class="h">${fmtDuration(total)}</td></tr>`;
    })
    .join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Planning — ${esc(current.name)}</title>
<style>
  @page { size: A4 landscape; margin: 1cm }
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#211921;background:#fff;margin:0;padding:1.4rem}
  h1{font-size:1.35rem;margin:0 0 .2rem}
  .sub{color:#6c5a6d;font-size:.85rem;margin:0 0 1rem}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{background:#1f2b45;color:#fff;padding:.45rem .5rem;text-align:left;font-size:.72rem;letter-spacing:.03em}
  td{border:1px solid #d9d2e0;padding:.4rem .5rem;vertical-align:top}
  td.c{text-align:center;white-space:nowrap}
  td.h{text-align:right;font-weight:700}
  .n b{font-size:.9rem} .ro{color:#6c5a6d;font-size:.72rem}
  .r{color:#a98baa}
  .note{margin-top:1rem;color:#6c5a6d;font-size:.78rem}
  .no-print{margin:0 0 1rem}
  .no-print button{background:#7c547d;color:#fff;border:none;border-radius:8px;padding:.5rem 1rem;font-size:.95rem;cursor:pointer}
  @media print{ .no-print{display:none} body{padding:0} }
</style></head><body>
<div class="no-print"><button onclick="window.print()">🖨 Imprimer / Enregistrer en PDF</button></div>
<h1>Planning du personnel — ${esc(current.name)}</h1>
<p class="sub">Revive Ventures · Almadies, Dakar${current.status === "published" ? " · planning de référence" : " · brouillon"}</p>
<table><thead><tr><th>Employée</th>${WEEKDAYS_FR.map((d) => `<th>${d}</th>`).join("")}<th>Heures</th></tr></thead><tbody>${rows}</tbody></table>
<p class="note">Pause 13h30 – 14h30 non comprise dans les totaux (déduite pour les journées se poursuivant l'après-midi).</p>
</body></html>`;
}
