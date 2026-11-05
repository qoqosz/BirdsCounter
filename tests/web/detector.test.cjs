// Tests of the web detector (src/detector.js) on synthetic cloudy-sky scenes, ported from
// the tests in src-tauri/src/blob_filter.rs. Run `./build_web.sh` once (it downloads
// OpenCV.js), then `node --test tests/web/*.test.cjs`.
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

const TOP_BAND = 60;

/** 80 birds below TOP_BAND rows. */
function drawFlockBelowBand(img) {
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 10; col++) drawBird(img, 40 + col * 55, 120 + row * 45, 90);
  }
  return 80;
}

/** Texture with patches larger than a pixel of the copy the sky mask uses. */
function roughTexture(rows, cols) {
  cv.setRNGSeed(13);
  const noise = new cv.Mat(rows, cols, cv.CV_32F, new cv.Scalar(0));
  cv.randn(noise, new cv.Mat(1, 1, cv.CV_64F, new cv.Scalar(0)), new cv.Mat(1, 1, cv.CV_64F, new cv.Scalar(1)));
  const blurred = new cv.Mat();
  cv.GaussianBlur(noise, blurred, new cv.Size(0, 0), 3, 3, cv.BORDER_REPLICATE);
  // Blurring leaves a standard deviation of about 1 / (2 * sqrt(pi) * 3) = 0.094.
  const out = new cv.Mat();
  blurred.convertTo(out, cv.CV_8U, 45 / 0.094, 90);
  noise.delete();
  blurred.delete();
  return out;
}

function paste(img, patch, x, y) {
  const roi = img.roi(new cv.Rect(x, y, patch.cols, patch.rows));
  patch.copyTo(roi);
  roi.delete();
  patch.delete();
}

test("finds the sky below a smooth band at the top", () => {
  const img = sky(200);
  const expected = drawFlockBelowBand(img);
  cv.rectangle(img, new cv.Point(0, 0), new cv.Point(WIDTH - 1, TOP_BAND - 1), new cv.Scalar(70), -1, cv.LINE_8, 0);
  assert.equal(count(img), expected);
  img.delete();
});

test("finds the sky below branches at the top", () => {
  const img = sky(200);
  const expected = drawFlockBelowBand(img);
  paste(img, roughTexture(TOP_BAND, WIDTH), 0, 0);
  assert.equal(count(img), expected);
  img.delete();
});

test("keeps a bright lake out when the top is sky", () => {
  const img = sky(120);
  for (let col = 0; col < 10; col++) {
    for (let row = 0; row < 2; row++) drawBird(img, 40 + col * 55, 30 + row * 40, 50);
  }
  const shore = 130;
  paste(img, roughTexture(30, WIDTH), 0, shore);
  cv.rectangle(img, new cv.Point(0, shore + 30), new cv.Point(WIDTH - 1, HEIGHT - 1), new cv.Scalar(180), -1, cv.LINE_8, 0);
  for (let boat = 0; boat < 10; boat++) drawBird(img, 60 + boat * 70, 300, 80);
  assert.equal(count(img), 20);
  img.delete();
});

/** Twigs with small gaps between their pieces, growing from the ground at `horizon`. */
function drawBush(img, horizon) {
  for (let stem = 0; stem < 9; stem++) {
    const x = 600 + stem * 20;
    for (let y = horizon; y > horizon - 90; y -= 11) {
      cv.line(img, new cv.Point(x + (y % 3), y), new cv.Point(x + 3, y - 6), new cv.Scalar(70), 1, cv.LINE_8, 0);
    }
  }
}

test("drops twigs linked to a bush", () => {
  const img = sky(200);
  const expected = drawFlock(img, 5, 90);
  const horizon = 400;
  paste(img, roughTexture(HEIGHT - horizon, WIDTH), 0, horizon);
  drawBush(img, horizon);
  assert.equal(count(img), expected);
  img.delete();
});

test("ignores water below the land", () => {
  const img = sky(200);
  const expected = drawFlock(img, 3, 90);
  // A headland from the left edge, with water below it and to its right.
  paste(img, roughTexture(50, 560), 0, 250);
  cv.rectangle(img, new cv.Point(0, 300), new cv.Point(WIDTH - 1, HEIGHT - 1), new cv.Scalar(175), -1, cv.LINE_8, 0);
  for (let wave = 0; wave < 9; wave++) {
    cv.ellipse(img, new cv.Point(60 + wave * 50, 380), new cv.Size(10, 2), 0, 0, 360, new cv.Scalar(120), -1, cv.LINE_AA, 0);
  }
  assert.equal(count(img), expected);
  img.delete();
});

