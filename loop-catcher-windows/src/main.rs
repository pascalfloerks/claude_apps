// Loop Catcher for Windows: a native window around the web app in ../loop-catcher,
// plus what a browser cannot do: record the system's playback (WASAPI loopback) and
// write WAV files straight to disk.
// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
struct DeviceInfo {
    name: String,
    is_default: bool,
    sample_rate: u32,
    channels: u16,
}

#[derive(Serialize)]
struct StreamInfo {
    device: String,
    sample_rate: u32,
    channels: u16,
}

/// The running capture, if any. Sending on (or dropping) the sender stops it.
#[derive(Default)]
struct Capture {
    stop: Mutex<Option<mpsc::Sender<()>>>,
}

/// Playback devices that can be recorded with loopback.
#[tauri::command]
fn loopback_devices() -> Result<Vec<DeviceInfo>, String> {
    let host = cpal::default_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());
    let mut out = Vec::new();
    for dev in host.output_devices().map_err(|e| e.to_string())? {
        let Ok(name) = dev.name() else { continue };
        let Ok(cfg) = dev.default_output_config() else { continue };
        out.push(DeviceInfo {
            is_default: default_name.as_deref() == Some(name.as_str()),
            name,
            sample_rate: cfg.sample_rate().0,
            channels: cfg.channels(),
        });
    }
    Ok(out)
}

fn find_output(host: &cpal::Host, name: Option<&str>) -> Option<cpal::Device> {
    match name {
        Some(n) if !n.is_empty() => host
            .output_devices()
            .ok()?
            .find(|d| d.name().map(|x| x == n).unwrap_or(false)),
        _ => host.default_output_device(),
    }
}

/// Input stream on an output device = WASAPI loopback. Converts every sample format to f32.
fn build_capture(
    dev: &cpal::Device,
    cfg: &cpal::SupportedStreamConfig,
    tx: mpsc::Sender<Vec<f32>>,
) -> Result<cpal::Stream, String> {
    fn make<T: SizedSample + Send + 'static>(
        dev: &cpal::Device,
        cfg: &cpal::StreamConfig,
        tx: mpsc::Sender<Vec<f32>>,
        conv: fn(T) -> f32,
    ) -> Result<cpal::Stream, cpal::BuildStreamError> {
        dev.build_input_stream(
            cfg,
            move |data: &[T], _| {
                let _ = tx.send(data.iter().map(|&v| conv(v)).collect());
            },
            |e| eprintln!("loopback stream error: {e}"),
            None,
        )
    }
    let c = cfg.config();
    let r = match cfg.sample_format() {
        SampleFormat::F32 => make::<f32>(dev, &c, tx, |v| v),
        SampleFormat::I16 => make::<i16>(dev, &c, tx, |v| v as f32 / 32768.0),
        SampleFormat::I32 => make::<i32>(dev, &c, tx, |v| v as f32 / 2_147_483_648.0),
        SampleFormat::U16 => make::<u16>(dev, &c, tx, |v| (v as f32 - 32768.0) / 32768.0),
        f => return Err(format!("Unsupported sample format {f:?}")),
    };
    r.map_err(|e| e.to_string())
}

/// WASAPI delivers no loopback data while nothing is playing, which would remove the silent
/// parts from a recording. Playing silence on the same device keeps the stream running.
fn build_silence(dev: &cpal::Device, cfg: &cpal::SupportedStreamConfig) -> Option<cpal::Stream> {
    fn make<T: SizedSample + Send + 'static>(dev: &cpal::Device, cfg: &cpal::StreamConfig, zero: T) -> Option<cpal::Stream> {
        dev.build_output_stream(cfg, move |d: &mut [T], _| d.fill(zero), |_| {}, None).ok()
    }
    let c = cfg.config();
    match cfg.sample_format() {
        SampleFormat::F32 => make::<f32>(dev, &c, 0.0),
        SampleFormat::I16 => make::<i16>(dev, &c, 0),
        SampleFormat::I32 => make::<i32>(dev, &c, 0),
        SampleFormat::U16 => make::<u16>(dev, &c, 32768),
        _ => None,
    }
}

