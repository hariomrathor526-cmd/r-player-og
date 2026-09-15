import { isRebrandable, rebrand } from "./mirror-branding";
import { getOverrideUrl } from "./mirror-asset-overrides";
import {
  GATE_BYPASS_COOKIES,
  GATE_ENABLED,
  GATE_GUARD_SCRIPT,
  isGatePath,
  isGateUrl,
} from "./mirror-gate";

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
const MEDIA_PROXY_PREFIX = "/__media_proxy__/";
// Hosts that should never be routed through the media proxy (same-origin app
// paths or the origin host itself, which is handled by the main proxy).

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
  function unmap(u){
    try { var p = new URL(u, real.href); return p.host === HN || p.host === H ? real.origin + p.pathname + p.search + p.hash : u; }
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
    set href(v){ real.href = unmap(v); },
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
    assign: function(u){ return real.assign(unmap(u)); },
    replace: function(u){ return real.replace(unmap(u)); },
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
      if (k === "origin") return O;
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

  // Because the page believes it lives on the origin host, app code builds
  // absolute origin URLs for its own APIs. Those would be cross-origin here
  // and get blocked by CORS, so send them back through the mirror.
  function toMirror(u){
    try {
      var p = new URL(String(u), real.href);
      if (p.hostname === HN) return real.origin + p.pathname + p.search + p.hash;
      if (p.hostname === real.hostname) return u;
      if (p.protocol !== "http:" && p.protocol !== "https:") return u;
      // Route every other cross-origin request through the mirror so the
      // response is same-origin and CORS-safe.
      return real.origin + ${JSON.stringify(MEDIA_PROXY_PREFIX)} + p.host + p.pathname + p.search + p.hash;
    } catch (e) { return u; }
  }
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function(input, init){
      try {
        if (typeof input === "string" || input instanceof URL) {
          input = toMirror(input);
        } else if (input && input.url) {
          var mapped = toMirror(input.url);
          if (mapped !== input.url) input = new Request(mapped, input);
        }
      } catch (e) {}
      return nativeFetch.call(this, input, init);
    };
  }
  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url){
    var args = Array.prototype.slice.call(arguments);
    args[1] = toMirror(url);
    return xhrOpen.apply(this, args);
  };
  if (navigator.sendBeacon) {
    var beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data){ return beacon(toMirror(url), data); };
  }
  window.__mirrorToMirror = toMirror;
})();
</script>`;

/** Wraps a domain-locked origin bundle so its global scope sees the spoofed host. */
function wrapLockedScript(source: string): string {
  return `;(function(){ with (window.__mirrorScope || window) { ${source}\n} })();`;
}



/** Paths whose INLINE scripts are domain-locked and must run in the mirror scope. */
const LOCKED_INLINE_HTML = [/^\/play\.php$/i, /player/i];

/**
 * Rewrites bare `location` reads inside inline origin scripts to the spoofed
 * origin location. A `with (...)` wrapper cannot be used here: function
 * declarations inside a `with` block stop being global, which breaks the
 * player's inline handlers.
 */
function wrapInlineScripts(html: string): string {
  return html.replace(
    /<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi,
    (match, attrs: string, body: string) => {
      if (/data-mirror-(shim|override)/i.test(attrs)) return match;
      if (/type\s*=\s*["']?(module|application\/json|application\/ld\+json|text\/template)/i.test(attrs))
        return match;
      if (!body.trim()) return match;
      // Heavily obfuscated origin bundles resolve identifiers at runtime via
      // eval, so a textual rewrite cannot reach them: run them in the scope
      // proxy instead.
      if (/eval\(/.test(body) && /[\u0250-\u2C7F]/.test(body)) {
        return `<script${attrs}>with (window.__mirrorScope || window) {\n${body}\n}</script>`;
      }
      const patched = body
        .replace(
          /(^|[^\w$.'"`])(?:window\s*\.\s*|document\s*\.\s*)?location(\s*\.)/g,
          (m, pre: string, post: string) =>
            `${pre}(window.__mirrorLocation||location)${post}`,
        )
        .replace(
          /(^|[^\w$.'"`])document\s*\.\s*domain\b/g,
          (m, pre: string) => `${pre}((window.__mirrorLocation||location).hostname)`,
        );
      return `<script${attrs}>${patched}</script>`;
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

/**
 * Adds a "Powered by MARCO" watermark on every batch/banner image card.
 * Injected on every proxied HTML page regardless of INJECT_OVERRIDE.
 */
const BANNER_WATERMARK_SCRIPT = `<style data-mirror-watermark>
.batch-image,.batch-card,.banner,.course-card,.batch-item{position:relative!important;overflow:hidden!important;}
.batch-image::after,.batch-card::after,.banner::after,.course-card::after,.batch-item::after{
  content:"";
  position:absolute;right:0;bottom:0;
  width:38%;height:46%;
  max-width:180px;max-height:96px;
  min-width:110px;min-height:60px;
  pointer-events:none;z-index:20;
  background-repeat:no-repeat;
  background-position:right bottom;
  background-size:100% 100%;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 160' preserveAspectRatio='none'><path d='M300 20 C 220 40 140 80 60 160 L 300 160 Z' fill='%23FCD34D'/><path d='M300 60 C 240 70 170 100 110 160 L 300 160 Z' fill='%23F5B841' opacity='.55'/><g font-family=\"Poppins,Segoe UI,Roboto,system-ui,sans-serif\" font-weight='800' fill='%23111'><text x='210' y='108' font-size='22' text-anchor='middle'>Powered by</text><text x='210' y='140' font-size='36' text-anchor='middle' letter-spacing='1'>MARCO</text><path d='M170 146 Q 210 154 250 146' stroke='%23111' stroke-width='3' fill='none' stroke-linecap='round'/></g></svg>");
}
</style>`;


export function getOriginBase(): string {
  return ORIGIN_BASE;
}

function buildUpstreamUrl(request: Request): URL {
  const incoming = new URL(request.url);
  if (incoming.pathname.startsWith(MEDIA_PROXY_PREFIX)) {
    const rest = incoming.pathname.slice(MEDIA_PROXY_PREFIX.length);
    const slash = rest.indexOf("/");
    const host = slash === -1 ? rest : rest.slice(0, slash);
    const subpath = slash === -1 ? "/" : rest.slice(slash);
    const mediaUpstream = new URL(`https://${host}${subpath}`);
    mediaUpstream.search = incoming.search;
    return mediaUpstream;
  }
  const upstream = new URL(ORIGIN_BASE);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  return upstream;
}

function isMediaProxyRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith(MEDIA_PROXY_PREFIX);
}

function applyProxyCors(headers: Headers, request: Request): void {
  const requestOrigin = request.headers.get("origin") ?? new URL(request.url).origin;

  // Media providers often echo the origin site here. That value is wrong after
  // the response has passed through the mirror, so expose the mirror instead.
  headers.set("access-control-allow-origin", requestOrigin);
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "Range, Content-Type, Origin, Accept, Authorization, X-Requested-With",
  );
  headers.set("access-control-expose-headers", "Accept-Ranges, Content-Length, Content-Range, Content-Type");
  headers.set("access-control-max-age", "86400");
}

