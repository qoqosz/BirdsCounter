// Tests of the web detector (src/detector.js) on synthetic cloudy-sky scenes, ported from
// the tests in src-tauri/src/blob_filter.rs. Run `./build_web.sh` once (it downloads
// OpenCV.js), then `node --test tests/web/`.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const BirdDetector = require("../../src/detector.js");

const OPENCV_JS = path.join(__dirname, "../../target/opencv-js/opencv-5.0.0.js");
const WIDTH = 800;
const HEIGHT = 500;

let cv;
let detector;

test.before(async () => {
  cv = await require(OPENCV_JS);
  detector = BirdDetector.create(cv);
});

/** Overcast sky: a few soft clouds on a flat background. */
function sky(base) {
  const img = new cv.Mat(HEIGHT, WIDTH, cv.CV_8U, new cv.Scalar(base));
  for (const [x, y, r, delta] of [
    [150, 120, 110, -25],
    [600, 350, 140, -20],
    [420, 60, 90, 15],
  ]) {
    cv.circle(img, new cv.Point(x, y), r, new cv.Scalar(base + delta), -1, cv.LINE_8, 0);
  }
  const clouds = new cv.Mat();
  cv.GaussianBlur(img, clouds, new cv.Size(0, 0), 40, 40, cv.BORDER_REPLICATE);
  img.delete();
  return clouds;
}

function skyAt(img, x, y) {
  return img.ucharPtr(y, x)[0];
}

/** Draws a bird `contrast` levels darker (negative: brighter) than the sky under it. */
function drawBird(img, x, y, contrast) {
  const center = new cv.Point(Math.round(x), Math.round(y));
  const color = new cv.Scalar(skyAt(img, center.x, center.y) - contrast);
  cv.ellipse(img, center, new cv.Size(5, 2), 10, 0, 360, color, -1, cv.LINE_AA, 0);
}

/** Grid of `rows` x 10 birds; every cell listed in `pairs` holds two touching birds. */
function drawFlock(img, rows, contrast, pairs = []) {
  let birds = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < 10; col++) {
      const x = 40 + col * 55;
      const y = 40 + row * 45;
      drawBird(img, x, y, contrast);
      birds++;
      if (pairs.includes(row * 10 + col)) {
        drawBird(img, x + 9, y + 1, contrast);
        birds++;
      }
    }
  }
  return birds;
}

/** Adds sensor noise, like `encode` in the Rust tests. */
function noisy(img) {
  cv.setRNGSeed(7);
  const noise = new cv.Mat(img.rows, img.cols, cv.CV_16S, new cv.Scalar(0));
  cv.randn(noise, new cv.Mat(1, 1, cv.CV_64F, new cv.Scalar(0)), new cv.Mat(1, 1, cv.CV_64F, new cv.Scalar(2.5)));
  const wide = new cv.Mat();
  img.convertTo(wide, cv.CV_16S, 1, 0);
  const sum = new cv.Mat();
  cv.add(wide, noise, sum);
  const out = new cv.Mat();
  sum.convertTo(out, cv.CV_8U, 1, 0);
  for (const m of [noise, wide, sum]) m.delete();
  return out;
}

function detect(img, params = {}, mask = null, crop = null) {
  const gray = noisy(img);
  try {
    return detector.detect(gray, mask, params, crop);
  } finally {
    gray.delete();
  }
}

function count(img, params = {}, mask = null) {
  return detect(img, params, mask).count;
}

/** Mask excluding the top 240 rows. */
function topMask() {
  const mask = cv.Mat.zeros(HEIGHT, WIDTH, cv.CV_8U);
  cv.rectangle(mask, new cv.Point(0, 0), new cv.Point(WIDTH - 1, 239), new cv.Scalar(255), -1, cv.LINE_8, 0);
  return mask;
}

test("counts separate birds on cloudy sky", () => {
  const img = sky(200);
  const expected = drawFlock(img, 8, 90);
  assert.equal(count(img), expected);
  img.delete();
});

test("counts faint birds", () => {
  const img = sky(200);
  const expected = drawFlock(img, 8, 30);
  assert.equal(count(img), expected);
  img.delete();
});

test("counts dense flock of thin birds", () => {
  const img = sky(200);
  let expected = 0;
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 12; col++) {
      const x = 60 + col * 20 + (row % 2) * 10;
      const y = 60 + row * 14;
      const base = skyAt(img, x, y);
      const wings = new cv.MatVector();
      const points = cv.matFromArray(3, 1, cv.CV_32SC2, [x - 6, y - 3, x, y + 2, x + 6, y - 3]);
      wings.push_back(points);
      for (const [thickness, color] of [
        [3, base + 8],
        [1, base - 70],
      ]) {
        cv.polylines(img, wings, false, new cv.Scalar(color), thickness, cv.LINE_8, 0);
      }
      points.delete();
      wings.delete();
      expected++;
    }
  }
  assert.equal(count(img), expected);
  img.delete();
});

test("splits touching birds", () => {
  const img = sky(200);
  const pairs = [3, 14, 22, 37, 41, 58, 66, 75];
  const expected = drawFlock(img, 8, 90, pairs);
  assert.equal(count(img), expected);
  assert.equal(count(img, { split_clusters: false }), expected - pairs.length);
  img.delete();
});