/// Start recording a playback device. Samples go to `on_data` as raw little-endian
/// interleaved f32 (an ArrayBuffer on the JavaScript side) about every 30 ms.
#[tauri::command]
fn loopback_start(
    state: tauri::State<'_, Capture>,
    device: Option<String>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<StreamInfo, String> {
    if let Some(old) = state.stop.lock().unwrap().take() {
        let _ = old.send(());
    }
    let (ready_tx, ready_rx) = mpsc::channel::<Result<StreamInfo, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    // cpal streams must stay on the thread that created them.
    thread::spawn(move || {
        let host = cpal::default_host();
        let Some(dev) = find_output(&host, device.as_deref()) else {
            let _ = ready_tx.send(Err("Playback device not found.".into()));
            return;
        };
        let cfg = match dev.default_output_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        };
        let info = StreamInfo {
            device: dev.name().unwrap_or_else(|_| "Playback device".into()),
            sample_rate: cfg.sample_rate().0,
            channels: cfg.channels(),
        };
        let (data_tx, data_rx) = mpsc::channel::<Vec<f32>>();
        let stream = match build_capture(&dev, &cfg, data_tx) {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("Could not open loopback: {e}")));
                return;
            }
        };
        let silence = build_silence(&dev, &cfg);
        if let Some(s) = &silence {
            let _ = s.play();
        }
        if let Err(e) = stream.play() {
            let _ = ready_tx.send(Err(format!("Could not start loopback: {e}")));
            return;
        }
        let _ = ready_tx.send(Ok(info));

        let mut buf: Vec<f32> = Vec::with_capacity(48_000);
        let mut last = Instant::now();
        loop {
            match stop_rx.try_recv() {
                Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
                Err(mpsc::TryRecvError::Empty) => {}
            }
            match data_rx.recv_timeout(Duration::from_millis(20)) {
                Ok(v) => buf.extend_from_slice(&v),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            while let Ok(v) = data_rx.try_recv() {
                buf.extend_from_slice(&v);
            }
            if !buf.is_empty() && last.elapsed() >= Duration::from_millis(30) {
                let mut bytes = Vec::with_capacity(buf.len() * 4);
                for s in &buf {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                buf.clear();
                last = Instant::now();
                if on_data.send(InvokeResponseBody::Raw(bytes)).is_err() {
                    break;
                }
            }
        }
        // flush what is left
        if !buf.is_empty() {
            let bytes: Vec<u8> = buf.iter().flat_map(|s| s.to_le_bytes()).collect();
            let _ = on_data.send(InvokeResponseBody::Raw(bytes));
        }
        drop(stream);
        drop(silence);
    });

    let info = ready_rx
        .recv()
        .map_err(|_| "The capture thread stopped unexpectedly.".to_string())??;
    *state.stop.lock().unwrap() = Some(stop_tx);
    Ok(info)
}

#[tauri::command]
fn loopback_stop(state: tauri::State<'_, Capture>) {
    if let Some(tx) = state.stop.lock().unwrap().take() {
        let _ = tx.send(());
    }
    // give the capture thread time to send its last block before the page reads the take
    thread::sleep(Duration::from_millis(80));
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(request: &Request<'_>, name: &str) -> String {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default()
}

/// Write a WAV file. The body is the file's bytes; headers carry the file name and,
/// optionally, a folder. Without a folder a "Save As" dialog asks where to put it.
/// Returns the full path, or None when the dialog is cancelled.
#[tauri::command]
async fn save_audio_file(app: tauri::AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file contents as raw bytes.".into());
    };
    let name: String = header(&request, "x-file-name")
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let name = if name.trim().is_empty() { "Recording.wav".to_string() } else { name };
    let dir = header(&request, "x-dir");

    let path: PathBuf = if !dir.is_empty() && PathBuf::from(&dir).is_dir() {
        // never overwrite: add " (2)", " (3)" … when the name is taken
        let base = PathBuf::from(&dir);
        let stem = name.trim_end_matches(".wav").to_string();
        let mut p = base.join(&name);
        let mut n = 2;
        while p.exists() {
            p = base.join(format!("{stem} ({n}).wav"));
            n += 1;
        }
        p
    } else {
        let picked = app
            .dialog()
            .file()
            .set_title("Save WAV")
            .set_file_name(&name)
            .add_filter("WAV audio", &["wav"])
            .blocking_save_file();
        let Some(file) = picked else { return Ok(None) };
        file.into_path().map_err(|e| e.to_string())?
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// Choose a folder for quick saving / auto-saving recordings.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().set_title("Folder for recordings").blocking_pick_folder();
    let Some(dir) = picked else { return Ok(None) };
    let path = dir.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Capture::default())
        .invoke_handler(tauri::generate_handler![
            loopback_devices,
            loopback_start,
            loopback_stop,
            save_audio_file,
            pick_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loop Catcher");
}