test("counts bright birds when inverted", () => {
  const img = sky(70);
  const expected = drawFlock(img, 8, -90);
  assert.equal(count(img, { invert: true }), expected);
  img.delete();
});

test("inverted contrast is relative to the real sky", () => {
  const flat = new cv.Mat(HEIGHT, WIDTH, cv.CV_8U, new cv.Scalar(170));
  cv.rectangle(flat, new cv.Point(WIDTH / 2, 0), new cv.Point(WIDTH - 1, HEIGHT - 1), new cv.Scalar(40), -1, cv.LINE_8, 0);
  const img = new cv.Mat();
  cv.GaussianBlur(flat, img, new cv.Size(0, 0), 40, 40, cv.BORDER_REPLICATE);
  flat.delete();
  let expected = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 13; col++) {
      const x = 40 + col * 55;
      const y = 40 + row * 55;
      drawBird(img, x, y, -0.4 * skyAt(img, x, y));
      expected++;
    }
  }
  // Some birds on the dark side are lost in the noise, which is large relative to it (and
  // larger than in the Rust test, where noise is added to three channels and then averaged).
  const found = count(img, { invert: true });
  assert.ok(found + 16 >= expected && found <= expected, `${found}`);
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

test("window follows the photo size", () => {
  assert.equal(BirdDetector.scaledWindow(31, 2000, 1623), 31);
  assert.equal(BirdDetector.scaledWindow(31, 1623, 2000), 31);
  assert.equal(BirdDetector.scaledWindow(31, 1000, 812), 17);
  assert.equal(BirdDetector.scaledWindow(31, 4000, 3000), 63);
  assert.equal(BirdDetector.scaledWindow(3, 100, 100), 3);
});

// Radius of a circle as big as the birds in largePhotoWithThickBirds.
const THICK_BIRD_RADIUS = 31.6;

/** A 4000 px photo with birds 40 px thick (see the Rust test). */
function largePhotoWithThickBirds() {
  const base = sky(200);
  const img = new cv.Mat();
  cv.resize(base, img, new cv.Size(WIDTH * 5, HEIGHT * 5), 0, 0, cv.INTER_LINEAR);
  base.delete();
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 5; col++) {
      const center = new cv.Point(400 + col * 700, 400 + row * 700);
      cv.ellipse(img, center, new cv.Size(50, 20), 0, 0, 360, new cv.Scalar(90), -1, cv.LINE_AA, 0);
    }
  }
  return img;
}

test("window grows with a large photo", () => {
  const img = largePhotoWithThickBirds();
  const found = detect(img);
  assert.equal(found.birds.length, 15);
  assert.ok(found.birds.every((bird) => bird.radius > 0.9 * THICK_BIRD_RADIUS));
  // Counted on a smaller copy, but the positions are in pixels of the photo.
  for (const bird of found.birds) {
    const col = Math.round((bird.x - 400) / 700);
    const row = Math.round((bird.y - 400) / 700);
    assert.ok(Math.hypot(bird.x - (400 + col * 700), bird.y - (400 + row * 700)) < 3, `${bird.x},${bird.y}`);
  }
  img.delete();
});

test("crop keeps the window of the whole photo", () => {
  const img = largePhotoWithThickBirds();
  const found = detect(img, {}, null, { x: 0, y: 0, width: 1500, height: 1500 });
  assert.equal(found.birds.length, 4);
  assert.ok(found.birds.every((bird) => bird.radius > 0.9 * THICK_BIRD_RADIUS));
  img.delete();
});

