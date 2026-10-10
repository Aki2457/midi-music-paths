import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateMidi } from '../midi-maker/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ktkCore = await import(pathToFileURL(path.join(root, 'ktk-converter/converter-core.js')));
const songCore = await import(pathToFileURL(path.join(root, 'test-support/song-maker-core.mjs')));
const template = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'ktk-converter/assets/template.json'), 'utf8'));
const presets = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'ktk-converter/instrument_presets.json'), 'utf8'));

const cases = [
  ['melody', { style: 'melody', key: 0, scale: 'major', tempo: 96, bars: 4, density: 2, seed: 101 }],
  ['chords', { style: 'chords', key: 7, scale: 'minor', tempo: 84, bars: 4, density: 2, seed: 102 }],
  ['ensemble', { style: 'ensemble', key: 4, scale: 'pentatonic', tempo: 120, bars: 8, density: 3, seed: 103 }],
  ['drums', { style: 'drums', key: 0, scale: 'major', tempo: 110, bars: 2, density: 2, seed: 104 }],
  ['polyphony', { style: 'polyphony', key: 5, scale: 'minor', tempo: 210, bars: 8, density: 2, trackCount: 12, seed: 105 }],
];

test('all MIDI maker shapes are parseable by the KTK and Song Maker cores without losing notes', () => {
  for (const [name, settings] of cases) {
    const generated = generateMidi(settings);
    assert.equal(String.fromCharCode(...generated.bytes.subarray(0, 4)), 'MThd', `${name}: MIDI header`);
    const parsedKtk = ktkCore.parseMidiBytes(generated.bytes);
    const noteCount = parsedKtk.tracks.reduce((total, track) => total + track.notes.length, 0);
    assert.equal(noteCount, generated.stats.noteCount, `${name}: exact note count`);
    const converted = ktkCore.convertMidiToKtk(parsedKtk, template, presets, { instrument: 'pianica' });
    assert.equal(ktkCore.countProjectNotes(converted.project), generated.stats.noteCount, `${name}: KTK retains notes`);
    const song = songCore.convertMidiToSongMakerParts(generated.bytes, { tempo: settings.tempo, subdivision: 2 });
    assert.equal(song.summary.trimmedNotes, 0, `${name}: Song Maker keeps every note`);
    assert.equal(song.summary.sourceNotes, generated.stats.noteCount, `${name}: Song Maker reads every source note`);
    assert.equal(song.parts.reduce((total, part) => total + part.note_count, 0), song.summary.melodyNotes + song.summary.drumNotes, `${name}: exported parts match the deduplicated grid`);
    for (const part of song.parts) assert.equal(songCore.parseMidi(part.midi).notes.length, part.note_count, `${name}: exported part is valid`);
  }
});

test('long preset is split into complete, sequential Song Maker parts', () => {
  const generated = generateMidi({ style: 'ensemble', key: 2, scale: 'minor', tempo: 92, bars: 20, density: 2, seed: 201 });
  const song = songCore.convertMidiToSongMakerParts(generated.bytes, { tempo: 92, subdivision: 2 });
  assert.equal(song.summary.bars, 20);
  assert.deepEqual(song.parts.map((part) => part.bars), [16, 4]);
  assert.equal(song.summary.trimmedNotes, 0);
});

test('generator clamps settings, emits valid single-track Type 0 and multi-track Type 1 files', () => {
  const single = generateMidi({ style: 'melody', tempo: 5, bars: 90, seed: 1 });
  assert.equal(single.settings.tempo, 30);
  assert.equal(single.settings.bars, 32);
  assert.equal(single.stats.midiFormat, 0);
  assert.equal(ktkCore.parseMidiBytes(single.bytes).tracks.length, 1);
  const multiple = generateMidi({ style: 'polyphony', tempo: 210, bars: 1, trackCount: 12, seed: 2 });
  assert.equal(multiple.stats.midiFormat, 1);
  assert.equal(multiple.tracks.length, 12);
  assert.equal(multiple.settings.tempo, 210);
  assert.equal(ktkCore.parseMidiBytes(multiple.bytes).tracks.length, 13); // Conductor plus 12 parts.
});

test('same seed and settings create the same file; a new seed makes a variation', () => {
  const options = { style: 'ensemble', key: 9, scale: 'major', tempo: 98, bars: 4, density: 2, seed: 12345 };
  const first = generateMidi(options);
  const second = generateMidi(options);
  const changed = generateMidi({ ...options, seed: 54321 });
  assert.deepEqual(first.bytes, second.bytes);
  assert.notDeepEqual(first.bytes, changed.bytes);
});
