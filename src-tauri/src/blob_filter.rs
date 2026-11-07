use opencv::prelude::*;
use opencv::{core, geometry, imgcodecs, imgproc};

/// Birds are silhouettes: at least this much darker than the sky (as a fraction of
/// its brightness), whatever the sky texture.
const MIN_CONTRAST: f64 = 0.08;
/// Sky texture is the median absolute contrast around a pixel scaled to a standard
/// deviation (exact for Gaussian noise). Unlike an RMS it ignores the birds as long as
/// they cover less than half of the window, so dense flocks do not hide themselves.
const MAD_TO_SIGMA: f32 = 1.4826;
/// Sky texture is capped at this value, so strongly contrasting birds stay visible
/// against heavy texture.
const MAX_TEXTURE: f32 = 0.05;
/// Bright specks up to this size (sharpening halos around birds, noise peaks) are
/// removed before the sky is estimated; a closing would spread them and overestimate
/// the sky inside dense flocks.
const SKY_SPECK_SIZE: i32 = 3;
/// Hysteresis: a detection seeded above the threshold grows into neighbouring
/// pixels that exceed this fraction of it (keeps faint wing tips attached).
const LOW_THRESHOLD_RATIO: f32 = 0.6;
/// Maximum number of nearest detections used to estimate the local single-bird area.
const SPLIT_NEIGHBOURS: usize = 12;
/// A detection is a neighbour of a blob when it is at most this many of its own
/// sizes (sqrt of area) away, i.e. it belongs to the same flock.
const SPLIT_NEIGHBOUR_DISTANCE: f64 = 12.0;
/// Minimum number of neighbours (including the blob itself) for a reliable estimate.
const SPLIT_MIN_NEIGHBOURS: usize = 4;
/// Above this many detections splitting is skipped to keep the neighbour search cheap
/// (such images are dominated by texture, not flocks).
const SPLIT_MAX_DETECTIONS: usize = 4000;
/// Above this coverage (area of the neighbours over the disk they lie in) a flock is so crowded
/// that many of its detections are merged birds, so the median is no longer a single bird.
const SPLIT_CROWDED_COVERAGE: f64 = 0.2;
/// At this coverage and above, a single bird is the `SPLIT_PACKED_QUANTILE` of the neighbours'
/// areas instead of their median; in between, the quantile goes down linearly.
const SPLIT_PACKED_COVERAGE: f64 = 0.3;
const SPLIT_PACKED_QUANTILE: f64 = 0.2;
/// Blobs touching the image edge that are larger than this many median blobs are
/// clutter (trees, roofs, lamps) rather than birds.
const BORDER_CLUTTER_RATIO: f64 = 3.0;
/// Blobs larger than this many median blobs are clutter wherever they are.
const MAX_CLUTTER_RATIO: f64 = 25.0;
/// The sky mask is computed on a copy scaled so that the local window spans this
/// many pixels: birds vanish after a closing of that size, landscape does not.
const SKY_MASK_WINDOW: i32 = 5;
/// Relative gradient of the bird-free image (Sobel, averaged over ~2 windows) above
/// which a region counts as landscape. Skies stay below ~0.15 even with clouds,
/// trees, grass and fences reach 0.5 and more.
const SKY_MAX_TEXTURE: f32 = 0.3;
/// Rough islands within this many mask pixels of the landscape belong to it.
const SKY_REACH: i32 = 15;
/// When the detected sky covers less than this fraction of the image, the photo is
/// not a sky shot (e.g. birds on water) and the sky mask is not applied.
const SKY_MIN_FRACTION: f64 = 0.05;
/// Smooth areas touching the top edge covering at least this fraction of the image are
/// taken to be the sky. Less than that can be something blocking the view of it.
const SKY_TOP_TRUSTED_FRACTION: f64 = 0.25;
/// The largest smooth area counts as sky too when the top edge is blocked and it is at
/// least this many times brighter than what blocks it (a dark roof, not a brighter lake).
const SKY_BLOCKER_BRIGHTNESS: f64 = 1.6;
/// The local window setting is in pixels of a photo with this longer side, and it grows
/// with the photo, so the same scene gives the same count at any resolution.
const WINDOW_REFERENCE_SIDE: f64 = 2000.0;
/// Longer side of the copy the detector works on, in pixels. Larger photos and crops are
/// shrunk to it, which keeps counting fast. Birds in photos of this size are found reliably.
const MAX_WORKING_SIDE: i32 = 2048;
/// Candidates linked to the landscape across gaps of up to this fraction of the local window
/// are vegetation: the sky mask erases thin leaves and twigs, so it can't see them itself.
const LANDSCAPE_GAP_RATIO: f64 = 0.25;
/// The links to the landscape use this sensitivity, not the slider's: at a low setting, cloud
/// texture would connect the whole sky to the ground.
const LANDSCAPE_LINK_SENSITIVITY: f32 = 9.0;
/// A candidate touching the landscape is dropped whole when it lies within this many local windows
/// of it, like a tree top. The mask already covers the tree, so what sticks out of it is short.
const LANDSCAPE_REACH_WINDOWS: f64 = 4.0;
/// A candidate linked to the landscape is dropped whole when it lies within this many local
/// windows of it. The mask erases a bush's twigs, so the bush itself reaches this far.
const LANDSCAPE_LINK_REACH_WINDOWS: f64 = 8.0;
/// A candidate reaching farther is a dense flock merged into one candidate, and it loses only its
/// pixels within this many local windows of the landscape.
const LANDSCAPE_CUT_WINDOWS: f64 = 1.0;
/// A blob smaller than this fraction of a much larger one right next to it is a piece of it,
/// such as a wing tip. Right next to it means within the larger blob's radius of its bounds.
const FRAGMENT_RATIO: f64 = 0.12;
/// Only a blob of at most this many local birds (`single_area`) has wing tips: in a dense flock, a
/// clump of merged birds is much larger than the single birds next to it.
const FRAGMENT_MAX_BIRDS: f64 = 3.0;
/// Compact dots smaller than this, for a photo with a longer side of `MAX_WORKING_SIDE`, are
/// not counted when the photo also has larger birds (see `drop_dots`).
const DOT_MAX_AREA: f64 = 20.0;
/// Longest bounding box side of such a dot, for the same photo size. Thin faint birds are as
/// small but longer.
const DOT_MAX_SIDE: f64 = 7.0;
/// Such a dot is also smaller than this fraction of the median detection, so a flock of tiny
/// birds is kept.
const DOT_MEDIAN_RATIO: f64 = 0.5;
/// OpenCV's fast median filter counts in 16 bits, so its window can't be wider than this.
const MAX_MEDIAN_WINDOW: i32 = 255;

#[derive(Clone, serde::Deserialize)]
#[serde(default)]
pub struct BlobParams {
    pub min_radius: f64,
    pub max_radius: f64,
    pub blur: i32,
    pub threshold_method: String,
    pub adaptive_block: i32,
    pub adaptive_c: f64,
    pub morph_kernel: i32,
    pub morph_open_iter: i32,
    pub morph_close_iter: i32,
    pub auto_invert: bool,
    pub invert: bool,
    /// Detection threshold for the `background` method, as a multiple of the local
    /// sky texture (contrast of clouds around each pixel).
    pub sensitivity: f64,
    /// Count blobs larger than a typical bird as several birds.
    pub split_clusters: bool,
    /// Detect birds only in the sky: smooth area connected to the top of the image,
    /// which excludes trees, buildings and the landscape below the horizon.
    pub sky_only: bool,
}

impl Default for BlobParams {
    fn default() -> Self {
        Self {
            min_radius: 1.0,
            max_radius: 100.0,
            blur: 3,
            threshold_method: "background".to_string(),
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
        }
    }
}

/// Part of the image to count birds in, in pixels of the decoded (EXIF-rotated) image.
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub struct Crop {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Crop {
    /// The crop clamped to an image of `cols` x `rows`; `None` when nothing is left.
    fn rect_within(&self, cols: i32, rows: i32) -> Option<core::Rect> {
        let x = self.x.clamp(0, cols);
        let y = self.y.clamp(0, rows);
        let right = self.x.saturating_add(self.width).clamp(x, cols);
        let bottom = self.y.saturating_add(self.height).clamp(y, rows);
        (right > x && bottom > y).then(|| core::Rect::new(x, y, right - x, bottom - y))
    }
}

/// The crop clamped to an image of `cols` x `rows`; an error when nothing is left.
fn crop_rect(crop: Option<Crop>, cols: i32, rows: i32) -> Result<Option<core::Rect>, String> {
    match crop {
        Some(crop) => Ok(Some(
            crop.rect_within(cols, rows)
                .ok_or("Crop is outside the image")?,
        )),
        None => Ok(None),
    }
}

/// A copy of `mat` cut to `rect`; `None` when `rect` covers all of it.
fn crop_mat(mat: &core::Mat, rect: Option<core::Rect>) -> Result<Option<core::Mat>, String> {
    match rect {
        Some(rect) if rect.width < mat.cols() || rect.height < mat.rows() => {
            core::Mat::roi(mat, rect)
                .and_then(|roi| roi.try_clone())
                .map(Some)
                .map_err(|e| format!("Crop error: {}", e))
        }
        _ => Ok(None),
    }
}

/// The most pixels a photo may have. The decoded BGR copy takes 3 bytes per pixel and the
/// grayscale one another, so a larger photo (a stitched panorama) would need over a gigabyte
/// and get the app killed on a phone. The largest phone sensors (200 MP, 16320x12240) fit.
const MAX_PHOTO_PIXELS: i64 = 250_000_000;

/// The error `check_photo_size` returns; `main.js` shows a translated message for it.
pub const PHOTO_TOO_LARGE: &str = "photo-too-large";

fn check_photo_size(width: i32, height: i32) -> Result<(), String> {
    if i64::from(width) * i64::from(height) > MAX_PHOTO_PIXELS {
        return Err(PHOTO_TOO_LARGE.to_string());
    }
    Ok(())
}

/// Decodes a photo (EXIF-rotated) as BGR.
fn decode_color(payload: &[u8]) -> Result<core::Mat, String> {
    let vec = core::Vector::<u8>::from_slice(payload);
    let image = imgcodecs::imdecode(&vec, imgcodecs::IMREAD_COLOR)
        .map_err(|e| format!("Failed to read image: {}", e))?;
    if image.empty() {
        return Err("Failed to decode image".to_string());
    }
    check_photo_size(image.cols(), image.rows())?;
    Ok(image)
}

fn to_gray(image: &core::Mat) -> Result<core::Mat, String> {
    let mut gray = core::Mat::default();
    imgproc::cvt_color(
        image,
        &mut gray,
        imgproc::COLOR_BGR2GRAY,
        0,
        core::AlgorithmHint::ALGO_HINT_DEFAULT,
    )
    .map_err(|e| format!("Color conversion error: {}", e))?;
    Ok(gray)
}

/// Decodes a photo to the grayscale image `BlobFilter::detect` takes, so it can be
/// decoded once and counted with many settings.
pub fn decode_gray(payload: &[u8]) -> Result<core::Mat, String> {
    to_gray(&decode_color(payload)?)
}

/// A detected blob; `count` is the estimated number of birds it contains.
#[derive(Clone, Debug)]
struct Blob {
    center: core::Point2d,
    area: f64,
    count: u32,
    touches_border: bool,
    bounds: core::Rect,
}

impl Blob {
    fn radius(&self) -> f64 {
        (self.area / std::f64::consts::PI).sqrt()
    }
}

/// A detected bird, or several merged ones (`count`), in pixels of the whole image.
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct Bird {
    pub x: f64,
    pub y: f64,
    pub radius: f64,
    pub count: u32,
}

/// Regions where birds are not looked for.
struct Masks<'a> {
    /// Painted by the user (255 = excluded); detections are cut along it.
    exclusion: Option<&'a core::Mat>,
    /// Everything but the sky (255). Detections touching it are trees, roofs or the
    /// horizon reaching into the sky, so they are dropped (see `drop_touching`).
    landscape: Option<&'a core::Mat>,
    /// The zones around `landscape`.
    reach: Option<&'a Reach>,
}

/// Zones around the landscape (255), see `drop_touching`.
struct Reach {
    /// Within `LANDSCAPE_CUT_WINDOWS` of it.
    near: core::Mat,
    /// Within `LANDSCAPE_REACH_WINDOWS` of it.
    far: core::Mat,
    /// Within `LANDSCAPE_LINK_REACH_WINDOWS` of it.
    linked: core::Mat,
}

