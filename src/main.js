const { invoke } = window.__TAURI__.core;
const { open, ask, message } = window.__TAURI__.dialog;
const { readFile } = window.__TAURI__.fs;

const MIN_CROP_SIZE = 40;
const DEFAULT_MASK_BRUSH_SIZE = 24;
// Min radius filters out specks, which are a few pixels across whatever the photo size,
// so its slider has a fixed range with fine steps instead of following the photo.
const MIN_RADIUS_LIMIT = 30;
const MASK_TINT_COLOR = "#e24d5c";
const MASK_BRUSH_OUTLINE = "rgba(226, 77, 92, 0.95)";
const MASK_BRUSH_FILL = "rgba(226, 77, 92, 0.2)";
const SUPPORTED_LANGS = ["en", "pl"];
const DEFAULT_LANG = "en";
// Longest side of the history thumbnails and of the quick cropped preview.
const THUMB_SIZE = 320;
const PREVIEW_SIZE = 1600;
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
let fullscreenCloseBtn;
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
let resultUrl = null;
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
let maskHoverPoint = null;
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
let isFullscreenPreview = false;
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;
let tapStartTime = 0;
let tapStartX = 0;
let tapStartY = 0;
let isAndroid = false;
let isMac = false;
let isIOS = false;
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
    const res = await fetch(`/i18n/${lang}.json`);
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
      (isMac && el.dataset.i18nMac) ||
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

// Fallback for an Android build without the native bridge: a plain file input.
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
  await openImage(bytes, file.type || null, { source: null, name: file.name, owned: false });
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

  await flushHistorySave();
  editSession++;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  setResultUrl(null);
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
  if (countLabel) countLabel.style.display = "block";
  if (processActions) processActions.style.display = "flex";
  if (settingsPanel) settingsPanel.style.display = "flex";
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
  setFullscreenPreview(false);
  if (countLabel) countLabel.style.display = "none";
  if (processActions) processActions.style.display = "none";
  if (settingsPanel) settingsPanel.style.display = "none";
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
  setResultUrl(null);
  resetCropUI();
  clearMaskData();
  resetMaskUI();
  updateCount(0);
  renderHistory();
}

function setResultUrl(url) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = url;
}

// The photo, cropped, until the counted result replaces it.
async function showWorkingPreview() {
  if (!sourceImage || !previewImg) return;
  if (workingPreviewUrl) {
    URL.revokeObjectURL(workingPreviewUrl);
    workingPreviewUrl = null;
  }
  if (!cropRect) {
    previewImg.src = sourceUrl;
    return;
  }
  const session = editSession;
  const scale = Math.min(1, PREVIEW_SIZE / Math.max(cropRect.width, cropRect.height));
  const blob = await drawToBlob(
    sourceImage,
    cropRect,
    Math.round(cropRect.width * scale),
    Math.round(cropRect.height * scale),
    "image/jpeg",
  );
  // Too late when the result for this crop is already shown.
  const counted = lastResult && JSON.stringify(lastResult.crop) === JSON.stringify(cropRect);
  if (!blob || session !== editSession || isCropping || counted) return;
  workingPreviewUrl = URL.createObjectURL(blob);
  previewImg.src = workingPreviewUrl;
}

function setFullscreenPreview(active) {
  if (!imagePreview || !previewImg) return;
  isFullscreenPreview = active;
  imagePreview.classList.toggle("is-fullscreen", active);
  document.body.classList.toggle("fullscreen-preview", active);
  updateMaskOverlayState();
  requestAnimationFrame(() => {
    syncMaskCanvasSize();
    renderMaskPreview();
  });
}

function toggleFullscreenPreview() {
  if (!isPreviewVisible || isCropping || isMasking) return;
  setFullscreenPreview(!isFullscreenPreview);
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
  if (maskCancelBtn) maskCancelBtn.style.display = isMasking ? "inline-flex" : "none";
  if (isPreviewVisible && processActions) {
    processActions.style.display = isCropping ? "none" : "flex";
  }
  if (cropActions) cropActions.style.display = isCropping ? "flex" : "none";
  if (cropHint) cropHint.style.display = isCropping ? "block" : "none";
}

