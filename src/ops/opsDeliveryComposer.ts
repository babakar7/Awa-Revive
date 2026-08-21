/**
 * Shared delivery composer for reception (/ops/service) and owner (/ops/owner).
 * It deliberately receives its data and transport as arguments so neither PWA
 * can grow a second copy of delivery validation/pricing rules: the API remains
 * authoritative (POST {base}/deliveries decides prices, dates, eligibility).
 *
 * UX: a FULL-SCREEN two-step flow (not a bottom sheet) — step 1 picks the
 * items with the same search/chips/populaires pattern as the salle composer,
 * step 2 collects the client & delivery details. The footer (total + primary
 * action) stays pinned on both steps.
 *
 * CLASS-NAME CONTRACT — this composer styles only its own additions
 * (OPS_DELIVERY_COMPOSER_CSS below, injected by BOTH pages). Everything else
 * reuses classes each page already defines for its salle composer, so any
 * restyle of these must stay in sync across opsOwnerPage.ts/opsServicePage.ts:
 *   .ov .ov.center .sheet .sheet.searching .toolbar .searchbar .searchctl
 *   .search-summary .browsebar .chips .chip(.cart) .list .cat .mi(.on/.needchoice)
 *   .qbadge .stepper .qv .creq(.missing/.collapsed) .clab .cpills .cpill .wrap
 *   .nores .foot .total .go .msg .optional .optional-fields .modeseg .mode .cfm
 */

/** Delivery-only styles; every other class comes from the host page (see contract above). */
export const OPS_DELIVERY_COMPOSER_CSS = `
/* Full-screen takeover: reads as a page, not a sheet. */
.ov.dpage{align-items:stretch;justify-content:center;padding:0;background:var(--bg)}
.sheet.dfull{max-width:none;height:100vh;height:100dvh;border-radius:0;box-shadow:none;background:var(--bg);
padding-top:calc(.45rem + env(safe-area-inset-top))}
.sheet.dfull::before{display:none}
@media(min-width:42rem){.sheet.dfull{max-width:44rem;margin:0 auto}}
.dhead{display:flex;align-items:center;gap:.55rem;padding:0 0 .5rem}
.dhead .dback{flex:0 0 auto;min-width:2.75rem;min-height:2.75rem;border:1px solid var(--border-strong);border-radius:50%;
background:var(--surface);color:var(--ink-700);font-size:1.3rem;line-height:1;font-weight:600}
.dhead h2{margin:0;flex:1;font-family:var(--serif);font-size:1.25rem;font-weight:600;letter-spacing:-.02em}
.dhead .dstepdot{font-size:.78rem;font-weight:800;color:var(--ink-500);font-variant-numeric:tabular-nums}
/* Each step is a flex column so ITS .list gets the scroll (flex:1;min-height:0). */
.dstep{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.dstep[hidden]{display:none}
/* Step-2 form (these classes were previously unstyled). */
.dfull .field{display:block;margin:0 0 .6rem;font-size:.75rem;font-weight:800;text-transform:uppercase;
letter-spacing:.05em;color:var(--ink-500)}
.dfull .field input,.dfull .field textarea{margin:.3rem 0 0;font-weight:400;text-transform:none;letter-spacing:0}
.dfull .client-results{display:flex;flex-direction:column;gap:.4rem;margin:0 0 .6rem}
.dfull .client-results button{text-align:left;padding:.7rem .8rem;border:1px solid var(--border-soft);
border-radius:var(--radius);background:var(--surface-raised);color:var(--ink-800);font:inherit;font-weight:600}
.dfull label.check{display:flex;align-items:center;gap:.55rem;padding:.35rem .1rem .6rem;font-weight:600;color:var(--ink-700)}
.dfull label.check input{width:auto;margin:0}
.dfull .optional-fields{padding:.1rem .65rem .35rem}
/* Step-2 cart recap linking back to the item picker. */
.dcart-recap{display:flex;align-items:center;gap:.5rem;margin:.1rem 0 .7rem;padding:.65rem .8rem;
border:1px solid var(--border-soft);border-radius:var(--radius);background:var(--surface-raised);
font-weight:700;color:var(--ink-800)}
.dcart-recap button{margin-left:auto;appearance:none;border:0;background:none;padding:.2rem 0;color:var(--plum-700);
font:inherit;font-weight:700;text-decoration:underline;text-underline-offset:.15rem}
.dcart-recap button:disabled{opacity:.5}
/* Search focus: the page rules compact the picker; we also fold our header. */
.sheet.dfull.searching .dhead{display:none}
`;