impl Masks<'_> {
    fn apply(&self, binary: core::Mat) -> Result<core::Mat, String> {
        let mut out = binary;
        if let (Some(landscape), Some(reach)) = (self.landscape, self.reach) {
            out = drop_touching(&out, landscape, &reach.near, &reach.far)?;
        }
        if let Some(exclusion) = self.exclusion {
            out = apply_exclusion_mask(&out, exclusion)?;
        }
        Ok(out)
    }
}

/// Detects birds as small blobs that differ from the local sky background.
pub struct BlobFilter {
    params: BlobParams,
}

impl BlobFilter {
    pub fn new(params: BlobParams) -> Self {
        Self { params }
    }

    /// Finds the birds in `gray` (from `decode_gray`), or in its `crop` region. The
    /// exclusion mask covers the whole image, not just the crop. Positions are in pixels
    /// of the whole image.
    pub fn detect(
        &self,
        gray: &core::Mat,
        mask_payload: Option<&[u8]>,
        crop: Option<Crop>,
    ) -> Result<Vec<Bird>, String> {
        let crop_rect = crop_rect(crop, gray.cols(), gray.rows())?;
        let blobs = self.run(gray, mask_payload, crop_rect)?;
        let origin = crop_rect.map_or(core::Point::new(0, 0), |rect| rect.tl());
        Ok(blobs
            .iter()
            .map(|blob| Bird {
                x: blob.center.x + origin.x as f64,
                y: blob.center.y + origin.y as f64,
                radius: blob.radius(),
                count: blob.count,
            })
            .collect())
    }

    /// Like `detect`, but returns the (cropped) image annotated with rings as PNG, and
    /// the number of birds.
    pub fn apply(
        &self,
        payload: Vec<u8>,
        mask_payload: Option<Vec<u8>>,
        crop: Option<Crop>,
    ) -> Result<(Vec<u8>, usize), String> {
        let full = decode_color(&payload)?;
        let crop_rect = crop_rect(crop, full.cols(), full.rows())?;
        let blobs = self.run(&to_gray(&full)?, mask_payload.as_deref(), crop_rect)?;
        let image = crop_mat(&full, crop_rect)?.unwrap_or(full);
        let annotated = annotate(&image, &blobs)?;
        let mut buf = core::Vector::new();
        let encode_params = core::Vector::new();
        imgcodecs::imencode(".png", &annotated, &mut buf, &encode_params)
            .map_err(|e| format!("OpenCV encode error: {}", e))?;

        let count = blobs.iter().map(|blob| blob.count as usize).sum();
        Ok((buf.to_vec(), count))
    }

    /// The blobs found in the `crop_rect` part of the whole grayscale image, in pixels of
    /// that part.
    fn run(
        &self,
        full_gray: &core::Mat,
        mask_payload: Option<&[u8]>,
        crop_rect: Option<core::Rect>,
    ) -> Result<Vec<Blob>, String> {
        let params = &self.params;

        let cropped = crop_mat(full_gray, crop_rect)?;
        let region = cropped.as_ref().unwrap_or(full_gray);

        // All the detection steps work on this copy; blobs go back to pixels of `region` below.
        let scale = working_scale(region.cols(), region.rows());
        let shrunk = shrink(region, scale, imgproc::INTER_AREA)?;
        let gray = shrunk.as_ref().unwrap_or(region);

        let exclusion_mask = match mask_payload {
            Some(mask_bytes) => {
                let mask = decode_mask(mask_bytes, full_gray.cols(), full_gray.rows())?;
                let mask = crop_mat(&mask, crop_rect)?.unwrap_or(mask);
                Some(match shrink(&mask, scale, imgproc::INTER_LINEAR)? {
                    Some(small) => binarize(&small)?,
                    None => mask,
                })
            }
            None => None,
        };
        // From the whole photo: cropping does not change how big a bird is in pixels.
        let whole_cols = scaled_side(full_gray.cols(), scale);
        let whole_rows = scaled_side(full_gray.rows(), scale);
        let window = scaled_window(params.adaptive_block, whole_cols, whole_rows);
        let landscape = if params.sky_only {
            landscape_mask(gray, window, params.invert)?
        } else {
            None
        };
        let masks = Masks {
            exclusion: exclusion_mask.as_ref(),
            landscape: landscape.as_ref().map(|(mask, _)| mask),
            reach: landscape.as_ref().map(|(_, reach)| reach),
        };

        let mut blobs = if params
            .threshold_method
            .trim()
            .eq_ignore_ascii_case("background")
        {
            self.detect_background(gray, &masks, window)?
        } else {
            self.detect_threshold(gray, &masks, window)?
        };

        blobs = absorb_fragments(blobs);
        blobs = drop_dots(blobs, whole_cols.max(whole_rows));
        for blob in &mut blobs {
            blob.center = core::Point2d::new(blob.center.x / scale, blob.center.y / scale);
            blob.area /= scale * scale;
        }

        let min_radius = params.min_radius.max(0.0);
        let max_radius = params.max_radius.max(min_radius);
        blobs.retain(|blob| {
            let radius = blob.radius();
            radius >= min_radius && radius <= max_radius
        });

        blobs = drop_clutter(blobs);
        if params.split_clusters {
            blobs = split_merged(blobs);
        }
        Ok(blobs)
    }

    /// Estimates the sky without birds and keeps blobs that are clearly darker than it.
    /// Contrast is relative to the sky brightness (birds are silhouettes against both
    /// bright and dark clouds), and the threshold rises with the local cloud texture.
    /// Birds are assumed darker than the sky unless `invert` is set.
    fn detect_background(
        &self,
        gray: &core::Mat,
        masks: &Masks,
        window: i32,
    ) -> Result<Vec<Blob>, String> {
        let params = &self.params;
        let subject = if params.invert {
            invert_image(gray)?
        } else {
            gray.try_clone()
                .map_err(|e| format!("Image clone error: {}", e))?
        };

        // Closing with a window larger than a bird's thickness erases the birds and
        // leaves the sky; the box blur smooths its blocky edges. The opening before it
        // removes bright specks the closing would otherwise spread.
        let border_value = imgproc::morphology_default_border_value()
            .map_err(|e| format!("Border value error: {}", e))?;
        let speck_kernel = imgproc::get_structuring_element(
            imgproc::MORPH_RECT,
            core::Size::new(SKY_SPECK_SIZE, SKY_SPECK_SIZE),
            core::Point::new(-1, -1),
        )
        .map_err(|e| format!("Kernel error: {}", e))?;
        let mut despeckled = core::Mat::default();
        imgproc::morphology_ex(
            &subject,
            &mut despeckled,
            imgproc::MORPH_OPEN,
            &speck_kernel,
            core::Point::new(-1, -1),
            1,
            core::BORDER_REPLICATE,
            border_value,
        )
        .map_err(|e| format!("Speck removal error: {}", e))?;
        let kernel = imgproc::get_structuring_element(
            imgproc::MORPH_RECT,
            core::Size::new(window, window),
            core::Point::new(-1, -1),
        )
        .map_err(|e| format!("Kernel error: {}", e))?;
        let mut background = core::Mat::default();
        imgproc::morphology_ex(
            &despeckled,
            &mut background,
            imgproc::MORPH_CLOSE,
            &kernel,
            core::Point::new(-1, -1),
            1,
            core::BORDER_REPLICATE,
            border_value,
        )
        .map_err(|e| format!("Background estimate error: {}", e))?;
        let mut smooth_background = core::Mat::default();
        imgproc::blur(
            &background,
            &mut smooth_background,
            core::Size::new(window, window),
            core::Point::new(-1, -1),
            core::BORDER_REPLICATE,
        )
        .map_err(|e| format!("Background blur error: {}", e))?;

        let mut subject_f = core::Mat::default();
        subject
            .convert_to(&mut subject_f, core::CV_32F, 1.0, 0.0)
            .map_err(|e| format!("Convert error: {}", e))?;
        let blur_k = odd_kernel(params.blur, 1);
        if blur_k > 1 {
            let mut smoothed = core::Mat::default();
            imgproc::gaussian_blur(
                &subject_f,
                &mut smoothed,
                core::Size::new(blur_k, blur_k),
                0.0,
                0.0,
                core::BORDER_DEFAULT,
                core::AlgorithmHint::ALGO_HINT_DEFAULT,
            )
            .map_err(|e| format!("Blur error: {}", e))?;
            subject_f = smoothed;
        }

        // Relative darkness (Weber contrast), and its absolute value quantized to 8 bits
        // (up to the texture cap) for the median filter.
        let rows = gray.rows();
        let cols = gray.cols();
        let mut contrast =
            core::Mat::new_rows_cols_with_default(rows, cols, core::CV_32F, core::Scalar::all(0.0))
                .map_err(|e| format!("Alloc error: {}", e))?;
        let mut deviation =
            core::Mat::new_rows_cols_with_default(rows, cols, core::CV_8U, core::Scalar::all(0.0))
                .map_err(|e| format!("Alloc error: {}", e))?;
        let deviation_cap = MAX_TEXTURE / MAD_TO_SIGMA;
        {
            let background_data = smooth_background
                .data_bytes()
                .map_err(|e| format!("Background access error: {}", e))?;
            let subject_data = subject_f
                .data_typed::<f32>()
                .map_err(|e| format!("Image access error: {}", e))?;
            let contrast_data = contrast
                .data_typed_mut::<f32>()
                .map_err(|e| format!("Contrast access error: {}", e))?;
            let deviation_data = deviation
                .data_bytes_mut()
                .map_err(|e| format!("Texture access error: {}", e))?;
            for (((out, dev), &sky), &value) in contrast_data
                .iter_mut()
                .zip(deviation_data.iter_mut())
                .zip(background_data)
                .zip(subject_data)
            {
                // The contrast is relative to the real sky, also when the image is flipped.
                let sky = sky as f32;
                let reference = if params.invert { 255.0 - sky } else { sky };
                let signed = (sky - value) / reference.max(1.0);
                *out = signed.clamp(0.0, 1.0);
                *dev = (signed.abs().min(deviation_cap) / deviation_cap * 255.0).round() as u8;
            }
        }

        let texture = local_median(&deviation, odd_kernel(3 * window, 3))?;

        // Significance: contrast divided by the local threshold (> 1 means a detection).
        let sensitivity = params.sensitivity.max(0.0) as f32;
        let mut significance =
            core::Mat::new_rows_cols_with_default(rows, cols, core::CV_32F, core::Scalar::all(0.0))
                .map_err(|e| format!("Alloc error: {}", e))?;
        let mut candidates =
            core::Mat::new_rows_cols_with_default(rows, cols, core::CV_8U, core::Scalar::all(0.0))
                .map_err(|e| format!("Alloc error: {}", e))?;
        let mut links =
            core::Mat::new_rows_cols_with_default(rows, cols, core::CV_8U, core::Scalar::all(0.0))
                .map_err(|e| format!("Alloc error: {}", e))?;
        {
            let contrast_data = contrast
                .data_typed::<f32>()
                .map_err(|e| format!("Contrast access error: {}", e))?;
            let texture_data = texture
                .data_bytes()
                .map_err(|e| format!("Texture access error: {}", e))?;
            let significance_data = significance
                .data_typed_mut::<f32>()
                .map_err(|e| format!("Significance access error: {}", e))?;
            let texture_scale = MAX_TEXTURE / 255.0;
            for ((out, &c), &t) in significance_data
                .iter_mut()
                .zip(contrast_data)
                .zip(texture_data)
            {
                let threshold = (sensitivity * texture_scale * t as f32).max(MIN_CONTRAST as f32);
                *out = c / threshold;
            }
            let candidate_data = candidates
                .data_bytes_mut()
                .map_err(|e| format!("Candidate access error: {}", e))?;
            for (out, &q) in candidate_data.iter_mut().zip(significance_data.iter()) {
                *out = if q > LOW_THRESHOLD_RATIO { 255 } else { 0 };
            }
            let link_data = links
                .data_bytes_mut()
                .map_err(|e| format!("Link access error: {}", e))?;
            let link_scale = LANDSCAPE_LINK_SENSITIVITY * texture_scale;
            for ((out, &c), &t) in link_data.iter_mut().zip(contrast_data).zip(texture_data) {
                let threshold = (link_scale * t as f32).max(MIN_CONTRAST as f32);
                *out = if c > threshold * LOW_THRESHOLD_RATIO {
                    255
                } else {
                    0
                };
            }
        }
        candidates = masks.apply(candidates)?;
        if let (Some(landscape), Some(reach)) = (masks.landscape, masks.reach) {
            candidates = drop_linked(&candidates, &links, landscape, reach, window)?;
        }

        let mut labels = core::Mat::default();
        let mut stats = core::Mat::default();
        let mut centroids = core::Mat::default();
        let label_count = imgproc::connected_components_with_stats(
            &candidates,
            &mut labels,
            &mut stats,
            &mut centroids,
            8,
            core::CV_32S,
        )
        .map_err(|e| format!("Connected components error: {}", e))?
            as usize;

        // Hysteresis: keep only components whose strongest pixel passes the threshold.
        let mut peaks = vec![0f32; label_count];
        let label_data = labels
            .data_typed::<i32>()
            .map_err(|e| format!("Label access error: {}", e))?;
        let significance_data = significance
            .data_typed::<f32>()
            .map_err(|e| format!("Significance access error: {}", e))?;
        // The background (label 0) is most of the image and is never kept; updating its
        // peak would make every pixel write to the same place, which is several times slower.
        for (&label, &value) in label_data.iter().zip(significance_data) {
            if label != 0 {
                let peak = &mut peaks[label as usize];
                *peak = peak.max(value);
            }
        }

        let mut blobs = Vec::new();
        for label in 1..label_count {
            if peaks[label] <= 1.0 {
                continue;
            }
            let stat = |field: i32| -> Result<i32, String> {
                stats
                    .at_2d::<i32>(label as i32, field)
                    .copied()
                    .map_err(|e| format!("Stats access error: {}", e))
            };
            let left = stat(imgproc::CC_STAT_LEFT)?;
            let top = stat(imgproc::CC_STAT_TOP)?;
            let touches_border = left == 0
                || top == 0
                || left + stat(imgproc::CC_STAT_WIDTH)? >= cols
                || top + stat(imgproc::CC_STAT_HEIGHT)? >= rows;
            let cx = *centroids
                .at_2d::<f64>(label as i32, 0)
                .map_err(|e| format!("Centroid access error: {}", e))?;
            let cy = *centroids
                .at_2d::<f64>(label as i32, 1)
                .map_err(|e| format!("Centroid access error: {}", e))?;
            blobs.push(Blob {
                center: core::Point2d::new(cx, cy),
                area: stat(imgproc::CC_STAT_AREA)? as f64,
                count: 1,
                touches_border,
                bounds: core::Rect::new(
                    left,
                    top,
                    stat(imgproc::CC_STAT_WIDTH)?,
                    stat(imgproc::CC_STAT_HEIGHT)?,
                ),
            });
        }
        Ok(blobs)
    }

