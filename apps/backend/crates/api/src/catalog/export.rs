//! GET /v1/exports/price-list (printable PDF / PNG).
use crate::{ApiError, AppState, auth::Actor};
use ab_glyph::{Font, FontRef, Glyph, ScaleFont, point};
use axum::{
    Router,
    body::Body,
    extract::{Query, State},
    http::{StatusCode, header},
    response::Response,
    routing::get,
};
use image::{ExtendedColorType, ImageEncoder, Rgba, RgbaImage, codecs::png::PngEncoder};
use printpdf::{
    Color, FontId, Mm, Op, ParsedFont, PdfDocument, PdfFontHandle, PdfPage, PdfSaveOptions, Point,
    Pt, Rgb, TextItem,
};
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

const FONT_BYTES: &[u8] = include_bytes!("../../assets/NotoSans-Regular.ttf");

const PAGE_WIDTH_MM: f32 = 210.0;
const PAGE_HEIGHT_MM: f32 = 297.0;
const MARGIN_MM: f32 = 15.0;
const TITLE_Y_MM: f32 = 20.0;
const HEADING_Y_MM: f32 = 31.0;
const HEADER_Y_MM: f32 = 42.0;
const FIRST_ROW_Y_MM: f32 = 50.0;
const LINE_HEIGHT_MM: f32 = 6.5;
const UNIT_COLUMN_MM: f32 = 112.0;
const PRICE_RIGHT_MM: f32 = 195.0;
const INDENT_MM: f32 = 6.0;
const TITLE_PT: f32 = 20.0;
const HEADING_PT: f32 = 13.0;
const BODY_PT: f32 = 10.0;
const SMALL_PT: f32 = 9.0;
const FOOTER_PT: f32 = 8.0;
const LINES_PER_PAGE: usize = 34;
const PNG_DPI: f32 = 150.0;
const PX_PER_MM: f32 = PNG_DPI / 25.4;
const PX_PER_PT: f32 = PNG_DPI / 72.0;
const BLACK: [u8; 3] = [0, 0, 0];
const GREY: [u8; 3] = [102, 102, 102];

pub fn routes() -> Router<AppState> {
    Router::new().route("/v1/exports/price-list", get(price_list))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitPrice {
    pub name: String,
    pub quantity_in_base: i32,
    pub price: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriceRow {
    pub name: String,
    pub base_unit: String,
    pub price: i64,
    pub units: Vec<UnitPrice>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriceList {
    pub store_name: String,
    pub rows: Vec<PriceRow>,
}

#[derive(Debug, Deserialize)]
struct ProductJson {
    name: Option<String>,
    base_unit: String,
    price: i64,
    units: Vec<UnitJson>,
}

#[derive(Debug, Deserialize)]
struct UnitJson {
    name: String,
    quantity_in_base: i32,
    price: i64,
}

#[derive(Debug, Deserialize)]
struct ExportQuery {
    format: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Pdf,
    Png,
}

impl Format {
    fn parse(query: &ExportQuery) -> Result<Self, ApiError> {
        match query.format.as_deref().unwrap_or("pdf") {
            "pdf" => Ok(Self::Pdf),
            "png" => Ok(Self::Png),
            _ => Err(ApiError::validation_failed(
                "format must be one of: pdf, png",
            )),
        }
    }
}

/// Load the printable price list with a single SQL query.
pub async fn load_price_list(pool: &PgPool, store_id: Uuid) -> Result<PriceList, ApiError> {
    let row: Option<(String, sqlx::types::Json<Vec<ProductJson>>)> = sqlx::query_as(
        "SELECT s.name,
                COALESCE(jsonb_agg(jsonb_build_object(
                    'name', p.name,
                    'base_unit', p.base_unit,
                    'price', p.price,
                    'units', (
                        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                   'name', u.name,
                                   'quantity_in_base', u.quantity_in_base,
                                   'price', u.price
                               ) ORDER BY u.quantity_in_base, lower(u.name)), '[]'::jsonb)
                        FROM product_units u
                        WHERE u.product_id = p.id
                    )
                ) ORDER BY lower(p.name), p.id) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb)
         FROM stores s
         LEFT JOIN products p ON p.store_id = s.id AND NOT p.archived
         WHERE s.id = $1
         GROUP BY s.id, s.name",
    )
    .bind(store_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| {
        crate::error::log_sqlx_error!(error, &error, "price list query failed");
        ApiError::internal()
    })?;
    let (store_name, sqlx::types::Json(products)) = row.unwrap_or_default();
    Ok(PriceList {
        store_name,
        rows: products
            .into_iter()
            .map(|product| PriceRow {
                name: product.name.unwrap_or_default(),
                base_unit: product.base_unit,
                price: product.price,
                units: product
                    .units
                    .into_iter()
                    .map(|unit| UnitPrice {
                        name: unit.name,
                        quantity_in_base: unit.quantity_in_base,
                        price: unit.price,
                    })
                    .collect(),
            })
            .collect(),
    })
}

