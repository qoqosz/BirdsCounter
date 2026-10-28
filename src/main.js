const { invoke } = window.__TAURI__.core;
const { open, ask, message } = window.__TAURI__.dialog;
const { readFile } = window.__TAURI__.fs;
// In a browser, web.js stands in for Tauri (counting in a worker, history in IndexedDB).
const isWeb = Boolean(window.__BIRDS_WEB__);

const MIN_CROP_SIZE = 40;
const DEFAULT_MASK_BRUSH_SIZE = 24;
// Min radius filters out specks, which are a few pixels across whatever the photo size,
// so its slider has a fixed range with fine steps instead of following the photo.
const MIN_RADIUS_LIMIT = 30;
const MASK_TINT_COLOR = "#e24d5c";
// The mask is painted at up to this many pixels: at a large photo's full resolution every
// stroke is slow and iOS refuses canvases over 16.7 MP. Rust scales it up to the photo.
const MASK_MAX_PIXELS = 2048 * 2048;
// Rings around the detections, as the detector used to draw them: red for one bird,
// orange and labelled for several merged ones. Sizes are in CSS pixels, except that the
// ring keeps RING_PADDING photo pixels around the bird.
const RING_COLOR = "#ff2a2a";
const RING_CLUSTER_COLOR = "#ff8c00";
const RING_LINE_WIDTH = 2;
const RING_MIN_RADIUS = 4;
const RING_PADDING = 2;
const RING_LABEL_SIZE = 13;
// The viewer zooms in until one photo pixel spans this many device pixels.
const VIEWER_MAX_DEVICE_ZOOM = 8;
const DOUBLE_TAP_TIME = 320;
const DOUBLE_TAP_DISTANCE = 30;
const SUPPORTED_LANGS = ["en", "pl"];
const DEFAULT_LANG = "en";
// Longest side of the history thumbnails and of the photo shown in the editor (the viewer
// shows it at full resolution).
const THUMB_SIZE = 320;
// Shared pictures are the counted part of the photo, scaled down to these limits.
const SHARE_MAX_SIDE = 3000;
const SHARE_MAX_PIXELS = 8_000_000;
const PREVIEW_SIZE = 2048;
const HISTORY_SAVE_DELAY = 400;
// Error codes from the native photo code (BCNativeBridge.m, MainActivity.kt).
const NATIVE_ERRORS = {
  "camera-unavailable": "error_camera_unavailable",
  "camera-denied": "error_camera_denied",
  "photos-denied": "error_photos_denied",
  "photo-unreadable": "error_photo_unreadable",
};

let dragDropArea;
let cameraBtn;
let galleryBtn;
let cameraInput;
let previewImg;
let imagePreview;
let cropBtn;
let maskBtn;
let maskCancelBtn;
let maskDoneBtn;
let maskActions;
let processActions;
let cropActions;
let cropResetBtn;
let cropCancelBtn;
let cropDoneBtn;
let cropHint;
let settingsPanel;
let cropOverlay;
let cropBox;
let maskOverlay;
let maskCanvas;
let maskBrushControls;
let maskBrushInput;
let maskBrushValue;
let countLabel;
let countPrefix;
let countValue;
let countSuffix;
let backBtn;
let birdCanvas;
let viewResultBtn;
let viewOriginalBtn;
let detectBtn;
let viewerBtn;
let photoViewer;
let viewerCanvas;
let viewerMarksBtn;
let viewerCloseBtn;
let shareBtn;
let viewerShareBtn;
let maskBrushCursor;
let historySection;
let historyList;
let historyClearBtn;

// The photo being edited, as loaded, and where it came from (see history.rs for sources).
let sourceBytes = null;
let sourceImage = null;
let sourceUrl = null;
let sourceInfo = { source: null, name: null, owned: false };
// Region to count in, in pixels of the photo; null for the whole photo.
let cropRect = null;
// The photo as shown in the editor: scaled down (null when it is small enough), and its crop.
let fullPreviewUrl = null;
let workingPreviewUrl = null;
// Bumped whenever another photo is opened or the editor closes, so late results are dropped.
let editSession = 0;

let isPreviewVisible = false;
let isCropping = false;
let isMasking = false;
// Crop being edited, in photo pixels, and the drag that changes it.
let cropDraft = null;
let cropDragState = null;
let maskDragState = null;
// The mask covers the whole photo, at its full resolution, so it survives crop changes.
let maskBitmap = null;
let maskContext = null;
let maskHasPaint = false;
let maskPngCache = null;
let maskSnapshot = null;
let langSelect;
let translations = {};
let currentLang = DEFAULT_LANG;
let radiusInitialized = false;
let minRadiusInput;
let minRadiusValue;
let maxRadiusInput;
let maxRadiusValue;
let blurInput;
let blurValue;
let thresholdMethodSelect;
let adaptiveBlockInput;
let adaptiveBlockValue;
let adaptiveCInput;
let adaptiveCValue;
let sensitivityInput;
let sensitivityValue;
let morphKernelInput;
let morphKernelValue;
let morphOpenIterInput;
let morphOpenIterValue;
let morphCloseIterInput;
let morphCloseIterValue;
let autoInvertInput;
let invertInput;
let splitClustersInput;
let skyOnlyInput;
let isProcessing = false;
let pendingProcess = false;
let processTimer = null;
let showRings = true;
let settingsOpen = false;
let isViewerOpen = false;
// Viewer zoom: a photo pixel p is drawn at x + (p - view.x) * scale; `fit` shows all of it.
let viewerView = null;
let viewerPointers = new Map();
let viewerGesture = null;
let viewerTap = null;
let viewerLastTap = null;
let viewerFrame = 0;
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;
let tapStartTime = 0;
let tapStartX = 0;
let tapStartY = 0;
let isAndroid = false;
let isMac = false;
let isIOS = false;
// A desktop browser: the shared default look, with no camera button.
let isDesktopWeb = false;
let countingAnimationTimer = null;
let countingDotCount = 1;

// History entry id of each editing session once saved, what was saved last (to skip
// saves that change nothing), and the last result to save.
let historyIds = new Map();
let historySavedKeys = new Map();
let lastResult = null;
let maskChangedSinceSave = false;
let historySaveTimer = null;
let historySaveChain = Promise.resolve();
let historyEntries = [];
let historyThumbUrls = new Map();

function normalizeLang(lang) {
  if (!lang) return DEFAULT_LANG;
  const normalized = lang.toLowerCase();
  if (SUPPORTED_LANGS.includes(normalized)) return normalized;
  const base = normalized.split("-")[0];
  return SUPPORTED_LANGS.includes(base) ? base : DEFAULT_LANG;
}

function t(key, params = {}) {
  const value = translations[key] ?? key;
  return Object.keys(params).reduce(
    (acc, k) => acc.replaceAll(`{${k}}`, String(params[k])),
    String(value),
  );
}

async function loadTranslations(lang) {
  try {
    const res = await fetch(`i18n/${lang}.json`);
    if (!res.ok) throw new Error(`Missing translation file for ${lang}`);
    return await res.json();
  } catch (e) {
    console.warn("Failed to load translations:", e);
    if (lang !== DEFAULT_LANG) {
      return await loadTranslations(DEFAULT_LANG);
    }
    return {};
  }
}

function applyTranslations() {
  document.documentElement.lang = currentLang;
  const titleEl = document.querySelector("title[data-i18n]");
  if (titleEl) titleEl.textContent = t(titleEl.dataset.i18n);

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key =
      (isDesktopWeb && el.dataset.i18nWeb) ||
      ((isMac || isDesktopWeb) && el.dataset.i18nMac) ||
      (isAndroid && el.dataset.i18nAndroid) ||
      (isIOS && el.dataset.i18nIos) ||
      el.dataset.i18n;
    if (!key) return;
    el.textContent = t(key);
  });

  document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    const attrPairs = el.dataset.i18nAttr
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    attrPairs.forEach((pair) => {
      const [attr, key] = pair.split(":").map((part) => part.trim());
      if (!attr || !key) return;
      el.setAttribute(attr, t(key));
    });
  });
}

async function setLanguage(lang) {
  currentLang = normalizeLang(lang);
  translations = await loadTranslations(currentLang);
  applyTranslations();
  if (!countingAnimationTimer && countValue) {
    const parsed = Number(countValue.textContent);
    updateCount(Number.isFinite(parsed) ? parsed : 0);
  }
  if (langSelect) {
    langSelect.value = currentLang;
  }
  try {
    localStorage.setItem("lang", currentLang);
  } catch (e) {
    console.warn("Failed to persist language selection:", e);
  }
  renderHistory();
  updateQuickActions();
}

async function tellUser(text) {
  try {
    await message(text, { title: t("app_title") });
  } catch (e) {
    alert(text);
  }
}

async function askUser(text) {
  try {
    return await ask(text, { title: t("app_title"), kind: "warning" });
  } catch (e) {
    return confirm(text);
  }
}

function showNativeError(error) {
  const code = String(error);
  console.error("Photo error:", code);
  tellUser(NATIVE_ERRORS[code] ? t(NATIVE_ERRORS[code]) : t("alert_process_fail", { error: code }));
}

// ===== Opening photos =====

function fileName(path) {
  return path ? path.split(/[\\/]/).pop() : null;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Desktop: Tauri reports dropped files with their paths, so the history can link to them.
function setupDragAndDrop() {
  if (isWeb) {
    setupWebDragAndDrop();
    return;
  }
  const webview = window.__TAURI__.webview?.getCurrentWebview?.();
  if (!webview) return;
  webview.onDragDropEvent(async (event) => {
    const { type, paths } = event.payload;
    const accepting = !isCropping && !isMasking;
    if (type === "enter" || type === "over") {
      dragDropArea.classList.toggle("drag-over", accepting && !isPreviewVisible);
      return;
    }
    dragDropArea.classList.remove("drag-over");
    if (type !== "drop" || !accepting || !paths?.length) return;
    const path = paths.find((p) => guessMimeFromPath(p));
    if (!path) {
      alert(t("alert_drop_image"));
      return;
    }
    await openFilePath(path);
  });
}

// Browser: dropped files come without a path; web.js keeps a copy for the history.
function setupWebDragAndDrop() {
  let depth = 0;
  const accepting = () => !isCropping && !isMasking && !isPreviewVisible;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth++;
    dragDropArea.classList.toggle("drag-over", accepting());
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) dragDropArea.classList.remove("drag-over");
  });
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = accepting() ? "copy" : "none";
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    dragDropArea.classList.remove("drag-over");
    if (!accepting()) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    const file = files.find((f) => f.type.startsWith("image/") || guessMimeFromPath(f.name));
    if (!file) {
      alert(t("alert_drop_image"));
      return;
    }
    handleFileObject(file);
  });
}

// Fallback for an Android build without the native bridge, and the browser: a file input.
function setupFileInputs() {
  cameraInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      handleFileObject(e.target.files[0]);
    }
    cameraInput.value = "";
  });
}

async function handleFileObject(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || guessMimeFromPath(file.name);
  const source = isWeb
    ? await invoke("web_keep_photo", { bytes, name: file.name, mime })
    : null;
  await openImage(bytes, mime, { source, name: file.name, owned: false });
}

// Browser: the camera (phones) or the file chooser, through the same file input.
function pickWebFile(camera) {
  if (camera) {
    cameraInput.setAttribute("capture", "environment");
  } else {
    cameraInput.removeAttribute("capture");
  }
  cameraInput.click();
}

async function openFilePath(path) {
  const source = `file:${path}`;
  let bytes;
  try {
    bytes = new Uint8Array(await invoke("read_image", { source }));
  } catch (e) {
    // Not a plain path (e.g. an Android content URI from the dialog)
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch (readError) {
      console.error("Error reading file:", e, readError);
      showNativeError("photo-unreadable");
      return;
    }
    await openImage(bytes, guessMimeFromPath(path), { source: null, name: fileName(path), owned: false });
    return;
  }
  await openImage(bytes, guessMimeFromPath(path), { source, name: fileName(path), owned: false });
}

