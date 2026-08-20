/**
 * Shared delivery composer for reception and owner.  It deliberately receives
 * its data and transport as arguments so neither PWA can grow a second copy of
 * delivery validation/pricing rules: the API remains authoritative.
 */
export const OPS_DELIVERY_COMPOSER = String.raw`
;(function(){
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
  function uid(){try{return crypto.randomUUID();}catch(_){return 'delivery-'+Date.now()+'-'+Math.round(Math.random()*1e9);}}
  function money(n){return Number(n||0).toLocaleString('fr-FR')+' F';}
  function normal(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');}
  function selectedLine(item,qty,choices){var selections=[];for(var i=0;i<choices.length;i++){if(choices[i])selections.push({group_index:i,value:choices[i]});}return {item_id:item.id,qty:qty,selections:selections};}
  function open(opt){
    var menu=opt.menu||[], recent=opt.recent||[], cart={}, requestId=uid(), searchTimer=0;
    var ov=el('div','ov'), sheet=el('div','sheet delivery-sheet');
    sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label','Nouvelle livraison');
    var previous=document.body.style.overflow;document.body.style.overflow='hidden';
    function close(){if(ov.parentNode)ov.parentNode.removeChild(ov);document.body.style.overflow=previous;}
    ov.onclick=function(e){if(e.target===ov)close();};
    var x=el('button','close-x','×');x.setAttribute('aria-label','Fermer');x.onclick=close;sheet.appendChild(x);
    sheet.appendChild(el('h2',null,'🛵 Nouvelle livraison'));
    var msg=el('p','msg');msg.hidden=true;sheet.appendChild(msg);
    function field(label,type,name,placeholder){var w=el('label','field');w.textContent=label;var i=document.createElement('input');i.type=type||'text';i.name=name;i.placeholder=placeholder||'';i.autocomplete='off';w.appendChild(i);sheet.appendChild(w);return i;}
    var clientSearch=field('Rechercher une cliente','search','delivery-client-search','Nom ou téléphone');
    var clientName=field('Nom de la cliente *','text','client_name','Fatou Sarr');
    var clientPhone=field('Téléphone *','tel','client_phone','77 000 00 00');
    var address=field('Adresse *','text','address','Adresse de livraison');
    var results=el('div','client-results');sheet.appendChild(results);
    function useClient(c){clientName.value=c.name||c.client_name||'';clientPhone.value=c.phone||c.client_phone||'';address.value=c.address||'';results.textContent='';}
    function paintClients(rows){results.textContent='';rows.slice(0,6).forEach(function(c){var b=el('button','sec',((c.name||c.client_name||'Cliente')+' · '+(c.phone||c.client_phone||'')));b.type='button';b.onclick=function(){useClient(c);};results.appendChild(b);});}
    paintClients(recent);
    clientSearch.oninput=function(){var q=clientSearch.value.trim();clearTimeout(searchTimer);if(q.length<2){paintClients(recent.filter(function(c){return normal((c.name||c.client_name||'')+' '+(c.phone||c.client_phone||'')).indexOf(normal(q))>=0;}));return;}searchTimer=setTimeout(function(){fetch(opt.base+'/delivery-clients?q='+encodeURIComponent(q),{headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.json():null;}).then(function(d){paintClients((d&&d.clients)||[]);}).catch(function(){});},220);};
    var details=el('details','optional');var summary=el('summary',null,'Détails optionnels');details.appendChild(summary);
    function detailField(label,type,name){var w=el('label','field');w.textContent=label;var i=document.createElement(type==='textarea'?'textarea':'input');if(type!=='textarea')i.type=type||'text';i.name=name;w.appendChild(i);details.appendChild(w);return i;}
    var recipientName=detailField('Contact de remise','text','recipient_name');var recipientPhone=detailField('Téléphone du contact','tel','recipient_phone');var note=detailField('Note','textarea','note');
    var scheduled=detailField('Livraison programmée','datetime-local','scheduled_for');var lead=detailField('Délai cuisine (minutes)','number','kitchen_lead_minutes');lead.min='60';lead.max='720';lead.value='120';
    var testWrap=el('label','check');var test=document.createElement('input');test.type='checkbox';testWrap.appendChild(test);testWrap.appendChild(document.createTextNode(' 🧪 Commande de test'));details.appendChild(testWrap);sheet.appendChild(details);
    sheet.appendChild(el('h3',null,'Articles'));
    var list=el('div','delivery-menu');sheet.appendChild(list);
    function ensure(item){if(!cart[item.id])cart[item.id]={qty:0,choices:[]};return cart[item.id];}
    function paintMenu(){list.textContent='';menu.forEach(function(group){var h=el('h4','cat',group.category||'');list.appendChild(h);var rows=window.__pick&&window.__pick.sortItems?window.__pick.sortItems(group.items||[]):(group.items||[]);rows.forEach(function(item){var row=el('div','mi');var line=el('div','line');line.appendChild(el('span','nm',item.name));line.appendChild(el('span','pr',money(item.price)));var step=el('div','stepper');var minus=el('button',null,'−'), q=el('span','qty',String((cart[item.id]||{}).qty||0)), plus=el('button',null,'＋');minus.type=plus.type='button';minus.onclick=function(){var v=ensure(item);v.qty=Math.max(0,v.qty-1);paintMenu();paintTotal();};plus.onclick=function(){var v=ensure(item);v.qty++;paintMenu();paintTotal();};step.appendChild(minus);step.appendChild(q);step.appendChild(plus);line.appendChild(step);row.appendChild(line);var groups=item.optionGroups||[];groups.forEach(function(g,idx){var c=ensure(item);var choice=c.choices[idx];var wrap=el('div','creq'+(c.qty&&!choice?' missing':''));wrap.appendChild(el('div','clab',(g.label||'Choix')+' *'));var pills=el('div','cpills');(g.choices||[]).forEach(function(v){var b=el('button','cpill'+(choice===v?' sel':''),v);b.type='button';b.onclick=function(){ensure(item).choices[idx]=v;paintMenu();};pills.appendChild(b);});wrap.appendChild(pills);row.appendChild(wrap);});list.appendChild(row);});});}
    var foot=el('div','foot'), total=el('div','total'), send=el('button','go','Envoyer la commande');send.type='button';foot.appendChild(total);foot.appendChild(send);sheet.appendChild(foot);
    function payload(){var items=[];menu.forEach(function(g){(g.items||[]).forEach(function(item){var c=cart[item.id];if(c&&c.qty)items.push(selectedLine(item,c.qty,c.choices));});});return {client_name:clientName.value,client_phone:clientPhone.value,address:address.value,recipient_name:recipientName.value,recipient_phone:recipientPhone.value,note:note.value,delivery_mode:scheduled.value?'scheduled':'now',scheduled_for:scheduled.value||null,kitchen_lead_minutes:scheduled.value?lead.value:null,is_test:test.checked,client_request_id:requestId,items:items};}
    function paintTotal(){var n=0;menu.forEach(function(g){(g.items||[]).forEach(function(i){n+=(((cart[i.id]||{}).qty||0)*Number(i.price||0));});});total.textContent=money(n);}
    send.onclick=function(){var p=payload();send.disabled=true;msg.hidden=true;opt.post('/deliveries',p).then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {r:r,j:j};});}).then(function(x){if(!x.r.ok||!x.j.ok){msg.textContent=x.j.message||'Impossible d’envoyer la livraison.';msg.hidden=false;send.disabled=false;return;}close();if(opt.onDone)opt.onDone(x.j);}).catch(function(){msg.textContent='Erreur réseau — réessaie.';msg.hidden=false;send.disabled=false;});};
    paintMenu();paintTotal();ov.appendChild(sheet);document.body.appendChild(ov);try{clientSearch.focus();}catch(_){}
  }
  window.__deliveryComposer={open:open};
})();`;