/// Group product rows into pages, accounting for the extra lines of alternate units.
pub fn paginate(rows: &[PriceRow], lines_per_page: usize) -> Vec<Vec<PriceRow>> {
    let lines_per_page = lines_per_page.max(1);
    let mut pages = Vec::new();
    let mut current = Vec::new();
    let mut used_lines = 0;
    for row in rows {
        let row_lines = 1 + row.units.len();
        if !current.is_empty() && used_lines + row_lines > lines_per_page {
            pages.push(std::mem::take(&mut current));
            used_lines = 0;
        }
        used_lines += row_lines;
        current.push(row.clone());
    }
    if !current.is_empty() {
        pages.push(current);
    }
    pages
}

/// Vietnamese đồng amount with dot thousands separators, e.g. `10.000đ`.
pub fn format_money(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push('.');
        }
        grouped.push(digit);
    }
    if value < 0 {
        grouped.insert(0, '-');
    }
    grouped.push('đ');
    grouped
}

fn text_width<F: Font>(font: &F, text: &str, size: f32) -> f32 {
    let scaled = font.as_scaled(size);
    text.chars()
        .map(|ch| scaled.h_advance(scaled.glyph_id(ch)))
        .sum()
}

fn fit_text<F: Font>(font: &F, text: &str, size: f32, max_width: f32) -> String {
    if text_width(font, text, size) <= max_width {
        return text.to_owned();
    }
    let ellipsis = '…';
    let budget = max_width - text_width(font, "…", size);
    let scaled = font.as_scaled(size);
    let mut fitted = String::new();
    let mut width = 0.0;
    for ch in text.chars() {
        let advance = scaled.h_advance(scaled.glyph_id(ch));
        if width + advance > budget {
            break;
        }
        width += advance;
        fitted.push(ch);
    }
    fitted.push(ellipsis);
    fitted
}

fn unit_line(row: &PriceRow, unit: &UnitPrice) -> String {
    format!(
        "{} ({} {})",
        unit.name, unit.quantity_in_base, row.base_unit
    )
}

fn pdf_text(font: &FontId, text: &str, x_mm: f32, y_mm: f32, size: f32, grey: f32) -> Vec<Op> {
    let shade = Rgb::new(grey, grey, grey, None);
    vec![
        Op::StartTextSection,
        Op::SetFillColor {
            col: Color::Rgb(shade),
        },
        Op::SetFont {
            font: PdfFontHandle::External(font.clone()),
            size: Pt(size),
        },
        Op::SetTextCursor {
            pos: Point::new(Mm(x_mm), Mm(PAGE_HEIGHT_MM - y_mm)),
        },
        Op::ShowText {
            items: vec![TextItem::Text(text.to_owned())],
        },
        Op::EndTextSection,
    ]
}