    /// Classic pipeline: global/adaptive threshold, morphology and external contours.
    fn detect_threshold(
        &self,
        gray: &core::Mat,
        masks: &Masks,
        window: i32,
    ) -> Result<Vec<Blob>, String> {
        let params = &self.params;

        let blur_k = odd_kernel(params.blur, 1);
        let mut blurred = core::Mat::default();
        imgproc::gaussian_blur(
            gray,
            &mut blurred,
            core::Size::new(blur_k, blur_k),
            0.0,
            0.0,
            core::BORDER_DEFAULT,
            core::AlgorithmHint::ALGO_HINT_DEFAULT,
        )
        .map_err(|e| format!("Blur error: {}", e))?;

        let mut binary = threshold_image(
            &blurred,
            &params.threshold_method,
            window,
            params.adaptive_c,
        )?;

        if params.auto_invert {
            let white = core::count_non_zero(&binary)
                .map_err(|e| format!("Auto invert error: {}", e))? as f64;
            let total = (binary.rows() as f64) * (binary.cols() as f64);
            if total > 0.0 && (white / total) > 0.5 {
                binary = invert_image(&binary)?;
            }
        }

        if params.invert {
            binary = invert_image(&binary)?;
        }

        let morph_k = odd_kernel(params.morph_kernel, 1);
        let kernel = imgproc::get_structuring_element(
            imgproc::MORPH_ELLIPSE,
            core::Size::new(morph_k, morph_k),
            core::Point::new(-1, -1),
        )
        .map_err(|e| format!("Kernel error: {}", e))?;

        let open_iter = params.morph_open_iter.max(0);
        let close_iter = params.morph_close_iter.max(0);

        let mut opened = core::Mat::default();
        if open_iter > 0 {
            imgproc::morphology_ex(
                &binary,
                &mut opened,
                imgproc::MORPH_OPEN,
                &kernel,
                core::Point::new(-1, -1),
                open_iter,
                core::BORDER_CONSTANT,
                core::Scalar::default(),
            )
            .map_err(|e| format!("Morph open error: {}", e))?;
        } else {
            opened = binary
                .try_clone()
                .map_err(|e| format!("Morph open clone error: {}", e))?;
        }

        let mut cleaned = core::Mat::default();
        if close_iter > 0 {
            imgproc::morphology_ex(
                &opened,
                &mut cleaned,
                imgproc::MORPH_CLOSE,
                &kernel,
                core::Point::new(-1, -1),
                close_iter,
                core::BORDER_CONSTANT,
                core::Scalar::default(),
            )
            .map_err(|e| format!("Morph close error: {}", e))?;
        } else {
            cleaned = opened
                .try_clone()
                .map_err(|e| format!("Morph close clone error: {}", e))?;
        }

        cleaned = masks.apply(cleaned)?;

        let mut contours: core::Vector<core::Vector<core::Point>> = core::Vector::new();
        imgproc::find_contours(
            &cleaned,
            &mut contours,
            imgproc::RETR_EXTERNAL,
            imgproc::CHAIN_APPROX_SIMPLE,
            core::Point::new(0, 0),
        )
        .map_err(|e| format!("Find contours error: {}", e))?;

        let mut blobs = Vec::new();
        for contour in contours.iter() {
            let area = geometry::contour_area(&contour, false)
                .map_err(|e| format!("Contour area error: {}", e))?;
            if area <= 0.0 {
                continue;
            }
            let Some(center) = contour_center(&contour)? else {
                continue;
            };
            let bounds = geometry::bounding_rect(&contour)
                .map_err(|e| format!("Bounding rect error: {}", e))?;
            let touches_border = bounds.x == 0
                || bounds.y == 0
                || bounds.x + bounds.width >= cleaned.cols()
                || bounds.y + bounds.height >= cleaned.rows();
            blobs.push(Blob {
                center,
                area,
                count: 1,
                touches_border,
                bounds,
            });
        }
        Ok(blobs)
    }
}

/// Finds everything that is not sky (255). The sky is the smooth part of the image
/// connected to its top edge (see `sky_candidates`), plus rough islands far from the rest (dense flocks,
/// sharp cloud edges). Smoothness is the relative gradient of a downscaled copy from
/// which birds were removed by a closing (an opening for `bright_birds`) one window
/// wide. Returns `None` when there is (almost) no sky, and the zones around the landscape with
/// the mask (grown on the small copy, which is much faster).
fn landscape_mask(
    gray: &core::Mat,
    window: i32,
    bright_birds: bool,
) -> Result<Option<(core::Mat, Reach)>, String> {
    let scale = (window as f64 / SKY_MASK_WINDOW as f64).max(1.0);
    let size = core::Size::new(
        ((gray.cols() as f64 / scale).round() as i32).max(1),
        ((gray.rows() as f64 / scale).round() as i32).max(1),
    );
    let mut small = core::Mat::default();
    imgproc::resize(gray, &mut small, size, 0.0, 0.0, imgproc::INTER_AREA)
        .map_err(|e| format!("Sky resize error: {}", e))?;
    let mut small_f = core::Mat::default();
    small
        .convert_to(&mut small_f, core::CV_32F, 1.0, 0.0)
        .map_err(|e| format!("Convert error: {}", e))?;

    let kernel = imgproc::get_structuring_element(
        imgproc::MORPH_RECT,
        core::Size::new(SKY_MASK_WINDOW, SKY_MASK_WINDOW),
        core::Point::new(-1, -1),
    )
    .map_err(|e| format!("Kernel error: {}", e))?;
    let border_value = imgproc::morphology_default_border_value()
        .map_err(|e| format!("Border value error: {}", e))?;
    let mut closed = core::Mat::default();
    imgproc::morphology_ex(
        &small_f,
        &mut closed,
        if bright_birds {
            imgproc::MORPH_OPEN
        } else {
            imgproc::MORPH_CLOSE
        },
        &kernel,
        core::Point::new(-1, -1),
        1,
        core::BORDER_REPLICATE,
        border_value,
    )
    .map_err(|e| format!("Sky closing error: {}", e))?;

    let mut gx = core::Mat::default();
    let mut gy = core::Mat::default();
    for (out, dx, dy) in [(&mut gx, 1, 0), (&mut gy, 0, 1)] {
        imgproc::sobel(
            &closed,
            out,
            core::CV_32F,
            dx,
            dy,
            3,
            1.0,
            0.0,
            core::BORDER_REPLICATE,
        )
        .map_err(|e| format!("Sobel error: {}", e))?;
    }
    let mut gradient = core::Mat::default();
    core::magnitude(&gx, &gy, &mut gradient).map_err(|e| format!("Magnitude error: {}", e))?;
    {
        let closed_data = closed
            .data_typed::<f32>()
            .map_err(|e| format!("Sky access error: {}", e))?;
        let gradient_data = gradient
            .data_typed_mut::<f32>()
            .map_err(|e| format!("Gradient access error: {}", e))?;
        for (g, &value) in gradient_data.iter_mut().zip(closed_data) {
            *g /= value.max(1.0);
        }
    }
    let texture_window = 2 * SKY_MASK_WINDOW - 1;
    let mut texture = core::Mat::default();
    imgproc::blur(
        &gradient,
        &mut texture,
        core::Size::new(texture_window, texture_window),
        core::Point::new(-1, -1),
        core::BORDER_REPLICATE,
    )
    .map_err(|e| format!("Texture blur error: {}", e))?;

    let mut smooth = core::Mat::new_size_with_default(size, core::CV_8U, core::Scalar::all(0.0))
        .map_err(|e| format!("Alloc error: {}", e))?;
    {
        let texture_data = texture
            .data_typed::<f32>()
            .map_err(|e| format!("Texture access error: {}", e))?;
        let smooth_data = smooth
            .data_bytes_mut()
            .map_err(|e| format!("Sky access error: {}", e))?;
        for (out, &t) in smooth_data.iter_mut().zip(texture_data) {
            *out = if t <= SKY_MAX_TEXTURE { 255 } else { 0 };
        }
    }

    let top_smooth = sky_candidates(&smooth, &closed, bright_birds)?;
    // Landscape: the rest of the image connected to its edges, together with rough
    // islands near it (leaves sticking out of a tree). Islands farther away are
    // dense flocks or sharp cloud edges and stay sky, also when they are near the edge
    // of the photo (a flock low over smooth water).
    let not_sky = invert_image(&top_smooth)?;
    let reach = 2 * SKY_REACH + 1;
    let reach_kernel = imgproc::get_structuring_element(
        imgproc::MORPH_ELLIPSE,
        core::Size::new(reach, reach),
        core::Point::new(-1, -1),
    )
    .map_err(|e| format!("Kernel error: {}", e))?;
    let mut grown = core::Mat::default();
    imgproc::dilate(
        &not_sky,
        &mut grown,
        &reach_kernel,
        core::Point::new(-1, -1),
        1,
        core::BORDER_CONSTANT,
        border_value,
    )
    .map_err(|e| format!("Sky dilate error: {}", e))?;
    let (cols, rows) = (size.width, size.height);
    let edge_land = components_where(&not_sky, 8, |left, top, width, height| {
        left == 0 || top == 0 || left + width >= cols || top + height >= rows
    })?;
    let landscape_zone = components_touching(&grown, &edge_land)?;
    let mut landscape = core::Mat::default();
    core::bitwise_and(&not_sky, &landscape_zone, &mut landscape, &core::no_array())
        .map_err(|e| format!("Mask combine error: {}", e))?;

    let landscape_pixels =
        core::count_non_zero(&landscape).map_err(|e| format!("Sky count error: {}", e))? as f64;
    let total = (cols as f64) * (rows as f64);
    if total - landscape_pixels < SKY_MIN_FRACTION * total {
        return Ok(None);
    }

    let landscape = fill_below_land(&landscape)?;
    let windows = |count: f64| (window as f64 * count / scale).round() as i32;
    let near = grow(&landscape, windows(LANDSCAPE_CUT_WINDOWS))?;
    let far = grow(&landscape, windows(LANDSCAPE_REACH_WINDOWS))?;
    let linked = grow(&landscape, windows(LANDSCAPE_LINK_REACH_WINDOWS))?;

    let full_size = gray.size().map_err(|e| format!("Size error: {}", e))?;
    let upscale = |mask: &core::Mat| -> Result<core::Mat, String> {
        let mut upscaled = core::Mat::default();
        imgproc::resize(
            mask,
            &mut upscaled,
            full_size,
            0.0,
            0.0,
            imgproc::INTER_LINEAR,
        )
        .map_err(|e| format!("Sky resize error: {}", e))?;
        let mut full = core::Mat::default();
        imgproc::threshold(&upscaled, &mut full, 127.0, 255.0, imgproc::THRESH_BINARY)
            .map_err(|e| format!("Sky threshold error: {}", e))?;
        Ok(full)
    };
    Ok(Some((
        upscale(&landscape)?,
        Reach {
            near: upscale(&near)?,
            far: upscale(&far)?,
            linked: upscale(&linked)?,
        },
    )))
}