export const OPS_DELIVERY_COMPOSER = String.raw`
;(function(){
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
  function uid(){try{return crypto.randomUUID();}catch(_){return 'delivery-'+Date.now()+'-'+Math.round(Math.random()*1e9);}}
  function money(n){return Number(n||0).toLocaleString('fr-FR')+' F';}
  function normal(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');}
  function selectedLine(item,qty,choices){var selections=[];for(var i=0;i<choices.length;i++){if(choices[i])selections.push({group_index:i,value:choices[i]});}return {item_id:item.id,qty:qty,selections:selections};}
  // Server-enforced caps (cafeMenu.ts) mirrored client-side to fail early.
  var MAX_QTY=10, MAX_LINES=15;
  function open(opt){
    var base=opt.base||'', menu=opt.menu||[], topIds=opt.top||[], recent=opt.recent||[];
    var cart={};                 // item_id -> {qty, choices:[value per group_index]}
    var requestId=uid();         // one id per open — a retry after a network error stays idempotent
    var searchTimer=0, clientReq=0;
    var state={step:1,q:'',cat:'__ALL__',cartOnly:false,searching:false,later:false,sending:false};
    var opener=document.activeElement;
    var pick=window.__pick||{};
    var pickTop=pick.top||function(){return [];};
    var sortItems=pick.sortItems||function(items){return items||[];};
    function findItem(id){for(var i=0;i<menu.length;i++){var its=menu[i].items||[];for(var j=0;j<its.length;j++){if(its[j].id===id)return its[j];}}return null;}

    var ov=el('div','ov dpage'), sh=el('div','sheet dfull');
    sh.setAttribute('role','dialog');sh.setAttribute('aria-modal','true');sh.setAttribute('aria-label','Nouvelle livraison');
    var previous=document.body.style.overflow;document.body.style.overflow='hidden';
    // iOS keyboard: pin the overlay to the visual viewport so the list + footer stay reachable.
    function fitViewport(){
      var vv=window.visualViewport;
      if(vv){ov.style.height=Math.round(vv.height)+'px';ov.style.top=Math.round(vv.offsetTop)+'px';ov.style.bottom='auto';sh.style.height='100%';}
      else{ov.style.height='';ov.style.top='';ov.style.bottom='';sh.style.height='';}
    }
    function close(){
      clearTimeout(searchTimer);clientReq++;
      if(window.visualViewport){window.visualViewport.removeEventListener('resize',fitViewport);window.visualViewport.removeEventListener('scroll',fitViewport);}
      window.removeEventListener('resize',fitViewport);
      if(ov.parentNode)ov.parentNode.removeChild(ov);
      document.body.style.overflow=previous;
      if(opener&&opener.focus){try{opener.focus();}catch(_){}}
    }
    // Verb-labelled confirm (local: the pages' askConfirm lives in their own IIFE).
    function askConfirm(question,yesLabel,noLabel,onYes){
      var cov=el('div','ov center');var box=el('div','cfm');
      box.setAttribute('role','alertdialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label',question);
      box.appendChild(el('p',null,question));
      var acts=el('div','cfmacts');
      var yes=el('button','danger',yesLabel);yes.type='button';
      var no=el('button',null,noLabel);no.type='button';
      function done(){if(cov.parentNode)cov.parentNode.removeChild(cov);}
      yes.onclick=function(){done();onYes();};no.onclick=done;
      cov.onclick=function(e){if(e.target===cov)done();};
      acts.appendChild(yes);acts.appendChild(no);box.appendChild(acts);cov.appendChild(box);
      document.body.appendChild(cov);try{no.focus();}catch(_){}
    }
    function dirty(){
      if(cartCount()>0)return true;
      return !!(clientName.value.trim()||clientPhone.value.trim()||address.value.trim());
    }
    function requestClose(){
      if(state.sending)return;   // the POST may already have created the order — never "abandon" mid-flight
      if(dirty()){askConfirm('Abandonner cette livraison ?','Oui, abandonner','Non, continuer',close);return;}
      close();
    }

    // ── Header: × (step 1) / ← back (step 2) + step indicator ──
    var head=el('div','dhead');
    var back=el('button','dback','×');back.type='button';back.setAttribute('aria-label','Fermer');
    back.onclick=function(){if(state.sending)return;if(state.step===2)setStep(1);else requestClose();};
    var stepdot=el('span','dstepdot','1/2');
    head.appendChild(back);head.appendChild(el('h2',null,'🛵 Nouvelle livraison'));head.appendChild(stepdot);
    sh.appendChild(head);
    var msg=el('p','msg');msg.hidden=true;msg.setAttribute('role','alert');sh.appendChild(msg);
    function setError(t){msg.textContent=t;msg.hidden=false;}

    // ── Step 1 · items (same pattern as the salle composer) ──
    var step1=el('div','dstep');
    var searchSummary=el('div','search-summary');
    searchSummary.appendChild(el('span',null,'🛵 Livraison'));
    var searchCart=el('button','chip cart','Panier (0)');searchCart.type='button';
    searchSummary.appendChild(searchCart);step1.appendChild(searchSummary);
    var toolbar=el('div','toolbar');var searchbar=el('div','searchbar');
    var search=el('input','search');search.placeholder='🔍 Rechercher un article…';
    search.setAttribute('inputmode','search');search.setAttribute('enterkeyhint','search');
    search.setAttribute('autocomplete','off');search.setAttribute('aria-label','Rechercher un article');
    var clearSearch=el('button','searchctl','×');clearSearch.type='button';clearSearch.setAttribute('aria-label','Effacer la recherche');
    var doneSearch=el('button','searchctl','Terminé');doneSearch.type='button';
    function enterSearch(){if(state.cartOnly)state.cartOnly=false;state.searching=true;sh.classList.add('searching');renderList();fitViewport();}
    function finishSearch(){state.searching=false;sh.classList.remove('searching');try{search.blur();}catch(_){}renderList();fitViewport();}
    search.onfocus=enterSearch;
    search.oninput=function(){state.q=search.value;state.cartOnly=false;renderList();};
    clearSearch.onpointerdown=function(e){e.preventDefault();};
    clearSearch.onclick=function(){state.q='';search.value='';renderList();try{search.focus();}catch(_){}};
    doneSearch.onclick=finishSearch;
    searchbar.appendChild(search);searchbar.appendChild(clearSearch);searchbar.appendChild(doneSearch);
    var cartChip=el('button','chip cart','Panier (0)');cartChip.type='button';
    searchbar.appendChild(cartChip);toolbar.appendChild(searchbar);
    var chips=el('div','chips');
    function setCat(c){state.cat=c;renderList();}
    var chipAll=el('button','chip','Tout');chipAll.type='button';chipAll.onclick=function(){setCat('__ALL__');};chips.appendChild(chipAll);
    var catChips={};
    menu.forEach(function(cat){var ch=el('button','chip',cat.category);ch.type='button';ch.onclick=(function(name){return function(){setCat(name);};})(cat.category);catChips[cat.category]=ch;chips.appendChild(ch);});
    function showCart(){state.cartOnly=true;state.q='';search.value='';finishSearch();}
    cartChip.onclick=function(){if(state.cartOnly){state.cartOnly=false;renderList();}else showCart();};
    searchCart.onclick=showCart;
    var browsebar=el('div','browsebar');browsebar.appendChild(chips);toolbar.appendChild(browsebar);
    step1.appendChild(toolbar);
    var listEl=el('div','list');step1.appendChild(listEl);
    sh.appendChild(step1);

    function cartCount(){var n=0;Object.keys(cart).forEach(function(id){if(cart[id].qty>0)n+=cart[id].qty;});return n;}
    function cartLines(){var n=0;Object.keys(cart).forEach(function(id){if(cart[id].qty>0)n++;});return n;}
    function cartTotal(){var t=0;Object.keys(cart).forEach(function(id){var it=findItem(id);if(it&&cart[id].qty>0)t+=Number(it.price||0)*cart[id].qty;});return t;}

    function itemRow(it){
      var groups=it.optionGroups||[];
      var needsChoice=groups.length>0;
      var d=cart[it.id]||{qty:0,choices:[]};
      var row=el('div','mi'+(d.qty>0?' on':''));row.dataset.id=it.id;
      var nm=el('div','nm');nm.appendChild(el('span',null,it.name));
      nm.appendChild(el('span','pr',money(it.price)));row.appendChild(nm);
      var stp=el('div','stepper');
      var minus=el('button',null,'−'),qv=el('span','qv',String(d.qty)),plus=el('button','plus','＋');
      minus.type=plus.type='button';
      var extra=el('div','wrap');
      var creqs=[];
      function ensure(){if(!cart[it.id])cart[it.id]={qty:0,choices:[]};return cart[it.id];}
      function markChoices(){var dd=cart[it.id]||{qty:0,choices:[]};var anyMissing=false;
        creqs.forEach(function(c){var miss=dd.qty>0&&!dd.choices[c.idx];c.box.classList.toggle('missing',miss);if(miss)anyMissing=true;});
        row.classList.toggle('needchoice',anyMissing);}
      // In-place sync: qty badge / highlight / missing-choice state update without
      // rebuilding the list, so the scroll position survives every +/− tap.
      function sync(){var dd=cart[it.id]||{qty:0,choices:[]};qv.textContent=dd.qty;
        extra.style.display=(dd.qty>0&&(!state.searching||needsChoice||state.cartOnly))?'block':'none';
        row.classList.toggle('on',dd.qty>0);
        var old=nm.querySelector('.qbadge');if(old)nm.removeChild(old);
        if(dd.qty>0)nm.insertBefore(el('span','qbadge','×'+dd.qty),nm.querySelector('.pr'));
        markChoices();recompute();}
      minus.onpointerdown=function(e){if(state.searching)e.preventDefault();};
      plus.onpointerdown=function(e){if(state.searching&&!needsChoice)e.preventDefault();};
      minus.onclick=function(){var dd=ensure();dd.qty=Math.max(0,dd.qty-1);sync();if(state.cartOnly&&dd.qty===0)renderList();};
      plus.onclick=function(){var dd=ensure();var wasEmpty=dd.qty===0;dd.qty=Math.min(MAX_QTY,dd.qty+1);sync();
        if(state.searching){state.q='';search.value='';
          if(needsChoice&&wasEmpty){renderList();try{search.blur();}catch(_){}
            setTimeout(function(){var fresh=listEl.querySelector('[data-id="'+it.id+'"]');if(fresh&&fresh.scrollIntoView)fresh.scrollIntoView({block:'center'});},50);}
          else finishSearch();
        }};
      stp.appendChild(minus);stp.appendChild(qv);stp.appendChild(plus);row.appendChild(stp);
      groups.forEach(function(g,idx){
        var creq=el('div','creq');var optionName=g.label||'Choix';
        var choiceLabel=el('button','clab');choiceLabel.type='button';creq.appendChild(choiceLabel);
        var pills=el('div','cpills');
        function paintChoice(){var dd=cart[it.id]||d;var picked=(dd.choices||[])[idx]||'';
          creq.classList.toggle('collapsed',!!picked);
          choiceLabel.textContent=picked?optionName+' · '+picked+' ✓ — modifier':optionName+' · obligatoire';
          choiceLabel.setAttribute('aria-expanded',picked?'false':'true');}
        choiceLabel.onclick=function(){var dd=cart[it.id]||d;if(!((dd.choices||[])[idx]))return;
          var folded=creq.classList.toggle('collapsed');choiceLabel.setAttribute('aria-expanded',folded?'false':'true');
          if(!folded&&creq.scrollIntoView)creq.scrollIntoView({block:'center'});};
        (g.choices||[]).forEach(function(ch){
          var p=el('button','cpill'+((((d.choices||[])[idx])===ch)?' sel':''),ch);p.type='button';
          p.onclick=function(){var dd=ensure();dd.choices[idx]=ch;
            Array.prototype.forEach.call(pills.children,function(c){c.classList.remove('sel');});
            p.classList.add('sel');paintChoice();markChoices();};
          pills.appendChild(p);});
        creq.appendChild(pills);extra.appendChild(creq);creqs.push({idx:idx,box:creq});paintChoice();
      });
      row.appendChild(extra);sync();
      return row;
    }
    function section(label,items){if(!items.length)return;listEl.appendChild(el('div','cat',label));
      items.forEach(function(it){listEl.appendChild(itemRow(it));});}
    function renderList(){
      chipAll.classList.toggle('sel',state.cat==='__ALL__'&&!state.q&&!state.cartOnly);
      Object.keys(catChips).forEach(function(k){catChips[k].classList.toggle('sel',state.cat===k&&!state.q&&!state.cartOnly);});
      cartChip.classList.toggle('sel',state.cartOnly);
      listEl.textContent='';
      if(!menu.length){listEl.appendChild(el('div','nores','Menu indisponible.'));return;}
      var q=normal(state.q);var any=false;
      var isDefault=!q&&!state.cartOnly&&state.cat==='__ALL__';var popIds={};
      if(isDefault){
        var pop=pickTop(menu,topIds,8);pop.forEach(function(it){popIds[it.id]=1;});
        if(pop.length){section('🔥 Populaires',pop);any=true;}
      }
      menu.forEach(function(cat){
        var items=(cat.items||[]).filter(function(it){
          if(state.cartOnly)return !!(cart[it.id]&&cart[it.id].qty>0);
          if(q)return normal(it.name).indexOf(q)>=0;
          if(state.cat!=='__ALL__')return cat.category===state.cat;
          return !popIds[it.id];
        });
        if(!items.length)return;
        section(cat.category,sortItems(items));any=true;
      });
      if(!any)listEl.appendChild(el('div','nores',state.cartOnly?'Panier vide — ajoutez des articles.':'Aucun article trouvé.'));
      recompute();
    }

    // ── Step 2 · client & delivery details ──
    var step2=el('div','dstep');step2.hidden=true;
    var step2list=el('div','list');step2.appendChild(step2list);sh.appendChild(step2);
    var recap=el('div','dcart-recap');var recapTxt=el('span');recap.appendChild(recapTxt);
    var recapEdit=el('button',null,'Modifier');recapEdit.type='button';
    recapEdit.onclick=function(){if(state.sending)return;setStep(1);};
    recap.appendChild(recapEdit);step2list.appendChild(recap);
    function paintRecap(){var n=cartCount();recapTxt.textContent=n+' article'+(n>1?'s':'')+' · '+money(cartTotal());}
    function field(parent,label,type,name,placeholder){
      var w=el('label','field');w.appendChild(document.createTextNode(label));
      var i=document.createElement(type==='textarea'?'textarea':'input');
      if(type!=='textarea')i.type=type||'text';
      i.name=name;if(placeholder)i.placeholder=placeholder;i.autocomplete='off';
      w.appendChild(i);parent.appendChild(w);return i;}
    var clientSearch=field(step2list,'Rechercher une cliente','search','delivery-client-search','Nom ou téléphone');
    var results=el('div','client-results');step2list.appendChild(results);
    var clientName=field(step2list,'Nom de la cliente *','text','client_name','Fatou Sarr');
    var clientPhone=field(step2list,'Téléphone *','tel','client_phone','77 000 00 00');
    var address=field(step2list,'Adresse *','text','address','Adresse de livraison');
    function useClient(c){clientName.value=c.name||c.client_name||'';clientPhone.value=c.phone||c.client_phone||'';address.value=c.address||'';results.textContent='';}
    function paintClients(rows){results.textContent='';rows.slice(0,6).forEach(function(c){
      var b=el('button',null,(c.name||c.client_name||'Cliente')+' · '+(c.phone||c.client_phone||''));b.type='button';
      b.onclick=function(){useClient(c);};results.appendChild(b);});}
    paintClients(recent);
    clientSearch.oninput=function(){var q=clientSearch.value.trim();clearTimeout(searchTimer);
      if(q.length<2){clientReq++;paintClients(recent.filter(function(c){return normal((c.name||c.client_name||'')+' '+(c.phone||c.client_phone||'')).indexOf(normal(q))>=0;}));return;}
      searchTimer=setTimeout(function(){var seq=++clientReq;
        fetch(base+'/delivery-clients?q='+encodeURIComponent(q),{headers:{'X-Requested-With':'fetch'}})
          .then(function(r){return r.ok?r.json():null;})
          .then(function(d){if(seq!==clientReq)return;paintClients((d&&d.clients)||[]);})
          .catch(function(){});},220);};
    var modeseg=el('div','modeseg');
    var mNow=el('button','mode sel');mNow.type='button';mNow.textContent='⚡ Maintenant';mNow.setAttribute('aria-pressed','true');
    var mLater=el('button','mode');mLater.type='button';mLater.textContent='⏰ Programmée';mLater.setAttribute('aria-pressed','false');
    var schedWrap=el('div');schedWrap.hidden=true;
    var scheduled=field(schedWrap,'Arrivée souhaitée *','datetime-local','scheduled_for');
    var lead=field(schedWrap,'Délai cuisine (minutes)','number','kitchen_lead_minutes');lead.min='60';lead.max='720';lead.value='120';
    function paintDeliveryMode(){
      mNow.classList.toggle('sel',!state.later);mLater.classList.toggle('sel',state.later);
      mNow.setAttribute('aria-pressed',state.later?'false':'true');mLater.setAttribute('aria-pressed',state.later?'true':'false');
      schedWrap.hidden=!state.later;if(!state.later)scheduled.value='';}
    mNow.onclick=function(){state.later=false;paintDeliveryMode();};
    mLater.onclick=function(){state.later=true;paintDeliveryMode();};
    modeseg.appendChild(mNow);modeseg.appendChild(mLater);
    step2list.appendChild(modeseg);step2list.appendChild(schedWrap);
    var details=el('details','optional');details.appendChild(el('summary',null,'Détails optionnels'));
    var optWrap=el('div','optional-fields');
    var recipientName=field(optWrap,'Contact de remise','text','recipient_name');
    var recipientPhone=field(optWrap,'Téléphone du contact','tel','recipient_phone');
    var note=field(optWrap,'Note','textarea','note');
    var testWrap=el('label','check');var test=document.createElement('input');test.type='checkbox';
    testWrap.appendChild(test);testWrap.appendChild(document.createTextNode(' 🧪 Commande de test'));
    optWrap.appendChild(testWrap);details.appendChild(optWrap);step2list.appendChild(details);
    function fieldByName(name){
      return {client_name:clientName,client_phone:clientPhone,address:address,
        recipient_name:recipientName,recipient_phone:recipientPhone,note:note,
        scheduled_for:scheduled,kitchen_lead_minutes:lead}[name]||null;}

    // ── Persistent footer (both steps): total + primary action ──
    var foot=el('div','foot');var totalEl=el('div','total');
    var go=el('button','go','Ajouter des articles');go.type='button';
    foot.appendChild(totalEl);foot.appendChild(go);sh.appendChild(foot);
    function recompute(){
      if(!totalEl)return;
      var n=cartCount();
      totalEl.textContent='';
      totalEl.appendChild(document.createTextNode(n+' article'+(n>1?'s':'')+' · '+money(cartTotal())));
      cartChip.textContent='Panier ('+n+')';searchCart.textContent='Panier ('+n+')';
      cartChip.classList.toggle('sel',state.cartOnly);searchCart.classList.toggle('sel',state.cartOnly);
      paintRecap();
      if(state.sending)return;
      if(state.step===1){go.textContent=n?'Continuer':'Ajouter des articles';go.disabled=!n;}
      else{go.textContent='Envoyer la commande';go.disabled=false;}
    }
    function setStep(s){
      if(state.sending)return;
      state.step=s;
      if(s===2)finishSearch();      // never carry .searching into the details step
      else{var ae=document.activeElement;if(ae&&ae!==document.body&&ae.blur){try{ae.blur();}catch(_){}}}
      step1.hidden=s!==1;step2.hidden=s!==2;
      back.textContent=s===2?'←':'×';
      back.setAttribute('aria-label',s===2?'Retour aux articles':'Fermer');
      stepdot.textContent=s+'/2';
      msg.hidden=true;
      try{(s===2?step2list:listEl).scrollTop=0;}catch(_){}
      fitViewport();recompute();
    }

    function payload(){
      var items=[];menu.forEach(function(g){(g.items||[]).forEach(function(item){var c=cart[item.id];if(c&&c.qty)items.push(selectedLine(item,c.qty,c.choices));});});
      var sched=state.later&&scheduled.value?scheduled.value:null;
      return {client_name:clientName.value.trim(),client_phone:clientPhone.value.trim(),address:address.value.trim(),
        recipient_name:recipientName.value,recipient_phone:recipientPhone.value,note:note.value,
        delivery_mode:sched?'scheduled':'now',scheduled_for:sched,kitchen_lead_minutes:sched?lead.value:null,
        is_test:test.checked,client_request_id:requestId,items:items};
    }
    function sendUnlock(){state.sending=false;go.disabled=false;back.disabled=false;recapEdit.disabled=false;recompute();}
    function submit(){
      var missing=!clientName.value.trim()?clientName:!clientPhone.value.trim()?clientPhone:!address.value.trim()?address:
        (state.later&&!scheduled.value)?scheduled:null;
      if(missing){
        setError(missing===scheduled?'Indiquez la date et l’heure d’arrivée.':'Remplissez les champs obligatoires (nom, téléphone, adresse).');
        try{missing.focus();}catch(_){}if(missing.scrollIntoView)missing.scrollIntoView({block:'center'});return;}
      state.sending=true;go.disabled=true;go.textContent='Envoi…';msg.hidden=true;
      back.disabled=true;recapEdit.disabled=true;
      opt.post('/deliveries',payload())
        .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {r:r,j:j};});})
        .then(function(x){
          if(!x.r.ok||!x.j.ok){
            sendUnlock();setError(x.j.message||'Impossible d’envoyer la livraison.');
            var f=x.j.field&&fieldByName(x.j.field);
            if(f){if(f===recipientName||f===recipientPhone||f===note)details.open=true;
              try{f.focus();}catch(_){}if(f.scrollIntoView)f.scrollIntoView({block:'center'});}
            return;}
          close();if(opt.onDone)opt.onDone(x.j);
        })
        .catch(function(){sendUnlock();setError('Erreur réseau — réessaie.');});
    }
    go.onclick=function(){
      if(state.sending)return;
      if(state.step===2){submit();return;}
      var n=cartCount();
      if(!n){setError('Ajoutez au moins un article.');return;}
      if(cartLines()>MAX_LINES){setError('Maximum '+MAX_LINES+' articles différents par commande.');return;}
      var miss=null;
      Object.keys(cart).forEach(function(id){var c=cart[id];if(c.qty<1||miss)return;var it=findItem(id);
        ((it&&it.optionGroups)||[]).forEach(function(g,idx){if(!miss&&!c.choices[idx])miss={item:it,group:g};});});
      if(miss){
        setError('Choisissez « '+(miss.group.label||'Choix')+' » pour '+miss.item.name+'.');
        state.cartOnly=true;state.q='';search.value='';finishSearch();
        var r=listEl.querySelector('[data-id="'+miss.item.id+'"]');
        if(r&&r.scrollIntoView)r.scrollIntoView({block:'center'});return;}
      setStep(2);
    };

    ov.appendChild(sh);document.body.appendChild(ov);
    if(window.visualViewport){window.visualViewport.addEventListener('resize',fitViewport);window.visualViewport.addEventListener('scroll',fitViewport);}
    window.addEventListener('resize',fitViewport);
    fitViewport();paintDeliveryMode();renderList();recompute();
  }
  window.__deliveryComposer={open:open};
})();`;
