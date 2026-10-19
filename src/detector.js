// Bird detector of the web build: a port of src-tauri/src/blob_filter.rs to OpenCV.js.
// Constants, steps and their order follow the Rust code, so keep the two in sync. Images
// are 8-bit gray `cv.Mat`s; per-pixel steps work on the Mats' data views, which a later
// allocation can detach (the wasm heap grows), so views are taken right before each loop.
//
// Loaded by detector-worker.js (importScripts) and by the Node tests (require).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BirdDetector = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Float32 rounding, so thresholds compare like the Rust f32 code.
  const f = Math.fround;

  const MIN_CONTRAST = 0.08;
  const MAD_TO_SIGMA = f(1.4826);
  const MAX_TEXTURE = f(0.05);
  const SKY_SPECK_SIZE = 3;
  const LOW_THRESHOLD_RATIO = f(0.6);
  const SPLIT_NEIGHBOURS = 12;
  const SPLIT_NEIGHBOUR_DISTANCE = 12.0;
  const SPLIT_MIN_NEIGHBOURS = 4;
  const SPLIT_MAX_DETECTIONS = 4000;
  const BORDER_CLUTTER_RATIO = 3.0;
  const MAX_CLUTTER_RATIO = 25.0;
  const SKY_MASK_WINDOW = 5;
  const SKY_MAX_TEXTURE = f(0.3);
  const SKY_REACH = 15;
  const SKY_MIN_FRACTION = 0.05;

  // BlobParams::default(); missing fields fall back to these, like `#[serde(default)]`.
  const DEFAULT_PARAMS = {
    min_radius: 1.0,
    max_radius: 100.0,
    blur: 3,
    threshold_method: "background",
    adaptive_block: 31,
    adaptive_c: 4.0,
    morph_kernel: 3,
    morph_open_iter: 1,
    morph_close_iter: 1,
    auto_invert: true,
    invert: false,
    sensitivity: 9.0,
    split_clusters: true,
    sky_only: true,
  };
  const INT_PARAMS = ["blur", "adaptive_block", "morph_kernel", "morph_open_iter", "morph_close_iter"];

  function normalizeParams(params) {
    const out = { ...DEFAULT_PARAMS };
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) out[key] = value;
    }
    for (const key of INT_PARAMS) out[key] = Math.trunc(Number(out[key]));
    return out;
  }

  function oddKernel(value, minOdd) {
    let v = Math.max(value, Math.max(minOdd, 1));
    if (v % 2 === 0) v += 1;
    return v;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /** The crop clamped to an image of `cols` x `rows`; null when nothing is left. */
  function rectWithin(crop, cols, rows) {
    const x = clamp(Math.round(crop.x), 0, cols);
    const y = clamp(Math.round(crop.y), 0, rows);
    const right = clamp(Math.round(crop.x + crop.width), x, cols);
    const bottom = clamp(Math.round(crop.y + crop.height), y, rows);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  }

  function blobRadius(blob) {
    return Math.sqrt(blob.area / Math.PI);
  }

  function median(values) {
    if (values.length === 0) return 0;
    values.sort((a, b) => a - b);
    const mid = values.length >> 1;
    return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  }

  /**
   * Removes blobs much larger than a typical detection: anything touching the image edge
   * (trees, roofs, lamps) above BORDER_CLUTTER_RATIO and anything at all above
   * MAX_CLUTTER_RATIO median blobs.
   */
  function dropClutter(blobs) {
    const typical = median(blobs.map((blob) => blob.area));
    if (typical <= 0) return blobs;
    return blobs.filter((blob) => {
      const ratio = blob.area / typical;
      return ratio <= MAX_CLUTTER_RATIO && !(blob.touchesBorder && ratio > BORDER_CLUTTER_RATIO);
    });
  }

  /**
   * Estimates how many birds each blob holds by comparing its area with the median area of
   * nearby detections from the same flock (see split_merged in blob_filter.rs).
   */
  function splitMerged(blobs) {
    if (blobs.length > SPLIT_MAX_DETECTIONS) return blobs;
    const counts = blobs.map((blob) => {
      const neighbours = [];
      for (const other of blobs) {
        const distance = Math.hypot(other.x - blob.x, other.y - blob.y);
        if (distance <= SPLIT_NEIGHBOUR_DISTANCE * Math.sqrt(other.area)) {
          neighbours.push([distance, other.area]);
        }
      }
      if (neighbours.length < SPLIT_MIN_NEIGHBOURS) return 1;
      neighbours.sort((a, b) => a[0] - b[0]);
      const reference = median(neighbours.slice(0, SPLIT_NEIGHBOURS).map(([, area]) => area));
      if (reference <= 0) return 1;
      return Math.max(Math.round(blob.area / reference), 1);
    });
    return blobs.map((blob, i) => ({ ...blob, count: counts[i] }));
  }

  /** OpenCV.js objects to delete together; `free` deletes one early to save memory. */
  class Scope {
    constructor() {
      this.objects = [];
    }
    add(object) {
      this.objects.push(object);
      return object;
    }
    free(object) {
      const index = this.objects.indexOf(object);
      if (index >= 0) this.objects.splice(index, 1);
      if (!object.isDeleted()) object.delete();
    }
    release() {
      for (const object of this.objects) {
        if (!object.isDeleted()) object.delete();
      }
      this.objects = [];
    }
  }

  /** Binds the detector to an initialized OpenCV.js module. */
  function create(cv) {
    const anchor = () => new cv.Point(-1, -1);

    function mat(scope) {
      return scope.add(new cv.Mat());
    }

    function zeros(scope, rows, cols) {
      return scope.add(cv.Mat.zeros(rows, cols, cv.CV_8U));
    }

    function kernel(scope, shape, size) {
      return scope.add(cv.getStructuringElement(shape, new cv.Size(size, size), anchor()));
    }

    function invert(src, scope) {
      const out = mat(scope);
      cv.bitwise_not(src, out);
      return out;
    }

    function cropMat(src, rect, scope) {
      if (!rect || (rect.width >= src.cols && rect.height >= src.rows)) return src;
      const roi = src.roi(new cv.Rect(rect.x, rect.y, rect.width, rect.height));
      try {
        return scope.add(roi.clone());
      } finally {
        roi.delete();
      }
    }

    /** The painted mask (any size, nonzero = excluded) at the photo's size, as 0/255. */
    function decodeMask(mask, width, height, scope) {
      const local = new Scope();
      try {
        let resized = mask;
        if (mask.cols !== width || mask.rows !== height) {
          resized = mat(local);
          cv.resize(mask, resized, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);
        }
        const binary = mat(scope);
        cv.threshold(resized, binary, 1, 255, cv.THRESH_BINARY);
        return binary;
      } finally {
        local.release();
      }
    }

    /** Removes the connected components of `binary` that overlap `forbidden`. */
    function dropTouching(binary, forbidden, scope) {
      const local = new Scope();
      try {
        const labels = mat(local);
        const labelCount = cv.connectedComponents(binary, labels, 8, cv.CV_32S);
        const out = zeros(scope, binary.rows, binary.cols);
        const labelData = labels.data32S;
        const forbiddenData = forbidden.data;
        const outData = out.data;
        const touching = new Uint8Array(labelCount);
        for (let i = 0; i < labelData.length; i++) {
          if (forbiddenData[i] > 0) touching[labelData[i]] = 1;
        }
        for (let i = 0; i < labelData.length; i++) {
          const label = labelData[i];
          if (label > 0 && !touching[label]) outData[i] = 255;
        }
        return out;
      } finally {
        local.release();
      }
    }

    function applyExclusionMask(src, exclusion, scope) {
      const local = new Scope();
      try {
        const keep = invert(exclusion, local);
        const out = mat(scope);
        cv.bitwise_and(src, keep, out);
        return out;
      } finally {
        local.release();
      }
    }

    /**
     * Landscape components touching the sky mask are dropped whole, the painted mask only
     * cuts detections.
     */
    function applyMasks(binary, masks, scope) {
      let out = binary;
      if (masks.landscape) out = dropTouching(out, masks.landscape, scope);
      if (masks.exclusion) out = applyExclusionMask(out, masks.exclusion, scope);
      return out;
    }

    /** Mask (255) of the connected components whose bounding box satisfies `keep`. */
    function componentsWhere(binary, connectivity, keep, scope) {
      const local = new Scope();
      try {
        const labels = mat(local);
        const stats = mat(local);
        const centroids = mat(local);
        const labelCount = cv.connectedComponentsWithStats(
          binary,
          labels,
          stats,
          centroids,
          connectivity,
          cv.CV_32S,
        );
        const out = zeros(scope, binary.rows, binary.cols);
        const statData = stats.data32S;
        const width = stats.cols;
        const selected = new Uint8Array(labelCount);
        for (let label = 1; label < labelCount; label++) {
          const row = label * width;
          selected[label] = keep(
            statData[row + cv.CC_STAT_LEFT],
            statData[row + cv.CC_STAT_TOP],
            statData[row + cv.CC_STAT_WIDTH],
            statData[row + cv.CC_STAT_HEIGHT],
          )
            ? 1
            : 0;
        }
        const labelData = labels.data32S;
        const outData = out.data;
        for (let i = 0; i < labelData.length; i++) {
          if (selected[labelData[i]]) outData[i] = 255;
        }
        return out;
      } finally {
        local.release();
      }
    }

    /**
     * Finds everything that is not sky (255); null when there is (almost) no sky. See
     * landscape_mask in blob_filter.rs.
     */
    function landscapeMask(gray, window, brightBirds, scope) {
      const local = new Scope();
      try {
        const scale = Math.max(window / SKY_MASK_WINDOW, 1);
        const cols = Math.max(Math.round(gray.cols / scale), 1);
        const rows = Math.max(Math.round(gray.rows / scale), 1);
        const small = mat(local);
        cv.resize(gray, small, new cv.Size(cols, rows), 0, 0, cv.INTER_AREA);
        const smallF = mat(local);
        small.convertTo(smallF, cv.CV_32F, 1, 0);

        const borderValue = cv.morphologyDefaultBorderValue();
        const closed = mat(local);
        cv.morphologyEx(
          smallF,
          closed,
          brightBirds ? cv.MORPH_OPEN : cv.MORPH_CLOSE,
          kernel(local, cv.MORPH_RECT, SKY_MASK_WINDOW),
          anchor(),
          1,
          cv.BORDER_REPLICATE,
          borderValue,
        );

        const gx = mat(local);
        const gy = mat(local);
        cv.Sobel(closed, gx, cv.CV_32F, 1, 0, 3, 1, 0, cv.BORDER_REPLICATE);
        cv.Sobel(closed, gy, cv.CV_32F, 0, 1, 3, 1, 0, cv.BORDER_REPLICATE);
        const gradient = mat(local);
        cv.magnitude(gx, gy, gradient);
        {
          const closedData = closed.data32F;
          const gradientData = gradient.data32F;
          for (let i = 0; i < gradientData.length; i++) {
            gradientData[i] = gradientData[i] / Math.max(closedData[i], 1);
          }
        }
        const textureWindow = 2 * SKY_MASK_WINDOW - 1;
        const texture = mat(local);
        cv.blur(
          gradient,
          texture,
          new cv.Size(textureWindow, textureWindow),
          anchor(),
          cv.BORDER_REPLICATE,
        );

        const smooth = zeros(local, rows, cols);
        {
          const textureData = texture.data32F;
          const smoothData = smooth.data;
          for (let i = 0; i < textureData.length; i++) {
            if (textureData[i] <= SKY_MAX_TEXTURE) smoothData[i] = 255;
          }
        }

        // Candidate sky: smooth components reaching the top edge.
        const topSmooth = componentsWhere(smooth, 4, (_left, top) => top === 0, local);
        // Landscape: the rest of the image connected to its edges, together with rough
        // islands near it. Islands farther away are dense flocks or sharp cloud edges.
        const notSky = invert(topSmooth, local);
        const reach = 2 * SKY_REACH + 1;
        const grown = mat(local);
        cv.dilate(
          notSky,
          grown,
          kernel(local, cv.MORPH_ELLIPSE, reach),
          anchor(),
          1,
          cv.BORDER_CONSTANT,
          borderValue,
        );
        const landscapeZone = componentsWhere(
          grown,
          8,
          (left, top, width, height) =>
            left === 0 || top === 0 || left + width >= cols || top + height >= rows,
          local,
        );
        const landscape = mat(local);
        cv.bitwise_and(notSky, landscapeZone, landscape);

        const landscapePixels = cv.countNonZero(landscape);
        const total = cols * rows;
        if (total - landscapePixels < SKY_MIN_FRACTION * total) return null;

        const upscaled = mat(local);
        cv.resize(landscape, upscaled, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR);
        const full = mat(scope);
        cv.threshold(upscaled, full, 127, 255, cv.THRESH_BINARY);
        return full;
      } finally {
        local.release();
      }
    }

    /**
     * Estimates the sky without birds and keeps blobs that are clearly darker than it
     * (Weber contrast against a threshold that rises with the local cloud texture).
     */
    function detectBackground(gray, masks, params) {
      const s = new Scope();
      try {
        const subject = params.invert ? invert(gray, s) : gray;
        const borderValue = cv.morphologyDefaultBorderValue();

        // Closing with a window larger than a bird's thickness erases the birds and leaves
        // the sky; the box blur smooths its blocky edges. The opening before it removes
        // bright specks the closing would otherwise spread.
        const despeckled = mat(s);
        cv.morphologyEx(
          subject,
          despeckled,
          cv.MORPH_OPEN,
          kernel(s, cv.MORPH_RECT, SKY_SPECK_SIZE),
          anchor(),
          1,
          cv.BORDER_REPLICATE,
          borderValue,
        );
        const window = oddKernel(params.adaptive_block, 3);
        const background = mat(s);
        cv.morphologyEx(
          despeckled,
          background,
          cv.MORPH_CLOSE,
          kernel(s, cv.MORPH_RECT, window),
          anchor(),
          1,
          cv.BORDER_REPLICATE,
          borderValue,
        );
        s.free(despeckled);
        const smoothBackground = mat(s);
        cv.blur(background, smoothBackground, new cv.Size(window, window), anchor(), cv.BORDER_REPLICATE);
        s.free(background);

        let subjectF = mat(s);
        subject.convertTo(subjectF, cv.CV_32F, 1, 0);
        const blurK = oddKernel(params.blur, 1);
        if (blurK > 1) {
          const smoothed = mat(s);
          cv.GaussianBlur(subjectF, smoothed, new cv.Size(blurK, blurK), 0, 0, cv.BORDER_DEFAULT);
          s.free(subjectF);
          subjectF = smoothed;
        }

        // Relative darkness (Weber contrast), and its absolute value quantized to 8 bits (up
        // to the texture cap) for the median filter.
        const rows = gray.rows;
        const cols = gray.cols;
        const contrast = new Float32Array(rows * cols);
        const deviation = zeros(s, rows, cols);
        const deviationCap = f(MAX_TEXTURE / MAD_TO_SIGMA);
        {
          const backgroundData = smoothBackground.data;
          const subjectData = subjectF.data32F;
          const deviationData = deviation.data;
          for (let i = 0; i < contrast.length; i++) {
            const sky = backgroundData[i];
            const signed = f(f(sky - subjectData[i]) / Math.max(sky, 1));
            contrast[i] = clamp(signed, 0, 1);
            deviationData[i] = Math.round(f(f(Math.min(Math.abs(signed), deviationCap) / deviationCap) * 255));
          }
        }
        s.free(subjectF);
        s.free(smoothBackground);

        const texture = mat(s);
        cv.medianBlur(deviation, texture, oddKernel(3 * window, 3));
        s.free(deviation);

        // Significance: contrast divided by the local threshold (> 1 means a detection).
        const sensitivity = f(Math.max(params.sensitivity, 0));
        const textureScale = f(MAX_TEXTURE / 255);
        const minContrast = f(MIN_CONTRAST);
        const significance = new Float32Array(rows * cols);
        let candidates = zeros(s, rows, cols);
        {
          const textureData = texture.data;
          const candidateData = candidates.data;
          const scale = f(sensitivity * textureScale);
          for (let i = 0; i < significance.length; i++) {
            const threshold = Math.max(f(scale * textureData[i]), minContrast);
            const q = f(contrast[i] / threshold);
            significance[i] = q;
            if (q > LOW_THRESHOLD_RATIO) candidateData[i] = 255;
          }
        }
        s.free(texture);
        candidates = applyMasks(candidates, masks, s);

        const labels = mat(s);
        const stats = mat(s);
        const centroids = mat(s);
        const labelCount = cv.connectedComponentsWithStats(
          candidates,
          labels,
          stats,
          centroids,
          8,
          cv.CV_32S,
        );

        // Hysteresis: keep only components whose strongest pixel passes the threshold.
        const peaks = new Float32Array(labelCount);
        {
          const labelData = labels.data32S;
          for (let i = 0; i < labelData.length; i++) {
            const label = labelData[i];
            if (significance[i] > peaks[label]) peaks[label] = significance[i];
          }
        }

        const blobs = [];
        const statData = stats.data32S;
        const statWidth = stats.cols;
        const centroidData = centroids.data64F;
        for (let label = 1; label < labelCount; label++) {
          if (peaks[label] <= 1) continue;
          const row = label * statWidth;
          const left = statData[row + cv.CC_STAT_LEFT];
          const top = statData[row + cv.CC_STAT_TOP];
          const touchesBorder =
            left === 0 ||
            top === 0 ||
            left + statData[row + cv.CC_STAT_WIDTH] >= cols ||
            top + statData[row + cv.CC_STAT_HEIGHT] >= rows;
          blobs.push({
            x: centroidData[label * 2],
            y: centroidData[label * 2 + 1],
            area: statData[row + cv.CC_STAT_AREA],
            count: 1,
            touchesBorder,
          });
        }
        return blobs;
      } finally {
        s.release();
      }
    }

    function thresholdImage(blurred, method, adaptiveBlock, adaptiveC, scope) {
      const binary = mat(scope);
      if (method.trim().toLowerCase() === "adaptive") {
        cv.adaptiveThreshold(
          blurred,
          binary,
          255,
          cv.ADAPTIVE_THRESH_GAUSSIAN_C,
          cv.THRESH_BINARY,
          oddKernel(adaptiveBlock, 3),
          adaptiveC,
        );
      } else {
        cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      }
      return binary;
    }

    /** Classic pipeline: global/adaptive threshold, morphology and external contours. */
    function detectThreshold(gray, masks, params) {
      const s = new Scope();
      try {
        const blurK = oddKernel(params.blur, 1);
        const blurred = mat(s);
        cv.GaussianBlur(gray, blurred, new cv.Size(blurK, blurK), 0, 0, cv.BORDER_DEFAULT);

        let binary = thresholdImage(
          blurred,
          params.threshold_method,
          params.adaptive_block,
          params.adaptive_c,
          s,
        );
        if (params.auto_invert) {
          const white = cv.countNonZero(binary);
          const total = binary.rows * binary.cols;
          if (total > 0 && white / total > 0.5) binary = invert(binary, s);
        }
        if (params.invert) binary = invert(binary, s);

        const morphKernel = kernel(s, cv.MORPH_ELLIPSE, oddKernel(params.morph_kernel, 1));
        const openIter = Math.max(params.morph_open_iter, 0);
        const closeIter = Math.max(params.morph_close_iter, 0);
        const zero = new cv.Scalar(0, 0, 0, 0);
        let cleaned = binary;
        if (openIter > 0) {
          const opened = mat(s);
          cv.morphologyEx(cleaned, opened, cv.MORPH_OPEN, morphKernel, anchor(), openIter, cv.BORDER_CONSTANT, zero);
          cleaned = opened;
        }
        if (closeIter > 0) {
          const closed = mat(s);
          cv.morphologyEx(cleaned, closed, cv.MORPH_CLOSE, morphKernel, anchor(), closeIter, cv.BORDER_CONSTANT, zero);
          cleaned = closed;
        }
        cleaned = applyMasks(cleaned, masks, s);

        const contours = s.add(new cv.MatVector());
        const hierarchy = mat(s);
        cv.findContours(cleaned, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        const blobs = [];
        for (let i = 0; i < contours.size(); i++) {
          const contour = contours.get(i);
          try {
            const area = cv.contourArea(contour, false);
            if (area <= 0) continue;
            const moments = cv.moments(contour, false);
            if (moments.m00 === 0) continue;
            const bounds = cv.boundingRect(contour);
            blobs.push({
              x: moments.m10 / moments.m00,
              y: moments.m01 / moments.m00,
              area,
              count: 1,
              touchesBorder:
                bounds.x === 0 ||
                bounds.y === 0 ||
                bounds.x + bounds.width >= cleaned.cols ||
                bounds.y + bounds.height >= cleaned.rows,
            });
          } finally {
            contour.delete();
          }
        }
        return blobs;
      } finally {
        s.release();
      }
    }

    /**
     * Finds the birds in `full` (8-bit gray, the whole photo), or in its `crop` region.
     * `mask` (8-bit, any size, nonzero = excluded) covers the whole photo. Positions are in
     * pixels of the whole photo, like BlobFilter::detect.
     */
    function detect(full, mask, rawParams, crop) {
      const params = normalizeParams(rawParams);
      const scope = new Scope();
      try {
        let rect = null;
        if (crop) {
          rect = rectWithin(crop, full.cols, full.rows);
          if (!rect) throw new Error("Crop is outside the image");
        }
        const gray = cropMat(full, rect, scope);
        const exclusion = mask
          ? cropMat(decodeMask(mask, full.cols, full.rows, scope), rect, scope)
          : null;
        const landscape = params.sky_only
          ? landscapeMask(gray, oddKernel(params.adaptive_block, 3), params.invert, scope)
          : null;
        const masks = { exclusion, landscape };

        let blobs =
          params.threshold_method.trim().toLowerCase() === "background"
            ? detectBackground(gray, masks, params)
            : detectThreshold(gray, masks, params);

        const minRadius = Math.max(params.min_radius, 0);
        const maxRadius = Math.max(params.max_radius, minRadius);
        blobs = blobs.filter((blob) => {
          const radius = blobRadius(blob);
          return radius >= minRadius && radius <= maxRadius;
        });
        blobs = dropClutter(blobs);
        if (params.split_clusters) blobs = splitMerged(blobs);

        const originX = rect ? rect.x : 0;
        const originY = rect ? rect.y : 0;
        const birds = blobs.map((blob) => ({
          x: blob.x + originX,
          y: blob.y + originY,
          radius: blobRadius(blob),
          count: blob.count,
        }));
        return { birds, count: birds.reduce((sum, bird) => sum + bird.count, 0) };
      } finally {
        scope.release();
      }
    }

    return { detect };
  }

  return { create, DEFAULT_PARAMS, dropClutter, splitMerged };
});
