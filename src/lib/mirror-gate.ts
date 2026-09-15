/**
 * Gate lock layer for the mirror.
 *
 * The origin site may add a login / task-verification / key-generation flow in
 * the future. This module freezes the mirror at the CURRENT origin state
 * (no gate at all) so those pages never reach our users.
 *
 * The upstream remains responsible for its own login and verification rules.
 */

/** Keep upstream authentication and verification enabled. */
export const GATE_ENABLED = true;

/**
 * Paths that are locked to their current state. Right now every one of these
 * is a 302 / non-existent page on the origin, so we keep them that way even if
 * the origin starts serving a real verification page.
 */
const GATE_PATH_PATTERNS: RegExp[] = [
  /task[-_]?verify/i,
  /verify[-_]?task/i,
  /^\/verify(\.php)?$/i,
  /^\/login(\.php)?$/i,
  /^\/signin(\.php)?$/i,
  /^\/auth(\.php)?$/i,
  /key[-_]?(gen|generate|generation|verify|verification)/i,
  /^\/key(\.php)?$/i,
  /^\/activate(\.php)?$/i,
  /^\/activation(\.php)?$/i,
  /^\/unlock(\.php)?$/i,
  /^\/gate(\.php)?$/i,
  /^\/license(\.php)?$/i,
];

export function isGatePath(pathname: string): boolean {
  return GATE_PATH_PATTERNS.some((re) => re.test(pathname));
}

/** True when a URL (absolute or relative) points at a locked gate page. */
export function isGateUrl(url: string, base: string): boolean {
  try {
    return isGatePath(new URL(url, base).pathname);
  } catch {
    return isGatePath(url);
  }
}

/**
 * Retained as an exported compatibility value for existing imports. It is not
 * injected while GATE_ENABLED is true.
 */
export const GATE_GUARD_SCRIPT = `<script data-mirror-gate>
(function(){
  if (${GATE_ENABLED}) return;
  var P = ${JSON.stringify(GATE_PATH_PATTERNS.map((r) => r.source))}.map(function(s){ return new RegExp(s, "i"); });
  function isGate(u){
    try { var p = new URL(String(u), location.href).pathname; return P.some(function(r){ return r.test(p); }); }
    catch (e) { return false; }
  }
  // Pretend verification already happened.
  try {
    ${JSON.stringify(["task_verified", "taskverify", "verified", "key_verified", "is_verified", "access_granted"])}
      .forEach(function(k){ try { localStorage.setItem(k, "1"); } catch (e) {} });
    ${JSON.stringify(["task_verified=1", "taskverify=1", "verified=1", "key_verified=1", "is_verified=1", "access_granted=1"])}
      .forEach(function(c){ try { document.cookie = c + "; path=/"; } catch (e) {} });
  } catch (e) {}

  // Block navigation to gate pages.
  var assign = location.assign.bind(location);
  var replace = location.replace.bind(location);
  try { location.assign = function(u){ if (!isGate(u)) assign(u); }; } catch (e) {}
  try { location.replace = function(u){ if (!isGate(u)) replace(u); }; } catch (e) {}
  ["pushState","replaceState"].forEach(function(m){
    var orig = history[m];
    history[m] = function(s,t,u){ if (u && isGate(u)) return; return orig.apply(history, arguments); };
  });
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (a && isGate(a.getAttribute("href"))) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener("beforeunload", function(){}, false);

  // Hide any gate overlay that gets injected into the DOM.
  var HINTS = ["task-verify","taskverify","task_verify","key-verify","key_verification","keygen","key-gen","verify-overlay","verification","license","activation","gate-overlay","login-overlay","auth-gate","unlock-overlay"];
  function looksLikeGate(el){
    if (!el || el.nodeType !== 1 || !el.getAttribute) return false;
    var s = ((el.id || "") + " " + (el.className && el.className.toString ? el.className.toString() : "")).toLowerCase();
    for (var i = 0; i < HINTS.length; i++) if (s.indexOf(HINTS[i]) !== -1) return true;
    return false;
  }
  function sweep(root){
    try {
      var nodes = (root || document).querySelectorAll("div,section,dialog,aside,iframe,form");
      for (var i = 0; i < nodes.length; i++) if (looksLikeGate(nodes[i])) nodes[i].remove();
      if (document.body && document.body.style.overflow === "hidden") document.body.style.overflow = "";
    } catch (e) {}
  }
  new MutationObserver(function(muts){
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        if (looksLikeGate(added[j])) { try { added[j].remove(); } catch (e) {} }
        else if (added[j].nodeType === 1) sweep(added[j]);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", function(){ sweep(); });
  setTimeout(function(){ sweep(); }, 800);
  setTimeout(function(){ sweep(); }, 2500);
})();
</script>`;