test("ignores large dark clutter", () => {
  const img = sky(200);
  const expected = drawFlock(img, 8, 90);
  cv.rectangle(img, new cv.Point(620, 280), new cv.Point(769, 429), new cv.Scalar(60), -1, cv.LINE_8, 0);
  assert.equal(count(img), expected);
  img.delete();
});

test("respects exclusion mask", () => {
  const img = sky(200);
  drawFlock(img, 8, 90);
  const mask = topMask();
  assert.equal(count(img, {}, mask), 30);
  // The app paints the mask at a lower resolution; it is scaled to the photo.
  const small = new cv.Mat();
  cv.resize(mask, small, new cv.Size(WIDTH / 4, HEIGHT / 4), 0, 0, cv.INTER_AREA);
  assert.equal(count(img, {}, small), 30);
  for (const m of [img, mask, small]) m.delete();
});

test("counts birds in crop", () => {
  const img = sky(200);
  drawFlock(img, 8, 90);
  // Columns 0..=4 (x <= 260) of rows 2..=7 (y >= 130).
  const crop = { x: 0, y: 110, width: 290, height: HEIGHT - 110 };
  const found = detect(img, {}, null, crop);
  assert.equal(found.count, 30);
  // Detections are reported in pixels of the whole image, inside the crop.
  assert.ok(
    found.birds.every(
      (bird) =>
        bird.x >= crop.x &&
        bird.x < crop.x + crop.width &&
        bird.y >= crop.y &&
        bird.y < crop.y + crop.height,
    ),
  );
  assert.ok(found.birds.some((bird) => bird.y >= 200));

  // Excluding rows 2..=4 (y <= 220) leaves rows 5..=7.
  const mask = topMask();
  assert.equal(detect(img, {}, mask, crop).count, 15);
  img.delete();
  mask.delete();
});

/** Grass-like texture below `horizon` and a tree with ragged edges at the right border. */
function drawLandscape(img, horizon) {
  cv.setRNGSeed(11);
  const grass = new cv.Mat(HEIGHT - horizon, WIDTH, cv.CV_8U);
  cv.randu(grass, new cv.Mat(1, 1, cv.CV_64F, new cv.Scalar(30)), new cv.Mat(1, 1, cv.CV_64F, new cv.Scalar(150)));
  const roi = img.roi(new cv.Rect(0, horizon, WIDTH, HEIGHT - horizon));
  grass.copyTo(roi);
  roi.delete();
  grass.delete();
  const crown = new cv.Scalar(50);
  for (let i = 0; i < 40; i++) {
    const cx = WIDTH - 60 - (i % 5) * 9;
    const cy = horizon - 10 - i * 4;
    cv.circle(img, new cv.Point(cx, cy), 14, crown, -1, cv.LINE_8, 0);
    // Leaves sticking out of the crown.
    cv.circle(img, new cv.Point(cx - 22, cy - 3), 3, crown, -1, cv.LINE_8, 0);
  }
}

test("ignores landscape below the sky", () => {
  const img = sky(200);
  const expected = drawFlock(img, 5, 90);
  drawLandscape(img, 320);
  assert.equal(count(img), expected);
  assert.ok(count(img, { sky_only: false }) > expected);
  img.delete();
});

test("counts bright birds when inverted", () => {
  const img = sky(70);
  const expected = drawFlock(img, 8, -90);
  assert.equal(count(img, { invert: true }), expected);
  img.delete();
});

test("adaptive method still works", () => {
  const img = sky(200);
  const expected = drawFlock(img, 8, 90);
  assert.equal(count(img, { threshold_method: "adaptive", min_radius: 2 }), expected);
  img.delete();
});

test("otsu method runs", () => {
  const img = sky(200);
  drawFlock(img, 8, 90);
  assert.ok(count(img, { threshold_method: "otsu" }) >= 0);
  img.delete();
});

function blob(x, area, touchesBorder = false) {
  return { x, y: 0, area, count: 1, touchesBorder };
}

test("split merged uses local bird size", () => {
  const blobs = [];
  for (let i = 0; i < 12; i++) blobs.push(blob(i * 10, 10));
  for (let i = 0; i < 12; i++) blobs.push(blob(1000 + i * 30, 60));
  blobs.push(blob(55, 31)); // three small birds merged
  blobs.push(blob(1150, 125)); // two large birds merged
  blobs.push(blob(3000, 60)); // lone large bird far from small ones: not split
  const counts = BirdDetector.splitMerged(blobs).map((b) => b.count);
  assert.equal(counts.length, 27);
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    24 + 3 + 2 + 1,
  );
});

test("split ignores distant small specks", () => {
  const blobs = [blob(0, 80), blob(40, 90)];
  for (let i = 0; i < 6; i++) blobs.push(blob(500 + i * 8, 4));
  assert.ok(BirdDetector.splitMerged(blobs).every((b) => b.count === 1));
});

test("drop clutter removes oversized and edge blobs", () => {
  const blobs = [];
  for (let i = 0; i < 10; i++) blobs.push(blob(i * 20, 20));
  blobs.push(blob(500, 10000)); // huge dark area
  blobs.push(blob(900, 100, true)); // roof or tree at the image edge
  blobs.push(blob(950, 22, true)); // a bird cut by the edge stays
  assert.equal(BirdDetector.dropClutter(blobs).length, 11);
});
