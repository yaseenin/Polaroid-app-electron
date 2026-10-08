use eframe::{egui, App as EApp, CreationContext, NativeOptions};
use egui::{Align, Color32, Frame, RichText, Stroke, Vec2};
use image::{ImageFormat, Rgba, RgbaImage};
use rayon::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preset {
    Mini,
    InstaxMax,
    Polaroid600,
}

impl Preset {
    const ALL: [Self; 3] = [Self::Mini, Self::InstaxMax, Self::Polaroid600];

    fn label(self) -> &'static str {
        match self {
            Self::Mini => "Mini",
            Self::InstaxMax => "Instax Max",
            Self::Polaroid600 => "Polaroid 600",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SheetPaper {
    A4,
    SuperB1319,
    Medium13x9_5,
}

impl SheetPaper {
    const ALL: [Self; 3] = [Self::A4, Self::SuperB1319, Self::Medium13x9_5];

    fn label(self) -> &'static str {
        match self {
            Self::A4 => "A4",
            Self::SuperB1319 => "13x19 inch",
            Self::Medium13x9_5 => "13x9.5 inch",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExportFormat {
    Jpeg,
    Pdf,
}

impl ExportFormat {
    const ALL: [Self; 2] = [Self::Jpeg, Self::Pdf];

    fn label(self) -> &'static str {
        match self {
            Self::Jpeg => "JPEG",
            Self::Pdf => "PDF",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ImageProcessingSettings {
    exposure: f32,
    contrast: f32,
    gamma: f32,
    sharpen: f32,
    chroma_nr: f32,
    auto_rotate: bool,
    export_format: ExportFormat,
    dpi: u32,
}

struct App {
    loaded_photo_paths: Vec<PathBuf>,
    preset: Preset,
    paper: SheetPaper,
    auto_rotate: bool,
    crop_marks: bool,
    nudge_x: f32,
    nudge_y: f32,
    exposure: f32,
    contrast: f32,
    gamma: f32,
    sharpen: f32,
    chroma_nr: f32,
    export_format: ExportFormat,
    export_dpi: u32,
    status: String,
    job_in_progress: bool,
    worker_rx: Option<Receiver<WorkerMessage>>,
    last_export_dir: Option<PathBuf>,
}

#[derive(Debug)]
enum WorkerMessage {
    Status(String),
    Finished { output_dir: PathBuf, total: usize },
    Error(String),
}

impl App {
    fn new(_cc: &CreationContext<'_>) -> Self {
        Self {
            loaded_photo_paths: Vec::new(),
            preset: Preset::Mini,
            paper: SheetPaper::A4,
            auto_rotate: true,
            crop_marks: true,
            nudge_x: 0.0,
            nudge_y: 0.0,
            exposure: 0.0,
            contrast: 1.0,
            gamma: 1.0,
            sharpen: 0.0,
            chroma_nr: 0.0,
            export_format: ExportFormat::Jpeg,
            export_dpi: 300,
            status: "Ready for layout generation".to_owned(),
            job_in_progress: false,
            worker_rx: None,
            last_export_dir: None,
        }
    }

    fn choose_photos(&mut self) {
        if let Some(paths) = rfd::FileDialog::new()
            .add_filter("Image", &["png", "jpg", "jpeg", "tif", "tiff"])
            .pick_files()
        {
            self.loaded_photo_paths = paths;
            self.status = format!("Loaded {} photo(s) for processing", self.loaded_photo_paths.len());
        }
    }

    fn clear_photos(&mut self) {
        self.loaded_photo_paths.clear();
        self.status = "Photo list cleared".to_owned();
    }

    fn export_imposition(&mut self) {
        if self.job_in_progress {
            self.status = "A processing job is already running".to_owned();
            return;
        }

        if self.loaded_photo_paths.is_empty() {
            self.status = "Add at least one photo before exporting".to_owned();
            return;
        }

        let (tx, rx) = mpsc::channel();
        let photo_paths = self.loaded_photo_paths.clone();
        let settings = ImageProcessingSettings {
            exposure: self.exposure,
            contrast: self.contrast,
            gamma: self.gamma,
            sharpen: self.sharpen,
            chroma_nr: self.chroma_nr,
            auto_rotate: self.auto_rotate,
            export_format: self.export_format,
            dpi: self.export_dpi,
        };

        self.job_in_progress = true;
        self.status = format!(
            "Processing {} photos in the worker thread…",
            photo_paths.len()
        );
        self.worker_rx = Some(rx);

        thread::spawn(move || {
            match ImageProcessingPipeline::new(settings).process_batch(&photo_paths) {
                Ok(output_dir) => {
                    let _ = tx.send(WorkerMessage::Finished {
                        output_dir,
                        total: photo_paths.len(),
                    });
                }
                Err(error) => {
                    let _ = tx.send(WorkerMessage::Error(error));
                }
            }
        });
    }

    fn poll_worker_message(&mut self) {
        let Some(receiver) = self.worker_rx.as_ref() else {
            return;
        };

        if let Ok(message) = receiver.try_recv() {
            match message {
                WorkerMessage::Status(next_status) => {
                    self.status = next_status;
                }
                WorkerMessage::Finished { output_dir, total } => {
                    self.job_in_progress = false;
                    self.last_export_dir = Some(output_dir.clone());
                    self.status = format!(
                        "Finished processing {} image(s). Exported to {}",
                        total,
                        output_dir.display()
                    );
                    self.worker_rx = None;
                }
                WorkerMessage::Error(error) => {
                    self.job_in_progress = false;
                    self.status = format!("Processing failed: {}", error);
                    self.worker_rx = None;
                }
            }
        }
    }
}

impl EApp for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_worker_message();
        ctx.request_repaint();

        let accent = Color32::from_rgb(0x00, 0x67, 0xC0);
        let panel_bg = Color32::from_rgb(245, 245, 245);
        let subtle_border = Color32::from_rgb(229, 229, 229);

        egui::TopBottomPanel::top("title_bar")
            .frame(Frame::central_panel(&ctx.style()).fill(panel_bg).stroke(Stroke::new(1.0_f32, subtle_border)))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new("Polaroid Imposition & Batch Processor")
                            .size(20.0)
                            .strong(),
                    );
                    ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                        ui.label(RichText::new("Ready").color(accent));
                    });
                });
            });

        egui::SidePanel::left("control_panel")
            .min_width(330.0)
            .max_width(420.0)
            .resizable(true)
            .frame(Frame::side_top_panel(&ctx.style()).fill(panel_bg).stroke(Stroke::new(1.0_f32, subtle_border)))
            .show(ctx, |ui| {
                ui.spacing_mut().item_spacing = Vec2::new(10.0, 10.0);
                ui.spacing_mut().button_padding = Vec2::splat(10.0);

                App::render_section(ui, "Photo Management", |ui| {
                    if ui.button("Add Photos (FileDialog)").clicked() {
                        self.choose_photos();
                    }
                    if ui.button("Clear All").clicked() {
                        self.clear_photos();
                    }
                    ui.horizontal(|ui| {
                        ui.label("Photos loaded:");
                        ui.label(RichText::new(self.loaded_photo_paths.len().to_string()).strong().color(accent));
                    });
                });

                App::render_section(ui, "Preset & Paper Configuration", |ui| {
                    egui::ComboBox::from_label("Preset")
                        .selected_text(self.preset.label())
                        .show_ui(ui, |ui| {
                            for preset in Preset::ALL {
                                ui.selectable_value(&mut self.preset, preset, preset.label());
                            }
                        });

                    egui::ComboBox::from_label("Paper")
                        .selected_text(self.paper.label())
                        .show_ui(ui, |ui| {
                            for paper in SheetPaper::ALL {
                                ui.selectable_value(&mut self.paper, paper, paper.label());
                            }
                        });

                    ui.checkbox(&mut self.auto_rotate, "Auto-Rotate Photos to Fit Frame");
                    ui.checkbox(&mut self.crop_marks, "Enable Perimeter Crop Marks");
                });

                App::render_section(ui, "Printer Nudge Alignment (mm)", |ui| {
                    ui.horizontal(|ui| {
                        ui.label("Nudge X");
                        ui.add(egui::DragValue::new(&mut self.nudge_x).speed(0.5).range(-20.0..=20.0));
                    });
                    ui.horizontal(|ui| {
                        ui.label("Nudge Y");
                        ui.add(egui::DragValue::new(&mut self.nudge_y).speed(0.5).range(-20.0..=20.0));
                    });
                });

                App::render_section(ui, "Image Adjustments (Non-Destructive)", |ui| {
                    ui.add(egui::Slider::new(&mut self.exposure, -2.0..=2.0).text("Exposure"));
                    ui.add(egui::Slider::new(&mut self.contrast, 0.5..=2.0).text("Contrast"));
                    ui.add(egui::Slider::new(&mut self.gamma, 0.2..=3.0).text("Gamma"));
                    ui.add(egui::Slider::new(&mut self.sharpen, 0.0..=3.0).text("Unsharp Masking"));
                    ui.add(egui::Slider::new(&mut self.chroma_nr, 0.0..=1.0).text("Chroma Noise Reduction"));
                });

                App::render_section(ui, "Export Action", |ui| {
                    egui::ComboBox::from_label("Format")
                        .selected_text(self.export_format.label())
                        .show_ui(ui, |ui| {
                            for format in ExportFormat::ALL {
                                ui.selectable_value(&mut self.export_format, format, format.label());
                            }
                        });
                    ui.add(egui::Slider::new(&mut self.export_dpi, 150..=600).text("Export DPI"));
                    if ui.button("Export Imposition Sheets").clicked() {
                        self.export_imposition();
                    }
                });
            });

        egui::CentralPanel::default().show(ctx, |ui| {
            let preview = ui.available_rect_before_wrap();
            let painter = ui.painter_at(preview);

            painter.rect_filled(preview, 6.0, Color32::from_rgb(248, 248, 250));
            painter.rect_stroke(preview, 6.0, Stroke::new(1.0_f32, subtle_border));

            let sheet_rect = egui::Rect::from_min_size(
                egui::pos2(preview.left() + 32.0, preview.top() + 32.0),
                egui::vec2(preview.width() - 64.0, preview.height() - 120.0),
            );
            painter.rect_filled(sheet_rect, 8.0, Color32::WHITE);
            painter.rect_stroke(sheet_rect, 8.0, Stroke::new(1.0_f32, subtle_border));

            let card_w = 86.0;
            let card_h = 112.0;
            let cols = 3;
            let rows = 2;
            let gutter = 18.0;
            let origin_x = sheet_rect.left() + 36.0;
            let origin_y = sheet_rect.top() + 34.0;

            for row in 0..rows {
                for col in 0..cols {
                    let x = origin_x + col as f32 * (card_w + gutter);
                    let y = origin_y + row as f32 * (card_h + gutter);
                    let card = egui::Rect::from_min_size(egui::pos2(x, y), egui::vec2(card_w, card_h));
                    painter.rect_filled(card, 6.0, Color32::from_rgb(240, 240, 245));
                    painter.rect_stroke(card, 6.0, Stroke::new(1.0_f32, Color32::from_rgb(210, 210, 220)));
                    painter.line_segment(
                        [egui::pos2(card.left(), card.top()), egui::pos2(card.right(), card.top())],
                        Stroke::new(1.0_f32, Color32::from_rgb(150, 150, 150)),
                    );
                    painter.line_segment(
                        [egui::pos2(card.left(), card.top()), egui::pos2(card.left(), card.bottom())],
                        Stroke::new(1.0_f32, Color32::from_rgb(150, 150, 150)),
                    );

                    let inner = card.shrink(10.0);
                    painter.rect_filled(inner, 4.0, Color32::from_rgb(220, 228, 235));
                    painter.rect_stroke(inner, 4.0, Stroke::new(1.0_f32, Color32::from_rgb(180, 190, 200)));
                }
            }

            let bottom = egui::Rect::from_min_size(
                egui::pos2(preview.left() + 16.0, preview.bottom() - 42.0),
                egui::vec2(preview.width() - 32.0, 26.0),
            );
            painter.rect_filled(bottom, 5.0, Color32::from_rgb(234, 234, 238));
            painter.text(
                bottom.center(),
                egui::Align2::CENTER_CENTER,
                &self.status,
                egui::FontId::proportional(14.0),
                Color32::from_rgb(30, 30, 30),
            );
        });
    }

    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        egui::Rgba::from_rgb(243.0 / 255.0, 243.0 / 255.0, 243.0 / 255.0).to_array()
    }
}

