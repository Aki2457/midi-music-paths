import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ktkCore = await import(pathToFileURL(path.join(root, 'ktk-converter/converter-core.js')));
const songCore = await import(pathToFileURL(path.join(root, 'test-support/song-maker-core.mjs')));
const template = JSON.parse(await readFile(path.join(root, 'ktk-converter/assets/template.json'), 'utf8'));
const presets = JSON.parse(await readFile(path.join(root, 'ktk-converter/instrument_presets.json'), 'utf8'));

function vlq(value) {
  let buffer = value & 0x7f;
  const output = [];
  while ((value >>= 7) > 0) { buffer <<= 8; buffer |= (value & 0x7f) | 0x80; }
  while (true) {
    output.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return output;
}
function makeTrack(events, endTick) {
  const ordered = [...events, { tick: endTick, priority: 9, data: [0xff, 0x2f, 0] }]
    .sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  const bytes = [];
  let previousTick = 0;
  for (const event of ordered) {
    bytes.push(...vlq(event.tick - previousTick), ...event.data);
    previousTick = event.tick;
  }
  return [0x4d, 0x54, 0x72, 0x6b, (bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255,
    (bytes.length >>> 8) & 255, bytes.length & 255, ...bytes];
}
function makeMidi({ tracks, ppqn = 96, tempo = 500000 }) {
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, tracks.length === 1 ? 0 : 1,
    (tracks.length >>> 8) & 255, tracks.length & 255, (ppqn >>> 8) & 255, ppqn & 255];
  const chunks = tracks.map((notes, trackIndex) => {
    const events = [];
    if (trackIndex === 0) events.push({ tick: 0, priority: 0, data: [0xff, 0x51, 3, (tempo >>> 16) & 255, (tempo >>> 8) & 255, tempo & 255] });
    for (const note of notes) {
      events.push({ tick: note.start, priority: 2, data: [0x90 | (note.channel || 0), note.pitch, note.velocity ?? 88] });
      events.push({ tick: note.start + note.duration, priority: 0, data: [0x80 | (note.channel || 0), note.pitch, 0] });
    }
    return makeTrack(events, Math.max(1, ...notes.map(note => note.start + note.duration)));
  });
  return new Uint8Array([...header, ...chunks.flat()]);
}

const suppliedNames = [
  'Veritythemesong.mid',
  'SmileSongRemix-TheLivingTombstone(PianoCover).mid',
  'StrangerThingsThemePianoCover.mid',
  'MyLittlePonyFriendshipisMagicMainTheme.mid',
  'FlowingMemories-LM_Productions.mid',
  '2Unlimited-GetReadyforThis(PerfectMidi).mid',
  'Wonderwall-Oasis(full).mid',
  'IrisOut-KenshiYonezu.mid',
];

 test('MIDI filename detection accepts .mid/.midi in either case and rejects partial matches', () => {
  for (const name of ['song.mid', 'SONG.MID', 'song.midi', 'SONG.MIDI']) assert.equal(ktkCore.isMidiFilename(name), true, name);
  for (const name of ['song.mid.txt', 'song.midi2', 'song.mp3', 'midi']) assert.equal(ktkCore.isMidiFilename(name), false, name);
});

test('KTK preserves all note events when 11 source tracks must share eight lanes and clamps 220 BPM', () => {
  const tracks = Array.from({ length: 11 }, (_, index) => [{ start: index * 96, duration: 48, pitch: 48 + index }]);
  const bytes = makeMidi({ tracks, tempo: Math.round(60_000_000 / 220) });
  const parsed = ktkCore.parseMidiBytes(bytes);
  const converted = ktkCore.convertMidiToKtk(parsed, template, presets, { instrument: 'pianica' });
  const expectedNotes = parsed.tracks.reduce((sum, track) => sum + track.notes.length, 0);
  assert.equal(ktkCore.countProjectNotes(converted.project), expectedNotes);
  assert.equal(converted.report.note_count, expectedNotes);
  assert.equal(converted.report.lane_count_used, 8);
  assert.equal(converted.report.lane_merging.merged, true);
  assert.ok(converted.report.source_tracks.every(track => track.ktk_lane >= 0 && track.ktk_lane < 8));
  assert.ok(converted.report.warnings.some(warning => warning.includes('no note events were discarded')));
  assert.equal(converted.project.BPM, 210);
  assert.equal(converted.report.tempo.source_tempo_clamped, true);
  assert.ok(converted.report.warnings.some(warning => warning.includes('automatically set to 210 BPM')));
});

test('long Song Maker exports retain all bars across 16-bar MIDI files, including a sustained note crossing the split', () => {
  const ticksPerBar = 4 * 96;
  const notes = Array.from({ length: 20 }, (_, bar) => ({ start: bar * ticksPerBar, duration: 48, pitch: 60 }));
  notes.push({ start: 15 * ticksPerBar, duration: 6 * ticksPerBar, pitch: 72 });
  const bytes = makeMidi({ tracks: [notes] });
  const converted = songCore.convertMidiToSongMakerParts(bytes, { tempo: 120, beats: 4, subdivision: 2 });
  assert.equal(converted.summary.bars, 21);
  assert.equal(converted.summary.partCount, 2);
  assert.deepEqual(converted.parts.map(part => part.bars), [16, 5]);
  assert.equal(converted.summary.trimmedNotes, 0);
  for (const part of converted.parts) {
    assert.ok(part.bars <= 16);
    assert.equal(songCore.parseMidi(part.midi).notes.length, part.note_count);
  }
  const sustainedFirst = converted.parts[0].notes.find(note => note.pitch === 72);
  const sustainedSecond = converted.parts[1].notes.find(note => note.pitch === 72);
  assert.equal(sustainedFirst.durationSteps, 8);
  assert.equal(sustainedSecond.startStep, 0);
  assert.equal(sustainedSecond.durationSteps, 40);
  assert.equal(converted.parts.reduce((sum, part) => sum + part.note_count, 0), 22);
});

const fixtureDirectory = process.env.MIDI_FIXTURE_DIR;
if (fixtureDirectory && suppliedNames.every(name => existsSync(path.join(fixtureDirectory, name)))) {
  test('all eight supplied MIDI files convert in the KTK, Song Maker-parts, and local playback parsers', async () => {
    for (const name of suppliedNames) {
      const bytes = new Uint8Array(await readFile(path.join(fixtureDirectory, name)));
      const ktkMidi = ktkCore.parseMidiBytes(bytes);
      const sourceNoteCount = ktkMidi.tracks.reduce((sum, track) => sum + track.notes.length, 0);
      const convertedKtk = ktkCore.convertMidiToKtk(ktkMidi, template, presets, { sourceName: name, instrument: 'pianica' });
      assert.equal(ktkCore.countProjectNotes(convertedKtk.project), sourceNoteCount, `${name}: KTK notes`);
      assert.ok(convertedKtk.report.lane_count_used <= 8, `${name}: KTK lanes`);
      assert.ok(convertedKtk.project.BPM >= 30 && convertedKtk.project.BPM <= 210, `${name}: KTK BPM`);

      const playbackMidi = songCore.parseMidi(bytes);
      assert.ok(playbackMidi.notes.length > 0, `${name}: local player notes`);
      const parts = songCore.convertMidiToSongMakerParts(bytes, { tempo: playbackMidi.sourceTempo, subdivision: 2 });
      assert.equal(parts.summary.trimmedNotes, 0, `${name}: Song Maker parts are not truncated`);
      assert.equal(parts.parts.length, Math.ceil(parts.summary.bars / 16), `${name}: expected part count`);
      for (const part of parts.parts) {
        assert.ok(part.bars >= 1 && part.bars <= 16, `${name}: part bar limit`);
        assert.equal(songCore.parseMidi(part.midi).notes.length, part.note_count, `${name}: part is parseable`);
      }
    }
  });
}