fn pdf_header(font: &FontId, measure: &FontRef<'_>, title: &str, heading: &str) -> Vec<Op> {
    let mut ops = pdf_text(font, title, MARGIN_MM, TITLE_Y_MM, TITLE_PT, 0.0);
    ops.extend(pdf_text(
        font,
        heading,
        MARGIN_MM,
        HEADING_Y_MM,
        HEADING_PT,
        0.25,
    ));
    ops.extend(pdf_text(
        font,
        "Sản phẩm",
        MARGIN_MM,
        HEADER_Y_MM,
        SMALL_PT,
        0.35,
    ));
    ops.extend(pdf_text(
        font,
        "Đơn vị",
        UNIT_COLUMN_MM,
        HEADER_Y_MM,
        SMALL_PT,
        0.35,
    ));
    ops.extend(pdf_text(
        font,
        "Giá",
        PRICE_RIGHT_MM - text_width(measure, "Giá", SMALL_PT),
        HEADER_Y_MM,
        SMALL_PT,
        0.35,
    ));
    ops
}

fn pdf_font_ref() -> FontRef<'static> {
    FontRef::try_from_slice(FONT_BYTES).expect("bundled font is valid")
}

fn pdf_page(
    font: &FontId,
    title: &str,
    heading: &str,
    rows: &[PriceRow],
    page: usize,
    total_pages: usize,
) -> PdfPage {
    let measure = pdf_font_ref();
    let mut ops = pdf_header(font, &measure, title, heading);
    if rows.is_empty() {
        ops.extend(pdf_text(
            font,
            "Chưa có sản phẩm nào.",
            MARGIN_MM,
            FIRST_ROW_Y_MM,
            BODY_PT,
            0.35,
        ));
    }
    let mut y = FIRST_ROW_Y_MM;
    for row in rows {
        let name = fit_text(
            &measure,
            &row.name,
            BODY_PT,
            UNIT_COLUMN_MM - MARGIN_MM - 2.0,
        );
        ops.extend(pdf_text(font, &name, MARGIN_MM, y, BODY_PT, 0.0));
        let unit = fit_text(&measure, &row.base_unit, BODY_PT, 30.0);
        ops.extend(pdf_text(font, &unit, UNIT_COLUMN_MM, y, BODY_PT, 0.0));
        let price = format_money(row.price);
        let price_x = PRICE_RIGHT_MM - text_width(&measure, &price, BODY_PT);
        ops.extend(pdf_text(font, &price, price_x, y, BODY_PT, 0.0));
        y += LINE_HEIGHT_MM;
        for unit in &row.units {
            let label = fit_text(
                &measure,
                &unit_line(row, unit),
                SMALL_PT,
                UNIT_COLUMN_MM - MARGIN_MM - INDENT_MM - 2.0,
            );
            ops.extend(pdf_text(
                font,
                &label,
                MARGIN_MM + INDENT_MM,
                y,
                SMALL_PT,
                0.35,
            ));
            let price = format_money(unit.price);
            let price_x = PRICE_RIGHT_MM - text_width(&measure, &price, SMALL_PT);
            ops.extend(pdf_text(font, &price, price_x, y, SMALL_PT, 0.35));
            y += LINE_HEIGHT_MM;
        }
    }
    let footer = format!("Trang {} / {}", page + 1, total_pages);
    ops.extend(pdf_text(
        font,
        &footer,
        PRICE_RIGHT_MM - text_width(&measure, &footer, FOOTER_PT),
        PAGE_HEIGHT_MM - 8.0,
        FOOTER_PT,
        0.5,
    ));
    PdfPage::new(Mm(PAGE_WIDTH_MM), Mm(PAGE_HEIGHT_MM), ops)
}