/// `landscape` with everything below the ground marked too: sky can't be under it, and what
/// looks like it there is water or a smooth field. Ground reaches down into the lower half of
/// the image but not up to its top edge, unlike branches hanging in front of the sky or the
/// lower edge of something blocking the view across the top.
fn fill_below_land(landscape: &core::Mat) -> Result<core::Mat, String> {
    let rows = landscape.rows();
    let ground = components_where(landscape, 8, |_, top, _, height| {
        top > 0 && 2 * (top + height) >= rows
    })?;
    let mut out = landscape
        .try_clone()
        .map_err(|e| format!("Mask clone error: {}", e))?;
    let cols = landscape.cols() as usize;
    let ground_data = ground
        .data_bytes()
        .map_err(|e| format!("Mask access error: {}", e))?;
    let out_data = out
        .data_bytes_mut()
        .map_err(|e| format!("Mask access error: {}", e))?;
    let mut below = vec![false; cols];
    for (ground_row, out_row) in ground_data.chunks(cols).zip(out_data.chunks_mut(cols)) {
        for ((flag, &value), out) in below.iter_mut().zip(ground_row).zip(out_row) {
            *flag |= value > 0;
            if *flag {
                *out = 255;
            }
        }
    }
    Ok(out)
}

/// Removes from `binary` what `links` connects to the landscape across small gaps (as
/// `drop_touching` does). Twigs and leaves stay in `binary` as separate pieces, but they lead down
/// to the tree they grow on.
fn drop_linked(
    binary: &core::Mat,
    links: &core::Mat,
    landscape: &core::Mat,
    reach: &Reach,
    window: i32,
) -> Result<core::Mat, String> {
    let grown = grow(links, (window as f64 * LANDSCAPE_GAP_RATIO).round() as i32)?;
    let free = drop_touching(&grown, landscape, &reach.near, &reach.linked)?;
    let mut out = core::Mat::default();
    core::bitwise_and(binary, &free, &mut out, &core::no_array())
        .map_err(|e| format!("Mask combine error: {}", e))?;
    Ok(out)
}

/// `mask` grown by `reach` pixels in every direction. A square, not a disk: OpenCV.js dilates
/// with a disk ten times slower.
fn grow(mask: &core::Mat, reach: i32) -> Result<core::Mat, String> {
    let kernel = imgproc::get_structuring_element(
        imgproc::MORPH_RECT,
        core::Size::new(2 * reach + 1, 2 * reach + 1),
        core::Point::new(-1, -1),
    )
    .map_err(|e| format!("Kernel error: {}", e))?;
    let mut grown = core::Mat::default();
    imgproc::dilate(
        mask,
        &mut grown,
        &kernel,
        core::Point::new(-1, -1),
        1,
        core::BORDER_CONSTANT,
        imgproc::morphology_default_border_value()
            .map_err(|e| format!("Border value error: {}", e))?,
    )
    .map_err(|e| format!("Dilate error: {}", e))?;
    Ok(grown)
}

/// Candidate sky (255): the smooth components reaching the top edge. When those are missing
/// or small, something may be blocking the view across the top, so the largest smooth
/// component joins them if they are next to nothing or it is much brighter than they are.
/// `brightness` is 32-bit float.
fn sky_candidates(
    smooth: &core::Mat,
    brightness: &core::Mat,
    bright_birds: bool,
) -> Result<core::Mat, String> {
    let mut labels = core::Mat::default();
    let mut stats = core::Mat::default();
    let mut centroids = core::Mat::default();
    let label_count = imgproc::connected_components_with_stats(
        smooth,
        &mut labels,
        &mut stats,
        &mut centroids,
        4,
        core::CV_32S,
    )
    .map_err(|e| format!("Connected components error: {}", e))? as usize;

    let mut selected = vec![false; label_count];
    let mut areas = vec![0f64; label_count];
    for label in 1..label_count {
        let stat = |field: i32| -> Result<i32, String> {
            stats
                .at_2d::<i32>(label as i32, field)
                .copied()
                .map_err(|e| format!("Stats access error: {}", e))
        };
        selected[label] = stat(imgproc::CC_STAT_TOP)? == 0;
        areas[label] = stat(imgproc::CC_STAT_AREA)? as f64;
    }
    let label_data = labels
        .data_typed::<i32>()
        .map_err(|e| format!("Label access error: {}", e))?;
    let brightness_data = brightness
        .data_typed::<f32>()
        .map_err(|e| format!("Sky access error: {}", e))?;
    let mut totals = vec![0f64; label_count];
    for (&label, &value) in label_data.iter().zip(brightness_data) {
        totals[label as usize] += value as f64;
    }

    let total = (smooth.rows() as f64) * (smooth.cols() as f64);
    let top_area: f64 = (1..label_count)
        .filter(|&l| selected[l])
        .map(|l| areas[l])
        .sum();
    let top_total: f64 = (1..label_count)
        .filter(|&l| selected[l])
        .map(|l| totals[l])
        .sum();
    let largest = (1..label_count).max_by(|&a, &b| areas[a].total_cmp(&areas[b]));
    if let Some(largest) = largest {
        let area = areas[largest];
        // Next to nothing at the top is not sky, whatever its brightness.
        let much_brighter = top_area < SKY_MIN_FRACTION * total
            || (!bright_birds
                && totals[largest] / area > SKY_BLOCKER_BRIGHTNESS * top_total / top_area);
        if area >= SKY_MIN_FRACTION * total
            && top_area < SKY_TOP_TRUSTED_FRACTION * total
            && area > top_area
            && much_brighter
        {
            selected[largest] = true;
        }
    }

    let mut mask = core::Mat::new_rows_cols_with_default(
        smooth.rows(),
        smooth.cols(),
        core::CV_8U,
        core::Scalar::all(0.0),
    )
    .map_err(|e| format!("Alloc error: {}", e))?;
    let mask_data = mask
        .data_bytes_mut()
        .map_err(|e| format!("Mask access error: {}", e))?;
    for (out, &label) in mask_data.iter_mut().zip(label_data) {
        if selected[label as usize] {
            *out = 255;
        }
    }
    Ok(mask)
}

/// Mask (255) of the connected components of a binary image whose bounding box
/// (left, top, width, height) satisfies `keep`.
fn components_where(
    binary: &core::Mat,
    connectivity: i32,
    keep: impl Fn(i32, i32, i32, i32) -> bool,
) -> Result<core::Mat, String> {
    let mut labels = core::Mat::default();
    let mut stats = core::Mat::default();
    let mut centroids = core::Mat::default();
    let label_count = imgproc::connected_components_with_stats(
        binary,
        &mut labels,
        &mut stats,
        &mut centroids,
        connectivity,
        core::CV_32S,
    )
    .map_err(|e| format!("Connected components error: {}", e))? as usize;

    let mut selected = vec![false; label_count];
    for (label, keep_label) in selected.iter_mut().enumerate().skip(1) {
        let stat = |field: i32| -> Result<i32, String> {
            stats
                .at_2d::<i32>(label as i32, field)
                .copied()
                .map_err(|e| format!("Stats access error: {}", e))
        };
        *keep_label = keep(
            stat(imgproc::CC_STAT_LEFT)?,
            stat(imgproc::CC_STAT_TOP)?,
            stat(imgproc::CC_STAT_WIDTH)?,
            stat(imgproc::CC_STAT_HEIGHT)?,
        );
    }

    let mut mask = core::Mat::new_rows_cols_with_default(
        binary.rows(),
        binary.cols(),
        core::CV_8U,
        core::Scalar::all(0.0),
    )
    .map_err(|e| format!("Alloc error: {}", e))?;
    let label_data = labels
        .data_typed::<i32>()
        .map_err(|e| format!("Label access error: {}", e))?;
    let mask_data = mask
        .data_bytes_mut()
        .map_err(|e| format!("Mask access error: {}", e))?;
    for (out, &label) in mask_data.iter_mut().zip(label_data) {
        if selected[label as usize] {
            *out = 255;
        }
    }
    Ok(mask)
}

/// Mask (255) of the connected components of a binary image that share a pixel with `seeds`.
fn components_touching(binary: &core::Mat, seeds: &core::Mat) -> Result<core::Mat, String> {
    let mut labels = core::Mat::default();
    let label_count = imgproc::connected_components(binary, &mut labels, 8, core::CV_32S)
        .map_err(|e| format!("Connected components error: {}", e))? as usize;
    let label_data = labels
        .data_typed::<i32>()
        .map_err(|e| format!("Label access error: {}", e))?;
    let seed_data = seeds
        .data_bytes()
        .map_err(|e| format!("Mask access error: {}", e))?;
    let mut selected = vec![false; label_count];
    for (&label, &seed) in label_data.iter().zip(seed_data) {
        if seed > 0 && label > 0 {
            selected[label as usize] = true;
        }
    }
    let mut mask = core::Mat::new_rows_cols_with_default(
        binary.rows(),
        binary.cols(),
        core::CV_8U,
        core::Scalar::all(0.0),
    )
    .map_err(|e| format!("Alloc error: {}", e))?;
    let mask_data = mask
        .data_bytes_mut()
        .map_err(|e| format!("Mask access error: {}", e))?;
    for (out, &label) in mask_data.iter_mut().zip(label_data) {
        if selected[label as usize] {
            *out = 255;
        }
    }
    Ok(mask)
}

/// The median area of the detections near `blob`, from the same flock; `None` when there
/// are too few of them to tell (see `neighbours`).
fn local_area(blob: &Blob, blobs: &[Blob]) -> Option<f64> {
    let mut areas: Vec<f64> = neighbours(blob, blobs)?
        .iter()
        .map(|(_, area)| *area)
        .collect();
    Some(median(&mut areas))
}

/// The area of a single bird near `blob`: the median area of its neighbours, or a lower quantile
/// of them when they are crowded (`SPLIT_CROWDED_COVERAGE`). `None` when there are too few
/// neighbours to tell.
fn single_area(blob: &Blob, blobs: &[Blob]) -> Option<f64> {
    let neighbours = neighbours(blob, blobs)?;
    let radius = neighbours.last().map_or(0.0, |(distance, _)| *distance);
    let mut areas: Vec<f64> = neighbours.iter().map(|(_, area)| *area).collect();
    let crowding = if radius > 0.0 {
        let coverage = areas.iter().sum::<f64>() / (std::f64::consts::PI * radius * radius);
        ((coverage - SPLIT_CROWDED_COVERAGE) / (SPLIT_PACKED_COVERAGE - SPLIT_CROWDED_COVERAGE))
            .clamp(0.0, 1.0)
    } else {
        0.0
    };
    Some(quantile(
        &mut areas,
        0.5 - crowding * (0.5 - SPLIT_PACKED_QUANTILE),
    ))
}

