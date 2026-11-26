// Android の共有メニューから送られた情報（Web Share Target）を受け取る。
// Workbox の Service Worker から importScripts で読み込まれ、POST の share-target だけを扱う。
// 受け取った内容はアカウントに関係なく端末の一時保管（IndexedDB: itl-share）に置き、
// アプリの「共有から登録」の画面で保存されるまで消さない（ログイン前・オフラインでも失わない）。
/* eslint-disable */
(function () {
  var DB_NAME = 'itl-share';
  var STORE = 'shares';
  var MAX_FILES = 10;
  var MAX_FILE_BYTES = 25 * 1024 * 1024;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function put(rec) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function str(v) {
    return typeof v === 'string' ? v.slice(0, 20000) : '';
  }

  self.addEventListener('fetch', function (event) {
    var req = event.request;
    if (req.method !== 'POST') return;
    var url = new URL(req.url);
    if (!/\/share-target\/?$/.test(url.pathname)) return;
    var base = url.pathname.replace(/share-target\/?$/, '');
    event.respondWith(
      (async function () {
        try {
          var form = await req.formData();
          var files = [];
          form.getAll('files').forEach(function (f) {
            if (f && typeof f !== 'string' && f.size > 0 && f.size <= MAX_FILE_BYTES && files.length < MAX_FILES) {
              files.push({ name: f.name || 'image', type: f.type || 'application/octet-stream', blob: f });
            }
          });
          var id = self.crypto.randomUUID();
          await put({
            id: id,
            receivedAt: new Date().toISOString(),
            title: str(form.get('title')),
            text: str(form.get('text')),
            url: str(form.get('url')),
            files: files,
          });
          return Response.redirect(base + '#/share?id=' + id, 303);
        } catch (e) {
          return Response.redirect(base + '#/share?error=1', 303);
        }
      })(),
    );
  });
})();
