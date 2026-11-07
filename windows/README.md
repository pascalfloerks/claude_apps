# Pedal Point for Windows

A native Windows app built with [Tauri 2](https://tauri.app): a small Rust program
that opens a window and shows the web app from `../pedal-point` in WebView2, the browser
engine built into Windows 10 and 11. The HTML, CSS and JavaScript are compiled into the `.exe`,
so it works offline. There is one codebase: change `pedal-point/index.html` and rebuild.

What the Windows app adds over the browser version:

- Its own window, taskbar entry and icon. No browser tabs or address bar.
- **Download file** (in the Save Session dialog) opens a native Windows "Save As" dialog.
- Saved sessions live in `%LOCALAPPDATA%\com.pascalfloerks.pedalpoint`.

Requirements to run: Windows 10/11 64-bit with the
[WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on current Windows).

## Build on Windows (recommended, makes an installer)

1. Install [Rust](https://rustup.rs) (choose the MSVC toolchain and the "Desktop development with C++" build tools when asked).
2. Install [Node.js](https://nodejs.org) LTS.
3. In this folder run:

   ```
   npx @tauri-apps/cli@2 build
   ```

The installers end up in `target\release\bundle\nsis\` (`Pedal Point_1.0.0_x64-setup.exe`)
and `target\release\bundle\msi\`. The plain program is `target\release\pedal-point.exe`.

For development with live reload of the window: `npx @tauri-apps/cli@2 dev`.

## Cross-compile from Linux (portable .exe, no installer)

```
rustup target add x86_64-pc-windows-gnu
sudo apt-get install mingw-w64
cargo build --release --target x86_64-pc-windows-gnu
```

Ship `target/x86_64-pc-windows-gnu/release/pedal-point.exe` together with
`WebView2Loader.dll` from the same folder. The GNU build needs that DLL beside the `.exe`;
the MSVC build made on Windows does not.
