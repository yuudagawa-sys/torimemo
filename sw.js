/* Rawpo — オフライン用のサービスワーカー
 *
 * アプリの本体（HTML/CSS/JS/アイコン）を端末に貯めておき、
 * 電波がなくても起動できるようにする。
 * 写真やメモは IndexedDB 側にあるので、ここでは扱わない。
 */
var CACHE = "expo-note-v30";
var SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        /* 新しい版を入れるときは、必ずサーバーから取り直す。
           ブラウザの手持ちを使うと、古いままが貯まり直ってしまう */
        return c.add(new Request(u, { cache: "reload" }))
          .catch(function () { return c.add(u).catch(function () { /* 1つ失敗しても導入は続ける */ }); });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;

  /* 書体は取れたぶんだけ貯めておく（取れなければ端末の書体で表示される） */
  if (!sameOrigin) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
          return res;
        });
      })
    );
    return;
  }

  /* アプリ本体は、まず貯めてあるものを出して、裏で新しいものを取りに行く */
  e.respondWith(
    caches.match(req).then(function (hit) {
      var live = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () { return hit || caches.match("./index.html"); });
      return hit || live;
    })
  );
});
