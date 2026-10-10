const PPQN = 480;
const BAR_TICKS = PPQN * 4;
const MIDI_HEADER = [0x4d, 0x54, 0x68, 0x64];
const MIDI_TRACK = [0x4d, 0x54, 0x72, 0x6b];
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
};
const KEYS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const PROGRESSION = { major: [0, 4, 5, 3], minor: [0, 5, 2, 6], pentatonic: [0, 3, 4, 2] };
const PROGRAMS = [0, 4, 10, 11, 24, 40, 48, 73, 80, 88, 91, 104, 11, 46, 52, 74];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function makeRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encodeVlq(input) {
  let value = Math.max(0, Math.floor(input));
  let buffer = value & 0x7f;
  while ((value >>= 7) > 0) buffer = (buffer << 8) | ((value & 0x7f) | 0x80);
  const bytes = [];
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

function metaEvent(kind, payload) {
  return [0xff, kind, ...encodeVlq(payload.length), ...payload];
}

function asciiBytes(text) {
  return [...new TextEncoder().encode(text)];
}

function makeChunk(tag, body) {
  const length = body.length;
  return [...tag, (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255, ...body];
}

function writeTrack(events, endTick) {
  const ordered = [...events, { tick: endTick, priority: 99, data: [0xff, 0x2f, 0] }]
    .sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  const body = [];
  let previous = 0;
  for (const event of ordered) {
    body.push(...encodeVlq(event.tick - previous), ...event.data);
    previous = event.tick;
  }
  return makeChunk(MIDI_TRACK, body);
}

function normalizedSettings(options = {}) {
  const style = ['melody', 'chords', 'ensemble', 'drums', 'polyphony'].includes(options.style) ? options.style : 'melody';
  const scale = Object.hasOwn(SCALES, options.scale) ? options.scale : 'major';
  return {
    style,
    scale,
    key: Math.round(clamp(Number(options.key), 0, 11)),
    tempo: Math.round(clamp(Number(options.tempo), 30, 210)),
    bars: Math.round(clamp(Number(options.bars), 1, 32)),
    density: Math.round(clamp(Number(options.density), 1, 3)),
    trackCount: Math.round(clamp(Number(options.trackCount), 1, 12)),
    seed: Number(options.seed) >>> 0 || 1,
  };
}

function buildPitch(scale, key, degree, octave = 0, base = 60) {
  const pitches = SCALES[scale];
  const scaleIndex = ((degree % pitches.length) + pitches.length) % pitches.length;
  const degreeOctaves = Math.floor(degree / pitches.length);
  return clamp(base + key + pitches[scaleIndex] + (degreeOctaves + octave) * 12, 0, 127);
}

function chordNotes(scale, key, degree, base, start, duration, velocity, trackIndex) {
  return [0, 2, 4].map((offset, index) => ({
    start,
    duration,
    pitch: buildPitch(scale, key, degree + offset, 0, base),
    velocity: Math.max(38, velocity - index * 4),
    trackIndex,
  }));
}

function melodyNotes(settings, random, trackIndex = 0, degreeOffset = 0, octaveOffset = 0) {
  const notes = [];
  const slots = [1, 2, 4][settings.density - 1];
  const slotTicks = BAR_TICKS / slots;
  let previousDegree = 2 + degreeOffset;
  for (let bar = 0; bar < settings.bars; bar += 1) {
    const home = PROGRESSION[settings.scale][bar % 4];
    for (let slot = 0; slot < slots; slot += 1) {
      const probability = [0.76, 0.83, 0.78][settings.density - 1];
      if (random() > probability) continue;
      let degree;
      if (random() < 0.3) degree = home + [0, 2, 4][Math.floor(random() * 3)];
      else degree = previousDegree + Math.floor(random() * 5) - 2;
      degree = clamp(degree, 0, 12) + degreeOffset;
      previousDegree = degree;
      const start = bar * BAR_TICKS + slot * slotTicks;
      const rest = settings.density === 3 ? Math.floor(random() * 3) : 0;
      const duration = Math.max(75, Math.floor(slotTicks * ([0.82, 0.86, 0.78][settings.density - 1]) - rest * 18));
      notes.push({ start, duration, pitch: buildPitch(settings.scale, settings.key, degree, octaveOffset, 60), velocity: Math.round(68 + random() * 25), trackIndex });
    }
  }
  return notes;
}

function compose(settings) {
  const random = makeRandom(settings.seed);
  const tracks = [];
  const makeTrack = (name, channel, program, notes) => tracks.push({ name, channel, program, notes });
  const progression = PROGRESSION[settings.scale];

  if (settings.style === 'melody') {
    makeTrack('Generated Melody', 0, 0, melodyNotes(settings, random));
  } else if (settings.style === 'chords') {
    const notes = [];
    const hitsPerBar = settings.density === 1 ? 1 : 2;
    for (let bar = 0; bar < settings.bars; bar += 1) {
      for (let hit = 0; hit < hitsPerBar; hit += 1) {
        const beat = hit * (4 / hitsPerBar);
        const start = bar * BAR_TICKS + beat * PPQN;
        const duration = Math.max(PPQN, (4 / hitsPerBar) * PPQN - 35);
        const degree = progression[bar % progression.length];
        notes.push(...chordNotes(settings.scale, settings.key, degree, 60, start, duration, 70, 0));
      }
    }
    makeTrack('Chord Progression', 0, 4, notes);
  } else if (settings.style === 'ensemble') {
    makeTrack('Top Line', 0, 0, melodyNotes(settings, random, 0));
    const harmony = [];
    const bass = [];
    for (let bar = 0; bar < settings.bars; bar += 1) {
      const degree = progression[bar % progression.length];
      harmony.push(...chordNotes(settings.scale, settings.key, degree, 60, bar * BAR_TICKS, BAR_TICKS - 40, 52, 1));
      const bassHits = settings.density === 1 ? 1 : 2;
      for (let hit = 0; hit < bassHits; hit += 1) {
        const start = bar * BAR_TICKS + hit * (4 / bassHits) * PPQN;
        bass.push({ start, duration: (4 / bassHits) * PPQN - 40, pitch: buildPitch(settings.scale, settings.key, degree, -2, 36), velocity: 66, trackIndex: 2 });
      }
    }
    makeTrack('Soft Harmony', 1, 48, harmony);
    makeTrack('Bass Line', 2, 32, bass);
  } else if (settings.style === 'drums') {
    const notes = [];
    const hatsPerBar = [4, 8, 16][settings.density - 1];
    for (let bar = 0; bar < settings.bars; bar += 1) {
      for (let beat = 0; beat < 4; beat += 1) {
        const tick = bar * BAR_TICKS + beat * PPQN;
        if (beat === 0 || beat === 2) notes.push({ start: tick, duration: 110, pitch: 36, velocity: 94, trackIndex: 0 });
        if (beat === 1 || beat === 3) notes.push({ start: tick, duration: 110, pitch: 38, velocity: 78, trackIndex: 0 });
      }
      for (let hit = 0; hit < hatsPerBar; hit += 1) {
        notes.push({ start: bar * BAR_TICKS + hit * (BAR_TICKS / hatsPerBar), duration: 60, pitch: 42, velocity: Math.round(40 + random() * 35), trackIndex: 0 });
      }
    }
    makeTrack('Drum Kit', 9, 0, notes);
  } else {
    for (let index = 0; index < settings.trackCount; index += 1) {
      const channel = index < 9 ? index : index + 1;
      const offset = Math.floor(index / 3) * 2;
      const octave = index % 3 === 0 ? 0 : index % 3 === 1 ? -1 : 1;
      makeTrack(`Test Part ${String(index + 1).padStart(2, '0')}`, channel, PROGRAMS[index % PROGRAMS.length], melodyNotes(settings, random, index, offset, octave));
    }
  }
  return tracks;
}

function encodeMidi(tracks, tempo, bars) {
  const format = tracks.length > 1 ? 1 : 0;
  const endTick = bars * BAR_TICKS;
  const conductor = [
    { tick: 0, priority: 0, data: metaEvent(0x03, asciiBytes('MIDI Maker')) },
    { tick: 0, priority: 1, data: metaEvent(0x51, [(Math.round(60_000_000 / tempo) >>> 16) & 255, (Math.round(60_000_000 / tempo) >>> 8) & 255, Math.round(60_000_000 / tempo) & 255]) },
    { tick: 0, priority: 2, data: metaEvent(0x58, [4, 2, 24, 8]) },
  ];
  const noteTracks = tracks.map((track) => {
    const events = [
      { tick: 0, priority: 0, data: metaEvent(0x03, asciiBytes(track.name)) },
      { tick: 0, priority: 1, data: [0xc0 | track.channel, track.program] },
    ];
    for (const note of track.notes) {
      events.push({ tick: note.start, priority: 2, data: [0x90 | track.channel, note.pitch, note.velocity] });
      events.push({ tick: note.start + note.duration, priority: 0, data: [0x80 | track.channel, note.pitch, 0] });
    }
    return writeTrack(events, endTick);
  });
  const chunks = format === 1 ? [writeTrack(conductor, endTick), ...noteTracks] : [
    (() => {
      const allEvents = [...conductor];
      for (const track of tracks) {
        allEvents.push({ tick: 0, priority: 3, data: metaEvent(0x03, asciiBytes(track.name)) });
        allEvents.push({ tick: 0, priority: 4, data: [0xc0 | track.channel, track.program] });
        for (const note of track.notes) {
          allEvents.push({ tick: note.start, priority: 6, data: [0x90 | track.channel, note.pitch, note.velocity] });
          allEvents.push({ tick: note.start + note.duration, priority: 5, data: [0x80 | track.channel, note.pitch, 0] });
        }
      }
      return writeTrack(allEvents, endTick);
    })(),
  ];
  const trackCount = chunks.length;
  const header = [...MIDI_HEADER, 0, 0, 0, 6, (format >>> 8) & 255, format & 255,
    (trackCount >>> 8) & 255, trackCount & 255, (PPQN >>> 8) & 255, PPQN & 255];
  return new Uint8Array([...header, ...chunks.flat()]);
}

/** Build a self-contained Standard MIDI File and its display data. */
export function generateMidi(options = {}) {
  const settings = normalizedSettings(options);
  const tracks = compose(settings);
  const bytes = encodeMidi(tracks, settings.tempo, settings.bars);
  const notes = tracks.flatMap((track, index) => track.notes.map((note) => ({ ...note, trackIndex: index })));
  return {
    bytes,
    notes,
    tracks: tracks.map(({ name, channel, program, notes: trackNotes }) => ({ name, channel, program, noteCount: trackNotes.length })),
    settings: { ...settings, keyName: KEYS[settings.key] },
    stats: {
      noteCount: notes.length,
      trackCount: tracks.length,
      midiFormat: tracks.length > 1 ? 1 : 0,
      durationSeconds: (settings.bars * 4 * 60) / settings.tempo,
      fileSize: bytes.length,
    },
  };
}

export { BAR_TICKS, PPQN, SCALES, KEYS };
