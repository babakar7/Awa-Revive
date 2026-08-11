/**
 * Shared Revive admin design system.
 *
 * Kept as a TypeScript string so the zero-dependency admin needs neither a
 * frontend build nor static-file serving. Print-only documents keep their own
 * deliberately isolated styles.
 */
export const ADMIN_CSS = `
:root{
  color-scheme:light;
  --cream-25:#faf6f1;--cream-50:#f5efe9;--cream-100:#eee5dd;--cream-200:#e2d6cc;
  --plum-50:#f8f4f8;--plum-100:#f0e8f0;--plum-200:#dfd0df;--plum-300:#c6b1c6;
  --plum-400:#a98baa;--plum-500:#916d92;--plum-600:#7c547d;--plum-700:#684469;--plum-800:#503451;--plum-900:#382439;
  --ink-900:#211a22;--ink-700:#48404a;--ink-500:#665c68;--ink-400:#817683;--ink-300:#aaa1ab;
  --surface:#fbf7f2;--surface-raised:#fefbf7;--bg:var(--cream-50);
  --border:#ded3ca;--border-soft:#e9e0d8;--border-strong:#cfc1b7;
  --brand:var(--plum-600);--brand-strong:var(--plum-700);--brand-soft:var(--plum-50);--brand-border:var(--plum-200);
  --ok:#21683b;--ok-bg:#edf8f1;--ok-border:#c8e7d1;
  --danger:#b63843;--danger-bg:#fff0f1;--danger-border:#f1c8cc;
  --warn:#8b5c16;--warn-bg:#fff7e8;--warn-border:#ecd9af;
  --info:#2f6394;--info-bg:#edf5fb;--info-border:#c8ddec;
  --sidebar:var(--plum-900);--sidebar-2:#49304a;--sidebar-text:#e5dce5;
  --space-1:.25rem;--space-2:.5rem;--space-3:.75rem;--space-4:1rem;--space-5:1.25rem;--space-6:1.5rem;--space-8:2rem;
  --radius-sm:7px;--radius:10px;--radius-lg:14px;--radius-xl:18px;
  --shadow-1:0 1px 2px rgba(45,30,49,.04),0 5px 16px -10px rgba(45,30,49,.18);
  --shadow-2:0 2px 5px rgba(45,30,49,.06),0 14px 32px -18px rgba(45,30,49,.28);
  --focus:0 0 0 2px var(--surface),0 0 0 4px var(--plum-600);
  --sidebar-w:256px;--topbar-h:70px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--ink-900);font-size:16px;line-height:1.6;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
button,input,select,textarea{font:inherit}
button,a,input,select,textarea,summary{outline:none}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{box-shadow:var(--focus);border-radius:var(--radius-sm)}
::selection{background:var(--plum-200);color:var(--ink-900)}
h1,h2,h3{letter-spacing:-.022em;color:var(--ink-900)}
h2{font-size:1.125rem;font-weight:680;margin:1.75rem 0 .65rem;scroll-margin-top:calc(var(--topbar-h) + 1rem)}
h2:first-child{margin-top:.15rem}
h3{font-size:1rem;font-weight:680;margin:1.2rem 0 .45rem}
p{margin-top:0}

/* shell */
.shell{display:flex;min-height:100vh;align-items:stretch}
.sidebar{width:var(--sidebar-w);flex:0 0 var(--sidebar-w);position:fixed;inset:0 auto 0 0;z-index:30;overflow-y:auto;display:flex;flex-direction:column;padding:.8rem .75rem 1rem;background:linear-gradient(180deg,var(--plum-700) 0%,var(--sidebar) 58%,#2e1e2f 100%);color:#fff;transition:width .18s ease,transform .18s ease;box-shadow:8px 0 32px -26px #000}
.brand{display:flex;align-items:center;gap:.7rem;padding:.45rem .55rem .8rem;margin-bottom:.15rem;text-decoration:none;color:#fff!important}
.brand-mark{display:grid;place-items:center;width:34px;height:34px;flex:0 0 34px;border:1px solid rgba(255,255,255,.16);border-radius:11px;background:rgba(255,255,255,.08);font-family:Georgia,serif;font-size:1.1rem;font-weight:700;letter-spacing:-.08em}
.brand-copy{min-width:0;line-height:1.05}
.brand-copy b{display:block;font-family:Georgia,"Times New Roman",serif;font-size:1.18rem;font-weight:600;letter-spacing:-.035em}
.brand-copy small{display:block;margin-top:.28rem;color:#d1c4d2;font-size:.72rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase}
.nav-section{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#cfc1d0;padding:1rem .65rem .32rem;font-weight:700;white-space:nowrap}
.nav-group--pinned{padding-top:.2rem}
.nav-group.muted-sec .nav-section{margin-top:.25rem}
.nav-group-toggle{display:flex;align-items:center;width:100%;background:none;border:0;padding:0;cursor:pointer;color:inherit;text-align:left;font:inherit}
.nav-group-toggle:hover .nav-section{color:#fff}
.nav-group-toggle .nav-section{flex:1;min-width:0;padding-right:.4rem}
.nav-chevron{width:14px;height:14px;flex:0 0 14px;margin-right:.55rem;color:#a893a9;transition:transform .15s ease}
.nav-chevron svg{width:100%;height:100%}
.nav-group.is-collapsed .nav-chevron{transform:rotate(-90deg)}
.js-nav .nav-group.is-collapsed .nav-group-links{display:none}
.nav-group:not(.is-collapsed) .nav-group-badge{display:none}
.nav-group-toggle .nav-group-badge{margin-left:0;margin-right:.4rem}
.sidebar a.nav-link{position:relative;display:flex;align-items:center;gap:.7rem;min-height:42px;margin:1px 0;padding:.5rem .62rem;border-radius:9px;color:var(--sidebar-text);text-decoration:none;font-size:.9rem;font-weight:540;transition:background-color .15s ease,color .15s ease,transform .15s ease}
.sidebar a.nav-link:hover{background:rgba(255,255,255,.075);color:#fff}
.sidebar a.nav-link.active{background:rgba(239,227,239,.12);color:#fff;font-weight:650}
.sidebar a.nav-link.active:before{content:"";position:absolute;left:-.12rem;top:.55rem;bottom:.55rem;width:3px;background:var(--plum-400);border-radius:99px}
.nav-icon{width:18px;height:18px;flex:0 0 18px;display:inline-grid;place-items:center;color:#d0c1d1}
.nav-link:hover .nav-icon,.nav-link.active .nav-icon{color:#fff}
.nav-icon svg,.ui-icon svg{width:100%;height:100%;display:block;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.nav-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-badge{margin-left:auto;background:#d74a55;color:#fff;border:2px solid var(--sidebar);border-radius:999px;font-size:.72rem;line-height:1.25;font-weight:750;padding:.06rem .4rem;min-width:1.3rem;text-align:center}
.sidebar-footer{margin-top:auto;padding-top:1rem}
.sidebar-footer form{margin:0}
.sidebar-footer button{width:100%;min-height:40px;display:flex;align-items:center;justify-content:center;gap:.5rem;background:transparent;border:1px solid rgba(255,255,255,.18);color:#ddd2de;border-radius:9px;padding:.45rem .55rem;font-size:.84rem;cursor:pointer}
.sidebar-footer button:hover{background:rgba(255,255,255,.07);color:#fff}
.main-wrap{flex:1;min-width:0;margin-left:var(--sidebar-w);display:flex;flex-direction:column;transition:margin-left .18s ease}
.topbar{height:var(--topbar-h);position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:1rem;padding:.65rem 1.5rem;background:rgba(251,247,242,.94);border-bottom:1px solid rgba(222,211,202,.9);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.topbar-title{min-width:0}
.topbar .page-title{font-size:1.08rem;font-weight:700;line-height:1.25;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar .page-subtitle{display:block;color:var(--ink-500);font-size:.875rem;margin-top:.12rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-search{position:relative;flex:1;min-width:220px;max-width:440px;margin:0 0 0 auto}
.topbar-search .ui-icon{position:absolute;left:.8rem;top:50%;transform:translateY(-50%);width:16px;height:16px;color:var(--ink-400);pointer-events:none}
.topbar input[type=search]{width:100%;height:42px;margin:0;padding:.5rem 3.4rem .5rem 2.25rem;border:1px solid var(--border);border-radius:999px;background:var(--cream-25);font-size:.9rem;transition:border-color .15s ease,background .15s ease,box-shadow .15s ease}
.topbar input[type=search]:hover{border-color:var(--border-strong);background:var(--surface-raised)}
.search-key{position:absolute;right:.62rem;top:50%;transform:translateY(-50%);border:1px solid var(--border);border-bottom-color:var(--border-strong);border-radius:5px;background:var(--surface-raised);color:var(--ink-400);font-size:.63rem;font-weight:650;line-height:1;padding:.22rem .35rem;pointer-events:none}
.global-search-panel{position:absolute;top:calc(100% + .45rem);left:0;right:0;z-index:45;max-height:min(68vh,520px);overflow:auto;padding:.35rem;border:1px solid var(--border);border-radius:13px;background:var(--surface-raised);box-shadow:0 18px 50px rgba(45,30,49,.18)}
.global-search-message{padding:.85rem;color:var(--ink-500);font-size:.84rem;line-height:1.45}
.global-search-loading{color:var(--brand)}
.global-search-error{color:var(--danger)}
.global-search-option{display:grid;gap:.18rem;padding:.62rem .7rem;border-radius:9px;color:var(--ink-700)!important;text-decoration:none}
.global-search-option:hover,.global-search-option.active,.global-search-option[aria-selected=true]{background:var(--brand-soft);color:var(--ink-900)!important}
.global-search-option-heading{display:flex;align-items:baseline;justify-content:space-between;gap:.7rem}
.global-search-option-heading span{flex:0 0 auto;color:var(--ink-500);font-size:.75rem}
.global-search-option-preview{overflow:hidden;color:var(--ink-500);font-size:.79rem;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}
.global-search-option-meta{color:var(--plum-600);font-size:.7rem;font-weight:700}
.global-search-all{display:block;margin-top:.25rem;padding:.6rem .7rem;border-top:1px solid var(--border-soft);color:var(--brand)!important;font-size:.8rem;font-weight:700;text-align:center;text-decoration:none}
.nav-toggle,.nav-collapse{width:40px;height:40px;flex:0 0 40px;display:grid;place-items:center;border:1px solid var(--border);border-radius:10px;background:var(--surface-raised);color:var(--ink-700);cursor:pointer}
.nav-toggle{display:none}
.nav-collapse{margin-left:.1rem}
.nav-toggle .ui-icon,.nav-collapse .ui-icon{width:18px;height:18px}
.topbar-actions{display:flex;align-items:center;gap:.5rem}
.nav-scrim{display:none}
main{width:100%;max-width:1180px;margin:0 auto;padding:1.55rem 1.75rem 4rem}
main.content-standard{max-width:900px}
main.content-wide{max-width:1280px}
main.content-full{max-width:none}
.breadcrumbs{display:flex;align-items:center;gap:.35rem;margin:0 0 .55rem;color:var(--ink-500);font-size:.875rem}
.breadcrumbs a{color:inherit!important;text-decoration:none}
.breadcrumbs span[aria-hidden=true]{color:var(--ink-300)}

body.nav-collapsed .sidebar{width:78px}
body.nav-collapsed .main-wrap{margin-left:78px}
body.nav-collapsed .brand-copy,body.nav-collapsed .nav-label,body.nav-collapsed .nav-section,body.nav-collapsed .sidebar-footer span,body.nav-collapsed .nav-badge{display:none}
body.nav-collapsed .brand{justify-content:center;padding-inline:0}
body.nav-collapsed .sidebar a.nav-link{justify-content:center;padding-inline:0}
body.nav-collapsed .nav-group-toggle{display:none}
body.nav-collapsed .nav-group-links{display:block!important}

/* page composition */
.page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin:.05rem 0 1.25rem}
.page-header-copy{min-width:0}
.page-header h2,.page-header h1{font-size:1.625rem;line-height:1.22;margin:0;font-weight:720;letter-spacing:-.035em}
.page-header p{margin:.4rem 0 0;color:var(--ink-500);font-size:.94rem;line-height:1.6;max-width:65ch}
.page-header-actions{display:flex;align-items:center;justify-content:flex-end;gap:.5rem;flex-wrap:wrap}
.section-header{display:flex;align-items:center;justify-content:space-between;gap:.8rem;margin:1.7rem 0 .65rem}
.section-header h2,.section-header h3{margin:0}
.eyebrow{display:block;margin-bottom:.25rem;color:var(--plum-600);font-size:.72rem;font-weight:750;letter-spacing:.085em;text-transform:uppercase}
.subhead{font-size:.9rem;color:var(--ink-500);line-height:1.6;margin:-.25rem 0 1rem}

/* surfaces */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1rem 1.05rem;margin-bottom:.9rem;box-shadow:var(--shadow-1)}
.card.warn,.warn{background:var(--warn-bg);border-color:var(--warn-border)}
.card.success{background:var(--ok-bg);border-color:var(--ok-border)}
.card.warn,.card.success,.notice{position:relative;overflow:hidden}
.card.warn:before,.card.success:before,.notice:before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--warn)}
.card.success:before{background:var(--ok)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.75rem;margin-bottom:1rem}
.stat{position:relative;background:linear-gradient(145deg,var(--surface-raised) 0%,var(--cream-25) 100%);border:1px solid var(--border);border-radius:var(--radius-lg);padding:.95rem 1rem;box-shadow:var(--shadow-1);overflow:hidden}
.stat:before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,var(--plum-400),transparent 80%)}
.stat span{display:block;font-size:.75rem;color:var(--ink-500);text-transform:uppercase;letter-spacing:.05em;font-weight:700}
.stat b{display:block;font-size:1.72rem;line-height:1.15;font-weight:720;letter-spacing:-.035em;margin:.24rem 0;color:var(--ink-900)}
.stat b+span{font-size:.875rem;text-transform:none;letter-spacing:0;font-weight:500}
.studio-activity{margin-bottom:1.25rem}
.activity-section-header{align-items:flex-end;margin-top:.15rem}
.activity-period-copy{margin:.2rem 0 0;color:var(--ink-500);font-size:.875rem}
.period-toggle{display:inline-flex;align-items:center;gap:.2rem;padding:.22rem;border:1px solid var(--border);border-radius:10px;background:var(--surface);box-shadow:var(--shadow-1)}
.period-toggle button{min-height:36px;padding:.36rem .72rem;border:0;border-radius:7px;background:transparent;color:var(--ink-500);font-size:.82rem;font-weight:680;cursor:pointer;transition:background-color .15s ease,color .15s ease,box-shadow .15s ease}
.period-toggle button:hover{color:var(--brand);background:var(--brand-soft)}
.period-toggle button.active,.period-toggle button[aria-pressed=true],.period-toggle button[aria-selected=true]{color:var(--brand-strong);background:var(--plum-100);box-shadow:0 1px 2px rgba(45,30,49,.08)}
.activity-stat-grid{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:0}
.activity-stat{min-height:142px;display:flex;flex-direction:column;justify-content:center;padding:1.05rem 1.1rem}
.activity-stat-label{display:flex;align-items:center;gap:.55rem;color:var(--ink-500)}
.activity-stat .activity-stat-label>span{display:inline;text-transform:none;letter-spacing:0;font-size:.8rem;font-weight:680;color:inherit}
.activity-stat .activity-stat-icon{width:31px;height:31px;flex:0 0 31px;display:inline-grid;place-items:center;border-radius:9px;background:var(--plum-100);color:var(--plum-600)}
.activity-stat .activity-stat-icon .ui-icon{width:17px;height:17px;display:inline-grid;color:inherit}
.activity-stat b{font-size:1.95rem;margin:.55rem 0 .1rem}
.activity-stat b+span{font-size:.78rem;color:var(--ink-400)}
.activity-stat .stat-drilldown{margin-top:.45rem;font-size:.78rem;font-weight:650;text-transform:none;letter-spacing:0}
.empty{display:grid;justify-items:center;text-align:center;gap:.32rem;padding:1.7rem 1rem;color:var(--ink-500)}
.empty .empty-icon{width:38px;height:38px;display:grid;place-items:center;border-radius:12px;background:var(--cream-100);color:var(--plum-500)}
.empty .empty-icon .ui-icon{width:19px;height:19px}
.empty b{color:var(--ink-700);font-size:.94rem}
.empty p{margin:0;max-width:42ch;font-size:.875rem;line-height:1.55}

/* operational task cards */
.task-list{display:grid;gap:.62rem}
.task-item{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:.85rem;padding:.85rem .9rem;border:1px solid var(--border);border-radius:12px;background:var(--surface-raised);transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease}
.task-item:hover{border-color:var(--brand-border);box-shadow:var(--shadow-1)}
.task-item.is-complete{opacity:.72}
.follow-up-filters,.conversation-filters{display:grid;grid-template-columns:minmax(180px,1fr) minmax(150px,.45fr) minmax(150px,.45fr) auto;align-items:end;gap:.7rem}
.conversation-filters{grid-template-columns:minmax(240px,1fr) minmax(150px,.35fr) auto auto}
.conversation-filters.is-live .conversation-submit{display:none}
.conversation-live-status,.conversation-search-reload{grid-column:1/-1;font-size:.8rem}
.conversation-live-status:empty,.conversation-search-reload[hidden]{display:none}
.conversation-search-error{color:var(--danger)!important}
.conversation-search-reload{width:max-content;color:var(--brand);font-weight:700}
.conversation-result-summary{margin:.1rem 0 .55rem;color:var(--ink-500);font-size:.86rem}
.conversation-results{transition:opacity .15s ease}
.conversation-results[aria-busy=true]{opacity:.62}
.follow-up-item .task-action{min-width:170px}
.resolution-panel{position:relative}
.resolution-panel>summary{list-style:none}
.resolution-panel>summary::-webkit-details-marker{display:none}
.resolution-panel[open]>.resolution-form{display:grid}
.resolution-form{display:none;position:absolute;right:0;top:calc(100% + .4rem);z-index:12;width:min(340px,80vw);gap:.7rem;padding:.85rem;background:var(--surface-raised);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-2);text-align:left}
.resolution-form textarea{min-height:72px}
.internal-note{margin:.55rem 0 0;padding:.5rem .6rem;border-radius:8px;background:var(--cream-50);color:var(--ink-700);font-size:.84rem}
.pagination{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.8rem;margin:1rem 0;color:var(--ink-500);font-size:.875rem}
.pagination>:last-child{justify-self:end}
.takeover-banner{display:flex;align-items:center;justify-content:space-between;gap:1rem}
.takeover-banner span{color:var(--ink-500);font-size:.875rem}
.human-turn .bubble{border-color:var(--plum-300);background:linear-gradient(145deg,var(--plum-50),var(--plum-100))}
.human-label{display:block;margin-bottom:.22rem;color:var(--plum-700);font-size:.7rem;font-weight:750;letter-spacing:.06em;text-transform:uppercase}
.conversation-match mark{padding:.04em .12em;border-radius:3px;background:#f5dda1;color:inherit;font-weight:750}
.conversation-match>.muted{margin-top:.25rem}
.retry-send{margin-left:.35rem}
.admin-composer{position:sticky;bottom:.6rem;z-index:7;box-shadow:var(--shadow-2)}
.admin-composer textarea{width:100%;min-height:92px}
.workspace-history-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
.workspace-history-grid>.card{margin:0;align-self:start}
.workspace-history-grid summary{cursor:pointer}
.workspace-history-grid details[open] summary{margin-bottom:.65rem}
.document-list{display:grid;gap:.55rem;margin:0;padding:0;list-style:none}
.document-list li{display:flex;align-items:center;justify-content:space-between;gap:.7rem;padding:.55rem 0;border-bottom:1px solid var(--border-soft)}
.document-list li:last-child{border:0}
.compact-empty{padding:1rem .4rem}
.task-priority{width:9px;height:9px;border-radius:50%;background:var(--ink-300);box-shadow:0 0 0 5px var(--cream-100)}
.task-priority.danger{background:var(--danger);box-shadow:0 0 0 5px var(--danger-bg)}
.task-priority.warn{background:#d48a22;box-shadow:0 0 0 5px var(--warn-bg)}
.task-copy{min-width:0}
.task-copy b{display:block;font-size:.96rem}
.task-copy p{margin:.16rem 0 0;color:var(--ink-500);font-size:.875rem;line-height:1.55;white-space:normal}
.task-meta{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;margin-top:.35rem}
.task-action{display:flex;align-items:center;justify-content:flex-end;gap:.4rem;flex-wrap:wrap}

/* tables */
.table-wrap{width:100%;overflow:auto;border-radius:10px;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:.92rem;line-height:1.5;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:.78rem .7rem;border-bottom:1px solid var(--border-soft);vertical-align:middle}
th{color:var(--ink-500);font-weight:750;font-size:.75rem;text-transform:uppercase;letter-spacing:.055em;background:var(--cream-25);white-space:nowrap}
thead th:first-child{border-radius:9px 0 0 9px}
thead th:last-child{border-radius:0 9px 9px 0}
tbody tr:last-child td{border-bottom:0}
tbody tr{transition:background-color .12s ease}
tbody tr:hover{background:#f8f1eb}
tbody tr.is-complete{opacity:.58}
a.rowlink{color:inherit;text-decoration:none;display:block}
tr.rowlink{cursor:pointer}
tr.rowlink:focus-within{box-shadow:inset 3px 0 var(--brand)}

/* text and statuses */
.badge{border:1px solid transparent;border-radius:999px;padding:.18rem .52rem;font-size:.75rem;line-height:1.3;font-weight:700;white-space:nowrap;display:inline-flex;align-items:center;gap:.22rem}
.badge--gray{background:var(--cream-100);border-color:var(--cream-200);color:var(--ink-500)}
.badge--violet{background:var(--plum-50);border-color:var(--plum-200);color:var(--plum-700)}
.badge--red{background:var(--danger-bg);border-color:var(--danger-border);color:var(--danger)}
.badge--amber{background:var(--warn-bg);border-color:var(--warn-border);color:var(--warn)}
.badge--blue{background:var(--info-bg);border-color:var(--info-border);color:var(--info)}
.badge--green{background:var(--ok-bg);border-color:var(--ok-border);color:var(--ok)}
.muted{color:var(--ink-500);font-size:.875rem;line-height:1.55}
.ok{color:var(--ok);font-weight:650}
.danger-text{color:var(--danger);font-weight:650}
.warn-text{color:var(--warn);font-weight:650}
code{padding:.08rem .28rem;border-radius:5px;background:var(--cream-100);color:var(--plum-700);font-size:.82em}

/* buttons and links */
main a:not(.act){color:var(--brand);text-underline-offset:2px;text-decoration-thickness:1px}
main a:not(.act):hover{color:var(--brand-strong)}
button.act,a.act{min-height:42px;display:inline-flex;align-items:center;justify-content:center;gap:.38rem;background:var(--brand);color:#fff;border:1px solid var(--brand);border-radius:var(--radius);padding:.55rem .95rem;font-size:.875rem;font-weight:650;cursor:pointer;text-decoration:none;line-height:1.3;box-shadow:0 4px 12px -8px rgba(124,84,125,.85);transition:background-color .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease,transform .15s ease}
button.act:hover,a.act:hover{background:var(--brand-strong);border-color:var(--brand-strong);color:#fff;box-shadow:0 8px 18px -10px rgba(124,84,125,.9);transform:translateY(-1px)}
button.act:active,a.act:active{transform:translateY(0);box-shadow:none}
.act--sm{min-height:38px!important;padding:.4rem .68rem!important;font-size:.85rem!important;border-radius:8px!important}
button.act.act--ok,a.act.act--ok{background:var(--ok);border-color:var(--ok);color:#fff}
button.act.act--ok:hover,a.act.act--ok:hover{background:#195a31;border-color:#195a31;color:#fff}
button.act.act--danger,a.act.act--danger{background:var(--danger);border-color:var(--danger);color:#fff}
button.act.act--danger:hover,a.act.act--danger:hover{background:#9e2e38;border-color:#9e2e38;color:#fff}
button.act.act--ghost,a.act.act--ghost{background:var(--surface-raised);color:var(--brand);border-color:var(--brand-border);box-shadow:none}
button.act.act--ghost:hover,a.act.act--ghost:hover{background:var(--brand-soft);color:var(--brand-strong);border-color:var(--plum-400)}
button.act:disabled,.act[aria-disabled=true]{opacity:.5;cursor:not-allowed;pointer-events:none;transform:none;box-shadow:none}
.icon-button{width:40px;padding:0!important}

/* forms */
main input:not([type=checkbox]):not([type=radio]):not([type=search]),main select,main textarea{
  min-height:42px;background:var(--surface-raised);border:1px solid var(--border-strong);border-radius:var(--radius);padding:.55rem .7rem;font-size:.9rem;color:var(--ink-900);max-width:100%;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease}
main textarea{min-height:88px;resize:vertical}
main input[type=search]{width:100%;min-height:42px;background:var(--surface-raised);border:1px solid var(--border-strong);border-radius:var(--radius);padding:.55rem .7rem;font-size:.9rem;color:var(--ink-900)}
main label>input:not([type=checkbox]):not([type=radio]),main label>select,main label>textarea{width:100%;margin-top:.28rem}
main input:hover,main select:hover,main textarea:hover{border-color:#bcaeb8}
main input:focus-visible,main select:focus-visible,main textarea:focus-visible{border-color:var(--brand);box-shadow:0 0 0 3px var(--plum-100)}
main input::placeholder,main textarea::placeholder{color:var(--ink-400)}
main input[type=checkbox],main input[type=radio]{accent-color:var(--brand);width:1rem;height:1rem}
main label{font-size:.875rem;font-weight:650;color:var(--ink-700)}
fieldset{border-color:var(--border)!important;border-radius:var(--radius-lg)!important}
legend{padding:0 .35rem}
form.inline{display:inline}
.is-selected{border-color:var(--brand)!important;background:var(--brand-soft)}
.field-help{display:block;margin-top:.25rem;color:var(--ink-500);font-size:.875rem;line-height:1.5;font-weight:450}
.form-card{padding:1.2rem}
.form-stack{display:flex;flex-direction:column;gap:1rem}
.form-actions{display:flex;justify-content:flex-start;gap:.5rem;padding-top:.2rem}
.profile-preview{display:flex;align-items:center;gap:.9rem;margin-bottom:1.15rem;padding-bottom:1rem;border-bottom:1px solid var(--border-soft)}
.profile-preview img{width:76px;height:76px;flex:0 0 76px;border-radius:50%;object-fit:cover;border:3px solid var(--surface-raised);box-shadow:0 0 0 1px var(--border),var(--shadow-1)}
.profile-preview p{margin:.18rem 0 0}
.filter-bar{display:flex;align-items:flex-end;justify-content:space-between;padding:.8rem 1rem}
.finance-card h2{margin:.05rem 0 .2rem;font-size:1.08rem}
.finance-total{display:flex;flex-direction:column;align-items:flex-end;gap:.2rem;text-align:right}
.finance-total b{font-size:1.28rem;letter-spacing:-.025em}
.finance-total>span:not(.badge){color:var(--ink-500);font-size:.875rem}
.card-actions{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-top:.85rem;padding-top:.8rem;border-top:1px solid var(--border-soft)}
.statement-summary{display:flex;align-items:center;justify-content:space-between;gap:1rem;background:linear-gradient(135deg,var(--surface-raised) 0%,var(--plum-50) 100%)}
.statement-summary>div{display:flex;flex-direction:column;align-items:flex-start;gap:.22rem}
.statement-summary>div:last-child{align-items:flex-end;text-align:right}
.statement-summary b{font-size:1.55rem;letter-spacing:-.035em}
.statement-summary p{margin:0}
.payment-month-bar{display:grid;grid-template-columns:auto 1fr auto;align-items:end;gap:1rem;padding:.8rem 1rem}
.payment-month-bar form{justify-content:center;align-items:end}
.payment-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem;margin-bottom:1rem}
.payment-stat-grid article{display:flex;flex-direction:column;gap:.24rem;padding:1rem;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface-raised);box-shadow:var(--shadow-1)}
.payment-stat-grid span{color:var(--ink-500);font-size:.76rem;font-weight:750;letter-spacing:.045em;text-transform:uppercase}
.payment-stat-grid b{font-size:1.4rem;letter-spacing:-.035em}
.payment-stat-grid small{color:var(--ink-500);font-size:.75rem}
.payment-cockpit-table{padding:.35rem .6rem}
.payment-cockpit-table table{margin:0}.payment-cockpit-table td,.payment-cockpit-table th{padding:.7rem .55rem;vertical-align:middle}
.payment-cockpit-table form{margin:0}.payment-bulk-result{display:flex;gap:.8rem;flex-wrap:wrap;margin-top:.35rem;color:var(--ink-600);font-size:.85rem}
.payment-sticky-summary{position:sticky;top:.55rem;z-index:8;display:grid;grid-template-columns:1.35fr 1.2fr .7fr .7fr auto;align-items:center;gap:1rem;margin-bottom:.35rem;padding:.85rem 1rem;border:1px solid var(--plum-200);border-radius:var(--radius-lg);background:rgba(255,255,255,.96);box-shadow:var(--shadow-2);backdrop-filter:blur(12px)}
.payment-sticky-summary>div{display:flex;flex-direction:column;gap:.2rem}.payment-sticky-summary span:not(.badge){color:var(--ink-500);font-size:.72rem;font-weight:750;text-transform:uppercase;letter-spacing:.045em}.payment-sticky-summary b{font-size:1.12rem}.payment-sticky-summary>div:first-child b{font-size:1.4rem}.payment-sticky-summary .payment-primary-action{align-items:flex-end}.payment-sync-line{margin:.35rem 0 1rem;text-align:right;font-size:.82rem}
.payment-checklist ul{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.65rem;margin:0;padding:0;list-style:none}.payment-checklist li{display:grid;grid-template-columns:1.7rem 1fr;gap:.55rem;padding:.7rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}.payment-checklist li>span{display:grid;place-items:center;width:1.55rem;height:1.55rem;border-radius:50%;font-weight:800}.payment-checklist .is-ok>span{background:var(--ok-bg);color:var(--ok)}.payment-checklist .is-blocked>span{background:var(--warn-bg);color:var(--warn)}.payment-checklist li div{display:flex;flex-direction:column;gap:.12rem}.payment-checklist li small{color:var(--ink-500);line-height:1.35}
.payment-buckets{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.65rem;margin-bottom:1rem}.payment-buckets article{display:flex;align-items:center;justify-content:space-between;padding:.75rem .9rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface-raised)}.payment-buckets span{color:var(--ink-500);font-size:.82rem}.payment-buckets b{font-size:1.12rem}
.payment-panel>summary,.payment-settings-item>summary{display:flex;align-items:center;justify-content:space-between;gap:1rem;cursor:pointer;list-style:none}.payment-panel>summary::-webkit-details-marker,.payment-settings-item>summary::-webkit-details-marker{display:none}.payment-panel>summary span,.payment-settings-item>summary span:first-child{display:flex;flex-direction:column;gap:.14rem}.payment-panel>summary small,.payment-settings-item>summary small{color:var(--ink-500);font-weight:500}.payment-panel[open]>summary{margin-bottom:1rem;padding-bottom:.75rem;border-bottom:1px solid var(--border-soft)}
.payment-settings-item{margin-bottom:.65rem;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface-raised);box-shadow:var(--shadow-1)}.payment-settings-item>summary{padding:.85rem 1rem}.payment-settings-item>form.card{margin:0;border:0;border-top:1px solid var(--border-soft);border-radius:0 0 var(--radius-lg) var(--radius-lg);box-shadow:none}
.checklist-progress{display:flex;align-items:center;justify-content:space-between;gap:1rem}
.checklist-progress>div{display:flex;flex-direction:column;gap:.12rem}
.report-stat-grid{grid-template-columns:repeat(4,minmax(0,1fr))}
.ad-roas-hero{border-color:var(--plum-300);background:linear-gradient(135deg,var(--plum-50),var(--surface-raised));box-shadow:var(--shadow-2)}
.ad-roas-grid{grid-template-columns:1.4fr 1fr 1fr;margin-bottom:0}
.ad-roas-primary{border-color:var(--plum-300);background:var(--surface-raised)}
.ad-roas-primary:before{height:3px;background:linear-gradient(90deg,var(--brand),var(--plum-300))}
.ad-roas-primary b{color:var(--brand-strong);font-size:2.45rem}
[data-acquisition-period-panel][hidden]{display:none}
.report-breakdown{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem}
.report-breakdown>div{display:flex;flex-direction:column;gap:.2rem;padding-right:1rem;border-right:1px solid var(--border-soft)}
.report-breakdown>div:last-child{border:0}
.report-breakdown span{color:var(--ink-500);font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em}

/* Historique commandes — mini graphe en barres CSS (pas de lib de charts) */
.trend-bars{display:flex;align-items:flex-end;gap:.3rem;height:140px;padding:.4rem .2rem 0;overflow-x:auto}
.trend-bars .trend-col{flex:1 1 0;min-width:14px;display:flex;flex-direction:column;align-items:center;gap:.3rem;height:100%}
.trend-bars .trend-track{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center}
.trend-bars .trend-bar{width:70%;min-height:2px;border-radius:5px 5px 0 0;background:linear-gradient(180deg,var(--brand),var(--plum-300))}
.trend-bars .trend-bar.is-zero{background:var(--border);min-height:2px}
.trend-bars .trend-label{font-size:.66rem;color:var(--ink-500);white-space:nowrap}
#oh-root{transition:opacity .12s ease}
#oh-root[aria-busy="true"]{opacity:.5;pointer-events:none}

/* Clés de la Maison — reception memo */
.key-memo{max-width:980px;margin:0 auto}
.key-memo-header{margin-bottom:1rem}
.key-memo-principle{display:grid;grid-template-columns:auto minmax(0,1fr);gap:1rem;align-items:center;margin-bottom:1rem;padding:1.15rem 1.25rem;border:1px solid var(--plum-200);border-radius:var(--radius-xl);background:linear-gradient(135deg,var(--plum-50),var(--surface-raised));box-shadow:var(--shadow-1)}
.key-memo-principle-icon{display:grid;place-items:center;width:46px;height:46px;border-radius:14px;background:var(--brand);color:#fff;font-size:1.15rem;box-shadow:0 8px 20px -12px var(--brand)}
.key-memo-principle .eyebrow{margin:0 0 .15rem}
.key-memo-principle h2{margin:0;font-size:1.13rem;line-height:1.4}
.key-memo-principle p{margin:.25rem 0 0;color:var(--ink-500);font-size:.9rem}
.key-memo-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.85rem}
.key-rule-card{min-width:0;margin:0;padding:1.1rem 1.15rem;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow-1)}
.key-rule-card--wide{grid-column:1/-1}
.key-rule-heading{display:flex;align-items:center;gap:.8rem;margin-bottom:.85rem;padding-bottom:.8rem;border-bottom:1px solid var(--border-soft)}
.key-rule-heading .eyebrow{margin:0 0 .12rem}
.key-rule-heading h2{margin:0;font-size:1.08rem;line-height:1.3}
.key-rule-number{display:grid;place-items:center;width:36px;height:36px;flex:0 0 36px;border-radius:11px;background:var(--plum-100);color:var(--brand-strong);font-size:.94rem;font-weight:780}
.key-rule-card>p{font-size:.92rem;line-height:1.62}
.key-callout{display:grid;gap:.08rem;margin-top:.65rem;padding:.68rem .75rem;border:1px solid var(--border);border-radius:10px;font-size:.86rem;line-height:1.5}
.key-callout strong{font-size:.76rem;letter-spacing:.045em;text-transform:uppercase}
.key-callout--success{background:var(--ok-bg);border-color:var(--ok-border)}
.key-callout--success strong{color:var(--ok)}
.key-callout--danger{background:var(--danger-bg);border-color:var(--danger-border)}
.key-callout--danger strong{color:var(--danger)}
.key-facts{display:grid;gap:0;margin:0}
.key-facts>div{display:grid;grid-template-columns:90px minmax(0,1fr);gap:.75rem;padding:.62rem 0;border-bottom:1px solid var(--border-soft)}
.key-facts>div:last-child{border-bottom:0}
.key-facts dt{color:var(--ink-500);font-size:.72rem;font-weight:750;letter-spacing:.055em;text-transform:uppercase}
.key-facts dd{margin:0;color:var(--ink-700);font-size:.9rem;font-weight:620}
.key-check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem;margin:.85rem 0}
.key-check-grid p{display:flex;align-items:flex-start;gap:.48rem;margin:0;padding:.62rem .7rem;border:1px solid var(--border-soft);border-radius:9px;background:var(--cream-25);color:var(--ink-700);font-size:.88rem;line-height:1.5}
.key-check-grid p span{color:var(--ok);font-weight:800}
.key-checklist{display:grid;gap:.5rem;margin:.7rem 0 1rem;padding:0;list-style:none}
.key-checklist li{position:relative;padding-left:1.5rem;color:var(--ink-700);font-size:.9rem;line-height:1.5}
.key-checklist li:before{content:"✓";position:absolute;left:0;top:0;color:var(--ok);font-weight:800}
.key-checklist--excluded li:before{content:"×";color:var(--danger)}
.key-final-rule,.key-owner-note,.key-deadline{margin:.8rem 0 0;padding:.68rem .75rem;border-radius:10px;background:var(--cream-50);color:var(--ink-700);font-size:.87rem!important}
.key-deadline{background:var(--warn-bg);border:1px solid var(--warn-border)}
.key-owner-note{background:var(--info-bg);border:1px solid var(--info-border)}
.key-founders-layout{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
.key-founders-layout>div{padding:.85rem;border:1px solid var(--border-soft);border-radius:11px;background:var(--cream-25)}
.key-founders-layout h3{margin:0 0 .7rem;font-size:.92rem}
.key-founders-layout .key-checklist{margin-bottom:0}
.key-memo-footer{display:flex;align-items:center;gap:.55rem;margin-top:1rem;padding:.9rem 1rem;border-radius:12px;background:var(--plum-800);color:#fff;font-size:.9rem}
.key-memo-footer span{color:#eee3ee}
/* Catalogue des abonnements (référence statique) */
.key-catalogue{margin-top:1.4rem}
.key-catalogue-head{margin-bottom:.9rem}
.key-catalogue-head h2{margin:.15rem 0 .2rem}
.key-catalogue-head p{font-size:.9rem;color:var(--muted)}
.key-catalogue-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.85rem}
.key-cat-card{min-width:0;padding:1.05rem 1.15rem;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow-1)}
.key-cat-card--accent{border-color:var(--plum-300,#d8b9d0);background:var(--plum-50,#faf4f8)}
.key-cat-card--plain{background:var(--surface-2,#faf9fb)}
.key-cat-card>header{display:flex;flex-direction:column;gap:.15rem;margin-bottom:.6rem}
.key-cat-card h3{margin:0;font-size:1rem}
.key-cat-price{font-size:.82rem;color:var(--muted);font-weight:600}
.key-cat-card ul{margin:0;padding-left:1.1rem;display:flex;flex-direction:column;gap:.3rem;font-size:.9rem;line-height:1.5}
.key-cat-note{margin:.6rem 0 0;font-size:.82rem;color:var(--muted);font-style:italic}

/* menu catalogue and internal recipes */
.menu-stats{grid-template-columns:repeat(3,minmax(0,1fr))}
.menu-filters{display:grid;grid-template-columns:minmax(220px,1.5fr) repeat(2,minmax(130px,.75fr)) auto;align-items:end;gap:.75rem}
.menu-filter-actions{min-height:42px;display:flex;align-items:center;gap:.7rem;white-space:nowrap}
/* sticky section bar: stays visible while scrolling; scrolls horizontally on
   narrow screens instead of wrapping into a tall block. Shared by the menu
   catalogue tabs and the payments (.jump-nav--sticky) in-page section nav. */
.menu-jumpnav,.jump-nav--sticky{position:sticky;top:calc(var(--topbar-h) + .5rem);z-index:9;flex-wrap:nowrap;overflow-x:auto;white-space:nowrap;width:auto;background:rgba(251,247,242,.97);backdrop-filter:blur(10px);scrollbar-width:thin}
.menu-jumpnav a,.jump-nav--sticky a{flex:0 0 auto}
.menu-jumpnav a .badge,.jump-nav--sticky a .badge{margin-left:.35rem}
/* sections targeted by the sticky jump-nav must clear both the topbar and the
   nav itself, otherwise an anchored heading lands hidden under the bar */
.anchor-target{scroll-margin-top:calc(var(--topbar-h) + 3.6rem)}
/* compact "à qualifier" rows: one row per untagged movement instead of a full
   form card each, so the sections below aren't pushed thousands of px down */
.qualify-row{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,1.4fr);gap:.6rem 1rem;align-items:center;padding:.55rem 0;border-bottom:1px solid var(--border-soft)}
.qualify-row:last-child{border-bottom:0}
.qualify-act{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.qualify-act input{max-width:220px;margin:0}
/* day-grouping band in the movements table: one header row per Dakar day so the
   team can retrace every transaction of a given day (client, amount, method) */
.day-head td{background:var(--cream-100);border-top:2px solid var(--border);font-size:.86rem;color:var(--ink-700);padding:.5rem .7rem!important}
.day-head b{color:var(--ink-900)}
/* movements range scoper: quick day chips (Aujourd'hui / Hier / 7 jours) + a
   date picker to go further back; defaults to the current day */
.range-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem 1rem;margin:0 0 1rem}
.range-bar .filters{margin:0}
.range-picker{display:flex;align-items:flex-end;flex-wrap:wrap;gap:.5rem}
.range-picker label{display:flex;flex-direction:column;font-size:.78rem;font-weight:700;color:var(--ink-500);gap:.2rem}
.range-picker input{margin:0}
/* selected tab: filled brand pill so the active category is unmistakable
   (the shared .jump-nav a.active tint is too subtle for a one-at-a-time view) */
.menu-jumpnav a.menu-tab.active{background:var(--brand);color:#fff!important;font-weight:700;box-shadow:var(--shadow-1)}
.menu-jumpnav a.menu-tab.active .badge{background:rgba(255,255,255,.26);color:#fff}
.menu-editor{display:grid;gap:.9rem}
.menu-editor>.card{margin-bottom:0}
.menu-editor-heading{margin:0 0 1rem}
.menu-editor-heading p{margin:.25rem 0 0}
.menu-form-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(150px,.5fr);gap:1rem}
.menu-form-grid .menu-description{grid-column:1/-1}
.choice-editor{grid-column:1/-1;display:grid;gap:1rem;padding:1rem;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--cream-25)}
.choice-editor-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}
.choice-editor-heading h3{margin:0;font-size:1.02rem}
.choice-editor-heading p{margin:.3rem 0 0;max-width:68ch}
.choice-groups{display:grid;gap:.9rem}
.choice-group{display:grid;gap:.85rem;padding:1rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface-raised)}
.choice-group-heading{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding-bottom:.65rem;border-bottom:1px solid var(--border-soft)}
.choice-group-heading h4{margin:0;font-size:.95rem}
.choice-label{max-width:620px}
.choice-responses{display:grid;gap:.75rem}
.choice-responses-heading{display:flex;align-items:center;justify-content:space-between;gap:.75rem}
.choice-responses-heading .field-help{margin-top:.15rem}
.choice-response-list{display:grid;gap:.6rem}
.choice-response-row{display:grid;grid-template-columns:2rem minmax(0,1fr) auto;align-items:center;gap:.65rem}
.choice-response-row input{width:100%;margin:0}
.choice-response-number{display:inline-flex;align-items:center;justify-content:center;width:2rem;height:2rem;border-radius:999px;background:var(--plum-100);color:var(--brand-strong);font-size:.82rem;font-weight:750}
.choice-remove{min-width:100px}
.choice-response-actions,.choice-group-actions{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
.choice-response-actions .field-help,.choice-group-actions .field-help{margin:0}
.menu-form-grid .menu-favourite{grid-column:1/-1;display:flex;align-items:center;gap:.5rem;padding:.7rem .75rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--cream-25)}
.menu-form-grid .menu-favourite input{flex:0 0 auto;margin:0}
.recipe-editor{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.recipe-editor .menu-editor-heading{grid-column:1/-1}
.recipe-editor textarea{min-height:250px;line-height:1.6}
.menu-danger-zone{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-top:1rem}
.menu-danger-zone p{margin:.15rem 0 0}

/* chat */
.conversation-shell{display:grid;grid-template-columns:minmax(220px,280px) minmax(0,1fr);gap:1rem;align-items:start}
.client-summary{position:sticky;top:calc(var(--topbar-h) + 1rem)}
.thread{display:flex;flex-direction:column;gap:.22rem;padding:.25rem 0 1rem}
.bubble{max-width:min(78%,680px);padding:.68rem .88rem;border-radius:15px;margin:.12rem 0;white-space:pre-wrap;word-break:break-word;font-size:.95rem;line-height:1.6;box-shadow:0 1px 1px rgba(45,30,49,.03)}
.user{background:var(--surface-raised);border:1px solid var(--border);margin-right:auto;border-bottom-left-radius:5px}
.assistant{background:var(--plum-50);border:1px solid var(--plum-100);margin-left:auto;border-bottom-right-radius:5px}
.turnrow{display:flex;flex-direction:column}
.turnrow .muted{font-size:.78rem;margin:.08rem .3rem .3rem}
.turnrow.assistant>.muted{text-align:right}
.client-facts{display:grid;gap:.7rem;margin:1rem 0}
.client-facts div{padding-top:.6rem;border-top:1px solid var(--border-soft)}
.client-facts dt{color:var(--ink-500);font-size:.72rem;font-weight:750;letter-spacing:.055em;text-transform:uppercase}
.client-facts dd{margin:.12rem 0 0;font-size:.9rem;overflow-wrap:anywhere}
details.tool{margin:.12rem 0;font-size:.82rem;color:var(--ink-500);border-left:2px solid var(--cream-200);padding-left:.55rem}
details.tool pre{white-space:pre-wrap;word-break:break-all;background:var(--cream-50);border:1px solid var(--border-soft);padding:.65rem;border-radius:var(--radius);margin:.35rem 0 0;font-size:.78rem;line-height:1.55}
details>summary{cursor:pointer}

/* navigation and utilities */
.jump-nav,.filters{display:flex;flex-wrap:wrap;gap:.35rem;margin:0 0 1rem;padding:.25rem;border:1px solid var(--border);border-radius:11px;background:var(--surface);width:max-content;max-width:100%;box-shadow:var(--shadow-1)}
.jump-nav a,.filters a{min-height:38px;display:inline-flex;align-items:center;font-size:.875rem;font-weight:620;color:var(--ink-500)!important;text-decoration:none;border-radius:8px;padding:.38rem .72rem}
.jump-nav a:hover,.filters a:hover,.jump-nav a.active,.filters a.active{background:var(--brand-soft);color:var(--brand)!important}
.row{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}
.row.between{justify-content:space-between}
.col{display:flex;flex-direction:column;gap:.72rem}
/* L'attribut [hidden] doit toujours l'emporter, même sur un élément à display
   explicite (ex. .col{display:flex}) — sinon un bloc masqué en JS reste visible
   (cas du bloc « Programmer » du formulaire livraison quand « Maintenant » est coché). */
[hidden]{display:none!important}
.actionbar{position:sticky;bottom:.7rem;z-index:8;margin-top:.5rem;padding:.7rem .8rem;display:flex;align-items:center;gap:.8rem;flex-wrap:wrap;background:rgba(251,247,242,.97);border:1px solid var(--border);border-radius:13px;box-shadow:var(--shadow-2);backdrop-filter:blur(10px)}
.savebar{display:none;position:sticky;top:calc(var(--topbar-h) + .5rem);z-index:9;align-items:center;justify-content:space-between;gap:.8rem;margin-bottom:.7rem;padding:.7rem .85rem;background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:11px;box-shadow:var(--shadow-1);font-size:.9rem;font-weight:650}
.planning-dialog{display:none;position:fixed;inset:0;z-index:50;align-items:center;justify-content:center;padding:1rem;background:rgba(31,20,33,.48);backdrop-filter:blur(2px)}
.planning-dialog-panel{width:min(100%,350px);padding:1.15rem;background:var(--surface-raised);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-2)}
.planning-dialog-title{margin:.1rem 0 .35rem;font-size:1.2rem}
.planning-dialog-actions{display:flex;gap:.5rem;justify-content:flex-end;margin-top:.9rem}
.staff-person{min-width:145px}
.copy-week-btn{display:block;margin-top:.35rem;white-space:nowrap}
.planning-copy-warning{display:grid;gap:.2rem;margin-top:.85rem;padding:.7rem .75rem;background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:10px;color:var(--ink-700);font-size:.84rem;line-height:1.45}
.planning-copy-warning span{color:var(--ink-500)}
#staffgrid td[data-k]:focus-visible{box-shadow:inset 0 0 0 3px var(--plum-400);background:var(--plum-50)}
.nowrap{white-space:nowrap}
.right{text-align:right}
.stack{display:grid;gap:.75rem}
.cluster{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.leaderboard-sync{margin:-.35rem 0 1rem}.leaderboard-search{margin-bottom:1rem}.leaderboard-search label{display:block;font-weight:700;margin-bottom:.45rem}.leaderboard-search>div{display:flex;gap:.5rem}.leaderboard-search input{flex:1;min-width:0}.leaderboard-search p{margin:.55rem 0 0;font-size:.82rem}.leaderboard-search-results{margin-bottom:1rem}.leaderboard-podium{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem;margin:1rem 0}.leaderboard-podium-card{display:grid;justify-items:center;text-align:center;gap:.22rem;padding:1rem;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow-1)}.leaderboard-podium-card--1{background:linear-gradient(135deg,#fff7dd,var(--surface))}.leaderboard-medal{font-size:1.35rem}.leaderboard-podium-card strong,.leaderboard-total b{font-size:2rem;line-height:1;color:var(--brand)}.leaderboard-podium-card span:last-child,.leaderboard-total span{font-size:.78rem;color:var(--ink-500)}.leaderboard-detail{margin-bottom:1rem}.leaderboard-total{display:grid;justify-items:end;gap:.2rem}.leaderboard-detail-grid{display:grid;grid-template-columns:minmax(180px,.65fr) minmax(0,1.35fr);gap:1rem}.leaderboard-detail h3{font-size:.9rem;margin:.2rem 0 .6rem}.leaderboard-breakdown{list-style:none;padding:0;margin:0}.leaderboard-breakdown li{display:flex;justify-content:space-between;gap:.75rem;padding:.42rem 0;border-bottom:1px solid var(--border)}

/* confirm dialog */
.confirm-dialog{width:min(92vw,430px);padding:0;border:0;border-radius:var(--radius-xl);background:var(--surface-raised);color:var(--ink-900);box-shadow:0 24px 80px rgba(31,20,33,.28)}
.confirm-dialog::backdrop{background:rgba(31,20,33,.48);backdrop-filter:blur(2px)}
.confirm-dialog-inner{padding:1.2rem}
.confirm-dialog h2{margin:0;font-size:1.15rem}
.confirm-dialog p{margin:.5rem 0 1rem;color:var(--ink-500);font-size:.9rem;line-height:1.6}
.confirm-dialog-actions{display:flex;justify-content:flex-end;gap:.5rem}

@media(max-width:1100px){
  :root{--sidebar-w:232px}
  main{padding-inline:1.25rem}
}
@media(max-width:900px){
  :root{--topbar-h:62px}
  .qualify-row{grid-template-columns:1fr}
  .sidebar,.nav-collapsed .sidebar{width:min(86vw,292px)!important;transform:translateX(-105%);box-shadow:18px 0 50px rgba(25,15,27,.24)}
  body.mobile-nav-open .sidebar{transform:translateX(0)}
  .main-wrap,body.nav-collapsed .main-wrap{margin-left:0}
  .nav-toggle{display:grid}
  .nav-collapse{display:none}
  .nav-scrim{display:block;position:fixed;inset:0;z-index:29;padding:0;border:0;background:rgba(31,20,33,.42);opacity:0;visibility:hidden;transition:opacity .18s ease,visibility .18s ease}
  body.mobile-nav-open .nav-scrim{opacity:1;visibility:visible}
  body.mobile-nav-open{overflow:hidden}
  body.nav-collapsed .brand-copy,body.nav-collapsed .nav-label,body.nav-collapsed .nav-section,body.nav-collapsed .sidebar-footer span{display:block}
  body.nav-collapsed .nav-badge{display:inline-flex}
  body.nav-collapsed .nav-group-toggle{display:flex}
  body.nav-collapsed .brand{justify-content:flex-start;padding:.45rem .55rem .8rem}
  body.nav-collapsed .sidebar a.nav-link{justify-content:flex-start;padding:.48rem .62rem}
  .topbar{padding-inline:.8rem;gap:.65rem}
  .topbar-title{max-width:32vw}
  .topbar-search{min-width:0;max-width:none}
  .search-key{display:none}
  main,main.content-standard,main.content-wide,main.content-full{max-width:none;padding:1.15rem .9rem 3.5rem}
  .conversation-shell{grid-template-columns:1fr}
  .client-summary{position:static}
  .activity-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .report-stat-grid,.report-breakdown{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ad-roas-grid{grid-template-columns:1.2fr 1fr 1fr}
  .menu-filters{grid-template-columns:repeat(2,minmax(0,1fr))}
  .follow-up-filters,.conversation-filters{grid-template-columns:repeat(2,minmax(0,1fr))}
  .menu-search,.menu-filter-actions{grid-column:1/-1}
}
@media(max-width:640px){
  .topbar-title{display:none}
  .topbar-search{width:100%}
  .page-header{flex-direction:column;align-items:stretch;margin-bottom:1rem}
  .page-header h2,.page-header h1{font-size:1.4rem}
  .page-header-actions{justify-content:flex-start}
  .activity-section-header{align-items:stretch;flex-direction:column}
  .period-toggle{width:100%}
  .period-toggle button{flex:1;min-width:0;padding-inline:.35rem}
  .card{padding:.85rem;border-radius:12px;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .stat-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem}
  .stat{padding:.78rem}
  .stat b{font-size:1.42rem}
  .activity-stat{min-height:132px}
  .activity-stat-label{align-items:flex-start;flex-direction:column;gap:.4rem}
  .follow-up-filters,.conversation-filters,.workspace-history-grid{grid-template-columns:1fr}
  .report-stat-grid,.report-breakdown{grid-template-columns:1fr}
  .ad-roas-grid{grid-template-columns:1fr}
  .key-memo-grid,.key-check-grid,.key-founders-layout,.key-catalogue-grid{grid-template-columns:1fr}
  .key-rule-card--wide{grid-column:auto}
  .key-memo-principle{align-items:start;padding:1rem}
  .key-memo-principle-icon{width:38px;height:38px}
  .key-memo-actions{width:100%}
  .key-memo-actions .act{flex:1}
  .key-memo-footer{align-items:flex-start;flex-direction:column}
  .resolution-form{position:fixed;inset:auto .75rem .75rem;width:auto;max-height:80vh;overflow:auto}
  .takeover-banner{align-items:flex-start;flex-direction:column}
  button.act,a.act{min-height:44px}
  .act--sm{min-height:38px!important}
  .task-item{grid-template-columns:auto minmax(0,1fr);align-items:start}
  .task-action{grid-column:2;justify-content:flex-start}
  .bubble{max-width:88%}
  td.hide-sm,th.hide-sm{display:none}
  .card>.table-wrap,.card>table{margin-inline:-.3rem;width:calc(100% + .6rem)}
  .responsive-table thead{display:none}
  .responsive-table,.responsive-table tbody,.responsive-table tr,.responsive-table td{display:block;width:100%}
  .responsive-table tr{padding:.55rem .1rem;border-bottom:1px solid var(--border);background:var(--surface)}
  .responsive-table tr:last-child{border-bottom:0}
  .responsive-table td{display:grid;grid-template-columns:minmax(92px,35%) minmax(0,1fr);gap:.55rem;padding:.32rem .45rem;border:0;align-items:start}
  .responsive-table td:before{content:attr(data-label);color:var(--ink-500);font-size:.72rem;font-weight:750;letter-spacing:.045em;text-transform:uppercase}
  .responsive-table td[data-label=""]:before{display:none}
  .responsive-table td[data-label=""]{display:block;padding-top:.55rem}
  .actionbar{bottom:.45rem;margin-inline:-.2rem;padding:.65rem}
  .statement-summary,.checklist-progress{align-items:flex-start;flex-direction:column}
  .payment-month-bar{grid-template-columns:1fr 1fr}.payment-month-bar form{grid-column:1/-1;grid-row:1}.payment-stat-grid,.payment-checklist ul,.payment-buckets{grid-template-columns:1fr 1fr}.payment-sticky-summary{position:static;grid-template-columns:1fr 1fr}.payment-sticky-summary .payment-primary-action{align-items:stretch;grid-column:1/-1}.payment-sync-line{text-align:left}
  .statement-summary>div:last-child,.finance-total{align-items:flex-start;text-align:left}
  .menu-stats,.menu-filters,.menu-form-grid,.recipe-editor{grid-template-columns:1fr}
  .leaderboard-podium{gap:.5rem}.leaderboard-podium-card{padding:.75rem .4rem}.leaderboard-podium-card strong,.leaderboard-total b{font-size:1.6rem}.leaderboard-detail-grid{grid-template-columns:1fr}.leaderboard-total{justify-items:start}.leaderboard-search>div{flex-direction:column}.leaderboard-search .act{width:100%}
  .menu-search,.menu-filter-actions,.menu-form-grid .menu-description,.menu-form-grid .menu-favourite,.recipe-editor .menu-editor-heading{grid-column:1}
  .choice-editor{grid-column:1;padding:.85rem}
  .choice-editor-heading,.choice-group-heading,.choice-responses-heading{align-items:flex-start;flex-direction:column}
  .choice-group{padding:.8rem}
  .choice-group-remove{width:100%;min-height:42px}
  .choice-response-row{grid-template-columns:2rem minmax(0,1fr)}
  .choice-response-row .choice-remove{grid-column:2;width:100%;min-height:42px}
  .choice-response-actions,.choice-group-actions{align-items:stretch;flex-direction:column}
  .choice-response-actions .act,.choice-group-actions .act{width:100%;min-height:46px}
  .menu-danger-zone{align-items:stretch;flex-direction:column}
}
@media(prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*:before,*:after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}
}
@media print{
  @page{size:A4;margin:12mm}
  body{background:#fff;font-size:10.5pt}
  .sidebar,.topbar,.nav-scrim,.confirm-dialog,.breadcrumbs,.key-memo-actions{display:none!important}
  .main-wrap,body.nav-collapsed .main-wrap{margin-left:0}
  main,main.content-standard{max-width:none;padding:0}
  .key-memo{max-width:none}
  .key-memo-header{margin-bottom:7mm}
  .key-memo-principle,.key-rule-card,.key-memo-footer{box-shadow:none;break-inside:avoid}
  .key-memo-grid{gap:4mm}
  .key-rule-card{padding:4mm}
  .key-rule-heading{margin-bottom:3mm;padding-bottom:3mm}
  .key-callout,.key-final-rule,.key-owner-note,.key-deadline{print-color-adjust:exact;-webkit-print-color-adjust:exact}
}
`;

