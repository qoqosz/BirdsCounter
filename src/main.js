const { invoke, convertFileSrc } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { readFile } = window.__TAURI__.fs;

const MIN_CROP_SIZE = 40;
const SUPPORTED_LANGS = ["en", "pl"];
const DEFAULT_LANG = "en";

let dragDropArea;
let cameraBtn;
let galleryBtn;
let imageInput;
let cameraInput;
let previewImg;
let imagePreview;
let processBtn;
let cropBtn;
let processActions;
let cropOverlay;
let cropBox;
let cropMasks = {};
let countLabel;
let countValue;
let backBtn;
let currentImageBytes = null;
let isPreviewVisible = false;
let isCropping = false;
let cropState = null;
let cropBounds = { width: 0, height: 0 };
let cropDragState = null;
let langSelect;
let translations = {};
let currentLang = DEFAULT_LANG;

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
    currentImageBytes = new Uint8Array(e.target.result);
    // Create blob for display
    const blob = new Blob([currentImageBytes], { type: file.type });
    previewImg.src = URL.createObjectURL(blob);
    showPreview();
  };
  // Read as ArrayBuffer to get raw bytes
  reader.readAsArrayBuffer(file);
}

function showPreview() {
  isPreviewVisible = true;
  imagePreview.style.display = "block";
  if (countLabel) countLabel.style.display = "block";
  if (processActions) processActions.style.display = "flex";
  if (backBtn) backBtn.style.display = "flex";
  dragDropArea.style.display = "none";
  document.querySelector(".button-container").style.display = "none";
  resetCropUI();
  updateCount(0);
}

function resetApp() {
  isPreviewVisible = false;
  imagePreview.style.display = "none";
  if (countLabel) countLabel.style.display = "none";
  if (processActions) processActions.style.display = "none";
  if (backBtn) backBtn.style.display = "none";
  dragDropArea.style.display = "flex";
  document.querySelector(".button-container").style.display = "flex";
  currentImageBytes = null;
  if (previewImg) previewImg.src = "";
  resetCropUI();
  updateCount(0);
}

function updateCount(value) {
  if (!countValue) return;
  countValue.textContent = String(value);
}

function updateCropButtonState(active) {
  if (!cropBtn) return;
  cropBtn.classList.toggle("is-active", active);
  cropBtn.setAttribute("aria-pressed", active ? "true" : "false");
}

function resetCropUI() {
  isCropping = false;
  cropState = null;
  cropDragState = null;
  if (cropOverlay) {
    cropOverlay.classList.remove("is-active");
  }
  updateCropButtonState(false);
}

function syncCropBounds() {
  if (!previewImg) return;
  const rect = previewImg.getBoundingClientRect();
  cropBounds = {
    width: rect.width,
    height: rect.height,
  };
}