// Shows a photo in the editor and counts it at once. `entry` restores a history entry
// (settings, crop and mask) instead of starting fresh.
async function openImage(bytes, mime, info, entry = null, maskBytes = null) {
  let image;
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || undefined }));
  try {
    image = await loadImage(url);
  } catch (e) {
    URL.revokeObjectURL(url);
    showNativeError("photo-unreadable");
    return;
  }
  const previewUrl = await makePreviewUrl(image, wholeRect(image));

  await flushHistorySave();
  editSession++;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  setPreviewUrls(previewUrl, null);
  sourceBytes = bytes;
  sourceImage = image;
  sourceUrl = url;
  sourceInfo = {
    source: info?.source ?? null,
    name: info?.name ?? null,
    owned: Boolean(info?.owned),
  };
  if (entry) {
    historyIds.set(editSession, entry.id);
    historySavedKeys.set(editSession, historyKey(entry));
  }
  lastResult = null;
  maskChangedSinceSave = false;
  cropRect = entry?.crop ? clampCrop(entry.crop) : null;

  resetCropUI();
  clearMaskData();
  resetMaskUI();
  if (maskBytes) {
    await restoreMask(maskBytes);
  }

  // New photos start with the largest bird size the photo allows; history entries
  // get their own settings back.
  radiusInitialized = Boolean(entry);
  updateRadiusLimits();
  if (entry) {
    applyParamsToUI(entry.params);
  }

  showPreview();
  await showWorkingPreview();
  scheduleProcess();
}

function showPreview() {
  isPreviewVisible = true;
  imagePreview.style.display = "block";
  if (countLabel) countLabel.style.display = "flex";
  if (processActions) processActions.style.display = "flex";
  setSettingsOpen(false);
  if (backBtn) backBtn.style.display = "flex";
  document.body.classList.add("has-back");
  if (dragDropArea) dragDropArea.style.display = "none";
  document.querySelector(".button-container").style.display = "none";
  if (historySection) historySection.hidden = true;
  setAndroidBackEnabled(true);
  updateCount(0);
  window.scrollTo(0, 0);
}

function resetApp() {
  flushHistorySave().then(refreshHistory);
  editSession++;
  isPreviewVisible = false;
  if (processTimer) {
    clearTimeout(processTimer);
    processTimer = null;
  }
  pendingProcess = false;
  imagePreview.style.display = "none";
  closeViewer();
  if (countLabel) countLabel.style.display = "none";
  if (processActions) processActions.style.display = "none";
  setSettingsOpen(false);
  if (backBtn) backBtn.style.display = "none";
  document.body.classList.remove("has-back");
  if (dragDropArea) dragDropArea.style.display = "flex";
  document.querySelector(".button-container").style.display = "flex";
  setAndroidBackEnabled(false);
  sourceBytes = null;
  sourceImage = null;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = null;
  sourceInfo = { source: null, name: null, owned: false };
  cropRect = null;
  lastResult = null;
  if (previewImg) previewImg.removeAttribute("src");
  setPreviewUrls(null, null);
  resetCropUI();
  clearMaskData();
  resetMaskUI();
  renderRings();
  updateCount(0);
  renderHistory();
}

function wholeRect(image) {
  return { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
}

function setPreviewUrls(full, working) {
  if (fullPreviewUrl && fullPreviewUrl !== full) URL.revokeObjectURL(fullPreviewUrl);
  if (workingPreviewUrl && workingPreviewUrl !== working) URL.revokeObjectURL(workingPreviewUrl);
  fullPreviewUrl = full;
  workingPreviewUrl = working;
}

// `rect` of the photo scaled down to PREVIEW_SIZE; null when that is the whole photo
// and it is small enough to show as it is.
async function makePreviewUrl(image, rect) {
  const scale = Math.min(1, PREVIEW_SIZE / Math.max(rect.width, rect.height));
  const whole = rect.width === image.naturalWidth && rect.height === image.naturalHeight;
  if (whole && scale === 1) return null;
  const blob = await drawToBlob(
    image,
    rect,
    Math.max(1, Math.round(rect.width * scale)),
    Math.max(1, Math.round(rect.height * scale)),
    "image/jpeg",
  );
  return blob ? URL.createObjectURL(blob) : null;
}

// The whole photo, as shown while cropping.
function fullPreviewSrc() {
  return fullPreviewUrl ?? sourceUrl;
}

// Shows the photo, cropped; the rings are drawn over it.
async function showWorkingPreview() {
  if (!sourceImage || !previewImg) return;
  setPreviewUrls(fullPreviewUrl, null);
  if (!cropRect) {
    previewImg.src = fullPreviewSrc();
    return;
  }
  const session = editSession;
  const crop = cropRect;
  const url = await makePreviewUrl(sourceImage, crop);
  if (!url) return;
  if (session !== editSession || isCropping || crop !== cropRect) {
    URL.revokeObjectURL(url);
    return;
  }
  setPreviewUrls(fullPreviewUrl, url);
  previewImg.src = url;
}

function birdsSuffix(value) {
  if (currentLang === "pl") {
    const n = Math.abs(Math.trunc(value));
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (n === 1) return t("count_suffix_one");
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
      return t("count_suffix_few");
    }
    return t("count_suffix_many");
  }
  return t("count_suffix");
}

function updateCount(value) {
  stopCountingAnimation();
  if (!countValue) return;
  countValue.textContent = String(value);
  if (countSuffix) countSuffix.textContent = birdsSuffix(value);
}

function stopCountingAnimation() {
  if (countingAnimationTimer) {
    clearInterval(countingAnimationTimer);
    countingAnimationTimer = null;
  }
  countingDotCount = 1;
  if (countPrefix) countPrefix.style.display = "";
  if (countSuffix) countSuffix.style.display = "";
}

function startCountingAnimation() {
  stopCountingAnimation();
  if (!countValue) return;

  if (countPrefix) countPrefix.style.display = "none";
  if (countSuffix) countSuffix.style.display = "none";

  const render = () => {
    countValue.textContent = `${t("counting_in_progress")}${".".repeat(countingDotCount)}`;
    countingDotCount = (countingDotCount % 3) + 1;
  };

  render();
  countingAnimationTimer = setInterval(render, 350);
}

function formatFixed(value, digits) {
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  return num.toFixed(digits);
}

function bindRangeValue(input, output, formatter) {
  if (!input || !output) return () => {};
  const format = formatter ?? ((value) => String(value));
  const update = () => {
    output.textContent = format(input.value);
    updateRangeFill(input);
  };
  input.addEventListener("input", update);
  update();
  return update;
}

function updateRangeFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--fill", `${Math.min(100, Math.max(0, pct))}%`);
}

function clampRadiusValues() {
  if (!minRadiusInput || !maxRadiusInput) return;
  const minValue = parseFloat(minRadiusInput.value);
  const maxValue = parseFloat(maxRadiusInput.value);
  if (Number.isNaN(minValue) || Number.isNaN(maxValue)) return;

  if (minValue > maxValue) {
    minRadiusInput.value = maxValue.toString();
  }
  syncSettingsOutputs();
}

// Size of the part of the photo that is counted.
function workingSize() {
  if (cropRect) return { width: cropRect.width, height: cropRect.height };
  if (sourceImage) return { width: sourceImage.naturalWidth, height: sourceImage.naturalHeight };
  return null;
}

function updateRadiusLimits() {
  if (!minRadiusInput || !maxRadiusInput) return;
  const size = workingSize();
  if (!size || !size.width || !size.height) return;

  const maxAllowed = Math.max(1, Math.min(size.width, size.height) / 2);
  minRadiusInput.max = Math.min(MIN_RADIUS_LIMIT, maxAllowed).toString();
  maxRadiusInput.max = maxAllowed.toString();

  if (!radiusInitialized) {
    maxRadiusInput.value = maxAllowed.toFixed(1);
    radiusInitialized = true;
  }

  if (parseFloat(maxRadiusInput.value) > maxAllowed) {
    maxRadiusInput.value = maxAllowed.toFixed(1);
  }
  if (parseFloat(minRadiusInput.value) > parseFloat(maxRadiusInput.value)) {
    minRadiusInput.value = Math.max(1, parseFloat(maxRadiusInput.value) - 1).toFixed(1);
  }
  syncSettingsOutputs();
}

function syncSettingsOutputs() {
  if (minRadiusInput && minRadiusValue) {
    minRadiusValue.textContent = formatFixed(minRadiusInput.value, 1);
  }
  if (maxRadiusInput && maxRadiusValue) {
    maxRadiusValue.textContent = formatFixed(maxRadiusInput.value, 1);
  }
  if (blurInput && blurValue) {
    blurValue.textContent = String(blurInput.value);
  }
  if (adaptiveBlockInput && adaptiveBlockValue) {
    adaptiveBlockValue.textContent = String(adaptiveBlockInput.value);
  }
  if (adaptiveCInput && adaptiveCValue) {
    adaptiveCValue.textContent = formatFixed(adaptiveCInput.value, 1);
  }
  if (sensitivityInput && sensitivityValue) {
    sensitivityValue.textContent = formatFixed(sensitivityInput.value, 1);
  }
  if (morphKernelInput && morphKernelValue) {
    morphKernelValue.textContent = String(morphKernelInput.value);
  }
  if (morphOpenIterInput && morphOpenIterValue) {
    morphOpenIterValue.textContent = String(morphOpenIterInput.value);
  }
  if (morphCloseIterInput && morphCloseIterValue) {
    morphCloseIterValue.textContent = String(morphCloseIterInput.value);
  }
  document.querySelectorAll('input[type="range"]').forEach(updateRangeFill);
}

// Shows only the settings used by the selected threshold method.
function updateMethodSettingsVisibility() {
  if (!thresholdMethodSelect) return;
  const method = thresholdMethodSelect.value;
  document.querySelectorAll("[data-methods]").forEach((field) => {
    const methods = field.dataset.methods.split(" ");
    field.style.display = methods.includes(method) ? "" : "none";
  });
}

function updateMaskButtonState(active) {
  if (!maskBtn) return;
  maskBtn.classList.toggle("is-active", active);
  maskBtn.setAttribute("aria-pressed", active ? "true" : "false");
}

function updateEditingState() {
  const editing = isCropping || isMasking;
  if (window.Android && typeof window.Android.setEditing === "function") {
    window.Android.setEditing(editing);
  }
  document.body.classList.toggle("is-cropping", isCropping);
  document.body.classList.toggle("is-masking", isMasking);
  if (maskActions) maskActions.style.display = isMasking ? "flex" : "none";
  if (isPreviewVisible && processActions) {
    processActions.style.display = editing ? "none" : "flex";
  }
  if (cropActions) cropActions.style.display = isCropping ? "flex" : "none";
  if (cropHint) cropHint.style.display = isCropping ? "block" : "none";
  // Rings belong to the counted crop, not to the whole photo shown while cropping.
  renderRings();
}

// ===== Rings =====
// Rust returns the detections and the rings are drawn over the photo, so they can be
// hidden and stay sharp at any zoom.

