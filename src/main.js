const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;

let dragDropArea;
let cameraBtn;
let galleryBtn;
let imageInput;
let previewImg;
let imagePreview;

function setupDragAndDrop() {
  dragDropArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDropArea.classList.add("drag-over");
  });

  dragDropArea.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDropArea.classList.remove("drag-over");
  });

  dragDropArea.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDropArea.classList.remove("drag-over");

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (file.type.startsWith("image/")) {
        handleImageFile(file);
      } else {
        alert("Please drop an image file");
      }
    }
  });

  dragDropArea.addEventListener("click", () => {
    imageInput.click();
  });

  imageInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      const file = e.target.files[0];
      handleImageFile(file);
    }
  });
}

function handleImageFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    previewImg.src = e.target.result;
    imagePreview.style.display = "block";
    dragDropArea.style.display = "none";
    cameraBtn.style.display = "none";
    galleryBtn.style.display = "none";
  };
  reader.readAsDataURL(file);
}

async function openCamera() {
  try {
    await invoke("open_camera");
  } catch (error) {
    console.error("Error opening camera:", error);
    alert(
      "Could not open camera. Please ensure camera permissions are granted.",
    );
  }
}

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
      const reader = new FileReader();
      // For Tauri, we need to read the file differently
      fetch(`tauri://localhost${filePath}`)
        .then((response) => response.blob())
        .then((blob) => {
          const fileReader = new FileReader();
          fileReader.onload = (e) => {
            previewImg.src = e.target.result;
            imagePreview.style.display = "block";
            dragDropArea.style.display = "none";
            cameraBtn.style.display = "none";
            galleryBtn.style.display = "none";
          };
          fileReader.readAsDataURL(blob);
        })
        .catch((error) => {
          console.error("Error reading file:", error);
          alert("Could not load image from gallery");
        });
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
  previewImg = document.querySelector("#previewImg");
  imagePreview = document.querySelector("#imagePreview");

  setupDragAndDrop();

  cameraBtn.addEventListener("click", openCamera);
  galleryBtn.addEventListener("click", openGallery);

  // Close preview on image click
  previewImg.addEventListener("click", () => {
    imagePreview.style.display = "none";
    dragDropArea.style.display = "flex";
    cameraBtn.style.display = "flex";
    galleryBtn.style.display = "flex";
  });
});