// ===== Mask =====

function updateMaskBrushControlsState() {
  if (!maskBrushControls) return;
  maskBrushControls.style.display = isMasking ? "flex" : "none";
}

function updateMaskOverlayState() {
  if (!maskOverlay) return;
  maskOverlay.classList.toggle("is-active", isMasking);
  maskOverlay.classList.toggle(
    "has-mask",
    maskHasPaint && !isMasking && !isCropping && !isFullscreenPreview,
  );
}

function updateMaskBrushValue() {
  if (!maskBrushInput || !maskBrushValue) return;
  maskBrushValue.textContent = String(maskBrushInput.value);
  updateRangeFill(maskBrushInput);
}

function clearMaskData() {
  maskHasPaint = false;
  maskDragState = null;
  maskHoverPoint = null;
  maskBitmap = null;
  maskContext = null;
  maskPngCache = null;
  maskSnapshot = null;
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
  maskHoverPoint = null;
  maskSnapshot = null;
  updateMaskButtonState(false);
  updateEditingState();
  updateMaskBrushControlsState();
  updateMaskOverlayState();
}

function ensureMaskBitmap() {
  if (!sourceImage) return false;
  const width = sourceImage.naturalWidth;
  const height = sourceImage.naturalHeight;
  if (!width || !height) return false;
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
}

// Part of the photo shown in the preview: the crop, or all of it.
function viewRect() {
  if (cropRect) return cropRect;
  if (!sourceImage) return null;
  return { x: 0, y: 0, width: sourceImage.naturalWidth, height: sourceImage.naturalHeight };
}

function syncMaskCanvasSize() {
  if (!maskCanvas || !previewImg) return;
  const rect = previewImg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (maskCanvas.width === width && maskCanvas.height === height) return;
  maskCanvas.width = width;
  maskCanvas.height = height;
}

function renderMaskPreview() {
  if (!maskCanvas) return;
  syncMaskCanvasSize();
  const overlayCtx = maskCanvas.getContext("2d");
  if (!overlayCtx) return;
  overlayCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  const view = viewRect();
  if (maskHasPaint && maskBitmap && view) {
    overlayCtx.save();
    overlayCtx.globalAlpha = isMasking ? 1.0 : 0.9;
    overlayCtx.drawImage(
      maskBitmap,
      view.x,
      view.y,
      view.width,
      view.height,
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
  if (isMasking && maskHoverPoint) {
    const radius = getMaskBrushRadiusPixels();
    overlayCtx.save();
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeStyle = MASK_BRUSH_OUTLINE;
    overlayCtx.fillStyle = MASK_BRUSH_FILL;
    overlayCtx.beginPath();
    overlayCtx.arc(maskHoverPoint.x, maskHoverPoint.y, radius, 0, Math.PI * 2);
    overlayCtx.fill();
    overlayCtx.stroke();
    overlayCtx.restore();
  }
}

function getMaskBrushRadiusPixels() {
  if (!maskBrushInput) return DEFAULT_MASK_BRUSH_SIZE;
  const parsed = Number(maskBrushInput.value);
  if (!Number.isFinite(parsed)) return DEFAULT_MASK_BRUSH_SIZE;
  return Math.max(1, parsed);
}

// Pointer position in photo pixels.
function toMaskImagePoint(clientX, clientY) {
  const view = viewRect();
  if (!maskCanvas || !maskBitmap || !view) return null;
  const rect = maskCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
  const y = Math.min(Math.max(clientY - rect.top, 0), rect.height);

  return {
    x: view.x + (x / rect.width) * view.width,
    y: view.y + (y / rect.height) * view.height,
  };
}

function toMaskCanvasPoint(clientX, clientY) {
  if (!maskCanvas) return null;
  const rect = maskCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return null;
  }

  return {
    x: ((clientX - rect.left) / rect.width) * maskCanvas.width,
    y: ((clientY - rect.top) / rect.height) * maskCanvas.height,
  };
}

function toMaskCanvasPointFromImagePoint(point) {
  const view = viewRect();
  if (!maskCanvas || !view || !point) return null;
  return {
    x: ((point.x - view.x) / view.width) * maskCanvas.width,
    y: ((point.y - view.y) / view.height) * maskCanvas.height,
  };
}

function drawMaskStroke(from, to) {
  const view = viewRect();
  if (!ensureMaskBitmap() || !maskContext || !maskCanvas || !view) return;
  const rect = maskCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const scale = Math.max(view.width / rect.width, view.height / rect.height);
  const radius = getMaskBrushRadiusPixels() * scale;

  maskContext.save();
  maskContext.strokeStyle = "#ffffff";
  maskContext.fillStyle = "#ffffff";
  maskContext.lineCap = "round";
  maskContext.lineJoin = "round";
  maskContext.lineWidth = Math.max(1, radius * 2);
  maskContext.beginPath();
  maskContext.moveTo(from.x, from.y);
  maskContext.lineTo(to.x, to.y);
  maskContext.stroke();
  maskContext.beginPath();
  maskContext.arc(to.x, to.y, Math.max(1, radius), 0, Math.PI * 2);
  maskContext.fill();
  maskContext.restore();

  maskHasPaint = true;
  maskPngCache = null;
  maskChangedSinceSave = true;
  updateMaskOverlayState();
  renderMaskPreview();
}

// The mask as PNG at the photo's resolution; Rust crops it with the photo.
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
  if (isFullscreenPreview) {
    setFullscreenPreview(false);
  }
  if (isCropping) {
    exitCropMode();
  }

  if (!ensureMaskBitmap()) return;
  // Cancel brings this back.
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
  syncMaskCanvasSize();
  renderMaskPreview();
}