/// The `SPLIT_NEIGHBOURS` detections nearest to `blob` (itself included) as (distance, area),
/// nearest first; `None` when there are fewer than `SPLIT_MIN_NEIGHBOURS`. A detection counts as
/// near when it lies within `SPLIT_NEIGHBOUR_DISTANCE` of *its own* sizes, so small noise specks
/// or a distant flock of smaller birds do not count.
fn neighbours(blob: &Blob, blobs: &[Blob]) -> Option<Vec<(f64, f64)>> {
    let mut neighbours: Vec<(f64, f64)> = blobs
        .iter()
        .filter_map(|other| {
            let distance = (other.center.x - blob.center.x).hypot(other.center.y - blob.center.y);
            (distance <= SPLIT_NEIGHBOUR_DISTANCE * other.area.sqrt())
                .then_some((distance, other.area))
        })
        .collect();
    if neighbours.len() < SPLIT_MIN_NEIGHBOURS {
        return None;
    }
    neighbours.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    neighbours.truncate(SPLIT_NEIGHBOURS);
    Some(neighbours)
}

/// Removes tiny pieces right next to a much larger blob, like wing tips cut off from a bird. The
/// larger blob must be a bird or two (`FRAGMENT_MAX_BIRDS`), not a clump of a dense flock.
fn absorb_fragments(blobs: Vec<Blob>) -> Vec<Blob> {
    if blobs.len() > SPLIT_MAX_DETECTIONS {
        return blobs;
    }
    let near = |blob: &Blob, large: &Blob| {
        if blob.area >= FRAGMENT_RATIO * large.area {
            return false;
        }
        let (left, top) = (large.bounds.x as f64, large.bounds.y as f64);
        let right = left + large.bounds.width as f64;
        let bottom = top + large.bounds.height as f64;
        let dx = (left - blob.center.x).max(blob.center.x - right).max(0.0);
        let dy = (top - blob.center.y).max(blob.center.y - bottom).max(0.0);
        dx.hypot(dy) <= large.radius()
    };
    // Whether each blob can have wing tips, worked out only for blobs next to a fragment.
    let mut single: Vec<Option<bool>> = vec![None; blobs.len()];
    let mut keep = vec![true; blobs.len()];
    for (index, blob) in blobs.iter().enumerate() {
        for (large_index, large) in blobs.iter().enumerate() {
            if !near(blob, large) {
                continue;
            }
            let is_single = *single[large_index].get_or_insert_with(|| {
                single_area(large, &blobs)
                    .is_none_or(|area| large.area <= FRAGMENT_MAX_BIRDS * area)
            });
            if is_single {
                keep[index] = false;
                break;
            }
        }
    }
    blobs
        .into_iter()
        .zip(keep)
        .filter(|(_, keep)| *keep)
        .map(|(blob, _)| blob)
        .collect()
}

/// Removes tiny compact dots when the photo also has larger birds: scattered over the sky
/// without any bird shape, they are more often insects than birds. `whole_side` is the longer
/// side of the whole photo in pixels of the blobs. A photo of only tiny birds keeps them all.
fn drop_dots(blobs: Vec<Blob>, whole_side: i32) -> Vec<Blob> {
    let mut areas: Vec<f64> = blobs.iter().map(|blob| blob.area).collect();
    let typical = median(&mut areas);
    let size = whole_side as f64 / MAX_WORKING_SIDE as f64;
    let max_area = (DOT_MAX_AREA * size * size).min(DOT_MEDIAN_RATIO * typical);
    let max_side = DOT_MAX_SIDE * size;
    blobs
        .into_iter()
        .filter(|blob| {
            blob.area >= max_area || blob.bounds.width.max(blob.bounds.height) as f64 > max_side
        })
        .collect()
}

/// Removes blobs much larger than a typical detection: anything touching the image edge
/// (trees, roofs, lamps) above `BORDER_CLUTTER_RATIO` median blobs, and anything else above
/// `MAX_CLUTTER_RATIO` of them. Elsewhere in the image a blob is also compared with its own
/// flock, because near birds are much larger than far ones, and they do not make each other
/// clutter.
fn drop_clutter(blobs: Vec<Blob>) -> Vec<Blob> {
    let mut areas: Vec<f64> = blobs.iter().map(|blob| blob.area).collect();
    let typical = median(&mut areas);
    if typical <= 0.0 {
        return blobs;
    }
    let local: Vec<Option<f64>> = if blobs.len() > SPLIT_MAX_DETECTIONS {
        vec![None; blobs.len()]
    } else {
        blobs.iter().map(|blob| local_area(blob, &blobs)).collect()
    };
    blobs
        .iter()
        .zip(local)
        .filter(|(blob, local)| {
            let reference = local.map_or(typical, |area| area.max(typical));
            blob.area / reference <= MAX_CLUTTER_RATIO
                && !(blob.touches_border && blob.area / typical > BORDER_CLUTTER_RATIO)
        })
        .map(|(blob, _)| blob.clone())
        .collect()
}

/// Estimates how many birds each blob holds by comparing its area with the area of a single bird
/// of the same flock nearby (`single_area`).
fn split_merged(mut blobs: Vec<Blob>) -> Vec<Blob> {
    if blobs.len() > SPLIT_MAX_DETECTIONS {
        return blobs;
    }
    let counts: Vec<u32> = blobs
        .iter()
        .map(|blob| match single_area(blob, &blobs) {
            Some(reference) if reference > 0.0 => (blob.area / reference).round().max(1.0) as u32,
            _ => 1,
        })
        .collect();
    for (blob, count) in blobs.iter_mut().zip(counts) {
        blob.count = count;
    }
    blobs
}

/// The `q` quantile of `values` (0.5 is the median), interpolated between neighbouring values.
fn quantile(values: &mut [f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_unstable_by(f64::total_cmp);
    let position = q.clamp(0.0, 1.0) * (values.len() - 1) as f64;
    let (low, high) = (position.floor() as usize, position.ceil() as usize);
    values[low] + (values[high] - values[low]) * (position - low as f64)
}

fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_unstable_by(f64::total_cmp);
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    }
}

/// Draws a ring around every blob; blobs counted as several birds are orange
/// and labelled with their count.
fn annotate(image: &core::Mat, blobs: &[Blob]) -> Result<core::Mat, String> {
    let mut annotated = image
        .try_clone()
        .map_err(|e| format!("Image clone error: {}", e))?;
    let min_side = image.cols().min(image.rows()) as f64;
    let thickness = ((min_side / 1000.0).round() as i32).max(2);
    let font_scale = (min_side / 1500.0).max(0.5);
    let single = core::Scalar::new(0.0, 0.0, 255.0, 0.0);
    let cluster = core::Scalar::new(0.0, 140.0, 255.0, 0.0);

    for blob in blobs {
        let center = core::Point::new(blob.center.x.round() as i32, blob.center.y.round() as i32);
        let radius = (blob.radius() + 2.0).round() as i32;
        let color = if blob.count > 1 { cluster } else { single };
        imgproc::circle(
            &mut annotated,
            center,
            radius,
            color,
            thickness,
            imgproc::LINE_AA,
            0,
        )
        .map_err(|e| format!("Draw circle error: {}", e))?;
        if blob.count > 1 {
            imgproc::put_text(
                &mut annotated,
                &blob.count.to_string(),
                core::Point::new(center.x + radius + 2, center.y - radius),
                imgproc::FONT_HERSHEY_SIMPLEX,
                font_scale,
                cluster,
                thickness,
                imgproc::LINE_AA,
                false,
            )
            .map_err(|e| format!("Draw label error: {}", e))?;
        }
    }
    Ok(annotated)
}

fn odd_kernel(value: i32, min_odd: i32) -> i32 {
    let mut v = value.max(min_odd.max(1));
    if v % 2 == 0 {
        v += 1;
    }
    v
}

/// The local window in pixels of a photo of `cols` x `rows`.
fn scaled_window(setting: i32, cols: i32, rows: i32) -> i32 {
    let scale = cols.max(rows) as f64 / WINDOW_REFERENCE_SIDE;
    odd_kernel((setting as f64 * scale).round() as i32, 3)
}

/// The scale of the working copy of a part of a photo of `cols` x `rows` (1 when it fits).
fn working_scale(cols: i32, rows: i32) -> f64 {
    (MAX_WORKING_SIDE as f64 / cols.max(rows) as f64).min(1.0)
}

fn scaled_side(side: i32, scale: f64) -> i32 {
    ((side as f64 * scale).round() as i32).max(1)
}

/// A copy of `src` scaled by `scale`; `None` when that changes nothing.
fn shrink(src: &core::Mat, scale: f64, interpolation: i32) -> Result<Option<core::Mat>, String> {
    if scale >= 1.0 {
        return Ok(None);
    }
    let size = core::Size::new(
        scaled_side(src.cols(), scale),
        scaled_side(src.rows(), scale),
    );
    let mut out = core::Mat::default();
    imgproc::resize(src, &mut out, size, 0.0, 0.0, interpolation)
        .map_err(|e| format!("Resize error: {}", e))?;
    Ok(Some(out))
}

/// 255 wherever `src` is not 0.
fn binarize(src: &core::Mat) -> Result<core::Mat, String> {
    let mut out = core::Mat::default();
    imgproc::threshold(src, &mut out, 0.0, 255.0, imgproc::THRESH_BINARY)
        .map_err(|e| format!("Threshold error: {}", e))?;
    Ok(out)
}

/// Median of `src` (8-bit) in a square window. A window too wide for the median filter
/// uses a subsampled copy, which is close enough for a slowly changing map like this.
fn local_median(src: &core::Mat, window: i32) -> Result<core::Mat, String> {
    let error = |e: opencv::Error| format!("Median error: {}", e);
    let mut out = core::Mat::default();
    if window <= MAX_MEDIAN_WINDOW {
        imgproc::median_blur(src, &mut out, window).map_err(error)?;
        return Ok(out);
    }
    let factor = (window + MAX_MEDIAN_WINDOW - 1) / MAX_MEDIAN_WINDOW;
    let size = core::Size::new(
        ((src.cols() + factor - 1) / factor).max(1),
        ((src.rows() + factor - 1) / factor).max(1),
    );
    let mut small = core::Mat::default();
    imgproc::resize(src, &mut small, size, 0.0, 0.0, imgproc::INTER_NEAREST).map_err(error)?;
    let mut filtered = core::Mat::default();
    imgproc::median_blur(&small, &mut filtered, odd_kernel(window / factor, 3)).map_err(error)?;
    let full_size = src.size().map_err(error)?;
    imgproc::resize(
        &filtered,
        &mut out,
        full_size,
        0.0,
        0.0,
        imgproc::INTER_LINEAR,
    )
    .map_err(error)?;
    Ok(out)
}

fn threshold_image(
    blurred: &core::Mat,
    method: &str,
    adaptive_block: i32,
    adaptive_c: f64,
) -> Result<core::Mat, String> {
    let mut binary = core::Mat::default();
    let normalized = method.trim().to_lowercase();
    if normalized == "adaptive" {
        let block = odd_kernel(adaptive_block, 3);
        imgproc::adaptive_threshold(
            blurred,
            &mut binary,
            255.0,
            imgproc::ADAPTIVE_THRESH_GAUSSIAN_C,
            imgproc::THRESH_BINARY,
            block,
            adaptive_c,
        )
        .map_err(|e| format!("Adaptive threshold error: {}", e))?;
    } else {
        imgproc::threshold(
            blurred,
            &mut binary,
            0.0,
            255.0,
            imgproc::THRESH_BINARY | imgproc::THRESH_OTSU,
        )
        .map_err(|e| format!("Otsu threshold error: {}", e))?;
    }
    Ok(binary)
}

fn invert_image(src: &core::Mat) -> Result<core::Mat, String> {
    let mut inverted = core::Mat::default();
    core::bitwise_not(src, &mut inverted, &core::no_array())
        .map_err(|e| format!("Invert error: {}", e))?;
    Ok(inverted)
}

