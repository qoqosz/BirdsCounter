const { invoke, convertFileSrc } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { readFile } = window.__TAURI__.fs;

let dragDropArea;
let cameraBtn;
let galleryBtn;
let imageInput;
let cameraInput;
let previewImg;
let imagePreview;
let processBtn;
let backBtn;
let currentImageBytes = null;
let isPreviewVisible = false;

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
      alert("Please drop an image file");
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
  if (processBtn) processBtn.style.display = "flex";
  if (backBtn) backBtn.style.display = "flex";
  dragDropArea.style.display = "none";
  document.querySelector(".button-container").style.display = "none";
}

function resetApp() {
  isPreviewVisible = false;
  imagePreview.style.display = "none";
  if (processBtn) processBtn.style.display = "none";
  if (backBtn) backBtn.style.display = "none";
  dragDropArea.style.display = "flex";
  document.querySelector(".button-container").style.display = "flex";
  currentImageBytes = null;
  if (previewImg) previewImg.src = "";
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
      "Could not open camera. Please ensure camera permissions are granted.",
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
          name: "Image",
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
    alert("No image loaded to process!");
    return;
  }

  try {
    // Invoke Rust command
    const processedBytes = await invoke("process_image", { payload: Array.from(currentImageBytes) });

    // Update current bytes
    currentImageBytes = new Uint8Array(processedBytes);

    // Update preview
    const blob = new Blob([currentImageBytes]);
    previewImg.src = URL.createObjectURL(blob);

  } catch (e) {
    console.error("Image processing failed:", e);
    alert("Failed to process image: " + e);
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
  processBtn = document.querySelector("#processBtn");
  backBtn = document.querySelector("#backBtn");

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

  // Back button click handler
  if (backBtn) {
    backBtn.addEventListener("click", resetApp);
  }

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