/// Render the whole printable list as an A4 portrait PDF.
pub fn render_pdf(list: &PriceList) -> Vec<u8> {
    let mut document = PdfDocument::new("price-list");
    let mut parse_warnings = Vec::new();
    let parsed = ParsedFont::from_bytes(FONT_BYTES, 0, &mut parse_warnings)
        .expect("bundled font can be parsed");
    let font = document.add_font(&parsed);
    let title = if list.store_name.is_empty() {
        "Bảng giá".to_owned()
    } else {
        list.store_name.clone()
    };
    let pages = paginate(&list.rows, LINES_PER_PAGE);
    let total_pages = pages.len().max(1);
    let page_ops: Vec<PdfPage> = if pages.is_empty() {
        vec![pdf_page(&font, &title, "Bảng giá", &[], 0, total_pages)]
    } else {
        pages
            .iter()
            .enumerate()
            .map(|(index, rows)| pdf_page(&font, &title, "Bảng giá", rows, index, total_pages))
            .collect()
    };
    document.with_pages(page_ops);
    let mut save_warnings = Vec::new();
    document.save(&PdfSaveOptions::default(), &mut save_warnings)
}

fn blend(image: &mut RgbaImage, x: i32, y: i32, coverage: f32, color: [u8; 3]) {
    if x < 0 || y < 0 || x as u32 >= image.width() || y as u32 >= image.height() {
        return;
    }
    let pixel = image.get_pixel_mut(x as u32, y as u32);
    for (channel, value) in color.iter().enumerate() {
        let under = pixel[channel] as f32;
        pixel[channel] = (*value as f32 * coverage + under * (1.0 - coverage)) as u8;
    }
}

fn png_text(
    image: &mut RgbaImage,
    font: &FontRef<'_>,
    text: &str,
    x_mm: f32,
    y_mm: f32,
    size_pt: f32,
    color: [u8; 3],
) {
    let size_px = size_pt * PX_PER_PT;
    let scaled = font.as_scaled(size_px);
    let mut caret = x_mm * PX_PER_MM;
    let baseline = y_mm * PX_PER_MM;
    for ch in text.chars() {
        let id = scaled.glyph_id(ch);
        let glyph = Glyph {
            id,
            scale: scaled.scale(),
            position: point(caret, baseline),
        };
        if let Some(outlined) = font.outline_glyph(glyph) {
            let bounds = outlined.px_bounds();
            outlined.draw(|gx, gy, coverage| {
                blend(
                    image,
                    bounds.min.x as i32 + gx as i32,
                    bounds.min.y as i32 + gy as i32,
                    coverage,
                    color,
                );
            });
        }
        caret += scaled.h_advance(id);
    }
}

fn png_text_width(font: &FontRef<'_>, text: &str, size_pt: f32) -> f32 {
    let scaled = font.as_scaled(size_pt * PX_PER_PT);
    text.chars()
        .map(|ch| scaled.h_advance(scaled.glyph_id(ch)))
        .sum::<f32>()
        / PX_PER_MM
}

