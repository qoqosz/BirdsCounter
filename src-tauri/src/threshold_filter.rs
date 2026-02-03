use opencv::prelude::*;
use opencv::{core, imgcodecs, imgproc};

/// A filter that applies binary thresholding to identify birds in an image.
pub struct ThresholdFilter {
    pub threshold: u8,
}

impl ThresholdFilter {
    pub fn new(threshold: u8) -> Self {
        ThresholdFilter { threshold }
    }

    /// Identify birds in the image by applying thresholding and finding contours.
    pub fn apply(&self, payload: Vec<u8>) -> Result<Vec<u8>, String> {
        let vec: core::Vector<u8> = core::Vector::from_iter(payload);
        let gray = imgcodecs::imdecode(&vec, imgcodecs::IMREAD_GRAYSCALE)
            .map_err(|e| format!("Failed to read image: {}", e))?;

        // Apply binary threshold
        let mut binary = core::Mat::default();
        imgproc::threshold(
            &gray,
            &mut binary,
            self.threshold as f64,
            255.0,
            imgproc::THRESH_BINARY,
        )
        .map_err(|e| format!("Threshold error: {}", e))?;

        // Convert to RGB (BGR in OpenCV)
        let mut rgb_image = core::Mat::default();
        imgproc::cvt_color_def(&binary, &mut rgb_image, imgproc::COLOR_GRAY2RGB)
            .map_err(|e| format!("Color conversion error: {}", e))?;

        // Convert back to grayscale for contour detection
        let mut gray2 = core::Mat::default();
        imgproc::cvt_color_def(&rgb_image, &mut gray2, imgproc::COLOR_RGB2GRAY)
            .map_err(|e| format!("Color conversion error: {}", e))?;

        // Apply threshold for contour detection (invert binary)
        let mut threshold_img = core::Mat::default();
        imgproc::threshold(
            &gray2,
            &mut threshold_img,
            127.0,
            255.0,
            imgproc::THRESH_BINARY_INV,
        )
        .map_err(|e| format!("Threshold error: {}", e))?;

        // Find contours
        let mut contours: core::Vector<core::Vector<core::Point>> = core::Vector::new();
        imgproc::find_contours(
            &threshold_img,
            &mut contours,
            imgproc::RETR_EXTERNAL,
            imgproc::CHAIN_APPROX_SIMPLE,
            core::Point::new(0, 0),
        )
        .map_err(|e| format!("Find contours error: {}", e))?;

        // Draw all contours on the RGB image (red color)
        imgproc::draw_contours(
            &mut rgb_image,
            &contours,
            -1,                                      // Draw all contours
            core::Scalar::new(0.0, 0.0, 255.0, 0.0), // Red in BGR
            2,
            imgproc::LINE_8,
            &core::no_array(), // No hierarchy
            i32::MAX,
            core::Point::new(0, 0),
        )
        .map_err(|e| format!("Draw contours error: {}", e))?;

        // Encode the image back to a byte vector
        let mut buf = core::Vector::new();
        let params = core::Vector::new(); // default params
        imgcodecs::imencode(".png", &rgb_image, &mut buf, &params)
            .map_err(|e| format!("OpenCV encode error: {}", e))?;

        Ok(buf.to_vec())
    }
}
