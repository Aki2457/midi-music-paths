# MIDI Music Paths

A Chromebook-first workflow hub connecting the existing Song Bridge tool to a complete MIDI-to-KTK preview path:

- **Song Maker:** Download an example MIDI and use [Song Bridge](https://song-bridge-midi.vercel.app/). File selection and preview happen locally; its explicit **Send MIDI to Google & create link** action submits the converted MIDI and settings to Chrome Music Lab's save service.
- **KTK:** Use the included browser-only MIDI-to-KTK converter at `/ktk-converter/`, download the `.ktk` project, then open it in the included player at `/ktk-player/`.

## Contents

- `index.html`, `style.css` — workflow guide and steps.
- `samples/*.mid` — three original, small, Standard MIDI 0/1 examples with static tempo and no key-signature metadata.
- `ktk-converter/` — a browser-only MIDI-to-KTK converter. It accepts `.mid` and `.midi` files, combines overflow tracks into its eight lanes without dropping notes, and reports any tempo clamp.
- `ktk-player/` — a copy of the existing standalone KTK player.
- `midi-player/` — a local Web Audio MIDI player with seeking and speed control.
- `midi-maker/` — a browser-local generator for melodies, chords, drums, long songs, and multi-track test MIDIs.
- `song-maker/` — a local splitter that exports complete consecutive parts of up to 16 bars each.
- `make_samples.py` — reproducible MIDI-example generator.
- `test-support/song-maker-core.mjs` — MIDI parsing and Song Maker grid conversion/segmentation core.
- `tests/` — parser, extension, track-merging, segmentation, MIDI-maker, and sample regression checks.
- `vercel.json` — static-site response headers for Vercel hosting.

## Hosted hub

The permanent public site is [midi-music-paths.vercel.app](https://midi-music-paths.vercel.app/). Its source is maintained in a private GitHub repository.

## Run locally

From this folder, run:

```sh
python3 -m http.server 8787
```

Then open `http://localhost:8787`. No install or build step is needed.

## Verify sample MIDIs

Run `node --test tests/*.test.mjs`. MIDI Maker regression checks verify its Type 0/1 output in the KTK and Song Maker parsers, including 30/210 BPM boundaries, twelve tracks, and long-song splitting. To include the eight locally supplied test files, set `MIDI_FIXTURE_DIR` to their directory, for example `MIDI_FIXTURE_DIR=/home/ubuntu/upload node --test tests/*.test.mjs`.

The MIDI Maker, KTK converter/player, MIDI player, and Song Maker splitter run in the browser without uploading files. Song Maker exports are split into parts to avoid its 16-bar truncation; sending a part to Google and creating a share link remains a separate, user-controlled action in Song Bridge. KTK compatibility, pitch mapping, timing, and browser-generated sound remain experimental.
