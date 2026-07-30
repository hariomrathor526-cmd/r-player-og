import { getOverrideUrl } from "./mirror-asset-overrides";

/** Origin bundles that are domain-locked and must run inside the mirror scope. */
const LOCKED_SCRIPTS = new Set(["/script-v40.js"]);

/** Set to false to serve origin HTML completely untouched. */
const INJECT_OVERRIDE = false;


/**
 * Reverse-proxy layer for the StudyRatna mirror.
 *
 * Every request that is not handled by the app itself is forwarded to the
 * origin site. Responses are streamed back byte-for-byte so the player,
 * range requests and the original PHP backend keep working unchanged.
 */

const ORIGIN_BASE = process.env.ORIGIN_BASE ?? "https://s2-cdn.studyratna.cc";

/** Request headers we never forward upstream. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

/** Response headers we never forward downstream. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "strict-transport-security",
  "content-security-policy",
  "content-security-policy-report-only",
  "report-to",
  "nel",
  "alt-svc",
]);

/**
 * Injected at the very top of <head>. The origin bundle is domain-locked
 * (it traps into infinite recursion on a foreign host), so every location /
 * document identity read is spoofed back to the origin host. Native
 * navigation and fetch are untouched, so relative URLs still hit the mirror.
 */
const HOST_SHIM_SCRIPT = (originHost: string, originOrigin: string) => `<script data-mirror-shim>
(function(){
  var H = ${JSON.stringify(originHost)};
  var O = ${JSON.stringify(originOrigin)};
  var HN = H.split(":")[0];
  function map(u){
    try { var p = new URL(u, location.href); return p.host === location.host ? O + p.pathname + p.search + p.hash : u; }
    catch (e) { return u; }
  }
  function patch(proto, prop, get){
    try {
      var d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.configurable) return;
      Object.defineProperty(proto, prop, { configurable: true, enumerable: d.enumerable, get: get, set: d.set });
    } catch (e) {}
  }
  patch(Document.prototype, "URL", function(){ return map(location.href); });
  patch(Document.prototype, "documentURI", function(){ return map(location.href); });
  patch(Document.prototype, "referrer", function(){ return O + "/"; });
  patch(Document.prototype, "domain", function(){ return HN; });
  patch(Node.prototype, "baseURI", function(){ return map(location.href); });

  // location is [Unforgeable], so instead expose a spoofed stand-in that the
  // wrapped origin bundle resolves through a "with(__mirrorScope)" scope.
  var real = window.location;
  var fake = {
    get href(){ return map(real.href); },
    set href(v){ real.href = v; },
    get host(){ return H; },
    get hostname(){ return HN; },
    get origin(){ return O; },
    get protocol(){ return "https:"; },
    get port(){ return ""; },
    get pathname(){ return real.pathname; },
    get search(){ return real.search; },
    get hash(){ return real.hash; },
    set pathname(v){ real.pathname = v; },
    set search(v){ real.search = v; },
    set hash(v){ real.hash = v; },
    assign: function(u){ return real.assign(u); },
    replace: function(u){ return real.replace(u); },
    reload: function(){ return real.reload(); },
    toString: function(){ return map(real.href); },
  };
  var fnCache = new WeakMap();
  var windowProxy = new Proxy(window, {
    has: function(t, k){
      return k === "location" || k in t;
    },
    getOwnPropertyDescriptor: function(t, k){
      if (k === Symbol.unscopables) return undefined;
      return Object.getOwnPropertyDescriptor(t, k);
    },
    get: function(t, k){
      if (k === "location") return fake;
      if (k === "window" || k === "self" || k === "globalThis" || k === "top" || k === "parent") return windowProxy;
      // eval must stay the exact intrinsic, otherwise direct eval becomes
      // indirect eval and the bundle loses its closure scope.
      if (k === "eval" || k === "Function") return t[k];
      var v = t[k];
      if (typeof v !== "function") return v;
      var cached = fnCache.get(v);
      if (cached) return cached;
      var wrapped = new Proxy(v, {
        apply: function(fn, thisArg, args){
          return Reflect.apply(fn, (thisArg === windowProxy || thisArg == null) ? window : thisArg, args);
        },
        construct: function(fn, args, nt){ return Reflect.construct(fn, args, nt === wrapped ? fn : nt); },
      });
      fnCache.set(v, wrapped);
      return wrapped;
    },
    set: function(t, k, v){ if (k !== "location") { t[k] = v; } else { real.href = v; } return true; },
  });
  patch(Document.prototype, "location", function(){ return fake; });
  window.__mirrorLocation = fake;
  window.__mirrorScope = windowProxy;
})();
</script>`;

/** Wraps a domain-locked origin bundle so its global scope sees the spoofed host. */
function wrapLockedScript(source: string): string {
  return `;(function(){ with (window.__mirrorScope || window) { ${source}\n} })();`;
}



/** Paths whose INLINE scripts are domain-locked and must run in the mirror scope. */
const LOCKED_INLINE_HTML = [/^\/play\.php$/i, /player/i];

/**
 * Top-level `with (...)` keeps var/function declarations global (sloppy mode),
 * so inline origin scripts keep exporting their globals while `location`
 * resolves to the spoofed origin location.
 */
