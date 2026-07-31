/** Progressive enhancement shared by every authenticated admin page. */
export const ADMIN_CLIENT_JS = `
(function(){
  var body=document.body;
  var sidebar=document.getElementById('admin-sidebar');
  var menu=document.getElementById('nav-toggle');
  var collapse=document.getElementById('nav-collapse');
  var scrim=document.getElementById('nav-scrim');
  var search=document.getElementById('global-client-search');
  var searchForm=document.querySelector('[data-global-search-form]');
  var searchPanel=document.querySelector('[data-global-search-panel]');
  var lastFocus=null;

  function desktop(){return window.matchMedia('(min-width:901px)').matches;}
  function focusables(){return sidebar?Array.from(sidebar.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')):[];}
  function setMobile(open){
    if(!menu||!sidebar)return;
    body.classList.toggle('mobile-nav-open',open);
    menu.setAttribute('aria-expanded',open?'true':'false');
    sidebar.setAttribute('aria-hidden',open?'false':'true');
    sidebar.toggleAttribute('inert',!open);
    if(open){lastFocus=document.activeElement;var f=focusables();if(f[0])f[0].focus();}
    else if(lastFocus&&lastFocus.focus)lastFocus.focus();
  }
  function syncNav(){
    if(!sidebar)return;
    if(desktop()){
      body.classList.remove('mobile-nav-open');
      sidebar.removeAttribute('aria-hidden');
      sidebar.removeAttribute('inert');
      if(menu)menu.setAttribute('aria-expanded','false');
    }else{
      var open=body.classList.contains('mobile-nav-open');
      sidebar.setAttribute('aria-hidden',open?'false':'true');
      sidebar.toggleAttribute('inert',!open);
    }
  }
  try{if(localStorage.getItem('awa-admin-nav')==='collapsed')body.classList.add('nav-collapsed');}catch(e){}
  if(collapse)collapse.setAttribute('aria-expanded',body.classList.contains('nav-collapsed')?'false':'true');
  if(collapse)collapse.addEventListener('click',function(){
    body.classList.toggle('nav-collapsed');
    collapse.setAttribute('aria-expanded',body.classList.contains('nav-collapsed')?'false':'true');
    try{localStorage.setItem('awa-admin-nav',body.classList.contains('nav-collapsed')?'collapsed':'open');}catch(e){}
  });
  if(menu)menu.addEventListener('click',function(){setMobile(!body.classList.contains('mobile-nav-open'));});
  if(scrim)scrim.addEventListener('click',function(){setMobile(false);});
  if(sidebar)sidebar.querySelectorAll('a[href]').forEach(function(a){a.addEventListener('click',function(){if(!desktop())setMobile(false);});});
  window.addEventListener('resize',syncNav);syncNav();

  document.querySelectorAll('[data-studio-activity]').forEach(function(activity){
    var periodLabels={today:'Aujourd’hui',week:'7 derniers jours',month:'30 derniers jours'};
    var periodCopies={today:'Résultats d’aujourd’hui',week:'Résultats des 7 derniers jours',month:'Résultats des 30 derniers jours'};
    var buttons=Array.from(activity.querySelectorAll('[data-activity-period]'));
    var copy=activity.querySelector('[data-activity-period-copy]');
    function selectPeriod(period){
      buttons.forEach(function(button){
        var selected=button.getAttribute('data-activity-period')===period;
        button.classList.toggle('active',selected);
        button.setAttribute('aria-pressed',selected?'true':'false');
      });
      activity.querySelectorAll('[data-stat-value]').forEach(function(value){
        value.textContent=value.getAttribute('data-'+period)||'—';
      });
      activity.querySelectorAll('[data-stat-caption]').forEach(function(caption){
        caption.textContent=periodLabels[period]||'';
      });
      activity.querySelectorAll('[data-stat-link]').forEach(function(link){
        var base=link.getAttribute('data-href-base')||'';
        var value=period==='today'?'today':period==='month'?'30':'7';
        link.setAttribute('href',base+'?period='+value);
      });
      if(copy)copy.textContent=periodCopies[period]||'';
    }
    buttons.forEach(function(button){
      button.addEventListener('click',function(){selectPeriod(button.getAttribute('data-activity-period')||'week');});
    });
  });

  var globalTimer=null,globalRunning=false,globalQueued=null,globalDesired='',globalSequence=0,globalActive=-1;
  function globalSearchReady(value){
    var folded=String(value||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
    var letters=(folded.match(/[a-z]/gi)||[]).length;
    var digits=(folded.match(/[0-9]/g)||[]).length;
    return letters?letters+digits>=2:digits>=4;
  }
  function openGlobalSearch(){
    if(!search||!searchPanel)return;
    searchPanel.hidden=false;search.setAttribute('aria-expanded','true');
  }
  function closeGlobalSearch(){
    if(!search||!searchPanel)return;
    searchPanel.hidden=true;search.setAttribute('aria-expanded','false');search.removeAttribute('aria-activedescendant');globalActive=-1;
  }
  function globalMessage(message,className){
    if(!searchPanel)return;searchPanel.replaceChildren();
    var row=document.createElement('div');row.className=className||'global-search-message';row.textContent=message;searchPanel.appendChild(row);openGlobalSearch();
  }
  function globalOptions(){return searchPanel?Array.from(searchPanel.querySelectorAll('[role="option"]')):[]}
  function selectGlobalOption(index){
    var options=globalOptions();if(!options.length){globalActive=-1;return}
    globalActive=(index+options.length)%options.length;
    options.forEach(function(option,i){var active=i===globalActive;option.setAttribute('aria-selected',active?'true':'false');option.classList.toggle('active',active)});
    search.setAttribute('aria-activedescendant',options[globalActive].id);options[globalActive].scrollIntoView({block:'nearest'});
  }
  function globalDate(value){
    if(!value)return '';
    try{return new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'short'}).format(new Date(value))}catch(e){return ''}
  }
  function renderGlobalSuggestions(data,requested){
    if(!searchPanel||!search||search.value.trim()!==globalDesired||data.query!==requested)return;
    searchPanel.replaceChildren();globalActive=-1;search.removeAttribute('aria-activedescendant');
    var labels={client:'Client',awa:'Awa',team:'Équipe'};
    if(!Array.isArray(data.items)||!data.items.length){globalMessage('Aucune conversation trouvée.');return}
    data.items.forEach(function(item,index){
      var link=document.createElement('a');link.href=item.href;link.id='global-search-option-'+index;link.className='global-search-option';link.setAttribute('role','option');link.setAttribute('aria-selected','false');
      var heading=document.createElement('span');heading.className='global-search-option-heading';
      var name=document.createElement('b');name.textContent=item.name||'(sans nom)';
      var phone=document.createElement('span');phone.textContent='+'+item.phone;heading.append(name,phone);link.appendChild(heading);
      if(item.preview){var preview=document.createElement('span');preview.className='global-search-option-preview';preview.textContent=item.preview;link.appendChild(preview)}
      var meta=document.createElement('span');meta.className='global-search-option-meta';var date=globalDate(item.matchedAt);meta.textContent=(labels[item.source]||'Conversation')+(date?' · '+date:'');link.appendChild(meta);
      searchPanel.appendChild(link);
    });
    if(Number(data.total)>data.items.length){
      var all=document.createElement('a');all.className='global-search-all';all.href='/admin/conversations?q='+encodeURIComponent(requested);all.textContent='Voir les '+data.total+' résultats';searchPanel.appendChild(all);
    }
    openGlobalSearch();
  }
  function runGlobalSearch(){
    if(globalRunning||!globalQueued)return;
    var requested=globalQueued;globalQueued=null;globalRunning=true;var requestSequence=++globalSequence;
    globalMessage('Recherche…','global-search-message global-search-loading');
    fetch('/admin/conversations/suggestions?q='+encodeURIComponent(requested),{headers:{Accept:'application/json'},credentials:'same-origin'})
      .then(function(response){if(!response.ok)throw new Error('search_failed');return response.json()})
      .then(function(data){if(requestSequence===globalSequence&&requested===globalDesired)renderGlobalSuggestions(data,requested)})
      .catch(function(){if(requestSequence===globalSequence&&requested===globalDesired)globalMessage('Recherche indisponible — appuyez sur Entrée pour ouvrir la page complète.','global-search-message global-search-error')})
      .finally(function(){
        globalRunning=false;
        if(globalQueued&&globalQueued!==requested)runGlobalSearch();else if(globalQueued===requested)globalQueued=null;
      });
  }
  function scheduleGlobalSearch(immediate){
    if(!search)return;clearTimeout(globalTimer);var value=search.value.trim();globalDesired=value;globalActive=-1;
    if(!globalSearchReady(value)){globalQueued=null;globalMessage(value?'Saisissez 2 caractères, ou 4 chiffres pour un numéro.':'Saisissez un nom, un numéro ou des mots-clés.');return}
    globalTimer=setTimeout(function(){globalQueued=value;runGlobalSearch()},immediate?0:350);
  }
  if(search){
    search.addEventListener('focus',function(){openGlobalSearch();scheduleGlobalSearch(false)});
    search.addEventListener('input',function(){scheduleGlobalSearch(false)});
    search.addEventListener('keydown',function(event){
      if(event.key==='ArrowDown'){event.preventDefault();openGlobalSearch();selectGlobalOption(globalActive+1)}
      else if(event.key==='ArrowUp'){event.preventDefault();openGlobalSearch();selectGlobalOption(globalActive-1)}
      else if(event.key==='Escape'){event.preventDefault();closeGlobalSearch()}
      else if(event.key==='Enter'&&globalActive>=0){var option=globalOptions()[globalActive];if(option){event.preventDefault();location.href=option.href}}
    });
  }
  if(searchForm)searchForm.addEventListener('submit',function(event){
    if(globalActive>=0){var option=globalOptions()[globalActive];if(option){event.preventDefault();location.href=option.href}}
  });
  document.addEventListener('click',function(event){if(searchForm&&!searchForm.contains(event.target))closeGlobalSearch()});

  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&body.classList.contains('mobile-nav-open')){e.preventDefault();setMobile(false);return;}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'&&search){e.preventDefault();search.focus();search.select();openGlobalSearch();scheduleGlobalSearch(false);return;}
    if(e.key==='Tab'&&body.classList.contains('mobile-nav-open')){
      var f=focusables();if(!f.length)return;var first=f[0],last=f[f.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    }
  });

  var dialog=document.getElementById('confirm-dialog');
  var confirmText=document.getElementById('confirm-text');
  var confirmOk=document.getElementById('confirm-ok');
  var pendingForm=null;
  document.addEventListener('submit',function(e){
    var form=e.target;if(!(form instanceof HTMLFormElement))return;
    if(e.defaultPrevented)return;
    var message=form.getAttribute('data-confirm');
    if(message&&!form.dataset.confirmed){
      if(dialog&&typeof dialog.showModal==='function'){
        e.preventDefault();pendingForm=form;confirmText.textContent=message;dialog.showModal();return;
      }
      if(!window.confirm(message)){e.preventDefault();return;}
      form.dataset.confirmed='1';
    }
    window.setTimeout(function(){
      form.querySelectorAll('button[type=submit],input[type=submit]').forEach(function(b){
        if(!b.disabled){b.disabled=true;b.setAttribute('aria-busy','true');if(b.tagName==='BUTTON'&&!b.dataset.keepLabel)b.textContent='Enregistrement…';}
      });
    },0);
  });
  if(confirmOk)confirmOk.addEventListener('click',function(){
    if(!pendingForm)return;var f=pendingForm;pendingForm=null;dialog.close();f.dataset.confirmed='1';f.requestSubmit();
  });
  if(dialog)dialog.addEventListener('close',function(){pendingForm=null;});
})();
`;