/// Render the first page of the list as a single PNG image.
pub fn render_png(list: &PriceList) -> Vec<u8> {
    let mut image = RgbaImage::from_pixel(
        (PAGE_WIDTH_MM * PX_PER_MM).round() as u32,
        (PAGE_HEIGHT_MM * PX_PER_MM).round() as u32,
        Rgba([255, 255, 255, 255]),
    );
    let font = pdf_font_ref();
    let pages = paginate(&list.rows, LINES_PER_PAGE);
    let rows = pages.first().map(Vec::as_slice).unwrap_or(&[]);
    let title = fit_text(
        &font,
        if list.store_name.is_empty() {
            "Bảng giá"
        } else {
            &list.store_name
        },
        TITLE_PT,
        PAGE_WIDTH_MM - 2.0 * MARGIN_MM,
    );
    png_text(
        &mut image, &font, &title, MARGIN_MM, TITLE_Y_MM, TITLE_PT, BLACK,
    );
    png_text(
        &mut image,
        &font,
        "Bảng giá",
        MARGIN_MM,
        HEADING_Y_MM,
        HEADING_PT,
        GREY,
    );
    png_text(
        &mut image,
        &font,
        "Sản phẩm",
        MARGIN_MM,
        HEADER_Y_MM,
        SMALL_PT,
        GREY,
    );
    png_text(
        &mut image,
        &font,
        "Đơn vị",
        UNIT_COLUMN_MM,
        HEADER_Y_MM,
        SMALL_PT,
        GREY,
    );
    let price_header_x = PRICE_RIGHT_MM - png_text_width(&font, "Giá", SMALL_PT);
    png_text(
        &mut image,
        &font,
        "Giá",
        price_header_x,
        HEADER_Y_MM,
        SMALL_PT,
        GREY,
    );
    if rows.is_empty() {
        png_text(
            &mut image,
            &font,
            "Chưa có sản phẩm nào.",
            MARGIN_MM,
            FIRST_ROW_Y_MM,
            BODY_PT,
            GREY,
        );
    }
    let mut y = FIRST_ROW_Y_MM;
    for row in rows {
        let name = fit_text(
            &font,
            &row.name,
            BODY_PT * PX_PER_PT,
            (UNIT_COLUMN_MM - MARGIN_MM - 2.0) * PX_PER_MM,
        );
        png_text(&mut image, &font, &name, MARGIN_MM, y, BODY_PT, BLACK);
        let unit = fit_text(&font, &row.base_unit, BODY_PT * PX_PER_PT, 30.0 * PX_PER_MM);
        png_text(&mut image, &font, &unit, UNIT_COLUMN_MM, y, BODY_PT, BLACK);
        let price = format_money(row.price);
        let price_x = PRICE_RIGHT_MM - png_text_width(&font, &price, BODY_PT);
        png_text(&mut image, &font, &price, price_x, y, BODY_PT, BLACK);
        y += LINE_HEIGHT_MM;
        for unit in &row.units {
            let label = fit_text(
                &font,
                &unit_line(row, unit),
                SMALL_PT * PX_PER_PT,
                (UNIT_COLUMN_MM - MARGIN_MM - INDENT_MM - 2.0) * PX_PER_MM,
            );
            png_text(
                &mut image,
                &font,
                &label,
                MARGIN_MM + INDENT_MM,
                y,
                SMALL_PT,
                GREY,
            );
            let price = format_money(unit.price);
            let price_x = PRICE_RIGHT_MM - png_text_width(&font, &price, SMALL_PT);
            png_text(&mut image, &font, &price, price_x, y, SMALL_PT, GREY);
            y += LINE_HEIGHT_MM;
        }
    }
    let footer = format!("Trang 1 / {}", pages.len().max(1));
    let footer_x = PRICE_RIGHT_MM - png_text_width(&font, &footer, FOOTER_PT);
    png_text(
        &mut image,
        &font,
        &footer,
        footer_x,
        PAGE_HEIGHT_MM - 8.0,
        FOOTER_PT,
        GREY,
    );
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .expect("PNG encoding cannot fail for an in-memory buffer");
    bytes
}

fn file_response(content_type: &'static str, filename: &str, bytes: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("inline; filename=\"{filename}\""),
        )
        .body(Body::from(bytes))
        .expect("static response headers are valid")
}