impl App {
    fn render_section<R>(ui: &mut egui::Ui, title: &str, add_contents: impl FnOnce(&mut egui::Ui) -> R) {
        ui.group(|ui| {
            ui.label(RichText::new(title).strong().size(13.0));
            ui.separator();
            add_contents(ui);
        });
    }
}

struct ImageProcessingPipeline {
    settings: ImageProcessingSettings,
}

impl ImageProcessingPipeline {
    fn new(settings: ImageProcessingSettings) -> Self {
        Self { settings }
    }

    fn process_batch(&self, sources: &[PathBuf]) -> Result<PathBuf, String> {
        self.process_batch_with_override(sources, None)
    }

    fn process_batch_with_override(
        &self,
        sources: &[PathBuf],
        override_output_dir: Option<&Path>,
    ) -> Result<PathBuf, String> {
        let output_dir = match override_output_dir {
            Some(path) => path.to_path_buf(),
            None => {
                let output_root = std::env::temp_dir().join("polaroid_print_imposition_engine");
                let export_stamp = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|err| err.to_string())?
                    .as_millis();
                output_root.join(format!("export_{export_stamp}"))
            }
        };

        fs::create_dir_all(&output_dir).map_err(|err| err.to_string())?;

        let results: Vec<Result<PathBuf, String>> = sources
            .par_iter()
            .enumerate()
            .map(|(index, source)| self.process_one(source, &output_dir, index))
            .collect();

