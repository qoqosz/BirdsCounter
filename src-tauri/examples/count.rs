//! Counts birds in image files with the app's detector, e.g. to tune parameters
//! on your own photos:
//!
//!     cargo run --release --example count -- [--method background|adaptive|otsu]
//!         [--sensitivity 6] [--window 31] [--min-radius 1] [--no-split]
//!         [--out annotated_dir] photo1.jpg photo2.jpg ...

use birdscounter_lib::blob_filter::{BlobFilter, BlobParams};
use std::path::PathBuf;

fn main() -> Result<(), String> {
    let mut params = BlobParams::default();
    let mut out_dir: Option<PathBuf> = None;
    let mut images = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or(format!("Missing value for {}", name));
        match arg.as_str() {
            "--method" => params.threshold_method = value(&arg)?,
            "--sensitivity" => params.sensitivity = parse(&value(&arg)?)?,
            "--window" => params.adaptive_block = parse(&value(&arg)?)?,
            "--min-radius" => params.min_radius = parse(&value(&arg)?)?,
            "--max-radius" => params.max_radius = parse(&value(&arg)?)?,
            "--blur" => params.blur = parse(&value(&arg)?)?,
            "--invert" => params.invert = true,
            "--no-split" => params.split_clusters = false,
            "--out" => out_dir = Some(PathBuf::from(value(&arg)?)),
            _ => images.push(PathBuf::from(arg)),
        }
    }
    if images.is_empty() {
        return Err("Usage: count [options] <image>...".to_string());
    }
    if let Some(dir) = &out_dir {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    for path in images {
        let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", path.display(), e))?;
        let (annotated, count) = BlobFilter::new(params.clone()).apply(bytes, None)?;
        println!("{}\t{}", path.display(), count);
        if let Some(dir) = &out_dir {
            let name = path.file_stem().unwrap_or_default().to_string_lossy();
            std::fs::write(dir.join(format!("{}_annotated.png", name)), annotated)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn parse<T: std::str::FromStr>(value: &str) -> Result<T, String> {
    value
        .parse()
        .map_err(|_| format!("Invalid number: {}", value))
}
