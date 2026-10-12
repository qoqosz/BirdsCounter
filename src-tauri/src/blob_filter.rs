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

fn crop_mat(mat: core::Mat, rect: Option<core::Rect>) -> Result<core::Mat, String> {
    match rect {
        Some(rect) if rect.width < mat.cols() || rect.height < mat.rows() => {
            core::Mat::roi(&mat, rect)
                .and_then(|roi| roi.try_clone())
                .map_err(|e| format!("Crop error: {}", e))
        }
        _ => Ok(mat),
    }
}

/// A detected blob; `count` is the estimated number of birds it contains.
#[derive(Clone, Debug)]
struct Blob {
    center: core::Point2d,
    area: f64,
    count: u32,
    touches_border: bool,
}

impl Blob {
    fn radius(&self) -> f64 {
        (self.area / std::f64::consts::PI).sqrt()
    }
}

/// Regions where birds are not looked for.
struct Masks<'a> {
    /// Painted by the user (255 = excluded); detections are cut along it.
    exclusion: Option<&'a core::Mat>,
    /// Everything but the sky (255). Detections touching it are trees, roofs or the
    /// horizon reaching into the sky, so they are dropped as a whole.
    landscape: Option<&'a core::Mat>,
}

impl Masks<'_> {
    fn apply(&self, binary: core::Mat) -> Result<core::Mat, String> {
        let mut out = binary;
        if let Some(landscape) = self.landscape {
            out = drop_touching(&out, landscape)?;
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

    /// Counts the birds in `payload`, or in its `crop` region. The exclusion mask covers
    /// the whole image, not just the crop. Returns the annotated (cropped) image as PNG.
    pub fn apply(
        &self,
        payload: Vec<u8>,
        mask_payload: Option<Vec<u8>>,
        crop: Option<Crop>,
    ) -> Result<(Vec<u8>, usize), String> {
        let params = &self.params;

        let vec: core::Vector<u8> = core::Vector::from_iter(payload);
        let full = imgcodecs::imdecode(&vec, imgcodecs::IMREAD_COLOR)
            .map_err(|e| format!("Failed to read image: {}", e))?;
        if full.empty() {
            return Err("Failed to decode image".to_string());
        }
        let (full_cols, full_rows) = (full.cols(), full.rows());
        let crop_rect = match crop {
            Some(crop) => Some(
                crop.rect_within(full_cols, full_rows)
                    .ok_or("Crop is outside the image")?,
            ),
            None => None,
        };
        let image = crop_mat(full, crop_rect)?;

        let mut gray = core::Mat::default();
        imgproc::cvt_color(
            &image,
            &mut gray,
            imgproc::COLOR_BGR2GRAY,
            0,
            core::AlgorithmHint::ALGO_HINT_DEFAULT,
        )
        .map_err(|e| format!("Color conversion error: {}", e))?;

        let exclusion_mask = match mask_payload {
            Some(mask_bytes) => Some(crop_mat(
                decode_mask(mask_bytes, full_cols, full_rows)?,
                crop_rect,
            )?),
            None => None,
        };
        let landscape = if params.sky_only {
            landscape_mask(&gray, odd_kernel(params.adaptive_block, 3), params.invert)?
        } else {
            None
        };
        let masks = Masks {
            exclusion: exclusion_mask.as_ref(),
            landscape: landscape.as_ref(),
        };

        let mut blobs = if params
            .threshold_method
            .trim()
            .eq_ignore_ascii_case("background")
        {
            self.detect_background(&gray, &masks)?
        } else {
            self.detect_threshold(&gray, &masks)?
        };

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

        let annotated = annotate(&image, &blobs)?;
        let mut buf = core::Vector::new();
        let encode_params = core::Vector::new();
        imgcodecs::imencode(".png", &annotated, &mut buf, &encode_params)
            .map_err(|e| format!("OpenCV encode error: {}", e))?;

        let count = blobs.iter().map(|blob| blob.count as usize).sum();
        Ok((buf.to_vec(), count))
    }

    /// Estimates the sky without birds and keeps blobs that are clearly darker than it.
    /// Contrast is relative to the sky brightness (birds are silhouettes against both
    /// bright and dark clouds), and the threshold rises with the local cloud texture.
    /// Birds are assumed darker than the sky unless `invert` is set.
    fn detect_background(&self, gray: &core::Mat, masks: &Masks) -> Result<Vec<Blob>, String> {
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
        let window = odd_kernel(params.adaptive_block, 3);
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
                let sky = sky as f32;
                let signed = (sky - value) / sky.max(1.0);
                *out = signed.clamp(0.0, 1.0);
                *dev = (signed.abs().min(deviation_cap) / deviation_cap * 255.0).round() as u8;
            }
        }

        let texture_window = odd_kernel(3 * window, 3);
        let mut texture = core::Mat::default();
        imgproc::median_blur(&deviation, &mut texture, texture_window)
            .map_err(|e| format!("Texture median error: {}", e))?;

        // Significance: contrast divided by the local threshold (> 1 means a detection).
        let sensitivity = params.sensitivity.max(0.0) as f32;
        let mut significance =
            core::Mat::new_rows_cols_with_default(rows, cols, core::CV_32F, core::Scalar::all(0.0))
                .map_err(|e| format!("Alloc error: {}", e))?;
        let mut candidates =
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
        }
        candidates = masks.apply(candidates)?;

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
        for (&label, &value) in label_data.iter().zip(significance_data) {
            let peak = &mut peaks[label as usize];
            *peak = peak.max(value);
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
            });
        }
        Ok(blobs)
    }

    /// Classic pipeline: global/adaptive threshold, morphology and external contours.
    fn detect_threshold(&self, gray: &core::Mat, masks: &Masks) -> Result<Vec<Blob>, String> {
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
            params.adaptive_block,
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
            });
        }
        Ok(blobs)
    }
}

