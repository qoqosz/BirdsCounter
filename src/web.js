// Web build: stands in for Tauri when the page runs in a browser, so main.js can call the
// same commands. Counting runs in detector-worker.js (OpenCV.js), the history is kept in
// IndexedDB together with a copy of each photo, and dialogs use the browser's own.
// Inside the app this does nothing. Besides window.__TAURI__ it checks the address the app
// serves the page from (tauri://localhost, http://tauri.localhost), in case a webview runs
// this script before Tauri's injected one.
(function () {
  const inApp =
    window.__TAURI__ ||
    location.protocol === "tauri:" ||
    location.hostname === "tauri.localhost";
  if (inApp) return;

  const DB_NAME = "birdscounter";
  const STORES = ["entries", "thumbs", "masks", "photos"];
  const WEB_SOURCE = "web:";

  // ===== Counting =====

  let worker = null;
  let nextRequestId = 1;
  const pending = new Map();
  // The photo main.js counts, one at a time as load_photo in lib.rs, and the one the
  // worker keeps decoded.
  let loadedPhoto = null;
  let nextPhotoId = 1;
  let workerPhotoId = null;

  function startWorker() {
    if (worker) return worker;
    worker = new Worker("detector-worker.js");
    worker.onmessage = (event) => {
      const { requestId, result, error } = event.data;
      const request = pending.get(requestId);
      if (!request) return;
      pending.delete(requestId);
      if (error) request.reject(error);
      else request.resolve(result);
    };
    worker.onerror = (event) => {
      console.error("Detector worker failed:", event.message);
      for (const request of pending.values()) request.reject(event.message || "worker-failed");
      pending.clear();
      worker = null;
      workerPhotoId = null;
    };
    return worker;
  }

  function askWorker(message, transfer = []) {
    const target = startWorker();
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      target.postMessage({ ...message, requestId }, transfer);
    });
  }

  function asBytes(value) {
    if (value == null) return null;
    return value instanceof Uint8Array ? value : Uint8Array.from(value);
  }

  function loadPhoto(bytes) {
    loadedPhoto = { id: nextPhotoId++, bytes: asBytes(bytes) };
    return loadedPhoto.id;
  }

  async function processImage({ photoId, params, maskPayload, crop }) {
    if (loadedPhoto?.id !== photoId) throw "photo-missing";
    const message = { type: "process", photoId, params, crop, mask: asBytes(maskPayload) };
    if (workerPhotoId !== photoId) {
      message.bytes = loadedPhoto.bytes;
    }
    try {
      const result = await askWorker(message);
      workerPhotoId = photoId;
      return result;
    } catch (e) {
      if (e === "photo-missing") {
        workerPhotoId = null;
        return processImage({ photoId, params, maskPayload, crop });
      }
      throw e;
    }
  }

  // ===== Storage =====

  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          for (const name of STORES) {
            if (!request.result.objectStoreNames.contains(name)) {
              request.result.createObjectStore(name);
            }
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  function done(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** Runs `work(stores)` in one transaction over `names` and waits for it to commit. */
  async function transaction(names, mode, work) {
    const db = await openDb();
    const tx = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
    const committed = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? "aborted");
    });
    const result = await work(stores);
    await committed;
    return result;
  }

  async function getValue(store, key) {
    return transaction([store], "readonly", (stores) => done(stores[store].get(key)));
  }

  // Photos opened in this tab, stored with their first history entry.
  const openedPhotos = new Map();
  let nextOpenedPhoto = 1;

  // The photo last opened or read, most likely the one in the editor.
  let currentPhoto = null;

  function keepPhoto({ bytes, name, mime }) {
    const id = `${Date.now().toString(16)}-${nextOpenedPhoto++}`;
    openedPhotos.set(id, { bytes: asBytes(bytes), name, mime });
    currentPhoto = id;
    return `${WEB_SOURCE}${id}`;
  }

  function photoKey(source) {
    return source?.startsWith(WEB_SOURCE) ? source.slice(WEB_SOURCE.length) : null;
  }

  async function readImage({ source }) {
    const key = photoKey(source);
    if (!key) throw "photo-missing";
    currentPhoto = key;
    const opened = openedPhotos.get(key);
    if (opened) return opened.bytes;
    const stored = await getValue("photos", key);
    if (!stored) throw "photo-missing";
    return new Uint8Array(stored.bytes);
  }

  async function listEntries() {
    return transaction(["entries"], "readonly", (stores) => done(stores.entries.getAll()));
  }

  // Photos no entry links to any more (an entry saved again with another photo, or a
  // tab closed while saving) are removed once per page load.
  let photosCleaned = false;

  async function historyList() {
    const entries = await listEntries();
    entries.sort((a, b) => b.updated_at - a.updated_at);
    if (!photosCleaned) {
      photosCleaned = true;
      const used = new Set(entries.map((entry) => photoKey(entry.source)).filter(Boolean));
      transaction(["photos"], "readwrite", async (stores) => {
        const keys = await done(stores.photos.getAllKeys());
        for (const key of keys) {
          if (!used.has(key)) stores.photos.delete(key);
        }
      }).catch((e) => console.warn("Failed to clean up photos:", e));
    }
    return entries;
  }

  function isQuotaError(e) {
    return e?.name === "QuotaExceededError";
  }

  // Photos that did not fit in the storage: later saves of their entries skip the photo, so
  // each one doesn't fail again.
  const unstoredPhotos = new Set();

  /** Saves the entry and its thumbnail; when the storage is full, without the photo. */
  async function historySave(args) {
    const key = photoKey(args.entry.source);
    const withPhoto = Boolean(key) && !unstoredPhotos.has(key);
    try {
      return await saveEntry(args, withPhoto);
    } catch (e) {
      if (!withPhoto || !isQuotaError(e)) throw e;
    }
    // The entry is worth more than the photo. Opening it later reports the photo missing.
    console.warn("Storage is full, saving the history entry without its photo");
    unstoredPhotos.add(key);
    return saveEntry(args, false);
  }

  async function saveEntry({ entry, thumb, mask, updateMask }, withPhoto) {
    const now = Date.now();
    const key = photoKey(entry.source);
    const opened = withPhoto && key ? openedPhotos.get(key) : null;
    let persisted = false;
    const saved = await transaction(["entries", "thumbs", "masks", "photos"], "readwrite", async (stores) => {
      let stored = entry.id ? await done(stores.entries.get(entry.id)) : null;
      if (!stored) {
        // Deleted while open in the editor, or new: start a new entry.
        let id = now.toString(16);
        for (let n = 1; await done(stores.entries.getKey(id)); n++) {
          id = `${now.toString(16)}-${n}`;
        }
        stored = { id, created_at: now, has_mask: false };
      }
      Object.assign(stored, {
        updated_at: now,
        source: entry.source,
        owned: Boolean(entry.owned),
        name: entry.name,
        count: entry.count,
        params: entry.params,
        crop: entry.crop,
      });
      stores.thumbs.put(asBytes(thumb), stored.id);
      if (updateMask) {
        if (mask) stores.masks.put(asBytes(mask), stored.id);
        else stores.masks.delete(stored.id);
        stored.has_mask = Boolean(mask);
      }
      if (opened && !(await done(stores.photos.getKey(key)))) {
        stores.photos.put({ bytes: opened.bytes, name: opened.name, mime: opened.mime }, key);
      }
      persisted = Boolean(opened);
      stores.entries.put(stored, stored.id);
      return { ...stored };
    });
    // The photo is in IndexedDB now (readImage falls back to it), so don't keep its bytes
    // in memory. If the transaction failed, we never get here and the photo stays.
    if (persisted) openedPhotos.delete(key);
    return saved;
  }

  /** Deletes entries and the photos only they link to. */
  async function deleteEntries(ids) {
    await transaction(["entries", "thumbs", "masks", "photos"], "readwrite", async (stores) => {
      const entries = await done(stores.entries.getAll());
      const removed = new Set(ids ?? entries.map((entry) => entry.id));
      const kept = new Set(
        entries
          .filter((entry) => !removed.has(entry.id))
          .map((entry) => photoKey(entry.source))
          .filter(Boolean),
      );
      for (const entry of entries) {
        if (!removed.has(entry.id)) continue;
        stores.entries.delete(entry.id);
        stores.thumbs.delete(entry.id);
        stores.masks.delete(entry.id);
        const key = photoKey(entry.source);
        if (!key || kept.has(key)) continue;
        // The editor may still show it and save it again as a new entry: keep its bytes.
        if (key === currentPhoto && !openedPhotos.has(key)) {
          const stored = await done(stores.photos.get(key));
          if (stored) openedPhotos.set(key, stored);
        }
        stores.photos.delete(key);
      }
    });
  }

  async function storedBytes(store, id) {
    const bytes = await getValue(store, id);
    if (!bytes) throw `Missing ${store}: ${id}`;
    return bytes;
  }

  // ===== Commands =====

  const commands = {
    load_photo: loadPhoto,
    process_image: processImage,
    web_keep_photo: keepPhoto,
    read_image: readImage,
    history_list: historyList,
    history_save: historySave,
    history_thumb: ({ id }) => storedBytes("thumbs", id),
    history_mask: ({ id }) => storedBytes("masks", id),
    history_delete: ({ id }) => deleteEntries([id]),
    history_clear: () => deleteEntries(null),
    set_quick_actions: () => null,
    take_quick_action: () => null,
  };

  // Opening the database once tells at startup whether the browser lets the page keep a history.
  const historyAvailable = openDb().then(
    () => true,
    (e) => {
      console.warn("IndexedDB is unavailable, the history will not be kept:", e);
      return false;
    },
  );

  async function invoke(command, args = {}) {
    const handler = commands[command];
    if (!handler) throw `Not available on the web: ${command}`;
    if (command.startsWith("history_") && !(await historyAvailable)) {
      if (command === "history_list") return [];
      throw "History is not available";
    }
    return handler(args);
  }

  window.__BIRDS_WEB__ = true;
  window.__BIRDS_WEB_HISTORY__ = historyAvailable;
  window.__TAURI__ = {
    core: { invoke },
    dialog: {
      ask: async (text) => confirm(text),
      message: async (text) => alert(text),
    },
    event: { listen: async () => () => {} },
  };

  // OpenCV.js is large: start loading it while the start screen shows.
  askWorker({ type: "init" }).catch((e) => console.error("Failed to load the detector:", e));
})();