/** Standalone login/access-control screens share the same premium first impression. */
export const ADMIN_AUTH_CSS = `
:root{color-scheme:light;--brand:#7c547d;--brand-strong:#684469;--brand-accent:#a98baa;--ink:#211a22;--muted:#665c68;--border:#ded3ca;--cream:#f5efe9;--surface:#fbf7f2;--surface-raised:#fefbf7;--plum-soft:#f8f4f8;--danger:#b63843;--danger-bg:#fff0f1}
*{box-sizing:border-box}
body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 0%,#faf6f1 0,transparent 35%),linear-gradient(145deg,#f5efe9 0%,#ece3dc 100%);color:var(--ink);font-size:16px;line-height:1.6;padding:1rem;-webkit-font-smoothing:antialiased}
.auth-card{position:relative;background:rgba(251,247,242,.98);border:1px solid rgba(222,211,202,.95);border-radius:20px;padding:1.65rem;width:100%;max-width:410px;box-shadow:0 24px 70px -35px rgba(45,30,49,.45);overflow:hidden}
.auth-card:before{content:"";position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,var(--brand-accent),var(--brand),var(--brand-accent))}
.auth-brand{display:flex;align-items:center;gap:.7rem;margin-bottom:1.25rem}
.auth-mark{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:var(--brand);color:#fff;font-family:Georgia,serif;font-size:1.35rem;font-weight:700}
.auth-brand b{display:block;font-family:Georgia,"Times New Roman",serif;font-size:1.3rem;letter-spacing:-.035em}
.auth-brand small{display:block;margin-top:.15rem;color:var(--muted);font-size:.68rem;font-weight:650;text-transform:uppercase;letter-spacing:.1em}
h1{font-size:1.4rem;line-height:1.3;letter-spacing:-.025em;margin:0 0 .35rem}
p{color:var(--muted);font-size:.94rem;margin:0 0 1.1rem;line-height:1.6}
label{display:block;font-size:.875rem;font-weight:700;margin:.8rem 0 .3rem;color:#48404a}
input{width:100%;min-height:44px;padding:.58rem .72rem;border:1px solid #cfc1b7;border-radius:10px;background:var(--surface-raised);color:var(--ink);font:inherit;font-size:.92rem;outline:none}
input:focus-visible{border-color:var(--brand);box-shadow:0 0 0 3px #f0e8f0}
button{width:100%;min-height:44px;margin-top:1rem;background:var(--brand);color:#fff;border:0;border-radius:10px;padding:.65rem;font:inherit;font-size:.94rem;font-weight:700;cursor:pointer;box-shadow:0 8px 18px -12px var(--brand)}
button:hover{background:var(--brand-strong)}
a{color:var(--brand);font-size:.875rem;text-underline-offset:2px}
.err{background:var(--danger-bg);border:1px solid #f1c8cc;color:var(--danger);border-radius:10px;padding:.65rem .75rem;margin-bottom:.9rem;font-size:.875rem}
.muted{color:var(--muted);font-size:.875rem;margin-top:1rem;text-align:center}
@media(max-width:480px){.auth-card{padding:1.3rem;border-radius:16px}}
`;