test("very large photo is counted on a smaller copy", () => {
  const img = new cv.Mat(1000, 8000, cv.CV_8U, new cv.Scalar(180));
  assert.equal(detect(img).count, 0);
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

test("drop clutter keeps a near flock", () => {
  const blobs = [];
  for (let i = 0; i < 60; i++) blobs.push(blob(i * 40, 30));
  for (let i = 0; i < 8; i++) blobs.push(blob(4000 + i * 100, 1300));
  blobs.push(blob(5500, 1300, true)); // large blobs at the edge are trees or roofs
  blobs.push({ ...blob(9000, 1300), y: 9000 }); // a lone giant
  const kept = BirdDetector.dropClutter(blobs);
  assert.equal(kept.length, 68);
  assert.ok(kept.every((b) => !b.touchesBorder && b.y === 0));
});

test("absorb fragments merges wing tips", () => {
  const bird = { x: 100, y: 100, area: 300, left: 90, top: 95, width: 20, height: 10 };
  const tip = { x: 113, y: 100, area: 6, left: 112, top: 99, width: 2, height: 2 };
  const speck = { x: 200, y: 100, area: 6, left: 199, top: 99, width: 2, height: 2 };
  const neighbour = { x: 118, y: 100, area: 200, left: 111, top: 95, width: 14, height: 10 };
  const kept = BirdDetector.absorbFragments([bird, tip, speck, neighbour]);
  assert.deepEqual(kept, [bird, speck, neighbour]);
});

test("absorb fragments keeps birds next to a clump", () => {
  // A clump of about 20 merged birds in a dense flock, and single birds around it. Two of them
  // are as close to the clump as a wing tip would be.
  const clump = { x: 100, y: 100, area: 400, left: 88, top: 88, width: 25, height: 25 };
  const birds = [120, 124, 130, 140, 150, 75].map((x) => ({
    x,
    y: 100,
    area: 20,
    left: x - 2,
    top: 98,
    width: 4,
    height: 5,
  }));
  assert.equal(BirdDetector.absorbFragments([clump, ...birds]).length, 7);
});

function filled(rows, cols, rects) {
  const mask = cv.Mat.zeros(rows, cols, cv.CV_8U);
  for (const [x, y, width, height] of rects) {
    cv.rectangle(mask, new cv.Point(x, y), new cv.Point(x + width - 1, y + height - 1), new cv.Scalar(255), -1, cv.LINE_8, 0);
  }
  return mask;
}

function pixels(mask, [x, y, width, height]) {
  const roi = mask.roi(new cv.Rect(x, y, width, height));
  const count = cv.countNonZero(roi);
  roi.delete();
  return count;
}

test("drop touching keeps what reaches far into the sky", () => {
  const scope = new BirdDetector.Scope();
  try {
    const ground = scope.add(filled(100, 100, [[0, 90, 100, 10]]));
    const reach = { near: detector.grow(ground, 15, scope), far: detector.grow(ground, 40, scope) };
    const candidates = scope.add(
      filled(100, 100, [
        [20, 10, 4, 85], // a dense flock merged into one candidate, down to the ground
        [60, 70, 4, 25], // a bush
        [80, 20, 4, 4], // a bird
      ]),
    );
    const kept = detector.dropTouching(candidates, ground, reach, scope);
    assert.equal(pixels(kept, [20, 10, 4, 65]), 4 * 65);
    assert.equal(pixels(kept, [20, 75, 4, 25]), 0);
    assert.equal(pixels(kept, [60, 70, 4, 25]), 0);
    assert.equal(pixels(kept, [80, 20, 4, 4]), 16);
  } finally {
    scope.release();
  }
});

test("rough island near the edge stays sky", () => {
  // A dense flock low over smooth water looks rough, like the landscape, and lies close to the
  // bottom edge, but no land is near it.
  const img = sky(200);
  const [left, top, width, height] = [300, HEIGHT - 90, 200, 60];
  paste(img, roughTexture(height, width), left, top);
  const scope = new BirdDetector.Scope();
  try {
    const window = BirdDetector.scaledWindow(31, WIDTH, HEIGHT);
    const landscape = detector.landscapeMask(img, window, false, scope);
    if (landscape) assert.equal(pixels(landscape.mask, [left, top, width, height]), 0);
  } finally {
    scope.release();
    img.delete();
  }
});

test("drop dots keeps birds and flocks of tiny birds", () => {
  const box = (area, width, height) => ({ x: 0, y: 0, area, left: 0, top: 0, width, height });
  const birds = Array.from({ length: 10 }, () => box(250, 30, 12));
  const dots = Array.from({ length: 5 }, () => box(9, 3, 3));
  const thinBird = box(15, 10, 2);
  assert.equal(BirdDetector.dropDots([...birds, ...dots, thinBird], 2048).length, 11);
  // In a smaller photo the same dots are relatively larger.
  assert.equal(BirdDetector.dropDots([...birds, ...dots], 1024).length, 15);
  const tinyFlock = Array.from({ length: 12 }, () => box(10, 4, 3));
  assert.equal(BirdDetector.dropDots(tinyFlock, 2048).length, 12);
});

test("drop clutter removes oversized and edge blobs", () => {
  const blobs = [];
  for (let i = 0; i < 10; i++) blobs.push(blob(i * 20, 20));
  blobs.push(blob(500, 10000)); // huge dark area
  blobs.push(blob(900, 100, true)); // roof or tree at the image edge
  blobs.push(blob(950, 22, true)); // a bird cut by the edge stays
  assert.equal(BirdDetector.dropClutter(blobs).length, 11);
});
