const { invoke, convertFileSrc } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { readFile } = window.__TAURI__.fs;

const MIN_CROP_SIZE = 40;
const DEFAULT_MASK_BRUSH_SIZE = 24;
const MASK_TINT_COLOR = "#e24d5c";
const MASK_BRUSH_OUTLINE = "rgba(226, 77, 92, 0.95)";
const MASK_BRUSH_FILL = "rgba(226, 77, 92, 0.2)";
const SUPPORTED_LANGS = ["en", "pl"];
const DEFAULT_LANG = "en";

let dragDropArea;
let cameraBtn;
let galleryBtn;
let imageInput;
let cameraInput;
let previewImg;
let imagePreview;
let cropBtn;
let maskBtn;
let cropCancelBtn;
let processActions;
let settingsPanel;
let cropOverlay;
let cropBox;
let cropMasks = {};
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
let currentImageBytes = null;
let originalImageBytes = null;
let originalImageMime = null;
let isPreviewVisible = false;
let isCropping = false;
let isMasking = false;
let cropState = null;
let cropBounds = { width: 0, height: 0 };
let cropDragState = null;
let maskDragState = null;
let maskBitmap = null;
let maskContext = null;
let maskHasPaint = false;
let maskHoverPoint = null;
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
let isProcessing = false;
let pendingProcess = false;
let pendingProcessOptions = null;
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
let countingAnimationTimer = null;
let countingDotCount = 1;

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
    const key = el.dataset.i18n;
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
}

function setupDragAndDrop() {
  // Prevent default drag behaviors
  ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    dragDropArea.addEventListener(eventName, preventDefaults, false);
    document.body.addEventListener(eventName, preventDefaults, false);
  });

  // Highlight drop area when item is dragged over it
  ["dragenter", "dragover"].forEach((eventName) => {
    dragDropArea.addEventListener(eventName, highlight, false);
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dragDropArea.addEventListener(eventName, unhighlight, false);
  });

  // Handle dropped files
  dragDropArea.addEventListener("drop", handleDrop, false);

  // Click on drag area triggers the file selection (gallery compatible)
  dragDropArea.addEventListener("click", () => {
    imageInput.click();
  });

  // Handle file selection from the standard input
  imageInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      const file = e.target.files[0];
      handleFileObject(file);
    }
    // clear value to allow re-selection
    imageInput.value = "";
  });

  // Handle file selection from the camera input (Android)
  cameraInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      const file = e.target.files[0];
      handleFileObject(file);
    }
    // clear value
    cameraInput.value = "";
  });
}

function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

function highlight(e) {
  dragDropArea.classList.add("drag-over");
}

function unhighlight(e) {
  dragDropArea.classList.remove("drag-over");
}

function handleDrop(e) {
  const dt = e.dataTransfer;
  const files = dt.files;
  if (files.length > 0) {
    const file = files[0];
    if (file.type.startsWith("image/")) {
      handleFileObject(file);
    } else {
      alert(t("alert_drop_image"));
    }
  }
}

// Handle standard HTML File object (from Drag&Drop or Input)
function handleFileObject(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    // Store raw bytes for processing
    originalImageBytes = new Uint8Array(e.target.result);
    currentImageBytes = new Uint8Array(originalImageBytes);
    originalImageMime = file.type || null;
    // Create blob for display
    const blob = new Blob([originalImageBytes], { type: file.type || undefined });
    previewImg.src = URL.createObjectURL(blob);
    showPreview();
  };
  // Read as ArrayBuffer to get raw bytes
  reader.readAsArrayBuffer(file);
}

function showPreview() {
  isPreviewVisible = true;
  radiusInitialized = false;
  imagePreview.style.display = "block";
  if (countLabel) countLabel.style.display = "block";
  if (processActions) processActions.style.display = "flex";
  if (settingsPanel) settingsPanel.style.display = "flex";
  if (backBtn) backBtn.style.display = "flex";
  if (dragDropArea && !isAndroid) {
    dragDropArea.style.display = "none";
  }
  document.querySelector(".button-container").style.display = "none";
  resetCropUI();
  clearMaskData();
  resetMaskUI();
  updateCount(0);
  scheduleProcess({ applyCrop: false });
}

