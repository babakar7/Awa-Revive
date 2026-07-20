/** Progressive enhancement shared by every authenticated admin page. */
export const ADMIN_CLIENT_JS = `
(function(){
  var body=document.body;
  var sidebar=document.getElementById('admin-sidebar');
  var menu=document.getElementById('nav-toggle');
  var collapse=document.getElementById('nav-collapse');
  var scrim=document.getElementById('nav-scrim');
  var search=document.getElementById('global-client-search');
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

  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&body.classList.contains('mobile-nav-open')){e.preventDefault();setMobile(false);return;}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'&&search){e.preventDefault();search.focus();search.select();return;}
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
