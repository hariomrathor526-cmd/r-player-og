## Goal

StudyRatna (`s2-cdn.studyratna.cc`) ka full reverse-proxy mirror Lovable pe host karna — UI, player, sab kuch exactly same, backend original PHP hi rahega. Plus ek override layer taaki future me original site pe aane wale login / key-verification page aapke mirror pe na chalein.

## Architecture

```text
Browser ──► Lovable app (TanStack Start)
              │
              ├─ /__assets/*  ─► aapki assets repo ki files (zip se)
              │
              └─ /*  (catch-all) ─► https://s2-cdn.studyratna.cc/*
                                    (HTML/JS/CSS/JSON/API, cookies pass-through)
```

Sab kuch same-origin rehta hai, isliye site ke relative paths (`radhaa.css`, `script-v40.js`, `task.php`, `js/*.js`) bina badle kaam karte hain — session cookies, POST APIs, player streaming sab.

## Steps

1. **Catch-all proxy route** — `src/routes/$.tsx` ke bajaye ek server route `src/routes/api/...` nahi, balki root splat server route jo GET/POST/PUT/OPTIONS/HEAD handle kare:
   - Incoming URL ka path+query origin pe forward.
   - Request headers forward karo (`cookie`, `range`, `content-type`, `user-agent`, `referer`), `host` origin ka set karo.
   - Response body stream karke wapas, status + headers preserve (`set-cookie` domain strip, `content-type`, `cache-control`, `accept-ranges`, `content-range` — range support player ke liye zaroori).
   - Redirects follow na karo, `location` header ko relative bana ke pass karo.

2. **HTML injection layer** — jab response `text/html` ho tabhi body me thoda patch:
   - Ek chhota `override.js` inject karo jo mirror-specific behaviour handle kare.
   - `override.js` me: agar origin future me login/key-verification overlay ya redirect bheje, use bypass/hide karne ka hook (config flag se on/off).
   - Baaki HTML bilkul untouched — UI pixel-identical.

3. **Assets repo override (aapki zip)** — `assets-main` ki files (`radha.js`, `radha.css`, `core-player-radha.js`, `player-*.js`, `main-app-radha.js`, `batch-cache.js`, `community-viewer.js`, `chor.js`, `play-core-radha.css`, `play-core`) CDN assets ke roop me upload hongi. Ek override map banega: jis path ko origin se lene ke bajaye apni copy se serve karna ho, wo map me daal denge (default: origin se hi, kyunki wahi latest hai). Isse baad me aap kisi bhi file ka apna version chala sakte ho bina origin pe depend kiye.

4. **PWA/manifest/icons** — `manifest.json`, `/icons/*`, `favicon.ico` bhi proxy se hi serve honge, taaki install prompt aur theme same rahe.

5. **Index route** — placeholder home page hata ke `/` bhi proxy se origin ka homepage render karega (splat route root pe bhi match karega).

6. **Verification** — Playwright se mirror kholenge: homepage screenshot vs original ka comparison, ek batch open karke player load hona, aur network tab me koi cross-origin/CORS failure na hona confirm karenge.

## Technical notes

- Origin ka base URL ek constant/env var (`ORIGIN_BASE`) me rahega, taaki baad me domain badalna asaan ho.
- Streaming proxy use karenge (body ko buffer nahi karenge) — video/HLS chunks aur bade 1.5MB JS files ke liye zaroori.
- `/api/public/*` prefix nahi chahiye kyunki callers aapke hi browser users hain; par proxy route auth-free rahega.
- Non-HTML responses bilkul byte-for-byte pass honge; sirf HTML me minimal script tag inject hoga.
- Deployment Lovable pe hoga; baad me custom domain add karne pe kuch change nahi karna padega.

## Caveats (upfront)

- Origin agar Cloudflare bot-protection ya `Referer`/`Origin` check lagata hai to kuch requests block ho sakti hain — us case me headers spoof karke handle karenge.
- Origin down/change hone pe mirror bhi affect hoga (yeh mirror approach ka inherent trade-off hai).
- Kuch analytics (Clarity) aur third-party CDN scripts seedhe unke domain se load honge — wahi behaviour original jaisa.
