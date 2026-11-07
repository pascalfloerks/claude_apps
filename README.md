# claude_apps

## Loop Catcher (`loop-catcher/`)

Record whatever is playing, then loop it, slow it down and practise with it.
Open `loop-catcher/index.html` in Chrome or Edge, or use the standalone Windows app in
[`loop-catcher-windows/`](loop-catcher-windows/README.md). The Windows app records system audio directly (WASAPI loopback).

### Features

- **Record** the audio that is playing right now, with a live waveform while recording:
  - *System audio (loopback)* in the Windows app: pick any playback device.
  - *Audio input device*: microphone, line-in, audio interface, "Stereo Mix", virtual cables, BlackHole …
  - *Browser tab / screen audio*: Chrome/Edge's share picker ("Share tab audio" / "Share system audio").
  - Choose input and output device, sample rate, latency, mono/stereo, and optional input monitoring. A level meter and "Test" button check the input.
- **Timeline**: stereo waveform, playhead and edit cursor, zoom (down to single samples) and scroll, overview strip.
- **In / Out points** (`I` / `O`) and **loop** (`L`): loops In→Out, or the whole track when nothing is set.
- **Scrub**: drag in the ruler to hear the audio under the mouse.
- **Slow down or speed up (25–150 %) without changing pitch or key.** It uses a WSOLA time stretch running in an AudioWorklet, and at 100 % the output is sample-exact.
- **Volume and pan** sliders.
- **Metronome** that follows the grid and the playback speed, with an accent on beat 1. It can also play while you record.
- **Beat detection** (`B`) finds the tempo and the downbeat and lines the grid up with the track. It can run automatically after each recording.
  Correct it with ÷2 / ×2, tap tempo, "Bar 1 here" (`D`), 5 ms nudges, or Alt+drag in the ruler.
- **Grid** (bar, 1/4, 1/8, 1/16, triplets) with **snap** (`N`, hold Alt to bypass); the ruler shows bars and beats.
- **Markers** (`M`, or double-click the marker lane) and **sections** (`S` from In→Out, or draw them in the section lane).
  Move them, resize them, and rename, recolour or delete them from the right-click menu.
- **Double-click a section** to select and loop it. **Double-click a free spot** on the track to select the whole track.
- **Crop** the track to In→Out (`Ctrl+K`). The grid, markers and sections move with it.
- **Undo / redo** for every edit.
- **Save WAV** (`Ctrl+S`) as 16-bit, 24-bit or 32-bit float, for the whole track or only In→Out.
  Name files with a custom pattern (`{name}`, `{date}`, `{time}`, `{bpm}`, `{n}`, `{len}`, `{range}`).
  Markers and sections are embedded as standard cue points and regions, so DAWs and editors can read them.
  When the file is opened again in Loop Catcher, its grid, markers and sections come back.
- **Open** (`Ctrl+O`) or drag & drop WAV, MP3, FLAC, OGG or M4A files.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play / stop |
| R | Record / stop recording |
| I / O | Set In / Out (Shift: jump to it) |
| L | Loop on / off |
| X / Esc | Clear In / Out |
| Home / Enter, End | Go to In (or start), Out (or end) |
| ← / → (Shift: by bar) | Move cursor by grid step |
| , / . | Previous / next marker or section |
| [ / ] / \ | Slower / faster / 100 % |
| M / S | Add marker / section |
| F2 / Del | Rename / delete selected marker or section |
| B / D / T | Detect beats / bar 1 at cursor / tap tempo |
| C / N / G | Metronome / snap / grid |
| + / − / Z / F | Zoom in / out / fit, follow playhead |
| Ctrl+K | Crop to In→Out |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+S / Ctrl+O | Save WAV / open file |
| ? | All shortcuts and mouse actions |

## Pedal Point (`pedal-point/`)

A browser app for practising guitar chords and scales over a pedal tone (drone).
Open `pedal-point/index.html` in any modern browser. Nothing to install; the fonts ship in `pedal-point/fonts/`.

A standalone Windows app (Tauri, Rust) that wraps the same page lives in [`windows/`](windows/README.md).

### Features

- **Hold a pedal tone** in any of the 12 keys, as a single tone, octaves, power chord or a full chord
  (major, minor, sus, 7ths, dim, aug, add9, m9). It sustains until you release it.
  Optionally it changes key automatically every 1–16 bars (by 5ths, 4ths, half/whole steps, minor 3rds or randomly).
- **Session key and degrees**: every session has a key (root + major, minor, any church mode,
  harmonic or melodic minor). The "Key degrees" palette offers the diatonic chords of that key
  (I, ii, iii, IV, V, vi, vii° …) as single tones, octaves, power chords, triads or 7th chords.
  Degree blocks remember their degree, so changing the key transposes the whole arrangement.
  Blocks can also be set to a fixed note ("Free") that ignores the key.
- **Arrangement grid**: drag tones from the palette onto lanes. Each cell is one beat.
  Drag a block to move it (also between lanes), pull its right edge to make it longer.
  Several lanes play together, so you can put chords over a bass pedal.
  At the end the track either loops or holds the last tone indefinitely.
- **Tempo and metronome**: BPM (30–300) with tap tempo, time signature, number of bars,
  metronome with adjustable volume and an optional accent on beat 1.
- **Sounds**: warm pad, organ, bowed strings or pure sine, with pedal and master volume.
- **Fretboard**: "Mode of current chord" shows the mode that fits the chord playing right now within the key
  (e.g. over V in C major: G Mixolydian; over vii°: B Locrian; over V in harmonic minor: Phrygian dominant).
  It also shows the chosen scale (pentatonics, blues, all modes, harmonic/melodic minor)
  over whatever is sounding, with the pedal root and chord tones highlighted. Labels as note names or intervals.
- **Sessions**: Save Session / Open Session store sessions in the browser. Sessions can also be
  downloaded as a `.json` file, copied as text, and opened again from a file or pasted text.
  Work in progress is restored automatically when you reload.
- Undo / redo for all edits.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play / stop the arrangement |
| D | Hold / release the pedal tone |
| Home | Back to start |
| M | Metronome on / off |
| L | Loop track / hold last tone |
| T | Tap tempo |
| + / − | Tempo up / down |
| ← / → (Shift: by bar) | Move selected block |
| ↑ / ↓ | Move selected block to another lane |
| Shift + ↑ / ↓ | Transpose selected block (degree blocks step through the key's degrees) |
| [ / ] (Shift: by bar) | Shorten / lengthen selected block |
| Delete | Remove selected block |
| Ctrl/⌘ + D | Duplicate selected block |
| Ctrl/⌘ + Z, Ctrl/⌘ + Shift + Z | Undo, redo |
| Ctrl/⌘ + S (Shift: save as) | Save session |
| Ctrl/⌘ + O | Open session |
| ? | Show shortcuts |
