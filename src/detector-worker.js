// Web build: counts birds off the main thread (started by web.js). The photo is decoded
// once and kept in gray for the following requests, which only change settings, crop or
// mask.
importScripts("vendor/opencv.js", "detector.js");

// WebKit refuses canvases over 16.7 MP (and draws nothing into them); larger photos are
// counted scaled down to that size.
const MAX_CANVAS_PIXELS = 4096 * 4096;

let cvReady = null;
let detector = null;
// { id, gray, scale }: gray is the photo scaled by `scale` (1 unless it was too large).
let photo = null;
let queue = Promise.resolve();

function loadDetector() {
  if (!cvReady) {
    cvReady = Promise.resolve(self.cv).then((cv) => {
      detector = BirdDetector.create(cv);
      return cv;
    });
  }
  return cvReady;
}

function readPixels(bitmap, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

/** Pixels of an opaque photo; null when the canvas was over the limit and stayed empty. */
function readPhotoPixels(bitmap, width, height) {
  const pixels = readPixels(bitmap, width, height);
  return pixels && (pixels[3] !== 0 || pixels[pixels.length - 1] !== 0) ? pixels : null;
}

async function decodeBitmap(bytes) {
  return createImageBitmap(new Blob([bytes]), {
    imageOrientation: "from-image",
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
}

async function decodePhoto(cv, bytes) {
  const bitmap = await decodeBitmap(bytes);
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    let scale = 1;
    let pixels = width * height <= MAX_CANVAS_PIXELS ? readPhotoPixels(bitmap, width, height) : null;
    if (!pixels) {
      scale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
      width = Math.max(1, Math.floor(width * scale));
      height = Math.max(1, Math.floor(height * scale));
      scale = width / bitmap.width;
      pixels = readPhotoPixels(bitmap, width, height);
      if (!pixels) throw new Error("photo-unreadable");
    }
    // cv::cvtColor's fixed-point BGR2GRAY weights, so gray levels match the desktop app.
    const gray = new cv.Mat(height, width, cv.CV_8U);
    const out = gray.data;
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = (pixels[p] * 4899 + pixels[p + 1] * 9617 + pixels[p + 2] * 1868 + 8192) >> 14;
    }
    return { gray, scale };
  } finally {
    bitmap.close();
  }
}

/** The painted mask (white strokes on transparent) as 0/255 by its alpha. */
async function decodeMask(cv, bytes) {
  const bitmap = await decodeBitmap(bytes);
  try {
    const pixels = readPixels(bitmap, bitmap.width, bitmap.height);
    if (!pixels) throw new Error("Mask decode failed");
    const mask = new cv.Mat(bitmap.height, bitmap.width, cv.CV_8U);
    const out = mask.data;
    for (let i = 0; i < out.length; i++) out[i] = pixels[i * 4 + 3] > 0 ? 255 : 0;
    return mask;
  } finally {
    bitmap.close();
  }
}

async function processImage({ photoId, bytes, mask, params, crop }) {
  const cv = await loadDetector();
  if (!photo || photo.id !== photoId) {
    if (!bytes) throw new Error("photo-missing");
    photo?.gray.delete();
    photo = null;
    photo = { id: photoId, ...(await decodePhoto(cv, bytes)) };
  }
  const { gray, scale } = photo;
  const maskMat = mask ? await decodeMask(cv, mask) : null;
  try {
    // Sizes are in photo pixels, so they shrink with a scaled-down photo.
    const scaled = { ...params };
    if (scale !== 1) {
      if (typeof scaled.min_radius === "number") scaled.min_radius *= scale;
      if (typeof scaled.max_radius === "number") scaled.max_radius *= scale;
    }
    const scaledCrop = crop
      ? {
          x: crop.x * scale,
          y: crop.y * scale,
          width: crop.width * scale,
          height: crop.height * scale,
        }
      : null;
    const result = detector.detect(gray, maskMat, scaled, scaledCrop);
    if (scale !== 1) {
      for (const bird of result.birds) {
        bird.x /= scale;
        bird.y /= scale;
        bird.radius /= scale;
      }
    }
    return result;
  } finally {
    maskMat?.delete();
  }
}

self.onmessage = (event) => {
  const { requestId, type } = event.data;
  // One request at a time: they share the cached photo.
  queue = queue.then(async () => {
    try {
      const result = type === "init" ? (await loadDetector(), null) : await processImage(event.data);
      self.postMessage({ requestId, result });
    } catch (e) {
      self.postMessage({ requestId, error: String(e?.message ?? e) });
    }
  });
};
