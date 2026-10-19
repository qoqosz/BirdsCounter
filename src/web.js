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
  // Ids of the photos sent to the worker, which keeps the last one decoded.
  const photoIds = new WeakMap();
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

  async function processImage({ payload, params, maskPayload, crop }) {
    const bytes = asBytes(payload);
    let photoId = photoIds.get(bytes);
    if (!photoId) {
      photoId = nextPhotoId++;
      photoIds.set(bytes, photoId);
    }
    const message = { type: "process", photoId, params, crop, mask: asBytes(maskPayload) };
    if (workerPhotoId !== photoId) {
      message.bytes = bytes;
    }
    try {
      const result = await askWorker(message);
      workerPhotoId = photoId;
      return result;
    } catch (e) {
      if (e === "photo-missing") {
        workerPhotoId = null;
        return processImage({ payload: bytes, params, maskPayload, crop });
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

  function keepPhoto({ bytes, name, mime }) {
    const id = `${Date.now().toString(16)}-${nextOpenedPhoto++}`;
    openedPhotos.set(id, { bytes: asBytes(bytes), name, mime });
    return `${WEB_SOURCE}${id}`;
  }

  function photoKey(source) {
    return source?.startsWith(WEB_SOURCE) ? source.slice(WEB_SOURCE.length) : null;
  }

  async function readImage({ source }) {
    const key = photoKey(source);
    if (!key) throw "photo-missing";
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

  async function historySave({ entry, thumb, mask, updateMask }) {
    const now = Date.now();
    const key = photoKey(entry.source);
    const opened = key ? openedPhotos.get(key) : null;
    return transaction(["entries", "thumbs", "masks", "photos"], "readwrite", async (stores) => {
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
      stores.entries.put(stored, stored.id);
      return { ...stored };
    });
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
        if (key && !kept.has(key)) stores.photos.delete(key);
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

  async function invoke(command, args = {}) {
    const handler = commands[command];
    if (!handler) throw `Not available on the web: ${command}`;
    return handler(args);
  }

  window.__BIRDS_WEB__ = true;
  window.__TAURI__ = {
    core: { invoke },
    dialog: {
      open: async () => {
        throw "Not available on the web";
      },
      ask: async (text) => confirm(text),
      message: async (text) => alert(text),
    },
    fs: {
      readFile: async () => {
        throw "Not available on the web";
      },
    },
    event: { listen: async () => () => {} },
  };

  // OpenCV.js is large: start loading it while the start screen shows.
  askWorker({ type: "init" }).catch((e) => console.error("Failed to load the detector:", e));
})();