function setCropToFull() {
  syncCropBounds();
  cropState = {
    x: 0,
    y: 0,
    width: cropBounds.width,
    height: cropBounds.height,
  };
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

  cropOverlay.classList.add("is-active");
  isCropping = true;
  updateCropButtonState(true);
  requestAnimationFrame(() => {
    if (isCropping) {
      setCropToFull();
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
}

async function applyCrop() {
  if (!cropState || !previewImg) return;
  const imageRect = previewImg.getBoundingClientRect();
  if (imageRect.width === 0 || imageRect.height === 0) return;

  const scaleX = previewImg.naturalWidth / imageRect.width;
  const scaleY = previewImg.naturalHeight / imageRect.height;

  const sx = Math.max(0, Math.round(cropState.x * scaleX));
  const sy = Math.max(0, Math.round(cropState.y * scaleY));
  const sWidth = Math.max(1, Math.round(cropState.width * scaleX));
  const sHeight = Math.max(1, Math.round(cropState.height * scaleY));

  const canvas = document.createElement("canvas");
  canvas.width = sWidth;
  canvas.height = sHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(previewImg, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) return;

  const buf = await blob.arrayBuffer();
  currentImageBytes = new Uint8Array(buf);
  previewImg.src = URL.createObjectURL(blob);
  updateCount(0);
}

async function toggleCrop() {
  if (!isCropping) {
    enterCropMode();
    return;
  }

  await applyCrop();
  exitCropMode();
}

function onCropPointerDown(e) {
  if (!isCropping || !cropState || !cropBox) return;
  const handle = e.target.closest(".crop-handle");
  cropDragState = {
    pointerId: e.pointerId,
    mode: handle ? "resize" : "move",
    handle: handle ? handle.dataset.handle : null,
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
  } else if (cropDragState.handle) {
    if (cropDragState.handle.includes("e")) {
      width += dx;
    }
    if (cropDragState.handle.includes("w")) {
      width -= dx;
      x += dx;
    }
    if (cropDragState.handle.includes("s")) {
      height += dy;
    }
    if (cropDragState.handle.includes("n")) {
      height -= dy;
      y += dy;
    }
  }

  cropState = clampCropState({ x, y, width, height });
  updateCropUI();
}

function onCropPointerUp(e) {
  if (!cropDragState || e.pointerId !== cropDragState.pointerId) return;
  cropDragState = null;
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
      const res = await fetch(dataUrl);
      const buf = await res.arrayBuffer();
      currentImageBytes = new Uint8Array(buf);
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
        currentImageBytes = contents; // contents is already Uint8Array from tauri-plugin-fs
        const blob = new Blob([contents]);
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
          currentImageBytes = new Uint8Array(buf);
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

async function processImage() {
  if (!currentImageBytes) {
    alert(t("alert_no_image"));
    return;
  }

  if (isCropping) {
    await applyCrop();
    exitCropMode();
  }

  try {
    // Invoke Rust command
    const result = await invoke("process_image", { payload: Array.from(currentImageBytes) });

    // Update current bytes
    currentImageBytes = new Uint8Array(result.bytes);

    // Update preview
    const blob = new Blob([currentImageBytes]);
    previewImg.src = URL.createObjectURL(blob);
    updateCount(result.count);

  } catch (e) {
    console.error("Image processing failed:", e);
    alert(t("alert_process_fail", { error: e }));
  }
}

window.addEventListener("DOMContentLoaded", () => {
  dragDropArea = document.querySelector("#dragDropArea");
  cameraBtn = document.querySelector("#cameraBtn");
  galleryBtn = document.querySelector("#galleryBtn");
  imageInput = document.querySelector("#imageInput");
  cameraInput = document.querySelector("#cameraInput");
  previewImg = document.querySelector("#previewImg");
  imagePreview = document.querySelector("#imagePreview");
  countLabel = document.querySelector("#countLabel");
  countValue = document.querySelector("#countValue");
  processActions = document.querySelector("#processActions");
  processBtn = document.querySelector("#processBtn");
  cropBtn = document.querySelector("#cropBtn");
  cropOverlay = document.querySelector("#cropOverlay");
  cropBox = document.querySelector("#cropBox");
  cropMasks = {
    top: document.querySelector(".crop-mask-top"),
    right: document.querySelector(".crop-mask-right"),
    bottom: document.querySelector(".crop-mask-bottom"),
    left: document.querySelector(".crop-mask-left"),
  };
  backBtn = document.querySelector("#backBtn");
  langSelect = document.querySelector("#langSelect");

  if (dragDropArea) {
    setupDragAndDrop();
  }

  if (cameraBtn) {
    cameraBtn.addEventListener("click", openCamera);
  }

  if (galleryBtn) {
    galleryBtn.addEventListener("click", openGallery);
  }

  if (processBtn) {
    processBtn.addEventListener("click", processImage);
  }

  if (cropBtn) {
    cropBtn.addEventListener("click", toggleCrop);
  }

  if (cropBox) {
    cropBox.addEventListener("pointerdown", onCropPointerDown);
  }

  window.addEventListener("pointermove", onCropPointerMove);
  window.addEventListener("pointerup", onCropPointerUp);

  // Back button click handler
  if (backBtn) {
    backBtn.addEventListener("click", resetApp);
  }

  if (langSelect) {
    langSelect.addEventListener("change", (e) => {
      setLanguage(e.target.value);
    });
  }

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

  // Platform detection for styling
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isMac = /Mac/i.test(navigator.userAgent);

  if (isAndroid) {
    document.body.classList.add("is-android");
  } else if (isMac) {
    document.body.classList.add("is-mac");
  }

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
