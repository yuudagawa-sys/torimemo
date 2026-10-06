/* Rawpo（ローポ）— ホーム画面アプリ版
 *
 * 写真・録音・録画・メモはすべて端末の中（IndexedDB）に入ります。
 * サーバーには何も送りません。通信が無くても動きます。
 */
(function () {
  "use strict";

  /* いまの版。sw.js の CACHE と同じ数にすること。
     切り替わったかどうかを、画面の側でも分かるようにしてある。
     黙って新しくなっていると、直したはずのものが
     届いているのか分からない */
  var APPVER = "69";

  /* ============================================================
     小道具
     ============================================================ */
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
  var clock = function (ms) {
    var s = Math.round((ms || 0) / 1000);
    return pad2(Math.floor(s / 60)) + ":" + pad2(s % 60);
  };
  var today = function () {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  };
  var uid = function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };
  var mb = function (b) {
    if (b == null) return "";
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + "GB";
    if (b >= 1048576) return (b / 1048576).toFixed(1) + "MB";
    if (b >= 1024) return Math.round(b / 1024) + "KB";
    return b + "B";
  };
  var safeName = function (s) {
    return String(s || "").replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "_").replace(/[\s-]+/g, "_").trim() || "無題";
  };

  var toastTimer = null;
  function toast(msg, bad) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast on" + (bad ? " bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast"; }, bad ? 5200 : 2600);
  }
  function progress(pct) {
    var b = $("bar");
    if (pct == null) { b.className = "bar"; b.style.width = "0"; return; }
    b.className = "bar on";
    b.style.width = Math.max(3, Math.min(100, pct)) + "%";
    if (pct >= 100) setTimeout(function () { b.className = "bar"; b.style.width = "0"; }, 380);
  }
  function why(e) {
    if (!e) return "原因不明のエラーです（詳細なし）。ページを再読み込みしてお試しください。";
    if (e.name === "QuotaExceededError" || (e.message || "").indexOf("quota") >= 0) {
      return "端末の空き容量が足りません。いらないフォルダを削除するか、写真アプリ側を整理してください。";
    }
    if (e.name === "SecurityError" || e.name === "InvalidStateError") {
      return "この画面では保存が許可されていません（" + e.name + "）。アプリとして開き直すと解決します。";
    }
    var m = e.message || String(e);
    /* 黙って合鍵を取り直せなかったときの合図。中の言葉なので、
       そのまま出すと「quiet」とだけ表示されてしまう */
    if (m === "quiet") {
      return "Googleとつながりませんでした。下の右端にある丸から、もう一度ログインしてください。";
    }
    if (e.name && e.name !== "Error" && m.indexOf(e.name) < 0) m += "（" + e.name + "）";
    return m;
  }

  /* ============================================================
     保存庫（IndexedDB）
     ============================================================ */
  /* ============================================================
     同期のための下ごしらえ
     二つの端末で同じものを触ったとき、どちらが新しいかを
     決められないと合わせようがない。そこで記録のひとつひとつに
     「いつ・どの端末で変えたか」を必ず持たせる。
     ============================================================ */
  /* 端末の見分け札。画面に出る呼び名と違い、こちらは変えない */
  function devId() {
    var v = recall("devid");
    if (!v) {
      v = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      remember("devid", v);
    }
    return v;
  }

  /* 時刻を持たせる置き場。blobs は中身が変わらないので要らない。
     変わったかどうかは、それを指しているアイテムのほうで分かる */
  var TRACKED = ["exhibitions", "items", "templates", "brands", "boards"];
  function tracked(store) { return TRACKED.indexOf(store) >= 0; }

  /* keep を立てると、すでに書いてある時刻をそのまま使う。
     ドライブから降ろしたものを、降ろした時刻で塗り潰さないため */
  function stamp(store, obj, keep) {
    if (!obj || !tracked(store)) return obj;
    if (keep) {
      if (!obj.upAt) { obj.upAt = Date.now(); obj.upBy = obj.upBy || devId(); }
      return obj;
    }
    obj.upAt = Date.now();
    obj.upBy = devId();
    return obj;
  }

  /* 消したという記録。これが無いと、消したことが相手に伝わらず、
     次に合わせたときに消したはずのものが戻ってきてしまう */
  function goneRec(store, id) {
    return { id: store + "/" + id, store: store, rid: id, upAt: Date.now(), upBy: devId() };
  }

  var DB = (function () {
    var NAME = "expo-photo-note", VER = 4, dbp = null;

    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        if (!window.indexedDB) { rej(new Error("このブラウザではデータを保存できません。")); return; }
        var r = indexedDB.open(NAME, VER);
        r.onupgradeneeded = function () {
          var d = r.result;
          if (!d.objectStoreNames.contains("exhibitions")) d.createObjectStore("exhibitions", { keyPath: "id" });
          if (!d.objectStoreNames.contains("brands")) d.createObjectStore("brands", { keyPath: "id" });
          if (!d.objectStoreNames.contains("items")) {
            var s = d.createObjectStore("items", { keyPath: "id" });
            s.createIndex("exId", "exId", { unique: false });
          }
          if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "id" });
          if (!d.objectStoreNames.contains("templates")) d.createObjectStore("templates", { keyPath: "id" });
          if (!d.objectStoreNames.contains("gone")) d.createObjectStore("gone", { keyPath: "id" });
          if (!d.objectStoreNames.contains("boards")) d.createObjectStore("boards", { keyPath: "id" });
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
        r.onblocked = function () { rej(new Error("ほかのタブでこのアプリが開いています。閉じてからお試しください。")); };
      });
      return dbp;
    }

    function run(stores, mode, fn) {
      return open().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction(stores, mode);
          var out;
          t.oncomplete = function () { res(out); };
          t.onerror = function () { rej(t.error); };
          t.onabort = function () { rej(t.error || new Error("保存を中断しました。")); };
          out = fn(t);
        });
      });
    }

    return {
      all: function (store) {
        var out = [];
        return run([store], "readonly", function (t) {
          t.objectStore(store).openCursor().onsuccess = function (e) {
            var c = e.target.result;
            if (c) { out.push(c.value); c.continue(); }
          };
          return out;
        });
      },
      byEx: function (exId) {
        var out = [];
        return run(["items"], "readonly", function (t) {
          t.objectStore("items").index("exId").openCursor(IDBKeyRange.only(exId)).onsuccess = function (e) {
            var c = e.target.result;
            if (c) { out.push(c.value); c.continue(); }
          };
          return out;
        });
      },
      /* 番号だけを読む。写真の実体まで読み出すと、
         どれが要るか調べるだけで端末の記憶があふれる */
      keys: function (store) {
        var out = [];
        return run([store], "readonly", function (t) {
          t.objectStore(store).openKeyCursor().onsuccess = function (e) {
            var c = e.target.result;
            if (c) { out.push(c.key); c.continue(); }
          };
          return out;
        });
      },
      get: function (store, id) {
        var box = {};
        return run([store], "readonly", function (t) {
          var r = t.objectStore(store).get(id);
          r.onsuccess = function () { box.v = r.result; };
          return box;
        }).then(function (b) { return b.v; });
      },
      /* 普通の保存。触った時刻を今に書き替え、
         「まだ送っていないものがある」と自動同期に知らせる。
         降ろしてきたものを入れる putRaw では知らせない。
         知らせると、受け取るたびに送り返して止まらなくなる */
      put: function (store, obj) {
        return run([store], "readwrite", function (t) { t.objectStore(store).put(stamp(store, obj)); return obj; })
          .then(function (r) { if (tracked(store)) touched(); return r; });
      },
      putMany: function (pairs) {
        var names = [];
        pairs.forEach(function (p) { if (names.indexOf(p[0]) < 0) names.push(p[0]); });
        return run(names, "readwrite", function (t) {
          pairs.forEach(function (p) { t.objectStore(p[0]).put(stamp(p[0], p[1])); });
        }).then(function (r) {
          if (pairs.some(function (p) { return tracked(p[0]); })) touched();
          return r;
        });
      },
      /* よそから降ろしたものを、書いてある時刻のまま入れる */
      putRaw: function (store, obj) {
        return run([store], "readwrite", function (t) { t.objectStore(store).put(stamp(store, obj, true)); return obj; });
      },
      putManyRaw: function (pairs) {
        var names = [];
        pairs.forEach(function (p) { if (names.indexOf(p[0]) < 0) names.push(p[0]); });
        if (!names.length) return Promise.resolve();
        return run(names, "readwrite", function (t) {
          pairs.forEach(function (p) { t.objectStore(p[0]).put(stamp(p[0], p[1], true)); });
        });
      },
      del: function (store, id) {
        var names = tracked(store) ? [store, "gone"] : [store];
        return run(names, "readwrite", function (t) {
          t.objectStore(store).delete(id);
          if (tracked(store)) t.objectStore("gone").put(goneRec(store, id));
        }).then(function (r) { if (tracked(store)) touched(); return r; });
      },
      delMany: function (pairs) {
        var names = [];
        pairs.forEach(function (p) { if (names.indexOf(p[0]) < 0) names.push(p[0]); });
        if (!names.length) return Promise.resolve();
        var any = pairs.some(function (p) { return tracked(p[0]); });
        if (any) names.push("gone");
        return run(names, "readwrite", function (t) {
          pairs.forEach(function (p) {
            t.objectStore(p[0]).delete(p[1]);
            if (tracked(p[0])) t.objectStore("gone").put(goneRec(p[0], p[1]));
          });
        }).then(function (r) { if (any) touched(); return r; });
      },
      /* よそから届いた「消した」を、その時刻のまま効かせる。
         ここで今の時刻を打つと、消した順番が狂う */
      dropRaw: function (pairs, tombs) {
        var names = ["gone"];
        pairs.forEach(function (p) { if (names.indexOf(p[0]) < 0) names.push(p[0]); });
        return run(names, "readwrite", function (t) {
          pairs.forEach(function (p) { t.objectStore(p[0]).delete(p[1]); });
          (tombs || []).forEach(function (g) { t.objectStore("gone").put(g); });
        });
      },
      wipe: function () {
        return run(["exhibitions", "brands", "items", "blobs", "gone", "boards"], "readwrite", function (t) {
          t.objectStore("boards").clear();
          t.objectStore("exhibitions").clear();
          t.objectStore("brands").clear();
          t.objectStore("items").clear();
          t.objectStore("blobs").clear();
          t.objectStore("gone").clear();
        });
      }
    };
  })();

  /* ============================================================
     ZIP（書き出し・読み込み。圧縮なしの格納方式だけ扱う）
     ============================================================ */
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return function (u8) {
      var c = 0xFFFFFFFF;
      for (var i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    };
  })();

  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xFFFF;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  }

  /* entries: [{name, u8, date}] → Blob */
  function zipWrite(entries) {
    var parts = [], central = [], offset = 0;
    var enc = new TextEncoder();

    entries.forEach(function (e) {
      var name = enc.encode(e.name);
      var crc = CRC(e.u8), size = e.u8.length;
      var d = e.date || new Date();
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 0x0800, true);     /* ファイル名はUTF-8 */
      h.setUint16(8, 0, true);          /* 無圧縮 */
      h.setUint16(10, dosTime(d), true);
      h.setUint16(12, dosDate(d), true);
      h.setUint32(14, crc, true);
      h.setUint32(18, size, true);
      h.setUint32(22, size, true);
      h.setUint16(26, name.length, true);
      h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, e.u8);

      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, dosTime(d), true);
      c.setUint16(14, dosDate(d), true);
      c.setUint32(16, crc, true);
      c.setUint32(20, size, true);
      c.setUint32(24, size, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);

      offset += 30 + name.length + size;
    });

    var cbytes = 0;
    central.forEach(function (u) { cbytes += u.length; });
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cbytes, true);
    end.setUint32(16, offset, true);

    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: "application/zip" });
  }

  /* Blob → [{name, u8}]（無圧縮の項目だけ読む） */
  function zipRead(buf) {
    var v = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
    var eocd = -1;
    for (var i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("バックアップのファイルとして読めませんでした。");
    var count = v.getUint16(eocd + 10, true), pos = v.getUint32(eocd + 16, true);
    var out = [];
    for (var n = 0; n < count; n++) {
      if (v.getUint32(pos, true) !== 0x02014b50) break;
      var method = v.getUint16(pos + 10, true);
      var size = v.getUint32(pos + 24, true);
      var nlen = v.getUint16(pos + 28, true);
      var elen = v.getUint16(pos + 30, true);
      var clen = v.getUint16(pos + 32, true);
      var lho = v.getUint32(pos + 42, true);
      var name = dec.decode(u8.subarray(pos + 46, pos + 46 + nlen));
      if (method === 0) {
        var lnlen = v.getUint16(lho + 26, true), lelen = v.getUint16(lho + 28, true);
        var start = lho + 30 + lnlen + lelen;
        out.push({ name: name, u8: u8.subarray(start, start + size) });
      }
      pos += 46 + nlen + elen + clen;
    }
    return out;
  }

  /* 書き出したものを渡す。
     指で使う端末では共有シートを開く（メール・LINE・AirDropへ）。
     パソコンではそのまま保存する。Mac の共有シートには
     「保存」が無く、いったんメモやメールに送るしかないため */
  function handOver(blob, filename) {
    var f = new File([blob], filename, { type: blob.type });
    if (!onDesktop() && navigator.canShare && navigator.canShare({ files: [f] })) {
      return navigator.share({ files: [f], title: filename })
        .then(function () { return "shared"; })
        .catch(function (e) {
          if (e && e.name === "AbortError") return "cancel";
          return download(blob, filename);
        });
    }
    return Promise.resolve(download(blob, filename));
  }
  function download(blob, filename) {
    var u = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = u; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 30000);
    return "downloaded";
  }

  /* ============================================================
     置き場所（チームで使うための土台）
     ------------------------------------------------------------
     フォルダを何人かで使うには、間に立つ置き場所が要る。
     いまはGoogleドライブに置いているが、あとで自前のサーバーに
     替えたくなったときのために、外とのやりとりはぜんぶ
     この Shelf を通す。画面側は下の決まった呼び出ししか
     使わないので、中身を入れ替えても画面は直さなくていい。

       Shelf.linked()    つないであるか
       Shelf.link()      つなぐ（相手に許可画面が出る）
       Shelf.unlink()    つなぎを切る
       Shelf.who()       つないだ人の名前
       Shelf.newRoom()   フォルダを1つ作る
       Shelf.room()      中にフォルダを1つ。あれば作らず、その番号を返す
       Shelf.put()       1件置く
       Shelf.get()       1件取る
       Shelf.list()      中に何があるか
       Shelf.drop()      1件消す
       Shelf.invite()    招くためのリンクを作る
     ============================================================ */

  /* Googleに登録したRawpoの名札。公開されている前提の値なので、
     ここに書いてあって問題ない。対になる「シークレット」は使わない */
  var G_ID = "1016605740338-ilj0tn76ll6q23gepb7aer4ndi4h4d2i.apps.googleusercontent.com";

  /* 「このアプリが作ったファイルだけ触れる」いちばん狭い権限。
     これより広げると相手のドライブ全部が見えてしまううえ、
     Googleの有料の審査も要るようになる */
  var G_SCOPE = "https://www.googleapis.com/auth/drive.file";

  /* 合鍵は画面を閉じれば消える。端末に書き残さない。
     残しておくと、端末を借りた人がそのまま使えてしまう */
  var gTok = null, gTokUntil = 0, gClient = null, gName = "";

  function gScript() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    return new Promise(function (ok, ng) {
      var s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = function () { ok(); };
      s.onerror = function () { ng(new Error("Googleに接続できませんでした。通信を確かめてください。")); };
      document.head.appendChild(s);
    });
  }

  /* quiet を true にすると、許可画面を出さずに合鍵だけ取り直す。
     一度つないだ人が、次に開いたときに何も押さずに済むように */
  /* 黙って取り直すとき、Googleから返事が来ないことがある。
     iPhoneをアプリとして開いているときに起きやすく、
     待ち続けると、同期そのものが「接続しています…」のまま
     永久に止まる。上限を決めて、来なければあきらめる */
  var G_WAIT_QUIET = 12000, G_WAIT_ASK = 120000;
  /* 黙って取り直せなかった時刻。しばらくは、黙って取り直す道を飛ばす。
     押したのに12秒待たされる、ということがないように */
  var gQuietDead = 0;

  function gKey(quiet) {
    if (gTok && Date.now() < gTokUntil) return Promise.resolve(gTok);
    return gScript().then(function () {
      return new Promise(function (ok, ng) {
        var done = false, timer = null;
        function win(t) { if (done) return; done = true; clearTimeout(timer); ok(t); }
        function lose(e) { if (done) return; done = true; clearTimeout(timer); ng(e); }
        if (!gClient) {
          gClient = google.accounts.oauth2.initTokenClient({
            client_id: G_ID, scope: G_SCOPE, callback: function () {}
          });
        }
        gClient.callback = function (res) {
          if (!res || res.error) {
            /* 黙って取り直そうとして断られただけなら、まだ手はある */
            return lose(new Error(quiet ? "quiet" : "許可が下りませんでした。"));
          }
          gTok = res.access_token;
          gTokUntil = Date.now() + ((res.expires_in || 3600) - 60) * 1000;
          win(gTok);
        };
        timer = setTimeout(function () {
          if (quiet) gQuietDead = Date.now();
          lose(new Error(quiet ? "quiet"
            : "Googleから返事がありませんでした。通信を確かめて、もう一度お試しください。"));
        }, quiet ? G_WAIT_QUIET : G_WAIT_ASK);
        try {
          var opt = { prompt: quiet ? "" : "consent" };
          /* 前に選んだアカウントを伝えると、選び直しの画面が出ない。
             これが無いと、つないであっても毎回聞かれる */
          var who = recall("gacct");
          if (quiet && who) opt.hint = who;
          gClient.requestAccessToken(opt);
        } catch (e) { lose(e); }
      });
    });
  }

  /* Googleへの問い合わせ。合鍵を添えて、返事が変なら日本語にして投げ直す */
  /* この数が0より大きい間は、許可画面を出さない。
     触ってもいないのに許可画面が出てくると、何事かと驚く。
     入れ子になっても困らないよう、数で持つ */
  var noPrompt = 0;
  function hush(run) {
    noPrompt++;
    function done() { noPrompt--; }
    return run().then(function (v) { done(); return v; },
                      function (e) { done(); throw e; });
  }

  /* 返事が来ない通信を、いつまでも待たない。
     1本でも宙ぶらりんになると、同期が丸ごと止まってしまう */
  var NET_WAIT = 60000;
  function netFetch(url, opt, ms) {
    opt = opt || {};
    var ac = null;
    try { ac = new AbortController(); opt.signal = ac.signal; } catch (e) {}
    return new Promise(function (ok, ng) {
      var over = setTimeout(function () {
        try { if (ac) ac.abort(); } catch (e) {}
        ng(new Error("通信が返ってきませんでした。電波の届くところで、もう一度お試しください。"));
      }, ms || NET_WAIT);
      fetch(url, opt).then(function (r) { clearTimeout(over); ok(r); },
                           function (e) { clearTimeout(over); ng(e); });
    });
  }

  function gCall(url, opt) {
    opt = opt || {};
    var dead = Date.now() - gQuietDead < 60000;
    var key = (quietSync || noPrompt) ? gKey(true)
      : (dead ? gKey(false) : gKey(true).catch(function () { return gKey(false); }));
    return key.then(function (t) {
      var h = opt.headers || {};
      h.Authorization = "Bearer " + t;
      opt.headers = h;
      return netFetch(url, opt);
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) {
        gTok = null;
        throw new Error("ログインが切れました。下の右端にある丸から、もう一度ログインしてください。");
      }
      if (!r.ok) throw new Error("Googleが受け付けませんでした（" + r.status + "）。");
      return r.status === 204 ? null : r.json();
    });
  }

  var DRIVE = "https://www.googleapis.com/drive/v3/files";
  var DRIVE_UP = "https://www.googleapis.com/upload/drive/v3/files";

  var Shelf = {
    name: "drive",

    linked: function () { return recall("linked") === "1"; },
    /* 名前は端末に覚えておく。覚えていないと、画面を開くたびに
       Googleへ聞きに行くことになり、そのたびに許可画面が出る */
    who: function () { return gName || recall("gacct") || ""; },

    link: function () {
      return gKey(false).then(function () {
        remember("linked", "1");
        return Shelf.refresh();
      });
    },

    /* 名前を取り直す。許可画面は出さない。
       取れなければ、覚えてある名前のままでかまわない */
    refresh: function () {
      return gKey(true).then(function (t) {
        return netFetch("https://www.googleapis.com/drive/v3/about?fields=user",
          { headers: { Authorization: "Bearer " + t } }, 20000);
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (a) {
        var n = (a && a.user && (a.user.emailAddress || a.user.displayName)) || "";
        if (n) { gName = n; remember("gacct", n); }
        return Shelf.who();
      }).catch(function () { return Shelf.who(); });
    },

    unlink: function () {
      var t = gTok;
      gTok = null; gTokUntil = 0; gName = "";
      remember("linked", "");
      remember("gacct", "");
      /* Google側でも合鍵を無効にしておく。切ったつもりが
         生きている、という状態を残さない */
      if (t && window.google && google.accounts && google.accounts.oauth2) {
        try { google.accounts.oauth2.revoke(t, function () {}); } catch (e) {}
      }
      return Promise.resolve();
    },

    /* フォルダを1つ作る。返ってくるのはその番号 */
    newRoom: function (name) {
      return gCall(DRIVE + "?fields=id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name,
          mimeType: "application/vnd.google-apps.folder"
        })
      }).then(function (r) { return r.id; });
    },

    /* 名前が「Rawpo」のフォルダを、古い順に全部。
       二台が別々に初めて使うと、それぞれが自分のフォルダを作ってしまう。
       そうなると片方の記録がもう片方から一生見えないので、
       どの端末も「いちばん古いもの」に寄せる決まりにしてある */
    roots: function () {
      var q = encodeURIComponent(
        "mimeType='application/vnd.google-apps.folder' and name='Rawpo' and trashed=false");
      var f = encodeURIComponent("files(id,createdTime)");
      return gCall(DRIVE + "?q=" + q + "&fields=" + f + "&orderBy=createdTime&pageSize=100")
        .then(function (r) { return r.files || []; });
    },

    /* Rawpo の置き場所。無ければ作る。
       番号は控えるが、控えを頼りにはしない。毎回いちばん古いものを見にいく。
       控えだけで動かしていたせいで、二つのフォルダに分かれたまま
       どちらの端末も気づけない、ということが起きていた */
    root: function () {
      var had = recall("driveRoot");
      function born() {
        return Shelf.newRoom("Rawpo").then(function (id) {
          remember("driveRoot", id);
          return id;
        });
      }
      return Shelf.roots().then(function (files) {
        if (files.length) {
          var id = files[0].id;
          /* 前と違うフォルダに移るときは、送った控えを忘れる。
             前の置き場に送った記録は、新しい置き場には無い */
          if (had && had !== id) placeChanged();
          remember("driveRoot", id);
          return id;
        }
        if (!had) return born();
        /* 探して出てこないのに控えがある。捨てられたのか、
           たまたま返らなかったのか。確かめてから作り直す */
        return gCall(DRIVE + "/" + had + "?fields=id,trashed").then(function (r) {
          if (r && r.id && !r.trashed) return r.id;
          throw new Error("消えています");
        }).catch(function () { remember("driveRoot", ""); return born(); });
      }, function (e) {
        /* 一覧が引けないだけなら、控えで続ける */
        if (had) return had;
        throw e;
      });
    },

    /* 中にある同じ名前のフォルダを、古い順に全部。作りはしない。
       いつの間にか二つできていることがあり、片方にだけ
       入っているものが見えなくなるのを防ぐために使う */
    rooms: function (parentId, name) {
      var q = encodeURIComponent("'" + parentId + "' in parents and mimeType='application/vnd.google-apps.folder'"
        + " and name='" + String(name).replace(/'/g, "\\'") + "' and trashed=false");
      var f = encodeURIComponent("files(id,createdTime)");
      return gCall(DRIVE + "?q=" + q + "&fields=" + f + "&orderBy=createdTime&pageSize=100")
        .then(function (r) {
          return (r.files || []).map(function (x) { return x.id; });
        });
    },

    /* 中にフォルダを1つ。すでにあれば作らない。
       押すたびに同じ名前のフォルダが並んでいかないように */
    room: function (parentId, name) {
      var q = encodeURIComponent("'" + parentId + "' in parents and mimeType='application/vnd.google-apps.folder'"
        + " and name='" + String(name).replace(/'/g, "\\'") + "' and trashed=false");
      return gCall(DRIVE + "?q=" + q + "&fields=files(id)&orderBy=createdTime&pageSize=10").then(function (r) {
        /* 同じ名前が二つあっても、どの端末も古いほうを選ぶ */
        if (r.files && r.files.length) return r.files[0].id;
        return gCall(DRIVE + "?fields=id", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name, parents: [parentId],
            mimeType: "application/vnd.google-apps.folder"
          })
        }).then(function (x) { return x.id; });
      });
    },

    /* 同じ名前のものを探す。あれば入れ替え、無ければ置く。
       押すたびに増えていかないように */
    find: function (roomId, name) {
      var q = encodeURIComponent("'" + roomId + "' in parents and name='"
        + String(name).replace(/'/g, "\\'") + "' and trashed=false");
      var f = encodeURIComponent("files(id,name,size,modifiedTime,createdTime)");
      return gCall(DRIVE + "?q=" + q + "&fields=" + f + "&orderBy=createdTime&pageSize=10")
        .then(function (r) { return (r.files || [])[0] || null; });
    },

    save: function (roomId, name, blob) {
      return Shelf.find(roomId, name).then(function (f) {
        if (!f) return Shelf.put(roomId, name, blob);
        return gCall(DRIVE_UP + "/" + f.id + "?uploadType=media&fields=id,modifiedTime",
                     { method: "PATCH", body: blob });
      });
    },

    /* 1件置く。写真もメモも、1件＝1ファイルにする。
       別々のファイルなら、2人が同時に足してもぶつからない */
    put: function (roomId, name, blob) {
      var meta = { name: name, parents: [roomId] };
      var fd = new FormData();
      fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
      fd.append("file", blob);
      return gCall(DRIVE_UP + "?uploadType=multipart&fields=id,modifiedTime", {
        method: "POST", body: fd
      });
    },

    get: function (fileId) {
      return gKey(true).catch(function () { return gKey(false); }).then(function (t) {
        return netFetch(DRIVE + "/" + fileId + "?alt=media",
                        { headers: { Authorization: "Bearer " + t } });
      }).then(function (r) {
        if (!r.ok) throw new Error("取り出せませんでした（" + r.status + "）。");
        return r.blob();
      });
    },

    /* 中にあるものを並べる。1000件で切れるので、続きがあれば追う。
       写真はすぐ1000件を超えるため、ここで止まると取りこぼす */
    list: function (roomId) {
      var out = [];
      function page(tok) {
        var q = encodeURIComponent("'" + roomId + "' in parents and trashed=false");
        var f = encodeURIComponent("nextPageToken,files(id,name,size,modifiedTime,lastModifyingUser/displayName)");
        return gCall(DRIVE + "?q=" + q + "&fields=" + f + "&pageSize=1000"
          + (tok ? "&pageToken=" + encodeURIComponent(tok) : "")).then(function (r) {
          (r.files || []).forEach(function (x) {
            out.push({
              fileId: x.id, name: x.name, size: Number(x.size || 0),
              at: Date.parse(x.modifiedTime || 0) || 0,
              by: (x.lastModifyingUser && x.lastModifyingUser.displayName) || ""
            });
          });
          if (r.nextPageToken) return page(r.nextPageToken);
          return out;
        });
      }
      return page(null);
    },

    /* いくつかのフォルダの中身を、まとめて並べる。
       同じ名前のフォルダが二つあるときは、両方を見る */
    listMany: function (ids) {
      var out = [];
      function step(i) {
        if (i >= ids.length) return Promise.resolve(out);
        return Shelf.list(ids[i]).then(function (rows) {
          rows.forEach(function (r) { out.push(r); });
          return step(i + 1);
        });
      }
      return step(0);
    },

    drop: function (fileId) {
      return gCall(DRIVE + "/" + fileId, { method: "DELETE" });
    },

    /* 招くためのリンク。リンクを知っている人が書き込める状態にする */
    invite: function (roomId) {
      return gCall(DRIVE + "/" + roomId + "/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "writer", type: "anyone" })
      }).then(function () {
        return location.origin + location.pathname + "#join=" + roomId;
      });
    }
  };

  /* ============================================================
     テンプレートと配色
     ============================================================ */
  var DEF_L = "フォルダ";

  /* よく使う組み合わせ。ここに無いものは利用者が自分で作れる */
  var TEMPLATES = [
    { id: "b1", k: "会議",   name: "会議_「日付」",   form: "決まったこと：\n宿題：\n担当：" },
    { id: "b2", k: "取材",   name: "取材_「日付」",   form: "素材：\n価格：\n担当者の話：" },
    { id: "b3", k: "グルメ", name: "グルメ_「日付」", form: "店名：\n品名：\n価格：\nまた行きたいか：" },
    { id: "b4", k: "旅行",   name: "旅行_「日付」",   form: "行き方：\n時間帯：\n次に行くなら：" },
    { id: "b5", k: "フリー", name: "",                form: "" }
  ];
  /* 最初から入っているものかどうか */
  function isBuiltIn(t) { return !!t && /^b\d+$/.test(t.id || ""); }

  /* 「日付」などを実際の値に置き換える。古い {日付} 書きも受け付ける */
  function fillPattern(s) {
    var d = new Date();
    var ym = d.getFullYear() + "-" + pad2(d.getMonth() + 1);
    return String(s || "")
      .replace(/[「{]日付[」}]/g, today())
      .replace(/[「{]年月[」}]/g, ym);
  }
  var userTpl = [];          /* 自分で作ったもの */
  var tplOrder = [];         /* 並び順（idの並び） */
  var tplHidden = [];        /* 消したもの（最初から入っているものも消せる） */
  var TPL_PREF = "__tplpref";   /* 並び順の覚え書き。テンプレートと一緒にバックアップされる */

  /* 表示するテンプレート。消したものを除き、決めた順に並べる */
  function allTemplates() {
    var pool = TEMPLATES.concat(userTpl).filter(function (t) {
      return tplHidden.indexOf(t.id) < 0;
    });
    var seat = {};
    pool.forEach(function (t) { seat[t.id] = t; });
    var out = [];
    tplOrder.forEach(function (id) { if (seat[id]) { out.push(seat[id]); delete seat[id]; } });
    pool.forEach(function (t) { if (seat[t.id]) out.push(t); });
    return out;
  }
  function tplById(id) {
    var a = TEMPLATES.concat(userTpl);
    for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
    return null;
  }
  function saveTplPref() {
    return DB.put("templates", {
      id: TPL_PREF, pref: true, order: tplOrder.slice(), hidden: tplHidden.slice()
    }).catch(function () {});
  }

  /* 見本の丸は、地の色と差し色の二色で見せる。
     並びは白→灰→墨→砂→栗→山吹→柿→臙脂→藤→藍→浅葱→ミントの順。
     6つずつ2段に収まる */
  var PALETTES = [
    { k: "shiro",    name: "White",     bg: "#F2F1EC", dot: "#C2453A" },
    { k: "hai",      name: "Gray",      bg: "#C4C6C7", dot: "#C2553A" },
    { k: "sumi",     name: "Black",     bg: "#1C1D1F", dot: "#F07A5F" },
    { k: "suna",     name: "Beige",     bg: "#E5D8C2", dot: "#4A6F8C" },
    { k: "kuri",     name: "Brown",     bg: "#C9A98C", dot: "#3D6B63" },
    { k: "yamabuki", name: "Amber",     bg: "#EDD6A2", dot: "#2F5F7A" },
    { k: "kaki",     name: "Apricot",   bg: "#F3C5AA", dot: "#2C6659" },
    { k: "enji",     name: "Rose",      bg: "#E3C0C4", dot: "#2E6B5D" },
    { k: "fuji",     name: "Lavender",  bg: "#CFC6E6", dot: "#C46B2C" },
    { k: "ai",       name: "Indigo",    bg: "#B9C6E4", dot: "#DE5F2B" },
    { k: "asagi",    name: "Teal",      bg: "#A9D7DE", dot: "#E2622C" },
    { k: "mint",     name: "Mint",      bg: "#A9DDC8", dot: "#F0501E" }
  ];

  /* ============================================================
     状態
     ============================================================ */
  var exs = [], items = [];
  /* 画面は2階層。"shelf" が棚（フォルダが並ぶ）、"folder" がその中身 */
  var screen = "shelf";
  var curCat = "all", shelfTag = "";
  var shelfView = "sq";   /* 棚の並べ方。"sq"（正方形）が既定。"list" で行になる */
  var curEx = null, curTag = "all", favOnly = false, query = "", viewMode = "grid";
  /* 並び順は3つ。古い順＝撮った順 */
  /* 選んでまとめて操作するとき。長押しで入る */
  var picking = false, picked = {};
  function pickedIds() { return Object.keys(picked).filter(function (k) { return picked[k]; }); }
  function pickCount() { return pickedIds().length; }

  var SORTS = [
    { k: "new", t: "新しい順" },
    { k: "old", t: "古い順" },
    { k: "fav", t: "★から" },
    { k: "mine", t: "自分の順" }
  ];
  var sortMode = "old";
  /* 「自分の順」は、フォルダの中でだけ意味がある。棚では出さない */
  function sortList() {
    return screen === "shelf" ? SORTS.filter(function (x) { return x.k !== "mine"; }) : SORTS;
  }
  function sortLabel() {
    var m = (screen === "shelf" && sortMode === "mine") ? "new" : sortMode;
    for (var i = 0; i < SORTS.length; i++) if (SORTS[i].k === m) return SORTS[i].t;
    return SORTS[0].t;
  }
  function sortItems(a) {
    var out = a.slice();
    if (sortMode === "mine") {
      /* 自分で並べた順。まだ番号のないものは、撮った順で後ろにつける */
      out.sort(function (x, y) {
        var a = typeof x.ord === "number" ? x.ord : Infinity;
        var b = typeof y.ord === "number" ? y.ord : Infinity;
        return (a - b) || ((x.createdAt || 0) - (y.createdAt || 0));
      });
    } else if (sortMode === "fav") {
      out.sort(function (x, y) {
        return ((y.fav ? 1 : 0) - (x.fav ? 1 : 0)) || ((y.createdAt || 0) - (x.createdAt || 0));
      });
    } else if (sortMode === "new") {
      out.sort(function (x, y) { return (y.createdAt || 0) - (x.createdAt || 0); });
    } else {
      out.sort(function (x, y) { return (x.createdAt || 0) - (y.createdAt || 0); });
    }
    return out;
  }
  /* フォルダは日付で。★からのときは★の多いフォルダが上 */
  function sortFolders(a, favs) {
    var out = a.slice();
    function byDate(x, y, desc) {
      var d = String(x.date || "").localeCompare(String(y.date || ""));
      if (!d) d = (x.createdAt || 0) - (y.createdAt || 0);
      return desc ? -d : d;
    }
    if (sortMode === "fav") {
      out.sort(function (x, y) {
        return ((favs[y.id] || 0) - (favs[x.id] || 0)) || byDate(x, y, true);
      });
    } else if (sortMode === "old") {
      out.sort(function (x, y) { return byDate(x, y, false); });
    } else {
      out.sort(function (x, y) { return byDate(x, y, true); });
    }
    return out;
  }
  var urlCache = {}, paintSeq = 0, booted = false;
  var browseAll = null;   /* 全フォルダのアイテム。さがす画面と候補で使う */
  var deferredInstall = null;

  function remember(k, v) { try { localStorage.setItem("expo." + k, v); } catch (e) {} }
  function recall(k) { try { return localStorage.getItem("expo." + k); } catch (e) { return null; } }

  /* 入れものの呼び方は「フォルダ」でひとつに揃える。
     古い版では中身に合わせて呼び名を変えていたが、
     「新しいゲーム」のように、その種類しか作れないように見えてしまっていた */
  function LL() { return DEF_L; }
  /* フォルダが入っているカテゴリ（フォルダの上位の棚）。無ければ空 */
  function catOf(ex) { var e = ex || exById(curEx); return (e && e.cat) || ""; }
  /* いま在るカテゴリを、使われている順に並べて返す */
  function allCats() {
    var seen = {}, out = [];
    exs.forEach(function (e) {
      var c = (e.cat || "").trim();
      if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    });
    out.sort(function (a, b) { return a.localeCompare(b, "ja"); });
    return out;
  }
  /* そのフォルダのメモのフォーマット。無ければ空 */
  function memoForm(ex) {
    var e = ex || exById(curEx);
    return (e && (e.form || e.hint)) || "";
  }
  function memoHint(ex) {
    return memoForm(ex);
  }

  /* 見た目の設定。既定値のときは属性を付けない（CSSの素の値がそのまま効く） */
  var LOOK = [
    { key: "theme",   attr: "data-theme",   def: "auto" },
    { key: "palette", attr: "data-palette", def: "mint" },
    { key: "face",    attr: "data-face",    def: "gothic" },
    { key: "radius",  attr: "data-radius",  def: "normal" },
    { key: "density", attr: "data-density", def: "normal" },
    { key: "cols",    attr: "data-cols",    def: "3" }
  ];
  function lookOf(key) {
    for (var i = 0; i < LOOK.length; i++) if (LOOK[i].key === key) return recall(key) || LOOK[i].def;
    return "";
  }
  function applyLook() {
    var r = document.documentElement;
    LOOK.forEach(function (o) {
      var v = recall(o.key) || o.def;
      if (v === o.def) r.removeAttribute(o.attr); else r.setAttribute(o.attr, v);
    });
  }

  function setView(v) {
    viewMode = v; remember("view", v);
    syncViewToggle(); paintStage();
  }
  function syncViewToggle() {
    var g = $("vGrid"), f = $("vFeed");
    if (g) g.setAttribute("aria-pressed", String(viewMode === "grid"));
    if (f) f.setAttribute("aria-pressed", String(viewMode === "feed"));
  }

  var exById = function (id) {
    for (var i = 0; i < exs.length; i++) if (exs[i].id === id) return exs[i];
    return null;
  };
  var itemById = function (id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  };
  /* フォルダを跨いで引く。ボードはどのフォルダの写真も貼れるので、
     いま開いているフォルダの中だけを見ていては見つからない */
  var anyItem = function (id) {
    var it = itemById(id);
    if (it) return it;
    var all = browseAll || [];
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  };

  function dropUrls() {
    Object.keys(urlCache).forEach(function (k) {
      try { URL.revokeObjectURL(urlCache[k]); } catch (e) {}
    });
    urlCache = {};
  }
  function ensureUrls(ids) {
    var missing = ids.filter(function (i) { return i && !urlCache[i]; });
    if (!missing.length) return Promise.resolve();
    return Promise.all(missing.map(function (id) {
      return DB.get("blobs", id).then(function (r) {
        if (r && r.blob) urlCache[id] = URL.createObjectURL(r.blob);
      }).catch(function () {});
    }));
  }

  /* ============================================================
     起動
     ============================================================ */
  boot();

  /* 古い版では、写真1件ごとに「カテゴリ」が付いていた。
     カテゴリはフォルダの上位（棚）に移したので、
     写真に付いていた分類はタグに移し替える。消えるものは無い。 */
  /* browseAll は別に読み込んだ写しで、開いているフォルダの items とは
     別のもの。片方だけ書き換えると、棚の表紙が古いままになる */
  function syncBrowse(list) {
    if (!browseAll || !list || !list.length) return;
    var m = {};
    list.forEach(function (x) { if (x && x.id) m[x.id] = x; });
    browseAll.forEach(function (x, i) { if (m[x.id]) browseAll[i] = m[x.id]; });
  }

  /* browseAll は棚の表紙・点数・タグのもと。消したら落としておく */
  function forgetFromBrowse(id) {
    if (!browseAll) return;
    browseAll = browseAll.filter(function (x) { return x.id !== id; });
  }

  function migrateCats() {
    if (recall("catmoved") === "1") return Promise.resolve();
    return Promise.all([DB.all("brands"), DB.all("items")]).then(function (r) {
      var nameOf = {};
      (r[0] || []).forEach(function (b) { nameOf[b.id] = b.name; });
      var jobs = [];
      (r[1] || []).forEach(function (it) {
        if (!it.brandId) return;
        var nm = nameOf[it.brandId];
        it.brandId = null;
        if (nm) {
          it.tags = it.tags || [];
          if (it.tags.indexOf(nm) < 0) it.tags.push(nm);
        }
        jobs.push(DB.put("items", it));
      });
      return Promise.all(jobs);
    }).then(function () {
      remember("catmoved", "1");
    }).catch(function () {});
  }

  /* 前からある記録には時刻が無い。一度だけまとめて入れておく。
     作った時刻が分かるものはそれを使う。そのほうが、
     古いものが急に「今さっき変えた」顔をしないで済む */
  function stampOld() {
    if (recall("stamped") === "1") return Promise.resolve();
    var base = Date.now(), me = devId();
    return Promise.all(TRACKED.map(function (st) {
      return DB.all(st).then(function (rows) {
        var need = (rows || []).filter(function (r) { return !r.upAt; });
        if (!need.length) return null;
        need.forEach(function (r) {
          var t = Number(r.createdAt) || Date.parse(r.createdAt || r.date || "") || base;
          r.upAt = t;
          r.upBy = me;
        });
        return DB.putManyRaw(need.map(function (r) { return [st, r]; }));
      }, function () { return null; });
    })).then(function () {
      remember("stamped", "1");
    }).catch(function () {});
  }

  /* 消した記録は、置いたままだと増える一方で、
     同期のたびに送る分も重くなる。半年たったものは畳む。
     どの端末も同じ日数で畳むので、食い違いは長くは続かない。
     半年ぶりに開いた端末では消したものが戻ることがあるが、
     そこまで間が空いていれば、戻ってきたほうが気づける */
  var TOMB_KEEP = 180 * 24 * 60 * 60 * 1000;
  function trimGone() {
    var edge = Date.now() - TOMB_KEEP;
    return DB.all("gone").then(function (rows) {
      var old = (rows || []).filter(function (g) { return Number(g.upAt || 0) < edge; })
        .map(function (g) { return ["gone", g.id]; });
      return old.length ? DB.dropRaw(old, []) : null;
    }).catch(function () {});
  }

  /* テンプレートの置き場には、並び順の覚え書きも1件だけ混ざっている */
  function takeTemplates(rows) {
    var list = [], pref = null;
    (rows || []).forEach(function (t) {
      if (t && t.id === TPL_PREF) pref = t; else list.push(t);
    });
    userTpl = list.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    tplOrder = (pref && pref.order) || [];
    tplHidden = (pref && pref.hidden) || [];
  }

  function boot() {
    applyLook();
    viewMode = recall("view") === "feed" ? "feed" : "grid";
    if (recall("shelfview") === "list") shelfView = "list";
    /* 並び順は SORTS を見て確かめる。ここに名前を書き並べると、
       並び順を足したときに直し忘れて復元されなくなる */
    var sv = recall("sort");
    if (SORTS.some(function (x) { return x.k === sv; })) sortMode = sv;
    syncViewToggle();
    wireDrop();
    paintShell();
    migrateCats().then(stampOld).then(trimGone).then(function () {
      return Promise.all([DB.all("exhibitions"), DB.all("templates"), DB.all("boards")]);
    }).then(function (r) {
      exs = r[0].sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
      takeTemplates(r[1]);
      boards = r[2] || [];
      curEx = null;
      screen = "shelf";
      booted = true;
      /* 棚を描くのに全フォルダの中身の見出しが要る（表紙・点数・タグ） */
      return DB.all("items").then(function (all) { browseAll = all; }, function () { browseAll = []; });
    }).then(function () {
      paint();
      paintMe();
      loadSkin();
      gauge();
      askPersist();
      tellVer();
      /* 画面が出てからにする。開いた瞬間に通信を始めると、
         最初の描画がもたつく */
      setTimeout(maybeSync, 2500);
      watchSync();
    }).catch(function (e) {
      booted = true;
      $("stage").innerHTML = '<div class="blank"><h2>データを開けませんでした</h2><p>' + esc(why(e)) + "</p></div>";
    });

    /* ほかのアプリから戻ってきたとき。別の端末で触っていた分を拾う */
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) setTimeout(maybeSync, 800);
    });

    if ("serviceWorker" in navigator) {
      /* 新しい版が実際に受け持ちを引き継いだ瞬間。ここが一番確かな合図 */
      var hadSW = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (hadSW) updateBar();
        hadSW = true;
      });
      window.addEventListener("load", function () {
        /* updateViaCache を切っておく。これが無いと、新しい版があるか
           調べるときに、ブラウザの手持ちの古い sw.js を見てしまう */
        navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function (reg) {
          /* 新しい版が届いたら、黙って入れ替えず、こちらから声をかける。
             書きかけの画面が急に消えないように */
          reg.addEventListener("updatefound", function () {
            var w = reg.installing;
            if (!w) return;
            w.addEventListener("statechange", function () {
              if (w.state === "installed" && navigator.serviceWorker.controller) updateBar();
            });
          });
          /* すでに控えている版があれば、その場で声をかける */
          if (reg.waiting && navigator.serviceWorker.controller) updateBar();

          /* 新しい版がないか見にいく。開きっぱなしのときは1時間ごと。
             ただしホーム画面のアプリは、閉じずに戻ってくるかぎり
             load も時計も動かない。戻ってきたときに必ず見にいく */
          var lookedAt = 0;
          function look() {
            /* 立て続けには見にいかない。ただし間を空けすぎると、
               ちょっと離れて戻ってきたときに見のがす */
            if (Date.now() - lookedAt < 10000) return;
            lookedAt = Date.now();
            try { reg.update(); } catch (e) {}
          }
          look();
          setInterval(look, 60 * 60 * 1000);
          document.addEventListener("visibilitychange", function () {
            if (!document.hidden) look();
          });
        }).catch(function () {});
      });
    }

    /* 入れ替わったあとの知らせ。開き直したときに新しくなっていた、
       という場合はこちらが出る。帯を押す間もなく入れ替わることがあり、
       そのとき何も出ないと、更新されたのか分からない */
    function tellVer() {
      var seen = recall("appver");
      remember("appver", APPVER);
      if (!seen || seen === APPVER) return;
      var d = document.createElement("div");
      d.className = "upd on";
      d.id = "verbar";
      d.innerHTML = '<span>新しい版になりました（v' + esc(APPVER) + "）</span>"
        + '<button class="updx" id="verX" aria-label="閉じる">閉じる</button>';
      document.body.appendChild(d);
      var dock = document.querySelector(".dock");
      var h = dock ? Math.round(dock.getBoundingClientRect().height) : 92;
      d.style.bottom = (h + 12) + "px";
      $("verX").onclick = function () { d.remove(); };
      setTimeout(function () { if (d.parentNode) d.remove(); }, 12000);
    }

    /* 「新しい版があります」の帯。押したときだけ切り替える */
    function updateBar() {
      if ($("updbar")) return;
      var d = document.createElement("div");
      d.className = "upd on";
      d.id = "updbar";
      d.innerHTML = '<span>新しい版が届いています</span>'
        + '<button id="updGo">切り替える</button>'
        + '<button class="updx" id="updNo" aria-label="あとで">あとで</button>';
      document.body.appendChild(d);
      /* 下のバーと広告のぶんだけ持ち上げる。高さは端末や広告の有無で変わる */
      var dock = document.querySelector(".dock");
      var h = dock ? Math.round(dock.getBoundingClientRect().height) : 92;
      d.style.bottom = (h + 12) + "px";
      $("updGo").onclick = function () { location.reload(); };
      $("updNo").onclick = function () { d.remove(); };
    }
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault(); deferredInstall = e;
    });
    window.addEventListener("appinstalled", function () {
      deferredInstall = null;
    });
  }

  function loadItems() {
    dropUrls();
    items = [];
    if (!curEx) return Promise.resolve();
    return DB.byEx(curEx).then(function (r) {
      items = r.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    });
  }

  /* 端末に「このデータは勝手に消さないで」と伝える */
  function askPersist() {
    if (!navigator.storage || !navigator.storage.persist) return;
    navigator.storage.persisted().then(function (ok) {
      if (!ok) navigator.storage.persist().catch(function () {});
    }).catch(function () {});
  }

  function gauge() {
    var el = $("usage");
    if (!el) return;
    var total = items.reduce(function (a, b) { return a + (b.bytes || 0); }, 0);
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (s) {
        if (s && s.usage != null) el.textContent = mb(s.usage) + " 使用中";
        else el.textContent = total ? mb(total) : "";
      }).catch(function () { el.textContent = total ? mb(total) : ""; });
    } else {
      el.textContent = total ? mb(total) : "";
    }
  }

  /* ============================================================
     表示
     ============================================================ */
  /* 「#暑い」と打っても「暑い」と打っても同じように拾う */
  function normQ(v) { return String(v || "").trim().replace(/^[#＃]+/, "").toLowerCase(); }

  function visible() {
    var q = normQ(query);
    var out = items.filter(function (it) {
      if (favOnly && !it.fav) return false;
      if (curTag === "none") { if ((it.tags || []).length) return false; }
      else if (curTag !== "all") { if ((it.tags || []).indexOf(curTag) < 0) return false; }
      if (!q) return true;
      var hay = (it.memo || "") + " " + (it.tags || []).join(" ");
      return hay.toLowerCase().indexOf(q) >= 0;
    });
    return sortItems(out);
  }

  function paintShell() {
    $("stage").innerHTML = '<div class="nothing">読み込んでいます…</div>';
  }

  function paint() {
    paintSearchHint();
    paintEx();
    paintRail();
    paintAd();
    paintStage();
  }

  /* 広告を消してあるか。買い切りで消える */
  function adFree() { return recall("adfree") === "1"; }
  /* 見た目を自由にできる状態か（月額） */
  function isPro() { return recall("pro") === "1"; }

  /* 広告バナーの置き場。いまは中身の入っていない枠 */
  function paintAd() {
    var el = $("adSlot");
    if (!el) return;
    var show = !adFree();
    el.hidden = !show;
    el.innerHTML = show
      ? '<span>広告</span><button class="adx" id="adRemove">消す</button>'
      : "";
    document.documentElement.setAttribute("data-ad", show ? "on" : "off");
    var rm = $("adRemove");
    if (rm) rm.onclick = removeAdsDialog;
  }

  /* 背景の色を、並んだ見本から選ぶ */
  var CHART = [
    ["#FFFFFF", "#F7F7F5", "#EFEFEC", "#E4E4DF", "#D3D3CC", "#B8B8B0"],
    ["#FBF3E7", "#F6E7D2", "#F2D9BB", "#EFE3D0", "#E8DCC8", "#DCCBB0"],
    ["#FDECE6", "#FAD9CE", "#F6C3B2", "#F7E3DE", "#EED6CF", "#E2BCB0"],
    ["#EAF2EC", "#D6E8DB", "#BEDAC6", "#E3EEE6", "#CFE0D4", "#B2CBB9"],
    ["#E7F0F5", "#CFE3EE", "#B4D3E4", "#E0EDF2", "#CBDDE6", "#AAC6D6"],
    ["#ECEAF7", "#DAD6F0", "#C3BDE6", "#E9E7F3", "#D6D2E8", "#BDB6D8"],
    ["#F3F3F1", "#3E4348", "#2B2D33", "#1F2126", "#16171B", "#0C0D0F"]
  ];

  function colorDialog(slot) {
    var cur = recall(slot + "col") || "";
    var name = slot === "bg1" ? "上のエリア" : slot === "bg2" ? "中のエリア" : "下のエリア";

    $("minibox").innerHTML = "<h4>" + esc(name) + "の色</h4>"
      + "<p>押すとすぐ変わります。決まったら閉じてください。</p>"
      + '<div class="chart">' + CHART.map(function (row) {
          return row.map(function (c) {
            return '<button class="chip2" data-c="' + c + '" aria-pressed="'
              + (cur.toLowerCase() === c.toLowerCase()) + '" style="background:' + c + '" aria-label="' + c + '"></button>';
          }).join("");
        }).join("") + "</div>"
      + '<div class="field" style="margin-top:10px"><div class="label">自分で選ぶ</div>'
      + '<label class="freecol" style="background:' + esc(cur || "#F4F4F1") + '">'
      + "<span>" + esc(cur || "色を選ぶ") + "</span>"
      + '<input type="color" id="cdFree" value="' + esc(cur || "#F4F4F1") + '"></label></div>'
      + '<div class="minibtns"><button class="ghost" id="cdReset">戻す</button>'
      + '<button class="cta" id="cdOk">閉じる</button></div>';
    noAutofill($("minibox"));
    $("mini").className = "mini on";

    function put(v) {
      remember(slot + "col", v);
      DB.del("blobs", "skin_" + slot).catch(function () {}).then(function () {
        try { if (SKIN[slot]) URL.revokeObjectURL(SKIN[slot]); } catch (e) {}
        SKIN[slot] = "";
        applySkin();
      });
    }

    Array.prototype.forEach.call($("minibox").querySelectorAll("[data-c]"), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call($("minibox").querySelectorAll("[data-c]"), function (x) {
          x.setAttribute("aria-pressed", String(x === b));
        });
        put(b.getAttribute("data-c"));
      };
    });
    $("cdFree").oninput = function () {
      var lab = this.parentNode;
      lab.style.background = this.value;
      lab.querySelector("span").textContent = this.value;
      put(this.value);
    };
    $("cdReset").onclick = function () { remember(slot + "col", ""); applySkin(); miniClose(); lookDialog(); };
    $("cdOk").onclick = function () { miniClose(); lookDialog(); };
  }

  /* 見た目を自由にする（月額）の案内。決済はまだ繋いでいない */
  function proDialog() {
    $("minibox").innerHTML = "<h4>自分の見た目にする</h4>"
      + "<p>上にバナーを差し込み、画面の3つのエリアに好きな色や画像を入れられます。"
      + "写真やメモの扱いは変わりません。</p>"
      + '<div class="pricebox"><b>月額</b><span>¥180</span></div>'
      + '<div class="hintline">まだ決済を繋いでいないので、いまは申し込めません。'
      + "配信先が決まってからになります。</div>"
      + '<div class="minibtns"><button class="ghost" id="prNo">閉じる</button>'
      + '<button class="cta" id="prYes" disabled>申し込む（準備中）</button></div>'
      + '<button class="ghost" id="prTry" style="width:100%;margin-top:8px">'
      + (isPro() ? "元に戻す（確認用）" : "試しに使ってみる（確認用）") + "</button>";
    noAutofill($("minibox"));
    $("mini").className = "mini on";
    $("prNo").onclick = miniClose;
    $("prTry").onclick = function () {
      remember("pro", isPro() ? "0" : "1");
      miniClose();
      toast(isPro() ? "使えるようにしました（確認用）" : "元に戻しました");
      if (isPro()) lookDialog();
    };
  }

  /* 広告を消す（買い切り）の案内。決済はまだ繋いでいない */
  function removeAdsDialog() {
    $("minibox").innerHTML = "<h4>広告を消す</h4>"
      + "<p>一度払えば、この端末から広告が消えます。毎月の支払いはありません。"
      + "見た目の設定やバナーは、払わなくても最初から全部使えます。</p>"
      + '<div class="pricebox"><b>買い切り</b><span>¥480</span></div>'
      + '<div class="hintline">まだ決済を繋いでいないので、いまは買えません。'
      + "配信先が決まったら、ここから購入できるようにします。</div>"
      + '<div class="minibtns"><button class="ghost" id="adNo">閉じる</button>'
      + '<button class="cta" id="adYes" disabled>購入する（準備中）</button></div>'
      + '<button class="ghost" id="adTry" style="width:100%;margin-top:8px">'
      + (adFree() ? "広告を戻す（確認用）" : "試しに消してみる（確認用）") + "</button>";
    noAutofill($("minibox"));
    $("mini").className = "mini on";
    $("adNo").onclick = miniClose;
    $("adTry").onclick = function () {
      remember("adfree", adFree() ? "0" : "1");
      miniClose(); paintAd();
      toast(adFree() ? "広告を消しました（確認用）" : "広告を戻しました");
    };
  }

  /* 上のバナーと、3つのエリアの背景。画像は端末の中に持つ */
  var SKIN = { banner: "", bg1: "", bg2: "", bg3: "", me: "" };
  var SKIN_KEYS = ["banner", "bg1", "bg2", "bg3", "me"];

  function loadSkin() {
    return Promise.all(SKIN_KEYS.map(function (k) {
      return DB.get("blobs", "skin_" + k).then(function (r) {
        if (r && r.blob) {
          try { if (SKIN[k]) URL.revokeObjectURL(SKIN[k]); } catch (e) {}
          SKIN[k] = URL.createObjectURL(r.blob);
        }
      }, function () {});
    })).then(applySkin, function () {});
  }

  function areaEl(k) {
    if (k === "bg1") return document.querySelector("header.top");
    if (k === "bg2") return document.body;
    if (k === "bg3") return $("tabbar");
    return null;
  }

  function applySkin() {
    paintBanner();
    paintMe();
    ["bg1", "bg2", "bg3"].forEach(function (k) {
      var el = areaEl(k);
      if (!el) return;
      var col = recall(k + "col");
      if (SKIN[k]) el.style.background = "url(" + SKIN[k] + ") center/cover no-repeat";
      else if (col) el.style.background = col;
      else el.style.background = "";
    });
  }

  /* アカウントの丸。ログインしていれば頭文字、していなければ人の形。
     Googleとのやりとりは、ここを押せば全部ある */
  /* アカウントの頭文字。絵を選んでいないときは、これが丸に出る */
  function meLetter() {
    var head = (Shelf.who() || "?").trim().charAt(0).toUpperCase();
    return /[A-Za-z0-9]/.test(head) ? head : "●";
  }

  /* 同期しているあいだ、下の丸にも輪をまわす。
     アカウント画面を閉じていても、働いていることが分かるように */
  function busyMark() {
    var e = $("meBtn");
    if (!e) return;
    /* 裏で静かに走っているぶんは、見せない。
       触ってもいないのに輪が回り続けると、落ち着かない。
       押したときだけ回す（押すと quietSync が下りる） */
    if (typeof syncing !== "undefined" && syncing && !quietSync) e.classList.add("working");
    else e.classList.remove("working");
  }

  function paintMe() {
    var el = $("meBtn");
    if (!el) return;
    var who = Shelf.linked() ? Shelf.who() : "";
    el.style.backgroundImage = SKIN.me ? 'url("' + SKIN.me + '")' : "";
    if (SKIN.me) {
      el.className = "metab pic" + (Shelf.linked() ? " on" : "");
      el.textContent = "";
    } else if (Shelf.linked()) {
      el.className = "metab on";
      el.textContent = meLetter();
    } else {
      el.className = "metab";
      el.innerHTML = '<svg><use href="#i-me"/></svg>';
    }
    /* 描き直しても、回っている印が消えないように */
    busyMark();
    el.setAttribute("aria-label", Shelf.linked()
      ? ("アカウント（" + (who || "ログイン中") + "）") : "Googleでログイン");
    el.onclick = teamSheet;
  }

  function paintBanner() {
    var el = $("banner");
    if (!el) return;
    var col = recall("bannercol") || "";
    if (SKIN.banner) {
      el.className = "banner has";
      el.style.background = "";
      el.innerHTML = '<img src="' + SKIN.banner + '" alt="">';
    } else {
      el.className = "banner";
      el.style.background = col || "";
      el.innerHTML = '<span class="bmark">Rawpo</span>';
    }
  }

  /* 画像を選んで、その場所に入れる */
  var skinSlot = "";
  function pickSkin(slot) {
    skinSlot = slot;
    $("skinIn").click();
  }
  /* 場所ごとの仕上がりの寸法。この比で切り取る */
  var SKIN_SIZE = {
    banner: { w: 1200, h: 400 },   /* 横長の帯 */
    bg1:    { w: 1200, h: 800 },   /* 見出しのうしろ */
    bg2:    { w: 900,  h: 1600 },  /* 画面ぜんたい。縦長 */
    bg3:    { w: 1400, h: 320 },   /* 下のバー */
    me:     { w: 320,  h: 320 }    /* アカウントの丸。正方形で切り取る */
  };

  function saveSkin(file) {
    if (!file || !skinSlot) return;
    cropSheet(file, skinSlot);
  }

  /* 入れる前に、位置と大きさを決める画面。
     指でずらす、2本指かつまみで拡大。決めたらその見えたままを切り取って持つ */
  function cropSheet(file, slot) {
    var spec = SKIN_SIZE[slot] || SKIN_SIZE.bg2;
    var url = URL.createObjectURL(file);

    sheet('<div class="panel-head"><h3>位置と大きさ</h3>'
      + '<div style="display:flex;gap:8px">'
      + '<button class="iconbtn" id="cpNo" aria-label="やめる"><svg><use href="#i-back"/></svg></button>'
      + '<button class="iconbtn ok" id="cpOk" aria-label="これで入れる"><svg><use href="#i-check"/></svg></button>'
      + "</div></div>"
      + '<div class="panel-body">'
      + '<div class="cropbox" id="cpBox" style="aspect-ratio:' + spec.w + "/" + spec.h + '">'
      + '<img id="cpImg" src="' + url + '" alt="" draggable="false">'
      + "</div>"
      + '<div class="field"><div class="label">大きさ</div>'
      + '<input class="zoom" id="cpZoom" type="range" min="100" max="320" value="100" step="1">'
      + '<div class="hintline">画像を指でずらすと位置が変わります。2本指でつまんでも大きさを変えられます。'
      + "ここに見えているとおりに切り取って持ちます。</div></div>"
      + '<div class="panel-foot"><button class="ghost" id="cpFit">はじめに戻す</button></div>'
      + "</div>", "dialog");

    var box = $("cpBox"), img = $("cpImg"), zoom = $("cpZoom");
    var st = { s: 1, x: 0, y: 0 };      /* 拡大率と、中心からのずれ（割合） */
    var nat = { w: 0, h: 0 };

    function draw() {
      /* cover で収まる大きさを1として、そこからの拡大率で置く */
      img.style.transform = "translate(-50%, -50%) translate(" + st.x + "px, " + st.y + "px) scale(" + st.s + ")";
    }
    function clamp() {
      var bw = box.clientWidth, bh = box.clientHeight;
      var iw = img.clientWidth * st.s, ih = img.clientHeight * st.s;
      var mx = Math.max(0, (iw - bw) / 2), my = Math.max(0, (ih - bh) / 2);
      st.x = Math.max(-mx, Math.min(mx, st.x));
      st.y = Math.max(-my, Math.min(my, st.y));
    }
    img.onload = function () {
      nat.w = img.naturalWidth; nat.h = img.naturalHeight;
      st = { s: 1, x: 0, y: 0 };
      zoom.value = 100;
      draw();
    };

    zoom.oninput = function () {
      st.s = parseInt(this.value, 10) / 100;
      clamp(); draw();
    };
    $("cpFit").onclick = function () {
      st = { s: 1, x: 0, y: 0 }; zoom.value = 100; draw();
    };

    /* 指で動かす。2本なら、つまんだ幅で大きさも変える */
    var pts = {}, base = null;
    box.addEventListener("pointerdown", function (e) {
      box.setPointerCapture(e.pointerId);
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      base = null;
    });
    box.addEventListener("pointermove", function (e) {
      if (!pts[e.pointerId]) return;
      var ids = Object.keys(pts);
      if (ids.length === 1) {
        st.x += e.clientX - pts[e.pointerId].x;
        st.y += e.clientY - pts[e.pointerId].y;
        pts[e.pointerId] = { x: e.clientX, y: e.clientY };
        clamp(); draw();
      } else if (ids.length >= 2) {
        pts[e.pointerId] = { x: e.clientX, y: e.clientY };
        var a = pts[ids[0]], b = pts[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (base == null) { base = { d: d, s: st.s }; return; }
        st.s = Math.max(1, Math.min(3.2, base.s * (d / base.d)));
        zoom.value = Math.round(st.s * 100);
        clamp(); draw();
      }
    });
    ["pointerup", "pointercancel"].forEach(function (k) {
      box.addEventListener(k, function (e) { delete pts[e.pointerId]; base = null; });
    });

    $("cpNo").onclick = function () {
      try { URL.revokeObjectURL(url); } catch (e) {}
      closeSheet(); lookDialog();
    };
    $("cpOk").onclick = function () {
      var bw = box.clientWidth, bh = box.clientHeight;
      var dw = img.clientWidth * st.s, dh = img.clientHeight * st.s;   /* 画面上での見た目の大きさ */
      var k = spec.w / bw;                                             /* 画面 → 仕上がりの倍率 */
      var c = document.createElement("canvas");
      c.width = spec.w; c.height = spec.h;
      var g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(img,
        (bw / 2 + st.x - dw / 2) * k,
        (bh / 2 + st.y - dh / 2) * k,
        dw * k, dh * k);
      c.toBlob(function (blob) {
        try { URL.revokeObjectURL(url); } catch (e) {}
        if (!blob) { toast("画像を作れませんでした。", true); return; }
        putSkin(slot, blob);
      }, "image/jpeg", 0.85);
    };
  }

  function putSkin(slot, blob) {
    progress(20);
    DB.put("blobs", { id: "skin_" + slot, blob: blob }).then(function () {
      return DB.get("blobs", "skin_" + slot);
    }).then(function (r) {
      try { if (SKIN[slot]) URL.revokeObjectURL(SKIN[slot]); } catch (e) {}
      SKIN[slot] = r && r.blob ? URL.createObjectURL(r.blob) : "";
      remember(slot + "col", "");
      progress(100);
      applySkin();
      closeSheet();
      toast("入れました");
      if (slot === "me") teamSheet(); else lookDialog();
    }).catch(function (e) { progress(100); toast(why(e), true); });
  }
  function clearSkin(slot) {
    DB.del("blobs", "skin_" + slot).catch(function () {}).then(function () {
      try { if (SKIN[slot]) URL.revokeObjectURL(SKIN[slot]); } catch (e) {}
      SKIN[slot] = "";
      remember(slot + "col", "");
      applySkin();
      if (slot === "me") teamSheet(); else lookDialog();
    });
  }

  function paintSearchHint() {
    var q = $("q");
    if (!q) return;
    q.placeholder = screen === "shelf" ? "メモ・タグ・名前で探す" : "このフォルダの中を探す";
    var al = $("addLabel"), ab = $("btnAdd");
    if (al) al.textContent = screen === "shelf" ? "新しいフォルダ" : "追加";
    if (ab) ab.setAttribute("aria-label", screen === "shelf" ? "新しいフォルダを作る" : "写真や録音を追加する");
    var st = $("btnSort"), vt = document.querySelector(".viewtoggle");
    if (st) st.textContent = sortLabel();
    if (vt) vt.hidden = false;
    var g = $("vGrid"), f = $("vFeed");
    if (g && f) {
      var fu = f.querySelector("use");
      if (screen === "shelf") {
        g.title = "正方形で並べる"; g.setAttribute("aria-label", "正方形で並べる");
        f.title = "行で並べる";     f.setAttribute("aria-label", "行で並べる");
        if (fu) fu.setAttribute("href", "#i-list");
        g.setAttribute("aria-pressed", String(shelfView === "sq"));
        f.setAttribute("aria-pressed", String(shelfView === "list"));
      } else {
        g.title = "一覧"; g.setAttribute("aria-label", "一覧で見る");
        f.title = "大きく"; f.setAttribute("aria-label", "1件ずつ大きく見る");
        if (fu) fu.setAttribute("href", "#i-feed");
        syncViewToggle();
      }
    }
  }

  function paintEx() {
    var t = $("exTitle"), cb = $("exCat"), pick = $("exPick");
    var bits = [];

    if (screen === "shelf") {
      document.documentElement.setAttribute("data-screen", "shelf");
      pick.className = "exbtn still";
      pick.setAttribute("aria-label", "Rawpo");
      t.textContent = "";
      if (cb) cb.innerHTML = "";
      if (exs.length) {
        bits.push(exs.length + " フォルダ");
        bits.push(((browseAll || []).length) + " 点");
      }
      $("exMeta").innerHTML = bits.map(function (b) { return "<span>" + b + "</span>"; }).join("");
      return;
    }
    if (screen === "board") {
      document.documentElement.setAttribute("data-screen", "board");
      var bd = boardById(curBoard);
      pick.className = "exbtn back";
      pick.setAttribute("aria-label", "棚にもどる");
      t.textContent = (bd && bd.name) || "";
      if (cb) {
        cb.innerHTML = '<button class="catcrumb" id="bdSet">'
          + '<svg><use href="#i-grid"/></svg>'
          + "<span>" + esc(bd ? paperName(bd) : "") + "</span></button>";
        var bs = $("bdSet");
        if (bs) bs.onclick = function () { if (bd) boardDialog(bd); };
      }
      $("exMeta").innerHTML = bd
        ? "<span>" + pagesOf(bd).length + " ページ</span><span>" + boardCount(bd) + " 枚</span>"
        : "";
      return;
    }
    document.documentElement.setAttribute("data-screen", "folder");

    var ex = exById(curEx);
    pick.className = "exbtn back";
    pick.setAttribute("aria-label", "棚にもどる");
    t.textContent = (ex && ex.name) || "";
    if (cb) {
      var c = catOf(ex);
      cb.innerHTML = '<button class="catcrumb" id="catPick">'
        + '<svg><use href="#i-book"/></svg>'
        + "<span>" + (c ? esc(c) : "カテゴリなし") + "</span></button>";
      var cp = $("catPick");
      if (cp) cp.onclick = function () { if (ex) askCat(ex); };
    }
    if (ex) {
      if (ex.date) bits.push(esc(ex.date));
      if (ex.venue) bits.push(esc(ex.venue));
      bits.push(items.length + " 点");
      var favN = 0;
      items.forEach(function (i) { if (i.fav) favN++; });
      if (favN) bits.push("★ " + favN);
    }
    $("exMeta").innerHTML = bits.map(function (b) { return "<span>" + b + "</span>"; }).join("");
  }

  /* カテゴリの並び順。利用者が入れ替えたぶんを覚えておく。
     覚えていない名前は、あいうえお順であとに続ける */
  function catOrder() {
    try { return JSON.parse(recall("catorder") || "[]") || []; } catch (e) { return []; }
  }
  function sortCats(list) {
    var ord = catOrder();
    return list.slice().sort(function (a, b) {
      var x = ord.indexOf(a), y = ord.indexOf(b);
      if (x < 0 && y < 0) return a.localeCompare(b, "ja");
      if (x < 0) return 1;
      if (y < 0) return -1;
      return x - y;
    });
  }
  function railOpen() { return recall("railshut") !== "1"; }

  /* 棚のタブ＝カテゴリ。フォルダの中のタブ＝タグ */
  function paintRail() {
    var rail = $("rail");

    if (screen === "board") { rail.innerHTML = ""; return; }
    if (screen === "shelf") {
      if (!exs.length) { rail.innerHTML = ""; return; }
      var cc = {}, noCat = 0;
      exs.forEach(function (e) {
        var c = (e.cat || "").trim();
        if (c) cc[c] = (cc[c] || 0) + 1; else noCat++;
      });
      var cks = sortCats(Object.keys(cc));

      /* たたんであるときは、いま選んでいるものだけを出す。
         カテゴリが増えると帯だけで画面がうるさくなるため */
      if (!railOpen()) {
        var nm = curCat === "all" ? "すべて" : (curCat === "none" ? "カテゴリなし" : curCat);
        var cn = curCat === "all" ? exs.length : (curCat === "none" ? noCat : (cc[curCat] || 0));
        rail.innerHTML = '<button class="tag railtog" id="railMore" aria-pressed="true">'
          + esc(nm) + '<span class="n">' + cn + '</span><span class="chev"></span></button>';
        $("railMore").onclick = function () { remember("railshut", ""); paintRail(); };
        return;
      }

      var h = '<button class="tag" data-c="all" aria-pressed="' + (curCat === "all") + '">すべて<span class="n">' + exs.length + "</span></button>";
      cks.forEach(function (c) {
        h += '<button class="tag" data-c="' + esc(c) + '" aria-pressed="' + (curCat === c) + '" data-cat="' + esc(c) + '">' + esc(c) + '<span class="n">' + cc[c] + "</span></button>";
      });
      if (noCat && cks.length) h += '<button class="tag" data-c="none" aria-pressed="' + (curCat === "none") + '">カテゴリなし<span class="n">' + noCat + "</span></button>";
      h += '<button class="tag railtog shut" id="railLess" aria-label="カテゴリをたたむ"><span class="chev up"></span></button>';
      rail.innerHTML = h;
      $("railLess").onclick = function () { remember("railshut", "1"); paintRail(); };
      wireCatHold(rail);
      return;
    }

    /* タグの一覧は上に出さない。上がうるさくなるため。
       絞り込んでいるときだけ、いま何で絞っているかを出す */
    if (!curEx || curTag === "all") { rail.innerHTML = ""; return; }
    var label = curTag === "none" ? "タグなし" : "#" + curTag;
    rail.innerHTML = '<button class="tag" data-t="all" aria-pressed="true">'
      + esc(label) + '<span class="n">' + visible().length + "</span>"
      + '<span class="clearx">×</span></button>';
  }

  /* カテゴリの札を長押しして、横に並べ替える。
     タイルの並べ替えと同じ考え方で、こちらは横一列ぶん */
  function wireCatHold(rail) {
    if (rail._cathold) return;
    rail._cathold = true;
    var timer = null, held = false, node = null, sx = 0, dragging = false;
    var eat = false, eatTimer = null;

    function lift(n) {
      n.classList.add("lifted");
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (x) {} }
    }
    function drop() {
      Array.prototype.forEach.call(rail.querySelectorAll(".lifted"), function (n) { n.classList.remove("lifted"); });
    }
    function eatClick() {
      eat = true;
      clearTimeout(eatTimer);
      eatTimer = setTimeout(function () { eat = false; }, 400);
    }
    function save() {
      var out = [];
      Array.prototype.forEach.call(rail.querySelectorAll("[data-cat]"), function (n) {
        out.push(n.getAttribute("data-cat"));
      });
      try { remember("catorder", JSON.stringify(out)); } catch (e) {}
      toast("この並びで覚えました");
    }

    rail.addEventListener("dragstart", function (e) { e.preventDefault(); });
    rail.addEventListener("touchmove", function (e) { if (held) e.preventDefault(); }, { passive: false });

    rail.addEventListener("pointerdown", function (e) {
      var n = e.target.closest("[data-cat]");
      if (!n) return;
      node = n; sx = e.clientX; held = false; dragging = false;
      clearTimeout(timer);
      timer = setTimeout(function () { held = true; lift(n); }, 450);
    });

    rail.addEventListener("pointermove", function (e) {
      if (!node) return;
      if (!held) { if (Math.abs(e.clientX - sx) > 9) clearTimeout(timer); return; }
      if (!dragging) {
        dragging = true;
        try { rail.setPointerCapture(e.pointerId); } catch (x) {}
        rail.classList.add("reordering");
      }
      e.preventDefault();
      /* 指が入っている札の、左半分なら手前、右半分なら後ろへ差し込む */
      var over = null;
      Array.prototype.forEach.call(rail.querySelectorAll("[data-cat]"), function (t) {
        if (t === node) return;
        var b2 = t.getBoundingClientRect();
        if (e.clientX >= b2.left && e.clientX <= b2.right) over = t;
      });
      if (!over) return;
      var b3 = over.getBoundingClientRect();
      rail.insertBefore(node, e.clientX > b3.left + b3.width / 2 ? over.nextSibling : over);
    });

    ["pointerup", "pointercancel", "pointerleave"].forEach(function (k) {
      rail.addEventListener(k, function () {
        clearTimeout(timer);
        var wasDrag = dragging, wasHeld = held;
        held = false; dragging = false; node = null;
        rail.classList.remove("reordering");
        drop();
        if (wasDrag) { eatClick(); save(); return; }
        if (wasHeld) eatClick();
      });
    });

    rail.addEventListener("click", function (e) {
      if (!eat) return;
      eat = false;
      clearTimeout(eatTimer);
      e.preventDefault(); e.stopPropagation();
    }, true);
  }

  function standalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  /* 試用のための枠の中では、ホーム画面に入れられない */
  function inFrame() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }

  /* 案内は画面に出しっぱなしにせず、メニューの中に置く */
  function installRow() {
    if (standalone() || inFrame()) return "";
    var how = deferredInstall
      ? "アプリとして開けるようになります。電波がなくても動きます"
      : isIOS()
        ? "共有ボタン →「ホーム画面に追加」を選んでください"
        : "ブラウザのメニュー →「アプリをインストール」を選んでください";
    return '<button class="rowbtn" id="sInstall"><div><b>ホーム画面に追加する</b>'
      + "<span>" + esc(how) + '</span></div><svg><use href="#i-plus"/></svg></button>';
  }

  /* フォルダの長押し。押したまま指を動かさなければ選択肢を出す */
  function wireFolderHold(box) {
    if (!box || box._hold) return;
    box._hold = true;
    var timer = null, id = "", x0 = 0, y0 = 0, fired = false;

    function stop() { if (timer) { clearTimeout(timer); timer = null; } }

    box.addEventListener("pointerdown", function (ev) {
      var f = ev.target.closest("[data-folder]");
      if (!f) return;
      id = f.getAttribute("data-folder");
      x0 = ev.clientX; y0 = ev.clientY; fired = false;
      stop();
      timer = setTimeout(function () {
        timer = null; fired = true;
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
        folderMenu(id);
      }, 480);
    });
    box.addEventListener("pointermove", function (ev) {
      if (!timer) return;
      if (Math.abs(ev.clientX - x0) > 9 || Math.abs(ev.clientY - y0) > 9) stop();
    }, { passive: true });
    box.addEventListener("pointerup", function () { stop(); });
    box.addEventListener("pointercancel", function () { stop(); fired = false; });
    /* 長押しで開いたときは、指を離したあとのタップを飲み込む */
    box.addEventListener("click", function (ev) {
      if (!fired) return;
      fired = false;
      ev.stopPropagation();
      ev.preventDefault();
    }, true);
    box.addEventListener("contextmenu", function (ev) {
      if (ev.target.closest("[data-folder]")) ev.preventDefault();
    });
  }

  /* フォルダを長押ししたときの選択肢 */
  function folderMenu(id) {
    var e = exById(id);
    if (!e) return;
    var n = (browseAll || []).filter(function (x) { return x.exId === id; }).length;

    sheet('<div class="panel-head"><h3>' + esc(e.name) + "</h3>"
      + '<button class="iconbtn" id="fmClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div>'
      + '<div class="panel-body"><div class="stack">'
      + '<button class="rowbtn" id="fmOpen"><div><b>開く</b><span>'
      + n + " 点" + ((e.cat || "").trim() ? "　" + esc((e.cat || "").trim()) : "") + "</span></div>"
      + '<svg><use href="#i-chev"/></svg></button>'
      + '<button class="rowbtn" id="fmShare"><div><b>ダウンロード・共有</b>'
      + "<span>写真とメモをZIPで。AirDrop・LINE・メールへも送れます</span></div>"
      + '<svg><use href="#i-share"/></svg></button>'
      + '<button class="rowbtn" id="fmEdit"><div><b>名前と設定を変える</b>'
      + "<span>名前・カテゴリ・日付・場所・フォーマット</span></div>"
      + '<svg><use href="#i-book"/></svg></button>'
      + '<button class="rowbtn danger-row" id="fmDel"><div><b>削除する</b>'
      + "<span>中の写真・録音・メモもいっしょに消えます</span></div>"
      + '<svg><use href="#i-x"/></svg></button>'
      + "</div></div>", "dialog");

    $("fmClose").onclick = closeSheet;
    $("fmOpen").onclick = function () { closeSheet(); openFolder(id); };
    $("fmShare").onclick = function () { closeSheet(); exportNotes(id); };
    $("fmEdit").onclick = function () { closeSheet(); newExDialog(e); };
    $("fmDel").onclick = function () { closeSheet(); killFolder(e); };
  }

  /* フォルダを、開いていなくても消せるようにする */
  function killFolder(e) {
    askYesNo({
      title: "「" + e.name + "」を削除",
      body: "このフォルダと、その中の写真・録音・メモをすべて消します。取り消せません。",
      ok: "すべて削除する"
    }, function () {
      DB.byEx(e.id).then(function (list) {
        var kill = [];
        list.forEach(function (it) {
          kill.push(["items", it.id]);
          if (it.blobId) kill.push(["blobs", it.blobId]);
          if (it.thumbId && it.thumbId !== it.blobId) kill.push(["blobs", it.thumbId]);
        });
        kill.push(["exhibitions", e.id]);
        return DB.delMany(kill);
      }).then(function () {
        exs = exs.filter(function (x) { return x.id !== e.id; });
        if (curEx === e.id) { curEx = null; remember("ex", ""); }
        return goShelf();
      }).then(function () {
        gauge();
        toast("削除しました");
      }).catch(function (er) { toast(why(er), true); });
    });
  }

  /* 棚。いまのカテゴリのフォルダが並ぶ。
     検索・タグ・★を使ったときは、フォルダではなく中身の写真を横断して出す */
  function paintShelf(stage, seq) {
    var all = browseAll || [];
    var q = normQ(query);
    var digging = !!(q || shelfTag || favOnly);

    function inCat(e) {
      if (!e) return false;
      var c = (e.cat || "").trim();
      if (curCat === "none") return !c;
      if (curCat === "all") return true;
      return c === curCat;
    }

    var cover = {}, counts = {}, favs = {}, byEx = {};
    all.forEach(function (it) {
      counts[it.exId] = (counts[it.exId] || 0) + 1;
      if (it.fav) favs[it.exId] = (favs[it.exId] || 0) + 1;
      (byEx[it.exId] || (byEx[it.exId] = [])).push(it);
    });
    /* 表紙は、そのフォルダを開いたとき左上に来る写真。
       並べ替えると表紙もついてくる */
    Object.keys(byEx).forEach(function (ex) {
      var rows = sortItems(byEx[ex]);
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].kind === "photo") { cover[ex] = rows[i]; return; }
      }
    });

    var folders = sortFolders(exs, favs).filter(function (e) {
      if (!inCat(e)) return false;
      if (shelfTag || favOnly) return false;
      if (!q) return true;
      var hay = (e.name || "") + " " + (e.venue || "") + " " + (e.note || "")
        + " " + (e.date || "") + " " + (e.cat || "");
      return hay.toLowerCase().indexOf(q) >= 0;
    });

    var hits = [];
    if (digging) {
      hits = all.filter(function (it) {
        if (!inCat(exById(it.exId))) return false;
        if (favOnly && !it.fav) return false;
        if (shelfTag && (it.tags || []).indexOf(shelfTag) < 0) return false;
        if (!q) return true;
        var hay = (it.memo || "") + " " + (it.tags || []).join(" ");
        return hay.toLowerCase().indexOf(q) >= 0;
      });
      hits = sortItems(hits).slice(0, 90);
    }

    /* いまのカテゴリで使われているタグ */
    var tc = {};
    all.forEach(function (it) {
      if (!inCat(exById(it.exId))) return;
      (it.tags || []).forEach(function (t) { tc[t] = (tc[t] || 0) + 1; });
    });
    var tks = Object.keys(tc).sort(function (a, b) {
      return tc[b] - tc[a] || a.localeCompare(b, "ja");
    });

    var need = [];
    folders.forEach(function (e) { if (cover[e.id]) need.push(cover[e.id].thumbId || cover[e.id].blobId); });
    hits.forEach(function (it) { if (it.thumbId || it.blobId) need.push(it.thumbId || it.blobId); });

    ensureUrls(need).then(function () {
      if (seq !== paintSeq) return;
      var out = [];

      /* タグの一覧は並べない。いま何で絞っているかだけ出す */
      if (shelfTag || favOnly || q) {
        var marks = [];
        if (shelfTag) marks.push('<button class="hash" data-stag="" aria-pressed="true">#' + esc(shelfTag)
          + '<span class="n">' + (tc[shelfTag] || 0) + '</span><span class="clearx">×</span></button>');
        if (favOnly) marks.push('<button class="hash" id="clrFav" aria-pressed="true">★ だけ'
          + '<span class="clearx">×</span></button>');
        if (q) marks.push('<button class="hash" id="clrQ" aria-pressed="true">「' + esc(query.trim()) + '」'
          + '<span class="clearx">×</span></button>');
        out.push('<div class="shelfsec tagsec"><div class="hashrow">' + marks.join("") + "</div></div>");
      }

      if (folders.length) {
        out.push('<div class="shelfsec"><div class="label">フォルダ<span class="n">' + folders.length + "</span></div>");
        if (shelfView === "sq") out.push('<div class="sqgrid">');
        folders.forEach(function (e) {
          var cv = cover[e.id];
          var src = cv ? urlCache[cv.thumbId || cv.blobId] : "";
          var sub = [];
          if (curCat === "all" && (e.cat || "").trim()) sub.push((e.cat || "").trim());
          if (e.date) sub.push(e.date);
          if (e.venue) sub.push(e.venue);

          if (shelfView === "sq") {
            out.push('<div class="fsqwrap"><button class="fsq" data-folder="' + esc(e.id) + '">'
              + '<span class="fsqimg"' + (src ? ' style="background-image:url(' + src + ')"' : "") + ">"
              + '<span class="fsqn">' + (counts[e.id] || 0) + "</span>"
              + (favs[e.id] ? '<span class="fsqstar">★' + favs[e.id] + "</span>" : "")
              + "</span>"
              + '<span class="fsqname">' + esc(e.name) + "</span>"
              + '<span class="fsqsub">' + esc(sub.join(" · ")) + "</span></button>"
              + '<button class="fmore" data-more="' + esc(e.id) + '" aria-label="'
              + esc(e.name) + 'の操作">…</button></div>');
          } else {
            out.push('<div class="frowwrap"><button class="folderrow" data-folder="' + esc(e.id) + '">'
              + (src ? '<img class="fthumb" src="' + src + '" alt="">' : '<span class="fthumb"></span>')
              + '<span class="fmid"><span class="fname">' + esc(e.name) + "</span>"
              + '<span class="fsub">' + esc(sub.join(" · ")) + "</span></span>"
              + '<span class="fcount">' + (counts[e.id] || 0)
              + (favs[e.id] ? '<i class="fstar">★' + favs[e.id] + "</i>" : "") + "</span></button>"
              + '<button class="fmore" data-more="' + esc(e.id) + '" aria-label="'
              + esc(e.name) + 'の操作">…</button></div>');
          }
        });
        if (shelfView === "sq") out.push("</div>");
        out.push("</div>");
      } else if (!digging) {
        out.push('<div class="bnone">このカテゴリにはまだフォルダがありません</div>');
      }

      /* ボードはフォルダを跨ぐものなので、カテゴリでは絞らない */
      if (boards.length && !digging) {
        out.push('<div class="shelfsec"><div class="label">ボード<span class="n">' + boards.length + "</span></div>");
        out.push('<div class="bdgrid">');
        boards.slice().sort(function (x, y) { return (y.upAt || 0) - (x.upAt || 0); }).forEach(function (bd) {
          var sz = paperSize(bd);
          out.push('<button class="bdcard" data-board="' + esc(bd.id) + '">'
            + '<span class="bdpaper" style="aspect-ratio:' + sz.w + "/" + sz.h + '"></span>'
            + '<span class="bdname">' + esc(bd.name) + "</span>"
            + '<span class="bdsub">' + esc(paperName(bd)) + " · "
            + pagesOf(bd).length + " ページ · " + boardCount(bd) + " 枚</span>"
            + "</button>");
        });
        out.push("</div></div>");
      }

      if (digging) {
        out.push('<div class="shelfsec"><div class="label">写真・メモ<span class="n">'
          + hits.length + (hits.length >= 90 ? "+" : "") + "</span></div>");
        if (!hits.length) out.push('<div class="bnone">見つかりませんでした</div>');
        else {
          out.push('<div class="hitgrid">');
          hits.forEach(function (it) {
            var ex = exById(it.exId);
            var src = urlCache[it.thumbId || it.blobId];
            var inner;
            if (it.kind === "photo" && src) inner = '<img src="' + src + '" loading="lazy" alt="">';
            else if (it.kind === "video" && src) inner = '<video src="' + src + '#t=0.1" preload="metadata" muted playsinline></video>';
            else if (it.kind === "file") inner = '<div class="htext hfile">' + esc(fileMark(it)) + "<br>" + esc((it.name || "").slice(0, 40)) + "</div>";
            else inner = '<div class="htext">' + esc((it.memo || "（メモなし）").slice(0, 60)) + "</div>";
            out.push('<button class="hit" data-hit="' + esc(it.id) + '" data-hitex="' + esc(it.exId) + '">'
              + inner + '<span class="hwhere">' + esc(ex ? ex.name : "") + "</span></button>");
          });
          out.push("</div>");
        }
        out.push("</div>");
      }

      stage.innerHTML = out.join("");
      wireFolderHold(stage);
      var cf = $("clrFav");
      if (cf) cf.onclick = function () {
        favOnly = false;
        var fb = $("btnFav"); if (fb) fb.setAttribute("aria-pressed", "false");
        paintStage();
      };
      var cq = $("clrQ");
      if (cq) cq.onclick = function () { query = ""; $("q").value = ""; paintStage(); };
    });
  }

  function paintStage() {
    var stage = $("stage"), seq = ++paintSeq;
    if (!booted) return;

    if (screen === "board") { paintBoard(stage, seq); return; }
    if (!exs.length && !boards.length) { stage.innerHTML = welcome(); return; }
    if (screen === "shelf") { paintShelf(stage, seq); return; }

    var list = visible();
    if (!list.length) {
      if (items.length) {
        stage.innerHTML = '<div class="nothing">この条件に合う写真はありません。</div>';
      } else {
        stage.innerHTML = '<div class="blank"><h2>' + esc((exById(curEx) || {}).name || "") + " はまだ空です</h2>"
          + '<p>下の <span class="inlineplus">＋</span> から、撮る・写真・音声・動画・書類・メモを追加できます。'
          + "現場ではまず撮って放り込むだけで大丈夫です。整理は帰ってからまとめてやれます。</p></div>";
      }
      return;
    }

    var need = list.map(function (it) {
      return viewMode === "feed" ? it.blobId : (it.thumbId || it.blobId);
    });
    ensureUrls(need).then(function () {
      if (seq !== paintSeq) return;
      if (viewMode === "feed") { stage.innerHTML = feedHtml(list); wireFeed(list); return; }
      var html = '<div class="sheetgrid">';
      list.forEach(function (it, n) {
        var pips = "";
        if (it.fav) pips += '<span class="pip fav"><svg><use href="#i-star"/></svg></span>';
        if (it.memo) pips += '<span class="pip"><svg><use href="#i-note"/></svg></span>';
        var src = urlCache[it.thumbId || it.blobId];
        var body;
        if (it.kind === "photo") {
          body = src ? '<img src="' + src + '" loading="lazy" decoding="async" alt="">' : '<div class="mediatile"></div>';
        } else if (it.kind === "video") {
          body = src ? '<video src="' + src + '#t=0.1" preload="metadata" muted playsinline></video>' : '<div class="mediatile"></div>';
          pips += '<span class="pip"><svg><use href="#i-vid"/></svg></span>';
        } else if (it.kind === "text") {
          body = '<div class="texttile">'
            + '<div class="tt">' + (it.memo ? esc(it.memo) : '<span class="ttempty">（空のメモ）</span>') + "</div></div>";
        } else if (it.kind === "file") {
          body = fileTile(it);
          pips += '<span class="pip"><svg><use href="#i-doc"/></svg></span>';
        } else {
          var bars = "";
          for (var k = 0; k < 16; k++) {
            var h = 18 + ((it.id.charCodeAt(k % it.id.length) * 7) % 80);
            bars += '<i style="height:' + h + '%"></i>';
          }
          body = '<div class="mediatile"><div class="kindlabel">VOICE MEMO</div><div class="wave">' + bars + "</div>"
            + '<div class="dur">' + clock(it.durMs) + "</div></div>";
          pips += '<span class="pip"><svg><use href="#i-mic"/></svg></span>';
        }
        var tg = (it.tags || [])[0] || "";
        var on = !!picked[it.id];
        html += '<button class="frame' + (picking ? " picking" : "") + '" data-open="' + esc(it.id) + '"'
          + (picking ? ' aria-pressed="' + on + '"' : "") + ">"
          + body
          + (tg ? '<span class="brandstrip">#' + esc(tg) + "</span>" : "")
          + '<span class="pips">' + pips + "</span>"
          + (picking ? '<span class="tick">' + (on ? "✓" : "") + "</span>" : "")
          + "</button>";
      });
      html += "</div>";
      stage.innerHTML = html;
      wireItemHold(stage);
      pickBar();
    });
  }

  /* 写真を長押しすると、その1枚が持ち上がる。
     そのまま指を動かせば並べ替え、指を離せば「選ぶ」に入る。
     iPhoneのホーム画面と同じで、どちらも長押しから始まる */
  function wireItemHold(box) {
    if (box._itemwired) return;
    box._itemwired = true;
    var timer = null, sx = 0, sy = 0, held = false, id = null, node = null, drag = null;

    /* 長押しや並べ替えのあとに続くクリックを、1回だけ飲み込む。
       飲み込む約束を held で代用していたせいで、並べ替えのあと
       クリックが来ないときに held が立ったまま残り、
       次に押した1回（別の画面のフォルダなど）が消えていた。
       来なければ、すぐに忘れる */
    var eat = false, eatTimer = null;
    function eatClick() {
      eat = true;
      clearTimeout(eatTimer);
      eatTimer = setTimeout(function () { eat = false; }, 400);
    }

    function lift(n) {
      n.classList.add("lifted");
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (x) {} }
    }
    function drop() {
      if (node) node.classList.remove("lifted");
    }

    /* 写真をつまむと、ブラウザが「画像を持ち出す」動作を始めて
       指の追跡が打ち切られてしまう。これを止める */
    box.addEventListener("dragstart", function (e) { e.preventDefault(); });
    /* 持ち上がっているあいだは、指で動かしても画面をスクロールさせない。
       touch-action だけでは、指が動き出したあとに変えても間に合わない */
    box.addEventListener("touchmove", function (e) {
      if (held) e.preventDefault();
    }, { passive: false });

    box.addEventListener("pointerdown", function (e) {
      var f = e.target.closest("[data-open]");
      if (!f) return;
      id = f.getAttribute("data-open"); node = f;
      sx = e.clientX; sy = e.clientY; held = false; drag = null;
      clearTimeout(timer);
      timer = setTimeout(function () { held = true; lift(f); }, 450);
    });

    box.addEventListener("pointermove", function (e) {
      var far = Math.abs(e.clientX - sx) > 9 || Math.abs(e.clientY - sy) > 9;
      if (!held) { if (far) clearTimeout(timer); return; }
      /* 持ち上がっている状態で動かしたら、並べ替えに入る */
      if (!drag && far && !picking && node && node.parentNode
          && node.parentNode.classList.contains("sheetgrid")) {
        try { box.setPointerCapture(e.pointerId); } catch (x) {}
        drag = beginReorder(node, e);
      }
      if (drag) { e.preventDefault(); drag.move(e.clientX, e.clientY); }
    });

    ["pointerup", "pointercancel", "pointerleave"].forEach(function (k) {
      box.addEventListener(k, function (e) {
        clearTimeout(timer);
        var was = held;
        held = false;
        if (drag) { var d = drag; drag = null; drop(); eatClick(); d.end(); return; }
        if (was && k === "pointerup") {
          /* 動かさずに離した → これまで通り「選ぶ」に入る */
          drop();
          eatClick();
          if (!picking) { picking = true; picked = {}; }
          picked[id] = true;
          paintStage();
          return;
        }
        drop();
      });
    });

    /* 長押し・並べ替えのあとに続くクリックは飲み込む */
    box.addEventListener("click", function (e) {
      if (!eat) return;
      eat = false;
      clearTimeout(eatTimer);
      e.preventDefault(); e.stopPropagation();
    }, true);
    box.addEventListener("contextmenu", function (e) {
      if (e.target.closest("[data-open]")) e.preventDefault();
    });
  }

  /* 並べ替えの本体。指の下に分身を置いて、近いタイルの前か後ろに
     本体を差し込む。並びはその場で組み変わるので、置いた先が目で分かる */
  function beginReorder(node, e) {
    var grid = node.parentNode;
    var r = node.getBoundingClientRect();
    var ghost = node.cloneNode(true);
    ghost.className = "dragghost";
    ghost.style.width = r.width + "px";
    ghost.style.height = r.height + "px";
    document.body.appendChild(ghost);
    node.classList.add("ghosted");
    grid.classList.add("reordering");

    /* 画面のふちに寄せたら、ひとりでにスクロールする。
       ふちは画面の端ではなく、上の帯の下と下の帯の上。
       帯は居座っているので、画面の端で測るとその裏が当たり判定になり、
       いくら寄せてもスクロールが始まらない */
    var edge = 0, lastX = 0, lastY = 0;
    function zone() {
      var head = document.querySelector("header.top");
      var dock = document.querySelector(".dock .tabbar") || document.querySelector(".dock");
      var top = head ? head.getBoundingClientRect().bottom : 0;
      var bot = dock ? dock.getBoundingClientRect().top : window.innerHeight;
      if (!(bot > top + 80)) { top = 0; bot = window.innerHeight; }
      return { top: top, bot: bot };
    }
    var tick = setInterval(function () {
      if (!edge) return;
      var was = window.scrollY;
      window.scrollBy(0, edge);
      /* 動いたぶんタイルもずれるので、指が止まっていても置き場所を見直す */
      if (window.scrollY !== was) place(lastX, lastY);
    }, 16);

    function place(x, y) {
      lastX = x; lastY = y;
      ghost.style.left = x + "px";
      ghost.style.top = y + "px";

      var z = zone(), band = 64;
      /* ふちに食い込んだ深さで速さを変える。端ほど速い */
      if (y < z.top + band) edge = -Math.ceil(Math.min(1, (z.top + band - y) / band) * 14);
      else if (y > z.bot - band) edge = Math.ceil(Math.min(1, (y - (z.bot - band)) / band) * 14);
      else edge = 0;

      /* いま指が乗っているタイルだけを見る。いちばん近いタイルを探す
         やり方だと、行き過ぎたときに隣の行を拾って、並びが行き来してしまう */
      var over = null;
      Array.prototype.forEach.call(grid.children, function (t) {
        if (t === node) return;
        var b = t.getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) over = t;
      });
      if (!over) return;
      var b = over.getBoundingClientRect();
      /* そのタイルの左半分なら手前、右半分なら後ろに入れる */
      grid.insertBefore(node, x > b.left + b.width / 2 ? over.nextSibling : over);
    }

    return {
      move: place,
      end: function () {
        clearInterval(tick);
        try { ghost.remove(); } catch (x) {}
        node.classList.remove("ghosted");
        grid.classList.remove("reordering");
        saveOrder(grid);
      }
    };
  }

  /* 並べた結果を残す。絞り込みで隠れているものを巻き込まないよう、
     いま見えているものが元から持っていた番号を、順番だけ入れ替えて配り直す */
  function saveOrder(grid) {
    var rows = [];

    /* まだ番号がないなら、いまの並びを土台にして全部に振る */
    if (items.some(function (x) { return typeof x.ord !== "number"; })) {
      sortItems(items.slice()).forEach(function (it, i) {
        it.ord = i; rows.push(["items", it]);
      });
    }

    var ids = Array.prototype.slice.call(grid.children)
      .map(function (n) { return n.getAttribute("data-open"); })
      .filter(Boolean);
    var seen = ids.map(itemById).filter(Boolean);
    var slots = seen.map(function (it) { return it.ord; }).sort(function (a, b) { return a - b; });
    seen.forEach(function (it, i) {
      if (it.ord !== slots[i]) { it.ord = slots[i]; }
      rows.push(["items", it]);
    });

    sortMode = "mine";
    remember("sort", "mine");
    var sb = $("btnSort");
    if (sb) sb.textContent = sortLabel();
    DB.putMany(rows).then(function () {
      syncBrowse(rows.map(function (r) { return r[1]; }));
      paintRail(); paintStage();
      toast("この並びで覚えました");
    }).catch(function (e) { toast(why(e), true); paintStage(); });
  }

  /* 選んでいる間、下に出る帯 */
  function pickBar() {
    var bar = $("pickbar");
    if (!picking) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "pickbar";
      bar.id = "pickbar";
      document.body.appendChild(bar);
    }
    var n = pickCount();
    bar.innerHTML = '<span class="pn">' + n + " 件</span>"
      + '<button data-pk="all">すべて</button>'
      + '<button data-pk="share"' + (n ? "" : " disabled") + ">共有</button>"
      + '<button data-pk="tag"' + (n ? "" : " disabled") + ">タグ</button>"
      + '<button data-pk="del" class="bad"' + (n ? "" : " disabled") + ">削除</button>"
      + '<button data-pk="off" class="off">やめる</button>';
    var dock = document.querySelector(".dock");
    bar.style.bottom = ((dock ? Math.round(dock.getBoundingClientRect().height) : 92) + 10) + "px";
    Array.prototype.forEach.call(bar.querySelectorAll("[data-pk]"), function (b) {
      b.onclick = function () { pickAct(b.getAttribute("data-pk")); };
    });
  }

  function pickOff() {
    picking = false; picked = {};
    var bar = $("pickbar");
    if (bar) bar.remove();
    paintStage();
  }

  function pickAct(k) {
    var ids = pickedIds();
    var list = items.filter(function (it) { return picked[it.id]; });
    if (k === "off") { pickOff(); return; }
    if (k === "all") {
      var vis = visible();
      var everyone = vis.every(function (it) { return picked[it.id]; });
      picked = {};
      if (!everyone) vis.forEach(function (it) { picked[it.id] = true; });
      paintStage();
      return;
    }
    if (!ids.length) return;
    if (k === "share") {
      var ex = exById(curEx);
      if (ex) exportSheet(ex, list, true);
      return;
    }
    if (k === "tag") { tagPrompt(ids); return; }
    if (k === "del") {
      askYesNo({
        title: ids.length + " 件を削除",
        body: "選んだものを消します。取り消せません。",
        ok: "削除する"
      }, function () {
        var kill = [];
        list.forEach(function (it) {
          kill.push(["items", it.id]);
          if (it.blobId) kill.push(["blobs", it.blobId]);
          if (it.thumbId && it.thumbId !== it.blobId) kill.push(["blobs", it.thumbId]);
        });
        DB.delMany(kill).then(function () {
          items = items.filter(function (it) { return !picked[it.id]; });
          if (browseAll) browseAll = browseAll.filter(function (it) { return !picked[it.id]; });
          toast(ids.length + " 件を削除しました");
          pickOff(); gauge();
        }).catch(function (e) { toast(why(e), true); });
      });
    }
  }

  function welcome() {
    return '<div class="blank">'
      + "<h2>写真・音声・動画を、ひとつのフォルダに</h2>"
      + "<p>展示会・案件・旅行・議事録。ひとまとまりごとにフォルダを作って、"
      + "その場で撮ったものを放り込んでいきます。手が離せないときは声で残せます。</p>"
      + '<ol class="steps">'
      + '<li><span class="k">01</span><div><b>フォルダをつくる</b>'
      + "<span>ひとつの案件・旅行・会議につき、ひとつ。テンプレートを選ぶと、名前とメモの形が最初から入ります。</span></div></li>"
      + '<li><span class="k">02</span><div><b>放り込む</b>'
      + '<span>下の <span class="inlineplus">＋</span> から、撮る・写真・音声・動画・書類・メモ。数の上限はありません。</span></div></li>'
      + '<li><span class="k">03</span><div><b>カテゴリで絞り込む</b>'
      + "<span>「仕事」「旅」などの名前を付けておくと、この画面の上でそれを押したとき、そのフォルダだけが並びます。</span></div></li>"
      + '<li><span class="k">04</span><div><b>タグで拾う</b>'
      + "<span>写真1枚に何個でも。＃を押すと、フォルダをまたいで同じタグの写真が集まります。★だけを抜き出すこともできます。</span></div></li>"
      + "</ol>"
      + '<button class="cta" id="goNewEx">フォルダをつくる</button>'
      + (Shelf.linked() ? ""
          : '<p class="blanklog">別の端末でもう使っているなら、'
            + '<button class="linklike" id="goLogin">Googleでログイン</button>'
            + "すると、そのままの中身が出てきます。</p>")
      + "</div>";
  }

  /* ============================================================
     入力のふりわけ
     ============================================================ */
  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-t]");
    if (t) {
      var b = t.getAttribute("data-t");
      curTag = (curTag === b && b !== "all") ? "all" : b;
      paintRail(); paintStage(); return;
    }
    var c = ev.target.closest("[data-c]");
    if (c) {
      curCat = c.getAttribute("data-c");
      shelfTag = "";
      paintRail(); paintStage(); return;
    }
    var ta = ev.target.closest("[data-tagall]");
    if (ta) { tagSheet(ta.getAttribute("data-tagall")); return; }
    var g = ev.target.closest("[data-stag]");
    if (g) {
      var v = g.getAttribute("data-stag");
      shelfTag = (shelfTag === v) ? "" : v;
      paintStage(); return;
    }
    var mo = ev.target.closest("[data-more]");
    if (mo) { folderMenu(mo.getAttribute("data-more")); return; }
    var f = ev.target.closest("[data-folder]");
    if (f) { openFolder(f.getAttribute("data-folder")); return; }
    var h = ev.target.closest("[data-hit]");
    if (h) {
      var hid = h.getAttribute("data-hit");
      openFolder(h.getAttribute("data-hitex")).then(function () {
        setTimeout(function () { openItem(hid); }, 180);
      });
      return;
    }
    var o = ev.target.closest("[data-open]");
    if (o) {
      var oid = o.getAttribute("data-open");
      if (picking) {
        if (picked[oid]) delete picked[oid]; else picked[oid] = true;
        paintStage();
        return;
      }
      openItem(oid);
      return;
    }
    if (ev.target.id === "goNewEx") { newExDialog(); return; }
    if (ev.target.id === "goLogin") { teamSheet(); return; }
  });

  $("exPick").onclick = function () { if (screen === "folder") goShelf(); };

  function clearSearch() {
    query = ""; $("q").value = "";
    favOnly = false;
    var fb = $("btnFav"); if (fb) fb.setAttribute("aria-pressed", "false");
  }

  /* 棚へ戻る。フォルダが並んでいるところ */
  function goShelf() {
    picking = false; picked = {};
    screen = "shelf"; curBoard = null; boardSel = "";
    dropFix();
    clearSearch(); shelfTag = "";
    dropUrls(); items = [];
    return DB.all("items").then(function (all) { browseAll = all; }, function () {})
      .then(function () { paint(); gauge(); });
  }

  /* 棚でボードを押したら開く */
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-board]");
    if (!b) return;
    openBoard(b.getAttribute("data-board"));
  });

  /* フォルダを開く。中の写真・録音・メモが並ぶ */
  function openFolder(id) {
    if (!id) return Promise.resolve();
    picking = false; picked = {};
    dropFix();
    screen = "folder";
    curEx = id; remember("ex", curEx);
    curTag = "all"; clearSearch();
    return loadItems().then(function () { paint(); gauge(); });
  }
  $("q").oninput = function () { query = this.value; paintStage(); };
  window.addEventListener("popstate", function () { if (screen === "folder") goShelf(); });
  $("btnFav").onclick = function () {
    favOnly = !favOnly;
    this.setAttribute("aria-pressed", String(favOnly));
    paintStage();
  };
  $("btnSort").onclick = function () {
    var ls = sortList(), i = -1;
    for (var k = 0; k < ls.length; k++) if (ls[k].k === sortMode) i = k;
    sortMode = ls[(i + 1) % ls.length].k;
    remember("sort", sortMode);
    this.textContent = sortLabel();
    paintStage();
  };
  Array.prototype.forEach.call(document.querySelectorAll("[data-nav]"), function (b) {
    b.onclick = function () {
      var k = b.getAttribute("data-nav");
      if (k === "home") { if (screen !== "shelf") goShelf(); else window.scrollTo({ top: 0, behavior: "smooth" }); }
      else if (k === "tags") { tagSheet(screen === "folder" ? "folder" : "shelf"); return; }
      else if (k === "add") {
        if (screen === "board") boardPick();
        else if (screen === "shelf") makeMenu();
        else addMenu();
        return;
      }
      else { menuDialog(); return; }
      markNav("home");
    };
  });
  function markNav(k) {
    Array.prototype.forEach.call(document.querySelectorAll("[data-nav]"), function (b) {
      b.setAttribute("aria-current", String(b.getAttribute("data-nav") === k));
    });
  }

  $("vGrid").onclick = function () {
    if (screen === "shelf") { shelfView = "sq"; remember("shelfview", "sq"); paintSearchHint(); paintStage(); }
    else setView("grid");
  };
  $("vFeed").onclick = function () {
    if (screen === "shelf") { shelfView = "list"; remember("shelfview", "list"); paintSearchHint(); paintStage(); }
    else setView("feed");
  };
  $("fileIn").onchange = function () { addPhotos(this.files); this.value = ""; };
  $("videoIn").onchange = function () { importMedia(this.files, "video"); this.value = ""; };
  $("audioIn").onchange = function () { importMedia(this.files, "audio"); this.value = ""; };
  $("docIn").onchange   = function () { importDocs(this.files); this.value = ""; };
  $("skinIn").onchange = function () { saveSkin(this.files && this.files[0]); this.value = ""; };

  /* 音声・動画の長さを読む。読めなければ0を返す */
  function mediaDuration(blob, isVideo) {
    return new Promise(function (res) {
      var url, el;
      try { url = URL.createObjectURL(blob); } catch (e) { res(0); return; }
      el = document.createElement(isVideo ? "video" : "audio");
      var done = function (ms) {
        try { URL.revokeObjectURL(url); } catch (e) {}
        el.src = "";
        res(ms);
      };
      var timer = setTimeout(function () { done(0); }, 6000);
      el.preload = "metadata";
      el.onloadedmetadata = function () {
        clearTimeout(timer);
        var d = el.duration;
        done(isFinite(d) && d > 0 ? Math.round(d * 1000) : 0);
      };
      el.onerror = function () { clearTimeout(timer); done(0); };
      el.src = url;
    });
  }

  /* PDF・文書・表・スライドなどを、そのままの形で持つ。中身は開かない */
  function importDocs(files) {
    if (!curEx) { toast("先に" + LL() + "をつくってください。", true); newExDialog(); return; }
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var exAt = curEx;
    var tAt = (curTag !== "all" && curTag !== "none") ? [curTag] : [];
    var total = list.reduce(function (a, f) { return a + (f.size || 0); }, 0);

    var done = 0, failed = 0, lastErr = "", added = [];
    progress(3);
    toast(list.length + " 件を取り込んでいます…（" + mb(total) + "）");
    var chain = Promise.resolve();
    list.forEach(function (f, n) {
      chain = chain.then(function () {
        var bid = uid();
        var rec = {
          id: uid(), exId: exAt, kind: "file",
          blobId: bid, thumbId: null,
          mime: f.type || "application/octet-stream",
          memo: "", tags: tAt.slice(), fav: false,
          bytes: f.size || 0, name: f.name || "",
          createdAt: Date.now() + n
        };
        return DB.putMany([
          ["blobs", { id: bid, blob: f }],
          ["items", rec]
        ]).then(function () {
          if (exAt === curEx) items.push(rec);
          if (browseAll) browseAll.push(rec);
          added.push(rec.id);
          done++;
        }, function (e) { failed++; lastErr = why(e); });
      }).then(function () {
        progress(3 + Math.round(((done + failed) / list.length) * 94));
      });
    });
    chain.then(function () {
      progress(100);
      if (exAt === curEx) { items.sort(function (x, y) { return (x.createdAt || 0) - (y.createdAt || 0); }); paint(); }
      gauge();
      if (failed && !done) toast(failed + " 件とも失敗：" + lastErr, true);
      else if (failed) toast(done + " 件を取り込み（" + failed + " 件失敗：" + lastErr + "）", true);
      else { toast(done + " 件を取り込みました（" + mb(total) + "）"); tagPrompt(added); }
    });
  }

  /* 端末にある音声・動画をそのまま取り込む。変換はしない */
  function importMedia(files, kind) {
    if (!curEx) { toast("先に" + LL() + "をつくってください。", true); newExDialog(); return; }
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var exAt = curEx;
    var tAt = (curTag !== "all" && curTag !== "none") ? [curTag] : [];
    var isVideo = kind === "video";
    var total = list.reduce(function (a, f) { return a + (f.size || 0); }, 0);

    var go = function () {
      var done = 0, failed = 0, lastErr = "", added = [];
      progress(3);
      toast(list.length + " 件を取り込んでいます…（" + mb(total) + "）");
      var chain = Promise.resolve();
      list.forEach(function (f, n) {
        chain = chain.then(function () {
          return mediaDuration(f, isVideo).then(function (dur) {
            var bid = uid();
            var rec = {
              id: uid(), exId: exAt, kind: kind,
              blobId: bid, thumbId: isVideo ? bid : null,
              mime: f.type || (isVideo ? "video/mp4" : "audio/mp4"),
              memo: "", tags: tAt.slice(), fav: false,
              durMs: dur, bytes: f.size || 0,
              name: f.name || "",
              createdAt: Date.now() + n
            };
            return DB.putMany([
              ["blobs", { id: bid, blob: f }],
              ["items", rec]
            ]).then(function () {
              if (exAt === curEx) items.push(rec);
              if (browseAll) browseAll.push(rec);
              added.push(rec.id);
            });
          }).then(function () { done++; }, function (e) {
            failed++; lastErr = why(e);
          }).then(function () {
            progress(3 + Math.round(((done + failed) / list.length) * 94));
          });
        });
      });
      chain.then(function () {
        progress(100);
        items.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        paint(); gauge();
        if (failed && !done) toast(failed + " 件とも失敗：" + lastErr, true);
        else if (failed) toast(done + " 件を取り込み（" + failed + " 件失敗：" + lastErr + "）", true);
        else { toast(done + " 件を取り込みました（" + mb(total) + "）"); tagPrompt(added); }
      });
    };

    if (total > 200 * 1024 * 1024) {
      askYesNo({
        title: "大きめのファイルです",
        body: "合計 " + mb(total) + " あります。端末の空き容量をそのぶん使います。取り込みますか。",
        ok: "取り込む", safe: true
      }, go);
    } else {
      go();
    }
  }

  /* ＋を押したときに出る選択肢 */
  function addMenu() {
    if (!curEx) { toast("先に" + LL() + "をつくってください。", true); newExDialog(); return; }
    var groups = [
      { g: "その場で撮る・録る", rows: [
        { k: "shoot", t: "写真を撮る", d: "アプリの中で撮影。カメラロールには残りません", i: "i-cam" },
        { k: "audio", t: "録音する",   d: "相手の説明をその場で（最長30分）",             i: "i-mic" },
        { k: "video", t: "録画する",   d: "動きをその場で（最長5分）",                    i: "i-vid" }
      ]},
      { g: onDesktop() ? "パソコンから取り込む（引っぱって落としてもOK）" : "端末から取り込む", rows: [
        { k: "pick",   t: "写真", d: onDesktop() ? "パソコンの中から。まとめて何枚でも" : "カメラロールから。まとめて何枚でも", i: "i-plus" },
        { k: "impVid", t: "動画", d: "撮りためた動画をそのまま。変換しません",       i: "i-vid" },
        { k: "impAud", t: "音声", d: "ボイスメモや録音ファイルをそのまま",           i: "i-mic" },
        { k: "impDoc", t: "書類", d: "PDF・文書・表・スライドなど。そのままの形で",   i: "i-doc" }
      ]},
      { g: "そのほか", rows: [
        { k: "text", t: "メモ", d: "写真なしで、文字だけ書き留める",              i: "i-note" },
        { k: "note", t: "新しいフォルダ", d: "いまのフォルダとは別に、新しく作ります", i: "i-book" }
      ]}
    ];
    sheet('<div class="panel-head"><h3>追加する</h3>'
      + '<button class="iconbtn" id="adClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div>'
      + '<div class="panel-body"><div class="stack">'
      + groups.map(function (gr) {
          return '<div class="stacklabel">' + esc(gr.g) + "</div>"
            + gr.rows.map(function (r) {
                return '<button class="rowbtn" data-add="' + r.k + '"><div><b>' + esc(r.t) + "</b>"
                  + "<span>" + esc(r.d) + "</span></div>"
                  + '<svg><use href="#' + r.i + '"/></svg></button>';
              }).join("");
        }).join("")
      + "</div></div>", "dialog");
    $("adClose").onclick = closeSheet;
    Array.prototype.forEach.call(document.querySelectorAll("[data-add]"), function (b) {
      b.onclick = function () {
        var k = b.getAttribute("data-add");
        closeSheet();
        if (k === "shoot") camera();
        else if (k === "pick") $("fileIn").click();
        else if (k === "impVid") $("videoIn").click();
        else if (k === "impAud") $("audioIn").click();
        else if (k === "impDoc") $("docIn").click();
        else if (k === "text") addTextMemo();
        else if (k === "note") newExDialog();
        else record(k);
      };
    });
  }


  /* ============================================================
     パソコンから放り込む
     ------------------------------------------------------------
     スマホは「追加」から選ぶが、パソコンでは Finder や
     エクスプローラから直接引っぱってくるほうが速い。
     落としたものは中身を見て、写真・動画・音声・書類に振り分ける。
     ============================================================ */
  /* 指ではなくマウスやトラックパッドで操る端末か。
     文言と、引っぱって落とす案内の出し分けに使う */
  function onDesktop() {
    try { return window.matchMedia("(hover: hover) and (pointer: fine)").matches; }
    catch (e) { return false; }
  }

  function isFileDrag(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    if (!t) return false;
    for (var i = 0; i < t.length; i++) if (t[i] === "Files") return true;
    return false;
  }

  /* 落ちてきたものを読む。フォルダごと落とされたら中まで辿り、
     その名前をフォルダ名の下書きに使う。
     entry は drop の瞬間にしか取れないので、その場で控える */
  function readDrop(dt) {
    var flat = Array.prototype.slice.call(dt.files || []);
    var items = dt.items;
    var entries = [];
    if (items && items.length && typeof items[0].webkitGetAsEntry === "function") {
      for (var i = 0; i < items.length; i++) {
        var e = items[i].webkitGetAsEntry();
        if (e) entries.push(e);
      }
    }
    if (!entries.length) return Promise.resolve({ files: flat, name: "" });
    var name = (entries.length === 1 && entries[0].isDirectory) ? entries[0].name : "";
    var hasDir = entries.some(function (e) { return e.isDirectory; });
    /* フォルダが混ざっているときだけ中まで辿る。
       そうでなければ dataTransfer.files のほうが確実で、
       entry が1つでも読めないと取りこぼす */
    if (!hasDir) return Promise.resolve({ files: flat, name: "" });
    return walkEntries(entries).then(function (files) {
      return { files: files.length ? files : flat, name: name };
    }).catch(function () { return { files: flat, name: name }; });
  }

  function walkEntries(entries) {
    return Promise.all(entries.map(function (e) {
      if (e.isFile) {
        return new Promise(function (ok) { e.file(function (f) { ok([f]); }, function () { ok([]); }); });
      }
      if (!e.isDirectory) return Promise.resolve([]);
      var rd = e.createReader(), all = [];
      /* readEntries は一度に100件までしか返さない。空が返るまで繰り返す */
      function more() {
        return new Promise(function (ok) {
          rd.readEntries(function (batch) {
            if (!batch.length) return ok(null);
            all = all.concat(batch);
            ok(true);
          }, function () { ok(null); });
        }).then(function (again) { return again ? more() : walkEntries(all); });
      }
      return more();
    })).then(function (lists) {
      return lists.reduce(function (a, b) { return a.concat(b); }, []);
    });
  }

  /* 種類ごとに分けて、それぞれの取り込みに渡す */
  function takeDropped(files, folderName) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    if (!curEx) {
      /* フォルダが無いなら、落としたものを抱えたまま新規作成を開く。
         作り終えたらそのまま取り込む。落とし直させない */
      toast("入れる" + LL() + "を決めてください");
      newExDialog(null, { name: folderName || "", then: function () { takeDropped(list); } });
      return;
    }
    var pics = [], vids = [], auds = [], docs = [];
    list.forEach(function (f) {
      var m = (f.type || "").toLowerCase();
      var ex = (f.name || "").split(".").pop().toLowerCase();
      if (m.indexOf("image/") === 0 || ["jpg","jpeg","png","gif","webp","heic","heif","avif"].indexOf(ex) >= 0) pics.push(f);
      else if (m.indexOf("video/") === 0 || ["mp4","mov","m4v","webm"].indexOf(ex) >= 0) vids.push(f);
      else if (m.indexOf("audio/") === 0 || ["m4a","mp3","wav","aac","aiff"].indexOf(ex) >= 0) auds.push(f);
      else docs.push(f);
    });
    if (pics.length) addPhotos(pics);
    if (vids.length) importMedia(vids, "video");
    if (auds.length) importMedia(auds, "audio");
    if (docs.length) importDocs(docs);
  }

  function wireDrop() {
    var veil = null, deep = 0;

    function show() {
      if (veil) return;
      veil = document.createElement("div");
      veil.className = "dropveil";
      veil.innerHTML = '<div class="dropbox"><b>ここに落とす</b>'
        + "<span>写真・動画・音声・書類。種類はこちらで見分けます</span></div>";
      document.body.appendChild(veil);
    }
    function hide() {
      deep = 0;
      if (veil) { try { veil.remove(); } catch (e) {} veil = null; }
    }

    /* 子要素をまたぐたびに enter と leave が交互に出るので、
       深さを数えて、本当に外へ出たときだけ消す */
    window.addEventListener("dragenter", function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault(); deep++; show();
    });
    window.addEventListener("dragover", function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "copy"; } catch (x) {}
    });
    window.addEventListener("dragleave", function (e) {
      if (!isFileDrag(e)) return;
      deep--; if (deep <= 0) hide();
    });
    window.addEventListener("drop", function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault(); hide();
      readDrop(e.dataTransfer).then(function (r) { takeDropped(r.files, r.name); });
    });
  }

  /* ============================================================
     シートとダイアログ
     ============================================================ */
  /* 入力欄の自動入力を切る。切らないと Mac の Safari が
     住所や氏名を埋めようとして、キーチェーンのパスワードを聞いてくる。
     フォルダ名や場所はそういう類のものではないので、出すだけ邪魔になる */
  function noAutofill(root) {
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll("input, textarea"), function (e) {
      var t = (e.type || "").toLowerCase();
      if (["file", "checkbox", "radio", "range", "color"].indexOf(t) >= 0) return;
      e.setAttribute("autocomplete", "off");
      e.setAttribute("autocorrect", "off");
      e.setAttribute("data-form-type", "other");
    });
  }

  function sheet(html, cls) {
    $("panel").innerHTML = html;
    noAutofill($("panel"));
    $("scrim").className = "scrim on" + (cls ? " " + cls : "");
    document.body.style.overflow = "hidden";
  }
  /* 入力欄に触れたままシートを消すと、キーボードが引っ込むときに
     画面が半端な位置で止まることがある。先に指を離させてから閉じる */
  function dropFocus() {
    var a = document.activeElement;
    if (a && a !== document.body && a.blur) { try { a.blur(); } catch (e) {} }
  }
  function closeSheet() {
    dropFocus();
    $("scrim").className = "scrim";
    $("panel").innerHTML = "";
    document.body.style.overflow = "";
  }
  $("scrim").onclick = function (e) { if (e.target === this) closeSheet(); };

  function miniClose() { dropFocus(); $("mini").className = "mini"; $("minibox").innerHTML = ""; }
  $("mini").onclick = function (e) { if (e.target === this) miniClose(); };

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    /* 画面いっぱいで見ている間は、そちらが先に閉じる。
       ここで下の画面まで閉じると、戻る場所が無くなる */
    if (document.querySelector(".lens")) return;
    if ($("mini").className.indexOf("on") >= 0) { miniClose(); return; }
    if ($("scrim").className.indexOf("on") >= 0) { closeSheet(); return; }
    if (picking) pickOff();
  });

  function askText(o, done) {
    $("minibox").innerHTML = "<h4>" + esc(o.title) + "</h4>"
      + (o.body ? "<p>" + esc(o.body) + "</p>" : "")
      + '<input class="inp" id="miTxt" value="' + esc(o.value || "") + '" placeholder="' + esc(o.placeholder || "") + '">'
      + '<div class="minibtns"><button class="ghost" id="miNo">やめる</button>'
      + '<button class="cta" id="miYes">' + esc(o.ok || "決定") + "</button></div>";
    noAutofill($("minibox"));
    $("mini").className = "mini on";
    var go = function () {
      var v = $("miTxt").value.trim();
      if (!v) { $("miTxt").focus(); return; }
      miniClose(); done(v);
    };
    $("miYes").onclick = go;
    $("miNo").onclick = miniClose;
    $("miTxt").onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); go(); } };
    setTimeout(function () { var t = $("miTxt"); if (t) t.focus(); }, 50);
  }

  function askYesNo(o, done) {
    $("minibox").innerHTML = "<h4>" + esc(o.title) + "</h4>"
      + "<p>" + esc(o.body || "") + "</p>"
      + '<div class="minibtns"><button class="ghost" id="miNo">やめる</button>'
      + '<button class="cta" id="miYes" style="background:' + (o.safe ? "var(--ink)" : "var(--rec)") + ';color:#fff">'
      + esc(o.ok || "削除する") + "</button></div>";
    noAutofill($("minibox"));
    $("mini").className = "mini on";
    $("miYes").onclick = function () { miniClose(); done(); };
    $("miNo").onclick = function () { miniClose(); if (o.cancel) o.cancel(); };
  }

  /* ============================================================
     展示会
     ============================================================ */
  /* opt: { name: 名前の下書き, then: 作り終えたあとにやること } */
  function newExDialog(ex, opt) {
    opt = opt || {};
    var e = ex || { name: opt.name || "", date: today(), venue: "", note: "", cat: "" };
    var tpl = tplChips(e.tpl || "");

    /* 上に「やめて戻る」と「これでつくる」を並べる。下まで送らなくても決められる */
    var okJa = ex ? "保存する" : "つくる";
    sheet('<div class="panel-head"><h3>' + (ex ? "この" + esc(LL(e)) + "の設定" : "新しく作る") + "</h3>"
      + '<div style="display:flex;gap:8px">'
      + '<button class="iconbtn" id="dxClose" aria-label="やめて戻る" title="やめて戻る"><svg><use href="#i-back"/></svg></button>'
      + '<button class="iconbtn ok" id="exSave" aria-label="' + okJa + '" title="' + okJa + '"><svg><use href="#i-check"/></svg></button>'
      + '</div></div>'
      + '<div class="panel-body">'
      + '<div class="field"><div class="label">テンプレート</div>'
      + '<div class="chipset" id="tplRow">' + tpl + "</div>"
      + '<div class="hintline">名前とフォーマットが最初から入ります。長押しすると並べ替え・削除ができます</div></div>'
      + '<div class="field"><label class="label" for="exName">フォルダの名前</label>'
      + '<input class="inp" id="exName" value="' + esc(e.name) + '" placeholder="">'
      + '<div class="warnline" id="exDup" hidden></div></div>'
      + '<div class="field"><label class="label" for="exCatIn">カテゴリ</label>'
      + '<input class="inp" id="exCatIn" value="' + esc(e.cat || "") + '" placeholder="" list="catList" autocomplete="off">'
      + '<datalist id="catList">' + catOpts() + "</datalist>"
      + '<div class="chipset" id="catPast"></div>'
      + '<div class="hintline">フォルダを絞り込むための名前です</div></div>'
      + '<div class="field"><label class="label" for="exDate">日付</label>'
      + '<input class="inp" id="exDate" type="date" value="' + esc(e.date || "") + '"></div>'
      + '<div class="field"><label class="label" for="exVenue">場所</label>'
      + '<input class="inp" id="exVenue" value="' + esc(e.venue || "") + '" placeholder=""></div>'
      + '<div class="field"><label class="label" for="exForm">フォーマット</label>'
      + '<textarea class="ta" id="exForm" style="min-height:84px" placeholder="">'
      + esc(e.form || e.hint || "") + "</textarea>"
      + '<div class="hintline">1件ごとのメモがこの形で始まります。ここを直すとこのフォルダだけ変わります</div></div>'
      + '<div class="field"><label class="label" for="exNote">ひとことメモ</label>'
      + '<textarea class="ta" id="exNote" placeholder="">' + esc(e.note || "") + "</textarea>"
      + '<div class="hintline">フォルダ全体についての覚え書きです</div></div>'
      + "</div>"
      + (ex ? '<div class="panel-foot"><button class="danger" id="exDel">この' + esc(LL(e)) + 'を削除</button></div>' : ""), "dialog");

    $("dxClose").onclick = closeSheet;
    var ff = $("exForm");
    if (ff) ff.oninput = function () { this.dataset.touched = "1"; };
    var nn = $("exName");
    if (nn) {
      if (ex) nn.dataset.touched = "1";      /* 既存の設定を開いたときは上書きしない */
      nn.oninput = function () { this.dataset.touched = "1"; checkDup(); };
    }

    var pick = { k: e.tpl || "", form: e.form || e.hint || "", name: "" };
    function showTpl() {
      var nm = $("exName");
      if (nm && !nm.dataset.touched && pick.name) nm.value = fillPattern(pick.name);
      var f = $("exForm");
      if (f && !f.dataset.touched) f.value = pick.form || "";
    }
    /* 前に使ったカテゴリを、押すだけで入れられるように並べる */
    function showCats() {
      var box = $("catPast"); if (!box) return;
      var list = allCats();
      if (!list.length) { box.innerHTML = ""; return; }
      box.innerHTML = list.map(function (c) {
        return '<button class="tag" data-cat="' + esc(c) + '">' + esc(c) + "</button>";
      }).join("");
      Array.prototype.forEach.call(box.querySelectorAll("[data-cat]"), function (b) {
        b.onclick = function () {
          var inp = $("exCatIn");
          if (inp) { inp.value = b.getAttribute("data-cat"); inp.focus(); }
        };
      });
    }
    /* 同じ名前があることを、保存を押す前に知らせる */
    function checkDup() {
      var box = $("exDup"); if (!box) return;
      var v = $("exName").value.trim();
      if (!v || !nameTaken(v, ex ? ex.id : null)) { box.hidden = true; box.innerHTML = ""; return; }
      var alt = freeName(v);
      box.hidden = false;
      box.innerHTML = "<span>同じ名前のフォルダがあります</span>"
        + '<button type="button" id="exDupFix">「' + esc(alt) + '」にする</button>';
      $("exDupFix").onclick = function () {
        var n = $("exName");
        n.value = alt; n.dataset.touched = "1";
        checkDup();
      };
    }

    showTpl(); showCats(); checkDup();
    function redraw() {
      var row = $("tplRow");
      row.innerHTML = tplChips(pick.k);
      row.classList.toggle("editing", tplEditMode);
      wireTpl();
    }
    function wireTpl() { wireTplRow($("tplRow"), onPick, redraw); }
    function onPick(t) {
      pick = { k: t.k, form: t.form || "", name: t.name || "" };
      Array.prototype.forEach.call($("tplRow").querySelectorAll("[data-tid]"), function (x) {
        x.setAttribute("aria-pressed", String(x.getAttribute("data-tid") === t.id));
      });
      showTpl(); checkDup();
    }
    wireTpl();

    $("exSave").onclick = function () {
      var name = $("exName").value.trim();
      if (!name) { toast("名前を入れてください。", true); $("exName").focus(); return; }
      if (nameTaken(name, ex ? ex.id : null)) {
        toast("「" + name + "」はもうあります。別の名前にしてください。", true);
        $("exName").focus(); $("exName").select();
        return;
      }
      var rec = {
        id: ex ? ex.id : uid(),
        name: name, date: $("exDate").value || today(),
        venue: $("exVenue").value.trim(), note: $("exNote").value.trim(),
        cat: $("exCatIn") ? $("exCatIn").value.trim() : (ex ? ex.cat : ""),
        tpl: pick.k, form: $("exForm") ? $("exForm").value : pick.form,
        createdAt: ex ? (ex.createdAt || Date.now()) : Date.now()
      };
      DB.put("exhibitions", rec).then(function () {
        if (ex) {
          for (var i = 0; i < exs.length; i++) if (exs[i].id === rec.id) exs[i] = rec;
        } else {
          exs.unshift(rec);
        }
        exs.sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
        closeSheet();
        /* 作ったらそのまま中に入る。中身を入れ始められるように */
        return ex ? loadItems().then(paint) : openFolder(rec.id);
      }).then(function () {
        toast(ex ? "保存しました" : "つくりました");
        /* 落としたものを抱えて来ているなら、ここで取り込む */
        if (!ex && typeof opt.then === "function") opt.then(rec);
      }).catch(function (er) { toast(why(er), true); });
    };

    var del = $("exDel");
    if (del) del.onclick = function () {
      askYesNo({
        title: "「" + e.name + "」を削除",
        body: "この" + LL(e) + "と、その中の写真・録音・メモをすべて消します。取り消せません。",
        ok: "すべて削除する"
      }, function () {
        var kill = [];
        items.forEach(function (it) {
          kill.push(["items", it.id]);
          if (it.blobId) kill.push(["blobs", it.blobId]);
          if (it.thumbId) kill.push(["blobs", it.thumbId]);
        });
        kill.push(["exhibitions", e.id]);
        DB.delMany(kill).then(function () {
          exs = exs.filter(function (x) { return x.id !== e.id; });
          curEx = null; remember("ex", "");
          closeSheet();
          return goShelf();
        }).then(function () {
          toast("削除しました");
        }).catch(function (er) { toast(why(er), true); });
      });
    };
    setTimeout(function () { var n = $("exName"); if (n) n.focus(); }, 60);
  }

  /* 同じ名前のフォルダは作らせない。あとで見分けがつかなくなるため */
  function nameTaken(name, exceptId) {
    var k = String(name || "").trim().toLowerCase();
    for (var i = 0; i < exs.length; i++) {
      if (exs[i].id === exceptId) continue;
      if (String(exs[i].name || "").trim().toLowerCase() === k) return true;
    }
    return false;
  }
  /* テンプレートが入れる名前が重なっていたら、うしろに数字を足す */
  function freeName(base) {
    if (!base || !nameTaken(base, null)) return base;
    for (var n = 2; n < 200; n++) {
      var t = base + "_" + n;
      if (!nameTaken(t, null)) return t;
    }
    return base;
  }

  /* テンプレートのチップを組み立てる */
  var tplEditMode = false;   /* 長押しで入る、並べ替え・削除のモード */

  function tplChips(curK) {
    var h = allTemplates().map(function (t, i) {
      return '<button class="tag tpl" data-tpl="' + i + '" data-tid="' + esc(t.id) + '" aria-pressed="' + (curK === t.k) + '">'
        + '<span class="tplk">' + esc(t.k) + "</span>"
        + '<span class="tplx" data-kill="' + esc(t.id) + '" aria-hidden="true">×</span></button>';
    }).join("");

    if (tplEditMode) {
      TEMPLATES.concat(userTpl).forEach(function (t) {
        if (tplHidden.indexOf(t.id) < 0) return;
        h += '<button class="tag gone" data-back="' + esc(t.id) + '">' + esc(t.k) + " を戻す</button>";
      });
      h += '<button class="tag done" id="tplDone">完了</button>';
    } else {
      h += '<button class="tag add" id="tplNew">＋ 自分で作る</button>';
    }
    return h;
  }

  /* iPhoneのホーム画面と同じ手つき。長押しでゆれはじめ、そのまま動かせる */
  function wireTplRow(row, onPick, redraw) {
    if (!row) return;
    /* 描き直すたびに中身は入れ替わるので、行そのものへの登録は一度だけ */
    row._pick = onPick;
    row._redraw = redraw;

    wireTplButtons(row);
    if (row._wired) return;
    row._wired = true;

    var timer = null, drag = null, x0 = 0, y0 = 0, moved = false, justEntered = false;
    /* 動かしている間は対象が行そのものに移るので、押したものを覚えておく */
    var pressedId = "";

    function stopTimer() { if (timer) { clearTimeout(timer); timer = null; } }
    function again() { if (row._redraw) row._redraw(); }

    function enterEdit() {
      if (tplEditMode) return;
      tplEditMode = true;
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
      again();
    }

    /* いまの並びをそのまま覚える */
    function commit() {
      var ids = Array.prototype.map.call(row.querySelectorAll("[data-tid]"), function (n) {
        return n.getAttribute("data-tid");
      });
      if (!ids.length) return Promise.resolve();
      tplOrder = ids;
      return saveTplPref();
    }

    function beginDrag(chip, ev) {
      drag = chip;
      chip.classList.add("dragging");
      chip.style.pointerEvents = "none";
      try { row.setPointerCapture(ev.pointerId); } catch (e) {}
    }
    function endDrag() {
      if (!drag) return;
      drag.classList.remove("dragging");
      drag.style.pointerEvents = "";
      drag = null;
      commit();
    }

    row.addEventListener("pointerdown", function (ev) {
      var chip = ev.target.closest("[data-tid]");
      if (!chip) return;
      if (ev.target.closest("[data-kill]")) return;
      moved = false; justEntered = false;
      pressedId = chip.getAttribute("data-tid");
      x0 = ev.clientX; y0 = ev.clientY;
      if (tplEditMode) { beginDrag(chip, ev); return; }
      stopTimer();
      var id = chip.getAttribute("data-tid"), pid = ev.pointerId;
      timer = setTimeout(function () {
        timer = null;
        justEntered = true;
        enterEdit();
        var back = row.querySelector('[data-tid="' + id + '"]');
        if (back) beginDrag(back, { pointerId: pid });
      }, 430);
    });

    row.addEventListener("pointermove", function (ev) {
      if (Math.abs(ev.clientX - x0) > 8 || Math.abs(ev.clientY - y0) > 8) {
        moved = true;
        stopTimer();
      }
      if (!drag) return;
      ev.preventDefault();
      var over = document.elementFromPoint(ev.clientX, ev.clientY);
      var target = over && over.closest ? over.closest("[data-tid]") : null;
      if (!target || target === drag || target.parentNode !== row) return;
      var after = target.compareDocumentPosition(drag) & Node.DOCUMENT_POSITION_FOLLOWING;
      row.insertBefore(drag, after ? target : target.nextSibling);
    });

    row.addEventListener("pointerup", function (ev) {
      stopTimer();
      if (drag) endDrag();
      if (moved || justEntered) { justEntered = false; return; }
      if (!pressedId) return;
      var t = tplById(pressedId);
      pressedId = "";
      if (!t) return;
      /* ゆれているあいだは中身を直す。そうでなければ選ぶ */
      if (tplEditMode) templateDialog(again, t);
      else if (row._pick) row._pick(t);
    });

    row.addEventListener("pointercancel", function () { stopTimer(); endDrag(); });
  }

  /* 行の中のボタン。描き直すたびに付け直す */
  function wireTplButtons(row) {
    function again() { if (row._redraw) row._redraw(); }

    Array.prototype.forEach.call(row.querySelectorAll("[data-kill]"), function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var id = b.getAttribute("data-kill");
        var t = tplById(id);
        if (!t) return;
        /* 最初から入っているものは隠すだけなので戻せる */
        if (isBuiltIn(t)) {
          if (tplHidden.indexOf(id) < 0) tplHidden.push(id);
          saveTplPref().then(again);
        } else {
          DB.del("templates", id).then(function () {
            userTpl = userTpl.filter(function (x) { return x.id !== id; });
            tplOrder = tplOrder.filter(function (x) { return x !== id; });
            return saveTplPref();
          }).then(again).catch(function (e) { toast(why(e), true); });
        }
      };
    });

    Array.prototype.forEach.call(row.querySelectorAll("[data-back]"), function (b) {
      b.onclick = function () {
        var id = b.getAttribute("data-back");
        tplHidden = tplHidden.filter(function (x) { return x !== id; });
        saveTplPref().then(again);
      };
    });

    var dn = row.querySelector("#tplDone");
    if (dn) dn.onclick = function () { tplEditMode = false; again(); };

    var mk = row.querySelector("#tplNew");
    if (mk) mk.onclick = function () {
      templateDialog(function (rec) {
        if (rec && row._pick) row._pick(rec);
        again();
      });
    };
  }

  /* カテゴリの候補（入力欄の下に出る） */
  function catOpts() {
    return allCats().map(function (c) { return '<option value="' + esc(c) + '">'; }).join("");
  }

  /* テンプレートを自分で作る／消す */
  /* base を渡すと、その中身から始める（直すとき・最初から入っているものを写すとき） */
  function templateDialog(done, base) {
    var editing = base && !isBuiltIn(base) ? base : null;

    $("minibox").innerHTML = "<h4>" + (editing ? "テンプレートを直す" : "テンプレートを作る") + "</h4>"
      + "<p>フォルダを作るときに、名前とフォーマットが入った状態で始まります。"
      + (base && isBuiltIn(base) ? "最初から入っているものは直せないので、写して作ります。" : "") + "</p>"

      + '<div class="field"><label class="label" for="tpK">テンプレート名</label>'
      + '<input class="inp" id="tpK" value="' + esc(base ? base.k : "") + '" placeholder=""></div>'

      + '<div class="field"><label class="label" for="tpN">フォルダ名の初期値</label>'
      + '<input class="inp" id="tpN" value="' + esc(base ? (base.name || "") : "") + '" placeholder="">'
      + '<div class="hintline">名前の欄に最初から入る文字です。<code>「日付」</code> と書くと、作った日の日付に変わります</div></div>'

      + '<div class="field"><label class="label" for="tpH">フォーマット</label>'
      + '<textarea class="ta" id="tpH" style="min-height:76px" placeholder="">'
      + esc(base ? (base.form || "") : "") + "</textarea>"
      + '<div class="hintline">1件ごとのメモがこの形で始まります。改行して項目を並べてください</div></div>'

      + '<div class="field"><div class="label">こうなります</div>'
      + '<div class="tplpv" id="tpPv"></div></div>'

      + '<div class="minibtns"><button class="ghost" id="tpNo">やめる</button>'
      + '<button class="cta" id="tpYes">' + (editing ? "保存する" : "登録する") + "</button></div>";
    noAutofill($("minibox"));
    $("mini").className = "mini on";

    function preview() {
      var n = $("tpN").value.trim(), F = $("tpH").value;
      $("tpPv").innerHTML = '<div class="pvrow"><span>名前</span><b>'
        + (n ? esc(fillPattern(n)) : '<i class="pvnone">空のまま</i>') + "</b></div>"
        + '<div class="pvrow"><span>メモ</span><b>'
        + (F.trim() ? '<span class="pvform">' + esc(F) + "</span>" : '<i class="pvnone">空のまま</i>') + "</b></div>";
    }
    preview();
    ["tpN", "tpH"].forEach(function (id) { $(id).oninput = preview; });

    $("tpNo").onclick = miniClose;
    $("tpYes").onclick = function () {
      var k = $("tpK").value.trim();
      if (!k) { toast("テンプレート名を入れてください。", true); $("tpK").focus(); return; }
      var rec = {
        id: editing ? editing.id : uid(), k: k,
        name: $("tpN").value.trim(),
        form: $("tpH").value.replace(/\s+$/, ""),
        createdAt: editing ? (editing.createdAt || Date.now()) : Date.now()
      };
      DB.put("templates", rec).then(function () {
        if (editing) {
          for (var i = 0; i < userTpl.length; i++) if (userTpl[i].id === rec.id) userTpl[i] = rec;
        } else {
          userTpl.push(rec);
          /* 写したもとは隠して、同じ場所に置く */
          if (base && isBuiltIn(base)) {
            var seat = tplOrder.indexOf(base.id);
            if (seat < 0) {
              tplOrder = allTemplates().map(function (t) { return t.id; });
              seat = tplOrder.indexOf(base.id);
            }
            if (seat >= 0) tplOrder.splice(seat, 1, rec.id); else tplOrder.push(rec.id);
            if (tplHidden.indexOf(base.id) < 0) tplHidden.push(base.id);
            return saveTplPref().then(function () { return rec; });
          }
        }
        return rec;
      }).then(function () {
        miniClose();
        toast("「" + k + "」を" + (editing ? "保存しました" : "登録しました"));
        if (done) done(rec);
      }).catch(function (e) { toast(why(e), true); });
    };
    setTimeout(function () { var t = $("tpK"); if (t) t.focus(); }, 60);
  }

  /* ============================================================
     タグの一覧と整理
     ============================================================ */
  var TAGMAX = 12;

  /* いまの画面で使えるタグと、その件数 */
  function tagCounts(scope) {
    var src, c = {};
    if (scope === "folder") src = items;
    else src = (browseAll || []).filter(function (it) {
      var e = exById(it.exId);
      if (!e) return false;
      var cat = (e.cat || "").trim();
      if (curCat === "none") return !cat;
      if (curCat === "all") return true;
      return cat === curCat;
    });
    src.forEach(function (it) {
      (it.tags || []).forEach(function (t) { c[t] = (c[t] || 0) + 1; });
    });
    return c;
  }

  /* タグが増えてきたとき用。探す・付け替える・消す */
  function tagSheet(scope) {
    var c = tagCounts(scope);
    var q = "", byCount = true;

    sheet('<div class="browse-head">'
      + '<div style="display:flex;gap:8px;align-items:center">'
      + '<div class="seekfield" style="flex:1"><svg><use href="#i-search"/></svg>'
      + '<input id="tqIn" type="search" placeholder="タグを探す" autocomplete="off"></div>'
      + '<button class="iconbtn" id="tqClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button>'
      + "</div>"
      + '<div class="hashrow"><button class="hash" id="tqOrder" aria-pressed="true">多い順</button>'
      + '<span class="hashlabel" id="tqCount"></span></div>'
      + "</div>"
      + '<div class="browse-body" id="tqBody"></div>', "browse");

    $("tqClose").onclick = closeSheet;
    $("tqIn").oninput = function () { q = this.value.trim().toLowerCase(); render(); };
    $("tqOrder").onclick = function () {
      byCount = !byCount;
      this.textContent = byCount ? "多い順" : "名前順";
      this.setAttribute("aria-pressed", String(byCount));
      render();
    };

    function render() {
      var keys = Object.keys(c).filter(function (t) {
        return !q || t.toLowerCase().indexOf(q) >= 0;
      });
      keys.sort(byCount
        ? function (a, b) { return c[b] - c[a] || a.localeCompare(b, "ja"); }
        : function (a, b) { return a.localeCompare(b, "ja"); });

      $("tqCount").textContent = keys.length + " / " + Object.keys(c).length + " 件";

      if (!keys.length) {
        $("tqBody").innerHTML = '<div class="bnone">'
          + (Object.keys(c).length ? "見つかりませんでした" : "まだタグがありません") + "</div>";
        return;
      }
      $("tqBody").innerHTML = '<div class="taglist">' + keys.map(function (t) {
        return '<div class="tagrow">'
          + '<button class="tagpick" data-pick="' + esc(t) + '">#' + esc(t)
          + '<span class="n">' + c[t] + "</span></button>"
          + '<button class="tagedit" data-edit="' + esc(t) + '" aria-label="' + esc(t) + 'を付け替える／消す">…</button>'
          + "</div>";
      }).join("") + "</div>";

      Array.prototype.forEach.call($("tqBody").querySelectorAll("[data-pick]"), function (b) {
        b.onclick = function () {
          var t = b.getAttribute("data-pick");
          closeSheet();
          if (scope === "folder") { curTag = t; paintRail(); paintStage(); }
          else { shelfTag = t; paintStage(); }
        };
      });
      Array.prototype.forEach.call($("tqBody").querySelectorAll("[data-edit]"), function (b) {
        b.onclick = function () { editTag(b.getAttribute("data-edit"), scope); };
      });
    }
    render();
    setTimeout(function () { var e = $("tqIn"); if (e) e.focus(); }, 80);
  }

  /* タグの名前を変える／消す。すべてのフォルダにまとめて効く */
  function editTag(t, scope) {
    $("minibox").innerHTML = "<h4>#" + esc(t) + "</h4>"
      + "<p>すべてのフォルダのこのタグが、まとめて変わります。写真そのものは消えません。</p>"
      + '<input class="inp" id="etIn" value="' + esc(t) + '">'
      + '<div class="minibtns"><button class="danger" id="etDel">このタグを消す</button>'
      + '<button class="cta" id="etOk">名前を変える</button></div>';
    noAutofill($("minibox"));
    $("mini").className = "mini on";

    $("etOk").onclick = function () {
      var to = $("etIn").value.trim();
      if (!to || to === t) { miniClose(); return; }
      miniClose();
      applyTag(t, to, scope, "「#" + to + "」にしました");
    };
    $("etDel").onclick = function () {
      miniClose();
      askYesNo({
        title: "#" + t + " を消す",
        body: "すべてのフォルダからこのタグを外します。写真とメモは残ります。",
        ok: "タグを外す"
      }, function () { applyTag(t, "", scope, "「#" + t + "」を外しました"); });
    };
    setTimeout(function () { var e = $("etIn"); if (e) { e.focus(); e.select(); } }, 60);
  }

  function applyTag(from, to, scope, msg) {
    progress(8);
    DB.all("items").then(function (all) {
      var jobs = [];
      all.forEach(function (it) {
        var tg = (it.tags || []).slice();
        var i = tg.indexOf(from);
        if (i < 0) return;
        if (to) { if (tg.indexOf(to) >= 0) tg.splice(i, 1); else tg[i] = to; }
        else tg.splice(i, 1);
        it.tags = tg;
        jobs.push(DB.put("items", it));
      });
      return Promise.all(jobs);
    }).then(function () {
      return DB.all("items");
    }).then(function (all) {
      browseAll = all;
      if (shelfTag === from) shelfTag = to || "";
      if (curTag === from) curTag = to || "all";
      progress(100);
      closeSheet();
      return (screen === "folder" ? loadItems() : Promise.resolve());
    }).then(function () {
      paint();
      toast(msg);
      if (scope) tagSheet(scope);
    }).catch(function (e) { progress(100); toast(why(e), true); });
  }

  /* ============================================================
     カテゴリ（フォルダを入れておく棚）
     ============================================================ */
  function askCat(ex) {
    var e = ex || exById(curEx);
    if (!e) return;
    var list = allCats();
    $("minibox").innerHTML = "<h4>カテゴリを選ぶ</h4>"
      + "<p>フォルダを絞り込むための名前です。</p>"
      + (list.length ? '<div class="chipset" id="ctPast">' + list.map(function (c) {
          return '<button class="tag" data-cat="' + esc(c) + '" aria-pressed="' + (c === (e.cat || "")) + '">' + esc(c) + "</button>";
        }).join("") + "</div>" : "")
      + '<div class="field"><label class="label" for="ctIn">新しく作る／書き換える</label>'
      + '<input class="inp" id="ctIn" value="' + esc(e.cat || "") + '" placeholder="" autocomplete="off"></div>'
      + '<div class="minibtns"><button class="ghost" id="ctNo">やめる</button>'
      + '<button class="cta" id="ctYes">決める</button></div>';
    noAutofill($("minibox"));
    $("mini").className = "mini on";

    var box = $("ctPast");
    if (box) Array.prototype.forEach.call(box.querySelectorAll("[data-cat]"), function (b) {
      b.onclick = function () { $("ctIn").value = b.getAttribute("data-cat"); $("ctIn").focus(); };
    });
    $("ctNo").onclick = miniClose;
    $("ctYes").onclick = function () {
      e.cat = $("ctIn").value.trim();
      DB.put("exhibitions", e).then(function () {
        miniClose(); paintEx();
        toast(e.cat ? "「" + e.cat + "」に入れました" : "カテゴリを外しました");
      }).catch(function (er) { toast(why(er), true); });
    };
    setTimeout(function () { var i = $("ctIn"); if (i) i.focus(); }, 60);
  }

  /* ============================================================
     写真の追加
     ============================================================ */
  /* 画像を読む。createImageBitmap が無い／失敗する端末のために
     <img> 経由の道も用意しておく */
  function decode(src) {
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(src, { imageOrientation: "from-image" })
        .catch(function () { return createImageBitmap(src); })
        .catch(function () { return viaImg(src); });
    }
    return viaImg(src);
  }
  function viaImg(src) {
    return new Promise(function (res, rej) {
      var url;
      try { url = URL.createObjectURL(src); }
      catch (e) { rej(new Error("この画像を読み込めませんでした。")); return; }
      var im = new Image();
      im.onload = function () {
        res({ width: im.naturalWidth, height: im.naturalHeight, el: im, url: url });
      };
      im.onerror = function () {
        try { URL.revokeObjectURL(url); } catch (e) {}
        rej(new Error("この画像の形式に対応していません。HEICのままPCへ送った写真などは、JPEGに変換してからお試しください。"));
      };
      im.src = url;
    });
  }

  function shrink(file, maxEdge, quality) {
    return decode(file).then(function (bmp) {
      var iw = bmp.width, ih = bmp.height;
      if (!iw || !ih) throw new Error("画像の大きさを読み取れませんでした。");
      var scale = Math.min(1, maxEdge / Math.max(iw, ih));
      var w = Math.max(1, Math.round(iw * scale));
      var h = Math.max(1, Math.round(ih * scale));
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      var ctx = c.getContext("2d");
      if (!ctx) throw new Error("この端末では画像を処理できませんでした。");
      ctx.drawImage(bmp.el || bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      if (bmp.url) { try { URL.revokeObjectURL(bmp.url); } catch (e) {} }
      return new Promise(function (res, rej) {
        try {
          c.toBlob(function (b) {
            if (b) res({ blob: b, w: w, h: h });
            else rej(new Error("画像をJPEGに変換できませんでした。"));
          }, "image/jpeg", quality);
        } catch (e) { rej(e); }
      });
    });
  }

  /* ============================================================
     EXIF（撮影時刻と位置）
     ============================================================
     JPEGの先頭にある小さな覚え書きを読むだけ。
     ファイル全体ではなく、頭の128KBしか触らないので速い。
     AIは使っていない。時刻と位置は事実なので、間違えようがない */
  function exifOf(file) {
    return new Promise(function (res) {
      if (!file || !/jpe?g/i.test(file.type || file.name || "")) { res(null); return; }
      var head = file.slice(0, 131072);
      var fr = new FileReader();
      fr.onerror = function () { res(null); };
      fr.onload = function () {
        try { res(readExif(new DataView(fr.result))); }
        catch (e) { res(null); }
      };
      fr.readAsArrayBuffer(head);
    });
  }

  function readExif(v) {
    if (v.byteLength < 8 || v.getUint16(0) !== 0xFFD8) return null;
    var p = 2;
    while (p + 4 < v.byteLength) {
      if (v.getUint8(p) !== 0xFF) break;
      var mark = v.getUint8(p + 1), len = v.getUint16(p + 2);
      if (mark === 0xE1) {
        if (v.getUint32(p + 4) !== 0x45786966) break;   /* "Exif" */
        return readTiff(v, p + 10);
      }
      if (mark === 0xDA) break;                          /* 画像本体に入った */
      p += 2 + len;
    }
    return null;
  }

  function readTiff(v, t) {
    var le = v.getUint16(t) === 0x4949;                  /* バイトの並び */
    var u16 = function (o) { return v.getUint16(o, le); };
    var u32 = function (o) { return v.getUint32(o, le); };
    if (u16(t + 2) !== 42) return null;

    var out = { when: null, lat: null, lon: null };
    var ifd0 = t + u32(t + 4);
    var exifOff = 0, gpsOff = 0;

    function walk(dir, onTag) {
      if (dir + 2 > v.byteLength) return;
      var n = u16(dir);
      for (var i = 0; i < n; i++) {
        var e = dir + 2 + i * 12;
        if (e + 12 > v.byteLength) return;
        onTag(u16(e), u16(e + 2), u32(e + 4), e + 8);
      }
    }
    function str(count, valOff, raw) {
      var off = count > 4 ? t + u32(raw) : raw;
      var sOut = "";
      for (var i = 0; i < count && off + i < v.byteLength; i++) {
        var c = v.getUint8(off + i);
        if (!c) break;
        sOut += String.fromCharCode(c);
      }
      return sOut;
    }
    function rat3(raw) {
      var off = t + u32(raw), a = [];
      for (var i = 0; i < 3; i++) {
        var d = u32(off + i * 8), q = u32(off + i * 8 + 4);
        a.push(q ? d / q : 0);
      }
      return a[0] + a[1] / 60 + a[2] / 3600;
    }

    walk(ifd0, function (tag, type, count, raw) {
      if (tag === 0x8769) exifOff = t + u32(raw);
      else if (tag === 0x8825) gpsOff = t + u32(raw);
      else if (tag === 0x0132 && !out.when) out.when = str(count, raw, raw);
    });
    if (exifOff) walk(exifOff, function (tag, type, count, raw) {
      if (tag === 0x9003 || tag === 0x9004) out.when = str(count, raw, raw) || out.when;
    });
    if (gpsOff) {
      var ns = "N", ew = "E";
      walk(gpsOff, function (tag, type, count, raw) {
        if (tag === 0x0001) ns = str(2, raw, raw);
        else if (tag === 0x0002) out.lat = rat3(raw);
        else if (tag === 0x0003) ew = str(2, raw, raw);
        else if (tag === 0x0004) out.lon = rat3(raw);
      });
      if (out.lat != null && ns === "S") out.lat = -out.lat;
      if (out.lon != null && ew === "W") out.lon = -out.lon;
    }

    /* "2026:09:24 14:10:33" の形で入っている */
    if (out.when) {
      var m = out.when.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
      out.when = m
        ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
        : null;
    }
    if (!out.when && out.lat == null) return null;
    return out;
  }

  /* 2点の距離をメートルで。地球を丸い球として扱う程度で十分 */
  function metersBetween(a, b) {
    if (a.lat == null || b.lat == null) return 0;
    var R = 6371000, r = Math.PI / 180;
    var dla = (b.lat - a.lat) * r, dlo = (b.lon - a.lon) * r;
    var h = Math.sin(dla / 2) * Math.sin(dla / 2)
      + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlo / 2) * Math.sin(dlo / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /* 時刻と場所でひとかたまりにする。
     2時間以上あいたら別、500m以上離れたら別 */
  var GAP_MS = 2 * 60 * 60 * 1000, GAP_M = 500;
  function clump(rows) {
    var withWhen = rows.filter(function (r) { return r.ex && r.ex.when; });
    if (withWhen.length < 2) return null;
    withWhen.sort(function (a, b) { return a.ex.when - b.ex.when; });
    var groups = [], cur = [withWhen[0]];
    for (var i = 1; i < withWhen.length; i++) {
      var prev = withWhen[i - 1].ex, now = withWhen[i].ex;
      var far = (now.lat != null && prev.lat != null) && metersBetween(prev, now) > GAP_M;
      if (now.when - prev.when > GAP_MS || far) { groups.push(cur); cur = []; }
      cur.push(withWhen[i]);
    }
    groups.push(cur);
    var loose = rows.filter(function (r) { return !(r.ex && r.ex.when); });
    return { groups: groups, loose: loose };
  }

  /* ============================================================
     写真の大きさ
     ============================================================
     元のファイルは持たず、必ず縮めてから保存する。
     iPhoneの写真は 4032×3024・3〜5MB あるので、そのまま溜めると端末が持たない */
  var SIZES = [
    { k: "full",  name: "そのまま",     edge: 2048, q: 0.86, note: "長辺2048px。細かいところまで残る" },
    { k: "mid",   name: "軽め",         edge: 1600, q: 0.82, note: "長辺1600px。見るぶんには十分" },
    { k: "small", name: "もっと軽め",   edge: 1280, q: 0.78, note: "長辺1280px。枚数が多い日に" }
  ];
  function sizeSpec(k) {
    for (var i = 0; i < SIZES.length; i++) if (SIZES[i].k === k) return SIZES[i];
    return SIZES[0];
  }
  /* 既定の大きさ。アプリ内カメラはこれをそのまま使い、いちいち聞かない */
  function photoSize() { return sizeSpec(recall("psize") || "full"); }
  /* 取り込むとき、毎回きくかどうか */
  function asksSize() { return recall("pask") !== "0"; }

  /* 1枚を大小2つのJPEGにして保存する。取り込みとアプリ内カメラで共用 */
  function savePhoto(src, exAt, tAt, nudge, spec) {
    var sp = spec || photoSize();
    return Promise.all([shrink(src, sp.edge, sp.q), shrink(src, 400, 0.72)]).then(function (r) {
      var full = r[0], thumb = r[1];
      var bid = uid(), tid = uid();
      var rec = {
        id: uid(), exId: exAt, kind: "photo",
        blobId: bid, thumbId: tid, mime: "image/jpeg",
        memo: "", tags: tAt.slice(), fav: false,
        w: full.w, h: full.h, bytes: full.blob.size + thumb.blob.size,
        createdAt: Date.now() + (nudge || 0)
      };
      return DB.putMany([
        ["blobs", { id: bid, blob: full.blob }],
        ["blobs", { id: tid, blob: thumb.blob }],
        ["items", rec]
      ]).then(function () {
        if (exAt === curEx) items.push(rec);
        if (browseAll) browseAll.push(rec);
        return rec;
      });
    });
  }

  function addPhotos(files) {
    if (!curEx) { toast("先に" + LL() + "をつくってください。", true); newExDialog(); return; }
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    /* 毎回きく設定なら、先に大きさを選ばせてから取り込む */
    if (asksSize()) { sizeAsk(list.length, function (sp) { afterSize(list, sp); }); return; }
    afterSize(list, photoSize());
  }

  /* 大きさが決まったら、撮った時刻と場所でかたまりを探す。
     2つ以上に分かれたときだけ、分けるか聞く */
  function afterSize(list, spec) {
    if (list.length < 3 || recall("nosplit") === "1") { runPhotos(list, spec); return; }
    toast("撮った時刻を見ています…");
    var jobs = list.map(function (f) {
      return exifOf(f).then(function (ex) { return { file: f, ex: ex }; });
    });
    Promise.all(jobs).then(function (rows) {
      var c = clump(rows);
      if (!c || c.groups.length < 2) { runPhotos(list, spec); return; }
      splitAsk(c, spec, list);
    }, function () { runPhotos(list, spec); });
  }

  function whenLabel(g) {
    var a = new Date(g[0].ex.when), b = new Date(g[g.length - 1].ex.when);
    var d = (a.getMonth() + 1) + "/" + a.getDate();
    var t1 = pad2(a.getHours()) + ":" + pad2(a.getMinutes());
    var t2 = pad2(b.getHours()) + ":" + pad2(b.getMinutes());
    return d + " " + t1 + (t1 === t2 ? "" : "〜" + t2);
  }
  function placeLabel(g) {
    for (var i = 0; i < g.length; i++) if (g[i].ex.lat != null) {
      return g[i].ex.lat.toFixed(3) + ", " + g[i].ex.lon.toFixed(3);
    }
    return "";
  }

  /* かたまりが見つかったとき。分けるか、1つにまとめるかを選ばせる */
  function splitAsk(c, spec, all) {
    var gs = c.groups;
    $("minibox").innerHTML = "<h4>" + gs.length + " つのまとまりに分かれています</h4>"
      + "<p>撮った時刻と場所で見ると、別の場面が混ざっているようです。分けて入れることもできます。</p>"
      + '<div class="clumps">'
      + gs.map(function (g, i) {
          var pl = placeLabel(g);
          return '<div class="clump"><b>' + esc(whenLabel(g)) + "</b>"
            + "<span>" + g.length + " 枚" + (pl ? " ・ " + esc(pl) : "") + "</span></div>";
        }).join("")
      + (c.loose.length ? '<div class="clump"><b>時刻が分からないもの</b><span>' + c.loose.length + " 枚</span></div>" : "")
      + "</div>"
      + '<label class="sizeask"><input type="checkbox" id="spNo"> 次からきかない</label>'
      + '<div class="minibtns"><button class="ghost" id="spOne">1つにまとめる</button>'
      + '<button class="cta" id="spSplit">' + gs.length + " つに分ける</button></div>";
    noAutofill($("minibox"));
    $("mini").className = "mini on";

    function remember0() { if ($("spNo").checked) remember("nosplit", "1"); }
    $("spOne").onclick = function () { remember0(); miniClose(); runPhotos(all, spec); };
    $("spSplit").onclick = function () {
      remember0(); miniClose();
      splitInto(gs, c.loose, spec);
    };
  }

  /* かたまりごとに新しいフォルダを作って、順に入れていく */
  function splitInto(gs, loose, spec) {
    var base = exById(curEx), made = 0;
    var chain = Promise.resolve();
    gs.forEach(function (g, i) {
      chain = chain.then(function () {
        var a = new Date(g[0].ex.when);
        var nm = (base && base.name ? base.name : "写真") + "_" + (a.getMonth() + 1) + "-" + a.getDate()
          + "_" + pad2(a.getHours()) + pad2(a.getMinutes());
        var ex = {
          id: uid(), name: dedupeName(nm), cat: (base && base.cat) || "",
          date: a.getFullYear() + "-" + pad2(a.getMonth() + 1) + "-" + pad2(a.getDate()),
          venue: "", note: "", form: (base && base.form) || "", createdAt: Date.now() + i
        };
        return DB.put("exhibitions", ex).then(function () {
          exs.push(ex);
          made++;
          curEx = ex.id;
          return new Promise(function (done) {
            runPhotos(g.map(function (r) { return r.file; }), spec, done);
          });
        });
      });
    });
    chain.then(function () {
      if (loose && loose.length) {
        curEx = base ? base.id : curEx;
        return new Promise(function (done) {
          runPhotos(loose.map(function (r) { return r.file; }), spec, done);
        });
      }
    }).then(function () {
      curEx = base ? base.id : curEx;
      toast(made + " つのフォルダに分けました");
      goShelf();
    }).catch(function (e) { toast(why(e), true); });
  }

  /* 同じ名前が並ばないように、後ろに番号を足す */
  function dedupeName(nm) {
    var used = {};
    exs.forEach(function (e) { used[(e.name || "").trim()] = 1; });
    if (!used[nm]) return nm;
    for (var i = 2; i < 99; i++) if (!used[nm + "_" + i]) return nm + "_" + i;
    return nm + "_" + Date.now();
  }

  /* 取り込む前に1回だけきく。「毎回きかない」にすると次からは出ない */
  function sizeAsk(count, go) {
    var cur = photoSize().k;
    $("minibox").innerHTML = "<h4>" + count + " 枚の大きさ</h4>"
      + "<p>元のままだと端末の空きをそのぶん使います。あとから変えられません。</p>"
      + '<div class="sizepick" id="szPick">'
      + SIZES.map(function (x) {
          return '<button data-sz="' + x.k + '" aria-pressed="' + (x.k === cur) + '">'
            + "<b>" + esc(x.name) + "</b><span>" + esc(x.note) + "</span></button>";
        }).join("")
      + "</div>"
      + '<label class="sizeask"><input type="checkbox" id="szNo"> 次からきかない（設定でいつでも戻せます）</label>'
      + '<div class="minibtns"><button class="ghost" id="szCancel">やめる</button>'
      + '<button class="cta" id="szGo">取り込む</button></div>';
    noAutofill($("minibox"));
    $("mini").className = "mini on";

    var pick = cur;
    Array.prototype.forEach.call($("szPick").querySelectorAll("[data-sz]"), function (b) {
      b.onclick = function () {
        pick = b.getAttribute("data-sz");
        Array.prototype.forEach.call($("szPick").querySelectorAll("[data-sz]"), function (o) {
          o.setAttribute("aria-pressed", o === b);
        });
      };
    });
    $("szCancel").onclick = miniClose;
    $("szGo").onclick = function () {
      remember("psize", pick);
      if ($("szNo").checked) remember("pask", "0");
      miniClose();
      go(sizeSpec(pick));
    };
  }

  /* then は、分けて入れるときに「1つ終わった」と伝えるための合図 */
  function runPhotos(list, spec, then) {
    var exAt = curEx;
    var tAt = (curTag !== "all" && curTag !== "none") ? [curTag] : [];
    var ok = 0, failed = 0, lastErr = "", added = [];
    progress(2);
    toast(list.length + " 枚を取り込んでいます…");

    var chain = Promise.resolve();
    list.forEach(function (f, n) {
      chain = chain.then(function () {
        return savePhoto(f, exAt, tAt, n, spec).then(function (rec) { ok++; if (rec) added.push(rec.id); }, function (e) {
          failed++; lastErr = why(e);
        }).then(function () {
          progress(Math.round(((ok + failed) / list.length) * 100));
        });
      });
    });

    chain.then(function () {
      progress(100);
      items.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      paint(); gauge();
      if (then) { if (failed) toast(failed + " 枚は入りませんでした。" + lastErr, true); then(); return; }
      if (failed && !ok) toast(failed + " 枚とも失敗：" + lastErr, true);
      else if (failed) toast(ok + " 枚を追加（" + failed + " 枚失敗：" + lastErr + "）", true);
      else tagPrompt(added);
    });
  }

  /* 写真の大きさの設定。アプリ内カメラはここで選んだものを黙って使う */
  function sizeSheet() {
    var cur = photoSize().k;
    sheet('<div class="panel-head"><h3>写真の大きさ</h3>'
      + '<button class="iconbtn ok" id="szClose" aria-label="完了"><svg><use href="#i-check"/></svg></button></div>'
      + '<div class="panel-body">'
      + '<div class="field"><div class="label">大きさ</div>'
      + '<div class="sizepick" id="szPick2">'
      + SIZES.map(function (x) {
          return '<button data-sz="' + x.k + '" aria-pressed="' + (x.k === cur) + '">'
            + "<b>" + esc(x.name) + "</b><span>" + esc(x.note) + "</span></button>";
        }).join("")
      + "</div>"
      + '<div class="hintline">元の写真は残しません。ここで選んだ大きさに縮めてから入ります。'
      + "あとから大きくは戻せません。</div></div>"
      + '<div class="field"><div class="label">取り込むとき</div>'
      + '<div class="segs" id="szAsk">'
      + '<button data-ask="1" aria-pressed="' + asksSize() + '">毎回きく</button>'
      + '<button data-ask="0" aria-pressed="' + (!asksSize()) + '">きかない</button>'
      + "</div>"
      + '<div class="hintline">アプリ内カメラで撮るときは、いつも上の大きさを使います。'
      + "撮るたびに手が止まらないように、こちらではききません。</div></div>"
      + '<div class="field"><div class="label">時刻と場所で分ける</div>'
      + '<div class="segs" id="szSplit">'
      + '<button data-sp="1" aria-pressed="' + (recall("nosplit") !== "1") + '">まとまりが分かれていたらきく</button>'
      + '<button data-sp="0" aria-pressed="' + (recall("nosplit") === "1") + '">きかない</button>'
      + "</div>"
      + '<div class="hintline">写真に残っている撮影時刻と位置を見て、'
      + "2時間以上あいているか500m以上離れていたら、別の場面として分けるかきいてきます。"
      + "写真の中身は見ていません。</div></div>"
      + "</div>", "dialog");

    $("szClose").onclick = closeSheet;
    Array.prototype.forEach.call($("szPick2").querySelectorAll("[data-sz]"), function (b) {
      b.onclick = function () {
        remember("psize", b.getAttribute("data-sz"));
        Array.prototype.forEach.call($("szPick2").querySelectorAll("[data-sz]"), function (o) {
          o.setAttribute("aria-pressed", o === b);
        });
        toast(photoSize().name + "（長辺" + photoSize().edge + "px）にしました");
      };
    });
    Array.prototype.forEach.call($("szSplit").querySelectorAll("[data-sp]"), function (b) {
      b.onclick = function () {
        remember("nosplit", b.getAttribute("data-sp") === "1" ? "0" : "1");
        Array.prototype.forEach.call($("szSplit").querySelectorAll("[data-sp]"), function (o) {
          o.setAttribute("aria-pressed", o === b);
        });
      };
    });
    Array.prototype.forEach.call($("szAsk").querySelectorAll("[data-ask]"), function (b) {
      b.onclick = function () {
        remember("pask", b.getAttribute("data-ask"));
        Array.prototype.forEach.call($("szAsk").querySelectorAll("[data-ask]"), function (o) {
          o.setAttribute("aria-pressed", o === b);
        });
      };
    });
  }

  /* 入れたばかりのものに、まとめてタグを付ける */
  function tagPrompt(ids) {
    if (!ids || !ids.length) return;
    var c = tagCounts("shelf");
    var sug = Object.keys(c).sort(function (a, b) { return c[b] - c[a]; }).slice(0, 10);
    var now = (curTag !== "all" && curTag !== "none") ? curTag : "";

    $("minibox").innerHTML = "<h4>" + ids.length + " 件を追加しました</h4>"
      + "<p>まとめてタグを付けられます。あとから1件ずつ付けても構いません。</p>"
      + '<input class="inp" id="tgIn" value="' + esc(now) + '" placeholder="" autocomplete="off">'
      + (sug.length
          ? '<div class="chipset" style="margin-top:8px">' + sug.map(function (t) {
              return '<button class="tag" data-sugt="' + esc(t) + '">#' + esc(t) + "</button>";
            }).join("") + "</div>"
          : "")
      + '<div class="minibtns"><button class="ghost" id="tgNo">あとで</button>'
      + '<button class="cta" id="tgYes">付ける</button></div>';
    noAutofill($("minibox"));
    $("mini").className = "mini on";

    Array.prototype.forEach.call($("minibox").querySelectorAll("[data-sugt]"), function (b) {
      b.onclick = function () { $("tgIn").value = b.getAttribute("data-sugt"); $("tgIn").focus(); };
    });
    $("tgNo").onclick = miniClose;
    $("tgYes").onclick = function () {
      var t = $("tgIn").value.trim().replace(/^[#＃]+/, "");
      if (!t) { miniClose(); return; }
      var jobs = [];
      ids.forEach(function (id) {
        var it = itemById(id) || (browseAll || []).filter(function (x) { return x.id === id; })[0];
        if (!it) return;
        it.tags = it.tags || [];
        if (it.tags.indexOf(t) < 0) it.tags.push(t);
        jobs.push(DB.put("items", it));
      });
      Promise.all(jobs).then(function () {
        miniClose();
        paint();
        toast("#" + t + " を付けました");
      }).catch(function (e) { toast(why(e), true); });
    };
    setTimeout(function () { var e = $("tgIn"); if (e) { e.focus(); e.select(); } }, 60);
  }

  /* 種類の呼び名。あちこちで同じ判定を書かないための一本化 */
  function kindName(k) {
    return k === "photo" ? "写真" : k === "video" ? "動画"
         : k === "text" ? "メモ" : k === "file" ? "書類" : "録音";
  }
  /* 書類の見出しに出す短い記号。PDF・XLSX など */
  function fileMark(it) {
    var e = extOf(it);
    return (e || "FILE").toUpperCase().slice(0, 5);
  }
  /* 書類のタイル。一覧でも1点の画面でも同じ形 */
  function fileTile(it, big) {
    return '<div class="filetile' + (big ? " big" : "") + '">'
      + '<svg><use href="#i-doc"/></svg>'
      + '<div class="fext">' + esc(fileMark(it)) + "</div>"
      + '<div class="fname">' + esc(it.name || "名前のない書類") + "</div></div>";
  }

  /* 保存するときの拡張子。取り込んだファイルは元の名前・形式を尊重する */
  function extOf(it) {
    if (it.kind === "photo") return "jpg";
    if (it.kind === "file") {
      var fn = String(it.name || "").match(/\.([A-Za-z0-9]{1,8})$/);
      return fn ? fn[1].toLowerCase() : "dat";
    }
    var n = String(it.name || "");
    var m = n.match(/\.([A-Za-z0-9]{2,5})$/);
    if (m) return m[1].toLowerCase();
    var t = String(it.mime || "").toLowerCase();
    if (t.indexOf("quicktime") >= 0) return "mov";
    if (t.indexOf("mpeg") >= 0) return it.kind === "audio" ? "mp3" : "mpg";
    if (t.indexOf("wav") >= 0) return "wav";
    if (t.indexOf("mp4") >= 0 || t.indexOf("m4a") >= 0) return it.kind === "audio" ? "m4a" : "mp4";
    return "webm";
  }

  /* 文字だけのメモを1件作り、そのまま編集画面を開く */
  function addTextMemo() {
    var rec = {
      id: uid(), exId: curEx,

      kind: "text", blobId: null, thumbId: null, mime: "",
      memo: memoForm(), tags: (curTag !== "all" && curTag !== "none") ? [curTag] : [], fav: false, bytes: 0,
      createdAt: Date.now()
    };
    DB.put("items", rec).then(function () {
      items.push(rec);
      items.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      paint();
      openItem(rec.id);
      setTimeout(function () { var m = $("mMemo"); if (m) m.focus(); }, 260);
    }).catch(function (e) { toast(why(e), true); });
  }

  /* ============================================================
     録音・録画
     ============================================================ */
  var MIME_AUDIO = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
  var MIME_VIDEO = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  var LIMIT = { audio: 30 * 60 * 1000, video: 5 * 60 * 1000 };

  function pickMime(cands) {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < cands.length; i++) if (MediaRecorder.isTypeSupported(cands[i])) return cands[i];
    return "";
  }

  function record(kind) {
    if (!curEx) { toast("先に" + LL() + "をつくってください。", true); newExDialog(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast("この端末では" + (kind === "audio" ? "録音" : "録画") + "できません。", true);
      return;
    }

    var isA = kind === "audio";
    var want = isA ? { audio: true }
      : { audio: true, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } } };

    var box = $("rec");
    box.className = "rec on";
    box.innerHTML = '<div class="rechint">' + (isA ? "マイク" : "カメラとマイク") + "の使用を許可してください…</div>"
      + '<div class="recbtns"><button class="ghost" id="recCancel">やめる</button></div>';
    $("recCancel").onclick = function () { box.className = "rec"; box.innerHTML = ""; document.body.style.overflow = ""; };
    document.body.style.overflow = "hidden";

    navigator.mediaDevices.getUserMedia(want).then(function (stream) {
      var mime = pickMime(isA ? MIME_AUDIO : MIME_VIDEO);
      var opts = {};
      if (mime) opts.mimeType = mime;
      opts.audioBitsPerSecond = 96000;
      if (!isA) opts.videoBitsPerSecond = 4000000;

      var mr;
      try { mr = new MediaRecorder(stream, opts); }
      catch (e1) {
        try { mr = new MediaRecorder(stream); }
        catch (e2) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          box.className = "rec"; box.innerHTML = ""; document.body.style.overflow = "";
          toast("録音・録画を開始できませんでした。", true);
          return;
        }
      }

      var chunks = [], bytes = 0, t0 = Date.now(), tick = null, level = null, ac = null, stopped = false;

      box.innerHTML = (isA ? '<div class="levels" id="lv"></div>' : '<video id="prev" muted playsinline autoplay></video>')
        + '<div class="reclock"><span class="recdot"></span><span id="lock">00:00</span></div>'
        + '<div class="recmeter"><i id="mtr"></i></div>'
        + '<div class="rechint">' + (isA ? "プレスの説明はここに残しておけます。最長30分。" : "そのまま歩きながら回せます。最長5分。")
        + "<br>" + ((curTag !== "all" && curTag !== "none") ? "タグ：#" + esc(curTag) : "あとからタグを付けられます") + "</div>"
        + '<div class="recbtns"><button class="ghost" id="recAbort">破棄</button>'
        + '<button class="stopbtn" id="recStop">録り終える</button></div>';

      if (isA) {
        var lv = $("lv"), bars = [];
        for (var i = 0; i < 24; i++) { var el = document.createElement("i"); lv.appendChild(el); bars.push(el); }
        try {
          ac = new (window.AudioContext || window.webkitAudioContext)();
          var an = ac.createAnalyser(); an.fftSize = 64;
          ac.createMediaStreamSource(stream).connect(an);
          var buf = new Uint8Array(an.frequencyBinCount);
          level = setInterval(function () {
            an.getByteFrequencyData(buf);
            for (var j = 0; j < bars.length; j++) {
              bars[j].style.height = Math.max(10, (buf[Math.min(buf.length - 1, j)] / 255) * 100) + "%";
            }
          }, 80);
        } catch (e) {}
      } else {
        var pv = $("prev");
        pv.srcObject = stream;
        pv.play().catch(function () {});
      }

      function stop(discard) {
        if (stopped) return;
        stopped = true;
        clearInterval(tick); clearInterval(level);
        if (ac && ac.close) ac.close().catch(function () {});
        if (discard) chunks = [];
        try { if (mr.state !== "inactive") mr.stop(); } catch (e) {}
        stream.getTracks().forEach(function (t) { t.stop(); });
        if (discard) { box.className = "rec"; box.innerHTML = ""; document.body.style.overflow = ""; }
      }

      $("recAbort").onclick = function () { stop(true); toast("破棄しました"); };
      $("recStop").onclick = function () { stop(false); };

      tick = setInterval(function () {
        var el2 = Date.now() - t0;
        var l = $("lock"); if (l) l.textContent = clock(el2);
        var m = $("mtr"); if (m) m.style.width = Math.min(100, (el2 / LIMIT[kind]) * 100) + "%";
        if (el2 >= LIMIT[kind]) { stop(false); toast("上限に達したので録り終えました"); }
      }, 200);

      mr.ondataavailable = function (e) {
        if (e.data && e.data.size) { chunks.push(e.data); bytes += e.data.size; }
      };

      mr.onstop = function () {
        box.className = "rec"; box.innerHTML = ""; document.body.style.overflow = "";
        if (!chunks.length) return;
        var dur = Date.now() - t0;
        var blob = new Blob(chunks, { type: (mr.mimeType || "").split(";")[0] || (isA ? "audio/webm" : "video/webm") });
        var exAt = curEx;
        var tAt = (curTag !== "all" && curTag !== "none") ? [curTag] : [];
        var bid = uid();
        var rec = {
          id: uid(), exId: exAt, kind: kind,
          blobId: bid, thumbId: kind === "video" ? bid : null, mime: blob.type,
          memo: "", tags: tAt.slice(), fav: false,
          durMs: dur, bytes: blob.size, createdAt: Date.now()
        };
        progress(40);
        DB.putMany([["blobs", { id: bid, blob: blob }], ["items", rec]]).then(function () {
          progress(100);
          if (exAt === curEx) {
            items.push(rec);
            items.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
            paint();
          }
          gauge();
          toast((isA ? "録音" : "録画") + "を保存しました（" + mb(blob.size) + "）");
        }).catch(function (e) { progress(100); toast(why(e), true); });
      };

      try { mr.start(1000); }
      catch (e) {
        stop(true);
        toast("録音・録画を開始できませんでした。", true);
      }

    }).catch(function (e) {
      box.className = "rec"; box.innerHTML = ""; document.body.style.overflow = "";
      var n = e && e.name;
      if (n === "NotAllowedError") toast("マイク／カメラの使用が許可されませんでした。設定から許可してください。", true);
      else if (n === "NotFoundError") toast("マイク／カメラが見つかりませんでした。", true);
      else toast("マイク／カメラを使えませんでした。" + (n ? "（" + n + "）" : ""), true);
    });
  }

  /* ============================================================
     1点の詳細
     ============================================================ */
  var saveTimer = null;

  function openItem(id) {
    var it = itemById(id);
    if (!it) return;
    var list = visible(), pos = 0;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) pos = i + 1;

    ensureUrls([it.blobId]).then(function () {
      var src = urlCache[it.blobId] || "";
      var media;
      /* 隣の1件へ送る矢印。指ではスワイプできるが、
         パソコンには払う動きがないので、押せるものを重ねておく */
      function stepArrows() {
        return '<button class="stepper prev" id="mPrev" aria-label="前の1件">'
          + '<svg><use href="#i-back"/></svg></button>'
          + '<button class="stepper next" id="mNext" aria-label="次の1件">'
          + '<svg><use href="#i-back"/></svg></button>';
      }
      if (it.kind === "photo") {
        media = '<div class="shotwrap">'
          + '<img class="shot big" id="mShot" src="' + src + '" alt="" '
          + 'role="button" tabindex="0" aria-label="大きく見る">'
          + stepArrows() + "</div>"
          + '<div class="fxrow" style="margin-top:6px">'
          + '<button class="ghost" id="mFix">写真を直す</button>'
          + (it.origId ? '<button class="ghost" id="mUnfix">元に戻す</button>' : "")
          + "</div>";
      }
      else if (it.kind === "video") media = '<div class="shotwrap">'
        + '<video class="play" id="mShot" src="' + src + '" controls playsinline preload="metadata"></video>'
        + stepArrows() + "</div>";
      else if (it.kind === "text") media = "";
      else if (it.kind === "file") media = fileTile(it, true) + '<button class="ghost" id="mOpen" style="justify-self:start">この書類を開く</button>';
      else media = '<audio src="' + src + '" controls preload="metadata"></audio>';

      var kindJa = kindName(it.kind);
      var stamp = new Date(it.createdAt || Date.now());

      sheet('<div class="panel-head">'
        + "<h3>" + pad2(pos) + " ／ " + kindJa + "</h3>"
        + '<div style="display:flex;gap:8px">'
        + '<button class="iconbtn" id="mFav" title="お気に入り" aria-pressed="' + (!!it.fav) + '" style="color:' + (it.fav ? "var(--mark)" : "var(--ink3)") + '"><svg><use href="#i-star"/></svg></button>'
        + '<button class="iconbtn ok" id="mClose" aria-label="完了"><svg><use href="#i-check"/></svg></button></div></div>'
        + '<div class="panel-body">'
        + media
        + '<div class="field"><label class="label" for="mMemo">メモ</label>'
        + '<textarea class="ta" id="mMemo" placeholder="' + esc(memoHint()) + '">' + esc(it.memo || "") + "</textarea>"
        + ((!it.memo && memoForm()) ? '<button class="ghost" id="mForm" style="justify-self:start;margin-top:2px">＋ フォーマットを入れる</button>' : "")
        + '<div class="saveflag" id="mFlag"></div></div>'
        + '<div class="field"><label class="label" for="mTag">タグ</label>'
        + '<input class="inp" id="mTag" placeholder="＃タグを入れて Enter（何個でも）">'
        + '<div class="chipset" id="mTags"></div>'
        + '<div class="hintline">何個でも付けられます。＃を押すと、全フォルダから同じタグを集めます</div></div>'
        + '<div class="label">' + stamp.getFullYear() + "/" + pad2(stamp.getMonth() + 1) + "/" + pad2(stamp.getDate())
        + " " + pad2(stamp.getHours()) + ":" + pad2(stamp.getMinutes())
        + (it.bytes ? " ・ " + mb(it.bytes) : "") + (it.durMs ? " ・ " + clock(it.durMs) : "")
        + (it.w ? " ・ " + it.w + "×" + it.h : "")
        + (it.name ? ' ・ <span class="asis">' + esc(it.name) + "</span>" : "") + "</div>"
        + "</div>"
        + '<div class="panel-foot">'
        + '<button class="danger" id="mDel">削除</button>'
        + (it.blobId ? '<button class="ghost" id="mDl">この' + kindJa + "を共有</button>" : "<span></span>")
        + "</div>");

      var fx = $("mFix");
      if (fx) fx.onclick = function () {
        clearTimeout(saveTimer);
        var t = $("mMemo");
        if (t && t.value !== (it.memo || "")) save({ memo: t.value });
        fixSheet(it, function () { openItem(it.id); });
      };
      var ufx = $("mUnfix");
      if (ufx) ufx.onclick = function () {
        unfixItem(it, function () { openItem(it.id); });
      };

      $("mClose").onclick = function () {
        /* 700ミリ秒の自動保存を待たずに、いま書いてあるものを残してから閉じる */
        clearTimeout(saveTimer);
        var t = $("mMemo");
        if (t && t.value !== (it.memo || "")) save({ memo: t.value });
        closeSheet();
      };

      /* 左右スワイプで隣の1件へ */
      function step(d) {
        var l = visible(), i = -1;
        for (var k = 0; k < l.length; k++) if (l[k].id === id) i = k;
        var t = l[i + d];
        if (t) openItem(t.id);
        else toast(d > 0 ? "最後の1件です" : "最初の1件です");
      }
      var shot = $("mShot");
      if (shot) attachSwipe(shot, function () { step(-1); }, function () { step(1); });
      /* 写真を押したら画面いっぱいで見る。払って送る動きとぶつからないよう、
         指が動かずに離れたときだけ開く */
      if (shot && it.kind === "photo") {
        var px = 0, py = 0;
        shot.addEventListener("pointerdown", function (e) { px = e.clientX; py = e.clientY; });
        shot.addEventListener("pointerup", function (e) {
          if (Math.abs(e.clientX - px) > 8 || Math.abs(e.clientY - py) > 8) return;
          bigView(shot.src);
        });
        shot.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bigView(shot.src); }
        });
      }

      var pv = $("mPrev"), nx = $("mNext");
      if (pv && nx) {
        pv.disabled = pos <= 1;
        nx.disabled = pos >= list.length;
        pv.onclick = function () { step(-1); };
        nx.onclick = function () { step(1); };
      }

      var op = $("mOpen");
      if (op) op.onclick = function () {
        /* 中身はこのアプリでは開かない。端末の持っているアプリに任せる */
        DB.get("blobs", it.blobId).then(function (r) {
          if (!r || !r.blob) throw new Error("元のデータが見つかりませんでした。");
          var u = URL.createObjectURL(r.blob);
          var w = window.open(u, "_blank");
          if (!w) { var link = document.createElement("a"); link.href = u; link.download = it.name || ("書類." + extOf(it)); link.click(); }
          setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
        }).catch(function (e) { toast(why(e), true); });
      };

      var tags = (it.tags || []).slice();
      function sugHtml() {
        var pool = browseAll || items;
        var count = {};
        pool.forEach(function (x) {
          (x.tags || []).forEach(function (t) { if (tags.indexOf(t) < 0) count[t] = (count[t] || 0) + 1; });
        });
        var keys = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; }).slice(0, 8);
        if (!keys.length) return "";
        return '<div class="tagsug">' + keys.map(function (t) {
          return '<button data-sug="' + esc(t) + '">＋ #' + esc(t) + "</button>";
        }).join("") + "</div>";
      }
      function paintTags() {
        $("mTags").innerHTML = tags.map(function (t, i) {
          return '<span class="chip"><button class="tap" data-find="' + esc(t) + '">#' + esc(t) + "</button>"
            + '<button class="rm" data-tag="' + i + '" aria-label="' + esc(t) + 'を外す">×</button></span>';
        }).join("") + sugHtml();
        Array.prototype.forEach.call($("mTags").querySelectorAll("[data-tag]"), function (b) {
          b.onclick = function () {
            tags.splice(parseInt(b.getAttribute("data-tag"), 10), 1);
            paintTags(); save({ tags: tags });
          };
        });
        Array.prototype.forEach.call($("mTags").querySelectorAll("[data-find]"), function (b) {
          b.onclick = function () { searchByTag(b.getAttribute("data-find")); };
        });
        Array.prototype.forEach.call($("mTags").querySelectorAll("[data-sug]"), function (b) {
          b.onclick = function () {
            var t = b.getAttribute("data-sug");
            if (tags.indexOf(t) < 0) { tags.push(t); paintTags(); save({ tags: tags }); }
          };
        });
      }
      paintTags();

      function save(patch) {
        Object.keys(patch).forEach(function (k) { it[k] = patch[k]; });
        var f = $("mFlag");
        if (f) f.textContent = "保存中…";
        DB.put("items", it).then(function () {
          if (f) {
            f.textContent = "保存しました";
            setTimeout(function () { if (f) f.textContent = ""; }, 1400);
          }
          paintRail(); paintStage();
        }).catch(function (e) { if (f) f.textContent = why(e); });
      }

      $("mMemo").oninput = function () {
        var v = this.value;
        clearTimeout(saveTimer);
        $("mFlag").textContent = "…";
        saveTimer = setTimeout(function () { save({ memo: v }); }, 700);
      };
      var fb = $("mForm");
      if (fb) fb.onclick = function () {
        var t = $("mMemo");
        t.value = memoForm();
        t.focus();
        try { t.setSelectionRange(t.value.indexOf("\n") > 0 ? t.value.indexOf("\n") : t.value.length, t.value.indexOf("\n") > 0 ? t.value.indexOf("\n") : t.value.length); } catch (e) {}
        save({ memo: t.value });
        fb.remove();
      };

      $("mTag").onkeydown = function (e) {
        if (e.key !== "Enter") return;
        e.preventDefault();
        var v = this.value.trim();
        if (!v) return;
        if (tags.indexOf(v) < 0) { tags.push(v); paintTags(); save({ tags: tags }); }
        this.value = "";
      };
      $("mFav").onclick = function () {
        var next = !it.fav;
        this.setAttribute("aria-pressed", String(next));
        this.style.color = next ? "var(--mark)" : "var(--ink3)";
        save({ fav: next });
      };
      $("mDel").onclick = function () {
        askYesNo({
          title: "この" + kindJa + "を削除",
          body: "付けたメモとタグもいっしょに消えます。取り消せません。",
          ok: "削除する"
        }, function () {
          var kill = [["items", it.id]];
          if (it.blobId) kill.push(["blobs", it.blobId]);
          if (it.thumbId && it.thumbId !== it.blobId) kill.push(["blobs", it.thumbId]);
          DB.delMany(kill).then(function () {
            items = items.filter(function (x) { return x.id !== it.id; });
            forgetFromBrowse(it.id);
            closeSheet(); paint(); gauge(); toast("削除しました");
          }).catch(function (e) { toast(why(e), true); });
        });
      };
      var dl = $("mDl");
      if (dl) dl.onclick = function () {
        var ext = extOf(it);
        /* 取り込んだ書類は、元のファイル名のまま渡す。相手が探しやすい */
        var fname = (it.kind === "file" && it.name)
          ? it.name
          : safeName((exById(curEx) || {}).name) + "_" + pad2(pos) + "." + ext;
        DB.get("blobs", it.blobId).then(function (r) {
          if (!r || !r.blob) throw new Error("元のデータが見つかりませんでした。");
          return handOver(r.blob, fname);
        }).then(function (how) {
          if (how !== "cancel") toast("書き出しました");
        }).catch(function (e) { toast(why(e), true); });
      };
    });
  }


  /* ============================================================
     写真を直す（回転・切り抜き・明るさ）
     ------------------------------------------------------------
     見えているとおりに保存されることが何より大事なので、
     下書きも仕上がりも render() ひとつで描く。大きさが違うだけ。
     二重に計算を書くと、必ずどこかでずれる。

     ずらし量（st.x / st.y）は画素ではなく「枠に対する割合」で持つ。
     こうしておくと、小さい下書きで決めた位置が、そのまま
     大きい仕上がりでも同じ場所になる。
     ============================================================ */

  /* 切り抜きの形。そのまま＝写真の形を変えない */
  var CUTS = [
    { k: "as", t: "そのまま", r: 0 },
    { k: "sq", t: "1:1", r: 1 },
    { k: "p45", t: "4:5", r: 4 / 5 },
    { k: "l43", t: "4:3", r: 4 / 3 },
    { k: "l169", t: "16:9", r: 16 / 9 }
  ];

  function fixSheet(it, after) {
    if (!it || it.kind !== "photo" || !it.blobId) return;

    var rot = 0, bri = 100, con = 100, cut = "as";
    var st = { s: 1, x: 0, y: 0 };
    var im = null, nat = { w: 0, h: 0 };

    /* 回したあとの、元画像の向き */
    function srcW() { return rot % 180 === 0 ? nat.w : nat.h; }
    function srcH() { return rot % 180 === 0 ? nat.h : nat.w; }

    function ratio() {
      for (var i = 0; i < CUTS.length; i++) if (CUTS[i].k === cut) return CUTS[i].r;
      return 0;
    }
    /* 仕上がりの縦横。そのままなら回したあとの形をそのまま使う */
    function outSize() {
      var r = ratio();
      var edge = Math.min(photoSize().edge, Math.max(srcW(), srcH()));
      if (!r) {
        var k = edge / Math.max(srcW(), srcH());
        return { w: Math.round(srcW() * k), h: Math.round(srcH() * k) };
      }
      /* 切り抜きで実際に使える画素はここまで。これを超えて大きくすると、
         元にない細かさを水増しすることになるので、上限にする */
      var sr = srcW() / srcH();
      var aw = r >= sr ? srcW() : srcH() * r;
      var ah = aw / r;
      var long = Math.max(aw, ah);
      var k = Math.min(photoSize().edge, long) / long;
      return { w: Math.max(1, Math.round(aw * k)), h: Math.max(1, Math.round(ah * k)) };
    }

    function clampST(W, H) {
      var cover = Math.max(W / srcW(), H / srcH()), s = cover * st.s;
      var ow = srcW() * s, oh = srcH() * s;
      var mx = Math.max(0, (ow - W) / 2) / W;
      var my = Math.max(0, (oh - H) / 2) / H;
      st.x = Math.max(-mx, Math.min(mx, st.x));
      st.y = Math.max(-my, Math.min(my, st.y));
    }

    /* 下書きも仕上がりもこれ。明るさはここでは触らない */
    function render(g, W, H) {
      var cover = Math.max(W / srcW(), H / srcH()), s = cover * st.s;
      g.clearRect(0, 0, W, H);
      g.save();
      g.imageSmoothingQuality = "high";
      g.translate(W / 2 + st.x * W, H / 2 + st.y * H);
      g.rotate(rot * Math.PI / 180);
      g.drawImage(im, -nat.w * s / 2, -nat.h * s / 2, nat.w * s, nat.h * s);
      g.restore();
    }

    /* 明るさとコントラスト。下書きはCSSに任せ、仕上がりだけ自前で計算する。
       canvas の filter は古いiPhoneで効かないことがあるため */
    function tone(g, W, H) {
      if (bri === 100 && con === 100) return;
      var d = g.getImageData(0, 0, W, H), a = d.data;
      var b = bri / 100, c = con / 100;
      var lut = new Uint8ClampedArray(256);
      for (var v = 0; v < 256; v++) lut[v] = (v * b - 127.5) * c + 127.5;
      for (var i = 0; i < a.length; i += 4) {
        a[i] = lut[a[i]]; a[i + 1] = lut[a[i + 1]]; a[i + 2] = lut[a[i + 2]];
      }
      g.putImageData(d, 0, 0);
    }

    function cutRow() {
      return CUTS.map(function (c) {
        return '<button data-cut="' + c.k + '" aria-pressed="' + (c.k === cut) + '">'
          + esc(c.t) + "</button>";
      }).join("");
    }

    sheet('<div class="panel-head"><h3>写真を直す</h3>'
      + '<div style="display:flex;gap:8px">'
      + '<button class="iconbtn" id="fxNo" aria-label="やめる"><svg><use href="#i-back"/></svg></button>'
      + '<button class="iconbtn ok" id="fxOk" aria-label="これで保存"><svg><use href="#i-check"/></svg></button>'
      + "</div></div>"
      + '<div class="panel-body">'
      + '<div class="cropbox" id="fxBox"><canvas id="fxCv"></canvas></div>'
      + '<div class="fxrow">'
      + '<button class="ghost" id="fxL">↺ 左に90°</button>'
      + '<button class="ghost" id="fxR">↻ 右に90°</button>'
      + "</div>"
      + '<div class="field"><div class="label">切り抜き</div>'
      + '<div class="segs" id="fxCuts">' + cutRow() + "</div></div>"
      + '<div class="field"><div class="label">大きさ</div>'
      + '<input class="zoom" id="fxZoom" type="range" min="100" max="320" value="100" step="1"></div>'
      + '<div class="field"><div class="label">明るさ</div>'
      + '<input class="zoom" id="fxBri" type="range" min="50" max="160" value="100" step="1"></div>'
      + '<div class="field"><div class="label">くっきり</div>'
      + '<input class="zoom" id="fxCon" type="range" min="60" max="180" value="100" step="1"></div>'
      + '<div class="hintline">指でずらすと位置が変わります。2本指でつまむと大きさも。'
      + "ここに見えているとおりに保存されます。</div>"
      + "</div>"
      + '<div class="panel-foot"><button class="ghost" id="fxReset">はじめに戻す</button>'
      + '<span class="saveflag" id="fxSay"></span></div>', "dialog");

    var box = $("fxBox"), cv = $("fxCv");
    function say(t, bad) {
      var e = $("fxSay");
      if (e) { e.textContent = t || ""; e.style.color = bad ? "var(--rec)" : ""; }
    }

    function paintFix() {
      var out = outSize();
      /* 下書きが大きすぎると、回転や明るさの操作が画面の外に出てしまう。
         縦に上限を設けて、写真と操作がいつも一緒に見えるようにする */
      var room = Math.max(160, Math.min(Math.round(window.innerHeight * 0.34), 400));
      box.style.aspectRatio = "auto";
      box.style.marginInline = "auto";
      var W = (box.parentNode ? box.parentNode.clientWidth : 0) || box.clientWidth || 320;
      var H = Math.round(W * out.h / out.w);
      if (H > room) { H = room; W = Math.round(H * out.w / out.h); }
      box.style.width = W + "px";
      box.style.height = H + "px";
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = W + "px"; cv.style.height = H + "px";
      var g = cv.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      clampST(W, H);
      render(g, W, H);
      cv.style.filter = "brightness(" + bri + "%) contrast(" + con + "%)";
      say(out.w + "×" + out.h);
    }

    DB.get("blobs", it.origId || it.blobId).then(function (r) {
      if (!r || !r.blob) throw new Error("元の写真が見つかりませんでした。");
      return decode(r.blob);
    }).then(function (bmp) {
      im = bmp.el || bmp;
      nat = { w: im.width || im.naturalWidth, h: im.height || im.naturalHeight };
      paintFix();
    }).catch(function (e) { say(why(e), true); });

    $("fxNo").onclick = function () { closeSheet(); if (after) after(); };
    $("fxL").onclick = function () { rot = (rot + 270) % 360; st.x = 0; st.y = 0; paintFix(); };
    $("fxR").onclick = function () { rot = (rot + 90) % 360; st.x = 0; st.y = 0; paintFix(); };
    $("fxReset").onclick = function () {
      rot = 0; bri = 100; con = 100; cut = "as"; st = { s: 1, x: 0, y: 0 };
      $("fxZoom").value = 100; $("fxBri").value = 100; $("fxCon").value = 100;
      $("fxCuts").innerHTML = cutRow(); wireCuts();
      paintFix();
    };
    function wireCuts() {
      Array.prototype.forEach.call($("fxCuts").querySelectorAll("[data-cut]"), function (b) {
        b.onclick = function () {
          cut = b.getAttribute("data-cut");
          $("fxCuts").innerHTML = cutRow(); wireCuts();
          paintFix();
        };
      });
    }
    wireCuts();
    $("fxZoom").oninput = function () { st.s = parseInt(this.value, 10) / 100; paintFix(); };
    $("fxBri").oninput = function () { bri = parseInt(this.value, 10); paintFix(); };
    $("fxCon").oninput = function () { con = parseInt(this.value, 10); paintFix(); };

    /* 指で動かす。切り抜きの枠に対する割合で覚える */
    var pts = {}, base = null;
    box.addEventListener("pointerdown", function (e) {
      box.setPointerCapture(e.pointerId);
      pts[e.pointerId] = { x: e.clientX, y: e.clientY }; base = null;
    });
    box.addEventListener("pointermove", function (e) {
      if (!pts[e.pointerId]) return;
      var ids = Object.keys(pts);
      var W = box.clientWidth || 1, H = box.clientHeight || 1;
      if (ids.length === 1) {
        st.x += (e.clientX - pts[e.pointerId].x) / W;
        st.y += (e.clientY - pts[e.pointerId].y) / H;
        pts[e.pointerId] = { x: e.clientX, y: e.clientY };
        paintFix();
      } else if (ids.length >= 2) {
        pts[e.pointerId] = { x: e.clientX, y: e.clientY };
        var a = pts[ids[0]], b = pts[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (base == null) { base = { d: d, s: st.s }; return; }
        st.s = Math.max(1, Math.min(3.2, base.s * (d / base.d)));
        $("fxZoom").value = Math.round(st.s * 100);
        paintFix();
      }
    });
    ["pointerup", "pointercancel"].forEach(function (k) {
      box.addEventListener(k, function (e) { delete pts[e.pointerId]; base = null; });
    });

    $("fxOk").onclick = function () {
      if (!im) return;
      say("書き出しています…");
      var out = outSize();
      function bake(W, H, q) {
        var c = document.createElement("canvas");
        c.width = W; c.height = H;
        var g = c.getContext("2d");
        render(g, W, H);
        tone(g, W, H);
        return new Promise(function (res, rej) {
          c.toBlob(function (b) { b ? res({ blob: b, w: W, h: H }) : rej(new Error("画像を作れませんでした。")); },
                   "image/jpeg", q);
        });
      }
      var tw = out.w >= out.h ? 400 : Math.round(400 * out.w / out.h);
      var th = out.w >= out.h ? Math.round(400 * out.h / out.w) : 400;
      Promise.all([bake(out.w, out.h, photoSize().q), bake(tw, th, 0.72)])
        .then(function (r) { return saveFixed(it, r[0], r[1]); })
        .then(function () { closeSheet(); toast("直しました"); if (after) after(); })
        .catch(function (e) { say(why(e), true); });
    };
  }

  /* 直したものを入れ替える。いちばん最初の1回だけ、元の写真を
     別にとっておく。あとで「元に戻す」ができるように */
  function saveFixed(it, full, thumb) {
    var rows = [];
    var first = !it.origId;
    if (first) {
      it.origId = uid();
      rows.push(["blobs", { id: it.origId, blob: null }]);   /* 下で入れ替える */
    }
    return (first
      ? DB.get("blobs", it.blobId).then(function (r) {
          rows[0] = ["blobs", { id: it.origId, blob: r && r.blob }];
        })
      : Promise.resolve()
    ).then(function () {
      rows.push(["blobs", { id: it.blobId, blob: full.blob }]);
      rows.push(["blobs", { id: it.thumbId, blob: thumb.blob }]);
      it.w = full.w; it.h = full.h;
      it.bytes = full.blob.size + thumb.blob.size;
      it.fixedAt = Date.now();
      rows.push(["items", it]);
      return DB.putMany(rows);
    }).then(function () { return freshenItem(it); });
  }

  /* 中身を差し替えたので、画面が持っている古い見た目を捨てる */
  function freshenItem(it) {
    syncBrowse([it]);
    [it.blobId, it.thumbId].forEach(function (k) {
      if (k && urlCache[k]) { try { URL.revokeObjectURL(urlCache[k]); } catch (e) {} delete urlCache[k]; }
    });
    return ensureUrls([it.blobId, it.thumbId]).then(function () {
      paintStage();
    });
  }

  function unfixItem(it, after) {
    if (!it.origId) return;
    DB.get("blobs", it.origId).then(function (r) {
      if (!r || !r.blob) throw new Error("元の写真が残っていませんでした。");
      return Promise.all([shrink(r.blob, photoSize().edge, photoSize().q), shrink(r.blob, 400, 0.72)])
        .then(function (x) {
          it.w = x[0].w; it.h = x[0].h;
          it.bytes = x[0].blob.size + x[1].blob.size;
          delete it.fixedAt;
          var oid = it.origId; delete it.origId;
          return DB.putMany([
            ["blobs", { id: it.blobId, blob: x[0].blob }],
            ["blobs", { id: it.thumbId, blob: x[1].blob }],
            ["items", it]
          ]).then(function () { return DB.del("blobs", oid).catch(function () {}); });
        });
    }).then(function () {
      return freshenItem(it);
    }).then(function () {
      closeSheet(); toast("元に戻しました"); if (after) after();
    }).catch(function (e) { toast(why(e), true); });
  }

  /* ============================================================
     書き出し
     ============================================================ */
  function notesMarkdown(ex, src) {
    var list = (src || items).slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    var L = [];
    L.push("# " + ex.name);
    var head = [];
    if (ex.cat) head.push(ex.cat);
    if (ex.date) head.push(ex.date);
    if (ex.venue) head.push(ex.venue);
    if (head.length) L.push(head.join(" ／ "));
    if (ex.note) { L.push(""); L.push("> " + ex.note.replace(/\n/g, "\n> ")); }
    L.push("");
    L.push(list.length + " 点（写真 " + list.filter(function (i) { return i.kind === "photo"; }).length
      + " ／ 録音 " + list.filter(function (i) { return i.kind === "audio"; }).length
      + " ／ 動画 " + list.filter(function (i) { return i.kind === "video"; }).length
      + " ／ メモ " + list.filter(function (i) { return i.kind === "text"; }).length
      + " ／ 書類 " + list.filter(function (i) { return i.kind === "file"; }).length + "）");
    L.push("");

    list.forEach(function (it, n) {
      var kindJa = kindName(it.kind);
      var t = new Date(it.createdAt || 0);
      L.push("");
      L.push("## " + pad2(n + 1) + ". " + kindJa
        + "（" + pad2(t.getHours()) + ":" + pad2(t.getMinutes())
        + (it.durMs ? " ・ " + clock(it.durMs) : "") + "）" + (it.fav ? " ★" : "")
        + (it.kind === "file" && it.name ? "\n" + it.name : ""));
      if (it.memo) L.push(it.memo);
      if (it.tags && it.tags.length) L.push((it.tags || []).map(function (x) { return "#" + x; }).join(" "));
    });
    return { text: L.join("\n"), list: list };
  }

  /* exId を渡すと、開いていないフォルダでも書き出せる */
  function exportNotes(exId) {
    var id = exId || curEx;
    if (!id) { toast("先に" + LL() + "を選んでください。", true); return; }
    var ex = exById(id);
    if (!ex) return;

    /* 棚に戻ると items は空になるので、いま開いているときだけ使い回す */
    var live = screen === "folder" && id === curEx;
    (live ? Promise.resolve(items) : DB.byEx(id)).then(function (src) {
      if (!src.length) { toast("書き出すものがまだありません。", true); return; }
      exportSheet(ex, src);
    }).catch(function (e) { toast(why(e), true); });
  }

  /* 共有シートに写真そのものを渡せる端末か。
     ZIPのままだと、インスタなど「画像を受け取る」相手が出てこない */
  function canSharePics() {
    try {
      return !!(navigator.canShare && navigator.share
        && navigator.canShare({ files: [new File([""], "a.jpg", { type: "image/jpeg" })] }));
    } catch (e) { return false; }
  }
  var PICMAX = 20;   /* 渡しすぎると共有シートが開かない端末がある */

  function exportSheet(ex, src, partial) {
    var pics = sortItems(src.filter(function (it) {
      return it.kind === "photo" && it.blobId;
    }));

    sheet('<div class="panel-head"><h3>'
      + (partial ? "選んだ " + src.length + " 件を共有する" : "このフォルダを共有する") + "</h3>"
      + '<button class="iconbtn" id="xClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div>'
      + '<div class="panel-body"><div class="stack">'
      + ((pics.length && canSharePics())
          ? '<button class="rowbtn" id="xPics"><div><b>写真だけ（インスタ・LINEへ）</b>'
            + "<span>写真を1枚ずつ渡します。ZIPだと出てこない相手にも送れます。"
            + (pics.length > PICMAX ? "はじめの " + PICMAX + " 枚" : pics.length + " 枚")
            + "を並び順のまま。</span></div>"
            + '<svg><use href="#i-share"/></svg></button>'
          : "")
      + '<button class="rowbtn" id="xZip"><div><b>写真とメモ（ZIP）</b>'
      + "<span>写真・動画・録音・書類をまとめて、メモも同梱。相手がRawpoを使っていなくても開けます。</span></div>"
      + '<svg><use href="#i-share"/></svg></button>'
      + '<button class="rowbtn" id="xMd"><div><b>メモだけ（Markdown）</b>'
      + "<span>撮った順に並べた文章。原稿を書くときはこれ。</span></div>"
      + '<svg><use href="#i-share"/></svg></button>'
      + '<button class="rowbtn" id="xPack"><div><b>まるごと（Rawpoに読み込める形）</b>'
      + "<span>別の端末のRawpoで「バックアップから戻す」を使うと、このフォルダがそのまま入ります。</span></div>"
      + '<svg><use href="#i-share"/></svg></button>'
      + "</div>"
      + '<div class="hintline" style="margin-top:10px">どれを選んでも、最後に端末の共有シートが開きます。'
      + "<b>メール</b>を選べば、添付された状態で新しいメールが立ち上がります。"
      + "AirDrop・LINE・ファイルアプリも同じところから選べます。</div>"
      + "</div>", "dialog");

    $("xClose").onclick = closeSheet;

    var xp = $("xPics");
    if (xp) xp.onclick = function () {
      var use = pics.slice(0, PICMAX);
      closeSheet();
      progress(5);
      toast("写真を取り出しています…");
      var files = [], i = 0;
      (function next() {
        if (i >= use.length) {
          progress(96);
          if (!files.length) { progress(100); toast("写真を取り出せませんでした。", true); return; }
          navigator.share({ files: files, title: ex.name }).then(function () {
            progress(100);
            toast("送りました（" + files.length + "枚）");
          }).catch(function (e) {
            progress(100);
            if (!e || e.name !== "AbortError") toast(why(e), true);
          });
          return;
        }
        var it = use[i++];
        progress(5 + Math.round((i / use.length) * 88));
        DB.get("blobs", it.blobId).then(function (r) {
          if (r && r.blob) {
            /* 名前は並び順の番号にする。相手の端末で順に並ぶ */
            var nm = pad2(files.length + 1) + "_" + safeName(ex.name) + "." + extOf(it);
            files.push(new File([r.blob], nm, { type: it.mime || r.blob.type || "image/jpeg" }));
          }
        }).catch(function () {}).then(next);
      })();
    };

    $("xPack").onclick = function () {
      closeSheet();
      makeBackup(function (x) { return x.id === ex.id; },
                 function (it) { return it.exId === ex.id; })
        .then(function (zip) {
          return handOver(zip, "v1_" + safeName(ex.name) + "_まるごと.zip").then(function (how) {
            progress(100);
            if (how !== "cancel") toast("送りました（" + mb(zip.size) + "）");
          });
        }).catch(function (e) { progress(100); toast(why(e), true); });
    };

    $("xMd").onclick = function () {
      var md = notesMarkdown(ex, src);
      var nm = "v1_" + safeName(ex.name) + "_メモ.md";
      handOver(new Blob([md.text], { type: "text/markdown" }), nm).then(function (how) {
        closeSheet();
        if (how !== "cancel") toast("書き出しました");
      }).catch(function (e) { toast(why(e), true); });
    };

    $("xZip").onclick = function () {
      var md = notesMarkdown(ex, src);
      closeSheet();
      progress(5);
      toast("まとめています…");
      var entries = [{ name: "メモ.md", u8: new TextEncoder().encode(md.text), date: new Date() }];
      var jobs = [], seen = {};

      var folder = safeName(ex.name);
      md.list.forEach(function (it, n) {
        if (!it.blobId) return;
        var ext = extOf(it);
        var head = (it.memo || "").split("\n")[0].slice(0, 24);
        /* 書類は元のファイル名を残す。相手が中身を推し量れるように */
        var nm = (it.kind === "file" && it.name)
          ? folder + "/" + pad2(n + 1) + "_" + safeName(it.name.replace(/\.[^.]+$/, "")) + "." + ext
          : folder + "/" + pad2(n + 1) + (head ? "_" + safeName(head) : "") + "." + ext;
        while (seen[nm]) nm = nm.replace(/(\.\w+)$/, "_" + Math.floor(Math.random() * 99) + "$1");
        seen[nm] = 1;
        jobs.push({ name: nm, blobId: it.blobId, date: new Date(it.createdAt || Date.now()) });
      });

      var i = 0;
      (function next() {
        if (i >= jobs.length) {
          progress(92);
          try {
            var zip = zipWrite(entries);
            handOver(zip, "v1_" + safeName(ex.name) + "_写真とメモ.zip").then(function (how) {
              progress(100);
              if (how !== "cancel") toast("書き出しました（" + mb(zip.size) + "）");
            }).catch(function (e) { progress(100); toast(why(e), true); });
          } catch (e) { progress(100); toast(why(e), true); }
          return;
        }
        var j = jobs[i++];
        progress(5 + Math.round((i / jobs.length) * 85));
        DB.get("blobs", j.blobId).then(function (r) {
          if (r && r.blob) return r.blob.arrayBuffer().then(function (ab) {
            entries.push({ name: j.name, u8: new Uint8Array(ab), date: j.date });
          });
        }).catch(function () {}).then(next);
      })();
    };
  }


  /* ============================================================
     チームで使う（つなぎの確認）
     ------------------------------------------------------------
     いまは「つながるかどうか」だけを見る画面。
     ここが通らないと先へ進めないので、同期を組む前に
     実機で確かめられるようにしてある。
     ============================================================ */
  /* この端末の呼び名。アップロードしたものを見分けるために使う */
  function deviceName() {
    var n = (recall("devname") || "").trim();
    if (n) return n;
    var u = navigator.userAgent || "";
    if (/iPhone/.test(u)) return "iPhone";
    if (/iPad/.test(u)) return "iPad";
    if (/Android/.test(u)) return "Android";
    if (/Macintosh|Mac OS/.test(u)) return "Mac";
    if (/Windows/.test(u)) return "Windows";
    return "この端末";
  }
  function bundleName(dev) { return "Rawpo_まるごと_" + safeName(dev || deviceName()) + ".zip"; }

  /* ドライブにアップロードする。端末ごとに1つだけ置き、押すたびに入れ替える */
  function pushAll(after) {
    var room = null;
    toast("ドライブに接続しています…");
    Shelf.root().then(function (id) {
      room = id;
      return makeBackup(null, null);
    }).then(function (zip) {
      progress(92);
      toast("保存しています…（" + mb(zip.size) + "）");
      return Shelf.save(room, bundleName(), zip).then(function () { return zip; });
    }).then(function (zip) {
      progress(100);
      remember("pushedAt", String(Date.now()));
      toast("保存しました（" + mb(zip.size) + "）");
      if (after) after();
    }).catch(function (e) { progress(100); toast(why(e), true); });
  }

  /* ============================================================
     変わったものだけ送る（自動でそろえる・第2段階）
     ------------------------------------------------------------
     まるごとZIPは「セーブデータ」として残し、こちらを普段づかいにする。
     ドライブの中はこうなる。

       Rawpo/
         Rawpo_まるごと_端末名.zip   ← 手で作るセーブデータ
         同期/
           端末の札.json             ← その端末が知っていること（記録だけ）
           中身/
             blobの番号              ← 写真・録音・書類の実体。1件1ファイル

     記録は軽いので毎回まるごと置き替える。重いのは写真で、
     こちらは一度上げたら中身が変わらないから、
     ドライブに無いものだけを上げる。これが「変わったものだけ」の中身。

     端末ごとに別のファイルに書くので、二台が同時に送ってもぶつからない。
     突き合わせは、降ろすとき（第3段階）にやる。
     ============================================================ */
  /* 自動で走っているときは、途中経過を出さない。
     何もしていないのに画面がしゃべり出すと落ち着かない。
     ただし、うまくいかなかったときだけは必ず出す */
  var quietSync = false, syncing = false;
  /* いま何をしているか。押しても何も起きないように見えるのを防ぐため、
     走っている最中でも、そのときの様子を言えるようにしておく */
  var syncSince = 0, syncStep = "";
  function step(t) { syncStep = t; stoast(t); }
  function stoast(t, bad) { if (bad || !quietSync) toast(t, bad); }

  /* まだ送っていないものがあるか。書き込みのたびに立つ */
  var unsent = false, touchTimer = null;
  function touched() {
    unsent = true;
    if (!Shelf.linked() || !autoSyncOn()) return;
    /* 連打のたびに通信しない。手が止まってから送る */
    clearTimeout(touchTimer);
    touchTimer = setTimeout(function () { maybeSync(); }, 20000);
  }

  var syncRooms = null;   /* 置き場の番号。一度引いたら使い回す */

  /* 「ここまで送った」「ここまで読んだ」の控えを全部忘れる。
     置き場が変わったときに呼ぶ。新しい置き場には何も無いので、
     控えを信じると、送ったつもりのものが誰にも届かない */
  function forgetSync() {
    remember("sentUpTo", "0");
    remember("sentAt", "");
    /* 新しい置き場には写真も無い。上げ終わった印も捨てる */
    remember("sentAll", "");
    remember("sweptAt", "0");
    try {
      var kill = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("expo.seen:") === 0) kill.push(k);
      }
      kill.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
  }
  function placeChanged() {
    syncRooms = null;
    forgetSync();
  }
  /* 同じ名前のフォルダが二つできてしまっていることがある。
     書くのはいちばん古い一つだけ。読むときは全部見る。
     片方に取り残されたものが、ずっと見えないままにならないように */
  function roomsOf(parentId, name) {
    return Shelf.rooms(parentId, name).then(function (ids) {
      if (ids.length) return ids;
      return Shelf.room(parentId, name).then(function (id) { return [id]; });
    });
  }
  function syncPlace() {
    if (syncRooms) return Promise.resolve(syncRooms);
    return Shelf.root().then(function (root) {
      return roomsOf(root, "同期").then(function (syncs) {
        /* 「中身」は、どの「同期」の下にもあり得る */
        return Promise.all(syncs.map(function (s) { return Shelf.rooms(s, "中身"); })).then(function (lists) {
          var parts = [];
          lists.forEach(function (l) { l.forEach(function (id) { parts.push(id); }); });
          if (parts.length) return parts;
          return Shelf.room(syncs[0], "中身").then(function (id) { return [id]; });
        }).then(function (parts) {
          syncRooms = { root: root, sync: syncs[0], parts: parts[0],
                        syncs: syncs, partsAll: parts };
          return syncRooms;
        });
      });
    });
  }
  function myIndexName() { return devId() + ".json"; }

  /* 置き場を調べる。片方だけそろわないときに、二台が同じところを
     見ているのかどうかを、その場で確かめられるようにしておく。
     ここが食い違っていれば、原因はまず置き場 */
  function probePlace() {
    var out = { roots: 0, root: "", rooms: 1, bins: 1, parts: 0, devs: [] };
    return hush(function () {
      return Shelf.roots().then(function (files) {
        out.roots = files.length;
        return syncPlace();
      }).then(function (p) {
        out.root = p.root;
        out.rooms = p.syncs.length;
        out.bins = p.partsAll.length;
        return Shelf.listMany(p.syncs).then(function (rows) {
          out.devs = rows.filter(function (f) { return /\.json$/.test(f.name); })
            .map(function (f) {
              return { dev: f.name.replace(/\.json$/, ""), at: f.at, size: f.size };
            }).sort(function (a, b) { return b.at - a.at; });
          return Shelf.listMany(p.partsAll);
        });
      }).then(function (rows) {
        out.parts = rows.length;
        return out;
      });
    });
  }

  /* 端末の番号と呼び名の対応。受け取ったときに書き足していく。
     ドライブのファイル名は番号なので、これが無いと誰のものか分からない */
  function devNames() {
    try { return JSON.parse(recall("devnames") || "{}") || {}; } catch (e) { return {}; }
  }
  function noteDevName(id, name) {
    if (!id || !name) return;
    var m = devNames();
    if (m[id] === name) return;
    m[id] = name;
    try { remember("devnames", JSON.stringify(m)); } catch (e) {}
  }

  /* いまログインしている端末。ドライブに置かれた記録から数える。
     ここに出てこない端末は、まだログインしていない */
  function devicesOnDrive() {
    return hush(function () {
      return syncPlace().then(function (p) { return Shelf.listMany(p.syncs); });
    }).then(function (rows) {
      var me = myIndexName(), names = devNames();
      return rows.filter(function (f) { return /\.json$/.test(f.name); })
        .map(function (f) {
          var id = f.name.replace(/\.json$/, "");
          return { id: id, mine: f.name === me, at: f.at,
                   name: f.name === me ? deviceName() : (names[id] || "別の端末") };
        })
        .sort(function (a, b) { return (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || b.at - a.at; });
    });
  }

  /* この端末が持っている記録。写真そのものは入らない */
  function myRecords() {
    return Promise.all([DB.all("exhibitions"), DB.all("items"),
      DB.all("templates"), DB.all("boards"), DB.all("gone")]).then(function (r) {
      return { exhibitions: r[0] || [], items: r[1] || [], templates: r[2] || [],
               boards: r[3] || [], gone: r[4] || [] };
    });
  }

  /* いちばん新しい更新時刻。前に送ったときと同じなら、送るものは無い */
  function newestAt(rec) {
    var m = 0;
    ["exhibitions", "items", "templates", "boards", "gone"].forEach(function (k) {
      (rec[k] || []).forEach(function (x) { if (Number(x.upAt) > m) m = Number(x.upAt); });
    });
    return m;
  }

  /* 記録が指している、写真・録音・書類の番号 */
  function partIds(items) {
    var seen = {}, out = [];
    (items || []).forEach(function (it) {
      [it.blobId, it.thumbId, it.origId].forEach(function (id) {
        if (id && !seen[id]) { seen[id] = 1; out.push(id); }
      });
    });
    return out;
  }

  /* 写真まで含めて、ぜんぶ向こうに在ると分かった印。
     次に開いたとき、置き場を数えにいかずに済ませるために控える */
  function allSent(rec) {
    remember("sentAll", String(newestAt(rec)));
    remember("sweptAt", String(Date.now()));
  }
  /* 念のため数え直す間隔。誰かがドライブから手で消していても、
     ここで気づける */
  var SWEEP_GAP = 24 * 60 * 60 * 1000;

  function sendChanges() {
    var place = null, rec = null, need = [], sent = 0, changed = false;
    progress(4);
    step("ドライブに接続しています…");
    return syncPlace().then(function (p) {
      place = p;
      return myRecords();
    }).then(function (r) {
      rec = r;
      var now = newestAt(rec);
      changed = now > Number(recall("sentUpTo") || 0);
      /* 前に「ぜんぶ上げ終わった」と分かっていて、そこから何も
         変えていないなら、写真置き場を数えにいく必要すらない。
         開くたびに何百件もの一覧を引かないで済む */
      if (!changed && recall("sentAll") === String(now)
          && Date.now() - Number(recall("sweptAt") || 0) < SWEEP_GAP) {
        return "skip";
      }
      progress(8);
      return Shelf.listMany(place.partsAll);
    }).then(function (rows) {
      if (rows === "skip") return "same";
      var there = {};
      rows.forEach(function (f) { there[f.name] = 1; });
      need = partIds(rec.items).filter(function (id) { return !there[id]; });
      if (!changed && !need.length) { allSent(rec); return "same"; }

      /* 記録を先に置き、写真はあとから送る。
         写真が何十枚もあると送り終わるまでに何分もかかる。
         先に写真を送っていたせいで、途中で画面を閉じたり通信が切れたりすると
         記録が一度も置かれず、ほかの端末からはこの端末が
         「まだログインしていない」ように見えていた。
         記録だけなら数十キロなので、まず確実に置いてしまう */
      progress(12);
      step("記録を送っています…");
      var body = JSON.stringify({
        v: 1, dev: devId(), name: deviceName(), at: Date.now(),
        exhibitions: rec.exhibitions, items: rec.items,
        templates: rec.templates, boards: rec.boards, gone: rec.gone
      });
      return Shelf.save(place.sync, myIndexName(),
        new Blob([body], { type: "application/json" })).then(function () {
        remember("sentAt", String(Date.now()));
        remember("sentUpTo", String(newestAt(rec)));
        if (!need.length) { allSent(rec); return null; }
        step("写真を送っています…（" + need.length + "件）");
        var i = 0;
        return (function next() {
          if (i >= need.length) return Promise.resolve(null);
          var id = need[i++];
          progress(16 + Math.round((i / need.length) * 30));
          /* 何枚目かを控える。押したときに「止まっていない」と言えるように */
          syncStep = "写真を送っています…（" + i + " / " + need.length + "件）";
          return DB.get("blobs", id).then(function (b) {
            if (!b || !b.blob) return null;
            return Shelf.put(place.parts, id, b.blob).then(function () { sent++; });
          }).catch(function () { return null; }).then(next);
        })().then(function () {
          /* 1枚も取りこぼさずに上げ切ったときだけ、印をつける。
             落ちた分があるなら、次もちゃんと数え直す */
          if (sent === need.length) allSent(rec);
        });
      });
    }).then(function (how) {
      if (how === "same") return { same: true, sent: 0 };
      return { same: false, sent: sent };
    });
  }

  /* ============================================================
     向こうの変わりを降ろす（第3段階）と、消えたものを合わせる（第4段階）
     ------------------------------------------------------------
     突き合わせの決まりは二つだけ。

       ・同じものが両方にあるなら、あとで触ったほうを採る
       ・「消した」という記録が、その記録より新しければ、消えたままにする

     逆に、消したあとに別の端末で直してあれば、そちらが新しいので残る。
     どちらも時刻の比べ合いなので、迷うところがない。
     ============================================================ */
  var SYNCED = ["exhibitions", "items", "templates", "boards"];

  /* 画面の持ちものを、いまのデータベースから作り直す */
  function reloadAll() {
    curEx = null; screen = "shelf"; curCat = "all";
    return Promise.all([DB.all("exhibitions"), DB.all("templates"), DB.all("boards")]).then(function (r) {
      exs = r[0].sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
      takeTemplates(r[1]);
      boards = r[2] || [];
      remember("ex", "");
      return DB.all("items");
    }).then(function (all) { browseAll = all; }, function () { browseAll = []; })
      .then(function () { return goShelf(); });
  }

  /* 届いた記録を、いまの中身に合わせる。写真の取り寄せまでやる */
  function applyIndexes(list, place) {
    var out = { add: 0, upd: 0, del: 0, got: 0, miss: 0 };
    var mine = {}, kept = null, lost = [];
    return myRecords().then(function (here) {
      SYNCED.forEach(function (st) {
        mine[st] = {};
        (here[st] || []).forEach(function (r) { mine[st][r.id] = r; });
      });

      /* 「消した」は、こちらとあちらで新しいほうを残す */
      var tomb = {};
      function noteTomb(g) {
        if (!g || !g.store || !g.rid) return;
        var k = g.store + "/" + g.rid;
        if (!tomb[k] || Number(g.upAt) > Number(tomb[k].upAt)) tomb[k] = g;
      }
      (here.gone || []).forEach(noteTomb);
      list.forEach(function (ix) { (ix.gone || []).forEach(noteTomb); });

      var puts = [], kills = [], tombs = [];

      /* 1. 向こうにしか無いもの、向こうのほうが新しいものを採る */
      list.forEach(function (ix) {
        SYNCED.forEach(function (st) {
          (ix[st] || []).forEach(function (r) {
            if (!r || !r.id) return;
            var t = tomb[st + "/" + r.id];
            /* 消したあとの古い記録は、戻さない */
            if (t && Number(t.upAt) >= Number(r.upAt || 0)) return;
            var cur = mine[st][r.id];
            if (!cur) { mine[st][r.id] = r; puts.push([st, r]); out.add++; return; }
            if (Number(r.upAt || 0) > Number(cur.upAt || 0)) {
              mine[st][r.id] = r; puts.push([st, r]); out.upd++;
            }
          });
        });
      });

      /* 2. 向こうで消されたものを、こちらでも消す */
      Object.keys(tomb).forEach(function (k) {
        var g = tomb[k];
        tombs.push(g);
        var cur = mine[g.store] && mine[g.store][g.rid];
        if (!cur) return;
        /* 消したあとに直してあれば、そちらが新しいので残す */
        if (Number(g.upAt) <= Number(cur.upAt || 0)) return;
        kills.push([g.store, g.rid]);
        if (g.store === "items") lost.push(cur);
        delete mine[g.store][g.rid];
        out.del++;
      });

      kept = Object.keys(mine.items).map(function (k) { return mine.items[k]; });
      progress(70);
      return DB.putManyRaw(puts.concat(tombs.map(function (g) { return ["gone", g]; })))
        .then(function () { return kills.length ? DB.dropRaw(kills, []) : null; });
    }).then(function () {
      /* 消えたものだけが指していた写真は、置いておいても使い道がない。
         ほかの記録がまだ指しているものは残す */
      if (!lost.length) return null;
      var alive = {};
      partIds(kept).forEach(function (id) { alive[id] = 1; });
      var drop = partIds(lost).filter(function (id) { return !alive[id]; })
        .map(function (id) { return ["blobs", id]; });
      return drop.length ? DB.dropRaw(drop, []) : null;
    }).then(function () {
      progress(74);
      /* 3. 足りない写真・録音・書類を取り寄せる */
      var want = partIds(kept);
      return DB.keys("blobs").then(function (have) {
        var box = {};
        have.forEach(function (k) { box[k] = 1; });
        return want.filter(function (id) { return !box[id]; });
      });
    }).then(function (need) {
      if (!need.length) return null;
      step("写真を取り寄せています…（" + need.length + "件）");
      /* 名前から番号を引けるようにしておく。1件ずつ探すと何度も往復する */
      var type = {};
      kept.forEach(function (it) {
        if (it.blobId) type[it.blobId] = it.mime || "application/octet-stream";
        if (it.thumbId) type[it.thumbId] = "image/jpeg";
        if (it.origId) type[it.origId] = it.mime || "application/octet-stream";
      });
      return Shelf.listMany(place.partsAll).then(function (rows) {
        var at = {};
        rows.forEach(function (f) { at[f.name] = f.fileId; });
        var i = 0;
        return (function next() {
          if (i >= need.length) return Promise.resolve(null);
          var id = need[i++];
          progress(74 + Math.round((i / need.length) * 22));
          syncStep = "写真を取り寄せています…（" + i + " / " + need.length + "件）";
          /* 向こうがまだ写真を上げ終わっていないことがある。
             数えておいて、あとでもう一度降ろしにくる */
          if (!at[id]) { out.miss++; return Promise.resolve().then(next); }
          return Shelf.get(at[id]).then(function (b) {
            return DB.putRaw("blobs", { id: id, blob: new Blob([b], { type: type[id] || b.type }) });
          }).then(function () { out.got++; })
            .catch(function () { out.miss++; }).then(next);
        })();
      });
    }).then(function () {
      return out;
    });
  }

  function takeChanges() {
    var place = null, mine = myIndexName(), fresh = [];
    progress(50);
    return syncPlace().then(function (p) {
      place = p;
      return Shelf.listMany(p.syncs);
    }).then(function (rows) {
      var others = rows.filter(function (f) {
        if (!/\.json$/.test(f.name) || f.name === mine) return false;
        /* 前に見たときから変わっていなければ、降ろす必要がない。
           見張りを増やしても通信が増えないのは、これのおかげ */
        return f.at > Number(recall("seen:" + f.name) || 0);
      });
      if (!others.length) return null;
      fresh = others;
      progress(56);
      step("ほかの端末の記録を読んでいます…（" + others.length + "台）");
      var box = [], i = 0;
      return (function next() {
        if (i >= others.length) return Promise.resolve(box);
        var f = others[i++];
        progress(56 + Math.round((i / others.length) * 10));
        return Shelf.get(f.fileId).then(function (b) { return b.text(); })
          .then(function (t) {
            try {
              var ix = JSON.parse(t);
              box.push(ix);
              noteDevName(ix.dev, ix.name);
            } catch (e) {}
          })
          .catch(function () {}).then(next);
      })();
    }).then(function (box) {
      if (!box || !box.length) return "none";
      return applyIndexes(box, place);
    }).then(function (out) {
      if (out === "none") return { none: true, add: 0, upd: 0, del: 0, got: 0, miss: 0 };
      remember("tookAt", String(Date.now()));
      /* ここまで無事に済んでから控える。途中で切れたら、次にまた降ろす。
         写真が1枚でも取り寄せられていないときは控えない。
         控えてしまうと「変わっていない」と見なして二度と降ろしにいかず、
         その写真はずっと出てこないままになる */
      if (!out.miss) fresh.forEach(function (f) { remember("seen:" + f.name, String(f.at)); });
      return reloadAll().then(function () { return out; });
    });
  }

  /* 送ってから受け取る。順番が逆だと、こちらの新しい分が
     向こうの古い記録で上書きされたように見えてしまう。
     終わったあとの知らせは、送りと受けをまとめて1つにする。
     別々に出すと、最後の1つしか目に入らない */
  function syncNow(after, quiet) {
    /* すでに走っているときに押されたら、黙って帰らない。
       写真の初回送信は何分もかかるので、ここで何も言わないと
       「ボタンが反応しない」ように見える。
       長く居座っているときだけは、作り直して押し直せるようにする */
    if (syncing) {
      if (Date.now() - syncSince < 10 * 60 * 1000) {
        if (!quiet) {
          /* 押した人には、終わったときの知らせも見せる */
          quietSync = false;
          busyMark();
          toast(syncStep ? ("いま同期しています。" + syncStep) : "いま同期しています…");
        }
        return;
      }
      /* 10分以上戻ってこない。途中で見失ったものとして、やり直す */
      syncing = false;
    }
    syncing = true;
    syncSince = Date.now();
    syncStep = "";
    quietSync = !!quiet;
    busyMark();
    var up = null;
    function fell(e) {
      progress(100);
      syncing = false; quietSync = false; syncStep = "";
      busyMark();
      toast(why(e), true);
    }
    try {
    sendChanges().then(function (a) {
      up = a;
      return takeChanges();
    }).then(function (down) {
      progress(100);
      remember("syncAt", String(Date.now()));
      var said = [];
      if (up.sent) said.push("写真 " + up.sent + "件を送りました");
      else if (!up.same) said.push("記録を送りました");
      if (down.add) said.push("新しく " + down.add + "件");
      if (down.upd) said.push("直し " + down.upd + "件");
      if (down.del) said.push("消し " + down.del + "件");
      if (down.got) said.push("写真 " + down.got + "件を受け取りました");
      if (down.miss) said.push("写真 " + down.miss + "件はまだ向こうが送り終わっていません");
      /* 裏で5分おきに回っているときは、何か増えたときだけ知らせる。
         自分の記録を置き直しただけで毎回しゃべられると、うるさい */
      var worth = up.sent || down.add || down.upd || down.del || down.got;
      if (!quietSync) toast(said.length ? ("同期しました（" + said.join(" ・ ") + "）") : "変わったものはありませんでした");
      else if (worth) toast("同期しました（" + said.join(" ・ ") + "）");
      unsent = false;
      syncing = false; quietSync = false; syncStep = "";
      busyMark();
      if (after) after();
    }).catch(fell);
    } catch (e) {
      /* 走り出す前に転んだとき。ここで札を戻さないと、
         二度と押せない体になってしまう */
      fell(e);
    }
  }

  /* 押さなくても合っている、が目当てなので、開いたときと、
     ほかのことをして戻ってきたときに、そっと走らせる。
     立て続けに動かないよう、前からしばらく空いているときだけ */
  var AUTO_GAP = 5 * 60 * 1000;
  var autoTimer = null;
  /* 開きっぱなしのパソコンは、戻ってくることがないので
     「戻ってきたとき」の合図が一度も来ない。時計でも見にいく */
  function watchSync() {
    clearInterval(autoTimer);
    autoTimer = setInterval(function () {
      /* 隠れている間は見にいかない。見ていない画面を直しても仕方がない */
      if (!document.hidden) maybeSync(true);
    }, AUTO_GAP);
  }
  function autoSyncOn() { return recall("autosync") !== "0"; }
  /* now を立てると、間が空いていなくても走らせる。
     時計からの呼び出しは、すでに間隔そのものなので待たせない */
  function maybeSync(now) {
    if (syncing || !Shelf.linked() || !autoSyncOn()) return;
    /* まだ送っていないものがあるときは、間を空けずに走らせる。
       撮ったものがいつまでも向こうに出てこないと、同期の意味がない */
    if (!now && !unsent && Date.now() - Number(recall("syncAt") || 0) < AUTO_GAP) return;
    syncNow(null, true);
  }

  /* ドライブにあるものの一覧 */
  function listBundles() {
    return Shelf.root().then(function (id) {
      return Shelf.list(id).then(function (rows) {
        return rows.filter(function (r) { return /^Rawpo_まるごと_.*\.zip$/.test(r.name); })
          .sort(function (a, b) { return b.at - a.at; });
      });
    });
  }

  /* ダウンロードして取り込む。いまあるものを消さず、足して合わせる */
  function pullOne(row, after) {
    progress(5);
    toast("ダウンロードしています…");
    Shelf.get(row.fileId).then(function (blob) {
      progress(40);
      return restore(new File([blob], row.name, { type: "application/zip" }));
    }).then(function () {
      remember("pulledAt", String(Date.now()));
      if (after) after();
    }).catch(function (e) { progress(100); toast(why(e), true); });
  }

  function whenTxt(ms) {
    if (!ms) return "まだありません";
    var d = new Date(Number(ms));
    return d.getFullYear() + "/" + pad2(d.getMonth() + 1) + "/" + pad2(d.getDate())
      + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  var syncWatch = null;
  function teamSheet() {
    function paintTeam() {
      var on = Shelf.linked();
      var body = on
        ? '<div class="meblock">'
            + '<button class="mebig' + (SKIN.me ? " pic" : "") + '" id="tmFace"'
            + ' aria-label="アイコンの絵を選ぶ"'
            + (SKIN.me ? " style=\"background-image:url('" + SKIN.me + "')\"" : "") + ">"
            + (SKIN.me ? "" : esc(meLetter()))
            + '<span class="meplus"><svg><use href="#i-plus"/></svg></span></button>'
            + '<div class="mewho"><b>ログイン中</b><span>'
            + (Shelf.who() ? esc(Shelf.who()) : "このGoogleアカウント") + "</span></div>"
          + "</div>"
          + (SKIN.me ? '<button class="ghost" id="tmFaceOff" style="width:100%">アイコンの絵をやめて、頭文字に戻す</button>' : "")
          + '<div class="field"><label class="label" for="tmDev">この端末の呼び名</label>'
          + '<input class="inp" id="tmDev" value="' + esc(deviceName()) + '">'
          + '<div class="hintline">送ったものを見分けるための名前です。端末ごとに1つ保管します</div></div>'
          + '<button class="rowbtn' + (syncing ? " working" : "") + '" id="tmSync"><div><b>いますぐ同期</b>'
          + '<span id="tmSyncSay">' + (syncing
              ? esc(syncStep || "いま同期しています…")
              : "変わったものを送り、ほかの端末の変わりを受け取ります。"
                + "写真は一度送れば二度は送りません。"
                + "最後に同期したのは " + whenTxt(recall("syncAt"))) + "</span></div>"
          + '<svg><use href="#i-sync"/></svg></button>'
          + '<label class="rowbtn" for="tmAuto" style="cursor:pointer"><div><b>開いたときに自動で同期</b>'
          + "<span>ほかのことをして戻ってきたときも、そっと合わせます</span></div>"
          + '<input type="checkbox" id="tmAuto"' + (recall("autosync") === "0" ? "" : " checked") + "></label>"
          + '<div class="label" style="margin-top:10px">ログインしている端末</div>'
          + '<div id="tmWho"><div class="saveflag">調べています…</div></div>'
          + '<div class="label" style="margin-top:10px">セーブデータ</div>'
          + '<button class="rowbtn" id="tmPush"><div><b>まるごと保存</b>'
          + "<span>いまのフォルダ・写真・メモをひとまとめに。前の保存と入れ替わります。"
          + "最後に保存したのは " + whenTxt(recall("pushedAt")) + "</span></div>"
          + '<svg><use href="#i-up"/></svg></button>'
          + '<button class="rowbtn" id="tmPull"><div><b>保存から戻す</b>'
          + "<span>保存したところまで戻します。いまの中身は消えません</span></div>"
          + '<svg><use href="#i-out"/></svg></button>'
          + '<div id="tmList"></div>'
          + '<button class="rowbtn" id="tmTest"><div><b>やりとりできるか試す</b>'
          + "<span>置き場所を1つ作って、すぐ消します。写真は送りません</span></div>"
          + '<svg><use href="#i-share"/></svg></button>'
          + '<button class="rowbtn" id="tmProbe"><div><b>置き場を調べる</b>'
          + "<span>ドライブのどこを見ているか、何が置かれているかを出します。"
          + "片方の端末だけそろわないときに、二台で見比べてください</span></div>"
          + '<svg><use href="#i-help"/></svg></button>'
          + '<div id="tmProbeOut"></div>'
          + '<button class="danger" id="tmOff">ログアウト</button>'
        : '<button class="rowbtn" id="tmOn"><div><b>Googleでログイン</b>'
          + "<span>この端末を、ほかの端末と同じ中身にします。"
          + "別の端末で使っていたフォルダは、ログインすれば出てきます</span></div>"
          + '<svg><use href="#i-sync"/></svg></button>';

      sheet('<div class="panel-head"><h3>アカウント</h3>'
        + '<button class="iconbtn" id="tmClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div>'
        + '<div class="panel-body"><div class="stack">'
        + '<div class="hintline">使う端末それぞれで<b>同じGoogleアカウントにログイン</b>すると、中身がそろいます。'
        + "置き場所は<b>あなた自身のGoogleドライブ</b>です。写真がRawpoのサーバーを通ることはありません。</div>"
        + body
        + '<div class="saveflag" id="tmSay"></div>'
        + '<div class="hintline">いまは<b>お試しの段階</b>です。使えるのは、Google側に登録した人だけ。'
        + "一緒に使いたい人が決まったら、その人のGmailを登録してください。</div>"
        + "</div></div>"
        + '<div class="panel-foot"><span class="label">送っていないものは、これまで通りこの端末の中だけにあります</span></div>', "dialog");

      $("tmClose").onclick = closeSheet;
      var say = function (t, bad) {
        var e = $("tmSay");
        if (e) { e.textContent = t; e.style.color = bad ? "var(--rec)" : ""; }
      };

      var on1 = $("tmOn");
      if (on1) on1.onclick = function () {
        say("Googleの画面を開いています…");
        Shelf.link().then(function () {
          toast("ログインしました");
          paintMe();
          paintTeam();
        }).catch(function (e) { say(why(e), true); });
      };

      var fc = $("tmFace");
      if (fc) fc.onclick = function () { pickSkin("me"); };
      var fo = $("tmFaceOff");
      if (fo) fo.onclick = function () { clearSkin("me"); };

      var dev = $("tmDev");
      if (dev) dev.onchange = function () {
        remember("devname", this.value.trim());
        toast("この端末は「" + deviceName() + "」として送ります");
      };

      var sy = $("tmSync");
      if (sy) sy.onclick = function () {
        if (dev) remember("devname", dev.value.trim());
        syncNow(function () { teamSheet(); });
      };

      /* 走っている間は、この行に様子を出し続ける。
         初回は写真が何十枚もあって何分もかかるので、
         止まっていないことが見えないと、押し直したくなる */
      clearInterval(syncWatch);
      syncWatch = setInterval(function () {
        var e = $("tmSyncSay");
        if (!e) { clearInterval(syncWatch); syncWatch = null; return; }
        var row = $("tmSync");
        if (syncing) {
          e.textContent = syncStep || "いま同期しています…";
          if (row) row.classList.add("working");
          return;
        }
        if (row) row.classList.remove("working");
        e.textContent = "変わったものを送り、ほかの端末の変わりを受け取ります。"
          + "写真は一度送れば二度は送りません。"
          + "最後に同期したのは " + whenTxt(recall("syncAt"));
      }, 1200);

      /* ここに出てこない端末は、まだログインしていない。
         「片方だけ出てこない」はたいていこれ */
      var who = $("tmWho");
      if (who) devicesOnDrive().then(function (list) {
        if (!$("tmWho")) return;
        if (!list.length) {
          $("tmWho").innerHTML = '<div class="hintline">まだ記録がありません。'
            + "下の「いますぐ同期」を一度押してください。</div>";
          return;
        }
        $("tmWho").innerHTML = list.map(function (d) {
          return '<div class="devrow"><b>' + esc(d.name) + (d.mine ? "（この端末）" : "") + "</b>"
            + "<span>" + whenTxt(d.at) + " に送信</span></div>";
        }).join("")
          + (list.length < 2
              ? '<div class="hintline">ほかの端末はまだログインしていません。'
                + "その端末でも、画面の<b>下の右端にある丸</b>から同じGoogleアカウントにログインしてください。</div>"
              : "");
      }).catch(function (e) {
        if ($("tmWho")) $("tmWho").innerHTML = '<div class="saveflag" style="color:var(--rec)">' + esc(why(e)) + "</div>";
      });

      var au = $("tmAuto");
      if (au) au.onchange = function () {
        remember("autosync", this.checked ? "1" : "0");
        toast(this.checked ? "自動で同期します" : "自動の同期をやめました");
      };

      var push = $("tmPush");
      if (push) push.onclick = function () {
        if (dev) remember("devname", dev.value.trim());
        /* ひと押しで何メガも送るので、先に行き先と大きさを伝える */
        var size = (browseAll || []).reduce(function (a, b) { return a + (b.bytes || 0); }, 0);
        askYesNo({
          title: "まるごと保存",
          body: "いまのフォルダ・写真・メモをひとつにまとめて、"
            + "あなた自身のGoogleドライブの「Rawpo」フォルダに置きます。"
            + "名前は Rawpo_まるごと_" + deviceName() + ".zip です。"
            + (size ? "だいたい " + mb(size) + " を送ります。" : "")
            + "前の保存と入れ替わるので、ドライブの中が増えていくことはありません。",
          ok: "保存する",
          safe: true
        }, function () { pushAll(function () { teamSheet(); }); });
      };

      var pull = $("tmPull");
      if (pull) pull.onclick = function () {
        var box = $("tmList");
        if (!box) return;
        box.innerHTML = '<div class="saveflag">探しています…</div>';
        listBundles().then(function (rows) {
          if (!rows.length) {
            box.innerHTML = '<div class="hintline">まだ保存がありません。'
              + "「まるごと保存」を押してから、もう一度ここを見てください。</div>";
            return;
          }
          box.innerHTML = '<div class="label" style="margin-top:6px">ドライブにある保存</div>'
            + rows.map(function (r, i) {
              var who = r.name.replace(/^Rawpo_まるごと_/, "").replace(/\.zip$/, "");
              return '<button class="rowbtn" data-pull="' + i + '"><div><b>' + esc(who) + "</b>"
                + "<span>" + whenTxt(r.at) + " ・ " + mb(r.size) + "</span></div>"
                + '<svg><use href="#i-out"/></svg></button>';
            }).join("");
          Array.prototype.forEach.call(box.querySelectorAll("[data-pull]"), function (b) {
            b.onclick = function () {
              var r = rows[Number(b.getAttribute("data-pull"))];
              askYesNo({
                title: "「" + r.name.replace(/^Rawpo_まるごと_/, "").replace(/\.zip$/, "") + "」から戻す",
                body: "いまこの端末にあるものは消えません。足りないものだけが足されます。"
                  + "同じものが両方にあるときは、ドライブにあるほうで上書きされます。",
                ok: "戻す"
              }, function () { pullOne(r, function () { teamSheet(); }); });
            };
          });
        }).catch(function (e) { box.innerHTML = '<div class="saveflag" style="color:var(--rec)">' + esc(why(e)) + "</div>"; });
      };

      var pb = $("tmProbe");
      if (pb) pb.onclick = function () {
        var box = $("tmProbeOut");
        if (!box) return;
        box.innerHTML = '<div class="saveflag">調べています…</div>';
        probePlace().then(function (r) {
          if (!$("tmProbeOut")) return;
          var names = devNames();
          $("tmProbeOut").innerHTML = '<div class="qabody" style="margin-top:6px">'
            + "<p>この端末の札：<b>" + esc(devId()) + "</b>（" + esc(deviceName()) + "）</p>"
            + "<p>アカウント：<b>" + esc(Shelf.who() || "不明") + "</b></p>"
            + "<p>「Rawpo」フォルダの数：<b>" + r.roots + "</b>"
            + (r.roots > 1 ? "　← 二つ以上あります。いちばん古いほうを使います" : "")
            + "</p>"
            + "<p>使っているフォルダ：<b>" + esc(String(r.root).slice(0, 8)) + "…</b></p>"
            + "<p>「同期」フォルダの数：<b>" + r.rooms + "</b>"
            + "　／　「中身」フォルダの数：<b>" + r.bins + "</b>"
            + (r.rooms > 1 || r.bins > 1 ? "　← 重なっていますが、両方から読んでいます" : "")
            + "</p>"
            + "<p>置かれている記録：<b>" + r.devs.length + "台</b></p>"
            + (r.devs.length
                ? "<ul>" + r.devs.map(function (d) {
                    return "<li>" + esc(names[d.dev] || (d.dev === devId() ? deviceName() : "別の端末"))
                      + "（" + esc(d.dev) + "）・" + whenTxt(d.at) + "・" + mb(d.size) + "</li>";
                  }).join("") + "</ul>"
                : "")
            + "<p>置かれている写真の数：<b>" + r.parts + "</b></p>"
            + "</div>";
        }).catch(function (e) {
          if ($("tmProbeOut")) $("tmProbeOut").innerHTML =
            '<div class="saveflag" style="color:var(--rec)">' + esc(why(e)) + "</div>";
        });
      };

      var off = $("tmOff");
      if (off) off.onclick = function () {
        Shelf.unlink().then(function () { toast("ログアウトしました"); paintMe(); paintTeam(); });
      };

      var t = $("tmTest");
      if (t) t.onclick = function () {
        say("試しています…");
        var made = null;
        Shelf.newRoom("Rawpo_接続の確認").then(function (id) {
          made = id;
          return Shelf.put(id, "test.txt", new Blob(["ok"], { type: "text/plain" }));
        }).then(function () {
          return Shelf.list(made);
        }).then(function (rows) {
          if (!rows.length) throw new Error("置いたはずのものが見つかりませんでした。");
          return Shelf.drop(made);
        }).then(function () {
          say("やりとりできました。片付けも済んでいます");
          toast("問題ありません");
        }).catch(function (e) {
          say(why(e), true);
          if (made) Shelf.drop(made).catch(function () {});
        });
      };
    }
    paintTeam();

    /* 名前は覚えてあるぶんをすぐ出す。裏で静かに確かめ直すだけ。
       ここで link() を呼ぶと、開くたびに許可画面が出てしまう */
    if (Shelf.linked()) {
      var had = Shelf.who();
      Shelf.refresh().then(function (n) {
        if (n === had) return;
        paintMe();
        if ($("tmSay")) paintTeam();
      }).catch(function () {});
    }
  }

  /* ============================================================
     使い方・困ったとき
     ------------------------------------------------------------
     画面の中に長い説明を置くと、そこだけ文字だらけになる。
     説明はここに集めて、知りたい人が開くようにする。
     たたんであるので、開いたときの眺めは短い。
     ============================================================ */
  function qa(title, body) {
    return "<details class=\"qa\"><summary>" + esc(title) + "</summary>"
      + '<div class="qabody">' + body + "</div></details>";
  }

  function helpSheet() {
    sheet('<div class="panel-head"><h3>使い方・困ったとき</h3>'
      + '<button class="iconbtn" id="hpClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div>'
      + '<div class="panel-body"><div class="stack">'

      + '<div class="hintline">Rawpoは、ひとつの出来事ごとにフォルダを作って、'
      + "その場で撮ったもの・書いたものを放り込んでいくアプリです。</div>"

      + qa("はじめかた",
          "<p>下の<b>＋ 新しいフォルダ</b>から、出来事ごとにフォルダを1つ作ります。"
          + "展示会、取材、旅、会議。テンプレートを選ぶと、名前とメモの形が最初から入ります。</p>"
          + "<p>フォルダを開いて、下の<b>＋</b>から 撮る・写真・音声・動画・書類・メモ。"
          + "数の上限はありません。手が離せないときは、声で残せます。</p>")

      + qa("並べ替えと、写真を直す",
          "<p>タイルを<b>長押ししてから指を動かす</b>と、好きな順に並べ替えられます。</p>"
          + "<p>左上に来たものが、そのままホームでのフォルダの<b>表紙</b>になります。</p>"
          + "<p>写真を開いて<b>直す</b>を押すと、回す・切り取る・明るさを変えられます。"
          + "元の写真は残してあるので、いつでも<b>元に戻す</b>が効きます。</p>")

      + qa("さがす",
          "<p>上の枠にメモ・タグ・名前を打つと、<b>全部のフォルダをまたいで</b>探します。</p>"
          + "<p>フォルダに「仕事」「旅」などの<b>カテゴリ</b>を付けておくと、"
          + "ホームの上でそれを押したとき、そのフォルダだけが並びます。</p>"
          + "<p>★を付けたものだけを並べることもできます。</p>")

      + qa("iPhoneとパソコンで同じ中身にする",
          "<p>使う端末それぞれで、画面の<b>下の右端にある丸</b>から同じGoogleアカウントにログインします。"
          + "写真が置かれるのは<b>あなた自身のGoogleドライブ</b>で、Rawpoのサーバーは通りません。</p>"
          + "<p>つないだあとは、<b>アプリを開いたときと、ほかのことをして戻ってきたとき</b>に自動で合わせます。"
          + "手で合わせたいときは「いますぐ同期」を押します。</p>"
          + "<p>写真は<b>一度送れば二度は送りません</b>。2回目からは記録だけなので、通信はごくわずかです。</p>"
          + "<p>同じものを両方の端末で直したときは、<b>あとで直したほう</b>が残ります。"
          + "片方で消して、もう片方でそのあと直していたときは、直したほうが残ります。</p>")

      + qa("セーブデータ（まるごと保存・保存から戻す）",
          "<p><b>まるごと保存</b>は、いまの中身をひとまとめにしてドライブに置きます。"
          + "押すたびに前の保存と入れ替わるので、ドライブの中が増えていくことはありません。</p>"
          + "<p><b>保存から戻す</b>で、そこまで戻せます。いまの中身は消えず、足りないものだけが足されます。</p>"
          + "<p>ドライブに置いたファイルは<b>Rawpoがまとめた形</b>です。"
          + "ドライブのアプリで開こうとすると「サポートされていないファイル形式です」と出ますが、"
          + "壊れているわけではありません。中身を見るときは、Rawpoの「保存から戻す」を使ってください。</p>")

      + qa("機種変更・バックアップ",
          "<p>設定の<b>まるごとバックアップ</b>で、すべてをZIPにして書き出せます。"
          + "新しい端末でRawpoを開き、<b>バックアップ／共有されたZIPを読み込む</b>から読ませてください。</p>"
          + "<p>フォルダ1つだけを人に渡したいときは、そのフォルダを開いて"
          + "設定 → <b>このフォルダを共有する</b>。相手も同じ読み込み口から開けます。</p>")

      + qa("うまくいかないとき",
          "<p><b>新しい版が来ない</b><br>アプリをいったん完全に閉じて、開き直してください。"
          + "いまの版は、この設定画面の見出しの横に出ています（v" + esc(APPVER) + "）。</p>"
          + "<p><b>「ログインが切れました」と出た</b><br>合鍵の期限が切れただけです。"
          + "下の右端にある丸から、もう一度ログインすれば直ります。</p>"
          + "<p><b>片方の端末にだけ出てこない</b><br>その端末がまだログインしていない可能性があります。"
          + "下の右端にある丸を押すと、いまログインしている端末が並びます。"
          + "そこに出てこない端末では、ログインして「いますぐ同期」を一度押してください。</p>"
          + "<p><b>ログインしているのに、相手の端末が出てこない</b><br>"
          + "下の右端にある丸 → <b>置き場を調べる</b>を、両方の端末で押して見比べてください。"
          + "「使っているフォルダ」が同じなら、あとは同期を押すだけでそろいます。"
          + "違っていても、もう一度同期すれば、古いほうのフォルダに自動でそろいます。</p>"
          + "<p><b>写真のところが空のまま</b><br>相手の端末が、まだ写真を送り終わっていません。"
          + "相手の端末でRawpoを開いたままにしておくと送り終わり、次の同期で届きます。</p>"
          + "<p><b>一緒に使う人がログインできない</b><br>いまはお試しの段階で、"
          + "Google側に登録した人しか使えません。その人のGmailを登録する必要があります。</p>"
          + "<p><b>容量が気になる</b><br>設定の<b>端末の使用量</b>で見られます。"
          + "写真は取り込むときに縮められます（設定の<b>写真の大きさ</b>で変えられます）。</p>")

      + qa("データはどこにあるか",
          "<p>写真・録音・動画・メモは、すべて<b>この端末の中</b>にあります。"
          + "Rawpoのサーバーに送られることはありません。</p>"
          + "<p>同期をつないだときだけ、<b>あなた自身のGoogleドライブ</b>を通ります。"
          + "Rawpoが触れるのは、Rawpoが作ったファイルだけです。"
          + "ドライブのほかのファイルは見えません。</p>")

      + "</div></div>"
      + '<div class="panel-foot"><span class="label">Rawpo v' + esc(APPVER) + "</span></div>", "dialog");

    $("hpClose").onclick = closeSheet;
  }

  /* ============================================================
     設定・バックアップ
     ============================================================ */
  function menuDialog() {
    sheet('<div class="panel-head">'
      + '<h3><span style="color:var(--mark)">Raw</span>po'
      + '<span class="ver">v' + esc(APPVER) + "</span></h3>"
      + '<button class="iconbtn" id="sClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div>'
      + '<div class="panel-body"><div class="stack">'
      + '<button class="rowbtn" id="sNew"><div><b>新しく作る</b>'
      + '<span>テンプレートを選んで、フォルダを1つ作ります</span></div><svg><use href="#i-plus"/></svg></button>'
      + (screen === "folder" ? '<button class="rowbtn" id="sExport"><div><b>このフォルダを共有する</b><span>AirDrop・LINE・メールへ。端末の共有シートが開きます</span></div><svg><use href="#i-share"/></svg></button>' : "")
      + (screen === "folder" ? '<button class="rowbtn" id="sEdit"><div><b>このフォルダの設定</b><span>名前・カテゴリ・日付・場所・フォーマット・削除</span></div><svg><use href="#i-book"/></svg></button>' : "")
      + '<button class="rowbtn" id="sTags"><div><b>タグを見る・整理する</b>'
      + "<span>付けたタグの一覧。名前の付け替えと削除もここで</span></div><svg><use href=\"#i-tag\"/></svg></button>"
      + '<button class="rowbtn" id="sSize"><div><b>写真の大きさ</b>'
      + "<span>" + esc(photoSize().name) + "・長辺" + photoSize().edge + "px"
      + (asksSize() ? "。取り込むたびにきく" : "。取り込むときはきかない") + "</span></div><svg><use href=\"#i-cam\"/></svg></button>"
      + '<button class="rowbtn" id="sLook"><div><b>見た目を整える</b><span>配色・明るさ・書体・余白・角の丸み・列数</span></div><svg><use href="#i-paint"/></svg></button>'
      + '<button class="rowbtn" id="sAd"><div><b>広告を消す</b>'
      + "<span>" + (adFree() ? "いまは消えています" : "買い切り。毎月の支払いはありません") + "</span></div>"
      + '<svg><use href="#i-star"/></svg></button>'
      + '<button class="rowbtn" id="sHelp"><div><b>使い方・困ったとき</b>'
      + "<span>はじめかたから、同期・セーブデータ・うまくいかないときまで</span></div>"
      + '<svg><use href="#i-help"/></svg></button>'
      + installRow()
      + '<div class="field"><div class="label">端末の使用量</div>'
      + '<div class="gauge"><div class="gaugebar"><i id="gBar" style="width:0%"></i></div>'
      + '<div class="saveflag" id="gTxt">調べています…</div></div></div>'
      + '<button class="rowbtn" id="sBackup"><div><b>まるごとバックアップ</b>'
      + "<span>すべてのフォルダ・写真・メモを1つのZIPにして書き出します。機種変更のときはこれ。</span></div>"
      + '<svg><use href="#i-out"/></svg></button>'
      + '<button class="rowbtn" id="sRestore"><div><b>バックアップ／共有されたZIPを読み込む</b>'
      + "<span>まるごとのZIPでも、1フォルダ分のZIPでも。いまのデータに足されます。</span></div>"
      + '<svg><use href="#i-plus"/></svg></button>'
      + '<input id="restoreIn" type="file" accept=".zip,application/zip" hidden>'
      + '</div></div>'
      + '<div class="panel-foot"><span class="label">データはこの端末の中だけにあります</span></div>', "dialog");

    $("sClose").onclick = closeSheet;
    $("sNew").onclick = function () { closeSheet(); newExDialog(); };
    var xp = $("sExport");
    if (xp) xp.onclick = function () { closeSheet(); exportNotes(); };
    var e = $("sEdit");
    if (e) e.onclick = function () { closeSheet(); newExDialog(exById(curEx)); };

    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (s) {
        var used = s.usage || 0, quota = s.quota || 0;
        $("gBar").style.width = quota ? Math.max(1, Math.min(100, (used / quota) * 100)) + "%" : "0%";
        $("gTxt").textContent = mb(used) + (quota ? " / 使える上限 約" + mb(quota) : "");
      }).catch(function () { $("gTxt").textContent = "調べられませんでした"; });
    } else {
      $("gTxt").textContent = "この端末では調べられません";
    }

    $("sHelp").onclick = helpSheet;
    $("sLook").onclick = lookDialog;
    $("sAd").onclick = function () { closeSheet(); removeAdsDialog(); };
    $("sTags").onclick = function () {
      tagSheet(screen === "folder" ? "folder" : "shelf");
    };
    var ib = $("sInstall");
    if (ib) ib.onclick = function () {
      if (deferredInstall) {
        deferredInstall.prompt();
        deferredInstall.userChoice.then(function () { deferredInstall = null; closeSheet(); });
      } else {
        toast(isIOS() ? "共有ボタン →「ホーム画面に追加」を選んでください"
                      : "ブラウザのメニュー →「アプリをインストール」を選んでください");
      }
    };
    $("sSize").onclick = function () { closeSheet(); sizeSheet(); };
    $("sBackup").onclick = backup;
    $("sRestore").onclick = function () { $("restoreIn").click(); };
    $("restoreIn").onchange = function () {
      var f = this.files && this.files[0];
      this.value = "";
      if (f) restore(f);
    };
  }

  /* 読み込める形のZIPを作る。フィルタを渡すと1フォルダだけにできる */
  function makeBackup(exFilter, itFilter) {
    progress(3);
    toast("まとめています…");
    var meta = { version: 4, madeAt: new Date().toISOString(), exhibitions: [], items: [], templates: [], boards: [], gone: [] };
    var entries = [], blobIds = [];

    /* 一部だけ書き出すときは、消えた記録まで持ち出さない。
       その相手に関係のない削除まで伝えてしまうため */
    var whole = !exFilter && !itFilter;
    return Promise.all([DB.all("exhibitions"), DB.all("items"), DB.all("templates"),
      whole ? DB.all("boards") : Promise.resolve([]),
      whole ? DB.all("gone") : Promise.resolve([])]).then(function (r) {
      meta.exhibitions = exFilter ? r[0].filter(exFilter) : r[0];
      meta.items = itFilter ? r[1].filter(itFilter) : r[1];
      meta.templates = r[2] || [];
      meta.boards = r[3] || [];
      meta.gone = r[4] || [];
      meta.items.forEach(function (it) {
        if (it.blobId && blobIds.indexOf(it.blobId) < 0) blobIds.push(it.blobId);
        if (it.thumbId && blobIds.indexOf(it.thumbId) < 0) blobIds.push(it.thumbId);
      });
      var i = 0;
      return new Promise(function (res) {
        (function next() {
          if (i >= blobIds.length) { res(); return; }
          var id = blobIds[i++];
          progress(3 + Math.round((i / blobIds.length) * 88));
          DB.get("blobs", id).then(function (b) {
            if (b && b.blob) return b.blob.arrayBuffer().then(function (ab) {
              entries.push({ name: "blobs/" + id, u8: new Uint8Array(ab) });
            });
          }).catch(function () {}).then(next);
        })();
      });
    }).then(function () {
      entries.unshift({ name: "data.json", u8: new TextEncoder().encode(JSON.stringify(meta)) });
      return zipWrite(entries);
    });
  }

  function backup() {
    makeBackup(null, null).then(function (zip) {
      return handOver(zip, "Rawpo_バックアップ_" + today() + ".zip").then(function (how) {
        progress(100);
        if (how !== "cancel") toast("バックアップを書き出しました（" + mb(zip.size) + "）");
      });
    }).catch(function (e) { progress(100); toast(why(e), true); });
  }

  function restore(file) {
    progress(5);
    toast("読み込んでいます…");
    file.arrayBuffer().then(function (ab) {
      var files = zipRead(ab), meta = null, blobs = {};
      files.forEach(function (f) {
        if (f.name === "data.json") meta = JSON.parse(new TextDecoder().decode(f.u8));
        else if (f.name.indexOf("blobs/") === 0) blobs[f.name.slice(6)] = f.u8;
      });
      if (!meta) throw new Error("このZIPにはバックアップのデータが入っていません。");

      var pairs = [];
      (meta.exhibitions || []).forEach(function (x) { pairs.push(["exhibitions", x]); });
      (meta.brands || []).forEach(function (x) { pairs.push(["brands", x]); });
      (meta.items || []).forEach(function (x) { pairs.push(["items", x]); });
      (meta.templates || []).forEach(function (x) { pairs.push(["templates", x]); });
      (meta.boards || []).forEach(function (x) { pairs.push(["boards", x]); });
      Object.keys(blobs).forEach(function (id) {
        var it = (meta.items || []).filter(function (x) { return x.blobId === id || x.thumbId === id; })[0];
        var type = it ? (it.thumbId === id && it.kind === "photo" ? "image/jpeg" : (it.mime || "application/octet-stream")) : "application/octet-stream";
        pairs.push(["blobs", { id: id, blob: new Blob([blobs[id]], { type: type }) }]);
      });

      progress(60);
      /* 書いてある時刻のまま入れる。ここで今の時刻に塗り替えると、
         どちらが新しいか分からなくなる */
      return DB.putManyRaw(pairs).then(function () {
        curEx = null; screen = "shelf"; curCat = "all";
        return Promise.all([DB.all("exhibitions"), DB.all("templates"), DB.all("boards")]);
      }).then(function (r) {
        exs = r[0].sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
        takeTemplates(r[1]);
        boards = r[2] || [];
        remember("ex", "");
        closeSheet();
        return goShelf();
      }).then(function () {
        progress(100);
        toast("読み込みました（フォルダ " + (meta.exhibitions || []).length + " 件）");
      });
    }).catch(function (e) { progress(100); toast(why(e), true); });
  }
  /* ============================================================
     1枚を画面いっぱいで見る
     ------------------------------------------------------------
     はじめは全体が入る大きさ。横位置の写真は上下に余白がつくので、
     端が切れることはない。そこから、つまむか2回たたくと大きくなる。
     ============================================================ */
  var lensOff = null;   /* 開いているあいだの後片付け */

  function bigView(src) {
    if (!src || lensOff) return;
    var box = document.createElement("div");
    box.className = "lens";
    box.innerHTML = '<img class="lensimg" alt="">'
      + '<button class="lensx" aria-label="閉じる"><svg><use href="#i-x"/></svg></button>';
    var img = box.querySelector(".lensimg");
    img.src = src;
    document.body.appendChild(box);
    /* 画面の送りには手をつけない。下の画面が止めていることがあり、
       こちらで戻すと食い違う。この画面は全面を覆い、
       指の動きも受け取らないので、裏が動くことはない */
    requestAnimationFrame(function () { box.classList.add("on"); });

    var sc = 1, tx = 0, ty = 0;
    var pts = {}, nPts = 0, last = null, lastTap = 0, pinch = null;
    /* つまんで離すと指が2本続けて離れる。それを2回たたいたと取り違えて
       せっかく広げた大きさが戻っていた。
       指1本で、動かさずに、最後の1本が離れたときだけ「たたいた」と見る */
    var downX = 0, downY = 0, downAt = 0, moved = false, multi = false;

    function draw() {
      img.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + sc + ")";
    }
    /* はみ出したぶんより外へは行かせない。
       写真が画面より小さい向きは、まん中に置いたままにする */
    function clamp() {
      var b = box.getBoundingClientRect();
      var w = img.clientWidth * sc, h = img.clientHeight * sc;
      var mx = Math.max(0, (w - b.width) / 2), my = Math.max(0, (h - b.height) / 2);
      tx = Math.max(-mx, Math.min(mx, tx));
      ty = Math.max(-my, Math.min(my, ty));
    }
    function zoomAt(next, cx, cy) {
      var b = box.getBoundingClientRect();
      var ox = cx - b.left - b.width / 2, oy = cy - b.top - b.height / 2;
      var k = next / sc;
      tx = ox - (ox - tx) * k;
      ty = oy - (oy - ty) * k;
      sc = next;
      clamp(); draw();
    }

    function close() {
      if (!lensOff) return;
      lensOff(); lensOff = null;
      box.classList.remove("on");
      setTimeout(function () { try { box.remove(); } catch (e) {} }, 180);
    }

    box.querySelector(".lensx").onclick = close;

    box.addEventListener("pointerdown", function (e) {
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      nPts++;
      try { box.setPointerCapture(e.pointerId); } catch (x) {}
      if (nPts === 1) { downX = e.clientX; downY = e.clientY; downAt = Date.now(); moved = false; multi = false; }
      if (nPts >= 2) multi = true;
      if (nPts === 2) {
        var k = Object.keys(pts), a = pts[k[0]], c = pts[k[1]];
        pinch = { d: Math.hypot(a.x - c.x, a.y - c.y), s: sc };
      }
      last = { x: e.clientX, y: e.clientY };
    });

    box.addEventListener("pointermove", function (e) {
      if (!pts[e.pointerId]) return;
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (Math.abs(e.clientX - downX) > 10 || Math.abs(e.clientY - downY) > 10) moved = true;
      if (nPts >= 2 && pinch) {
        var k = Object.keys(pts), a = pts[k[0]], c = pts[k[1]];
        var d = Math.hypot(a.x - c.x, a.y - c.y);
        if (pinch.d > 0) {
          zoomAt(Math.max(1, Math.min(6, pinch.s * (d / pinch.d))),
                 (a.x + c.x) / 2, (a.y + c.y) / 2);
        }
        return;
      }
      if (sc > 1 && last) {
        e.preventDefault();
        tx += e.clientX - last.x;
        ty += e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
        clamp(); draw();
      }
    });

    ["pointerup", "pointercancel"].forEach(function (nm) {
      box.addEventListener(nm, function (e) {
        if (pts[e.pointerId]) { delete pts[e.pointerId]; nPts = Math.max(0, nPts - 1); }
        if (nPts < 2) pinch = null;
        if (nPts > 0) return;          /* まだ指が残っている。終わっていない */
        last = null;
        var wasMulti = multi, wasMoved = moved;
        multi = false;
        if (nm !== "pointerup") return;
        /* つまんだあとや、指を滑らせたあとは「たたいた」ではない */
        if (wasMulti || wasMoved || Date.now() - downAt > 400) { lastTap = 0; return; }
        /* 2回たたいたら、大きくする・元に戻すを行き来する */
        var now = Date.now();
        if (now - lastTap < 300) {
          lastTap = 0;
          if (sc > 1.02) { sc = 1; tx = 0; ty = 0; draw(); }
          else zoomAt(2.5, e.clientX, e.clientY);
          return;
        }
        lastTap = now;
      });
    });

    /* パソコンでは、ホイールでも大きくできる */
    box.addEventListener("wheel", function (e) {
      e.preventDefault();
      zoomAt(Math.max(1, Math.min(6, sc * (e.deltaY < 0 ? 1.12 : 1 / 1.12))), e.clientX, e.clientY);
    }, { passive: false });

    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    lensOff = function () { document.removeEventListener("keydown", onKey); };
  }

  /* ============================================================
     ボード
     ------------------------------------------------------------
     フォルダを跨いで、1枚の紙に写真を貼っていく台。
     位置も大きさも「紙に対する割合」で持つので、
     あとから紙の大きさや向きを変えても、貼った並びは崩れない。
     ============================================================ */
  var PAPER = {
    a4: { w: 210, h: 297, name: "A4" },
    a3: { w: 297, h: 420, name: "A3" },
    a2: { w: 420, h: 594, name: "A2" }
  };
  var LAY = [
    { k: "p",  name: "縦" },
    { k: "l",  name: "横" },
    { k: "sq", name: "正方形" }
  ];
  /* 紙の実寸（mm）。向きで入れ替える。正方形は短いほうに合わせる */
  function paperSize(b) {
    var p = PAPER[(b && b.paper) || "a4"] || PAPER.a4;
    if (b && b.lay === "l") return { w: p.h, h: p.w };
    if (b && b.lay === "sq") return { w: p.w, h: p.w };
    return { w: p.w, h: p.h };
  }
  function paperName(b) {
    var p = PAPER[(b && b.paper) || "a4"] || PAPER.a4;
    var l = LAY.filter(function (x) { return x.k === ((b && b.lay) || "p"); })[0];
    var s = paperSize(b);
    return p.name + "・" + (l ? l.name : "縦") + "（" + s.w + "×" + s.h + "mm）";
  }

  var boards = [];
  var curBoard = null, boardSel = "";

  /* ボードは何ページでも持てる。
     前の版は1枚ぶんを cards に直接持っていたので、
     開いたときに1ページ目として引き取る */
  function pagesOf(b) {
    if (!b.pages || !b.pages.length) {
      b.pages = [{ id: uid(), cards: (b.cards || []).slice() }];
      delete b.cards;
    }
    return b.pages;
  }
  /* 全ページを合わせた枚数。棚の札と上の帯に出す */
  /* 選んでいる写真が、どのページのどれか。
     ページが縦に並ぶので、ページ番号だけでは決まらない */
  function selOf(b) {
    var out = null;
    pagesOf(b).forEach(function (pg, n) {
      (pg.cards || []).forEach(function (c, i) {
        if (c.id === boardSel) out = { page: pg, n: n, i: i, card: c };
      });
    });
    return out;
  }

  /* いま画面のまん中にいちばん近いページ。
     縦に送って見ているので、「いま見ているページ」がそれ */
  function shownPage(b) {
    var ps = pagesOf(b), best = ps.length - 1, near = Infinity;
    var mid = window.innerHeight / 2;
    Array.prototype.forEach.call(document.querySelectorAll(".paper[data-page]"), function (el) {
      var r = el.getBoundingClientRect();
      var d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < near) { near = d; best = Number(el.getAttribute("data-page")); }
    });
    return ps[best] || ps[ps.length - 1];
  }

  function boardCount(b) {
    var n = 0;
    pagesOf(b).forEach(function (pg) { n += (pg.cards || []).length; });
    return n;
  }

  /* 目安の線。紙の横幅を8つに割った幅を1ますとし、
     縦もその幅で割る。こうするとます目が正方形になる */
  var GRIDN = 8;
  var GRIDS = [
    { k: "",     name: "線なし", n: GRIDN },
    { k: "v",    name: "縦",     n: GRIDN },
    { k: "h",    name: "横",     n: GRIDN },
    { k: "both", name: "格子 大", n: GRIDN },
    { k: "fine", name: "格子 小", n: GRIDN * 2 }
  ];
  function gridOf(b) {
    var k = (b && b.grid) || "";
    return GRIDS.filter(function (x) { return x.k === k; })[0] || GRIDS[0];
  }
  /* 紙に対する割合での、ます目の幅と高さ。
     吸い付きも、いま出している線の細かさに合わせる */
  function gridStep(b) {
    var sz = paperSize(b);
    var gx = 1 / gridOf(b).n;
    return { x: gx, y: (sz.w * gx) / sz.h };
  }
  /* 吸い付き。近い線があればそこへ寄せる。
     強すぎると置きたいところに置けないので、1ますの1/4まで */
  function snapTo(v, step) {
    var near = Math.round(v / step) * step;
    return Math.abs(near - v) < step / 4 ? near : v;
  }

  function boardById(id) {
    for (var i = 0; i < boards.length; i++) if (boards[i].id === id) return boards[i];
    return null;
  }
  function saveBoard(b, after) {
    pagesOf(b);
    DB.put("boards", b).then(function () {
      var i = -1;
      for (var k = 0; k < boards.length; k++) if (boards[k].id === b.id) i = k;
      if (i < 0) boards.push(b); else boards[i] = b;
      if (after) after();
    }).catch(function (e) { toast(why(e), true); });
  }

  /* 棚の＋。フォルダとボードのどちらを作るか */
  function makeMenu() {
    sheet('<div class="panel-head"><h3>新しく作る</h3>'
      + '<button class="iconbtn" id="mkNo" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div>'
      + '<div class="panel-body"><div class="stack">'
      + '<button class="rowbtn" id="mkEx"><div><b>フォルダ</b>'
      + "<span>ひとつの出来事ごとに1つ。写真・録音・メモを放り込みます</span></div>"
      + '<svg><use href="#i-folder"/></svg></button>'
      + '<button class="rowbtn" id="mkBd"><div><b>ボード</b>'
      + "<span>フォルダを跨いで、1枚の紙に写真を貼っていきます</span></div>"
      + '<svg><use href="#i-grid"/></svg></button>'
      + "</div></div>", "dialog");
    $("mkNo").onclick = closeSheet;
    $("mkEx").onclick = function () { closeSheet(); newExDialog(); };
    $("mkBd").onclick = function () { closeSheet(); boardDialog(null); };
  }

  /* 新しく作る・設定を変える */
  function boardDialog(b) {
    var mk = !b;
    var e = b || { id: "", name: "", paper: "a4", lay: "p", cards: [] };
    var pick = { paper: e.paper || "a4", lay: e.lay || "p" };

    function seg(name, list, cur, key) {
      return '<div class="field"><div class="label">' + esc(name) + "</div>"
        + '<div class="segrow">' + list.map(function (x) {
          return '<button class="seg" data-' + key + '="' + x.k + '" aria-pressed="'
            + (x.k === cur) + '">' + esc(x.name) + "</button>";
        }).join("") + "</div></div>";
    }

    sheet('<div class="panel-head"><h3>' + (mk ? "新しいボード" : "ボードの設定") + "</h3>"
      + '<button class="iconbtn" id="bdNo" aria-label="やめる"><svg><use href="#i-x"/></svg></button></div>'
      + '<div class="panel-body"><div class="stack">'
      + '<div class="field"><label class="label" for="bdName">名前</label>'
      + '<input class="inp" id="bdName" value="' + esc(e.name) + '" placeholder="参考ボード"></div>'
      + seg("紙の大きさ", Object.keys(PAPER).map(function (k) { return { k: k, name: PAPER[k].name }; }), pick.paper, "paper")
      + seg("向き", LAY, pick.lay, "lay")
      + '<div class="hintline" id="bdSize"></div>'
      + '<button class="cta" id="bdOk" style="width:100%">' + (mk ? "つくる" : "直す") + "</button>"
      + (mk ? "" : '<button class="danger" id="bdDel" style="width:100%">このボードを削除</button>')
      + "</div></div>", "dialog");

    noAutofill($("panel"));
    function sizeLine() {
      $("bdSize").textContent = "紙は " + paperName({ paper: pick.paper, lay: pick.lay })
        + "。あとから変えても、貼った並びは崩れません。";
    }
    sizeLine();

    function wire(key) {
      Array.prototype.forEach.call($("panel").querySelectorAll("[data-" + key + "]"), function (bt) {
        bt.onclick = function () {
          pick[key] = bt.getAttribute("data-" + key);
          Array.prototype.forEach.call($("panel").querySelectorAll("[data-" + key + "]"), function (x) {
            x.setAttribute("aria-pressed", String(x === bt));
          });
          sizeLine();
        };
      });
    }
    wire("paper"); wire("lay");

    $("bdNo").onclick = closeSheet;
    $("bdOk").onclick = function () {
      var nm = ($("bdName").value || "").trim() || "名前のないボード";
      if (mk) {
        var rec = { id: uid(), name: nm, paper: pick.paper, lay: pick.lay,
                    pages: [{ id: uid(), cards: [] }], createdAt: Date.now() };
        saveBoard(rec, function () { closeSheet(); openBoard(rec.id); });
      } else {
        e.name = nm; e.paper = pick.paper; e.lay = pick.lay;
        saveBoard(e, function () { closeSheet(); paint(); });
      }
    };
    var dl = $("bdDel");
    if (dl) dl.onclick = function () {
      askYesNo({
        title: "「" + e.name + "」を削除",
        body: "ボードだけを消します。貼ってあった写真そのものは、フォルダに残ります。",
        ok: "削除する"
      }, function () {
        DB.del("boards", e.id).then(function () {
          boards = boards.filter(function (x) { return x.id !== e.id; });
          closeSheet();
          if (curBoard === e.id) goShelf(); else paint();
          toast("削除しました");
        }).catch(function (er) { toast(why(er), true); });
      });
    };
  }

  /* ボードを開く */
  function openBoard(id) {
    var b = boardById(id);
    if (!b) return Promise.resolve();
    picking = false; picked = {};
    screen = "board"; curBoard = id; boardSel = "";
    clearSearch();
    dropUrls(); items = [];
    return DB.all("items").then(function (all) { browseAll = all; }, function () {})
      .then(function () { paint(); });
  }

  /* 貼ってある写真の実体を用意してから描く */
  function paintBoard(stage, seq) {
    var b = boardById(curBoard);
    if (!b) { goShelf(); return; }
    var ps = pagesOf(b);
    var need = [];
    ps.forEach(function (pg) {
      (pg.cards || []).forEach(function (c) {
        var it = anyItem(c.itemId);
        if (it) need.push(it.blobId || it.thumbId);
      });
    });

    ensureUrls(need).then(function () {
      if (seq !== paintSeq) return;
      var sz = paperSize(b);
      /* ページは縦に並べる。次のページへは、そのまま下に送るだけ */
      var out = "";
      ps.forEach(function (pg, n) {
        out += '<div class="pagehead"><span>' + (n + 1) + " ページ目</span>"
          + (ps.length > 1 ? '<button class="bad" data-pgdel="' + n + '">消す</button>' : "")
          + "</div>"
          + '<div class="boardwrap">'
          + '<div class="paper" data-page="' + n + '" style="aspect-ratio:' + sz.w + "/" + sz.h + '">';
        (pg.cards || []).forEach(function (c, i) {
          var it = anyItem(c.itemId);
          var src = it ? urlCache[it.blobId || it.thumbId] : "";
          out += '<div class="card' + (c.id === boardSel ? " sel" : "") + '" data-card="' + esc(c.id) + '"'
            + ' style="left:' + (c.x * 100) + "%;top:" + (c.y * 100) + "%;width:" + (c.w * 100) + "%;"
            + "transform:translate(-50%,-50%) rotate(" + (c.rot || 0) + 'deg);z-index:' + (i + 1) + '">'
            + (src ? '<img src="' + src + '" alt="" draggable="false">' : '<span class="cardgone">写真がありません</span>')
            + "</div>";
        });
        out += "</div></div>";
      });
      out += '<button class="pgadd" id="pgAdd">＋ ページを足す</button>';
      stage.innerHTML = out;

      ps.forEach(function (pg, n) {
        var el = stage.querySelector('.paper[data-page="' + n + '"]');
        if (el) { paintGrid(b, el); wireBoard(b, pg, el); }
      });
      wirePager(b);
      paintFix(b);
    });
  }

  /* 下の帯。いつも同じ高さで、同じところに居る。
     高さが変わると画面が跳ねるので、2行ぶんを決め打ちで取る */
  function paintFix(b) {
    var el = $("boardFix");
    if (!el) {
      el = document.createElement("div");
      el.className = "boardfix";
      el.id = "boardFix";
      document.body.appendChild(el);
    }
    el.innerHTML = '<div class="boardtools" id="boardTools"></div>'
      + '<div class="boardbar" id="boardBar"></div>';
    var dock = document.querySelector(".dock");
    var dh = dock ? Math.round(dock.getBoundingClientRect().height) : 92;
    el.style.bottom = dh + "px";
    paintTools(b);
    paintBoardBar(b);
    /* 帯の裏に紙や「ページを足す」が隠れないよう、
       実際の高さを測って、そのぶん下を空ける */
    var m = document.querySelector("main");
    if (m) m.style.paddingBottom = (Math.round(el.getBoundingClientRect().height) + 16) + "px";
  }
  function dropFix() {
    var el = $("boardFix");
    if (el) el.remove();
    var m = document.querySelector("main");
    if (m) m.style.paddingBottom = "";
  }

  function wirePager(b) {
    var ps = pagesOf(b);
    var ad = $("pgAdd");
    if (ad) ad.onclick = function () {
      ps.push({ id: uid(), cards: [] });
      boardSel = "";
      saveBoard(b, function () {
        paint();
        /* 足したページまで送る。下にできたものを探させない */
        setTimeout(function () {
          var el = document.querySelector('.paper[data-page="' + (ps.length - 1) + '"]');
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 60);
        toast(ps.length + " ページになりました");
      });
    };
    Array.prototype.forEach.call(document.querySelectorAll("[data-pgdel]"), function (bt) {
      bt.onclick = function () {
        var n = Number(bt.getAttribute("data-pgdel"));
        askYesNo({
          title: (n + 1) + " ページ目を消す",
          body: "このページに貼ってあるものだけを消します。写真そのものはフォルダに残ります。",
          ok: "消す"
        }, function () {
          ps.splice(n, 1);
          boardSel = "";
          saveBoard(b, function () { paint(); toast("消しました"); });
        });
      };
    });
  }

  /* 目安の線は紙の背景として描く。書き出した絵には出ない */
  function paintGrid(b, paper) {
    if (!paper) return;
    var g = b.grid || "";
    if (!g) { paper.style.backgroundImage = ""; return; }
    var st = gridStep(b);
    /* 細かいほうは線を薄くする。濃いままだと面が灰色に見えてしまう */
    var line = g === "fine" ? "rgba(34,64,58,.10)" : "rgba(34,64,58,.14)";
    var bits = [], size = [];
    if (g === "v" || g === "both" || g === "fine") {
      bits.push("repeating-linear-gradient(to right, " + line + " 0 1px, transparent 1px "
        + (st.x * 100) + "%)");
      size.push("100% 100%");
    }
    if (g === "h" || g === "both" || g === "fine") {
      bits.push("repeating-linear-gradient(to bottom, " + line + " 0 1px, transparent 1px "
        + (st.y * 100) + "%)");
      size.push("100% 100%");
    }
    paper.style.backgroundImage = bits.join(",");
    paper.style.backgroundSize = size.join(",");
  }

  function allPapers() { return document.querySelectorAll(".paper[data-page]"); }
  function paintGrids(b) {
    Array.prototype.forEach.call(allPapers(), function (el) { paintGrid(b, el); });
  }

  function paintTools(b) {
    var el = $("boardTools");
    if (!el) return;
    var g = b.grid || "";
    var now = gridOf(b);
    el.innerHTML = '<button id="bdGrid"><span class="bk' + (g === "fine" ? " fine" : "") + '"></span>'
      + esc(now.name) + "</button>"
      + '<button id="bdSnap" aria-pressed="' + (!!b.snap) + '">吸い付き</button>'
      + '<span style="flex:1 1 auto"></span>'
      + '<button id="bdPdf" class="go">PDFにする</button>';
    /* 押すたびに、線なし→縦→横→格子と回る。1タップで変えられる */
    $("bdGrid").onclick = function () {
      var i = 0;
      GRIDS.forEach(function (x, n) { if (x.k === g) i = n; });
      b.grid = GRIDS[(i + 1) % GRIDS.length].k;
      saveBoard(b, function () { paintGrids(b); paintTools(b); });
    };
    $("bdSnap").onclick = function () {
      b.snap = !b.snap;
      saveBoard(b, function () { paintTools(b); toast(b.snap ? "線に吸い付きます" : "吸い付きをやめました"); });
    };
    $("bdPdf").onclick = function () { pdfSheet(b); };
  }

  function paintBoardBar(b) {
    var bar = $("boardBar");
    if (!bar) return;
    var hit = selOf(b), c = hit && hit.card;
    bar.innerHTML = c
      ? '<button data-bd="back">うしろへ</button>'
        + '<button data-bd="front">まえへ</button>'
        /* 回すのは記号にする。文字にすると帯に収まらず、端が切れる */
        + '<button data-bd="left" class="turn" aria-label="左へ回す" title="左へ回す">↺</button>'
        + '<button data-bd="right" class="turn" aria-label="右へ回す" title="右へ回す">↻</button>'
        + '<button data-bd="off" class="bad">はずす</button>'
      : '<span class="bdhint">写真を押すと、動かしたり大きさを変えたりできます</span>';
    Array.prototype.forEach.call(bar.querySelectorAll("[data-bd]"), function (bt) {
      bt.onclick = function () { boardAct(b, bt.getAttribute("data-bd")); };
    });
  }

  function boardAct(b, k) {
    var hit = selOf(b);
    if (!hit) return;
    var page = hit.page, i = hit.i, c = hit.card;
    if (k === "off") { page.cards.splice(i, 1); boardSel = ""; }
    else if (k === "front") { page.cards.splice(i, 1); page.cards.push(c); }
    else if (k === "back") { page.cards.splice(i, 1); page.cards.unshift(c); }
    else if (k === "left") { c.rot = Math.round(((c.rot || 0) - 5) * 10) / 10; }
    else if (k === "right") { c.rot = Math.round(((c.rot || 0) + 5) * 10) / 10; }
    saveBoard(b, function () { paint(); });
  }

  /* 指で動かす・つまんで大きさと傾きを変える */
  function wireBoard(b, page, paper) {
    if (!paper) return;
    var pts = {}, n = 0, node = null, card = null;
    var start = null, moved = false;

    function find(id) {
      var out = null;
      (page.cards || []).forEach(function (c) { if (c.id === id) out = c; });
      return out;
    }
    function put() {
      if (!node || !card) return;
      node.style.left = (card.x * 100) + "%";
      node.style.top = (card.y * 100) + "%";
      node.style.width = (card.w * 100) + "%";
      node.style.transform = "translate(-50%,-50%) rotate(" + (card.rot || 0) + "deg)";
    }

    paper.addEventListener("pointerdown", function (e) {
      var el = e.target.closest("[data-card]");
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      n++;
      if (n === 1) {
        node = el; card = el ? find(el.getAttribute("data-card")) : null;
        moved = false;
        var r = paper.getBoundingClientRect();
        start = card ? { x: card.x, y: card.y, w: card.w, rot: card.rot || 0,
                         px: e.clientX, py: e.clientY, bw: r.width, bh: r.height } : null;
        if (el) { try { paper.setPointerCapture(e.pointerId); } catch (x) {} }
      }
      if (n === 2 && card) {
        var k = Object.keys(pts), a = pts[k[0]], c2 = pts[k[1]];
        start.d = Math.hypot(a.x - c2.x, a.y - c2.y);
        start.a = Math.atan2(c2.y - a.y, c2.x - a.x) * 180 / Math.PI;
        start.w0 = card.w; start.r0 = card.rot || 0;
      }
    });

    paper.addEventListener("pointermove", function (e) {
      if (!pts[e.pointerId] || !card || !start) return;
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      moved = true;
      if (n >= 2 && start.d) {
        var k = Object.keys(pts), a = pts[k[0]], c2 = pts[k[1]];
        var d = Math.hypot(a.x - c2.x, a.y - c2.y);
        var ang = Math.atan2(c2.y - a.y, c2.x - a.x) * 180 / Math.PI;
        card.w = Math.max(0.05, Math.min(1.6, start.w0 * (d / start.d)));
        card.rot = Math.round((start.r0 + (ang - start.a)) * 10) / 10;
        put();
        return;
      }
      e.preventDefault();
      card.x = start.x + (e.clientX - start.px) / start.bw;
      card.y = start.y + (e.clientY - start.py) / start.bh;
      /* 吸い付きが入っているときは、近い線へ寄せる */
      if (b.snap) {
        var st = gridStep(b);
        card.x = snapTo(card.x, st.x);
        card.y = snapTo(card.y, st.y);
      }
      /* 紙の外へは出しきらない。つまみ出して見失わないように */
      card.x = Math.max(-0.1, Math.min(1.1, card.x));
      card.y = Math.max(-0.1, Math.min(1.1, card.y));
      put();
    });

    ["pointerup", "pointercancel"].forEach(function (nm) {
      paper.addEventListener(nm, function (e) {
        if (pts[e.pointerId]) { delete pts[e.pointerId]; n = Math.max(0, n - 1); }
        if (n > 0) return;
        var wasCard = card, had = node;
        node = null; card = null; start = null;
        if (!had) { if (boardSel) { boardSel = ""; paintStage(); } return; }
        if (!moved) {
          boardSel = had.getAttribute("data-card");
          paintStage();
          return;
        }
        if (wasCard) saveBoard(b, function () { paintBoardBar(b); paintEx(); });
      });
    });
  }

  /* 印刷に耐える大きさで描く。画面に出している目安の線は描かない */
  var BOARD_DPI = 150;

  /* 1ページぶんを絵にする。写真は画面用の小さいほうではなく、元の大きさを使う */
  function renderPage(b, page, onStep) {
    var cards = (page.cards || []).filter(function (c) { return anyItem(c.itemId); });
    var sz = paperSize(b);
    var W = Math.round(sz.w / 25.4 * BOARD_DPI);
    var H = Math.round(sz.h / 25.4 * BOARD_DPI);
    var need = cards.map(function (c) {
      var it = anyItem(c.itemId);
      return it.blobId || it.thumbId;
    });
    return ensureUrls(need).then(function () {
      var cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      var g = cv.getContext("2d");
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, W, H);
      var i = 0;
      return new Promise(function (done) {
        (function next() {
          if (i >= cards.length) { done(cv); return; }
          var c = cards[i++];
          if (onStep) onStep(i, cards.length);
          var it = anyItem(c.itemId);
          var src = urlCache[it.blobId || it.thumbId];
          if (!src) { next(); return; }
          var im = new Image();
          im.onload = function () {
            var w = c.w * W;
            var h = im.naturalHeight && im.naturalWidth
              ? w * (im.naturalHeight / im.naturalWidth) : w;
            g.save();
            g.translate(c.x * W, c.y * H);
            g.rotate((c.rot || 0) * Math.PI / 180);
            g.drawImage(im, -w / 2, -h / 2, w, h);
            g.restore();
            next();
          };
          im.onerror = function () { next(); };
          im.src = src;
        })();
      });
    });
  }

  function toJpeg(cv, q) {
    return new Promise(function (done, ng) {
      cv.toBlob(function (bl) { bl ? done(bl) : ng(new Error("画像を作れませんでした。")); },
        "image/jpeg", q || 0.92);
    });
  }

  /* ============================================================
     小さなPDF書き
     ------------------------------------------------------------
     1ページに写真を1枚、紙いっぱいに貼るだけ。
     JPEGはPDFがそのまま読める形なので、詰め直さずに入れている。
     外の部品は使わない。電波がなくても作れるように。
     ============================================================ */
  function pdfWrite(pages) {
    var chunks = [], len = 0, enc = new TextEncoder();
    function put(x) {
      var u = typeof x === "string" ? enc.encode(x) : x;
      chunks.push(u); len += u.length;
    }
    var at = [];
    function obj(n, body, stream) {
      at[n] = len;
      put(n + " 0 obj\n" + body + "\n");
      if (stream) { put("stream\n"); put(stream); put("\nendstream\n"); }
      put("endobj\n");
    }
    put("%PDF-1.4\n");
    /* ここは「このファイルは文字だけではない」という目印。生の値で置く */
    put(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    var n = pages.length, kids = [];
    for (var i = 0; i < n; i++) kids.push((3 + i * 3) + " 0 R");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + n + " >>");
    pages.forEach(function (p, k) {
      var pg = 3 + k * 3, ct = pg + 1, im = pg + 2;
      obj(pg, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + p.w + " " + p.h + "]"
        + " /Resources << /XObject << /Im0 " + im + " 0 R >> >> /Contents " + ct + " 0 R >>");
      var sc = "q\n" + p.w + " 0 0 " + p.h + " 0 0 cm\n/Im0 Do\nQ";
      obj(ct, "<< /Length " + sc.length + " >>", sc);
      obj(im, "<< /Type /XObject /Subtype /Image /Width " + p.iw + " /Height " + p.ih
        + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length "
        + p.jpg.length + " >>", p.jpg);
    });

    var top = 2 + n * 3, xref = len;
    var t = "xref\n0 " + (top + 1) + "\n0000000000 65535 f \n";
    for (var k2 = 1; k2 <= top; k2++) {
      t += ("0000000000" + at[k2]).slice(-10) + " 00000 n \n";
    }
    put(t);
    put("trailer\n<< /Size " + (top + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
    return new Blob(chunks, { type: "application/pdf" });
  }

  /* どのページを出すか選んでから作る。
     1ページだけでも、まとめてでも、出てくるものはPDFひとつ */
  function pdfSheet(b) {
    var ps = pagesOf(b);
    var live = [];
    ps.forEach(function (pg, n) { if ((pg.cards || []).length) live.push(n); });
    if (!live.length) { toast("まだ写真を貼っていません。", true); return; }
    /* 選べるものが1つしかないなら、聞かずに作る */
    if (live.length === 1) { boardPdf(b, live.slice()); return; }

    sheet('<div class="panel-head"><h3>PDFにする</h3>'
      + '<button class="iconbtn" id="pfNo" aria-label="やめる"><svg><use href="#i-x"/></svg></button></div>'
      + '<div class="panel-body"><div class="stack">'
      + (live.length > 1
          ? '<button class="rowbtn" data-pf="all"><div><b>ぜんぶ</b>'
            + "<span>" + live.length + " ページを1冊にまとめます</span></div>"
            + '<svg><use href="#i-book"/></svg></button>'
          : "")
      + live.map(function (n) {
          return '<button class="rowbtn" data-pf="' + n + '"><div><b>' + (n + 1) + " ページ目だけ</b>"
            + "<span>" + ((ps[n].cards || []).length) + " 枚</span></div>"
            + '<svg><use href="#i-doc"/></svg></button>';
        }).join("")
      + '<div class="hintline">紙の大きさは ' + esc(paperName(b)) + " のまま出ます。"
      + "iPhoneなら、出てきたPDFの共有からそのまま印刷できます。</div>"
      + "</div></div>", "dialog");

    $("pfNo").onclick = closeSheet;
    Array.prototype.forEach.call($("panel").querySelectorAll("[data-pf]"), function (bt) {
      bt.onclick = function () {
        var v = bt.getAttribute("data-pf");
        closeSheet();
        boardPdf(b, v === "all" ? null : [Number(v)]);
      };
    });
  }

  /* 選んだページを1冊のPDFにする。only を渡さなければ全部 */
  function boardPdf(b, only) {
    var all = pagesOf(b);
    var ps = all.filter(function (pg, n) {
      if (!(pg.cards || []).length) return false;
      return !only || only.indexOf(n) >= 0;
    });
    if (!ps.length) { toast("まだ写真を貼っていません。", true); return; }
    var sz = paperSize(b);
    /* PDFの寸法はポイント。1インチ72ポイント */
    var pw = Math.round(sz.w / 25.4 * 72), ph = Math.round(sz.h / 25.4 * 72);
    progress(4);
    toast("1冊にまとめています…（" + ps.length + "ページ）");
    var out = [], i = 0;
    (function next() {
      if (i >= ps.length) {
        progress(94);
        try {
          var blob = pdfWrite(out);
          var nm = "v1_" + safeName(b.name)
            + (only ? "_" + (only[0] + 1) + "ページ" : "") + "_ボード.pdf";
          handOver(blob, nm).then(function (how) {
            progress(100);
            if (how !== "cancel") toast("1冊にしました（" + ps.length + "ページ・" + mb(blob.size) + "）");
          }).catch(function (e) { progress(100); toast(why(e), true); });
        } catch (e) { progress(100); toast(why(e), true); }
        return;
      }
      var pg = ps[i++];
      progress(4 + Math.round((i / ps.length) * 86));
      renderPage(b, pg).then(function (cv) {
        return toJpeg(cv, 0.9).then(function (bl) { return bl.arrayBuffer(); })
          .then(function (ab) {
            out.push({ w: pw, h: ph, iw: cv.width, ih: cv.height, jpg: new Uint8Array(ab) });
            next();
          });
      }).catch(function (e) { progress(100); toast(why(e), true); });
    })();
  }

  /* 貼る写真を選ぶ。フォルダを跨いで全部から選べる */
  function boardPick() {
    var b = boardById(curBoard);
    if (!b) return;
    var all = (browseAll || []).filter(function (it) { return it.kind === "photo" && (it.thumbId || it.blobId); });
    all = sortItems(all);
    if (!all.length) { toast("貼れる写真がまだありません。", true); return; }
    var take = {};

    ensureUrls(all.slice(0, 200).map(function (it) { return it.thumbId || it.blobId; })).then(function () {
      sheet('<div class="panel-head"><h3>貼る写真を選ぶ</h3>'
        + '<div style="display:flex;gap:8px">'
        + '<button class="iconbtn" id="bpNo" aria-label="やめる"><svg><use href="#i-x"/></svg></button>'
        + '<button class="iconbtn ok" id="bpOk" aria-label="貼る"><svg><use href="#i-check"/></svg></button>'
        + "</div></div>"
        + '<div class="panel-body">'
        + '<div class="seekfield"><svg><use href="#i-search"/></svg>'
        + '<input id="bpQ" type="search" placeholder="フォルダ名・タグ・メモで絞る" autocomplete="off"></div>'
        + '<div class="hintline" id="bpN">まだ選んでいません</div>'
        + '<div class="pickgrid" id="bpGrid"></div></div>', "dialog");
      noAutofill($("panel"));

      function count() {
        var k = Object.keys(take).length;
        $("bpN").textContent = k ? (k + " 枚を選んでいます") : "まだ選んでいません";
      }
      /* 探すのは、フォルダの名前・カテゴリ・タグ・メモ。
         どれかに当たれば残す */
      function hay(it) {
        var ex = exById(it.exId) || {};
        return ((ex.name || "") + " " + (ex.cat || "") + " " + (ex.venue || "")
          + " " + (it.memo || "") + " " + (it.tags || []).join(" ")).toLowerCase();
      }
      function fill() {
        var q = normQ($("bpQ") ? $("bpQ").value : "");
        var rows = q ? all.filter(function (it) { return hay(it).indexOf(q) >= 0; }) : all;
        rows = rows.slice(0, 200);
        var g = $("bpGrid");
        if (!g) return;
        if (!rows.length) { g.innerHTML = '<div class="bnone">見つかりませんでした</div>'; return; }
        g.innerHTML = rows.map(function (it) {
          var src = urlCache[it.thumbId || it.blobId];
          var ex = exById(it.exId);
          return '<button class="pickcell" data-pk2="' + esc(it.id) + '" aria-pressed="'
            + (!!take[it.id]) + '">'
            + (src ? '<img src="' + src + '" alt="" loading="lazy">' : "")
            + '<span class="pkex">' + esc((ex && ex.name) || "") + "</span></button>";
        }).join("");
        Array.prototype.forEach.call(g.querySelectorAll("[data-pk2]"), function (bt) {
          bt.onclick = function () {
            var id = bt.getAttribute("data-pk2");
            if (take[id]) delete take[id]; else take[id] = 1;
            bt.setAttribute("aria-pressed", String(!!take[id]));
            count();
          };
        });
      }
      /* 絞ったときに、まだ読み込んでいない写真が出てくることがある */
      $("bpQ").oninput = function () {
        var q = normQ(this.value);
        var rows = (q ? all.filter(function (it) { return hay(it).indexOf(q) >= 0; }) : all).slice(0, 200);
        ensureUrls(rows.map(function (it) { return it.thumbId || it.blobId; })).then(fill);
      };
      fill();
      $("bpNo").onclick = function () { closeSheet(); };
      $("bpOk").onclick = function () {
        var ids = Object.keys(take);
        if (!ids.length) { closeSheet(); return; }
        /* まん中あたりから、少しずつずらして重ねて置く。
           入れ先は、いま画面に見えているページ */
        var page = shownPage(b);
        var k = (page.cards || []).length;
        ids.forEach(function (id, i) {
          var step = (k + i) % 8;
          page.cards.push({
            id: uid(), itemId: id,
            x: 0.34 + (step % 4) * 0.1, y: 0.3 + Math.floor(step / 4) * 0.22,
            w: 0.34, rot: 0
          });
        });
        saveBoard(b, function () { closeSheet(); paint(); toast(ids.length + " 枚を貼りました"); });
      };
    });
  }

  /* ============================================================
     左右スワイプ
     ============================================================ */
  function attachSwipe(el, onPrev, onNext) {
    var x0 = null, y0 = null;
    el.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) { x0 = null; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    el.addEventListener("touchend", function (e) {
      if (x0 == null) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - x0, dy = t.clientY - y0;
      x0 = null;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      if (dx < 0) onNext(); else onPrev();
    }, { passive: true });
  }

  /* ============================================================
     1件ずつ大きく見る（インデックス表示）
     ============================================================ */
  /* 下の点。数が多いときは「3 / 24」に切り替える */
  var DOTMAX = 12;

  /* 1件ぶんの見出し・メモ・タグ */
  function slideInfo(it) {
    if (!it) return "";
    var t = new Date(it.createdAt || 0);
    return '<div class="slidehead"><span class="when">'
      + t.getFullYear() + "/" + pad2(t.getMonth() + 1) + "/" + pad2(t.getDate())
      + " " + pad2(t.getHours()) + ":" + pad2(t.getMinutes()) + "</span>"
      + '<div class="slideact">'
      + '<button class="star" data-fav="' + esc(it.id) + '" aria-pressed="' + (!!it.fav) + '" aria-label="お気に入り">★</button>'
      + '<button class="ghost" data-open="' + esc(it.id) + '">編集</button>'
      + "</div></div>"
      + (it.memo ? "<p>" + esc(it.memo) + "</p>" : '<p class="empty">メモなし</p>')
      + ((it.tags && it.tags.length)
          ? '<div class="chipset">' + it.tags.map(function (x) {
              return '<span class="chip"><button class="tap" data-find="' + esc(x) + '">#' + esc(x) + "</button></span>";
            }).join("") + "</div>"
          : "");
  }

  function wireDots(list) {
    var track = $("feedTrack"), dots = $("feedDots"), info = $("feedInfo");
    var total = list.length;
    if (!track || !dots || !total) return;

    function draw(i) {
      if (total <= 1) dots.innerHTML = "";
      else if (total > DOTMAX) {
        dots.className = "dots count";
        dots.innerHTML = "<span>" + (i + 1) + " / " + total + "</span>";
      } else {
        dots.className = "dots";
        var h = "";
        for (var k = 0; k < total; k++) h += '<i' + (k === i ? ' class="on"' : "") + "></i>";
        dots.innerHTML = h;
      }
      if (info) { info.innerHTML = slideInfo(list[i]); wireSlideBtns(); }
    }

    var at = -1;
    function sync() {
      var w = track.clientWidth || 1;
      var i = Math.round(track.scrollLeft / w);
      if (i < 0) i = 0;
      if (i > total - 1) i = total - 1;
      if (i !== at) { at = i; draw(i); }
    }
    track.addEventListener("scroll", function () {
      if (track._t) return;
      track._t = setTimeout(function () { track._t = null; sync(); }, 60);
    }, { passive: true });
    draw(0); at = 0;
  }

  /* 1件ずつ大きく。横にスワイプして送る */
  function feedHtml(list) {
    var out = ['<div class="feedwrap"><div class="feedtrack" id="feedTrack">'];
    list.forEach(function (it) {
      var src = urlCache[it.blobId] || "";
      var media;
      if (it.kind === "photo") {
        media = '<img src="' + src + '" loading="lazy" decoding="async" alt="">';
      } else if (it.kind === "video") {
        media = '<video src="' + src + '" controls playsinline preload="metadata"></video>';
      } else if (it.kind === "text") {
        media = '<div class="tt">' + (it.memo ? esc(it.memo) : '<span class="ttempty">（空のメモ）</span>') + "</div>";
      } else if (it.kind === "file") {
        media = fileTile(it, true);
      } else {
        media = '<div class="wave2">';
        for (var k = 0; k < 24; k++) {
          var h = 16 + ((it.id.charCodeAt(k % it.id.length) * 7) % 78);
          media += '<i style="height:' + h + '%"></i>';
        }
        media += '</div><audio src="' + src + '" controls preload="metadata"></audio>';
      }
      var cls = it.kind === "text" ? " textonly"
              : it.kind === "file" ? " fileonly"
              : (it.kind === "audio" ? " audioonly" : "");
      out.push('<div class="fslide"><div class="slidemedia' + cls + '">' + media + "</div></div>");
    });
    out.push("</div>");
    out.push('<div class="dots" id="feedDots"></div>');
    out.push('<div class="slidebody" id="feedInfo"></div>');
    out.push("</div>");
    return out.join("");
  }

  /* 見出しの中のボタン。送るたびに付け直す */
  function wireSlideBtns() {
    var box = $("feedInfo");
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll("[data-find]"), function (b) {
      b.onclick = function (ev) { ev.stopPropagation(); searchByTag(b.getAttribute("data-find")); };
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-fav]"), function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var it = itemById(b.getAttribute("data-fav"));
        if (!it) return;
        it.fav = !it.fav;
        b.setAttribute("aria-pressed", String(it.fav));
        DB.put("items", it).catch(function (e) { toast(why(e), true); });
      };
    });
  }

  function wireFeed(list) { wireDots(list); }

  /* ============================================================
     見た目の設定
     ============================================================ */
  function lookDialog() {
    var GROUPS = [
      { key: "theme",   name: "明るさ",       opts: [["auto", "端末に合わせる"], ["light", "明るい"], ["dark", "暗い"]] },
      { key: "face",    name: "書体",         opts: [["gothic", "Helvetica"], ["din", "DIN風"], ["mincho", "明朝見出し"]] },
      { key: "density", name: "余白",         opts: [["tight", "詰める"], ["normal", "標準"], ["airy", "ゆったり"]] },
      { key: "radius",  name: "角の丸み",     opts: [["sharp", "角ばる"], ["normal", "標準"], ["soft", "丸い"]] },
      { key: "cols",    name: "一覧の列数",   opts: [["2", "2列"], ["3", "3列"], ["4", "4列"]] }
    ];

    var body = '<div class="field"><div class="label">配色</div>'
      + '<div class="swatches">'
      + PALETTES.map(function (x) {
          return '<button class="sw" data-set="palette" data-val="' + x.k + '" title="' + esc(x.name) + '"'
            + ' aria-label="' + esc(x.name) + '" aria-pressed="' + (lookOf("palette") === x.k) + '">'
            + '<i style="background:' + x.bg + '">'
            + '<b style="background:' + x.dot + '"></b></i></button>';
        }).join("")
      + '</div><div class="saveflag" id="lkPalName"></div></div>';

    GROUPS.forEach(function (g) {
      body += '<div class="field"><div class="label">' + esc(g.name) + "</div>"
        + '<div class="segs">'
        + g.opts.map(function (o) {
            return '<button data-set="' + g.key + '" data-val="' + o[0] + '" aria-pressed="'
              + (lookOf(g.key) === o[0]) + '">' + esc(o[1]) + "</button>";
          }).join("")
        + "</div></div>";
    });

    var AREAS = [
      { k: "banner", name: "上のバナー", note: "いちばん上の帯。横長がきれいに出ます" },
      { k: "bg1",    name: "上のエリア", note: "見出し・タブ・検索窓のうしろ" },
      { k: "bg2",    name: "中のエリア", note: "フォルダや写真が並ぶところ" },
      { k: "bg3",    name: "下のエリア", note: "ホーム・タグ・設定のバー" }
    ];
    var skinBody = '<div class="field"><div class="label">バナーと背景</div>'
      + '<div class="skins">' + AREAS.map(function (a) {
        var has = !!SKIN[a.k], col = recall(a.k + "col") || "";
        return '<div class="skinrow"><div class="skinname">' + esc(a.name)
          + "<span>" + esc(a.note) + "</span></div>"
          + '<div class="skinbtns">'
          + ('<button class="ghost colbtn" data-col="' + a.k + '"'
              + (col ? ' style="border-color:' + esc(col) + ';background:' + esc(col) + '"' : "") + ">色</button>")
          + '<button class="ghost" data-pick="' + a.k + '">画像</button>'
          + ((has || col) ? '<button class="ghost" data-clear="' + a.k + '">戻す</button>' : "")
          + "</div></div>";
      }).join("") + "</div>"
      + '<div class="hintline">画像を選ぶと、位置と大きさを決める画面になります。'
      + "決めたぶんだけを切り取って、この端末の中に持ちます。</div></div>";

    sheet('<div class="panel-head"><h3>見た目を整える</h3>'
      + '<button class="iconbtn ok" id="lkClose" aria-label="完了"><svg><use href="#i-check"/></svg></button></div>'
      + '<div class="panel-body">'
      + '<div class="preview">'
      + '<div class="pvname">2026AW 合同展示会</div>'
      + '<div class="pvmeta">2026-09-18 · 表参道 GYRE 4F · 12点</div>'
      + '<div class="pvgrid"><i></i><i></i><i></i><i></i></div>'
      + '<div class="pvbody">ここが本文の見え方です。余白と行の高さが変わります。</div>'
      + "</div>"
      + skinBody
      + body
      + '</div>'
      + '<div class="panel-foot"><span></span><button class="ghost" id="lkReset">はじめの設定に戻す</button></div>', "dialog");

    $("lkClose").onclick = closeSheet;

    Array.prototype.forEach.call(document.querySelectorAll("[data-pick]"), function (b) {
      b.onclick = function () { closeSheet(); pickSkin(b.getAttribute("data-pick")); };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-clear]"), function (b) {
      b.onclick = function () { closeSheet(); clearSkin(b.getAttribute("data-clear")); };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-col]"), function (b) {
      b.onclick = function () { colorDialog(b.getAttribute("data-col")); };
    });

    function palName() {
      var cur = lookOf("palette");
      for (var i = 0; i < PALETTES.length; i++) {
        if (PALETTES[i].k === cur) $("lkPalName").textContent = PALETTES[i].name;
      }
    }
    palName();

    Array.prototype.forEach.call(document.querySelectorAll("[data-set]"), function (b) {
      b.onclick = function () {
        var key = b.getAttribute("data-set");
        remember(key, b.getAttribute("data-val"));
        Array.prototype.forEach.call(document.querySelectorAll('[data-set="' + key + '"]'), function (x) {
          x.setAttribute("aria-pressed", String(x === b));
        });
        applyLook(); palName(); paintStage();
      };
    });

    $("lkReset").onclick = function () {
      LOOK.forEach(function (o) { try { localStorage.removeItem("expo." + o.key); } catch (e) {} });
      applyLook(); paintStage(); closeSheet();
      toast("はじめの設定に戻しました");
    };
  }

  /* ============================================================
     アプリ内カメラ
     写真アプリ（カメラロール）には保存されず、このアプリの中だけに入る
     ============================================================ */
  function camera() {
    if (!curEx) { toast("先に" + LL() + "をつくってください。", true); newExDialog(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("この端末ではアプリ内カメラが使えません。「取り込む」から選んでください。", true);
      return;
    }

    var box = $("cam"), stream = null, facing = "environment";
    var shots = [], busy = false, closed = false;
    var exAt = curEx, tAt = (curTag !== "all" && curTag !== "none") ? [curTag] : [];

    box.className = "cam on";
    document.body.style.overflow = "hidden";
    box.innerHTML = '<div style="margin:auto;color:#fff;font-size:13px;text-align:center;padding:24px">'
      + "カメラの使用を許可してください…<br><br>"
      + '<button class="ghost" id="camCancel" style="color:#fff;border-color:#666">やめる</button></div>';
    $("camCancel").onclick = function () { shutdown(); };

    open();

    function open() {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 2560 }, height: { ideal: 1440 } },
        audio: false
      }).then(function (st) {
        if (closed) { st.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = st; paintCam();
      }).catch(function (e) {
        shutdown();
        var n = e && e.name;
        if (n === "NotAllowedError") toast("カメラの使用が許可されませんでした。設定から許可してください。", true);
        else if (n === "NotFoundError") toast("カメラが見つかりませんでした。", true);
        else toast("カメラを使えませんでした。" + (n ? "（" + n + "）" : ""), true);
      });
    }

    function paintCam() {
      var where = (exById(exAt) || {}).name || "";
      if (tAt.length) where += " ／ #" + tAt[0];
      box.innerHTML = '<video id="camV" playsinline autoplay muted></video>'
        + '<div class="camflash" id="camF"></div>'
        + '<div class="cam-top">'
        + '<button id="camX" aria-label="閉じる"><svg><use href="#i-x"/></svg></button>'
        + '<div class="where">' + esc(where) + "</div>"
        + '<button id="camFlip" aria-label="前面と背面の切り替え"><svg><use href="#i-flip"/></svg></button>'
        + "</div>"
        + '<div class="cam-bot">'
        + '<div class="tray" id="camTray"><span id="camN">0</span></div>'
        + '<button class="shutter" id="camS" aria-label="撮る"></button>'
        + '<button class="camdone" id="camD">終わる</button>'
        + "</div>";

      var v = $("camV");
      v.srcObject = stream;
      v.play().catch(function () {});

      $("camX").onclick = function () {
        if (!shots.length) { shutdown(); return; }
        askYesNo({
          title: "撮ったぶんを捨てますか",
          body: shots.length + " 枚がまだ保存されていません。",
          ok: "捨てる"
        }, function () { shots = []; shutdown(); });
      };
      $("camFlip").onclick = function () {
        facing = facing === "environment" ? "user" : "environment";
        open();
      };
      $("camS").onclick = shoot;
      $("camD").onclick = finish;
      refreshTray();
    }

    function refreshTray() {
      var n = $("camN"), tray = $("camTray");
      if (!tray) return;
      if (!shots.length) {
        tray.innerHTML = '<span id="camN" style="opacity:.7">0</span>';
        return;
      }
      var last = shots[shots.length - 1];
      tray.innerHTML = '<img src="' + last.url + '" alt=""><b>' + shots.length + "</b>";
    }

    function shoot() {
      if (busy || !stream) return;
      busy = true;
      var v = $("camV");
      var w = v.videoWidth, h = v.videoHeight;
      if (!w || !h) { busy = false; return; }
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(v, 0, 0, w, h);
      var f = $("camF");
      if (f) { f.className = "camflash"; void f.offsetWidth; f.className = "camflash go"; }
      c.toBlob(function (b) {
        busy = false;
        if (!b) { toast("撮影できませんでした。", true); return; }
        shots.push({ blob: b, url: URL.createObjectURL(b) });
        refreshTray();
      }, "image/jpeg", 0.92);
    }

    function finish() {
      if (!shots.length) { shutdown(); return; }
      var mine = shots.slice();
      shots = [];
      shutdown();
      progress(3);
      toast(mine.length + " 枚を保存しています…");
      var done = 0, failed = 0, lastErr = "", added = [];
      var chain = Promise.resolve();
      mine.forEach(function (sh, i) {
        chain = chain.then(function () {
          return savePhoto(sh.blob, exAt, tAt, i).then(function (rec) { done++; if (rec) added.push(rec.id); }, function (e) {
            failed++; lastErr = why(e);
          }).then(function () {
            try { URL.revokeObjectURL(sh.url); } catch (e) {}
            progress(3 + Math.round(((done + failed) / mine.length) * 94));
          });
        });
      });
      chain.then(function () {
        progress(100);
        items.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        paint(); gauge();
        if (failed) toast(lastErr, true);
        else tagPrompt(added);
      });
    }

    function shutdown() {
      closed = true;
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
      shots.forEach(function (sh) { try { URL.revokeObjectURL(sh.url); } catch (e) {} });
      box.className = "cam";
      box.innerHTML = "";
      document.body.style.overflow = "";
    }
  }

  /* タグを押したら、棚に戻ってそのタグで全フォルダから集める */
  function searchByTag(t) {
    closeSheet();
    curCat = "all";
    goShelf().then(function () {
      shelfTag = t;
      paintStage();
    });
  }
})();