function sameCrop(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// Detections to draw over the current view, if any.
function shownBirds() {
  if (!showRings || !lastResult) return null;
  return sameCrop(lastResult.crop, cropRect) ? lastResult.birds : null;
}

// Draws a ring around each detection, a photo pixel p landing at (p - origin) * scale.
function drawRings(ctx, birds, options) {
  const {
    originX,
    originY,
    scale,
    width,
    height,
    lineWidth = RING_LINE_WIDTH,
    minRadius = RING_MIN_RADIUS,
    labelSize = RING_LABEL_SIZE,
  } = options;
  const visible = [];
  for (const bird of birds) {
    const x = (bird.x - originX) * scale;
    const y = (bird.y - originY) * scale;
    const r = Math.max(minRadius, (bird.radius + RING_PADDING) * scale);
    if (x + r < 0 || y + r < 0 || x - r > width || y - r > height) continue;
    visible.push({ x, y, r, count: bird.count });
  }

  ctx.save();
  ctx.lineWidth = lineWidth;
  for (const [color, merged] of [
    [RING_COLOR, false],
    [RING_CLUSTER_COLOR, true],
  ]) {
    ctx.beginPath();
    for (const ring of visible) {
      if ((ring.count > 1) !== merged) continue;
      ctx.moveTo(ring.x + ring.r, ring.y);
      ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
    }
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  ctx.font = `700 ${labelSize}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = "bottom";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, labelSize / 4);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillStyle = RING_CLUSTER_COLOR;
  for (const ring of visible) {
    if (ring.count <= 1) continue;
    const label = String(ring.count);
    const x = ring.x + ring.r * 0.7 + 2;
    const y = ring.y - ring.r * 0.7;
    ctx.strokeText(label, x, y);
    ctx.fillText(label, x, y);
  }
  ctx.restore();
}

// Rings over the editor's photo, at the screen's resolution.
function renderRings() {
  updateShareButtons();
  if (!birdCanvas || !previewImg) return;
  const rect = previewImg.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (birdCanvas.width !== width || birdCanvas.height !== height) {
    birdCanvas.width = width;
    birdCanvas.height = height;
  }
  const ctx = birdCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const birds = isCropping ? null : shownBirds();
  const view = viewRect();
  if (!birds || !view || rect.width <= 0) return;
  ctx.setTransform(width / rect.width, 0, 0, height / rect.height, 0, 0);
  drawRings(ctx, birds, {
    originX: view.x,
    originY: view.y,
    scale: rect.width / view.width,
    width: rect.width,
    height: rect.height,
  });
}

// Detection settings stay folded away until the Detection button opens them.
function setSettingsOpen(open) {
  settingsOpen = open;
  if (settingsPanel) settingsPanel.style.display = open && isPreviewVisible ? "flex" : "none";
  if (detectBtn) {
    detectBtn.classList.toggle("is-active", open);
    detectBtn.setAttribute("aria-pressed", open ? "true" : "false");
  }
  if (open && settingsPanel) {
    settingsPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function setShowRings(show, persist = true) {
  showRings = show;
  for (const [button, selected] of [
    [viewResultBtn, show],
    [viewOriginalBtn, !show],
  ]) {
    if (!button) continue;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
  for (const button of [viewerMarksBtn]) {
    if (!button) continue;
    button.classList.toggle("is-off", !show);
    button.setAttribute("aria-pressed", show ? "true" : "false");
  }
  if (persist) {
    try {
      localStorage.setItem("showRings", show ? "1" : "0");
    } catch (e) {
      console.warn("Failed to persist the rings setting:", e);
    }
  }
  renderRings();
  requestViewerRender();
}

// ===== Full resolution viewer =====
// Draws the visible part of the photo (or its crop) at the current zoom, so it stays
// sharp down to single pixels without scaling a huge layer.

function openViewer() {
  if (!isPreviewVisible || isCropping || isMasking || !sourceImage || !photoViewer) return;
  isViewerOpen = true;
  photoViewer.hidden = false;
  document.body.classList.add("viewer-open");
  viewerPointers.clear();
  viewerGesture = null;
  viewerTap = null;
  viewerLastTap = null;
  viewerView = null;
  layoutViewer();
  viewerCloseBtn?.focus({ preventScroll: true });
}

function closeViewer() {
  if (!isViewerOpen) return;
  isViewerOpen = false;
  photoViewer.hidden = true;
  document.body.classList.remove("viewer-open");
  viewerPointers.clear();
  viewerGesture = null;
  if (viewerFrame) cancelAnimationFrame(viewerFrame);
  viewerFrame = 0;
  // Frees the canvas memory right away; WebKit only does it when the canvas is collected.
  viewerCanvas.width = 0;
  viewerCanvas.height = 0;
}

function viewerMaxScale() {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(viewerView.fit, VIEWER_MAX_DEVICE_ZOOM / dpr);
}

// Fits the photo on open, and keeps the zoom within limits when the window changes.
function layoutViewer() {
  const view = viewRect();
  if (!isViewerOpen || !view) return;
  const width = viewerCanvas.clientWidth;
  const height = viewerCanvas.clientHeight;
  if (!width || !height) return;
  const fit = Math.min(width / view.width, height / view.height);
  if (!viewerView || viewerView.scale <= viewerView.fit) {
    viewerView = { scale: fit, fit, x: 0, y: 0 };
  } else {
    viewerView.fit = fit;
    viewerView.scale = clamp(viewerView.scale, fit, viewerMaxScale());
  }
  clampViewer();
  requestViewerRender();
}

// Centres the photo where it is smaller than the screen and keeps it covering the screen
// where it is larger.
function clampViewer() {
  const view = viewRect();
  if (!viewerView || !view) return;
  const width = viewerCanvas.clientWidth;
  const height = viewerCanvas.clientHeight;
  const shownWidth = view.width * viewerView.scale;
  const shownHeight = view.height * viewerView.scale;
  viewerView.x =
    shownWidth <= width ? (width - shownWidth) / 2 : clamp(viewerView.x, width - shownWidth, 0);
  viewerView.y =
    shownHeight <= height
      ? (height - shownHeight) / 2
      : clamp(viewerView.y, height - shownHeight, 0);
}

// Zooms keeping the photo point under (cx, cy) in place.
function zoomViewerAt(cx, cy, scale) {
  if (!viewerView) return;
  const next = clamp(scale, viewerView.fit, viewerMaxScale());
  const ratio = next / viewerView.scale;
  viewerView.x = cx - (cx - viewerView.x) * ratio;
  viewerView.y = cy - (cy - viewerView.y) * ratio;
  viewerView.scale = next;
  clampViewer();
  requestViewerRender();
}

// Double tap: zooms in to full resolution (a photo pixel per device pixel), or back out.
function toggleViewerZoom(cx, cy) {
  if (!viewerView) return;
  if (viewerView.scale > viewerView.fit * 1.01) {
    zoomViewerAt(cx, cy, viewerView.fit);
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  zoomViewerAt(cx, cy, Math.max(viewerView.fit * 2, 1 / dpr));
}

function requestViewerRender() {
  if (!isViewerOpen || viewerFrame) return;
  viewerFrame = requestAnimationFrame(renderViewer);
}

function renderViewer() {
  viewerFrame = 0;
  const view = viewRect();
  if (!isViewerOpen || !viewerView || !view || !sourceImage) return;
  const dpr = window.devicePixelRatio || 1;
  const width = viewerCanvas.clientWidth;
  const height = viewerCanvas.clientHeight;
  const canvasWidth = Math.max(1, Math.round(width * dpr));
  const canvasHeight = Math.max(1, Math.round(height * dpr));
  if (viewerCanvas.width !== canvasWidth || viewerCanvas.height !== canvasHeight) {
    viewerCanvas.width = canvasWidth;
    viewerCanvas.height = canvasHeight;
  }
  const ctx = viewerCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.setTransform(canvasWidth / width, 0, 0, canvasHeight / height, 0, 0);

  const { x, y, scale } = viewerView;
  // Only the part of the photo on screen
  const left = Math.max(view.x, view.x - x / scale);
  const top = Math.max(view.y, view.y - y / scale);
  const right = Math.min(view.x + view.width, view.x + (width - x) / scale);
  const bottom = Math.min(view.y + view.height, view.y + (height - y) / scale);
  if (right > left && bottom > top) {
    // Pixels stay pixels when zoomed in far enough to tell them apart.
    ctx.imageSmoothingEnabled = scale * dpr < 3;
    ctx.drawImage(
      sourceImage,
      left,
      top,
      right - left,
      bottom - top,
      x + (left - view.x) * scale,
      y + (top - view.y) * scale,
      (right - left) * scale,
      (bottom - top) * scale,
    );
  }
  const birds = shownBirds();
  if (birds) {
    drawRings(ctx, birds, {
      originX: view.x - x / scale,
      originY: view.y - y / scale,
      scale,
      width,
      height,
    });
  }
}

// One finger (or the mouse) pans, two fingers pinch; each change of fingers starts over
// from the current zoom, so nothing jumps.
function startViewerGesture() {
  const points = [...viewerPointers.values()];
  if (!viewerView || points.length === 0) {
    viewerGesture = null;
    return;
  }
  if (points.length === 1) {
    viewerGesture = {
      kind: "pan",
      startX: points[0].x,
      startY: points[0].y,
      x: viewerView.x,
      y: viewerView.y,
    };
    return;
  }
  const [a, b] = points;
  viewerGesture = {
    kind: "pinch",
    distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
    scale: viewerView.scale,
    x: viewerView.x,
    y: viewerView.y,
  };
}

function onViewerPointerDown(e) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  try {
    viewerCanvas.setPointerCapture(e.pointerId);
  } catch (err) {
    // The pointer is already gone; its events still arrive while over the canvas.
  }
  viewerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  viewerTap =
    viewerPointers.size === 1
      ? { id: e.pointerId, x: e.clientX, y: e.clientY, time: performance.now() }
      : null;
  startViewerGesture();
  e.preventDefault();
}

function onViewerPointerMove(e) {
  if (!viewerPointers.has(e.pointerId) || !viewerGesture || !viewerView) return;
  viewerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const points = [...viewerPointers.values()];
  const gesture = viewerGesture;
  if (gesture.kind === "pan") {
    viewerView.x = gesture.x + points[0].x - gesture.startX;
    viewerView.y = gesture.y + points[0].y - gesture.startY;
  } else if (points.length >= 2) {
    const [a, b] = points;
    const scale = clamp(
      (gesture.scale * Math.hypot(b.x - a.x, b.y - a.y)) / gesture.distance,
      viewerView.fit,
      viewerMaxScale(),
    );
    // The photo point that was under the fingers follows them.
    const ratio = scale / gesture.scale;
    viewerView.x = (a.x + b.x) / 2 - (gesture.midX - gesture.x) * ratio;
    viewerView.y = (a.y + b.y) / 2 - (gesture.midY - gesture.y) * ratio;
    viewerView.scale = scale;
  }
  clampViewer();
  requestViewerRender();
}

function onViewerPointerUp(e) {
  if (!viewerPointers.has(e.pointerId)) return;
  viewerPointers.delete(e.pointerId);
  const tap = viewerTap;
  viewerTap = null;
  if (e.type === "pointerup" && tap && tap.id === e.pointerId) {
    const now = performance.now();
    const travel = Math.hypot(e.clientX - tap.x, e.clientY - tap.y);
    if (travel < 10 && now - tap.time < 300) {
      const last = viewerLastTap;
      if (
        last &&
        now - last.time < DOUBLE_TAP_TIME &&
        Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_DISTANCE
      ) {
        viewerLastTap = null;
        toggleViewerZoom(e.clientX, e.clientY);
      } else {
        viewerLastTap = { x: e.clientX, y: e.clientY, time: now };
      }
    }
  }
  startViewerGesture();
}

// Trackpad pinch (reported with ctrlKey) or ⌘ + wheel zooms, scrolling pans.
function onViewerWheel(e) {
  if (!viewerView) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    zoomViewerAt(e.clientX, e.clientY, viewerView.scale * Math.exp(-e.deltaY * 0.01));
    return;
  }
  const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewerCanvas.clientHeight : 1;
  viewerView.x -= e.deltaX * lines;
  viewerView.y -= e.deltaY * lines;
  clampViewer();
  requestViewerRender();
}

function onViewerKeyDown(e) {
  if (!isViewerOpen || !viewerView) return;
  const cx = viewerCanvas.clientWidth / 2;
  const cy = viewerCanvas.clientHeight / 2;
  if (e.key === "Escape") {
    closeViewer();
  } else if (e.key === "+" || e.key === "=") {
    zoomViewerAt(cx, cy, viewerView.scale * 1.5);
  } else if (e.key === "-") {
    zoomViewerAt(cx, cy, viewerView.scale / 1.5);
  } else if (e.key === "0") {
    zoomViewerAt(cx, cy, viewerView.fit);
  } else {
    return;
  }
  e.preventDefault();
}

// ===== Mask =====

function updateMaskBrushControlsState() {
  if (!maskBrushControls) return;
  maskBrushControls.style.display = isMasking ? "block" : "none";
}

function updateMaskOverlayState() {
  if (!maskOverlay) return;
  maskOverlay.classList.toggle("is-active", isMasking);
  maskOverlay.classList.toggle("has-mask", maskHasPaint && !isMasking && !isCropping);
}

function updateMaskBrushValue() {
  if (!maskBrushInput || !maskBrushValue) return;
  maskBrushValue.textContent = String(maskBrushInput.value);
  updateRangeFill(maskBrushInput);
}

// Drops a canvas's pixels at once; WebKit only frees them when the canvas is collected,
// and counts them against its canvas memory limit until then.
function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function clearMaskData() {
  maskHasPaint = false;
  maskDragState = null;
  releaseCanvas(maskBitmap);
  releaseCanvas(maskSnapshot);
  maskBitmap = null;
  maskContext = null;
  maskPngCache = null;
  maskSnapshot = null;
  hideMaskBrushCursor();
  if (maskCanvas) {
    const ctx = maskCanvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    }
  }
  updateMaskOverlayState();
}

function resetMaskUI() {
  isMasking = false;
  maskDragState = null;
  releaseCanvas(maskSnapshot);
  maskSnapshot = null;
  hideMaskBrushCursor();
  updateMaskButtonState(false);
  updateEditingState();
  updateMaskBrushControlsState();
  updateMaskOverlayState();
}

// The mask covers the whole photo, scaled down to MASK_MAX_PIXELS.
function ensureMaskBitmap() {
  if (!sourceImage) return false;
  const photoWidth = sourceImage.naturalWidth;
  const photoHeight = sourceImage.naturalHeight;
  if (!photoWidth || !photoHeight) return false;
  const scale = Math.min(1, Math.sqrt(MASK_MAX_PIXELS / (photoWidth * photoHeight)));
  const width = Math.max(1, Math.round(photoWidth * scale));
  const height = Math.max(1, Math.round(photoHeight * scale));
  if (maskBitmap && maskBitmap.width === width && maskBitmap.height === height && maskContext) {
    return true;
  }

  maskBitmap = document.createElement("canvas");
  maskBitmap.width = width;
  maskBitmap.height = height;
  maskContext = maskBitmap.getContext("2d");
  if (!maskContext) {
    maskBitmap = null;
    return false;
  }
  return true;
}

async function restoreMask(bytes) {
  if (!ensureMaskBitmap()) return;
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  try {
    const image = await loadImage(url);
    maskContext.drawImage(image, 0, 0, maskBitmap.width, maskBitmap.height);
    maskHasPaint = true;
    maskPngCache = bytes;
  } catch (e) {
    console.warn("Failed to restore the mask:", e);
  } finally {
    URL.revokeObjectURL(url);
  }
  updateMaskOverlayState();
  renderMaskPreview();
}

// Part of the photo shown in the preview: the crop, or all of it.
function viewRect() {
  if (cropRect) return cropRect;
  if (!sourceImage) return null;
  return { x: 0, y: 0, width: sourceImage.naturalWidth, height: sourceImage.naturalHeight };
}

// Resizing clears the canvas, so callers redraw it when this returns true.
function syncMaskCanvasSize() {
  if (!maskCanvas || !previewImg) return false;
  const rect = previewImg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (maskCanvas.width === width && maskCanvas.height === height) return false;
  maskCanvas.width = width;
  maskCanvas.height = height;
  return true;
}

// Redraws the whole overlay from the mask. Strokes only add their own segment
// (drawMaskStroke), so this runs when the view changes, not while painting.
function renderMaskPreview() {
  if (!maskCanvas) return;
  syncMaskCanvasSize();
  const overlayCtx = maskCanvas.getContext("2d");
  if (!overlayCtx) return;
  overlayCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  const view = viewRect();
  if (!maskHasPaint || !maskBitmap || !view) return;
  const sx = maskBitmap.width / sourceImage.naturalWidth;
  const sy = maskBitmap.height / sourceImage.naturalHeight;
  overlayCtx.save();
  overlayCtx.drawImage(
    maskBitmap,
    view.x * sx,
    view.y * sy,
    view.width * sx,
    view.height * sy,
    0,
    0,
    maskCanvas.width,
    maskCanvas.height,
  );
  overlayCtx.globalCompositeOperation = "source-in";
  overlayCtx.fillStyle = MASK_TINT_COLOR;
  overlayCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  overlayCtx.restore();
}

function getMaskBrushRadiusPixels() {
  if (!maskBrushInput) return DEFAULT_MASK_BRUSH_SIZE;
  const parsed = Number(maskBrushInput.value);
  if (!Number.isFinite(parsed)) return DEFAULT_MASK_BRUSH_SIZE;
  return Math.max(1, parsed);
}

// Pointer position in photo pixels; `rect` is the overlay's, read once per stroke.
function toMaskImagePoint(clientX, clientY, rect) {
  const view = viewRect();
  if (!view || rect.width <= 0 || rect.height <= 0) return null;

  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
  const y = Math.min(Math.max(clientY - rect.top, 0), rect.height);

  return {
    x: view.x + (x / rect.width) * view.width,
    y: view.y + (y / rect.height) * view.height,
  };
}

// The brush outline is an element moved with a transform, so hovering and painting don't
// redraw any canvas.
function moveMaskBrushCursor(clientX, clientY, rect) {
  if (!maskBrushCursor) return;
  const inside =
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom;
  if (!inside && !maskDragState) {
    hideMaskBrushCursor();
    return;
  }
  const radius = getMaskBrushRadiusPixels();
  const size = `${radius * 2}px`;
  if (maskBrushCursor.style.width !== size) {
    maskBrushCursor.style.width = size;
    maskBrushCursor.style.height = size;
  }
  const x = clamp(clientX - rect.left, 0, rect.width) - radius;
  const y = clamp(clientY - rect.top, 0, rect.height) - radius;
  maskBrushCursor.style.transform = `translate(${x}px, ${y}px)`;
  maskBrushCursor.classList.add("is-visible");
}

function hideMaskBrushCursor() {
  maskBrushCursor?.classList.remove("is-visible");
}

function strokeSegment(ctx, from, to, radius, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, radius * 2);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  // Zero-length lines draw nothing, so a tap needs the dot.
  ctx.beginPath();
  ctx.arc(to.x, to.y, Math.max(0.5, radius), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Paints the segment from `from` to `to` (photo pixels) into the mask and onto the overlay.
function drawMaskStroke(from, to, rect) {
  const view = viewRect();
  if (!ensureMaskBitmap() || !maskCanvas || !view) return;
  if (rect.width <= 0 || rect.height <= 0) return;

  const brush = getMaskBrushRadiusPixels();
  const sx = maskBitmap.width / sourceImage.naturalWidth;
  const sy = maskBitmap.height / sourceImage.naturalHeight;
  const photoPerScreen = Math.max(view.width / rect.width, view.height / rect.height);
  strokeSegment(
    maskContext,
    { x: from.x * sx, y: from.y * sy },
    { x: to.x * sx, y: to.y * sy },
    brush * photoPerScreen * sx,
    "#ffffff",
  );

  const overlayCtx = maskCanvas.getContext("2d");
  if (overlayCtx) {
    const ox = maskCanvas.width / view.width;
    const oy = maskCanvas.height / view.height;
    strokeSegment(
      overlayCtx,
      { x: (from.x - view.x) * ox, y: (from.y - view.y) * oy },
      { x: (to.x - view.x) * ox, y: (to.y - view.y) * oy },
      brush * (maskCanvas.width / rect.width),
      MASK_TINT_COLOR,
    );
  }

  maskPngCache = null;
  maskChangedSinceSave = true;
  if (!maskHasPaint) {
    maskHasPaint = true;
    updateMaskOverlayState();
  }
}

// The mask as PNG; Rust scales it to the photo and crops it with it.
async function buildMaskPayload() {
  if (!maskHasPaint || !maskBitmap) return null;
  if (maskPngCache) return maskPngCache;
  const blob = await new Promise((resolve) => maskBitmap.toBlob(resolve, "image/png"));
  if (!blob) return null;
  maskPngCache = new Uint8Array(await blob.arrayBuffer());
  return maskPngCache;
}

function enterMaskMode() {
  if (!sourceImage || !maskOverlay || !maskCanvas) return;
  closeViewer();
  if (isCropping) {
    exitCropMode();
  }

  if (!ensureMaskBitmap()) return;
  // Cancel brings this back.
  releaseCanvas(maskSnapshot);
  maskSnapshot = document.createElement("canvas");
  maskSnapshot.width = maskBitmap.width;
  maskSnapshot.height = maskBitmap.height;
  maskSnapshot.getContext("2d")?.drawImage(maskBitmap, 0, 0);
  maskSnapshot.hadPaint = maskHasPaint;

  isMasking = true;
  updateMaskButtonState(true);
  updateEditingState();
  updateMaskBrushControlsState();
  updateMaskOverlayState();
  renderMaskPreview();
}

function exitMaskMode(options = {}) {
  const { process = false } = options;
  isMasking = false;
  maskDragState = null;
  releaseCanvas(maskSnapshot);
  maskSnapshot = null;
  hideMaskBrushCursor();
  updateMaskButtonState(false);
  updateEditingState();
  updateMaskBrushControlsState();
  updateMaskOverlayState();
  renderMaskPreview();
  if (process) {
    scheduleProcess();
  }
}

function cancelMaskMode() {
  if (maskSnapshot && maskContext && maskBitmap) {
    maskContext.clearRect(0, 0, maskBitmap.width, maskBitmap.height);
    maskContext.drawImage(maskSnapshot, 0, 0);
    if (maskHasPaint !== maskSnapshot.hadPaint || maskPngCache === null) {
      maskChangedSinceSave = true;
    }
    maskHasPaint = maskSnapshot.hadPaint;
    maskPngCache = null;
  }
  exitMaskMode();
}

function toggleMask() {
  if (!isMasking) {
    enterMaskMode();
    return;
  }
  exitMaskMode({ process: true });
}

// ===== Crop =====
// The whole photo is shown with the crop frame on it, so a crop can always be changed or
// undone. Corners and edges resize the frame, dragging inside moves it and dragging
// outside draws a new one.

function clampCrop(crop) {
  if (!sourceImage || !crop) return null;
  const width = sourceImage.naturalWidth;
  const height = sourceImage.naturalHeight;
  const x = Math.min(Math.max(0, Math.round(crop.x)), width - 1);
  const y = Math.min(Math.max(0, Math.round(crop.y)), height - 1);
  const w = Math.min(Math.max(1, Math.round(crop.width)), width - x);
  const h = Math.min(Math.max(1, Math.round(crop.height)), height - y);
  // A crop that keeps (nearly) everything is no crop.
  if (w >= width - 1 && h >= height - 1) return null;
  return { x, y, width: w, height: h };
}

function resetCropUI() {
  isCropping = false;
  cropDraft = null;
  cropDragState = null;
  if (cropOverlay) {
    cropOverlay.classList.remove("is-active", "is-dragging");
  }
  updateCropButtonState(false);
  updateEditingState();
  updateMaskOverlayState();
}

function updateCropButtonState(active) {
  if (!cropBtn) return;
  cropBtn.classList.toggle("is-active", active);
  cropBtn.setAttribute("aria-pressed", active ? "true" : "false");
}

// Photo pixels per displayed pixel, and the displayed size.
function cropDisplayScale() {
  const rect = previewImg.getBoundingClientRect();
  if (!sourceImage || rect.width === 0 || rect.height === 0) return null;
  return {
    sx: sourceImage.naturalWidth / rect.width,
    sy: sourceImage.naturalHeight / rect.height,
    width: rect.width,
    height: rect.height,
  };
}

function updateCropUI() {
  if (!cropDraft || !cropBox) return;
  const scale = cropDisplayScale();
  if (!scale) return;
  cropBox.style.left = `${cropDraft.x / scale.sx}px`;
  cropBox.style.top = `${cropDraft.y / scale.sy}px`;
  cropBox.style.width = `${cropDraft.width / scale.sx}px`;
  cropBox.style.height = `${cropDraft.height / scale.sy}px`;
  if (cropResetBtn) {
    cropResetBtn.disabled = clampCrop(cropDraft) === null;
  }
}

function fullCrop() {
  return { x: 0, y: 0, width: sourceImage.naturalWidth, height: sourceImage.naturalHeight };
}

async function enterCropMode() {
  if (!sourceImage || !cropOverlay) return;
  closeViewer();
  if (isMasking) {
    exitMaskMode();
  }
  isCropping = true;
  cropDraft = cropRect ? { ...cropRect } : fullCrop();
  updateCropButtonState(true);
  updateEditingState();
  updateMaskOverlayState();

  previewImg.src = fullPreviewSrc();
  try {
    await previewImg.decode();
  } catch (e) {
    // Shown once loaded; the frame follows on resize.
  }
  if (!isCropping) return;
  cropOverlay.classList.add("is-active");
  updateCropUI();
}

function exitCropMode() {
  isCropping = false;
  cropDraft = null;
  cropDragState = null;
  if (cropOverlay) {
    cropOverlay.classList.remove("is-active", "is-dragging");
  }
  updateCropButtonState(false);
  updateEditingState();
  updateMaskOverlayState();
}

function cancelCrop() {
  exitCropMode();
  showWorkingPreview();
}

function applyCrop() {
  if (!isCropping || !cropDraft) return;
  const next = clampCrop(cropDraft);
  const changed = JSON.stringify(next) !== JSON.stringify(cropRect);
  exitCropMode();
  if (!changed) {
    cancelCrop();
    return;
  }
  cropRect = next;
  updateRadiusLimits();
  showWorkingPreview();
  scheduleProcess();
}

function onCropPointerDown(e) {
  if (!isCropping || !cropDraft || cropDragState) return;
  const scale = cropDisplayScale();
  if (!scale) return;
  const overlayRect = cropOverlay.getBoundingClientRect();
  const handle = e.target.closest("[data-handle]");
  let mode = "draw";
  if (handle) {
    mode = handle.dataset.handle;
  } else if (e.target.closest(".crop-box")) {
    mode = "move";
  }
  cropDragState = {
    pointerId: e.pointerId,
    mode,
    startX: e.clientX,
    startY: e.clientY,
    originX: e.clientX - overlayRect.left,
    originY: e.clientY - overlayRect.top,
    // In displayed pixels
    start: {
      left: cropDraft.x / scale.sx,
      top: cropDraft.y / scale.sy,
      right: (cropDraft.x + cropDraft.width) / scale.sx,
      bottom: (cropDraft.y + cropDraft.height) / scale.sy,
    },
    scale,
  };
  cropOverlay.setPointerCapture(e.pointerId);
  cropOverlay.classList.add("is-dragging");
  e.preventDefault();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function onCropPointerMove(e) {
  if (!cropDragState || e.pointerId !== cropDragState.pointerId) return;
  const { mode, start, scale } = cropDragState;
  const dx = e.clientX - cropDragState.startX;
  const dy = e.clientY - cropDragState.startY;
  const W = scale.width;
  const H = scale.height;
  const min = Math.min(MIN_CROP_SIZE, W, H);
  let { left, top, right, bottom } = start;

  if (mode === "move") {
    const width = right - left;
    const height = bottom - top;
    left = clamp(left + dx, 0, W - width);
    top = clamp(top + dy, 0, H - height);
    right = left + width;
    bottom = top + height;
  } else if (mode === "draw") {
    const ax = clamp(cropDragState.originX, 0, W);
    const ay = clamp(cropDragState.originY, 0, H);
    const bx = clamp(ax + dx, 0, W);
    const by = clamp(ay + dy, 0, H);
    left = Math.min(ax, bx);
    right = Math.max(ax, bx);
    top = Math.min(ay, by);
    bottom = Math.max(ay, by);
    if (right - left < min) {
      if (bx < ax) left = Math.max(0, right - min);
      else right = Math.min(W, left + min);
      if (right - left < min) left = right - min;
    }
    if (bottom - top < min) {
      if (by < ay) top = Math.max(0, bottom - min);
      else bottom = Math.min(H, top + min);
      if (bottom - top < min) top = bottom - min;
    }
  } else {
    if (mode.includes("w")) left = clamp(left + dx, 0, right - min);
    if (mode.includes("e")) right = clamp(right + dx, left + min, W);
    if (mode.includes("n")) top = clamp(top + dy, 0, bottom - min);
    if (mode.includes("s")) bottom = clamp(bottom + dy, top + min, H);
  }

  cropDraft = {
    x: left * scale.sx,
    y: top * scale.sy,
    width: (right - left) * scale.sx,
    height: (bottom - top) * scale.sy,
  };
  updateCropUI();
}

function onCropPointerUp(e) {
  if (!cropDragState || e.pointerId !== cropDragState.pointerId) return;
  cropDragState = null;
  cropOverlay.classList.remove("is-dragging");
}

function onMaskPointerDown(e) {
  if (!isMasking || maskDragState) return;
  if (!ensureMaskBitmap() || !maskCanvas) return;

  if (syncMaskCanvasSize()) renderMaskPreview();
  const rect = maskCanvas.getBoundingClientRect();
  const point = toMaskImagePoint(e.clientX, e.clientY, rect);
  if (!point) return;

  maskDragState = {
    pointerId: e.pointerId,
    lastPoint: point,
    rect,
  };
  maskCanvas.setPointerCapture(e.pointerId);
  drawMaskStroke(point, point, rect);
  moveMaskBrushCursor(e.clientX, e.clientY, rect);
  e.preventDefault();
}

function onMaskPointerMove(e) {
  if (!maskDragState || e.pointerId !== maskDragState.pointerId) return;
  const { rect } = maskDragState;
  const next = toMaskImagePoint(e.clientX, e.clientY, rect);
  if (!next) return;
  drawMaskStroke(maskDragState.lastPoint, next, rect);
  maskDragState.lastPoint = next;
  moveMaskBrushCursor(e.clientX, e.clientY, rect);
  e.preventDefault();
}

function onMaskPointerUp(e) {
  if (!maskDragState || e.pointerId !== maskDragState.pointerId) return;
  if (maskCanvas && maskCanvas.hasPointerCapture(e.pointerId)) {
    maskCanvas.releasePointerCapture(e.pointerId);
  }
  maskDragState = null;
  // A finger leaves no hover.
  if (e.pointerType !== "mouse") hideMaskBrushCursor();
}

function onMaskPointerHover(e) {
  if (!isMasking || maskDragState) return;
  if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
  moveMaskBrushCursor(e.clientX, e.clientY, maskCanvas.getBoundingClientRect());
}

function clearMaskHover() {
  if (!isMasking || maskDragState) return;
  hideMaskBrushCursor();
}

// ===== Camera and library =====
// Every photo, from any of these, opens in the editor and is counted at once.

async function takePhoto() {
  if (isWeb) {
    pickWebFile(true);
    return;
  }
  if (isAndroid) {
    // The photo comes back through window.onNativeImageReady
    if (window.Android && typeof window.Android.openCamera === "function") {
      window.Android.openCamera();
    } else {
      cameraInput.click();
    }
    return;
  }

  if (isIOS) {
    await openNativePhoto("native_take_photo");
    return;
  }

  // For Mac (and others), use the Rust command to open Photo Booth
  try {
    await invoke("open_camera");
  } catch (error) {
    console.error("Error opening camera:", error);
    alert(t("alert_open_camera_fail"));
  }
}

async function choosePhoto() {
  if (isWeb) {
    pickWebFile(false);
    return;
  }
  if (isAndroid && window.Android && typeof window.Android.pickImage === "function") {
    window.Android.pickImage();
    return;
  }
  if (isIOS) {
    await openNativePhoto("native_pick_photo");
    return;
  }
  await openGallery();
}

// iOS: camera or photo library through BCNativeBridge (see native.rs).
async function openNativePhoto(command) {
  try {
    const picked = await invoke(command);
    if (!picked) return;
    const bytes = new Uint8Array(await invoke("take_staged_image"));
    await openImage(bytes, "image/jpeg", picked);
  } catch (e) {
    showNativeError(e);
  }
}

// iOS: a photo another app shared or opened with BirdsCounter.
async function openSharedPhoto() {
  try {
    const picked = await invoke("native_take_shared_photo");
    if (!picked) return;
    const bytes = new Uint8Array(await invoke("take_staged_image"));
    await openImage(bytes, "image/jpeg", picked);
  } catch (e) {
    showNativeError(e);
  }
}

// Android: the camera or photo picker result waits in MainActivity until taken here.
function takeAndroidResult() {
  const bridge = window.Android;
  if (!bridge || typeof bridge.takePendingResult !== "function") return;
  const json = bridge.takePendingResult();
  if (!json) return;
  let result;
  try {
    result = JSON.parse(json);
  } catch (e) {
    console.error("Bad photo result:", e);
    return;
  }
  if (result.error) {
    showNativeError(result.error);
    return;
  }
  const { data, mime, source, name, owned } = result.image;
  openImage(base64ToBytes(data), mime, { source, name, owned });
}

async function openGallery() {
  try {
    const filePath = await open({
      multiple: false,
      filters: [
        {
          name: t("file_filter_image"),
          extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"],
        },
      ],
    });
    if (filePath) {
      await openFilePath(filePath);
    }
  } catch (error) {
    console.error("Error opening gallery:", error);
  }
}

// ===== Quick actions (long press on the app icon) =====

function updateQuickActions() {
  const items = [
    { type: "take-photo", title: t("take_photo"), icon: "camera" },
    { type: "choose-photo", title: t("choose_photo"), icon: "photo.on.rectangle" },
  ];
  if (isAndroid) {
    if (window.Android && typeof window.Android.setQuickActions === "function") {
      window.Android.setQuickActions(JSON.stringify(items));
    }
  } else if (isIOS) {
    invoke("set_quick_actions", { items }).catch((e) =>
      console.warn("Failed to set quick actions:", e),
    );
  }
}

// iOS: the action the app was opened with. Android starts the camera or picker natively.
async function runQuickAction() {
  let action = null;
  try {
    action = await invoke("take_quick_action");
  } catch (e) {
    return;
  }
  if (action === "take-photo") {
    takePhoto();
  } else if (action === "choose-photo") {
    choosePhoto();
  }
}

// ===== Counting =====

function readFloat(input, fallback) {
  if (!input) return fallback;
  const value = parseFloat(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function readInt(input, fallback) {
  if (!input) return fallback;
  const value = parseInt(input.value, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readParamsFromUI() {
  return {
    min_radius: readFloat(minRadiusInput, 1.0),
    max_radius: readFloat(maxRadiusInput, 100.0),
    blur: readInt(blurInput, 3),
    threshold_method: thresholdMethodSelect ? thresholdMethodSelect.value : "background",
    adaptive_block: readInt(adaptiveBlockInput, 31),
    adaptive_c: readFloat(adaptiveCInput, 4.0),
    morph_kernel: readInt(morphKernelInput, 3),
    morph_open_iter: readInt(morphOpenIterInput, 1),
    morph_close_iter: readInt(morphCloseIterInput, 1),
    auto_invert: autoInvertInput ? autoInvertInput.checked : true,
    invert: invertInput ? invertInput.checked : false,
    sensitivity: readFloat(sensitivityInput, 9.0),
    split_clusters: splitClustersInput ? splitClustersInput.checked : true,
    sky_only: skyOnlyInput ? skyOnlyInput.checked : true,
  };
}

// Inverse of readParamsFromUI, for history entries.
function applyParamsToUI(params) {
  if (!params || typeof params !== "object") return;
  const setValue = (input, value) => {
    if (input && value !== undefined && value !== null) input.value = String(value);
  };
  const setChecked = (input, value) => {
    if (input && typeof value === "boolean") input.checked = value;
  };
  setValue(minRadiusInput, params.min_radius);
  setValue(maxRadiusInput, params.max_radius);
  setValue(blurInput, params.blur);
  setValue(thresholdMethodSelect, params.threshold_method);
  setValue(adaptiveBlockInput, params.adaptive_block);
  setValue(adaptiveCInput, params.adaptive_c);
  setValue(morphKernelInput, params.morph_kernel);
  setValue(morphOpenIterInput, params.morph_open_iter);
  setValue(morphCloseIterInput, params.morph_close_iter);
  setChecked(autoInvertInput, params.auto_invert);
  setChecked(invertInput, params.invert);
  setValue(sensitivityInput, params.sensitivity);
  setChecked(splitClustersInput, params.split_clusters);
  setChecked(skyOnlyInput, params.sky_only);
  updateMethodSettingsVisibility();
  syncSettingsOutputs();
}

function scheduleProcess() {
  if (!isPreviewVisible || !sourceBytes) return;
  if (processTimer) clearTimeout(processTimer);
  processTimer = setTimeout(() => {
    processTimer = null;
    runProcess();
  }, 100);
}

async function runProcess() {
  if (!isPreviewVisible) return;
  if (isProcessing) {
    pendingProcess = true;
    return;
  }
  isProcessing = true;
  try {
    await processImage();
  } finally {
    isProcessing = false;
    if (pendingProcess) {
      pendingProcess = false;
      runProcess();
    }
  }
}

async function processImage() {
  const bytes = sourceBytes;
  if (!bytes) {
    alert(t("alert_no_image"));
    return;
  }
  const session = editSession;

  const previousCount = countValue ? Number(countValue.textContent) : 0;
  const fallbackCount = Number.isFinite(previousCount) ? previousCount : 0;
  startCountingAnimation();

  try {
    const params = readParamsFromUI();
    const crop = cropRect ? { ...cropRect } : null;
    const maskPayload = await buildMaskPayload();
    const result = await invoke("process_image", {
      payload: ipcBytes(bytes),
      params,
      maskPayload: maskPayload ? ipcBytes(maskPayload) : null,
      crop,
    });
    if (session !== editSession) return;

    updateCount(result.count);
    lastResult = { count: result.count, params, crop, birds: result.birds };
    renderRings();
    requestViewerRender();
    scheduleHistorySave();
  } catch (e) {
    if (session !== editSession) return;
    updateCount(fallbackCount);
    console.error("Image processing failed:", e);
    alert(t("alert_process_fail", { error: e }));
  }
}

// ===== History =====
// Each photo gets one entry that follows its latest result. Saves are queued one after
// another, so the first save's id is known to the next.

function scheduleHistorySave() {
  if (historySaveTimer) clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => {
    historySaveTimer = null;
    queueHistorySave();
  }, HISTORY_SAVE_DELAY);
}

function flushHistorySave() {
  if (historySaveTimer) {
    clearTimeout(historySaveTimer);
    historySaveTimer = null;
    queueHistorySave();
  }
  return historySaveChain;
}

// Independent of key order: params come back from Rust sorted by name.
function historyKey({ count, params, crop }) {
  const sortedParams = params
    ? Object.keys(params)
        .sort()
        .map((name) => [name, params[name]])
    : null;
  const cropValues = crop ? [crop.x, crop.y, crop.width, crop.height] : null;
  return JSON.stringify([count, sortedParams, cropValues]);
}

function queueHistorySave() {
  const session = editSession;
  const result = lastResult;
  const image = sourceImage;
  const info = { ...sourceInfo };
  const updateMask = maskChangedSinceSave;
  if (!result || !image) return;
  const key = historyKey(result);
  if (!updateMask && historySavedKeys.get(session) === key) return;
  historySavedKeys.set(session, key);
  maskChangedSinceSave = false;
  const maskPromise = updateMask ? buildMaskPayload() : Promise.resolve(null);
  historySaveChain = historySaveChain
    .then(async () => {
      const [thumb, mask] = await Promise.all([makeThumbnail(image, result), maskPromise]);
      if (!thumb) return;
      const saved = await invoke("history_save", {
        entry: {
          id: historyIds.get(session) ?? null,
          source: info.source,
          owned: info.owned,
          name: info.name,
          count: result.count,
          params: result.params,
          crop: result.crop,
        },
        thumb: ipcBytes(thumb),
        mask: mask ? ipcBytes(mask) : null,
        updateMask,
      });
      historyIds.set(session, saved.id);
    })
    .catch((e) => console.error("Failed to save history:", e));
}

// The counted part of the photo with its rings.
async function makeThumbnail(image, result) {
  const rect = result.crop ?? wholeRect(image);
  const scale = Math.min(1, THUMB_SIZE / Math.max(rect.width, rect.height));
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  try {
    const blob = await drawToBlob(image, rect, width, height, "image/jpeg", (ctx) =>
      drawRings(ctx, result.birds, {
        originX: rect.x,
        originY: rect.y,
        scale: width / rect.width,
        width,
        height,
        lineWidth: 1.5,
        minRadius: 2,
        labelSize: 10,
      }),
    );
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch (e) {
    console.warn("Failed to make a thumbnail:", e);
    return null;
  }
}

async function refreshHistory() {
  try {
    historyEntries = await invoke("history_list");
  } catch (e) {
    console.error("Failed to load history:", e);
    historyEntries = [];
  }
  renderHistory();
}

function formatDate(ms) {
  try {
    return new Intl.DateTimeFormat(currentLang, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch (e) {
    return new Date(ms).toLocaleString();
  }
}

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5-1-1h-5l-1 1H5v2h14V4z"/></svg>';

const SHARE_ICON =
  '<svg class="icon-share-material" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>' +
  '<svg class="icon-share-ios" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M7 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-1"/></svg>';

const MORE_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';

// The "⋮" button of a history row opens a small menu: Share and Delete (iOS and Android; elsewhere
// the row has a Delete button).
// It lives on the body, since the list clips its children.
let historyMenu = null;

function closeHistoryMenu() {
  if (!historyMenu) return;
  historyMenu.anchor.setAttribute("aria-expanded", "false");
  historyMenu.element.remove();
  historyMenu = null;
}

function toggleHistoryMenu(button, entry, item) {
  const reopen = historyMenu?.anchor !== button;
  closeHistoryMenu();
  if (!reopen) return;

  const actions = [];
  if (canShare()) {
    actions.push({ label: t("share"), icon: SHARE_ICON, run: () => shareHistoryEntry(entry, item) });
  }
  actions.push({
    label: t("history_delete"),
    icon: TRASH_ICON,
    danger: true,
    run: () => deleteHistoryEntry(entry, true),
  });

  const menu = document.createElement("div");
  menu.className = "history-menu";
  menu.setAttribute("role", "menu");
  for (const action of actions) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "history-menu-item" + (action.danger ? " is-danger" : "");
    row.setAttribute("role", "menuitem");
    const label = document.createElement("span");
    label.textContent = action.label;
    row.append(label);
    row.insertAdjacentHTML("beforeend", action.icon);
    row.addEventListener("click", () => {
      closeHistoryMenu();
      action.run();
    });
    menu.append(row);
  }
  document.body.append(menu);

  const anchor = button.getBoundingClientRect();
  const margin = 8;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
  const below = anchor.bottom + 4;
  const top = below + height + margin > window.innerHeight ? Math.max(margin, anchor.top - height - 4) : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  button.setAttribute("aria-expanded", "true");
  historyMenu = { element: menu, anchor: button };
  menu.querySelector("button")?.focus({ preventScroll: true });
}

function renderHistory() {
  closeHistoryMenu();
  if (!historySection || !historyList) return;
  const visible = !isPreviewVisible && historyEntries.length > 0;
  historySection.hidden = !visible;
  document.body.classList.toggle("has-history", historyEntries.length > 0);
  if (!visible) return;

  const ids = new Set(historyEntries.map((entry) => entry.id));
  historyList.replaceChildren(
    ...historyEntries.map((entry) => {
      const item = document.createElement("li");
      item.className = "history-item";

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "history-open";
      const thumb = document.createElement("img");
      thumb.className = "history-thumb";
      thumb.alt = "";
      setHistoryThumb(thumb, entry);
      const text = document.createElement("span");
      text.className = "history-text";
      const count = document.createElement("span");
      count.className = "history-count";
      count.textContent = `${entry.count} ${birdsSuffix(entry.count)}`;
      const meta = document.createElement("span");
      meta.className = "history-meta";
      meta.textContent = formatDate(entry.updated_at);
      const detail = document.createElement("span");
      detail.className = "history-meta";
      detail.textContent = entry.source ? entry.name ?? "" : t("history_unlinked");
      text.append(count, meta);
      if (detail.textContent) text.append(detail);
      openButton.append(thumb, text);
      openButton.addEventListener("click", () => openHistoryEntry(entry, item));

      const moreButton = document.createElement("button");
      moreButton.type = "button";
      moreButton.className = "icon-button history-more";
      if (canShare()) {
        moreButton.setAttribute("aria-label", t("history_more"));
        moreButton.setAttribute("aria-haspopup", "menu");
        moreButton.setAttribute("aria-expanded", "false");
        moreButton.innerHTML = MORE_ICON;
        moreButton.addEventListener("click", () => toggleHistoryMenu(moreButton, entry, item));
      } else {
        // Delete is the only action without sharing, so it needs no menu.
        moreButton.setAttribute("aria-label", t("history_delete"));
        moreButton.innerHTML = TRASH_ICON;
        moreButton.addEventListener("click", () => deleteHistoryEntry(entry, true));
      }

      item.append(openButton, moreButton);
      return item;
    }),
  );

  for (const [id, cached] of historyThumbUrls) {
    if (!ids.has(id)) {
      URL.revokeObjectURL(cached.url);
      historyThumbUrls.delete(id);
    }
  }
}

async function setHistoryThumb(img, entry) {
  // Entries change their thumbnail when edited, so the key includes the update time.
  const key = `${entry.id}@${entry.updated_at}`;
  const cached = historyThumbUrls.get(entry.id);
  if (cached && cached.key === key) {
    img.src = cached.url;
    return;
  }
  try {
    const bytes = await invoke("history_thumb", { id: entry.id });
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    if (cached) URL.revokeObjectURL(cached.url);
    historyThumbUrls.set(entry.id, { key, url });
    img.src = url;
  } catch (e) {
    console.warn("Missing thumbnail:", e);
  }
}

async function loadSourceBytes(source) {
  if (isWeb) {
    return new Uint8Array(await invoke("read_image", { source }));
  }
  if (source.startsWith("photos:")) {
    return new Uint8Array(await invoke("native_load_photo", { source }));
  }
  if (isAndroid) {
    const bridge = window.Android;
    const base64 =
      bridge && typeof bridge.readImage === "function" ? bridge.readImage(source) : null;
    if (!base64) throw "photo-missing";
    return base64ToBytes(base64);
  }
  return new Uint8Array(await invoke("read_image", { source }));
}

async function openHistoryEntry(entry, item) {
  if (item.classList.contains("is-loading")) return;
  if (!entry.source) {
    await tellUser(t("history_unlinked_detail"));
    return;
  }
  item.classList.add("is-loading");
  let bytes = null;
  let error = null;
  try {
    bytes = await loadSourceBytes(entry.source);
  } catch (e) {
    error = String(e);
  } finally {
    item.classList.remove("is-loading");
  }
  if (!bytes) {
    console.warn("History photo unavailable:", error);
    if (error === "photos-denied") {
      showNativeError(error);
      return;
    }
    if (await askUser(t("history_missing"))) {
      await deleteHistoryEntry(entry, false);
    }
    return;
  }
  let mask = null;
  if (entry.has_mask) {
    try {
      mask = new Uint8Array(await invoke("history_mask", { id: entry.id }));
    } catch (e) {
      console.warn("Missing mask:", e);
    }
  }
  await openImage(bytes, guessMimeFromPath(entry.name ?? ""), entry, entry, mask);
}

async function deleteHistoryEntry(entry, confirmOwned) {
  if (confirmOwned && entry.owned && !(await askUser(t("history_delete_owned_confirm")))) {
    return;
  }
  try {
    await invoke("history_delete", { id: entry.id });
  } catch (e) {
    console.error("Failed to delete history entry:", e);
  }
  await refreshHistory();
}

async function clearHistory() {
  if (!(await askUser(t("history_clear_confirm")))) return;
  try {
    await invoke("history_clear");
  } catch (e) {
    console.error("Failed to clear history:", e);
  }
  await refreshHistory();
}

// ===== Sharing =====
// The picture is the counted part of the photo, with the rings if the user sees them, and a
// black bar under it with the count. The system share sheet takes it from there (iOS and
// Android only).

function canShare() {
  return isIOS || isAndroid;
}

function updateShareButtons() {
  const ready = Boolean(
    sourceImage && lastResult && sameCrop(lastResult.crop, cropRect) && !isCropping && !isMasking,
  );
  for (const button of [shareBtn, viewerShareBtn]) {
    if (button) button.disabled = !ready;
  }
}

// `birds` are drawn when not null. Returns a JPEG blob.
async function composeShareImage(image, rect, birds, count) {
  let scale = Math.min(
    1,
    SHARE_MAX_SIDE / Math.max(rect.width, rect.height),
    Math.sqrt(SHARE_MAX_PIXELS / (rect.width * rect.height)),
  );
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  scale = width / rect.width;
  // Rings are sized for a screen about 800 px wide.
  const k = Math.max(1, width / 800);
  const barHeight = Math.round(Math.max(36, Math.min(width, height) * 0.075));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height + barHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw "canvas-unavailable";
  try {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height + barHeight);
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
    if (birds) {
      drawRings(ctx, birds, {
        originX: rect.x,
        originY: rect.y,
        scale,
        width,
        height,
        lineWidth: RING_LINE_WIDTH * k,
        minRadius: RING_MIN_RADIUS * k,
        labelSize: RING_LABEL_SIZE * k,
      });
    }
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${Math.round(barHeight * 0.5)}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      `${t("count_prefix")} ${count} ${birdsSuffix(count)}`,
      width / 2,
      height + barHeight / 2,
      width - barHeight,
    );
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw "encoding-failed";
    return blob;
  } finally {
    releaseCanvas(canvas);
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function shareBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const name = `BirdsCounter_${Date.now()}.jpg`;
  if (isAndroid) {
    const bridge = window.Android;
    if (!bridge || typeof bridge.shareImage !== "function") throw "share-unsupported";
    bridge.shareImage(bytesToBase64(bytes), name);
  } else {
    await invoke("native_share_image", { bytes: Array.from(bytes), name });
  }
}

function shareFailed(e) {
  console.error("Failed to share:", e);
  tellUser(t("share_failed", { error: e }));
}

// What the editor shows now.
async function shareCurrentResult() {
  if (!canShare() || !sourceImage || !lastResult || !sameCrop(lastResult.crop, cropRect)) return;
  const buttons = [shareBtn, viewerShareBtn];
  for (const button of buttons) if (button) button.disabled = true;
  try {
    const rect = lastResult.crop ?? wholeRect(sourceImage);
    const blob = await composeShareImage(
      sourceImage,
      rect,
      showRings ? lastResult.birds : null,
      lastResult.count,
    );
    await shareBlob(blob);
  } catch (e) {
    shareFailed(e);
  } finally {
    updateShareButtons();
  }
}

// A history entry keeps no detections, only the settings; counting again with them gives
// the same rings the entry had.
async function shareHistoryEntry(entry, item) {
  if (item.classList.contains("is-loading")) return;
  if (!entry.source) {
    await tellUser(t("history_unlinked_detail"));
    return;
  }
  item.classList.add("is-loading");
  let url = null;
  try {
    const bytes = await loadSourceBytes(entry.source);
    let mask = null;
    if (entry.has_mask) {
      try {
        mask = new Uint8Array(await invoke("history_mask", { id: entry.id }));
      } catch (e) {
        console.warn("Missing mask:", e);
      }
    }
    const result = await invoke("process_image", {
      payload: ipcBytes(bytes),
      params: entry.params,
      maskPayload: mask ? ipcBytes(mask) : null,
      crop: entry.crop ?? null,
    });
    url = URL.createObjectURL(new Blob([bytes], { type: guessMimeFromPath(entry.name ?? "") || undefined }));
    const image = await loadImage(url);
    const blob = await composeShareImage(
      image,
      entry.crop ?? wholeRect(image),
      showRings ? result.birds : null,
      result.count,
    );
    await shareBlob(blob);
  } catch (e) {
    if (String(e) === "photos-denied") showNativeError(e);
    else if (String(e) === "photo-missing") await tellUser(t("share_missing"));
    else shareFailed(e);
  } finally {
    if (url) URL.revokeObjectURL(url);
    item.classList.remove("is-loading");
  }
}

// ===== Helpers =====

// Tauri takes bytes as a plain array; web.js takes the Uint8Array as it is.
function ipcBytes(bytes) {
  return isWeb ? bytes : Array.from(bytes);
}

function guessMimeFromPath(path) {
  if (!path) return null;
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

function loadImage(url) {
  const img = new Image();
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

// Draws `rect` of the image at width x height, then `decorate` on top, and encodes it.
async function drawToBlob(image, rect, width, height, type, decorate = null) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
  decorate?.(ctx);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
  releaseCanvas(canvas);
  return blob;
}

// Android: system back steps out of the viewer/crop/mask, then returns to the start screen.
window.onAndroidBack = function () {
  if (isViewerOpen) {
    closeViewer();
  } else if (isCropping) {
    cancelCrop();
  } else if (isMasking) {
    cancelMaskMode();
  } else if (isPreviewVisible) {
    resetApp();
  }
};

function setAndroidBackEnabled(enabled) {
  if (window.Android && typeof window.Android.setBackEnabled === "function") {
    window.Android.setBackEnabled(enabled);
  }
}

window.onAndroidInsets = function (insets) {
  const root = document.documentElement;
  ["top", "right", "bottom", "left"].forEach((side) => {
    root.style.setProperty(`--android-inset-${side}`, `${insets[side] || 0}px`);
  });
};

function setupAndroid() {
  const bridge = window.Android;
  if (bridge && typeof bridge.getMaterialThemeCss === "function") {
    try {
      const style = document.createElement("style");
      style.id = "materialTheme";
      style.textContent = bridge.getMaterialThemeCss();
      document.head.appendChild(style);
    } catch (e) {
      console.warn("Failed to apply Material dynamic colors:", e);
    }
  }
  if (bridge && typeof bridge.getSystemInsets === "function") {
    try {
      window.onAndroidInsets(JSON.parse(bridge.getSystemInsets()));
    } catch (e) {
      console.warn("Failed to read system insets:", e);
    }
  }
  document.addEventListener("pointerdown", startRipple);
}

const RIPPLE_TARGETS = ".action-button, .icon-button, .lang-switch, .advanced-summary, .history-open";

function startRipple(e) {
  const target = e.target.closest(RIPPLE_TARGETS);
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const size = Math.hypot(rect.width, rect.height) * 2;
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  ripple.style.width = ripple.style.height = `${size}px`;
  ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
  ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
  target.appendChild(ripple);
  const release = () => {
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    ripple.classList.add("is-fading");
    setTimeout(() => ripple.remove(), 300);
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
}

function setupMac() {
  const { listen } = window.__TAURI__.event;
  listen("menu-open-image", () => {
    if (isPreviewVisible) resetApp();
    openGallery();
  });

  // Without traffic lights in fullscreen the toolbar starts at the window edge
  const appWindow = window.__TAURI__.window?.getCurrentWindow?.();
  if (!appWindow) return;
  const syncFullscreen = async () => {
    try {
      const fullscreen = await appWindow.isFullscreen();
      document.body.classList.toggle("is-fullscreen-window", fullscreen);
    } catch (e) {
      console.warn("Failed to read fullscreen state:", e);
    }
  };
  window.addEventListener("resize", syncFullscreen);
  syncFullscreen();
}

function setupIOS() {
  const { listen } = window.__TAURI__.event;
  listen("quick-action", runQuickAction);
  runQuickAction();
  listen("shared-photo", openSharedPhoto);
  openSharedPhoto();
}

// Toolbar / top app bar change their background once content scrolls under them
function setupScrollState() {
  const update = () => {
    document.body.classList.toggle("is-scrolled", window.scrollY > 0);
  };
  window.addEventListener("scroll", update, { passive: true });
  update();
}

// Native apps have no "Reload" / "Inspect" context menu
function setupContextMenu() {
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest("input, textarea, select")) return;
    e.preventDefault();
  });
}

window.addEventListener("DOMContentLoaded", () => {
  dragDropArea = document.querySelector("#dragDropArea");
  cameraBtn = document.querySelector("#cameraBtn");
  galleryBtn = document.querySelector("#galleryBtn");
  cameraInput = document.querySelector("#cameraInput");
  previewImg = document.querySelector("#previewImg");
  imagePreview = document.querySelector("#imagePreview");
  birdCanvas = document.querySelector("#birdCanvas");
  viewResultBtn = document.querySelector("#viewResultBtn");
  viewOriginalBtn = document.querySelector("#viewOriginalBtn");
  detectBtn = document.querySelector("#detectBtn");
  viewerBtn = document.querySelector("#viewerBtn");
  photoViewer = document.querySelector("#photoViewer");
  viewerCanvas = document.querySelector("#viewerCanvas");
  viewerMarksBtn = document.querySelector("#viewerMarksBtn");
  viewerCloseBtn = document.querySelector("#viewerCloseBtn");
  shareBtn = document.querySelector("#shareBtn");
  viewerShareBtn = document.querySelector("#viewerShareBtn");
  maskBrushCursor = document.querySelector("#maskBrushCursor");
  countLabel = document.querySelector("#countLabel");
  countPrefix = document.querySelector("#countLabel [data-i18n='count_prefix']");
  countValue = document.querySelector("#countValue");
  countSuffix = document.querySelector("#countSuffix");
  processActions = document.querySelector("#processActions");
  cropActions = document.querySelector("#cropActions");
  cropResetBtn = document.querySelector("#cropResetBtn");
  cropCancelBtn = document.querySelector("#cropCancelBtn");
  cropDoneBtn = document.querySelector("#cropDoneBtn");
  cropHint = document.querySelector("#cropHint");
  settingsPanel = document.querySelector("#settingsPanel");
  cropBtn = document.querySelector("#cropBtn");
  maskBtn = document.querySelector("#maskBtn");
  maskCancelBtn = document.querySelector("#maskCancelBtn");
  maskDoneBtn = document.querySelector("#maskDoneBtn");
  maskActions = document.querySelector("#maskActions");
  cropOverlay = document.querySelector("#cropOverlay");
  cropBox = document.querySelector("#cropBox");
  maskOverlay = document.querySelector("#maskOverlay");
  maskCanvas = document.querySelector("#maskCanvas");
  maskBrushControls = document.querySelector("#maskBrushControls");
  maskBrushInput = document.querySelector("#maskBrushSize");
  maskBrushValue = document.querySelector("#maskBrushSizeValue");
  historySection = document.querySelector("#historySection");
  historyList = document.querySelector("#historyList");
  historyClearBtn = document.querySelector("#historyClearBtn");
  backBtn = document.querySelector("#backBtn");
  langSelect = document.querySelector("#langSelect");
  minRadiusInput = document.querySelector("#minRadius");
  minRadiusValue = document.querySelector("#minRadiusValue");
  maxRadiusInput = document.querySelector("#maxRadius");
  maxRadiusValue = document.querySelector("#maxRadiusValue");
  blurInput = document.querySelector("#blur");
  blurValue = document.querySelector("#blurValue");
  thresholdMethodSelect = document.querySelector("#thresholdMethod");
  adaptiveBlockInput = document.querySelector("#adaptiveBlock");
  adaptiveBlockValue = document.querySelector("#adaptiveBlockValue");
  adaptiveCInput = document.querySelector("#adaptiveC");
  adaptiveCValue = document.querySelector("#adaptiveCValue");
  sensitivityInput = document.querySelector("#sensitivity");
  sensitivityValue = document.querySelector("#sensitivityValue");
  morphKernelInput = document.querySelector("#morphKernel");
  morphKernelValue = document.querySelector("#morphKernelValue");
  morphOpenIterInput = document.querySelector("#morphOpenIter");
  morphOpenIterValue = document.querySelector("#morphOpenIterValue");
  morphCloseIterInput = document.querySelector("#morphCloseIter");
  morphCloseIterValue = document.querySelector("#morphCloseIterValue");
  autoInvertInput = document.querySelector("#autoInvert");
  invertInput = document.querySelector("#invert");
  splitClustersInput = document.querySelector("#splitClusters");
  skyOnlyInput = document.querySelector("#skyOnly");

  isAndroid = /Android/i.test(navigator.userAgent);
  // iPhone/iPad user agents also mention "Mac OS X"
  isIOS =
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  // The macOS look needs the app's window (traffic lights, WebKit system colors).
  isMac = !isWeb && !isIOS && /Macintosh|Mac OS X/i.test(navigator.userAgent);
  isDesktopWeb = isWeb && !isAndroid && !isIOS;

  if (isWeb) {
    document.body.classList.add("is-web");
  }
  if (isAndroid) {
    document.body.classList.add("is-android");
    setupAndroid();
  } else if (isIOS) {
    document.body.classList.add("is-ios");
  } else if (isMac) {
    document.body.classList.add("is-mac");
    setupMac();
  }
  setupScrollState();
  if (!isWeb) {
    setupContextMenu();
  }
  setupFileInputs();

  if (dragDropArea && !isAndroid && !isIOS) {
    setupDragAndDrop();
  }
  if (dragDropArea && !isAndroid) {
    dragDropArea.addEventListener("click", choosePhoto);
  }

  if (cameraBtn) {
    cameraBtn.addEventListener("click", takePhoto);
    // A desktop browser would only open the file chooser again.
    if (isDesktopWeb) cameraBtn.hidden = true;
  }

  if (galleryBtn) {
    galleryBtn.addEventListener("click", choosePhoto);
  }

  if (cropBtn) {
    cropBtn.addEventListener("click", enterCropMode);
  }
  if (cropDoneBtn) {
    cropDoneBtn.addEventListener("click", applyCrop);
  }
  if (cropCancelBtn) {
    cropCancelBtn.addEventListener("click", cancelCrop);
  }
  if (cropResetBtn) {
    cropResetBtn.addEventListener("click", () => {
      if (!isCropping || !sourceImage) return;
      cropDraft = fullCrop();
      updateCropUI();
    });
  }
  if (maskBtn) {
    maskBtn.addEventListener("click", toggleMask);
  }
  if (maskDoneBtn) {
    maskDoneBtn.addEventListener("click", toggleMask);
  }
  if (maskCancelBtn) {
    maskCancelBtn.addEventListener("click", cancelMaskMode);
  }
  if (maskBrushInput) {
    maskBrushInput.value = String(DEFAULT_MASK_BRUSH_SIZE);
    maskBrushInput.addEventListener("input", updateMaskBrushValue);
    updateMaskBrushValue();
  }
  if (historyClearBtn) {
    historyClearBtn.addEventListener("click", clearHistory);
  }

  bindRangeValue(minRadiusInput, minRadiusValue, (value) => formatFixed(value, 1));
  bindRangeValue(maxRadiusInput, maxRadiusValue, (value) => formatFixed(value, 1));
  bindRangeValue(blurInput, blurValue);
  bindRangeValue(adaptiveBlockInput, adaptiveBlockValue);
  bindRangeValue(adaptiveCInput, adaptiveCValue, (value) => formatFixed(value, 1));
  bindRangeValue(sensitivityInput, sensitivityValue, (value) => formatFixed(value, 1));
  bindRangeValue(morphKernelInput, morphKernelValue);
  bindRangeValue(morphOpenIterInput, morphOpenIterValue);
  bindRangeValue(morphCloseIterInput, morphCloseIterValue);

  if (thresholdMethodSelect) {
    thresholdMethodSelect.addEventListener("change", updateMethodSettingsVisibility);
    updateMethodSettingsVisibility();
  }
  if (minRadiusInput) {
    minRadiusInput.addEventListener("input", clampRadiusValues);
  }
  if (maxRadiusInput) {
    maxRadiusInput.addEventListener("input", clampRadiusValues);
  }
  if (previewImg) {
    previewImg.addEventListener("load", () => {
      renderMaskPreview();
      renderRings();
      if (isCropping) updateCropUI();
    });
  }
  if (previewImg) {
    previewImg.addEventListener("dblclick", (e) => {
      if (isAndroid) return;
      e.preventDefault();
      e.stopPropagation();
      openViewer();
    });

    previewImg.addEventListener(
      "touchstart",
      (e) => {
        if (!isAndroid) return;
        if (e.touches.length !== 1) return;
        tapStartTime = Date.now();
        tapStartX = e.touches[0].clientX;
        tapStartY = e.touches[0].clientY;
      },
      { passive: true },
    );

    previewImg.addEventListener(
      "touchend",
      (e) => {
        if (!isAndroid) return;
        if (e.changedTouches.length !== 1) return;
        const now = Date.now();
        const touch = e.changedTouches[0];
        const travel = Math.hypot(touch.clientX - tapStartX, touch.clientY - tapStartY);
        const elapsed = now - tapStartTime;
        const isTap = travel < 12 && elapsed < 250;
        if (!isTap) {
          lastTapTime = 0;
          return;
        }

        const delta = now - lastTapTime;
        const dist = Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY);
        if (delta < 320 && dist < 28) {
          openViewer();
          lastTapTime = 0;
          return;
        }
        lastTapTime = now;
        lastTapX = touch.clientX;
        lastTapY = touch.clientY;
      },
      { passive: true },
    );
  }
  let initialShowRings = true;
  try {
    initialShowRings = localStorage.getItem("showRings") !== "0";
  } catch (e) {
    // Shown by default
  }
  setShowRings(initialShowRings, false);
  viewResultBtn?.addEventListener("click", () => setShowRings(true));
  viewOriginalBtn?.addEventListener("click", () => setShowRings(false));
  viewerMarksBtn?.addEventListener("click", () => setShowRings(!showRings));
  detectBtn?.addEventListener("click", () => setSettingsOpen(!settingsOpen));
  viewerBtn?.addEventListener("click", openViewer);
  for (const button of [shareBtn, viewerShareBtn]) {
    button?.addEventListener("click", shareCurrentResult);
  }
  viewerCloseBtn?.addEventListener("click", closeViewer);
  if (viewerCanvas) {
    viewerCanvas.addEventListener("pointerdown", onViewerPointerDown);
    viewerCanvas.addEventListener("pointermove", onViewerPointerMove);
    viewerCanvas.addEventListener("pointerup", onViewerPointerUp);
    viewerCanvas.addEventListener("pointercancel", onViewerPointerUp);
    viewerCanvas.addEventListener("wheel", onViewerWheel, { passive: false });
    viewerCanvas.addEventListener("dblclick", (e) => e.preventDefault());
  }
  document.addEventListener("keydown", onViewerKeyDown);
  document.addEventListener("pointerdown", (e) => {
    if (historyMenu && !historyMenu.element.contains(e.target) && !historyMenu.anchor.contains(e.target)) {
      closeHistoryMenu();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && historyMenu) {
      historyMenu.anchor.focus({ preventScroll: true });
      closeHistoryMenu();
      return;
    }
    // Crop and mask show only ✕ and ✓, so Esc and Return stand in for Cancel and Done.
    if (isViewerOpen || (!isCropping && !isMasking)) return;
    if (e.key === "Enter" && e.target instanceof Element && e.target.closest("button, input, select, summary")) {
      return;
    }
    if (e.key === "Escape") {
      (isCropping ? cropCancelBtn : maskCancelBtn).click();
    } else if (e.key === "Enter") {
      (isCropping ? cropDoneBtn : maskDoneBtn).click();
    } else {
      return;
    }
    e.preventDefault();
  });
  window.addEventListener("resize", closeHistoryMenu);
  window.addEventListener("scroll", closeHistoryMenu, { passive: true });

  if (cropOverlay) {
    cropOverlay.addEventListener("pointerdown", onCropPointerDown);
    cropOverlay.addEventListener("pointermove", onCropPointerMove);
    cropOverlay.addEventListener("pointerup", onCropPointerUp);
    cropOverlay.addEventListener("pointercancel", onCropPointerUp);
  }
  if (maskCanvas) {
    maskCanvas.addEventListener("pointerdown", onMaskPointerDown);
    maskCanvas.addEventListener("pointermove", onMaskPointerHover);
    maskCanvas.addEventListener("pointerenter", onMaskPointerHover);
    maskCanvas.addEventListener("pointerleave", clearMaskHover);
    maskCanvas.addEventListener("pointerout", clearMaskHover);
  }

  window.addEventListener("pointermove", onMaskPointerMove);
  window.addEventListener("pointerup", onMaskPointerUp);
  window.addEventListener("resize", () => {
    renderMaskPreview();
    renderRings();
    layoutViewer();
    if (isCropping) updateCropUI();
  });

  // Back button click handler
  if (backBtn) {
    backBtn.addEventListener("click", resetApp);
  }

  if (langSelect) {
    langSelect.addEventListener("change", (e) => {
      setLanguage(e.target.value);
    });
  }

  const settingsControls = [
    minRadiusInput,
    maxRadiusInput,
    blurInput,
    thresholdMethodSelect,
    adaptiveBlockInput,
    adaptiveCInput,
    sensitivityInput,
    morphKernelInput,
    morphOpenIterInput,
    morphCloseIterInput,
    autoInvertInput,
    invertInput,
    splitClustersInput,
    skyOnlyInput,
  ];

  settingsControls.forEach((control) => {
    if (!control) return;
    const eventName =
      control.tagName === "SELECT" || control.type === "checkbox"
        ? "change"
        : "input";
    control.addEventListener(eventName, () => {
      scheduleProcess();
    });
  });

  updateCropButtonState(false);
  updateMaskButtonState(false);
  updateEditingState();
  updateMaskBrushControlsState();
  updateMaskOverlayState();

  let initialLang = DEFAULT_LANG;
  try {
    initialLang = normalizeLang(localStorage.getItem("lang"));
  } catch (e) {
    initialLang = normalizeLang(navigator.language);
  }
  if (initialLang === DEFAULT_LANG) {
    initialLang = normalizeLang(navigator.language);
  }
  setLanguage(initialLang);
  refreshHistory();

  // Photos that arrive from the camera or the library, also when the app was started by a
  // quick action and the result came back before this page loaded.
  window.onNativeImageReady = takeAndroidResult;
  takeAndroidResult();
  if (isIOS) {
    setupIOS();
  }
});