function resetApp() {
  isPreviewVisible = false;
  if (processTimer) {
    clearTimeout(processTimer);
    processTimer = null;
  }
  pendingProcess = false;
  pendingProcessOptions = null;
  imagePreview.style.display = "none";
  setFullscreenPreview(false);
  if (countLabel) countLabel.style.display = "none";
  if (processActions) processActions.style.display = "none";
  if (settingsPanel) settingsPanel.style.display = "none";
  if (backBtn) backBtn.style.display = "none";
  if (dragDropArea && !isAndroid) {
    dragDropArea.style.display = "flex";
  }
  document.querySelector(".button-container").style.display = "flex";
  currentImageBytes = null;
  originalImageBytes = null;
  originalImageMime = null;
  if (previewImg) previewImg.src = "";
  resetCropUI();
  clearMaskData();
  resetMaskUI();
  updateCount(0);
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


function updateCount(value) {
  stopCountingAnimation();
  if (!countValue) return;
  countValue.textContent = String(value);
  if (!countSuffix) return;
  if (currentLang === "pl") {
    const n = Math.abs(Math.trunc(value));
    const mod10 = n % 10;
    const mod100 = n % 100;
    let suffixKey = "count_suffix_many";
    if (n === 1) {
      suffixKey = "count_suffix_one";
    } else if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
      suffixKey = "count_suffix_few";
    }
    countSuffix.textContent = t(suffixKey);
    return;
  }
  countSuffix.textContent = t("count_suffix");
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
  };
  input.addEventListener("input", update);
  update();
  return update;
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

function updateRadiusLimits() {
  if (!previewImg || !minRadiusInput || !maxRadiusInput) return;
  if (!previewImg.naturalWidth || !previewImg.naturalHeight) return;

  const maxAllowed = Math.max(
    1,
    Math.min(previewImg.naturalWidth, previewImg.naturalHeight) / 2,
  );
  minRadiusInput.max = maxAllowed.toString();
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

function updateCropButtonState(active) {
  if (!cropBtn) return;
  cropBtn.classList.toggle("is-active", active);
  cropBtn.setAttribute("aria-pressed", active ? "true" : "false");
}

function updateMaskButtonState(active) {
  if (!maskBtn) return;
  maskBtn.classList.toggle("is-active", active);
  maskBtn.setAttribute("aria-pressed", active ? "true" : "false");
}

function updateCancelButtonState() {
  if (!cropCancelBtn) return;
  cropCancelBtn.style.display = isCropping || isMasking ? "inline-flex" : "none";
}

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
}

function clearMaskData() {
  maskHasPaint = false;
  maskDragState = null;
  maskHoverPoint = null;
  maskBitmap = null;
  maskContext = null;
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
  updateMaskButtonState(false);
  updateCancelButtonState();
  updateMaskBrushControlsState();
  updateMaskOverlayState();
}

