/* とりメモ — ホーム画面アプリ版
 *
 * 写真・録音・録画・メモはすべて端末の中（IndexedDB）に入ります。
 * サーバーには何も送りません。通信が無くても動きます。
 */
(function () {
  "use strict";

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
    if (e.name && e.name !== "Error" && m.indexOf(e.name) < 0) m += "（" + e.name + "）";
    return m;
  }

  /* ============================================================
     保存庫（IndexedDB）
     ============================================================ */
  var DB = (function () {
    var NAME = "expo-photo-note", VER = 2, dbp = null;

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
      get: function (store, id) {
        var box = {};
        return run([store], "readonly", function (t) {
          var r = t.objectStore(store).get(id);
          r.onsuccess = function () { box.v = r.result; };
          return box;
        }).then(function (b) { return b.v; });
      },
      put: function (store, obj) {
        return run([store], "readwrite", function (t) { t.objectStore(store).put(obj); return obj; });
      },
      putMany: function (pairs) {
        var names = [];
        pairs.forEach(function (p) { if (names.indexOf(p[0]) < 0) names.push(p[0]); });
        return run(names, "readwrite", function (t) {
          pairs.forEach(function (p) { t.objectStore(p[0]).put(p[1]); });
        });
      },
      del: function (store, id) {
        return run([store], "readwrite", function (t) { t.objectStore(store).delete(id); });
      },
      delMany: function (pairs) {
        var names = [];
        pairs.forEach(function (p) { if (names.indexOf(p[0]) < 0) names.push(p[0]); });
        if (!names.length) return Promise.resolve();
        return run(names, "readwrite", function (t) {
          pairs.forEach(function (p) { t.objectStore(p[0]).delete(p[1]); });
        });
      },
      wipe: function () {
        return run(["exhibitions", "brands", "items", "blobs"], "readwrite", function (t) {
          t.objectStore("exhibitions").clear();
          t.objectStore("brands").clear();
          t.objectStore("items").clear();
          t.objectStore("blobs").clear();
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

  /* 端末に保存させる（iPhoneでは共有シートが開きます） */
  function handOver(blob, filename) {
    var f = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
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
  var SORTS = [
    { k: "new", t: "新しい順" },
    { k: "old", t: "古い順" },
    { k: "fav", t: "★から" }
  ];
  var sortMode = "old";
  function sortLabel() {
    for (var i = 0; i < SORTS.length; i++) if (SORTS[i].k === sortMode) return SORTS[i].t;
    return SORTS[0].t;
  }
  function sortItems(a) {
    var out = a.slice();
    if (sortMode === "fav") {
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
    { key: "face",    attr: "data-face",    def: "mincho" },
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
    var sv = recall("sort");
    if (sv === "new" || sv === "old" || sv === "fav") sortMode = sv;
    syncViewToggle();
    paintShell();
    migrateCats().then(function () {
      return Promise.all([DB.all("exhibitions"), DB.all("templates")]);
    }).then(function (r) {
      exs = r[0].sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
      takeTemplates(r[1]);
      curEx = null;
      screen = "shelf";
      booted = true;
      /* 棚を描くのに全フォルダの中身の見出しが要る（表紙・点数・タグ） */
      return DB.all("items").then(function (all) { browseAll = all; }, function () { browseAll = []; });
    }).then(function () {
      paint();
      loadSkin();
      gauge();
      askPersist();
    }).catch(function (e) {
      booted = true;
      $("stage").innerHTML = '<div class="blank"><h2>データを開けませんでした</h2><p>' + esc(why(e)) + "</p></div>";
    });

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () {});
      });
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
    $("mini").className = "mini on";
    $("adNo").onclick = miniClose;
    $("adTry").onclick = function () {
      remember("adfree", adFree() ? "0" : "1");
      miniClose(); paintAd();
      toast(adFree() ? "広告を消しました（確認用）" : "広告を戻しました");
    };
  }

  /* 上のバナーと、3つのエリアの背景。画像は端末の中に持つ */
  var SKIN = { banner: "", bg1: "", bg2: "", bg3: "" };
  var SKIN_KEYS = ["banner", "bg1", "bg2", "bg3"];

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
    ["bg1", "bg2", "bg3"].forEach(function (k) {
      var el = areaEl(k);
      if (!el) return;
      var col = recall(k + "col");
      if (SKIN[k]) el.style.background = "url(" + SKIN[k] + ") center/cover no-repeat";
      else if (col) el.style.background = col;
      else el.style.background = "";
    });
  }

  function paintBanner() {
    var el = $("banner");
    if (!el) return;
    if (SKIN.banner) {
      el.className = "banner has";
      el.innerHTML = '<img src="' + SKIN.banner + '" alt="">';
    } else {
      el.className = "banner";
      el.innerHTML = '<span class="bmark">とりメモ</span>';
    }
  }

  /* 画像を選んで、その場所に入れる */
  var skinSlot = "";
  function pickSkin(slot) {
    skinSlot = slot;
    $("skinIn").click();
  }
  function saveSkin(file) {
    if (!file || !skinSlot) return;
    var slot = skinSlot;
    var wide = slot === "banner" ? 1200 : 1400;
    progress(10);
    shrink(file, wide, 0.82).then(function (r) {
      return DB.put("blobs", { id: "skin_" + slot, blob: r.blob });
    }).then(function () {
      return DB.get("blobs", "skin_" + slot);
    }).then(function (r) {
      try { if (SKIN[slot]) URL.revokeObjectURL(SKIN[slot]); } catch (e) {}
      SKIN[slot] = r && r.blob ? URL.createObjectURL(r.blob) : "";
      if (slot !== "banner") remember(slot + "col", "");
      progress(100);
      applySkin();
      toast("入れました");
      lookDialog();
    }).catch(function (e) { progress(100); toast(why(e), true); });
  }
  function clearSkin(slot) {
    DB.del("blobs", "skin_" + slot).catch(function () {}).then(function () {
      try { if (SKIN[slot]) URL.revokeObjectURL(SKIN[slot]); } catch (e) {}
      SKIN[slot] = "";
      if (slot !== "banner") remember(slot + "col", "");
      applySkin();
      lookDialog();
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
      pick.setAttribute("aria-label", "とりメモ");
      t.textContent = "";
      if (cb) cb.innerHTML = "";
      if (exs.length) {
        bits.push(exs.length + " フォルダ");
        bits.push(((browseAll || []).length) + " 点");
      }
      $("exMeta").innerHTML = bits.map(function (b) { return "<span>" + b + "</span>"; }).join("");
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

  /* 棚のタブ＝カテゴリ。フォルダの中のタブ＝タグ */
  function paintRail() {
    var rail = $("rail");

    if (screen === "shelf") {
      if (!exs.length) { rail.innerHTML = ""; return; }
      var cc = {}, noCat = 0;
      exs.forEach(function (e) {
        var c = (e.cat || "").trim();
        if (c) cc[c] = (cc[c] || 0) + 1; else noCat++;
      });
      var cks = Object.keys(cc).sort(function (a, b) { return a.localeCompare(b, "ja"); });
      var h = '<button class="tag" data-c="all" aria-pressed="' + (curCat === "all") + '">すべて<span class="n">' + exs.length + "</span></button>";
      cks.forEach(function (c) {
        h += '<button class="tag" data-c="' + esc(c) + '" aria-pressed="' + (curCat === c) + '">' + esc(c) + '<span class="n">' + cc[c] + "</span></button>";
      });
      if (noCat && cks.length) h += '<button class="tag" data-c="none" aria-pressed="' + (curCat === "none") + '">カテゴリなし<span class="n">' + noCat + "</span></button>";
      rail.innerHTML = h;
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

    var cover = {}, counts = {}, favs = {};
    all.forEach(function (it) {
      counts[it.exId] = (counts[it.exId] || 0) + 1;
      if (it.fav) favs[it.exId] = (favs[it.exId] || 0) + 1;
      if (it.kind !== "photo") return;
      if (!cover[it.exId] || (it.createdAt || 0) < (cover[it.exId].createdAt || 0)) cover[it.exId] = it;
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

    if (!exs.length) { stage.innerHTML = welcome(); return; }
    if (screen === "shelf") { paintShelf(stage, seq); return; }

    var list = visible();
    if (!list.length) {
      if (items.length) {
        stage.innerHTML = '<div class="nothing">この条件に合う写真はありません。</div>';
      } else {
        stage.innerHTML = '<div class="blank"><h2>' + esc((exById(curEx) || {}).name || "") + " はまだ空です</h2>"
          + '<p>下の <span class="inlineplus">＋</span> から、撮る・写真・音声・動画・メモを追加できます。'
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
        html += '<button class="frame" data-open="' + esc(it.id) + '">'
          + body
          + (tg ? '<span class="brandstrip">#' + esc(tg) + "</span>" : "")
          + '<span class="pips">' + pips + "</span></button>";
      });
      html += "</div>";
      stage.innerHTML = html;
    });
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
      + '<span>下の <span class="inlineplus">＋</span> から、撮る・写真・音声・動画・メモ。枚数の上限はありません。</span></div></li>'
      + '<li><span class="k">03</span><div><b>カテゴリで絞り込む</b>'
      + "<span>「仕事」「旅」などの名前を付けておくと、この画面の上でそれを押したとき、そのフォルダだけが並びます。</span></div></li>"
      + '<li><span class="k">04</span><div><b>タグで拾う</b>'
      + "<span>写真1枚に何個でも。＃を押すと、フォルダをまたいで同じタグの写真が集まります。★だけを抜き出すこともできます。</span></div></li>"
      + "</ol>"
      + '<button class="cta" id="goNewEx">フォルダをつくる</button></div>';
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
    if (o) { openItem(o.getAttribute("data-open")); return; }
    if (ev.target.id === "goNewEx") { newExDialog(); return; }
  });

  $("exPick").onclick = function () { if (screen === "folder") goShelf(); };

  function clearSearch() {
    query = ""; $("q").value = "";
    favOnly = false;
    var fb = $("btnFav"); if (fb) fb.setAttribute("aria-pressed", "false");
  }

  /* 棚へ戻る。フォルダが並んでいるところ */
  function goShelf() {
    screen = "shelf";
    clearSearch(); shelfTag = "";
    dropUrls(); items = [];
    return DB.all("items").then(function (all) { browseAll = all; }, function () {})
      .then(function () { paint(); gauge(); });
  }

  /* フォルダを開く。中の写真・録音・メモが並ぶ */
  function openFolder(id) {
    if (!id) return Promise.resolve();
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
    var i = 0;
    for (var k = 0; k < SORTS.length; k++) if (SORTS[k].k === sortMode) i = k;
    sortMode = SORTS[(i + 1) % SORTS.length].k;
    remember("sort", sortMode);
    this.textContent = sortLabel();
    paintStage();
  };
  Array.prototype.forEach.call(document.querySelectorAll("[data-nav]"), function (b) {
    b.onclick = function () {
      var k = b.getAttribute("data-nav");
      if (k === "home") { if (screen === "folder") goShelf(); else window.scrollTo({ top: 0, behavior: "smooth" }); }
      else if (k === "tags") { tagSheet(screen === "folder" ? "folder" : "shelf"); return; }
      else if (k === "add") { if (screen === "shelf") newExDialog(); else addMenu(); return; }
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
      { g: "端末から取り込む", rows: [
        { k: "pick",   t: "写真", d: "カメラロールから。まとめて何枚でも",          i: "i-plus" },
        { k: "impVid", t: "動画", d: "撮りためた動画をそのまま。変換しません",       i: "i-vid" },
        { k: "impAud", t: "音声", d: "ボイスメモや録音ファイルをそのまま",           i: "i-mic" }
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
        else if (k === "text") addTextMemo();
        else if (k === "note") newExDialog();
        else record(k);
      };
    });
  }

  /* ============================================================
     シートとダイアログ
     ============================================================ */
  function sheet(html, cls) {
    $("panel").innerHTML = html;
    $("scrim").className = "scrim on" + (cls ? " " + cls : "");
    document.body.style.overflow = "hidden";
  }
  function closeSheet() {
    $("scrim").className = "scrim";
    $("panel").innerHTML = "";
    document.body.style.overflow = "";
  }
  $("scrim").onclick = function (e) { if (e.target === this) closeSheet(); };

  function miniClose() { $("mini").className = "mini"; $("minibox").innerHTML = ""; }
  $("mini").onclick = function (e) { if (e.target === this) miniClose(); };

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if ($("mini").className.indexOf("on") >= 0) { miniClose(); return; }
    if ($("scrim").className.indexOf("on") >= 0) closeSheet();
  });

  function askText(o, done) {
    $("minibox").innerHTML = "<h4>" + esc(o.title) + "</h4>"
      + (o.body ? "<p>" + esc(o.body) + "</p>" : "")
      + '<input class="inp" id="miTxt" value="' + esc(o.value || "") + '" placeholder="' + esc(o.placeholder || "") + '">'
      + '<div class="minibtns"><button class="ghost" id="miNo">やめる</button>'
      + '<button class="cta" id="miYes">' + esc(o.ok || "決定") + "</button></div>";
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
    $("mini").className = "mini on";
    $("miYes").onclick = function () { miniClose(); done(); };
    $("miNo").onclick = function () { miniClose(); if (o.cancel) o.cancel(); };
  }

  /* ============================================================
     展示会
     ============================================================ */
  function newExDialog(ex) {
    var e = ex || { name: "", date: today(), venue: "", note: "", cat: "" };
    var tpl = tplChips(e.tpl || "");

    sheet('<div class="panel-head"><h3>' + (ex ? "この" + esc(LL(e)) + "の設定" : "新しく作る") + "</h3>"
      + '<button class="iconbtn" id="dxClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div>'
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
      + '<div class="panel-foot">'
      + (ex ? '<button class="danger" id="exDel">この展示会を削除</button>' : "<span></span>")
      + '<button class="cta" id="exSave">' + (ex ? "保存する" : "つくる") + "</button></div>", "dialog");

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

  /* 1枚を大小2つのJPEGにして保存する。取り込みとアプリ内カメラで共用 */
  function savePhoto(src, exAt, tAt, nudge) {
    return Promise.all([shrink(src, 2048, 0.86), shrink(src, 400, 0.72)]).then(function (r) {
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
    var exAt = curEx;
    var tAt = (curTag !== "all" && curTag !== "none") ? [curTag] : [];
    var done = 0, failed = 0, lastErr = "", added = [];
    progress(2);
    toast(list.length + " 枚を取り込んでいます…");

    var chain = Promise.resolve();
    list.forEach(function (f, n) {
      chain = chain.then(function () {
        return savePhoto(f, exAt, tAt, n).then(function (rec) { done++; if (rec) added.push(rec.id); }, function (e) {
          failed++; lastErr = why(e);
        }).then(function () {
          progress(Math.round(((done + failed) / list.length) * 100));
        });
      });
    });

    chain.then(function () {
      progress(100);
      items.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      paint(); gauge();
      if (failed && !done) toast(failed + " 枚とも失敗：" + lastErr, true);
      else if (failed) toast(done + " 枚を追加（" + failed + " 枚失敗：" + lastErr + "）", true);
      else tagPrompt(added);
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

  /* 保存するときの拡張子。取り込んだファイルは元の名前・形式を尊重する */
  function extOf(it) {
    if (it.kind === "photo") return "jpg";
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
      if (it.kind === "photo") media = '<img class="shot" id="mShot" src="' + src + '" alt="">';
      else if (it.kind === "video") media = '<video class="play" id="mShot" src="' + src + '" controls playsinline preload="metadata"></video>';
      else if (it.kind === "text") media = "";
      else media = '<audio src="' + src + '" controls preload="metadata"></audio>';

      var kindJa = it.kind === "photo" ? "写真" : it.kind === "video" ? "動画" : it.kind === "text" ? "メモ" : "録音";
      var stamp = new Date(it.createdAt || Date.now());

      sheet('<div class="panel-head">'
        + "<h3>" + pad2(pos) + " ／ " + kindJa + "</h3>"
        + '<div style="display:flex;gap:8px">'
        + '<button class="iconbtn" id="mFav" title="お気に入り" aria-pressed="' + (!!it.fav) + '" style="color:' + (it.fav ? "var(--mark)" : "var(--ink3)") + '"><svg><use href="#i-star"/></svg></button>'
        + '<button class="iconbtn" id="mClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div></div>'
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
        + (it.name ? " ・ " + esc(it.name) : "") + "</div>"
        + "</div>"
        + '<div class="panel-foot">'
        + '<button class="danger" id="mDel">削除</button>'
        + (it.blobId ? '<button class="ghost" id="mDl">この' + kindJa + "を共有</button>" : "<span></span>")
        + "</div>");

      $("mClose").onclick = closeSheet;

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
        var base = safeName((exById(curEx) || {}).name) + "_" + pad2(pos);
        DB.get("blobs", it.blobId).then(function (r) {
          if (!r || !r.blob) throw new Error("元のデータが見つかりませんでした。");
          return handOver(r.blob, base + "." + ext);
        }).then(function (how) {
          if (how !== "cancel") toast("書き出しました");
        }).catch(function (e) { toast(why(e), true); });
      };
    });
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
      + " ／ メモ " + list.filter(function (i) { return i.kind === "text"; }).length + "）");
    L.push("");

    list.forEach(function (it, n) {
      var kindJa = it.kind === "photo" ? "写真" : it.kind === "video" ? "動画" : it.kind === "text" ? "メモ" : "録音";
      var t = new Date(it.createdAt || 0);
      L.push("");
      L.push("## " + pad2(n + 1) + ". " + kindJa
        + "（" + pad2(t.getHours()) + ":" + pad2(t.getMinutes())
        + (it.durMs ? " ・ " + clock(it.durMs) : "") + "）" + (it.fav ? " ★" : ""));
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

  function exportSheet(ex, src) {

    sheet('<div class="panel-head"><h3>このフォルダを共有する</h3>'
      + '<button class="iconbtn" id="xClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div>'
      + '<div class="panel-body"><div class="stack">'
      + '<button class="rowbtn" id="xZip"><div><b>写真とメモ（ZIP）</b>'
      + "<span>写真・動画・録音をまとめて、メモも同梱。相手がとりメモを使っていなくても開けます。</span></div>"
      + '<svg><use href="#i-share"/></svg></button>'
      + '<button class="rowbtn" id="xMd"><div><b>メモだけ（Markdown）</b>'
      + "<span>撮った順に並べた文章。原稿を書くときはこれ。</span></div>"
      + '<svg><use href="#i-share"/></svg></button>'
      + '<button class="rowbtn" id="xPack"><div><b>まるごと（とりメモに読み込める形）</b>'
      + "<span>別の端末のとりメモで「バックアップから戻す」を使うと、このフォルダがそのまま入ります。</span></div>"
      + '<svg><use href="#i-share"/></svg></button>'
      + "</div>"
      + '<div class="hintline" style="margin-top:10px">iPhoneでは共有シートが開きます。AirDrop・LINE・メール・ファイルアプリへそのまま送れます</div>'
      + "</div>", "dialog");

    $("xClose").onclick = closeSheet;

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
        var nm = folder + "/" + pad2(n + 1) + (head ? "_" + safeName(head) : "") + "." + ext;
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
     設定・バックアップ
     ============================================================ */
  function menuDialog() {
    sheet('<div class="panel-head">'
      + '<h3><span style="color:var(--mark)">とり</span>メモ</h3>'
      + '<button class="iconbtn" id="sClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div>'
      + '<div class="panel-body"><div class="stack">'
      + '<button class="rowbtn" id="sNew"><div><b>新しく作る</b>'
      + '<span>テンプレートを選んで、フォルダを1つ作ります</span></div><svg><use href="#i-plus"/></svg></button>'
      + (screen === "folder" ? '<button class="rowbtn" id="sExport"><div><b>このフォルダを共有する</b><span>AirDrop・LINE・メールへ。端末の共有シートが開きます</span></div><svg><use href="#i-share"/></svg></button>' : "")
      + (screen === "folder" ? '<button class="rowbtn" id="sEdit"><div><b>このフォルダの設定</b><span>名前・カテゴリ・日付・場所・フォーマット・削除</span></div><svg><use href="#i-book"/></svg></button>' : "")
      + '<button class="rowbtn" id="sTags"><div><b>タグを見る・整理する</b>'
      + "<span>付けたタグの一覧。名前の付け替えと削除もここで</span></div><svg><use href=\"#i-tag\"/></svg></button>"
      + '<button class="rowbtn" id="sLook"><div><b>見た目を整える</b><span>配色・明るさ・書体・余白・角の丸み・列数</span></div><svg><use href="#i-paint"/></svg></button>'
      + '<button class="rowbtn" id="sAd"><div><b>広告を消す</b>'
      + "<span>" + (adFree() ? "いまは消えています" : "買い切り。毎月の支払いはありません") + "</span></div>"
      + '<svg><use href="#i-star"/></svg></button>'
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
    var meta = { version: 2, madeAt: new Date().toISOString(), exhibitions: [], items: [], templates: [] };
    var entries = [], blobIds = [];

    return Promise.all([DB.all("exhibitions"), DB.all("items"), DB.all("templates")]).then(function (r) {
      meta.exhibitions = exFilter ? r[0].filter(exFilter) : r[0];
      meta.items = itFilter ? r[1].filter(itFilter) : r[1];
      meta.templates = r[2] || [];
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
      return handOver(zip, "v1_とりメモ_バックアップ_" + today() + ".zip").then(function (how) {
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
      Object.keys(blobs).forEach(function (id) {
        var it = (meta.items || []).filter(function (x) { return x.blobId === id || x.thumbId === id; })[0];
        var type = it ? (it.thumbId === id && it.kind === "photo" ? "image/jpeg" : (it.mime || "application/octet-stream")) : "application/octet-stream";
        pairs.push(["blobs", { id: id, blob: new Blob([blobs[id]], { type: type }) }]);
      });

      progress(60);
      return DB.putMany(pairs).then(function () {
        curEx = null; screen = "shelf"; curCat = "all";
        return Promise.all([DB.all("exhibitions"), DB.all("templates")]);
      }).then(function (r) {
        exs = r[0].sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
        takeTemplates(r[1]);
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
      } else {
        media = '<div class="wave2">';
        for (var k = 0; k < 24; k++) {
          var h = 16 + ((it.id.charCodeAt(k % it.id.length) * 7) % 78);
          media += '<i style="height:' + h + '%"></i>';
        }
        media += '</div><audio src="' + src + '" controls preload="metadata"></audio>';
      }
      var cls = it.kind === "text" ? " textonly" : (it.kind === "audio" ? " audioonly" : "");
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
      { key: "face",    name: "見出しの書体", opts: [["mincho", "明朝"], ["gothic", "ゴシック"]] },
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
      { k: "banner", name: "上のバナー", note: "画像だけ。横長がきれいに出ます" },
      { k: "bg1",    name: "上のエリア", note: "見出し・タブ・検索窓のうしろ" },
      { k: "bg2",    name: "中のエリア", note: "フォルダや写真が並ぶところ" },
      { k: "bg3",    name: "下のエリア", note: "ホーム・タグ・設定のバー" }
    ];
    var skinBody = '<div class="field"><div class="label">バナーと背景</div>'
      + '<div class="skins">' + AREAS.map(function (a) {
        var has = !!SKIN[a.k], col = a.k === "banner" ? "" : (recall(a.k + "col") || "");
        return '<div class="skinrow"><div class="skinname">' + esc(a.name)
          + "<span>" + esc(a.note) + "</span></div>"
          + '<div class="skinbtns">'
          + (a.k === "banner" ? "" : '<button class="ghost colbtn" data-col="' + a.k + '"'
              + (col ? ' style="border-color:' + esc(col) + ';background:' + esc(col) + '"' : "") + ">色</button>")
          + '<button class="ghost" data-pick="' + a.k + '">画像</button>'
          + ((has || col) ? '<button class="ghost" data-clear="' + a.k + '">戻す</button>' : "")
          + "</div></div>";
      }).join("") + "</div>"
      + '<div class="hintline">画像は長辺1400pxに縮めて、この端末の中に持ちます</div></div>';

    sheet('<div class="panel-head"><h3>見た目を整える</h3>'
      + '<button class="iconbtn" id="lkClose" aria-label="閉じる"><svg><use href="#i-x"/></svg></button></div>'
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
