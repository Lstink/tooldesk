use std::fs;
use std::io::Cursor;

use image::{load_from_memory, ImageFormat};
use printpdf::{
    image::RawImage, Mm, Op, PdfDocument, PdfPage, PdfSaveOptions, Pt, XObjectTransform,
};
use serde::Deserialize;

const DEFAULT_DPI: f32 = 72.0;
const MM_PER_INCH: f32 = 25.4;
const A4_WIDTH_MM: f32 = 210.0;
const A4_HEIGHT_MM: f32 = 297.0;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfImageInput {
    path: String,
    rotation_deg: i32,
}

#[tauri::command]
pub fn images_to_pdf(
    images: Vec<PdfImageInput>,
    output_path: String,
    force_a4: bool,
) -> Result<(), String> {
    if images.is_empty() {
        return Err("请先选择至少一张图片".to_string());
    }

    let mut document = PdfDocument::new("Images to PDF");
    let mut pages = Vec::with_capacity(images.len());

    for image in images {
        let image_path = image.path;
        let image_bytes =
            fs::read(&image_path).map_err(|err| format!("读取图片失败: {image_path} ({err})"))?;

        let rotated_bytes = rotate_image_bytes(&image_bytes, image.rotation_deg)
            .map_err(|err| format!("旋转图片失败: {image_path} ({err})"))?;

        let mut warnings = Vec::new();
        let mut raw_image = RawImage::decode_from_bytes(&rotated_bytes, &mut warnings)
            .map_err(|err| format!("解析图片失败: {image_path} ({err})"))?;

        if !raw_image.is_fully_opaque() {
            raw_image.remove_alpha_channel().ok();
        }

        let x_object_id = document.add_image(&raw_image);
        let image_width_mm = px_to_mm(raw_image.width as f32, DEFAULT_DPI);
        let image_height_mm = px_to_mm(raw_image.height as f32, DEFAULT_DPI);
        if image_width_mm <= 0.0 || image_height_mm <= 0.0 {
            return Err(format!("图片尺寸无效: {image_path}"));
        }

        let (page_width_mm, page_height_mm, scale, offset_x_mm, offset_y_mm) = if force_a4 {
            // A4 portrait + contain: keep full image visible and center it.
            let scale = (A4_WIDTH_MM / image_width_mm).min(A4_HEIGHT_MM / image_height_mm);
            let rendered_width_mm = image_width_mm * scale;
            let rendered_height_mm = image_height_mm * scale;
            let offset_x_mm = (A4_WIDTH_MM - rendered_width_mm) * 0.5;
            let offset_y_mm = (A4_HEIGHT_MM - rendered_height_mm) * 0.5;
            (A4_WIDTH_MM, A4_HEIGHT_MM, scale, offset_x_mm, offset_y_mm)
        } else {
            (image_width_mm, image_height_mm, 1.0, 0.0, 0.0)
        };

        let ops = vec![Op::UseXobject {
            id: x_object_id,
            transform: XObjectTransform {
                translate_x: Some(mm_to_pt(offset_x_mm)),
                translate_y: Some(mm_to_pt(offset_y_mm)),
                rotate: None,
                scale_x: Some(scale),
                scale_y: Some(scale),
                dpi: Some(DEFAULT_DPI),
            },
        }];

        pages.push(PdfPage::new(Mm(page_width_mm), Mm(page_height_mm), ops));
    }

    document.with_pages(pages);
    let mut warnings = Vec::new();
    let pdf_bytes = document.save(&PdfSaveOptions::default(), &mut warnings);

    fs::write(&output_path, pdf_bytes)
        .map_err(|err| format!("写入 PDF 失败: {output_path} ({err})"))?;

    Ok(())
}

fn px_to_mm(px: f32, dpi: f32) -> f32 {
    px * MM_PER_INCH / dpi
}

fn mm_to_pt(mm: f32) -> Pt {
    Pt(mm * 72.0 / MM_PER_INCH)
}

fn rotate_image_bytes(bytes: &[u8], rotation_deg: i32) -> Result<Vec<u8>, String> {
    let image = load_from_memory(bytes).map_err(|e| e.to_string())?;
    let normalized = ((rotation_deg % 360) + 360) % 360;
    let rotated = match normalized {
        0 => image,
        90 => image.rotate90(),
        180 => image.rotate180(),
        270 => image.rotate270(),
        _ => return Err("仅支持 0/90/180/270 度旋转".to_string()),
    };

    let mut cursor = Cursor::new(Vec::new());
    rotated
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}
