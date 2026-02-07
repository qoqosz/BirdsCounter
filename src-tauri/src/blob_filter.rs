use opencv::prelude::*;
use opencv::{core, imgcodecs, imgproc};

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
}

impl Default for BlobParams {
    fn default() -> Self {
        Self {
            min_radius: 2.0,
            max_radius: 100.0,
            blur: 3,
            threshold_method: "adaptive".to_string(),
            adaptive_block: 31,
            adaptive_c: 4.0,
            morph_kernel: 3,
            morph_open_iter: 1,
            morph_close_iter: 1,
            auto_invert: true,
            invert: false,
        }
    }
}

/// Detects blobs by thresholding, morphological cleanup, and contour filtering.
pub struct BlobFilter {
    params: BlobParams,
}

impl BlobFilter {
    pub fn new(params: BlobParams) -> Self {
        Self { params }
    }

    pub fn apply(&self, payload: Vec<u8>) -> Result<(Vec<u8>, usize), String> {
        let params = &self.params;

        let vec: core::Vector<u8> = core::Vector::from_iter(payload);
        let image = imgcodecs::imdecode(&vec, imgcodecs::IMREAD_COLOR)
            .map_err(|e| format!("Failed to read image: {}", e))?;
        if image.empty() {
            return Err("Failed to decode image".to_string());
        }

        let mut gray = core::Mat::default();
        imgproc::cvt_color(
            &image,
            &mut gray,
            imgproc::COLOR_BGR2GRAY,
            0,
            core::AlgorithmHint::ALGO_HINT_DEFAULT,
        )
        .map_err(|e| format!("Color conversion error: {}", e))?;

        let blur_k = odd_kernel(params.blur, 1);
        let mut blurred = core::Mat::default();
        imgproc::gaussian_blur(
            &gray,
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

        let mut contours: core::Vector<core::Vector<core::Point>> = core::Vector::new();
        imgproc::find_contours(
            &cleaned,
            &mut contours,
            imgproc::RETR_EXTERNAL,
            imgproc::CHAIN_APPROX_SIMPLE,
            core::Point::new(0, 0),
        )
        .map_err(|e| format!("Find contours error: {}", e))?;

        let min_radius = params.min_radius.max(0.0);
        let max_radius = params.max_radius.max(min_radius);

        let mut annotated = image
            .try_clone()
            .map_err(|e| format!("Image clone error: {}", e))?;
        let mut kept = 0usize;

        for contour in contours.iter() {
            let area = imgproc::contour_area(&contour, false)
                .map_err(|e| format!("Contour area error: {}", e))?;
            if area <= 0.0 {
                continue;
            }
            let radius = (area / std::f64::consts::PI).sqrt();
            if radius < min_radius || radius > max_radius {
                continue;
            }
            let center = contour_center(&contour)?;
            let Some(center) = center else {
                continue;
            };
            kept += 1;
            imgproc::circle(
                &mut annotated,
                center,
                radius.round().max(1.0) as i32,
                core::Scalar::new(0.0, 0.0, 255.0, 0.0),
                2,
                imgproc::LINE_8,
                0,
            )
            .map_err(|e| format!("Draw circle error: {}", e))?;
        }

        let mut buf = core::Vector::new();
        let encode_params = core::Vector::new();
        imgcodecs::imencode(".png", &annotated, &mut buf, &encode_params)
            .map_err(|e| format!("OpenCV encode error: {}", e))?;

        Ok((buf.to_vec(), kept))
    }
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

fn contour_center(contour: &core::Vector<core::Point>) -> Result<Option<core::Point>, String> {
    let moments = imgproc::moments(contour, false).map_err(|e| format!("Moments error: {}", e))?;
    if moments.m00 == 0.0 {
        return Ok(None);
    }
    let cx = (moments.m10 / moments.m00).round() as i32;
    let cy = (moments.m01 / moments.m00).round() as i32;
    Ok(Some(core::Point::new(cx, cy)))
}
