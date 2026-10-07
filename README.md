# MIDI Music Paths

A Chromebook-first workflow hub connecting the existing Song Bridge tool to a complete MIDI-to-KTK preview path:

- **Song Maker:** Download an example MIDI and use [Song Bridge](https://song-bridge-midi.vercel.app/). File selection and preview happen locally; its explicit **Send MIDI to Google & create link** action submits the converted MIDI and settings to Chrome Music Lab's save service.
- **KTK:** Use the included browser-only MIDI-to-KTK converter at `/ktk-converter/`, download the `.ktk` project, then open it in the included player at `/ktk-player/`.

## Contents

- `index.html`, `style.css` — workflow guide and steps.
- `samples/*.mid` — three original, small, Standard MIDI 0/1 examples with static tempo and no key-signature metadata.
- `ktk-converter/` — a copy of the existing browser-only MIDI-to-KTK web app.
- `ktk-player/` — a copy of the existing standalone KTK player.
- `make_samples.py` — reproducible MIDI-example generator.
- `test-support/song-maker-core.mjs` — Song Bridge converter core for the sample regression test.
- `tests/` — verifies the examples parse and convert in both converter cores.
- `vercel.json` — static-site response headers for Vercel hosting.

## Run locally

From this folder, run:

```sh
python3 -m http.server 8787
```

Then open `http://localhost:8787`. No install or build step is needed.

## Verify sample MIDIs

Run `node --test tests/sample-midis.test.mjs`. The test exercises the included Song Bridge and KTK conversion cores against all three downloadable examples.

The KTK converter and player process the selected file in the browser without uploading it. KTK compatibility, pitch mapping, timing, and browser-generated sound remain experimental.