fn decode_mask(mask_bytes: &[u8], width: i32, height: i32) -> Result<core::Mat, String> {
    let vec = core::Vector::<u8>::from_slice(mask_bytes);
    let decoded = imgcodecs::imdecode(&vec, imgcodecs::IMREAD_GRAYSCALE)
        .map_err(|e| format!("Mask decode error: {}", e))?;
    if decoded.empty() {
        return Err("Mask decode failed".to_string());
    }

    // The app paints the mask at a lower resolution than large photos; linear
    // scaling keeps its edges smooth, and any coverage counts as masked below.
    let mut resized = core::Mat::default();
    if decoded.cols() != width || decoded.rows() != height {
        imgproc::resize(
            &decoded,
            &mut resized,
            core::Size::new(width, height),
            0.0,
            0.0,
            imgproc::INTER_LINEAR,
        )
        .map_err(|e| format!("Mask resize error: {}", e))?;
    } else {
        resized = decoded;
    }

    let mut binary_mask = core::Mat::default();
    imgproc::threshold(
        &resized,
        &mut binary_mask,
        1.0,
        255.0,
        imgproc::THRESH_BINARY,
    )
    .map_err(|e| format!("Mask threshold error: {}", e))?;
    Ok(binary_mask)
}

/// Removes the connected components of `binary` that overlap `forbidden`.
/// Removes from `binary` every component that touches `forbidden` and stays within `far`. Of one
/// that reaches farther, only the pixels within `near` are removed.
fn drop_touching(
    binary: &core::Mat,
    forbidden: &core::Mat,
    near: &core::Mat,
    far: &core::Mat,
) -> Result<core::Mat, String> {
    let mut labels = core::Mat::default();
    let label_count = imgproc::connected_components(binary, &mut labels, 8, core::CV_32S)
        .map_err(|e| format!("Connected components error: {}", e))? as usize;
    let label_data = labels
        .data_typed::<i32>()
        .map_err(|e| format!("Label access error: {}", e))?;
    let forbidden_data = forbidden
        .data_bytes()
        .map_err(|e| format!("Mask access error: {}", e))?;
    let far_data = far
        .data_bytes()
        .map_err(|e| format!("Mask access error: {}", e))?;
    let mut touching = vec![false; label_count];
    let mut escapes = vec![false; label_count];
    for ((&label, &excluded), &far) in label_data.iter().zip(forbidden_data).zip(far_data) {
        if excluded > 0 {
            touching[label as usize] = true;
        }
        if far == 0 {
            escapes[label as usize] = true;
        }
    }
    let mut out = core::Mat::new_rows_cols_with_default(
        binary.rows(),
        binary.cols(),
        core::CV_8U,
        core::Scalar::all(0.0),
    )
    .map_err(|e| format!("Alloc error: {}", e))?;
    let out_data = out
        .data_bytes_mut()
        .map_err(|e| format!("Mask access error: {}", e))?;
    let near_data = near
        .data_bytes()
        .map_err(|e| format!("Mask access error: {}", e))?;
    for ((value, &label), &close) in out_data.iter_mut().zip(label_data).zip(near_data) {
        let label = label as usize;
        if label > 0 && !(touching[label] && (close > 0 || !escapes[label])) {
            *value = 255;
        }
    }
    Ok(out)
}

fn apply_exclusion_mask(src: &core::Mat, exclusion_mask: &core::Mat) -> Result<core::Mat, String> {
    let keep_mask = invert_image(exclusion_mask)?;
    let mut masked = core::Mat::default();
    core::bitwise_and(src, &keep_mask, &mut masked, &core::no_array())
        .map_err(|e| format!("Mask apply error: {}", e))?;
    Ok(masked)
}

