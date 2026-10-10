# MIDI Maker

A dependency-free, browser-local MIDI generator integrated with the MIDI Music Paths workflow.

## Run

From the `music-midi-workflow` project root:

```sh
python3 -m http.server 8787
```

Open `http://localhost:8787/midi-maker/`. The page uses the shared project paths for the favicon and MIDI player, so keep the `midi-maker/` directory under the workflow root.

## Generate

Choose a musical shape, key, scale, tempo, length, and density, then generate or download a `.mid` file. The quick cases cover a simple melody, a Type 1 ensemble, a 20-bar splitter check, tempo limits, and 12 test tracks. Regenerating with the same seed in the core produces the same file; the page picks a new seed for each variation.

Files are Standard MIDI format 0 or 1, PPQN timing at 480 ticks per quarter note, and 4/4 meter. Supported controls are 30–210 BPM and 1–32 bars. Generation runs locally; there are no dependencies or uploads.

Run the integration regression suite from the project root with `node --test tests/*.test.mjs`.
