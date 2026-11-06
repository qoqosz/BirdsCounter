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
  const SPLIT_CROWDED_COVERAGE = 0.2;
  const SPLIT_PACKED_COVERAGE = 0.3;
  const SPLIT_PACKED_QUANTILE = 0.2;
  const BORDER_CLUTTER_RATIO = 3.0;
  const MAX_CLUTTER_RATIO = 25.0;
  const SKY_MASK_WINDOW = 5;
  const SKY_MAX_TEXTURE = f(0.3);
  const SKY_REACH = 15;
  const SKY_MIN_FRACTION = 0.05;
  const SKY_TOP_TRUSTED_FRACTION = 0.25;
  const SKY_BLOCKER_BRIGHTNESS = 1.6;
  const WINDOW_REFERENCE_SIDE = 2000.0;
  const MAX_MEDIAN_WINDOW = 255;
  const MAX_WORKING_SIDE = 2048;
  const LANDSCAPE_GAP_RATIO = 0.25;
  const LANDSCAPE_LINK_SENSITIVITY = f(9.0);
  const LANDSCAPE_REACH_WINDOWS = 4.0;
  const LANDSCAPE_LINK_REACH_WINDOWS = 8.0;
  const LANDSCAPE_CUT_WINDOWS = 1.0;
  const FRAGMENT_RATIO = 0.12;
  const FRAGMENT_MAX_BIRDS = 3.0;
  const DOT_MAX_AREA = 20.0;
  const DOT_MAX_SIDE = 7.0;
  const DOT_MEDIAN_RATIO = 0.5;

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

  /** The local window in pixels of a photo of `cols` x `rows` (see scaled_window). */
  function scaledWindow(setting, cols, rows) {
    return oddKernel(Math.round((setting * Math.max(cols, rows)) / WINDOW_REFERENCE_SIDE), 3);
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

  /** The `q` quantile of `values`, interpolated between neighbouring values (see quantile). */
  function quantile(values, q) {
    if (values.length === 0) return 0;
    values.sort((a, b) => a - b);
    const position = clamp(q, 0, 1) * (values.length - 1);
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return values[low] + (values[high] - values[low]) * (position - low);
  }

  /**
   * The SPLIT_NEIGHBOURS detections nearest to `blob` as [distance, area], nearest first; null
   * when there are too few of them to tell (see neighbours in blob_filter.rs).
   */
  function neighboursOf(blob, blobs) {
    const neighbours = [];
    for (const other of blobs) {
      const distance = Math.hypot(other.x - blob.x, other.y - blob.y);
      if (distance <= SPLIT_NEIGHBOUR_DISTANCE * Math.sqrt(other.area)) {
        neighbours.push([distance, other.area]);
      }
    }
    if (neighbours.length < SPLIT_MIN_NEIGHBOURS) return null;
    neighbours.sort((a, b) => a[0] - b[0]);
    return neighbours.slice(0, SPLIT_NEIGHBOURS);
  }

  /** The median area of the detections near `blob` (see local_area). */
  function localArea(blob, blobs) {
    const neighbours = neighboursOf(blob, blobs);
    return neighbours === null ? null : median(neighbours.map(([, area]) => area));
  }

  /**
   * The area of a single bird near `blob`: the median of its neighbours, or a lower quantile when
   * they are crowded (see single_area).
   */
  function singleArea(blob, blobs) {
    const neighbours = neighboursOf(blob, blobs);
    if (neighbours === null) return null;
    const radius = neighbours[neighbours.length - 1][0];
    const areas = neighbours.map(([, area]) => area);
    let crowding = 0;
    if (radius > 0) {
      const coverage = areas.reduce((sum, area) => sum + area, 0) / (Math.PI * radius * radius);
      crowding = clamp(
        (coverage - SPLIT_CROWDED_COVERAGE) / (SPLIT_PACKED_COVERAGE - SPLIT_CROWDED_COVERAGE),
        0,
        1,
      );
    }
    return quantile(areas, 0.5 - crowding * (0.5 - SPLIT_PACKED_QUANTILE));
  }

  /**
   * Removes blobs much larger than a typical detection: anything touching the image edge
   * (trees, roofs, lamps) above BORDER_CLUTTER_RATIO median blobs, and anything else above
   * MAX_CLUTTER_RATIO of them. Elsewhere in the image a blob is also compared with its own
   * flock (see drop_clutter in blob_filter.rs).
   */
  function dropClutter(blobs) {
    const typical = median(blobs.map((blob) => blob.area));
    if (typical <= 0) return blobs;
    const useLocal = blobs.length <= SPLIT_MAX_DETECTIONS;
    return blobs.filter((blob) => {
      const local = useLocal ? localArea(blob, blobs) : null;
      const reference = local === null ? typical : Math.max(local, typical);
      return (
        blob.area / reference <= MAX_CLUTTER_RATIO &&
        !(blob.touchesBorder && blob.area / typical > BORDER_CLUTTER_RATIO)
      );
    });
  }

  /**
   * Removes tiny pieces right next to a much larger blob of at most FRAGMENT_MAX_BIRDS local
   * birds (see absorb_fragments).
   */
  function absorbFragments(blobs) {
    if (blobs.length > SPLIT_MAX_DETECTIONS) return blobs;
    const near = (blob, large) => {
      if (blob.area >= FRAGMENT_RATIO * large.area) return false;
      const right = large.left + large.width;
      const bottom = large.top + large.height;
      const dx = Math.max(large.left - blob.x, blob.x - right, 0);
      const dy = Math.max(large.top - blob.y, blob.y - bottom, 0);
      return Math.hypot(dx, dy) <= blobRadius(large);
    };
    // Whether each blob can have wing tips, worked out only for blobs next to a fragment.
    const single = new Map();
    const isSingle = (large) => {
      if (!single.has(large)) {
        const area = singleArea(large, blobs);
        single.set(large, area === null || large.area <= FRAGMENT_MAX_BIRDS * area);
      }
      return single.get(large);
    };
    return blobs.filter((blob) => !blobs.some((large) => near(blob, large) && isSingle(large)));
  }

  /**
   * Removes tiny compact dots when the photo also has larger birds (see drop_dots).
   * `wholeSide` is the longer side of the whole photo in pixels of the blobs.
   */
  function dropDots(blobs, wholeSide) {
    const typical = median(blobs.map((blob) => blob.area));
    const size = wholeSide / MAX_WORKING_SIDE;
    const maxArea = Math.min(DOT_MAX_AREA * size * size, DOT_MEDIAN_RATIO * typical);
    const maxSide = DOT_MAX_SIDE * size;
    return blobs.filter(
      (blob) => blob.area >= maxArea || Math.max(blob.width, blob.height) > maxSide,
    );
  }

  /** The scale of the working copy of a part of a photo (see working_scale). */
  function workingScale(cols, rows) {
    return Math.min(MAX_WORKING_SIDE / Math.max(cols, rows), 1);
  }

  function scaledSide(side, scale) {
    return Math.max(Math.round(side * scale), 1);
  }

  /**
   * Estimates how many birds each blob holds by comparing its area with the median area of
   * nearby detections from the same flock (localArea).
   */
  function splitMerged(blobs) {
    if (blobs.length > SPLIT_MAX_DETECTIONS) return blobs;
    const counts = blobs.map((blob) => {
      const reference = singleArea(blob, blobs);
      if (reference === null || reference <= 0) return 1;
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

    /**
     * Removes from `binary` every component that overlaps `forbidden` and stays within `far`. Of
     * one that reaches farther, only the pixels within `near` are removed (see drop_touching in
     * blob_filter.rs).
     */
    function dropTouching(binary, forbidden, near, far, scope) {
      const local = new Scope();
      try {
        const labels = mat(local);
        const labelCount = cv.connectedComponents(binary, labels, 8, cv.CV_32S);
        const out = zeros(scope, binary.rows, binary.cols);
        const labelData = labels.data32S;
        const forbiddenData = forbidden.data;
        const nearData = near.data;
        const farData = far.data;
        const outData = out.data;
        const touching = new Uint8Array(labelCount);
        const escapes = new Uint8Array(labelCount);
        for (let i = 0; i < labelData.length; i++) {
          if (forbiddenData[i] > 0) touching[labelData[i]] = 1;
          if (farData[i] === 0) escapes[labelData[i]] = 1;
        }
        for (let i = 0; i < labelData.length; i++) {
          const label = labelData[i];
          if (label > 0 && !(touching[label] && (nearData[i] > 0 || !escapes[label]))) {
            outData[i] = 255;
          }
        }
        return out;
      } finally {
        local.release();
      }
    }

    /** `mask` grown by `reach` pixels in every direction, with a square (see grow). */
    function grow(mask, reach, scope) {
      const local = new Scope();
      try {
        const out = mat(scope);
        cv.dilate(
          mask,
          out,
          kernel(local, cv.MORPH_RECT, 2 * reach + 1),
          anchor(),
          1,
          cv.BORDER_CONSTANT,
          cv.morphologyDefaultBorderValue(),
        );
        return out;
      } finally {
        local.release();
      }
    }

    /** Mask (255) of the connected components of `binary` that share a pixel with `seeds`. */
    function componentsTouching(binary, seeds, scope) {
      const local = new Scope();
      try {
        const labels = mat(local);
        const labelCount = cv.connectedComponents(binary, labels, 8, cv.CV_32S);
        const out = zeros(scope, binary.rows, binary.cols);
        const labelData = labels.data32S;
        const seedData = seeds.data;
        const outData = out.data;
        const selected = new Uint8Array(labelCount);
        for (let i = 0; i < labelData.length; i++) {
          if (seedData[i] > 0 && labelData[i] > 0) selected[labelData[i]] = 1;
        }
        for (let i = 0; i < labelData.length; i++) {
          if (selected[labelData[i]]) outData[i] = 255;
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
     * Components touching the landscape are dropped near it (see Masks::apply), the painted
     * mask only cuts detections.
     */
    function applyMasks(binary, masks, scope) {
      let out = binary;
      if (masks.landscape) out = dropTouching(out, masks.landscape, masks.reach.near, masks.reach.far, scope);
      if (masks.exclusion) out = applyExclusionMask(out, masks.exclusion, scope);
      return out;
    }

    /** A copy of `src` scaled by `scale`; `src` itself when that changes nothing. */
    function shrink(src, scale, interpolation, scope) {
      if (scale >= 1) return src;
      const out = mat(scope);
      cv.resize(
        src,
        out,
        new cv.Size(scaledSide(src.cols, scale), scaledSide(src.rows, scale)),
        0,
        0,
        interpolation,
      );
      return out;
    }

    /** `landscape` with everything below the ground marked too (see fill_below_land). */
    function fillBelowLand(landscape, scope) {
      const local = new Scope();
      try {
        const rows = landscape.rows;
        const ground = componentsWhere(
          landscape,
          8,
          (left, top, width, height) => top > 0 && 2 * (top + height) >= rows,
          local,
        );
        const out = scope.add(landscape.clone());
        const cols = landscape.cols;
        const groundData = ground.data;
        const outData = out.data;
        const below = new Uint8Array(cols);
        for (let i = 0; i < outData.length; i++) {
          const col = i % cols;
          if (groundData[i] > 0) below[col] = 1;
          if (below[col]) outData[i] = 255;
        }
        return out;
      } finally {
        local.release();
      }
    }

    /** Removes what `links` connects to the landscape across small gaps (see drop_linked). */
    function dropLinked(binary, links, landscape, reach, window, scope) {
      const local = new Scope();
      try {
        const grown = grow(links, Math.round(window * LANDSCAPE_GAP_RATIO), local);
        const free = dropTouching(grown, landscape, reach.near, reach.linked, local);
        const out = mat(scope);
        cv.bitwise_and(binary, free, out);
        return out;
      } finally {
        local.release();
      }
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
     * Candidate sky (255): the smooth components reaching the top edge, and the largest smooth
     * component when the top edge seems blocked (see sky_candidates in blob_filter.rs).
     */
    function skyCandidates(smooth, brightness, brightBirds, scope) {
      const local = new Scope();
      try {
        const labels = mat(local);
        const stats = mat(local);
        const centroids = mat(local);
        const labelCount = cv.connectedComponentsWithStats(smooth, labels, stats, centroids, 4, cv.CV_32S);
        const statData = stats.data32S;
        const width = stats.cols;
        const selected = new Uint8Array(labelCount);
        const areas = new Float64Array(labelCount);
        for (let label = 1; label < labelCount; label++) {
          selected[label] = statData[label * width + cv.CC_STAT_TOP] === 0 ? 1 : 0;
          areas[label] = statData[label * width + cv.CC_STAT_AREA];
        }
        const labelData = labels.data32S;
        const brightnessData = brightness.data32F;
        const totals = new Float64Array(labelCount);
        for (let i = 0; i < labelData.length; i++) totals[labelData[i]] += brightnessData[i];

        let topArea = 0;
        let topTotal = 0;
        let largest = 0;
        for (let label = 1; label < labelCount; label++) {
          if (selected[label]) {
            topArea += areas[label];
            topTotal += totals[label];
          }
          if (largest === 0 || areas[label] >= areas[largest]) largest = label;
        }
        if (largest > 0) {
          const area = areas[largest];
          const total = smooth.rows * smooth.cols;
          const muchBrighter =
            topArea < SKY_MIN_FRACTION * total ||
            (!brightBirds && totals[largest] / area > (SKY_BLOCKER_BRIGHTNESS * topTotal) / topArea);
          if (
            area >= SKY_MIN_FRACTION * total &&
            topArea < SKY_TOP_TRUSTED_FRACTION * total &&
            area > topArea &&
            muchBrighter
          ) {
            selected[largest] = 1;
          }
        }

        const out = zeros(scope, smooth.rows, smooth.cols);
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

        const topSmooth = skyCandidates(smooth, closed, brightBirds, local);
        // Landscape: the rest of the image connected to its edges, together with rough
        // islands near it. Islands farther away are dense flocks or sharp cloud edges, also
        // near the edge of the photo.
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
        const edgeLand = componentsWhere(
          notSky,
          8,
          (left, top, width, height) =>
            left === 0 || top === 0 || left + width >= cols || top + height >= rows,
          local,
        );
        const landscapeZone = componentsTouching(grown, edgeLand, local);
        const landscape = mat(local);
        cv.bitwise_and(notSky, landscapeZone, landscape);

        const landscapePixels = cv.countNonZero(landscape);
        const total = cols * rows;
        if (total - landscapePixels < SKY_MIN_FRACTION * total) return null;
        const filled = fillBelowLand(landscape, local);
        const windows = (count) => Math.round((window * count) / scale);
        const near = grow(filled, windows(LANDSCAPE_CUT_WINDOWS), local);
        const far = grow(filled, windows(LANDSCAPE_REACH_WINDOWS), local);
        const linked = grow(filled, windows(LANDSCAPE_LINK_REACH_WINDOWS), local);

        const upscale = (small) => {
          const upscaled = mat(local);
          cv.resize(small, upscaled, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR);
          const full = mat(scope);
          cv.threshold(upscaled, full, 127, 255, cv.THRESH_BINARY);
          return full;
        };
        return {
          mask: upscale(filled),
          reach: { near: upscale(near), far: upscale(far), linked: upscale(linked) },
        };
      } finally {
        local.release();
      }
    }

    /** Median of `src` in a square window; see local_median in blob_filter.rs. */
    function localMedian(src, window, scope) {
      const out = mat(scope);
      if (window <= MAX_MEDIAN_WINDOW) {
        cv.medianBlur(src, out, window);
        return out;
      }
      const local = new Scope();
      try {
        const factor = Math.floor((window + MAX_MEDIAN_WINDOW - 1) / MAX_MEDIAN_WINDOW);
        const size = new cv.Size(
          Math.max(Math.floor((src.cols + factor - 1) / factor), 1),
          Math.max(Math.floor((src.rows + factor - 1) / factor), 1),
        );
        const small = mat(local);
        cv.resize(src, small, size, 0, 0, cv.INTER_NEAREST);
        const filtered = mat(local);
        cv.medianBlur(small, filtered, oddKernel(Math.floor(window / factor), 3));
        cv.resize(filtered, out, new cv.Size(src.cols, src.rows), 0, 0, cv.INTER_LINEAR);
        return out;
      } finally {
        local.release();
      }
    }

    /**
     * Estimates the sky without birds and keeps blobs that are clearly darker than it
     * (Weber contrast against a threshold that rises with the local cloud texture).
     */
    function detectBackground(gray, masks, params, window) {
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
            // The contrast is relative to the real sky, also when the image is flipped.
            const reference = params.invert ? 255 - sky : sky;
            const signed = f(f(sky - subjectData[i]) / Math.max(reference, 1));
            contrast[i] = clamp(signed, 0, 1);
            deviationData[i] = Math.round(f(f(Math.min(Math.abs(signed), deviationCap) / deviationCap) * 255));
          }
        }
        s.free(subjectF);
        s.free(smoothBackground);

        const texture = localMedian(deviation, oddKernel(3 * window, 3), s);
        s.free(deviation);

        // Significance: contrast divided by the local threshold (> 1 means a detection).
        const sensitivity = f(Math.max(params.sensitivity, 0));
        const textureScale = f(MAX_TEXTURE / 255);
        const minContrast = f(MIN_CONTRAST);
        const significance = new Float32Array(rows * cols);
        let candidates = zeros(s, rows, cols);
        const links = zeros(s, rows, cols);
        {
          const textureData = texture.data;
          const candidateData = candidates.data;
          const linkData = links.data;
          const scale = f(sensitivity * textureScale);
          const linkScale = f(LANDSCAPE_LINK_SENSITIVITY * textureScale);
          for (let i = 0; i < significance.length; i++) {
            const threshold = Math.max(f(scale * textureData[i]), minContrast);
            const q = f(contrast[i] / threshold);
            significance[i] = q;
            if (q > LOW_THRESHOLD_RATIO) candidateData[i] = 255;
            const linkThreshold = Math.max(f(linkScale * textureData[i]), minContrast);
            if (contrast[i] > f(linkThreshold * LOW_THRESHOLD_RATIO)) linkData[i] = 255;
          }
        }
        s.free(texture);
        candidates = applyMasks(candidates, masks, s);
        if (masks.landscape) {
          candidates = dropLinked(candidates, links, masks.landscape, masks.reach, window, s);
        }

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
        // The background (label 0) is skipped, as it is never kept (see blob_filter.rs).
        const peaks = new Float32Array(labelCount);
        {
          const labelData = labels.data32S;
          for (let i = 0; i < labelData.length; i++) {
            const label = labelData[i];
            if (label !== 0 && significance[i] > peaks[label]) peaks[label] = significance[i];
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
          const width = statData[row + cv.CC_STAT_WIDTH];
          const height = statData[row + cv.CC_STAT_HEIGHT];
          const touchesBorder =
            left === 0 || top === 0 || left + width >= cols || top + height >= rows;
          blobs.push({
            x: centroidData[label * 2],
            y: centroidData[label * 2 + 1],
            area: statData[row + cv.CC_STAT_AREA],
            count: 1,
            touchesBorder,
            left,
            top,
            width,
            height,
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
    function detectThreshold(gray, masks, params, window) {
      const s = new Scope();
      try {
        const blurK = oddKernel(params.blur, 1);
        const blurred = mat(s);
        cv.GaussianBlur(gray, blurred, new cv.Size(blurK, blurK), 0, 0, cv.BORDER_DEFAULT);

        let binary = thresholdImage(
          blurred,
          params.threshold_method,
          window,
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
              left: bounds.x,
              top: bounds.y,
              width: bounds.width,
              height: bounds.height,
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
        const region = cropMat(full, rect, scope);
        // All the detection steps work on this copy; blobs go back to pixels of `region` below.
        const scale = workingScale(region.cols, region.rows);
        const gray = shrink(region, scale, cv.INTER_AREA, scope);
        let exclusion = null;
        if (mask) {
          const cropped = cropMat(decodeMask(mask, full.cols, full.rows, scope), rect, scope);
          exclusion = cropped;
          if (scale < 1) {
            exclusion = mat(scope);
            cv.threshold(shrink(cropped, scale, cv.INTER_LINEAR, scope), exclusion, 0, 255, cv.THRESH_BINARY);
          }
        }
        // From the whole photo: cropping does not change how big a bird is in pixels.
        const wholeCols = scaledSide(full.cols, scale);
        const wholeRows = scaledSide(full.rows, scale);
        const window = scaledWindow(params.adaptive_block, wholeCols, wholeRows);
        const landscape = params.sky_only ? landscapeMask(gray, window, params.invert, scope) : null;
        const masks = { exclusion, landscape: landscape?.mask, reach: landscape?.reach };

        let blobs =
          params.threshold_method.trim().toLowerCase() === "background"
            ? detectBackground(gray, masks, params, window)
            : detectThreshold(gray, masks, params, window);

        blobs = absorbFragments(blobs);
        blobs = dropDots(blobs, Math.max(wholeCols, wholeRows));
        blobs = blobs.map((blob) => ({
          ...blob,
          x: blob.x / scale,
          y: blob.y / scale,
          area: blob.area / (scale * scale),
        }));

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

    // The rest is exported for the tests.
    return { detect, dropTouching, grow, landscapeMask };
  }

  return {
    create,
    DEFAULT_PARAMS,
    dropClutter,
    splitMerged,
    absorbFragments,
    dropDots,
    scaledWindow,
    Scope,
  };
});