fn contour_center(contour: &core::Vector<core::Point>) -> Result<Option<core::Point2d>, String> {
    let moments = geometry::moments(contour, false).map_err(|e| format!("Moments error: {}", e))?;
    if moments.m00 == 0.0 {
        return Ok(None);
    }
    Ok(Some(core::Point2d::new(
        moments.m10 / moments.m00,
        moments.m01 / moments.m00,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn photo_size_is_capped() {
        assert!(check_photo_size(16320, 12240).is_ok());
        assert_eq!(
            check_photo_size(30000, 10000),
            Err(PHOTO_TOO_LARGE.to_string())
        );
        // No overflow in i32.
        assert!(check_photo_size(i32::MAX, i32::MAX).is_err());
    }

    const WIDTH: i32 = 800;
    const HEIGHT: i32 = 500;

    /// Overcast sky: horizontal brightness gradient, a few soft clouds and sensor noise.
    fn sky(base: f64) -> core::Mat {
        let mut img = core::Mat::new_rows_cols_with_default(
            HEIGHT,
            WIDTH,
            core::CV_8UC3,
            core::Scalar::all(base),
        )
        .unwrap();
        for (x, y, r, delta) in [
            (150, 120, 110, -25.0),
            (600, 350, 140, -20.0),
            (420, 60, 90, 15.0),
        ] {
            imgproc::circle(
                &mut img,
                core::Point::new(x, y),
                r,
                core::Scalar::all(base + delta),
                -1,
                imgproc::LINE_8,
                0,
            )
            .unwrap();
        }
        let mut clouds = core::Mat::default();
        imgproc::gaussian_blur(
            &img,
            &mut clouds,
            core::Size::new(0, 0),
            40.0,
            40.0,
            core::BORDER_REPLICATE,
            core::AlgorithmHint::ALGO_HINT_DEFAULT,
        )
        .unwrap();
        clouds
    }

    /// Draws a bird `contrast` levels darker (negative: brighter) than the sky under it.
    fn draw_bird(img: &mut core::Mat, x: f64, y: f64, contrast: f64) {
        let center = core::Point::new(x.round() as i32, y.round() as i32);
        let sky = img.at_2d::<core::Vec3b>(center.y, center.x).unwrap()[0] as f64;
        imgproc::ellipse(
            img,
            center,
            core::Size::new(5, 2),
            10.0,
            0.0,
            360.0,
            core::Scalar::all(sky - contrast),
            -1,
            imgproc::LINE_AA,
            0,
        )
        .unwrap();
    }

    fn encode(img: &core::Mat) -> Vec<u8> {
        core::set_rng_seed(7).unwrap();
        let mut noise = core::Mat::new_rows_cols_with_default(
            img.rows(),
            img.cols(),
            core::CV_16SC3,
            core::Scalar::all(0.0),
        )
        .unwrap();
        core::randn(&mut noise, &core::Scalar::all(0.0), &core::Scalar::all(2.5)).unwrap();
        let mut wide = core::Mat::default();
        img.convert_to(&mut wide, core::CV_16SC3, 1.0, 0.0).unwrap();
        let mut noisy = core::Mat::default();
        core::add(&wide, &noise, &mut noisy, &core::no_array(), -1).unwrap();
        let mut out = core::Mat::default();
        noisy.convert_to(&mut out, core::CV_8UC3, 1.0, 0.0).unwrap();

        let mut buf = core::Vector::new();
        imgcodecs::imencode(".png", &out, &mut buf, &core::Vector::new()).unwrap();
        buf.to_vec()
    }

    /// Grid of `rows` x 10 birds in the left 3/4 of the image; every cell listed in
    /// `pairs` holds two touching birds. Returns the number of birds drawn.
    fn draw_flock(img: &mut core::Mat, rows: i32, contrast: f64, pairs: &[i32]) -> usize {
        let mut birds = 0;
        for row in 0..rows {
            for col in 0..10 {
                let x = 40.0 + col as f64 * 55.0;
                let y = 40.0 + row as f64 * 45.0;
                draw_bird(img, x, y, contrast);
                birds += 1;
                if pairs.contains(&(row * 10 + col)) {
                    draw_bird(img, x + 9.0, y + 1.0, contrast);
                    birds += 1;
                }
            }
        }
        birds
    }

    fn count(image: Vec<u8>, params: BlobParams, mask: Option<Vec<u8>>) -> usize {
        BlobFilter::new(params).apply(image, mask, None).unwrap().1
    }

    #[test]
    fn counts_separate_birds_on_cloudy_sky() {
        let mut img = sky(200.0);
        let expected = draw_flock(&mut img, 8, 90.0, &[]);
        assert_eq!(count(encode(&img), BlobParams::default(), None), expected);
    }

    /// Faint birds are ~15% darker than the sky; the detector's floor is `MIN_CONTRAST`
    /// (8%), measured after the default 3x3 blur.
    #[test]
    fn counts_faint_birds() {
        let mut img = sky(200.0);
        let expected = draw_flock(&mut img, 8, 30.0, &[]);
        assert_eq!(count(encode(&img), BlobParams::default(), None), expected);
    }

    /// Distant birds in a dense flock: one pixel thin V shapes with the bright sharpening
    /// halo phone cameras add. Neither the halos nor the birds themselves may raise the
    /// sky estimate or the texture enough to hide the flock.
    #[test]
    fn counts_dense_flock_of_thin_birds() {
        let mut img = sky(200.0);
        let mut expected = 0;
        for row in 0..6 {
            for col in 0..12 {
                let x = 60 + col * 20 + (row % 2) * 10;
                let y = 60 + row * 14;
                let sky = img.at_2d::<core::Vec3b>(y, x).unwrap()[0] as f64;
                let wings: core::Vector<core::Vector<core::Point>> =
                    core::Vector::from_iter([core::Vector::from_iter([
                        core::Point::new(x - 6, y - 3),
                        core::Point::new(x, y + 2),
                        core::Point::new(x + 6, y - 3),
                    ])]);
                for (thickness, color) in [(3, sky + 8.0), (1, sky - 70.0)] {
                    imgproc::polylines(
                        &mut img,
                        &wings,
                        false,
                        core::Scalar::all(color),
                        thickness,
                        imgproc::LINE_8,
                        0,
                    )
                    .unwrap();
                }
                expected += 1;
            }
        }
        assert_eq!(count(encode(&img), BlobParams::default(), None), expected);
    }

    #[test]
    fn splits_touching_birds() {
        let mut img = sky(200.0);
        let pairs = [3, 14, 22, 37, 41, 58, 66, 75];
        let expected = draw_flock(&mut img, 8, 90.0, &pairs);
        assert_eq!(count(encode(&img), BlobParams::default(), None), expected);

        let unsplit = BlobParams {
            split_clusters: false,
            ..BlobParams::default()
        };
        assert_eq!(count(encode(&img), unsplit, None), expected - pairs.len());
    }

    #[test]
    fn ignores_large_dark_clutter() {
        let mut img = sky(200.0);
        let expected = draw_flock(&mut img, 8, 90.0, &[]);
        imgproc::rectangle(
            &mut img,
            core::Rect::new(620, 280, 150, 150),
            core::Scalar::all(60.0),
            -1,
            imgproc::LINE_8,
            0,
        )
        .unwrap();
        assert_eq!(count(encode(&img), BlobParams::default(), None), expected);
    }

    #[test]
    fn respects_exclusion_mask() {
        let mut img = sky(200.0);
        draw_flock(&mut img, 8, 90.0, &[]);
        // Exclude the top half: rows 0..=4 (y <= 220) of the flock.
        let mut mask = core::Mat::new_rows_cols_with_default(
            HEIGHT,
            WIDTH,
            core::CV_8UC1,
            core::Scalar::all(0.0),
        )
        .unwrap();
        imgproc::rectangle(
            &mut mask,
            core::Rect::new(0, 0, WIDTH, 240),
            core::Scalar::all(255.0),
            -1,
            imgproc::LINE_8,
            0,
        )
        .unwrap();
        let mut mask_png = core::Vector::new();
        imgcodecs::imencode(".png", &mask, &mut mask_png, &core::Vector::new()).unwrap();
        assert_eq!(
            count(encode(&img), BlobParams::default(), Some(mask_png.to_vec())),
            30
        );
    }

    /// Only birds inside the crop are counted, and the full-image mask is cropped with it.
    #[test]
    fn counts_birds_in_crop() {
        let mut img = sky(200.0);
        draw_flock(&mut img, 8, 90.0, &[]);
        // Columns 0..=4 (x <= 260) of rows 2..=7 (y >= 130).
        let crop = Crop {
            x: 0,
            y: 110,
            width: 290,
            height: HEIGHT - 110,
        };
        let (annotated, birds) = BlobFilter::new(BlobParams::default())
            .apply(encode(&img), None, Some(crop))
            .unwrap();
        assert_eq!(birds, 30);
        let decoded = imgcodecs::imdecode(
            &core::Vector::<u8>::from_iter(annotated),
            imgcodecs::IMREAD_COLOR,
        )
        .unwrap();
        assert_eq!((decoded.cols(), decoded.rows()), (crop.width, crop.height));

        // Detections are reported in pixels of the whole image, inside the crop.
        let found = BlobFilter::new(BlobParams::default())
            .detect(&decode_gray(&encode(&img)).unwrap(), None, Some(crop))
            .unwrap();
        assert_eq!(found.iter().map(|bird| bird.count).sum::<u32>(), 30);
        assert!(found.iter().all(|bird| {
            bird.x >= crop.x as f64
                && bird.x < (crop.x + crop.width) as f64
                && bird.y >= crop.y as f64
                && bird.y < (crop.y + crop.height) as f64
        }));
        assert!(found.iter().any(|bird| bird.y >= 200.0));

        // Excluding rows 2..=4 (y <= 220) leaves rows 5..=7.
        let mut mask = core::Mat::new_rows_cols_with_default(
            HEIGHT,
            WIDTH,
            core::CV_8UC1,
            core::Scalar::all(0.0),
        )
        .unwrap();
        imgproc::rectangle(
            &mut mask,
            core::Rect::new(0, 0, WIDTH, 240),
            core::Scalar::all(255.0),
            -1,
            imgproc::LINE_8,
            0,
        )
        .unwrap();
        let mut mask_png = core::Vector::new();
        imgcodecs::imencode(".png", &mask, &mut mask_png, &core::Vector::new()).unwrap();
        let (_, birds) = BlobFilter::new(BlobParams::default())
            .apply(encode(&img), Some(mask_png.to_vec()), Some(crop))
            .unwrap();
        assert_eq!(birds, 15);
    }

    /// Fills the image below `horizon` with grass-like texture and grows a tree with
    /// ragged edges from the right border into the sky.
    fn draw_landscape(img: &mut core::Mat, horizon: i32) {
        core::set_rng_seed(11).unwrap();
        let rect = core::Rect::new(0, horizon, WIDTH, HEIGHT - horizon);
        let mut grass =
            core::Mat::new_size_with_default(rect.size(), core::CV_8UC3, core::Scalar::all(0.0))
                .unwrap();
        core::randu(
            &mut grass,
            &core::Scalar::all(30.0),
            &core::Scalar::all(150.0),
        )
        .unwrap();
        grass.copy_to(&mut img.roi_mut(rect).unwrap()).unwrap();
        for i in 0..40 {
            let center = core::Point::new(WIDTH - 60 - (i % 5) * 9, horizon - 10 - i * 4);
            let crown = core::Scalar::all(50.0);
            imgproc::circle(img, center, 14, crown, -1, imgproc::LINE_8, 0).unwrap();
            // Leaves sticking out of the crown.
            let leaf = center - core::Point::new(22, 3);
            imgproc::circle(img, leaf, 3, crown, -1, imgproc::LINE_8, 0).unwrap();
        }
    }

    #[test]
    fn ignores_landscape_below_the_sky() {
        let mut img = sky(200.0);
        let expected = draw_flock(&mut img, 5, 90.0, &[]);
        draw_landscape(&mut img, 320);
        assert_eq!(count(encode(&img), BlobParams::default(), None), expected);

        let everywhere = BlobParams {
            sky_only: false,
            ..BlobParams::default()
        };
        assert!(count(encode(&img), everywhere, None) > expected);
    }

    /// 80 birds below `TOP_BAND` rows, on the sky of `sky(base)`.
    const TOP_BAND: i32 = 60;

    fn draw_flock_below_band(img: &mut core::Mat) -> usize {
        for row in 0..8 {
            for col in 0..10 {
                draw_bird(
                    img,
                    40.0 + col as f64 * 55.0,
                    120.0 + row as f64 * 45.0,
                    90.0,
                );
            }
        }
        80
    }

    /// Texture with patches larger than a pixel of the copy the sky mask uses.
    fn rough_texture(rows: i32, cols: i32) -> core::Mat {
        core::set_rng_seed(13).unwrap();
        let mut noise =
            core::Mat::new_rows_cols_with_default(rows, cols, core::CV_32F, core::Scalar::all(0.0))
                .unwrap();
        core::randn(&mut noise, &core::Scalar::all(0.0), &core::Scalar::all(1.0)).unwrap();
        let mut blurred = core::Mat::default();
        imgproc::gaussian_blur(
            &noise,
            &mut blurred,
            core::Size::new(0, 0),
            3.0,
            3.0,
            core::BORDER_REPLICATE,
            core::AlgorithmHint::ALGO_HINT_DEFAULT,
        )
        .unwrap();
        // Blurring leaves a standard deviation of about 1 / (2 * sqrt(pi) * 3) = 0.094.
        let mut gray = core::Mat::default();
        blurred
            .convert_to(&mut gray, core::CV_8U, 45.0 / 0.094, 90.0)
            .unwrap();
        let mut bgr = core::Mat::default();
        imgproc::cvt_color(
            &gray,
            &mut bgr,
            imgproc::COLOR_GRAY2BGR,
            0,
            core::AlgorithmHint::ALGO_HINT_DEFAULT,
        )
        .unwrap();
        bgr
    }

    #[test]
    fn finds_the_sky_below_a_smooth_band_at_the_top() {
        let mut img = sky(200.0);
        let expected = draw_flock_below_band(&mut img);
        imgproc::rectangle(
            &mut img,
            core::Rect::new(0, 0, WIDTH, TOP_BAND),
            core::Scalar::all(70.0),
            -1,
            imgproc::LINE_8,
            0,
        )
        .unwrap();
        assert_eq!(count(encode(&img), BlobParams::default(), None), expected);
    }

    #[test]
    fn finds_the_sky_below_branches_at_the_top() {
        let mut img = sky(200.0);
        let expected = draw_flock_below_band(&mut img);
        rough_texture(TOP_BAND, WIDTH)
            .copy_to(&mut img.roi_mut(core::Rect::new(0, 0, WIDTH, TOP_BAND)).unwrap())
            .unwrap();
        assert_eq!(count(encode(&img), BlobParams::default(), None), expected);
    }

    /// Twigs with small gaps between their pieces, growing from the ground at `horizon`.
    fn draw_bush(img: &mut core::Mat, horizon: i32) {
        for stem in 0..9 {
            let x = 600 + stem * 20;
            let mut y = horizon;
            while y > horizon - 90 {
                imgproc::line(
                    img,
                    core::Point::new(x + y % 3, y),
                    core::Point::new(x + 3, y - 6),
                    core::Scalar::all(70.0),
                    1,
                    imgproc::LINE_8,
                    0,
                )
                .unwrap();
                y -= 11;
            }
        }
    }

    #[test]
    fn drops_twigs_linked_to_a_bush() {
        let mut img = sky(200.0);
        let expected = draw_flock(&mut img, 5, 90.0, &[]);
        let horizon = 400;
        rough_texture(HEIGHT - horizon, WIDTH)
            .copy_to(
                &mut img
                    .roi_mut(core::Rect::new(0, horizon, WIDTH, HEIGHT - horizon))
                    .unwrap(),
            )
            .unwrap();
        draw_bush(&mut img, horizon);
        assert_eq!(count(encode(&img), BlobParams::default(), None), expected);
    }

    /// Birds merged into one column from the ground at `horizon` up to `height`, then after a
    /// small gap more of them up to 150: the lower part stays within 8 local windows of the
    /// ground, and its links to the upper part reach farther.
    fn draw_column(img: &mut core::Mat, horizon: i32, height: i32) {
        let mut y = horizon - 2;
        while y > horizon - 150 {
            let up = horizon - y;
            if !(up > height && up < height + 6) {
                draw_bird(img, 700.0 + (y % 2) as f64, y as f64, 90.0);
            }
            y -= 4;
        }
    }

    #[test]
    fn keeps_a_flock_rising_from_the_ground_beyond_a_tree_top() {
        let mut img = sky(200.0);
        let expected = draw_flock(&mut img, 3, 90.0, &[]);
        let horizon = 400;
        rough_texture(HEIGHT - horizon, WIDTH)
            .copy_to(
                &mut img
                    .roi_mut(core::Rect::new(0, horizon, WIDTH, HEIGHT - horizon))
                    .unwrap(),
            )
            .unwrap();
        // 80 pixels is about 6 local windows: more than a tree top sticking out of the mask.
        draw_column(&mut img, horizon, 80);
        assert_eq!(
            count(encode(&img), BlobParams::default(), None),
            expected + 2
        );
    }

    #[test]
    fn ignores_water_below_the_land() {
        let mut img = sky(200.0);
        let expected = draw_flock(&mut img, 3, 90.0, &[]);
        // A headland from the left edge, with water below it and to its right.
        imgproc::rectangle(
            &mut img,
            core::Rect::new(0, 300, WIDTH, HEIGHT - 300),
            core::Scalar::all(175.0),
            -1,
            imgproc::LINE_8,
            0,
        )
        .unwrap();
        rough_texture(50, 560)
            .copy_to(&mut img.roi_mut(core::Rect::new(0, 250, 560, 50)).unwrap())
            .unwrap();
        for wave in 0..9 {
            imgproc::ellipse(
                &mut img,
                core::Point::new(60 + wave * 50, 380),
                core::Size::new(10, 2),
                0.0,
                0.0,
                360.0,
                core::Scalar::all(120.0),
                -1,
                imgproc::LINE_AA,
                0,
            )
            .unwrap();
        }
        assert_eq!(count(encode(&img), BlobParams::default(), None), expected);
    }

    /// When the top of the image is sky, a bigger and brighter lake below it stays out.
    #[test]
    fn keeps_a_bright_lake_out_when_the_top_is_sky() {
        let mut img = sky(120.0);
        for col in 0..10 {
            for row in 0..2 {
                draw_bird(
                    &mut img,
                    40.0 + col as f64 * 55.0,
                    30.0 + row as f64 * 40.0,
                    50.0,
                );
            }
        }
        let shore = 130;
        rough_texture(30, WIDTH)
            .copy_to(&mut img.roi_mut(core::Rect::new(0, shore, WIDTH, 30)).unwrap())
            .unwrap();
        let lake = core::Rect::new(0, shore + 30, WIDTH, HEIGHT - shore - 30);
        imgproc::rectangle(
            &mut img,
            lake,
            core::Scalar::all(180.0),
            -1,
            imgproc::LINE_8,
            0,
        )
        .unwrap();
        for boat in 0..10 {
            draw_bird(&mut img, 60.0 + boat as f64 * 70.0, 300.0, 80.0);
        }
        assert_eq!(count(encode(&img), BlobParams::default(), None), 20);
    }

    #[test]
    fn counts_bright_birds_when_inverted() {
        let mut img = sky(70.0);
        let expected = draw_flock(&mut img, 8, -90.0, &[]);
        let params = BlobParams {
            invert: true,
            ..BlobParams::default()
        };
        assert_eq!(count(encode(&img), params, None), expected);
    }

    /// A sky going from bright to dark, with birds 40% brighter than it. The contrast has to
    /// be relative to the real sky: on the flipped sky the dark side looks bright.
    #[test]
    fn inverted_contrast_is_relative_to_the_real_sky() {
        let mut img = core::Mat::new_rows_cols_with_default(
            HEIGHT,
            WIDTH,
            core::CV_8UC3,
            core::Scalar::all(170.0),
        )
        .unwrap();
        imgproc::rectangle(
            &mut img,
            core::Rect::new(WIDTH / 2, 0, WIDTH / 2, HEIGHT),
            core::Scalar::all(40.0),
            -1,
            imgproc::LINE_8,
            0,
        )
        .unwrap();
        let mut sky = core::Mat::default();
        imgproc::gaussian_blur(
            &img,
            &mut sky,
            core::Size::new(0, 0),
            40.0,
            40.0,
            core::BORDER_REPLICATE,
            core::AlgorithmHint::ALGO_HINT_DEFAULT,
        )
        .unwrap();
        let mut expected = 0;
        for row in 0..8 {
            for col in 0..13 {
                let (x, y) = (40 + col * 55, 40 + row * 55);
                let level = sky.at_2d::<core::Vec3b>(y, x).unwrap()[0] as f64;
                draw_bird(&mut sky, x as f64, y as f64, -0.4 * level);
                expected += 1;
            }
        }
        let params = BlobParams {
            invert: true,
            ..BlobParams::default()
        };
        // A few birds on the dark side are lost in the noise, which is large relative to it.
        let found = count(encode(&sky), params, None);
        assert!(found + 8 >= expected && found <= expected, "{}", found);
    }

    #[test]
    fn adaptive_method_still_works() {
        let mut img = sky(200.0);
        let expected = draw_flock(&mut img, 8, 90.0, &[]);
        let params = BlobParams {
            threshold_method: "adaptive".to_string(),
            min_radius: 2.0,
            ..BlobParams::default()
        };
        assert_eq!(count(encode(&img), params, None), expected);
    }

    #[test]
    fn window_follows_the_photo_size() {
        assert_eq!(scaled_window(31, 2000, 1623), 31);
        assert_eq!(scaled_window(31, 1623, 2000), 31);
        assert_eq!(scaled_window(31, 1000, 812), 17);
        assert_eq!(scaled_window(31, 4000, 3000), 63);
        assert_eq!(scaled_window(3, 100, 100), 3);
    }

    /// Radius of a circle as big as the birds in `large_photo_with_thick_birds`.
    const THICK_BIRD_RADIUS: f64 = 31.6;

    /// A 4000 px photo with birds 40 px thick. With a window of 31 px the middle of each
    /// bird would count as sky, and only its rim would be found.
    fn large_photo_with_thick_birds() -> core::Mat {
        let mut img = core::Mat::default();
        imgproc::resize(
            &sky(200.0),
            &mut img,
            core::Size::new(WIDTH * 5, HEIGHT * 5),
            0.0,
            0.0,
            imgproc::INTER_LINEAR,
        )
        .unwrap();
        for row in 0..3 {
            for col in 0..5 {
                imgproc::ellipse(
                    &mut img,
                    core::Point::new(400 + col * 700, 400 + row * 700),
                    core::Size::new(50, 20),
                    0.0,
                    0.0,
                    360.0,
                    core::Scalar::all(90.0),
                    -1,
                    imgproc::LINE_AA,
                    0,
                )
                .unwrap();
            }
        }
        decode_gray(&encode(&img)).unwrap()
    }

    #[test]
    fn window_grows_with_a_large_photo() {
        let found = BlobFilter::new(BlobParams::default())
            .detect(&large_photo_with_thick_birds(), None, None)
            .unwrap();
        assert_eq!(found.len(), 15);
        for bird in found {
            assert!(bird.radius > 0.9 * THICK_BIRD_RADIUS, "{:?}", bird);
            // Counted on a smaller copy, but the positions are in pixels of the photo.
            let col = ((bird.x - 400.0) / 700.0).round();
            let row = ((bird.y - 400.0) / 700.0).round();
            let offset = (bird.x - (400.0 + col * 700.0)).hypot(bird.y - (400.0 + row * 700.0));
            assert!(offset < 3.0, "{:?}", bird);
        }
    }

    /// Cropping does not change how big a bird is in pixels, so it keeps the window.
    #[test]
    fn crop_keeps_the_window_of_the_whole_photo() {
        let crop = Crop {
            x: 0,
            y: 0,
            width: 1500,
            height: 1500,
        };
        let found = BlobFilter::new(BlobParams::default())
            .detect(&large_photo_with_thick_birds(), None, Some(crop))
            .unwrap();
        assert_eq!(found.len(), 4);
        for bird in found {
            assert!(bird.radius > 0.9 * THICK_BIRD_RADIUS, "{:?}", bird);
        }
    }

    /// A photo so large that the window is too wide for the median filter.
    #[test]
    fn median_handles_a_very_wide_window() {
        let flat =
            core::Mat::new_rows_cols_with_default(600, 800, core::CV_8UC1, core::Scalar::all(40.0))
                .unwrap();
        let out = local_median(&flat, 375).unwrap();
        assert_eq!((out.cols(), out.rows()), (800, 600));
        assert_eq!(*out.at_2d::<u8>(300, 400).unwrap(), 40);
    }

    fn blob(x: f64, area: f64) -> Blob {
        Blob {
            center: core::Point2d::new(x, 0.0),
            area,
            count: 1,
            touches_border: false,
            bounds: core::Rect::new(x as i32, 0, 1, 1),
        }
    }

    #[test]
    fn split_merged_uses_local_bird_size() {
        // Two flocks at different distances: small birds near x=0, large near x=1000.
        let mut blobs: Vec<Blob> = (0..12).map(|i| blob(i as f64 * 10.0, 10.0)).collect();
        blobs.extend((0..12).map(|i| blob(1000.0 + i as f64 * 30.0, 60.0)));
        blobs.push(blob(55.0, 31.0)); // three small birds merged
        blobs.push(blob(1150.0, 125.0)); // two large birds merged
        blobs.push(blob(3000.0, 60.0)); // lone large bird far from small ones: not split

        let counts: Vec<u32> = split_merged(blobs).iter().map(|b| b.count).collect();
        assert_eq!(counts.len(), 27);
        assert_eq!(counts.iter().sum::<u32>(), 24 + 3 + 2 + 1);
    }

    #[test]
    fn split_merged_uses_single_birds_in_a_crowded_flock() {
        // A packed flock: single birds and clumps of four, 4 pixels apart.
        let crowded: Vec<Blob> = (0..12)
            .map(|i| Blob {
                center: core::Point2d::new((i % 4) as f64 * 4.0, (i / 4) as f64 * 4.0),
                ..blob(0.0, if i % 2 == 0 { 10.0 } else { 40.0 })
            })
            .collect();
        let total: u32 = split_merged(crowded).iter().map(|b| b.count).sum();
        assert_eq!(total, 6 + 6 * 4);
    }

    #[test]
    fn split_ignores_distant_small_specks() {
        // Two large birds with a few far-away specks: none of them is merged.
        let mut blobs = vec![blob(0.0, 80.0), blob(40.0, 90.0)];
        blobs.extend((0..6).map(|i| blob(500.0 + i as f64 * 8.0, 4.0)));
        let counts: Vec<u32> = split_merged(blobs).iter().map(|b| b.count).collect();
        assert!(counts.iter().all(|&c| c == 1), "{:?}", counts);
    }

    /// Near birds are far larger than a big flock of far ones, but they are a flock too.
    /// Only away from the image edge: there, large blobs are nearly always a tree or a roof.
    #[test]
    fn drop_clutter_keeps_a_near_flock() {
        let mut blobs: Vec<Blob> = (0..60).map(|i| blob(i as f64 * 40.0, 30.0)).collect();
        let near: Vec<Blob> = (0..8)
            .map(|i| blob(4000.0 + i as f64 * 100.0, 1300.0))
            .collect();
        blobs.extend(near.iter().cloned());
        let mut edge = blob(5500.0, 1300.0);
        edge.touches_border = true;
        blobs.push(edge);
        let mut lone_giant = blob(9000.0, 1300.0);
        lone_giant.center.y = 9000.0;
        blobs.push(lone_giant);

        let kept = drop_clutter(blobs);
        assert_eq!(kept.len(), 60 + near.len());
        assert!(kept.iter().all(|b| !b.touches_border && b.center.y == 0.0));
    }

    fn boxed(x: f64, area: f64, bounds: (i32, i32, i32, i32)) -> Blob {
        Blob {
            center: core::Point2d::new(x, 100.0),
            bounds: core::Rect::new(bounds.0, bounds.1, bounds.2, bounds.3),
            ..blob(x, area)
        }
    }

    #[test]
    fn absorb_fragments_merges_wing_tips() {
        let blobs = vec![
            boxed(100.0, 300.0, (90, 95, 20, 10)),  // a bird
            boxed(113.0, 6.0, (112, 99, 2, 2)),     // its wing tip
            boxed(200.0, 6.0, (199, 99, 2, 2)),     // a speck far away
            boxed(118.0, 200.0, (111, 95, 14, 10)), // a neighbour of similar size
        ];
        let kept: Vec<f64> = absorb_fragments(blobs).iter().map(|b| b.center.x).collect();
        assert_eq!(kept, vec![100.0, 200.0, 118.0]);
    }

    #[test]
    fn absorb_fragments_keeps_birds_next_to_a_clump() {
        // A clump of about 20 merged birds in a dense flock, and single birds around it. Two of
        // them are as close to the clump as a wing tip would be.
        let mut blobs = vec![boxed(100.0, 400.0, (88, 88, 25, 25))];
        for x in [120.0, 124.0, 130.0, 140.0, 150.0, 75.0] {
            blobs.push(boxed(x, 20.0, (x as i32 - 2, 98, 4, 5)));
        }
        assert_eq!(absorb_fragments(blobs).len(), 7);
    }

    fn filled(rows: i32, cols: i32, rects: &[(i32, i32, i32, i32)]) -> core::Mat {
        let mut mask =
            core::Mat::new_rows_cols_with_default(rows, cols, core::CV_8U, core::Scalar::all(0.0))
                .unwrap();
        for &(x, y, width, height) in rects {
            imgproc::rectangle(
                &mut mask,
                core::Rect::new(x, y, width, height),
                core::Scalar::all(255.0),
                -1,
                imgproc::LINE_8,
                0,
            )
            .unwrap();
        }
        mask
    }

    fn pixels(mask: &core::Mat, rect: (i32, i32, i32, i32)) -> i32 {
        let roi = core::Mat::roi(mask, core::Rect::new(rect.0, rect.1, rect.2, rect.3)).unwrap();
        core::count_non_zero(&roi).unwrap()
    }

    #[test]
    fn drop_touching_keeps_what_reaches_far_into_the_sky() {
        let ground = filled(100, 100, &[(0, 90, 100, 10)]);
        let near = grow(&ground, 15).unwrap();
        let far = grow(&ground, 40).unwrap();
        let candidates = filled(
            100,
            100,
            &[
                (20, 10, 4, 85), // a dense flock merged into one candidate, down to the ground
                (60, 70, 4, 25), // a bush
                (80, 20, 4, 4),  // a bird
            ],
        );
        let kept = drop_touching(&candidates, &ground, &near, &far).unwrap();
        assert_eq!(pixels(&kept, (20, 10, 4, 65)), 4 * 65);
        assert_eq!(pixels(&kept, (20, 75, 4, 25)), 0);
        assert_eq!(pixels(&kept, (60, 70, 4, 25)), 0);
        assert_eq!(pixels(&kept, (80, 20, 4, 4)), 16);
    }

    #[test]
    fn rough_island_near_the_edge_stays_sky() {
        // A dense flock low over smooth water looks rough, like the landscape, and lies close to
        // the bottom edge, but no land is near it.
        let mut img = sky(200.0);
        let (left, top, width, height) = (300, HEIGHT - 90, 200, 60);
        rough_texture(height, width)
            .copy_to(
                &mut img
                    .roi_mut(core::Rect::new(left, top, width, height))
                    .unwrap(),
            )
            .unwrap();
        let window = scaled_window(31, WIDTH, HEIGHT);
        let landscape = landscape_mask(&to_gray(&img).unwrap(), window, false).unwrap();
        if let Some((landscape, _)) = landscape {
            assert_eq!(pixels(&landscape, (left, top, width, height)), 0);
        }
    }

    #[test]
    fn drop_dots_keeps_birds_and_flocks_of_tiny_birds() {
        let birds: Vec<Blob> = (0..10).map(|_| boxed(0.0, 250.0, (0, 0, 30, 12))).collect();
        let dots: Vec<Blob> = (0..5).map(|_| boxed(0.0, 9.0, (0, 0, 3, 3))).collect();
        let thin_bird = boxed(0.0, 15.0, (0, 0, 10, 2));
        let mut all = birds.clone();
        all.extend(dots.iter().cloned());
        all.push(thin_bird);
        assert_eq!(drop_dots(all, 2048).len(), 11);
        // In a smaller photo the same dots are relatively larger.
        let mut all = birds.clone();
        all.extend(dots.iter().cloned());
        assert_eq!(drop_dots(all, 1024).len(), 15);
        let tiny_flock: Vec<Blob> = (0..12).map(|_| boxed(0.0, 10.0, (0, 0, 4, 3))).collect();
        assert_eq!(drop_dots(tiny_flock, 2048).len(), 12);
    }

    #[test]
    fn drop_clutter_removes_oversized_and_edge_blobs() {
        let mut blobs: Vec<Blob> = (0..10).map(|i| blob(i as f64 * 20.0, 20.0)).collect();
        blobs.push(blob(500.0, 10_000.0)); // huge dark area
        let mut edge = blob(900.0, 100.0); // roof or tree at the image edge
        edge.touches_border = true;
        blobs.push(edge);
        let mut edge_bird = blob(950.0, 22.0); // a bird cut by the edge stays
        edge_bird.touches_border = true;
        blobs.push(edge_bird);
        assert_eq!(drop_clutter(blobs).len(), 11);
    }
}
