/**
 * Shared horizontal-swipe navigation for the ops PWAs (salle ⇄ livraisons on
 * /ops/service, commandes ⇄ livraisons on /ops/owner). Inlined as a string into
 * each bundle so the gesture thresholds live in ONE place and can't drift
 * between the two boards. Attaches `window.__swipe`.
 *
 * Deliberately conservative — on a phone this competes with vertical list
 * scrolling, the composer's sideways category scroller, and text selection, so
 * a gesture only navigates when it is clearly horizontal, quick, single-finger,
 * and started outside anything that scrolls sideways or takes input. A missed
 * swipe is harmless (the tabs are still there); a false one yanks the board out
 * from under a thumb mid-scroll.
 */
export const OPS_SWIPE_HELPER = String.raw`(function(){
  var MIN_X=60;      // px of horizontal travel before it counts as intent
  var MAX_MS=800;    // slower than this is a drag/scroll, not a swipe
  var RATIO=2;       // must be twice as horizontal as it is vertical
  var SKIP='.ov,.chips,input,textarea,select,[data-noswipe]';
  function blocked(){ return !!document.querySelector('.ov'); }   // composer/dialog owns the screen
  function bind(onLeft,onRight){
    var x0=null,y0=0,t0=0;
    document.addEventListener('touchstart',function(e){
      x0=null;
      if(!e.touches||e.touches.length!==1)return;
      if(blocked())return;
      var t=e.target;
      if(t&&t.closest&&t.closest(SKIP))return;
      x0=e.touches[0].clientX;y0=e.touches[0].clientY;t0=Date.now();
    },{passive:true});
    document.addEventListener('touchend',function(e){
      var sx=x0;x0=null;
      if(sx==null||blocked())return;
      var t=e.changedTouches&&e.changedTouches[0];
      if(!t||Date.now()-t0>MAX_MS)return;
      var dx=t.clientX-sx,dy=t.clientY-y0;
      if(Math.abs(dx)<MIN_X)return;
      if(Math.abs(dx)<Math.abs(dy)*RATIO)return;   // vertical scrolling wins
      if(dx<0)onLeft();else onRight();
    },{passive:true});
  }
  window.__swipe={bind:bind};
})();`;