async fn price_list(
    State(state): State<AppState>,
    actor: Actor,
    Query(query): Query<ExportQuery>,
) -> Result<Response, ApiError> {
    actor.require(crate::auth::permissions::Action::Exports)?;
    let format = Format::parse(&query)?;
    let pool = state.postgres.as_ref().ok_or_else(ApiError::unavailable)?;
    let list = load_price_list(pool, actor.store_id).await?;
    let (content_type, filename, bytes) = tokio::task::spawn_blocking(move || match format {
        Format::Pdf => ("application/pdf", "price-list.pdf", render_pdf(&list)),
        Format::Png => ("image/png", "price-list.png", render_png(&list)),
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "price list rendering task failed");
        ApiError::internal()
    })?;
    Ok(file_response(content_type, filename, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, units: usize) -> PriceRow {
        PriceRow {
            name: name.to_owned(),
            base_unit: "cái".to_owned(),
            price: 10_000,
            units: (0..units)
                .map(|index| UnitPrice {
                    name: format!("đơn vị {index}"),
                    quantity_in_base: 10,
                    price: 90_000,
                })
                .collect(),
        }
    }

    fn list(rows: Vec<PriceRow>) -> PriceList {
        PriceList {
            store_name: "Tạp hóa Cô Ba".to_owned(),
            rows,
        }
    }

    #[test]
    fn money_uses_dot_thousands_and_dong_suffix() {
        for (value, expected) in [
            (0, "0đ"),
            (5, "5đ"),
            (999, "999đ"),
            (1_000, "1.000đ"),
            (10_000, "10.000đ"),
            (123_456_789, "123.456.789đ"),
        ] {
            assert_eq!(format_money(value), expected);
        }
    }

    #[test]
    fn pagination_chunks_rows_and_counts_unit_lines() {
        let rows: Vec<PriceRow> = (0..60).map(|i| row(&format!("sp {i}"), 0)).collect();
        let pages = paginate(&rows, 25);
        assert_eq!(
            pages.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![25, 25, 10]
        );

        let rows = vec![row("a", 0), row("b", 3), row("c", 0)];
        let pages = paginate(&rows, 3);
        assert_eq!(
            pages.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![1, 1, 1]
        );
        assert_eq!(pages[1][0].name, "b");
    }

    #[test]
    fn bundled_font_covers_vietnamese() {
        let font = pdf_font_ref();
        for ch in "Bảnggiáchọcthùngđắếộữạ".chars() {
            assert_ne!(font.glyph_id(ch).0, 0, "missing glyph for {ch:?}");
        }
    }

    #[test]
    fn pdf_starts_with_magic_and_spans_pages() {
        let mut rows: Vec<PriceRow> = (0..40).map(|i| row(&format!("Sản phẩm {i}"), 0)).collect();
        rows[0].units = vec![
            UnitPrice {
                name: "Thùng".to_owned(),
                quantity_in_base: 10,
                price: 90_000,
            },
            UnitPrice {
                name: "Lốc".to_owned(),
                quantity_in_base: 6,
                price: 55_000,
            },
        ];
        let bytes = render_pdf(&list(rows));
        assert!(bytes.starts_with(b"%PDF"), "missing PDF header");
        assert!(bytes.len() > 1_000);
        let mut warnings = Vec::new();
        let document =
            PdfDocument::parse(&bytes, &printpdf::PdfParseOptions::default(), &mut warnings)
                .expect("generated PDF parses");
        assert_eq!(document.page_count(), 2);
    }

    #[test]
    fn png_starts_with_magic_and_is_a4_portrait() {
        let bytes = render_png(&list(vec![row("Cà phê sữa", 2)]));
        assert!(
            bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "missing PNG header"
        );
        let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
            .expect("decode PNG");
        assert_eq!(image.width(), 1240);
        assert_eq!(image.height(), 1754);
    }

    #[test]
    fn empty_list_still_renders_one_page() {
        let pdf = render_pdf(&list(vec![]));
        assert!(pdf.starts_with(b"%PDF"));
        let png = render_png(&list(vec![]));
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn five_hundred_products_render_quickly() {
        let rows: Vec<PriceRow> = (0..500)
            .map(|i| {
                let mut row = row(&format!("Sản phẩm {i}"), i % 3);
                row.price = (i as i64 + 1) * 1_000;
                row
            })
            .collect();
        let started = std::time::Instant::now();
        let bytes = render_pdf(&list(rows));
        let elapsed = started.elapsed();
        eprintln!("500 products PDF render: {elapsed:?}");
        assert!(bytes.starts_with(b"%PDF"));
        assert!(elapsed < std::time::Duration::from_secs(10));
    }
}