function wrapInlineScripts(html: string): string {
  return html.replace(
    /<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi,
    (match, attrs: string, body: string) => {
      if (/data-mirror-(shim|override)/i.test(attrs)) return match;
      if (/type\s*=\s*["']?(module|application\/json|application\/ld\+json|text\/template)/i.test(attrs))
        return match;
      if (!body.trim()) return match;
      return `<script${attrs}>with (window.__mirrorScope || window) {\n${body}\n}</script>`;
    },
  );
}

/**
 * Inline script injected into every proxied HTML document. Keeps the mirror
 * independent from any future login / key-verification gate added on the
 * origin site. Flip BYPASS_GATE to false to let origin gates through.
 */
const OVERRIDE_SCRIPT = `<script data-mirror-override>

(function(){
  var BYPASS_GATE = true;
  if (!BYPASS_GATE) return;
  var GATE_HINTS = ["key-verify","key_verification","verify-key","license","activation","gate-overlay","login-overlay","auth-gate"];
  function looksLikeGate(el){
    if (!el || !el.getAttribute) return false;
    var id = (el.id || "") + " " + (el.className && el.className.toString ? el.className.toString() : "");
    id = id.toLowerCase();
    for (var i = 0; i < GATE_HINTS.length; i++) if (id.indexOf(GATE_HINTS[i]) !== -1) return true;
    return false;
  }
  function sweep(){
    try {
      var nodes = document.querySelectorAll("body > div, body > section");
      for (var i = 0; i < nodes.length; i++) {
        if (looksLikeGate(nodes[i])) nodes[i].style.display = "none";
      }
      if (document.body && document.body.style.overflow === "hidden") document.body.style.overflow = "";
    } catch (e) {}
  }
  document.addEventListener("DOMContentLoaded", sweep);
  setTimeout(sweep, 1200);
})();
</script>`;


export function getOriginBase(): string {
  return ORIGIN_BASE;
}

function buildUpstreamUrl(request: Request): URL {
  const incoming = new URL(request.url);
  const upstream = new URL(ORIGIN_BASE);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  return upstream;
}

function buildUpstreamHeaders(request: Request, upstream: URL): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  headers.set("host", upstream.host);
  headers.set("origin", upstream.origin);

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const parsed = new URL(referer);
      headers.set("referer", upstream.origin + parsed.pathname + parsed.search);
    } catch {
      headers.set("referer", upstream.origin + "/");
    }
  }

  if (!headers.has("user-agent")) {
    headers.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    );
  }

  return headers;
}

function buildDownstreamHeaders(upstreamResponse: Response, upstream: URL): Headers {
  const headers = new Headers();
  upstreamResponse.headers.forEach((value, key) => {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });

  // Cookies must be re-scoped to the mirror host.
  const setCookie =
    typeof (upstreamResponse.headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie === "function"
      ? (
          upstreamResponse.headers as unknown as { getSetCookie: () => string[] }
        ).getSetCookie()
      : upstreamResponse.headers.get("set-cookie")
        ? [upstreamResponse.headers.get("set-cookie") as string]
        : [];

  if (setCookie.length > 0) {
    headers.delete("set-cookie");
    for (const cookie of setCookie) {
      headers.append("set-cookie", rewriteCookie(cookie));
    }
  }

  // Keep redirects on the mirror instead of bouncing users to the origin.
  const location = headers.get("location");
  if (location) {
    headers.set("location", rewriteLocation(location, upstream));
  }

  return headers;
}

function rewriteCookie(cookie: string): string {
  return cookie
    .split(";")
    .filter((part) => !/^\s*domain=/i.test(part))
    .join(";");
}

function rewriteLocation(location: string, upstream: URL): string {
  try {
    const target = new URL(location, upstream);
    if (target.host === upstream.host) {
      return target.pathname + target.search + target.hash;
    }
    return location;
  } catch {
    return location;
  }
}

function isHtml(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("text/html");
}

function injectHtml(html: string, upstream: URL): string {
  let out = html;

  // Host shim must run before any origin script.
  if (!out.includes("data-mirror-shim")) {
    const shim = HOST_SHIM_SCRIPT(upstream.host, upstream.origin);
    out = /<head[^>]*>/i.test(out)
      ? out.replace(/<head[^>]*>/i, (m) => `${m}\n${shim}`)
      : shim + out;
  }

  if (LOCKED_INLINE_HTML.some((re) => re.test(upstream.pathname))) {
    out = wrapInlineScripts(out);
  }

  if (!INJECT_OVERRIDE) return out;
  if (out.includes("data-mirror-override")) return out;

  if (out.includes("</body>")) {
    return out.replace(/<\/body>/i, `${OVERRIDE_SCRIPT}\n</body>`);
  }
  return out + OVERRIDE_SCRIPT;
}

export async function proxyRequest(request: Request): Promise<Response> {
  const upstream = buildUpstreamUrl(request);
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const override = getOverrideUrl(upstream.pathname);
  if (override && (method === "GET" || method === "HEAD")) {
    return Response.redirect(new URL(override, request.url).toString(), 302);
  }



  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream.toString(), {
      method,
      headers: buildUpstreamHeaders(request, upstream),
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
    });
  } catch (error) {
    console.error("[mirror] upstream fetch failed", upstream.toString(), error);
    return new Response("Upstream unavailable", { status: 502 });
  }

  const headers = buildDownstreamHeaders(upstreamResponse, upstream);

  if (isHtml(upstreamResponse) && upstreamResponse.status < 400) {
    const html = injectHtml(await upstreamResponse.text(), upstream);
    headers.delete("content-length");
    return new Response(html, { status: upstreamResponse.status, headers });
  }

  if (LOCKED_SCRIPTS.has(upstream.pathname) && upstreamResponse.status < 400) {
    const js = wrapLockedScript(await upstreamResponse.text());
    headers.delete("content-length");
    return new Response(js, { status: upstreamResponse.status, headers });
  }


  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
