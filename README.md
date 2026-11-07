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
- **The track is a block** on the timeline: drag its header bar to move it (snaps to the grid). Markers, sections and In/Out move with it,
  so you can line it up with the grid or leave room for a count-in.
- **Click** the waveform to set the cursor; **drag** it (or the ruler) to scrub: the cursor follows the mouse and you hear the audio under it.
- **New** clears everything for an empty timeline.
- **In / Out points** (`I` / `O`, or the buttons) and **loop** (`L`): loops In→Out, or the whole track when nothing is set.
  Fine-tune them by dragging their IN / OUT flags in the ruler.
- **Slow down or speed up (25–150 %) without changing pitch or key.** It uses a WSOLA time stretch running in an AudioWorklet, and at 100 % the output is sample-exact.
  The speed menu (click the % next to the slider) offers presets with the resulting BPM, a custom %, "play at this BPM",
  and your own saved presets.
- **Speed trainer** (`P`): starts at e.g. 70 % and raises the speed by a step every N loop passes or N bars until the target.
  At the target it holds, starts over or stops.
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
- **Save session** (`Ctrl+Shift+S`) as a `.lcsession` file: the audio (lossless) plus track position, markers, sections, grid,
  In/Out, loop, speed and metronome. Open it again to continue where you left off.
- **Open** (`Ctrl+O`) or drag & drop WAV, MP3, FLAC, OGG or M4A files, or sessions.

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
| P | Speed trainer on / off |
| M / S | Add marker / section |
| F2 / Del | Rename / delete selected marker or section |
| B / D / T | Detect beats / bar 1 at cursor / tap tempo |
| C / N / G | Metronome / snap / grid |
| + / − / Z / F | Zoom in / out / fit, follow playhead |
| Ctrl+K | Crop to In→Out |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+S / Ctrl+O | Save WAV / open file or session |
| Ctrl+Shift+S | Save session |
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
  harmonic or melodic minor, blues or minor blues). The "Key degrees" palette offers the chords of that key
  (I, ii, iii, IV, V, vi, vii° …) as single tones, octaves, power chords, triads or 7th chords.
  In the blues keys I, IV and V (minor blues: V and ♭VI) are dominant 7th chords.
  Degree blocks remember their degree, so changing the key transposes the whole arrangement.
  Blocks can also be set to a fixed note ("Free") that ignores the key.
- **Arrangement grid**: drag tones from the palette onto lanes. Each cell is one beat.
  Drag a block to move it (also between lanes), pull its right edge to make it longer.
  Several lanes play together, so you can put chords over a bass pedal.
  At the end the track either loops or holds the last tone indefinitely.
- **Tempo and metronome**: BPM (30–300) with tap tempo, time signature, number of bars,
  metronome with adjustable volume and an optional accent on beat 1.
- **Sounds**: warm pad, organ, bowed strings or pure sine, with pedal and master volume.
- **Fretboard** with chord-scale suggestions:
  - *Scale for the current chord*: diatonic chords get the key's own mode (V in C major: G Mixolydian;
    vii°: B Locrian; V in harmonic minor: Phrygian dominant). Chords outside the key (secondary dominants,
    borrowed chords, blues dominants, diminished and augmented chords) get the scale that contains every
    chord tone, does not contradict the chord's 3rd or 5th, and changes the fewest notes of the key
    (A7 in C: Mixolydian ♭13; E7 in C: Phrygian dominant; B♭ in C: Lydian; D7 in an A blues: Mixolydian).
    Other scales that fit are offered as buttons, plus the pentatonic shapes inside the chosen scale.
  - *Mode over the pedal note*: the same, measured from the bass pedal, for pedal-point playing.
  - *Session key*: the key's scale; in a blues key the blues scale for the whole form, with
    major + minor pentatonic and major blues as options.
  - Or pick any root and any of 25 scales by hand (modes, pentatonics, blues, altered, whole tone, diminished).
  Labels as note names or intervals.
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
