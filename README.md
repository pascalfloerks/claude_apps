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
