# claude_apps

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