function buildUpstreamHeaders(request: Request, upstream: URL): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  headers.set("host", upstream.host);
  const origin = new URL(ORIGIN_BASE);
  headers.set("origin", origin.origin);

  if (!GATE_ENABLED) {
    const existing = headers.get("cookie");
    headers.set(
      "cookie",
      existing ? `${existing}; ${GATE_BYPASS_COOKIES}` : GATE_BYPASS_COOKIES,
    );
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const parsed = new URL(referer);
      headers.set("referer", origin.origin + parsed.pathname + parsed.search);
    } catch {
      headers.set("referer", origin.origin + "/");
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

function buildDownstreamHeaders(
  upstreamResponse: Response,
  upstream: URL,
  request: Request,
): Headers {
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

  if (isMediaProxyRequest(request)) applyProxyCors(headers, request);

  return headers;
}

function rewriteCookie(cookie: string): string {
  return cookie
    .split(";")
    .filter((part) => !/^\s*domain=/i.test(part))
    .join(";");
}

function rewriteLocation(location: string, upstream: URL): string {
  if (/^https?:\/\/(?:www\.)?t\.me\//i.test(location)) {
    return "https://t.me/official_marco_22";
  }
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

  // Gate guard runs right after the host shim, before any origin script.
  if (!GATE_ENABLED && !out.includes("data-mirror-gate")) {
    out = /<head[^>]*>/i.test(out)
      ? out.replace(/<head[^>]*>/i, (m) => `${m}\n${GATE_GUARD_SCRIPT}`)
      : GATE_GUARD_SCRIPT + out;
  }

  if (LOCKED_INLINE_HTML.some((re) => re.test(upstream.pathname))) {
    out = wrapInlineScripts(out);
  }

  if (!out.includes("data-mirror-watermark")) {
    out = /<\/head>/i.test(out)
      ? out.replace(/<\/head>/i, `${BANNER_WATERMARK_SCRIPT}\n</head>`)
      : BANNER_WATERMARK_SCRIPT + out;
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

  // The browser may preflight a media request when Range or other playback
  // headers are present. Answer it at the mirror so the origin's CORS policy
  // cannot block playback before the media request is sent.
  if (method === "OPTIONS" && isMediaProxyRequest(request)) {
    const headers = new Headers({ "content-length": "0" });
    applyProxyCors(headers, request);
    return new Response(null, { status: 204, headers });
  }

  // Locked gate paths: frozen at their current (non-existent) origin state.
  if (!GATE_ENABLED && isGatePath(upstream.pathname)) {
    if (method === "GET" || method === "HEAD") {
      return new Response(null, { status: 302, headers: { location: "/" } });
    }
    return new Response(JSON.stringify({ status: true, verified: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

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

  const headers = buildDownstreamHeaders(upstreamResponse, upstream, request);

  // Never let the origin redirect our users into a future gate page.
  if (!GATE_ENABLED && upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    const loc = headers.get("location");
    if (loc && isGateUrl(loc, upstream.toString())) {
      headers.set("location", "/");
    }
  }

  if (isHtml(upstreamResponse) && upstreamResponse.status < 400) {
    const html = rebrand(injectHtml(await upstreamResponse.text(), upstream));
    headers.delete("content-length");
    return new Response(html, { status: upstreamResponse.status, headers });
  }

  if (LOCKED_SCRIPTS.has(upstream.pathname) && upstreamResponse.status < 400) {
    const js = rebrand(wrapLockedScript(await upstreamResponse.text()));
    headers.delete("content-length");
    return new Response(js, { status: upstreamResponse.status, headers });
  }

  if (
    upstreamResponse.status < 400 &&
    isRebrandable(upstreamResponse.headers.get("content-type") ?? "")
  ) {
    const body = rebrand(await upstreamResponse.text());
    headers.delete("content-length");
    return new Response(body, { status: upstreamResponse.status, headers });
  }


  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