function ensureMaskBitmap() {
  if (!previewImg) return false;
  if (!previewImg.naturalWidth || !previewImg.naturalHeight) return false;

  const width = previewImg.naturalWidth;
  const height = previewImg.naturalHeight;
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
  if (maskHasPaint && maskBitmap) {
    overlayCtx.save();
    overlayCtx.globalAlpha = isMasking ? 1.0 : 0.9;
    overlayCtx.drawImage(maskBitmap, 0, 0, maskCanvas.width, maskCanvas.height);
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

function toMaskImagePoint(clientX, clientY) {
  if (!maskCanvas || !maskBitmap) return null;
  const rect = maskCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
  const y = Math.min(Math.max(clientY - rect.top, 0), rect.height);

  return {
    x: (x / rect.width) * maskBitmap.width,
    y: (y / rect.height) * maskBitmap.height,
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
  if (!maskCanvas || !maskBitmap || !point) return null;
  if (!maskBitmap.width || !maskBitmap.height) return null;
  return {
    x: (point.x / maskBitmap.width) * maskCanvas.width,
    y: (point.y / maskBitmap.height) * maskCanvas.height,
  };
}

function drawMaskStroke(from, to) {
  if (!ensureMaskBitmap() || !maskContext || !maskCanvas || !maskBitmap) return;
  const rect = maskCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const scaleX = maskBitmap.width / rect.width;
  const scaleY = maskBitmap.height / rect.height;
  const radius = getMaskBrushRadiusPixels() * Math.max(scaleX, scaleY);

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
  updateMaskOverlayState();
  renderMaskPreview();
}

async function buildMaskPayload() {
  if (!maskHasPaint || !maskBitmap) return null;
  const blob = await new Promise((resolve) =>
    maskBitmap.toBlob(resolve, "image/png"),
  );
  if (!blob) return null;
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

function enterMaskMode() {
  if (!previewImg || !maskOverlay || !maskCanvas) return;
  if (!previewImg.complete || previewImg.naturalWidth === 0) {
    previewImg.addEventListener("load", enterMaskMode, { once: true });
    return;
  }

  if (isFullscreenPreview) {
    setFullscreenPreview(false);
  }
  if (isCropping) {
    exitCropMode();
  }

  if (!ensureMaskBitmap()) return;
  isMasking = true;
  updateMaskButtonState(true);
  updateCancelButtonState();
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
  updateMaskButtonState(false);
  updateCancelButtonState();
  updateMaskBrushControlsState();
  updateMaskOverlayState();
  renderMaskPreview();
  if (process) {
    scheduleProcess({ applyCrop: false });
  }
}

function toggleMask() {
  if (!isMasking) {
    enterMaskMode();
    return;
  }
  exitMaskMode({ process: true });
}

function resetCropUI() {
  isCropping = false;
  cropState = null;
  cropDragState = null;
  if (cropOverlay) {
    cropOverlay.classList.remove("is-active");
  }
  updateCropButtonState(false);
  updateCancelButtonState();
  updateMaskOverlayState();
}

function syncCropBounds() {
  if (!previewImg) return;
  const rect = previewImg.getBoundingClientRect();
  cropBounds = {
    width: rect.width,
    height: rect.height,
  };
}

function setCropToDefault() {
  syncCropBounds();
  const minDimension = Math.min(cropBounds.width, cropBounds.height);
  const margin = Math.max(12, Math.min(40, Math.round(minDimension * 0.05)));
  const width = Math.max(MIN_CROP_SIZE, cropBounds.width - margin * 2);
  const height = Math.max(MIN_CROP_SIZE, cropBounds.height - margin * 2);
  const x = Math.max(0, Math.round((cropBounds.width - width) / 2));
  const y = Math.max(0, Math.round((cropBounds.height - height) / 2));
  cropState = clampCropState({ x, y, width, height });
  updateCropUI();
}

function updateCropUI() {
  if (!cropState || !cropBox) return;
  cropBox.style.left = `${cropState.x}px`;
  cropBox.style.top = `${cropState.y}px`;
  cropBox.style.width = `${cropState.width}px`;
  cropBox.style.height = `${cropState.height}px`;
  updateCropMasks();
}

function updateCropMasks() {
  if (!cropState || !cropMasks.top) return;
  const { x, y, width, height } = cropState;
  const boundsWidth = cropBounds.width;
  const boundsHeight = cropBounds.height;

  cropMasks.top.style.left = "0px";
  cropMasks.top.style.top = "0px";
  cropMasks.top.style.width = `${boundsWidth}px`;
  cropMasks.top.style.height = `${Math.max(0, y)}px`;

  cropMasks.left.style.left = "0px";
  cropMasks.left.style.top = `${y}px`;
  cropMasks.left.style.width = `${Math.max(0, x)}px`;
  cropMasks.left.style.height = `${Math.max(0, height)}px`;

  cropMasks.right.style.left = `${x + width}px`;
  cropMasks.right.style.top = `${y}px`;
  cropMasks.right.style.width = `${Math.max(0, boundsWidth - (x + width))}px`;
  cropMasks.right.style.height = `${Math.max(0, height)}px`;

  cropMasks.bottom.style.left = "0px";
  cropMasks.bottom.style.top = `${y + height}px`;
  cropMasks.bottom.style.width = `${boundsWidth}px`;
  cropMasks.bottom.style.height = `${Math.max(0, boundsHeight - (y + height))}px`;
}

function clampCropState(state) {
  let { x, y, width, height } = state;
  const boundsWidth = cropBounds.width;
  const boundsHeight = cropBounds.height;

  width = Math.max(MIN_CROP_SIZE, width);
  height = Math.max(MIN_CROP_SIZE, height);

  if (x < 0) {
    width += x;
    x = 0;
  }
  if (y < 0) {
    height += y;
    y = 0;
  }

  if (x + width > boundsWidth) {
    width = boundsWidth - x;
  }
  if (y + height > boundsHeight) {
    height = boundsHeight - y;
  }

  width = Math.max(MIN_CROP_SIZE, width);
  height = Math.max(MIN_CROP_SIZE, height);

  if (x + width > boundsWidth) {
    x = Math.max(0, boundsWidth - width);
  }
  if (y + height > boundsHeight) {
    y = Math.max(0, boundsHeight - height);
  }

  return { x, y, width, height };
}

function enterCropMode() {
  if (!previewImg || !cropOverlay) return;
  if (!previewImg.complete || previewImg.naturalWidth === 0) {
    previewImg.addEventListener("load", enterCropMode, { once: true });
    return;
  }

  if (isFullscreenPreview) {
    setFullscreenPreview(false);
  }
  if (isMasking) {
    exitMaskMode();
  }
  cropOverlay.classList.add("is-active");
  isCropping = true;
  updateCropButtonState(true);
  updateCancelButtonState();
  updateMaskOverlayState();
  requestAnimationFrame(() => {
    if (isCropping) {
      setCropToDefault();
    }
  });
}

function exitCropMode() {
  isCropping = false;
  cropState = null;
  if (cropOverlay) {
    cropOverlay.classList.remove("is-active");
  }
  updateCropButtonState(false);
  updateCancelButtonState();
  updateMaskOverlayState();
}

async function applyCrop() {
  if (!cropState || !previewImg) return;
  const sourceBytes = originalImageBytes ?? currentImageBytes;
  if (!sourceBytes) return;
  const imageRect = previewImg.getBoundingClientRect();
  if (imageRect.width === 0 || imageRect.height === 0) return;

  const sourceImage = await loadImageFromBytes(
    sourceBytes,
    originalImageMime,
  );
  const scaleX = sourceImage.naturalWidth / imageRect.width;
  const scaleY = sourceImage.naturalHeight / imageRect.height;

  const sx = Math.max(0, Math.round(cropState.x * scaleX));
  const sy = Math.max(0, Math.round(cropState.y * scaleY));
  const sWidth = Math.max(1, Math.round(cropState.width * scaleX));
  const sHeight = Math.max(1, Math.round(cropState.height * scaleY));

  const canvas = document.createElement("canvas");
  canvas.width = sWidth;
  canvas.height = sHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(sourceImage, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) return;

  const buf = await blob.arrayBuffer();
  originalImageBytes = new Uint8Array(buf);
  currentImageBytes = new Uint8Array(originalImageBytes);
  originalImageMime = "image/png";
  previewImg.src = URL.createObjectURL(blob);
  clearMaskData();
  resetMaskUI();
  updateCount(0);
}

async function toggleCrop() {
  if (!isCropping) {
    enterCropMode();
    return;
  }

  await applyCrop();
  exitCropMode();
  scheduleProcess({ applyCrop: false });
}

function onCropPointerDown(e) {
  if (!isCropping || !cropState || !cropBox) return;
  const handle = e.target.closest(".crop-handle");
  if (!handle) return;
  const mode = handle.dataset.mode;
  if (!mode) return;
  cropDragState = {
    pointerId: e.pointerId,
    mode,
    handle: mode === "resize" ? handle.dataset.handle || null : null,
    startX: e.clientX,
    startY: e.clientY,
    startCrop: { ...cropState },
  };
  cropBox.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onCropPointerMove(e) {
  if (!cropDragState || e.pointerId !== cropDragState.pointerId) return;
  const dx = e.clientX - cropDragState.startX;
  const dy = e.clientY - cropDragState.startY;
  let { x, y, width, height } = cropDragState.startCrop;

  if (cropDragState.mode === "move") {
    x += dx;
    y += dy;
  } else if (cropDragState.handle === "se") {
    if (cropDragState.handle.includes("e")) {
      width += dx;
    }
    if (cropDragState.handle.includes("s")) {
      height += dy;
    }
  }

  cropState = clampCropState({ x, y, width, height });
  updateCropUI();
}

function onCropPointerUp(e) {
  if (!cropDragState || e.pointerId !== cropDragState.pointerId) return;
  cropDragState = null;
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

async function openCamera() {
  // Check if we are on Android with native camera interface
  const isAndroid = /Android/i.test(navigator.userAgent);

  if (isAndroid) {
    // For Android, use the native JavaScript interface
    if (typeof Android !== "undefined" && Android.openCamera) {
      Android.openCamera();
      return;
    }
    // Fallback to HTML capture input if interface not available
    cameraInput.click();
    return;
  }

  // For Mac (and others), use the Rust command to open Photo Booth
  try {
    await invoke("open_camera");
  } catch (error) {
    console.error("Error opening camera:", error);
    alert(
      t("alert_open_camera_fail"),
    );
  }
}

// Global callback function for Android camera result
window.onCameraResult = async function (dataUrl) {
  if (dataUrl) {
    previewImg.src = dataUrl;
    // For Android dataUrl, we might need to fetch it to get bytes if we want to process it
    try {
      const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
      originalImageMime = match ? match[1] : null;
      const res = await fetch(dataUrl);
      const buf = await res.arrayBuffer();
      originalImageBytes = new Uint8Array(buf);
      currentImageBytes = new Uint8Array(originalImageBytes);
    } catch (e) {
      console.error("Failed to load camera image bytes", e);
    }
    showPreview();
  }
};

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
      // Use fs.readFile to read the file content directly
      // This bypasses asset protocol issues by reading into memory
      try {
        const contents = await readFile(filePath);
        originalImageBytes = new Uint8Array(contents);
        currentImageBytes = new Uint8Array(originalImageBytes);
        originalImageMime = guessMimeFromPath(filePath);
        const blob = new Blob([originalImageBytes]);
        previewImg.src = URL.createObjectURL(blob);
        showPreview();
      } catch (readError) {
        console.error("Error reading file with fs:", readError);
        // Fallback to convertFileSrc
        previewImg.src = convertFileSrc(filePath);
        // NOTE: convertFileSrc gives a URL, not bytes. Processing might fail if we can't fetch it.
        // Attempt to fetch bytes from the asset URL
        try {
          const res = await fetch(convertFileSrc(filePath));
          const buf = await res.arrayBuffer();
          originalImageBytes = new Uint8Array(buf);
          currentImageBytes = new Uint8Array(originalImageBytes);
          originalImageMime = guessMimeFromPath(filePath);
        } catch (e) {
          console.error("Failed to fetch asset bytes", e);
        }
        showPreview();
      }
    }
  } catch (error) {
    console.error("Error opening gallery:", error);
  }
}

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
    sensitivity: readFloat(sensitivityInput, 6.0),
    split_clusters: splitClustersInput ? splitClustersInput.checked : true,
  };
}

function scheduleProcess(options = {}) {
  if (!isPreviewVisible) return;
  if (!originalImageBytes && !currentImageBytes) return;
  if (processTimer) clearTimeout(processTimer);
  processTimer = setTimeout(() => {
    processTimer = null;
    runProcess(options);
  }, 100);
}

async function runProcess(options = {}) {
  if (!isPreviewVisible) return;
  if (isProcessing) {
    pendingProcess = true;
    pendingProcessOptions = options;
    return;
  }
  isProcessing = true;
  try {
    await processImage(options);
  } finally {
    isProcessing = false;
    if (pendingProcess) {
      pendingProcess = false;
      const nextOptions = pendingProcessOptions ?? {};
      pendingProcessOptions = null;
      runProcess(nextOptions);
    }
  }
}

async function processImage(options = {}) {
  const { applyCrop: shouldApplyCrop = true } = options;
  if (shouldApplyCrop && isCropping) {
    await applyCrop();
    exitCropMode();
  }

  const sourceBytes = originalImageBytes;
  if (!sourceBytes) {
    alert(t("alert_no_image"));
    return;
  }

  const previousCount = countValue ? Number(countValue.textContent) : 0;
  const fallbackCount = Number.isFinite(previousCount) ? previousCount : 0;
  startCountingAnimation();

  try {
    // Invoke Rust command
    const params = readParamsFromUI();
    const maskPayload = await buildMaskPayload();
    const result = await invoke("process_image", {
      payload: Array.from(sourceBytes),
      params,
      maskPayload: maskPayload ? Array.from(maskPayload) : null,
      mask_payload: maskPayload ? Array.from(maskPayload) : null,
    });

    // Update current bytes
    currentImageBytes = new Uint8Array(result.bytes);

    // Update preview
    const blob = new Blob([currentImageBytes]);
    previewImg.src = URL.createObjectURL(blob);
    updateCount(result.count);

  } catch (e) {
    updateCount(fallbackCount);
    console.error("Image processing failed:", e);
    alert(t("alert_process_fail", { error: e }));
  }
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

async function loadImageFromBytes(bytes, mime) {
  const blob = new Blob([bytes], { type: mime || "image/png" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  return await new Promise((resolve, reject) => {
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

window.addEventListener("DOMContentLoaded", () => {
  dragDropArea = document.querySelector("#dragDropArea");
  cameraBtn = document.querySelector("#cameraBtn");
  galleryBtn = document.querySelector("#galleryBtn");
  imageInput = document.querySelector("#imageInput");
  cameraInput = document.querySelector("#cameraInput");
  previewImg = document.querySelector("#previewImg");
  imagePreview = document.querySelector("#imagePreview");
  fullscreenCloseBtn = document.querySelector("#fullscreenCloseBtn");
  countLabel = document.querySelector("#countLabel");
  countPrefix = document.querySelector("#countLabel [data-i18n='count_prefix']");
  countValue = document.querySelector("#countValue");
  countSuffix = document.querySelector("#countSuffix");
  processActions = document.querySelector("#processActions");
  settingsPanel = document.querySelector("#settingsPanel");
  cropBtn = document.querySelector("#cropBtn");
  maskBtn = document.querySelector("#maskBtn");
  cropCancelBtn = document.querySelector("#cropCancelBtn");
  cropOverlay = document.querySelector("#cropOverlay");
  cropBox = document.querySelector("#cropBox");
  maskOverlay = document.querySelector("#maskOverlay");
  maskCanvas = document.querySelector("#maskCanvas");
  maskBrushControls = document.querySelector("#maskBrushControls");
  maskBrushInput = document.querySelector("#maskBrushSize");
  maskBrushValue = document.querySelector("#maskBrushSizeValue");
  cropMasks = {
    top: document.querySelector(".crop-mask-top"),
    right: document.querySelector(".crop-mask-right"),
    bottom: document.querySelector(".crop-mask-bottom"),
    left: document.querySelector(".crop-mask-left"),
  };
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

  const applySystemAccentFromAndroid = () => {
    if (!window.Android || typeof window.Android.getSystemAccentPalette !== "function") {
      return;
    }
    try {
      const paletteJson = window.Android.getSystemAccentPalette();
      if (!paletteJson) return;
      const palette = JSON.parse(paletteJson);
      const root = document.documentElement;
      if (!root) return;
      if (palette.accent) root.style.setProperty("--system-accent", palette.accent);
      if (palette.hover) root.style.setProperty("--system-accent-hover", palette.hover);
      if (palette.active) root.style.setProperty("--system-accent-active", palette.active);
    } catch (e) {
      console.warn("Failed to apply Android system accent:", e);
    }
  };

  isAndroid = /Android/i.test(navigator.userAgent);
  isMac = /Mac/i.test(navigator.userAgent);

  if (isAndroid) {
    document.body.classList.add("is-android");
    applySystemAccentFromAndroid();
    if (dragDropArea) {
      dragDropArea.style.display = "none";
    }
  } else if (isMac) {
    document.body.classList.add("is-mac");
  }

  if (dragDropArea && !isAndroid) {
    setupDragAndDrop();
  }

  if (cameraBtn) {
    cameraBtn.addEventListener("click", openCamera);
  }

  if (galleryBtn) {
    galleryBtn.addEventListener("click", openGallery);
  }

  if (cropBtn) {
    cropBtn.addEventListener("click", toggleCrop);
  }
  if (maskBtn) {
    maskBtn.addEventListener("click", toggleMask);
  }
  if (cropCancelBtn) {
    cropCancelBtn.addEventListener("click", () => {
      if (isCropping) {
        exitCropMode();
      } else if (isMasking) {
        exitMaskMode();
      }
    });
  }
  if (maskBrushInput) {
    maskBrushInput.value = String(DEFAULT_MASK_BRUSH_SIZE);
    maskBrushInput.addEventListener("input", updateMaskBrushValue);
    updateMaskBrushValue();
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
      updateRadiusLimits();
      syncMaskCanvasSize();
      renderMaskPreview();
    });
  }
  if (previewImg) {
    previewImg.addEventListener("dblclick", (e) => {
      const isAndroid = /Android/i.test(navigator.userAgent);
      if (isAndroid) return;
      e.preventDefault();
      e.stopPropagation();
      toggleFullscreenPreview();
    });

    previewImg.addEventListener(
      "touchstart",
      (e) => {
        const isAndroid = /Android/i.test(navigator.userAgent);
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
        const isAndroid = /Android/i.test(navigator.userAgent);
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

  if (cropBox) {
    cropBox.addEventListener("pointerdown", onCropPointerDown);
  }
  if (maskCanvas) {
    maskCanvas.addEventListener("pointerdown", onMaskPointerDown);
    maskCanvas.addEventListener("pointermove", onMaskPointerHover);
    maskCanvas.addEventListener("pointerenter", onMaskPointerHover);
    maskCanvas.addEventListener("pointerleave", clearMaskHover);
    maskCanvas.addEventListener("pointerout", clearMaskHover);
  }

  window.addEventListener("pointermove", onCropPointerMove);
  window.addEventListener("pointerup", onCropPointerUp);
  window.addEventListener("pointermove", onMaskPointerMove);
  window.addEventListener("pointerup", onMaskPointerUp);
  window.addEventListener("resize", () => {
    syncMaskCanvasSize();
    renderMaskPreview();
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
  ];

  settingsControls.forEach((control) => {
    if (!control) return;
    const eventName =
      control.tagName === "SELECT" || control.type === "checkbox"
        ? "change"
        : "input";
    control.addEventListener(eventName, () => {
      scheduleProcess({ applyCrop: false });
    });
  });

  updateCropButtonState(false);
  updateMaskButtonState(false);
  updateCancelButtonState();
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

  // Swipe back gesture for Android
  // Note: We use a swipe area starting at 50px to avoid conflict with system edge gestures
  if (isAndroid) {
    let touchStartX = 0;
    let touchStartY = 0;
    const swipeThreshold = 100;
    const maxVerticalDeviation = 80;
    const swipeStartZone = 100; // Start zone width (outside system edge gesture area)

    document.addEventListener("touchstart", (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener("touchend", (e) => {
      if (!isPreviewVisible) return;

      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const deltaX = touchEndX - touchStartX;
      const deltaY = Math.abs(touchEndY - touchStartY);

      // Swipe from left side (within swipeStartZone) to right
      if (touchStartX < swipeStartZone && deltaX > swipeThreshold && deltaY < maxVerticalDeviation) {
        resetApp();
      }
    }, { passive: true });
  }
});