function exitMaskMode(options = {}) {
  const { process = false } = options;
  isMasking = false;
  maskDragState = null;
  maskHoverPoint = null;
  maskSnapshot = null;
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
  if (isFullscreenPreview) {
    setFullscreenPreview(false);
  }
  if (isMasking) {
    exitMaskMode();
  }
  isCropping = true;
  cropDraft = cropRect ? { ...cropRect } : fullCrop();
  updateCropButtonState(true);
  updateEditingState();
  updateMaskOverlayState();

  previewImg.src = sourceUrl;
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
  if (resultUrl) {
    previewImg.src = resultUrl;
  } else {
    showWorkingPreview();
  }
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
  if (!isMasking) return;
  if (!ensureMaskBitmap() || !maskCanvas) return;

  syncMaskCanvasSize();
  const point = toMaskImagePoint(e.clientX, e.clientY);
  if (!point) return;
  const hoverPoint = toMaskCanvasPoint(e.clientX, e.clientY);
  if (hoverPoint) {
    maskHoverPoint = hoverPoint;
  }

  maskDragState = {
    pointerId: e.pointerId,
    lastPoint: point,
  };
  maskCanvas.setPointerCapture(e.pointerId);
  drawMaskStroke(point, point);
  e.preventDefault();
}

function onMaskPointerMove(e) {
  if (!maskDragState || e.pointerId !== maskDragState.pointerId) return;
  if (isMasking) {
    const hoverPoint = toMaskCanvasPoint(e.clientX, e.clientY);
    if (hoverPoint) {
      maskHoverPoint = hoverPoint;
    } else {
      const fallback = toMaskCanvasPointFromImagePoint(maskDragState.lastPoint);
      if (fallback) {
        maskHoverPoint = fallback;
      }
    }
  }
  const next = toMaskImagePoint(e.clientX, e.clientY);
  if (!next) return;
  drawMaskStroke(maskDragState.lastPoint, next);
  maskDragState.lastPoint = next;
  e.preventDefault();
}

function onMaskPointerUp(e) {
  if (!maskDragState || e.pointerId !== maskDragState.pointerId) return;
  if (maskCanvas && maskCanvas.hasPointerCapture(e.pointerId)) {
    maskCanvas.releasePointerCapture(e.pointerId);
  }
  maskDragState = null;
}