        let mut paths = Vec::new();
        for result in results {
            match result {
                Ok(path) => paths.push(path),
                Err(err) => return Err(err),
            }
        }

        if self.settings.export_format == ExportFormat::Pdf {
            let pdf_path = self.write_pdf_sumary(&output_dir, &paths)?;
            paths.push(pdf_path);
        }

        Ok(output_dir)
    }

    fn process_one(&self, source: &Path, output_dir: &Path, index: usize) -> Result<PathBuf, String> {
        let image = image::open(source).map_err(|err| format!("{}: {}", source.display(), err))?;
        let transformed = if self.settings.auto_rotate && image.width() > image.height() {
            image.rotate90()
        } else {
            image
        };

        let mut rgba = transformed.to_rgba8();
        self.apply_adjustments(&mut rgba);

        let file_name = source
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("photo")
            .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");

        let output_path = output_dir.join(format!("{file_name}_{}.jpg", index + 1));
        rgba.save_with_format(&output_path, ImageFormat::Jpeg)
            .map_err(|err| format!("{}: {}", source.display(), err))?;

        Ok(output_path)
    }

    fn apply_adjustments(&self, rgba: &mut RgbaImage) {
        let (width, height) = rgba.dimensions();
        let original = rgba.clone();

        for y in 0..height {
            for x in 0..width {
                let pixel = original.get_pixel(x, y);
                let mut channels = [0.0_f32; 4];
                for channel in 0..3 {
                    let value = pixel[channel] as f32 / 255.0;
                    let adjusted = self.adjust_channel(value, channel);
                    channels[channel] = adjusted;
                }
                channels[3] = 1.0;

                let mut final_rgba = [0_u8; 4];
                for channel in 0..3 {
                    final_rgba[channel] = (channels[channel].clamp(0.0, 1.0) * 255.0).round() as u8;
                }
                final_rgba[3] = pixel[3];
                rgba.put_pixel(x, y, Rgba(final_rgba));
            }
        }

        if self.settings.sharpen > 0.0 {
            self.apply_unsharp_mask(rgba);
        }
    }

    fn adjust_channel(&self, value: f32, channel_index: usize) -> f32 {
        let mut v = value;

        if channel_index < 3 {
            v = (v - 0.5) * self.settings.contrast + 0.5;
            v = v.powf(1.0 / self.settings.gamma.max(0.001));
            v = (v * (2.0_f32).powf(self.settings.exposure)).clamp(0.0, 1.0);
        }

        v
    }

    fn apply_unsharp_mask(&self, rgba: &mut RgbaImage) {
        let (width, height) = rgba.dimensions();
        let original = rgba.clone();
        let amount = self.settings.sharpen;

        for y in 1..height - 1 {
            for x in 1..width - 1 {
                let base = original.get_pixel(x, y);
                let mut blurred = [0.0_f32; 3];
                let mut samples = 0usize;

                for yy in y - 1..=y + 1 {
                    for xx in x - 1..=x + 1 {
                        let neighbor = original.get_pixel(xx, yy);
                        for channel in 0..3 {
                            blurred[channel] += neighbor[channel] as f32 / 255.0;
                        }
                        samples += 1;
                    }
                }

                let mut result = [0_u8; 4];
                for channel in 0..3 {
                    let base_value = base[channel] as f32 / 255.0;
                    let blur_value = blurred[channel] / samples as f32;
                    let edge = base_value - blur_value;
                    let value = (base_value + amount * edge).clamp(0.0, 1.0);
                    result[channel] = (value * 255.0).round() as u8;
                }
                result[3] = base[3];
                rgba.put_pixel(x, y, Rgba(result));
            }
        }
    }

    fn write_pdf_sumary(&self, output_dir: &Path, exported_images: &[PathBuf]) -> Result<PathBuf, String> {
        let pdf_path = output_dir.join("export_summary.pdf");
        let mut pdf_contents = String::new();
        pdf_contents.push_str("%PDF-1.4\n");
        pdf_contents.push_str("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        pdf_contents.push_str("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
        pdf_contents.push_str("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n");
        pdf_contents.push_str("4 0 obj\n<< /Length 120 >>\nstream\nBT /F1 18 Tf 72 720 Td (Polaroid Print Imposition Export) Tj 0 -28 Td (Images: ");
        pdf_contents.push_str(&exported_images.len().to_string());
        pdf_contents.push_str(") Tj ET\nendstream\nendobj\n");
        pdf_contents.push_str("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
        pdf_contents.push_str("xref\n0 6\n0000000000 65535 f \n");
        pdf_contents.push_str("trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n0\n%%EOF\n");

        fs::write(&pdf_path, pdf_contents).map_err(|err| err.to_string())?;
        Ok(pdf_path)
    }
}

#[derive(Debug)]
struct HeadlessRequest {
    files: Vec<PathBuf>,
    output_dir: Option<PathBuf>,
    settings: ImageProcessingSettings,
}

fn parse_bool(value: &str) -> bool {
    matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
}

fn parse_headless_request() -> Result<HeadlessRequest, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.iter().any(|arg| arg == "--process") {
        return Err("not a headless request".to_owned());
    }

    let mut files = Vec::new();
    let mut output_dir = None;
    let mut exposure = 0.0_f32;
    let mut contrast = 1.0_f32;
    let mut gamma = 1.0_f32;
    let mut sharpen = 0.0_f32;
    let mut chroma_nr = 0.0_f32;
    let mut auto_rotate = true;
    let mut export_format = ExportFormat::Jpeg;
    let mut dpi = 300_u32;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--process" => {
                index += 1;
            }
            "--file" => {
                if index + 1 >= args.len() {
                    return Err("--file requires a value".to_owned());
                }
                files.push(PathBuf::from(&args[index + 1]));
                index += 2;
            }
            "--output-dir" => {
                if index + 1 >= args.len() {
                    return Err("--output-dir requires a value".to_owned());
                }
                output_dir = Some(PathBuf::from(&args[index + 1]));
                index += 2;
            }
            "--exposure" => {
                if index + 1 >= args.len() {
                    return Err("--exposure requires a value".to_owned());
                }
                exposure = args[index + 1].parse().map_err(|_| "invalid exposure value".to_owned())?;
                index += 2;
            }
            "--contrast" => {
                if index + 1 >= args.len() {
                    return Err("--contrast requires a value".to_owned());
                }
                contrast = args[index + 1].parse().map_err(|_| "invalid contrast value".to_owned())?;
                index += 2;
            }
            "--gamma" => {
                if index + 1 >= args.len() {
                    return Err("--gamma requires a value".to_owned());
                }
                gamma = args[index + 1].parse().map_err(|_| "invalid gamma value".to_owned())?;
                index += 2;
            }
            "--sharpen" => {
                if index + 1 >= args.len() {
                    return Err("--sharpen requires a value".to_owned());
                }
                sharpen = args[index + 1].parse().map_err(|_| "invalid sharpen value".to_owned())?;
                index += 2;
            }
            "--auto-rotate" => {
                if index + 1 >= args.len() {
                    return Err("--auto-rotate requires a value".to_owned());
                }
                auto_rotate = parse_bool(&args[index + 1]);
                index += 2;
            }
            "--format" => {
                if index + 1 >= args.len() {
                    return Err("--format requires a value".to_owned());
                }
                let format_name = args[index + 1].to_ascii_lowercase();
                export_format = match format_name.as_str() {
                    "jpeg" | "jpg" => ExportFormat::Jpeg,
                    "pdf" => ExportFormat::Pdf,
                    _ => return Err(format!("unsupported export format: {}", format_name)),
                };
                index += 2;
            }
            "--dpi" => {
                if index + 1 >= args.len() {
                    return Err("--dpi requires a value".to_owned());
                }
                dpi = args[index + 1].parse().map_err(|_| "invalid dpi value".to_owned())?;
                index += 2;
            }
            unknown => {
                return Err(format!("unknown argument: {}", unknown));
            }
        }
    }

    if files.is_empty() {
        return Err("no image files were supplied for processing".to_owned());
    }

    Ok(HeadlessRequest {
        files,
        output_dir,
        settings: ImageProcessingSettings {
            exposure,
            contrast,
            gamma,
            sharpen,
            chroma_nr,
            auto_rotate,
            export_format,
            dpi,
        },
    })
}

fn run_headless_job() -> Result<(), String> {
    let request = parse_headless_request()?;
    let output_dir = request
        .output_dir
        .as_deref()
        .map(Path::new)
        .map(|dir| dir.to_path_buf())
        .unwrap_or_else(|| std::env::temp_dir().join("polaroid_print_imposition_engine"));

    let pipeline = ImageProcessingPipeline::new(request.settings);
    let result_dir = pipeline.process_batch_with_override(&request.files, Some(&output_dir))?;
    println!("{}", result_dir.display());
    Ok(())
}

fn main() -> eframe::Result<()> {
    if let Ok(_) = parse_headless_request() {
        if let Err(error) = run_headless_job() {
            eprintln!("{}", error);
            std::process::exit(1);
        }
        return Ok(());
    }

    let native_options = NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 800.0])
            .with_min_inner_size([1024.0, 600.0])
            .with_title("Polaroid Imposition & Batch Processor"),
        ..Default::default()
    };

    eframe::run_native(
        "PolaroidPrintImpositionEngine",
        native_options,
        Box::new(|cc| Ok(Box::new(App::new(cc)))),
    )
}