/// Finds everything that is not sky (255). The sky is the smooth part of the image
/// connected to its top edge, plus rough islands far from the rest (dense flocks,
/// sharp cloud edges). Smoothness is the relative gradient of a downscaled copy from
/// which birds were removed by a closing (an opening for `bright_birds`) one window
/// wide. Returns `None` when there is (almost) no sky.
fn landscape_mask(
    gray: &core::Mat,
    window: i32,
    bright_birds: bool,
) -> Result<Option<core::Mat>, String> {
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

    // Candidate sky: smooth components reaching the top edge.
    let top_smooth = components_where(&smooth, 4, |_, top, _, _| top == 0)?;
    // Landscape: the rest of the image connected to its edges, together with rough
    // islands near it (leaves sticking out of a tree). Islands farther away are
    // dense flocks or sharp cloud edges and stay sky.
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
    let landscape_zone = components_where(&grown, 8, |left, top, width, height| {
        left == 0 || top == 0 || left + width >= cols || top + height >= rows
    })?;
    let mut landscape = core::Mat::default();
    core::bitwise_and(&not_sky, &landscape_zone, &mut landscape, &core::no_array())
        .map_err(|e| format!("Mask combine error: {}", e))?;

    let landscape_pixels =
        core::count_non_zero(&landscape).map_err(|e| format!("Sky count error: {}", e))? as f64;
    let total = (cols as f64) * (rows as f64);
    if total - landscape_pixels < SKY_MIN_FRACTION * total {
        return Ok(None);
    }

    let mut upscaled = core::Mat::default();
    let full_size = gray.size().map_err(|e| format!("Size error: {}", e))?;
    imgproc::resize(
        &landscape,
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
    Ok(Some(full))
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

/// Removes blobs much larger than a typical detection: anything touching the image
/// edge (trees, roofs, lamps) above `BORDER_CLUTTER_RATIO` and anything at all above
/// `MAX_CLUTTER_RATIO` median blobs.
fn drop_clutter(blobs: Vec<Blob>) -> Vec<Blob> {
    let mut areas: Vec<f64> = blobs.iter().map(|blob| blob.area).collect();
    let typical = median(&mut areas);
    if typical <= 0.0 {
        return blobs;
    }
    blobs
        .into_iter()
        .filter(|blob| {
            let ratio = blob.area / typical;
            ratio <= MAX_CLUTTER_RATIO && !(blob.touches_border && ratio > BORDER_CLUTTER_RATIO)
        })
        .collect()
}

/// Estimates how many birds each blob holds by comparing its area with the median
/// area of nearby detections from the same flock. A detection counts as nearby when
/// it lies within `SPLIT_NEIGHBOUR_DISTANCE` of *its own* sizes, so small noise specks
/// or a distant flock of smaller birds do not make a single large bird look merged.
fn split_merged(mut blobs: Vec<Blob>) -> Vec<Blob> {
    if blobs.len() > SPLIT_MAX_DETECTIONS {
        return blobs;
    }
    let counts: Vec<u32> = blobs
        .iter()
        .map(|blob| {
            let mut neighbours: Vec<(f64, f64)> = blobs
                .iter()
                .filter_map(|other| {
                    let distance =
                        (other.center.x - blob.center.x).hypot(other.center.y - blob.center.y);
                    (distance <= SPLIT_NEIGHBOUR_DISTANCE * other.area.sqrt())
                        .then_some((distance, other.area))
                })
                .collect();
            if neighbours.len() < SPLIT_MIN_NEIGHBOURS {
                return 1;
            }
            neighbours.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
            let mut areas: Vec<f64> = neighbours
                .iter()
                .take(SPLIT_NEIGHBOURS)
                .map(|(_, area)| *area)
                .collect();
            let reference = median(&mut areas);
            if reference <= 0.0 {
                return 1;
            }
            (blob.area / reference).round().max(1.0) as u32
        })
        .collect();
    for (blob, count) in blobs.iter_mut().zip(counts) {
        blob.count = count;
    }
    blobs
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

fn decode_mask(mask_bytes: Vec<u8>, width: i32, height: i32) -> Result<core::Mat, String> {
    let vec: core::Vector<u8> = core::Vector::from_iter(mask_bytes);
    let decoded = imgcodecs::imdecode(&vec, imgcodecs::IMREAD_GRAYSCALE)
        .map_err(|e| format!("Mask decode error: {}", e))?;
    if decoded.empty() {
        return Err("Mask decode failed".to_string());
    }

    let mut resized = core::Mat::default();
    if decoded.cols() != width || decoded.rows() != height {
        imgproc::resize(
            &decoded,
            &mut resized,
            core::Size::new(width, height),
            0.0,
            0.0,
            imgproc::INTER_NEAREST,
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
fn drop_touching(binary: &core::Mat, forbidden: &core::Mat) -> Result<core::Mat, String> {
    let mut labels = core::Mat::default();
    let label_count = imgproc::connected_components(binary, &mut labels, 8, core::CV_32S)
        .map_err(|e| format!("Connected components error: {}", e))? as usize;
    let label_data = labels
        .data_typed::<i32>()
        .map_err(|e| format!("Label access error: {}", e))?;
    let forbidden_data = forbidden
        .data_bytes()
        .map_err(|e| format!("Mask access error: {}", e))?;
    let mut touching = vec![false; label_count];
    for (&label, &excluded) in label_data.iter().zip(forbidden_data) {
        if excluded > 0 {
            touching[label as usize] = true;
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
    for (value, &label) in out_data.iter_mut().zip(label_data) {
        if label > 0 && !touching[label as usize] {
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

    fn blob(x: f64, area: f64) -> Blob {
        Blob {
            center: core::Point2d::new(x, 0.0),
            area,
            count: 1,
            touches_border: false,
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
    fn split_ignores_distant_small_specks() {
        // Two large birds with a few far-away specks: none of them is merged.
        let mut blobs = vec![blob(0.0, 80.0), blob(40.0, 90.0)];
        blobs.extend((0..6).map(|i| blob(500.0 + i as f64 * 8.0, 4.0)));
        let counts: Vec<u32> = split_merged(blobs).iter().map(|b| b.count).collect();
        assert!(counts.iter().all(|&c| c == 1), "{:?}", counts);
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
