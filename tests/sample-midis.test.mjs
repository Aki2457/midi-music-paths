import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const songCore = await import(pathToFileURL(path.join(root, 'test-support/song-maker-core.mjs')));
const ktkCore = await import(pathToFileURL(path.join(root, 'ktk-converter/converter-core.js')));
const template = JSON.parse(await readFile(path.join(root, 'ktk-converter/assets/template.json'), 'utf8'));
const presets = JSON.parse(await readFile(path.join(root, 'ktk-converter/instrument_presets.json'), 'utf8'));
const samples = ['little-lantern.mid', 'warm-chords.mid', 'paper-kite.mid'];

test('each MIDI sample parses and converts in both browser converters', async () => {
  for (const file of samples) {
    const bytes = new Uint8Array(await readFile(path.join(root, 'samples', file)));
    const parsedSong = songCore.parseMidi(bytes);
    const songPlan = songCore.convertMidiToSongMaker(bytes, { tempo: parsedSong.sourceTempo, subdivision: 2 });
    assert.ok(songPlan.notes.length > 0, `${file} should contain notes for Song Bridge`);
    assert.ok(songPlan.midi?.length > 0, `${file} should produce Song Maker MIDI`);

    const parsedKtk = ktkCore.parseMidiBytes(bytes);
    const project = ktkCore.convertMidiToKtk(parsedKtk, template, presets, { sourceName: file, instrument: 'pianica', quantization: 'nearest' });
    assert.ok(ktkCore.countProjectNotes(project.project) > 0, `${file} should contain notes for KTK`);
    assert.ok(project.report.lane_count_used >= 1, `${file} should make at least one KTK lane`);
  }
});