function onMaskPointerHover(e) {
  if (!isMasking) return;
  const point = toMaskCanvasPoint(e.clientX, e.clientY);
  if (!point) {
    if (!maskDragState && maskHoverPoint) {
      maskHoverPoint = null;
      renderMaskPreview();
    }
    return;
  }
  maskHoverPoint = point;
  renderMaskPreview();
}

function clearMaskHover() {
  if (!isMasking) return;
  if (maskDragState) return;
  if (!maskHoverPoint) return;
  maskHoverPoint = null;
  renderMaskPreview();
}

// ===== Camera and library =====
// Every photo, from any of these, opens in the editor and is counted at once.

async function takePhoto() {
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
      payload: Array.from(bytes),
      params,
      maskPayload: maskPayload ? Array.from(maskPayload) : null,
      crop,
    });
    if (session !== editSession) return;

    const blob = new Blob([new Uint8Array(result.bytes)], { type: "image/png" });
    setResultUrl(URL.createObjectURL(blob));
    // While cropping, the preview shows the whole photo; the result waits for the crop.
    if (!isCropping) previewImg.src = resultUrl;
    updateCount(result.count);
    lastResult = { count: result.count, params, crop, blob };
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
  const info = { ...sourceInfo };
  const updateMask = maskChangedSinceSave;
  if (!result) return;
  const key = historyKey(result);
  if (!updateMask && historySavedKeys.get(session) === key) return;
  historySavedKeys.set(session, key);
  maskChangedSinceSave = false;
  const maskPromise = updateMask ? buildMaskPayload() : Promise.resolve(null);
  historySaveChain = historySaveChain
    .then(async () => {
      const [thumb, mask] = await Promise.all([makeThumbnail(result.blob), maskPromise]);
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
        thumb: Array.from(thumb),
        mask: mask ? Array.from(mask) : null,
        updateMask,
      });
      historyIds.set(session, saved.id);
    })
    .catch((e) => console.error("Failed to save history:", e));
}

async function makeThumbnail(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const scale = Math.min(1, THUMB_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
    const blob = await drawToBlob(
      image,
      { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight },
      Math.max(1, Math.round(image.naturalWidth * scale)),
      Math.max(1, Math.round(image.naturalHeight * scale)),
      "image/jpeg",
    );
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch (e) {
    console.warn("Failed to make a thumbnail:", e);
    return null;
  } finally {
    URL.revokeObjectURL(url);
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

function renderHistory() {
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

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "icon-button history-delete";
      deleteButton.setAttribute("aria-label", t("history_delete"));
      deleteButton.innerHTML = TRASH_ICON;
      deleteButton.addEventListener("click", () => deleteHistoryEntry(entry, true));

      item.append(openButton, deleteButton);
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

// ===== Helpers =====

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

// Draws `rect` of the image at width x height and encodes it.
async function drawToBlob(image, rect, width, height, type) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
  return await new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
}

// Android: system back steps out of fullscreen/crop/mask, then returns to the start screen.
window.onAndroidBack = function () {
  if (isFullscreenPreview) {
    setFullscreenPreview(false);
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
  fullscreenCloseBtn = document.querySelector("#fullscreenCloseBtn");
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
  isMac = !isIOS && /Macintosh|Mac OS X/i.test(navigator.userAgent);

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
  setupContextMenu();
  setupFileInputs();

  if (dragDropArea && !isAndroid && !isIOS) {
    setupDragAndDrop();
  }
  if (dragDropArea && !isAndroid) {
    dragDropArea.addEventListener("click", choosePhoto);
  }

  if (cameraBtn) {
    cameraBtn.addEventListener("click", takePhoto);
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
      syncMaskCanvasSize();
      renderMaskPreview();
      if (isCropping) updateCropUI();
    });
  }
  if (previewImg) {
    previewImg.addEventListener("dblclick", (e) => {
      if (isAndroid) return;
      e.preventDefault();
      e.stopPropagation();
      toggleFullscreenPreview();
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
          toggleFullscreenPreview();
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
  if (fullscreenCloseBtn) {
    fullscreenCloseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setFullscreenPreview(false);
    });
  }

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
    syncMaskCanvasSize();
    renderMaskPreview();
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
