/*
 * Beacon service worker.
 *
 * Security model: authenticated data is never cached. Only immutable build
 * assets (/_next/static/*) and app icons are cached (cache-first). API calls,
 * React Server Component payloads, auth pages and cross-origin requests always
 * go to the network. Page navigations are network-first and are NOT cached;
 * when offline they get a static fallback page that contains no user data.
 *
 * Bump VERSION on every change: activation deletes caches from older versions.
 * A {type: "CLEAR_CACHES"} message (sent on sign-out) deletes every cache.
 */
const VERSION = "beacon-v2-2026-11-24";
const STATIC_CACHE = VERSION + "-static";
const PRECACHE = ["/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

const OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="theme-color" content="#3B82F6"><title>Offline · Beacon</title>' +
  "<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  "font-family:system-ui,-apple-system,sans-serif;background:#fff;color:#111;padding:24px;box-sizing:border-box}" +
  "@media (prefers-color-scheme:dark){body{background:#0b1120;color:#f1f5f9}}" +
  "main{max-width:360px;text-align:center}h1{font-size:1.4rem;margin:0 0 8px}p{margin:0 0 20px;opacity:.75;line-height:1.5}" +
  "a{display:inline-block;background:#3B82F6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600}</style>" +
  '</head><body><main><img src="/icon-192.png" alt="" width="64" height="64" style="border-radius:14px;margin-bottom:16px">' +
  "<h1>You&#39;re offline</h1><p>Beacon needs a connection to load your workspace. Check your connection and try again.</p>" +
  '<a href="">Try again</a></main></body></html>';

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION + "-")).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "CLEAR_CACHES") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

function isNetworkOnly(request, url) {
  if (url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith("/api/")) return true;
  if (url.pathname.startsWith("/sign-in") || url.pathname.startsWith("/sign-up")) return true;
  if (url.searchParams.has("_rsc")) return true;
  if (request.headers.get("RSC") === "1" || request.headers.has("Next-Router-State-Tree")) return true;
  return false;
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    /^\/icon[^/]*\.png$/.test(url.pathname) ||
    url.pathname === "/apple-touch-icon.png"
  );
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.status === 200 && response.type === "basic") {
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstNavigation(request) {
  try {
    // Never cached: pages carry the signed-in user's data.
    return await fetch(request);
  } catch (err) {
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // let the browser handle it (never cached)
  const url = new URL(request.url);
  if (isNetworkOnly(request, url)) return; // default network handling, no caching
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
  // Everything else: default network handling, no caching.
});
