# Loop Catcher for Windows

A native Windows app built with [Tauri 2](https://tauri.app): a small Rust program that opens a
window and shows the web app from `../loop-catcher` in WebView2, the browser engine built into
Windows 10 and 11. The HTML, CSS and JavaScript are compiled into the `.exe`, so it works offline.
There is one codebase: change the files in `loop-catcher/` and rebuild.

What the Windows app adds over the browser version:

- **System audio recording (WASAPI loopback).** Source "System audio – what's playing" records
  everything that plays on a playback device (YouTube, Spotify, a DAW, games …). There is
  no need for "Stereo Mix" or a virtual cable. You can pick the playback device in Audio setup.
  While recording, the app plays silence on that device so silent passages are kept in the take.
- **Save WAV** writes straight to disk: through a native "Save As" dialog, or into a fixed folder.
  Files in that folder are never overwritten; " (2)", " (3)" … is appended instead.
  With a folder chosen you can also turn on "Save every new recording automatically".
- Its own window, taskbar entry and icon.

Requirements to run: Windows 10/11 64-bit with the
[WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on current Windows).

## Build on Windows (recommended, makes an installer)

1. Install [Rust](https://rustup.rs) (choose the MSVC toolchain and the "Desktop development with C++" build tools when asked).
2. Install [Node.js](https://nodejs.org) LTS.
3. In this folder run:

   ```
   npx @tauri-apps/cli@2 build
   ```

The installers end up in `target\release\bundle\nsis\` (`Loop Catcher_1.0.0_x64-setup.exe`)
and `target\release\bundle\msi\`. The plain program is `target\release\loop-catcher.exe`.

For development with live reload of the window: `npx @tauri-apps/cli@2 dev`.

## Cross-compile from Linux (portable .exe, no installer)

```
rustup target add x86_64-pc-windows-gnu
sudo apt-get install mingw-w64
cargo build --release --target x86_64-pc-windows-gnu
```

Ship `target/x86_64-pc-windows-gnu/release/loop-catcher.exe` together with
`WebView2Loader.dll` from the same folder. The GNU build needs that DLL beside the `.exe`;
the MSVC build made on Windows does not.
