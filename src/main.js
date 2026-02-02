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
    previewImg.src = e.target.result;
    showPreview();
  };
  reader.readAsDataURL(file);
}

function showPreview() {
  imagePreview.style.display = "block";
  dragDropArea.style.display = "none";
  cameraBtn.style.display = "none";
  galleryBtn.style.display = "none";
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
window.onCameraResult = function (dataUrl) {
  if (dataUrl) {
    previewImg.src = dataUrl;
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
        const blob = new Blob([contents]);
        previewImg.src = URL.createObjectURL(blob);
        showPreview();
      } catch (readError) {
        console.error("Error reading file with fs:", readError);
        // Fallback to convertFileSrc
        previewImg.src = convertFileSrc(filePath);
        showPreview();
      }
    }
  } catch (error) {
    console.error("Error opening gallery:", error);
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

  if (dragDropArea) {
    setupDragAndDrop();
  }

  if (cameraBtn) {
    cameraBtn.addEventListener("click", openCamera);
  }

  if (galleryBtn) {
    galleryBtn.addEventListener("click", openGallery);
  }

  // Close preview on image click
  if (previewImg) {
    previewImg.addEventListener("click", () => {
      imagePreview.style.display = "none";
      dragDropArea.style.display = "flex";
      cameraBtn.style.display = "flex";
      galleryBtn.style.display = "flex";
    });
  }
});
