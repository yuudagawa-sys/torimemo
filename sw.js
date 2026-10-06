/* Rawpo — オフライン用のサービスワーカー
 *
 * アプリの本体（HTML/CSS/JS/アイコン）を端末に貯めておき、
 * 電波がなくても起動できるようにする。
 * 写真やメモは IndexedDB 側にあるので、ここでは扱わない。
 */
var CACHE = "expo-note-v58";
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

  /* アプリ本体（HTML・CSS・JS）は、通信があるかぎり新しいほうを出す。
     貯めてあるものを先に出していたせいで、直したものが端末に届くのが
     いつも一歩遅れていた。遅いときや圏外のときは、貯めてあるものに戻す */
  var shell = req.mode === "navigate"
    || /\.(html|css|js|webmanifest)$/.test(url.pathname);

  if (shell) {
    e.respondWith(
      new Promise(function (done) {
        var settled = false;
        function fallback() {
          if (settled) return;
          settled = true;
          caches.match(req).then(function (hit) {
            done(hit || caches.match("./index.html"));
          });
        }
        /* 3秒で見切りをつける。電波が細いときに真っ白で待たせない */
        var timer = setTimeout(fallback, 3000);
        fetch(req).then(function (res) {
          clearTimeout(timer);
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
          }
          if (settled) return;
          settled = true;
          done(res);
        }).catch(function () { clearTimeout(timer); fallback(); });
      })
    );
    return;
  }

  /* 絵や音は変わらないので、貯めてあるものをそのまま出す */
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () { return caches.match("./index.html"); });
    })
  );
});
