const PPQ_OUT = 960;
const MAX_BARS = 16;
const MAX_CONVERSION_BARS = 10000;
const MAX_NOTES = 20000;
const LOWEST_ROOT = 36; // Song Maker's Low octave (C2)
const HIGHEST_ROOT = 71; // Song Maker's High octave (B5)
const RANGE_SEMITONES = 36; // Song Maker range control tops out at three octaves

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readU16(view, offset) { return view.getUint16(offset, false); }
function readU32(view, offset) { return view.getUint32(offset, false); }

function readVlq(bytes, state, end) {
  let value = 0;
  for (let count = 0; count < 4; count += 1) {
    assert(state.pos < end, 'The MIDI file ends inside a variable-length event.');
    const byte = bytes[state.pos++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  throw new Error('The MIDI file contains an invalid variable-length number.');
}

/** Parse ordinary Standard MIDI Files (formats 0 and 1, PPQ timing). */
export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  assert(bytes.length >= 14, 'This file is too short to be a Standard MIDI File.');
  assert(ascii(bytes, 0, 4) === 'MThd', 'This file does not start with the MIDI header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = readU32(view, 4);
  assert(headerLength >= 6 && 8 + headerLength <= bytes.length, 'The MIDI header is malformed.');
  const format = readU16(view, 8);
  const trackCount = readU16(view, 10);
  const division = readU16(view, 12);
  assert(format === 0 || format === 1, 'MIDI type 2 (sequential patterns) is not supported yet. Save this file as type 0 or type 1 and try again.');
  assert((division & 0x8000) === 0 && division > 0, 'SMPTE-timed MIDI is not supported; please use a MIDI file with musical (PPQ) timing.');
  assert(trackCount > 0 && trackCount <= 256, 'The MIDI file has an invalid number of tracks.');

  let offset = 8 + headerLength;
  const notes = [];
  const tempoEvents = [];
  let order = 0;
  let lastTick = 0;

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    assert(offset + 8 <= bytes.length, 'The MIDI file is missing a track.');
    const tag = ascii(bytes, offset, 4);
    assert(tag === 'MTrk', `Track ${trackIndex + 1} is malformed (expected an MTrk chunk).`);
    const trackLength = readU32(view, offset + 4);
    const start = offset + 8;
    const end = start + trackLength;
    assert(end <= bytes.length, `Track ${trackIndex + 1} is truncated.`);
    const state = { pos: start };
    let tick = 0;
    let runningStatus = 0;
    const active = new Map();

    while (state.pos < end) {
      tick += readVlq(bytes, state, end);
      lastTick = Math.max(lastTick, tick);
      assert(state.pos < end, `Track ${trackIndex + 1} ends before its event data.`);
      let status = bytes[state.pos++];
      let firstData = null;
      if (status < 0x80) {
        assert(runningStatus >= 0x80 && runningStatus < 0xf0, `Track ${trackIndex + 1} uses running status without a channel status.`);
        firstData = status;
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      } else if (status !== 0xff) {
        runningStatus = 0;
      }

      if (status === 0xff) {
        assert(state.pos < end, 'The MIDI file has a truncated meta event.');
        const type = bytes[state.pos++];
        const length = readVlq(bytes, state, end);
        assert(state.pos + length <= end, 'The MIDI file has a truncated meta event payload.');
        if (type === 0x51 && length === 3) {
          const micros = (bytes[state.pos] << 16) | (bytes[state.pos + 1] << 8) | bytes[state.pos + 2];
          if (micros > 0) tempoEvents.push({ tick, micros, order: order++ });
        }
        state.pos += length;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const length = readVlq(bytes, state, end);
        assert(state.pos + length <= end, 'The MIDI file has a truncated system-exclusive event.');
        state.pos += length;
        continue;
      }
      if (status >= 0xf0) throw new Error('This MIDI file contains an unsupported system event.');

      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const dataCount = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      const data1 = firstData === null ? bytes[state.pos++] : firstData;
      const data2 = dataCount === 2 ? bytes[state.pos++] : 0;
      assert(state.pos <= end, `Track ${trackIndex + 1} has incomplete channel event data.`);

      if (kind === 0x90 && data2 > 0) {
        const key = `${channel}:${data1}`;
        const queue = active.get(key) || [];
        queue.push({ tick, channel, pitch: data1, velocity: data2, track: trackIndex });
        active.set(key, queue);
      } else if (kind === 0x80 || (kind === 0x90 && data2 === 0)) {
        const key = `${channel}:${data1}`;
        const queue = active.get(key);
        const noteOn = queue?.shift();
        if (noteOn && tick > noteOn.tick) notes.push({ ...noteOn, endTick: tick });
      }
    }

    // Close any unterminated notes at the end of their track, with a short fallback if needed.
    for (const queue of active.values()) {
      for (const noteOn of queue) {
        const endTick = Math.max(lastTick, noteOn.tick + Math.max(1, Math.round(division / 4)));
        if (endTick > noteOn.tick) notes.push({ ...noteOn, endTick });
      }
    }
    offset = end;
  }

  assert(notes.length > 0, 'No playable MIDI notes were found in this file.');
  assert(notes.length <= MAX_NOTES, `This MIDI has more than ${MAX_NOTES.toLocaleString()} notes. Shorten it or export fewer tracks, then try again.`);
  tempoEvents.sort((a, b) => a.tick - b.tick || a.order - b.order);

  // Convert all event ticks to real seconds using the MIDI tempo map.
  const uniqueTempos = [{ tick: 0, micros: 500000 }];
  for (const event of tempoEvents) {
    const last = uniqueTempos[uniqueTempos.length - 1];
    if (event.tick === last.tick) uniqueTempos[uniqueTempos.length - 1] = event;
    else uniqueTempos.push(event);
  }
  const tempoSegments = [];
  let accumulatedSeconds = 0;
  for (let index = 0; index < uniqueTempos.length; index += 1) {
    const event = uniqueTempos[index];
    if (index > 0) {
      const previous = uniqueTempos[index - 1];
      accumulatedSeconds += (event.tick - previous.tick) * previous.micros / 1e6 / division;
    }
    tempoSegments.push({ tick: event.tick, micros: event.micros, seconds: accumulatedSeconds });
  }
  function tickToSeconds(target) {
    let low = 0;
    let high = tempoSegments.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (tempoSegments[middle].tick <= target) low = middle;
      else high = middle - 1;
    }
    const segment = tempoSegments[low];
    return segment.seconds + (target - segment.tick) * segment.micros / 1e6 / division;
  }

  const playableNotes = notes.map(note => ({
    ...note,
    startSeconds: tickToSeconds(note.tick),
    endSeconds: tickToSeconds(note.endTick),
  })).filter(note => note.endSeconds > note.startSeconds);
  const firstTempo = uniqueTempos[0].micros;
  return {
    format,
    ppq: division,
    trackCount,
    tempoEvents: tempoEvents.length,
    sourceTempo: Math.round(60e6 / firstTempo),
    durationSeconds: Math.max(...playableNotes.map(note => note.endSeconds)),
    notes: playableNotes,
  };
}

function nearestAllowedPitch(pitch, rootNote) {
  const highest = rootNote + RANGE_SEMITONES - 1;
  let best = null;
  for (let octave = -12; octave <= 12; octave += 1) {
    const candidate = pitch + octave * 12;
    if (candidate < rootNote || candidate > highest) continue;
    if (best === null || Math.abs(candidate - pitch) < Math.abs(best - pitch) ||
      (Math.abs(candidate - pitch) === Math.abs(best - pitch) && candidate < best)) best = candidate;
  }
  return best;
}

function chooseRootNote(pitches) {
  if (!pitches.length) return 48;
  const ordered = [...pitches].sort((a, b) => a - b);
  const median = ordered[Math.floor(ordered.length / 2)];
  let bestRoot = 48;
  let bestScore = -Infinity;
  for (let root = LOWEST_ROOT; root <= HIGHEST_ROOT; root += 1) {
    const included = pitches.reduce((sum, pitch) => sum + (pitch >= root && pitch < root + RANGE_SEMITONES ? 1 : 0), 0);
    const midpointPenalty = Math.abs(root + (RANGE_SEMITONES - 1) / 2 - median);
    const score = included * 1000 - midpointPenalty;
    if (score > bestScore) { bestScore = score; bestRoot = root; }
  }
  return bestRoot;
}

function roundBpm(value, fallback) {
  const parsed = Number(value);
  const bpm = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(40, Math.min(240, Math.round(bpm)));
}

/** Convert arbitrary MIDI note events to the grid and options Song Maker expects. */
export function convertMidiToSongMaker(input, settings = {}) {
  const parsed = parseMidi(input);
  const maxBars = settings.maxBars === undefined ? MAX_BARS : Number(settings.maxBars);
  assert(Number.isInteger(maxBars) && maxBars >= 1 && maxBars <= MAX_CONVERSION_BARS,
    `The Song Maker conversion must use between 1 and ${MAX_CONVERSION_BARS} bars.`);
  const subdivision = Math.max(1, Math.min(4, Math.round(Number(settings.subdivision) || 4)));
  const beats = Math.max(2, Math.min(7, Math.round(Number(settings.beats) || 4)));
  const requestedTempo = roundBpm(settings.tempo, parsed.sourceTempo);
  const includeDrums = settings.includeDrums !== false;
  const instrument = ['piano', 'marimba', 'synth'].includes(settings.instrument) ? settings.instrument : 'marimba';
  const percussion = ['electronic', 'kit', 'woodblock', 'bongo'].includes(settings.percussion) ? settings.percussion : 'electronic';
  const melodySource = parsed.notes.filter(note => note.channel !== 9);
  const drumSource = includeDrums ? parsed.notes.filter(note => note.channel === 9) : [];
  const rootNote = chooseRootNote(melodySource.map(note => note.pitch));
  const stepsPerBar = beats * subdivision;

  let snappedCount = 0;
  let transposedCount = 0;
  const melodies = melodySource.map(note => {
    const rawStart = note.startSeconds * requestedTempo / 60 * subdivision;
    const rawDuration = (note.endSeconds - note.startSeconds) * requestedTempo / 60 * subdivision;
    const startStep = Math.max(0, Math.round(rawStart));
    const durationSteps = Math.max(1, Math.round(rawDuration));
    if (Math.abs(rawStart - startStep) > 0.015) snappedCount += 1;
    const pitch = nearestAllowedPitch(note.pitch, rootNote);
    if (pitch !== note.pitch) transposedCount += 1;
    return { startStep, durationSteps, pitch, sourcePitch: note.pitch };
  });
  const drums = drumSource.map(note => {
    const rawStart = note.startSeconds * requestedTempo / 60 * subdivision;
    const rawDuration = (note.endSeconds - note.startSeconds) * requestedTempo / 60 * subdivision;
    const lowDrumNotes = new Set([35, 36, 41, 43, 45, 47, 48, 50]);
    return {
      startStep: Math.max(0, Math.round(rawStart)),
      durationSteps: Math.max(1, Math.round(rawDuration)),
      row: lowDrumNotes.has(note.pitch) ? 0 : 1,
    };
  });

  const rawEnd = Math.max(1, ...melodies.map(note => note.startStep + note.durationSteps), ...drums.map(note => note.startStep + note.durationSteps));
  const desiredBars = Math.max(1, Math.ceil(rawEnd / stepsPerBar));
  const bars = Math.min(maxBars, desiredBars);
  const maxSteps = bars * stepsPerBar;
  let trimmedNotes = 0;
  let clippedNotes = 0;
  const trimAndDedupe = (events, keyOf) => {
    const unique = new Map();
    for (const item of events) {
      if (item.startStep >= maxSteps) { trimmedNotes += 1; continue; }
      const endStep = Math.min(maxSteps, item.startStep + item.durationSteps);
      if (endStep < item.startStep + item.durationSteps) clippedNotes += 1;
      const normalized = { ...item, durationSteps: Math.max(1, endStep - item.startStep) };
      const key = keyOf(normalized);
      const prior = unique.get(key);
      if (!prior || normalized.durationSteps > prior.durationSteps) unique.set(key, normalized);
    }
    return [...unique.values()].sort((a, b) => a.startStep - b.startStep || (a.pitch ?? a.row) - (b.pitch ?? b.row));
  };
  const songNotes = trimAndDedupe(melodies, note => `${note.startStep}:${note.pitch}`);
  const percussionNotes = trimAndDedupe(drums, note => `${note.startStep}:${note.row}`);
  const options = {
    bars,
    beats,
    subdivision,
    octaves: 3,
    scale: 'chromatic',
    rootNote,
    rootPitch: rootNote % 12,
    rootOctave: Math.floor(rootNote / 12),
    instrument,
    percussion,
    percussionNotes: 2,
    tempo: requestedTempo,
  };
  const warnings = [];
  if (transposedCount) warnings.push(`${transposedCount} melody note${transposedCount === 1 ? '' : 's'} shifted by octave(s) to fit Song Maker's three-octave grid; pitch classes are preserved.`);
  if (snappedCount) warnings.push(`${snappedCount} note${snappedCount === 1 ? '' : 's'} snapped to the selected ${subdivision}-part beat grid.`);
  if (desiredBars > maxBars) warnings.push(`This conversion allows at most ${maxBars} bars here; later notes were trimmed to the first ${maxBars} bars.`);
  if (trimmedNotes || clippedNotes) warnings.push(`${trimmedNotes} note${trimmedNotes === 1 ? '' : 's'} fell beyond the Song Maker length; ${clippedNotes} note${clippedNotes === 1 ? '' : 's'} were shortened at the end.`);
  if (parsed.tempoEvents > 1) warnings.push('This MIDI has tempo changes. Song Maker uses one tempo, so timing was converted using the tempo map and then fitted to the chosen BPM.');
  if (!songNotes.length && percussionNotes.length) warnings.push('This file only contains percussion notes; Song Maker will show them on its percussion rows.');

  return {
    options,
    notes: songNotes,
    drums: percussionNotes,
    midi: settings.buildMidi === false ? null : createSongMakerMidi({ options, notes: songNotes, drums: percussionNotes, stepsPerBar }),
    summary: {
      sourceNotes: parsed.notes.length,
      melodyNotes: songNotes.length,
      drumNotes: percussionNotes.length,
      sourceTempo: parsed.sourceTempo,
      tempo: requestedTempo,
      bars,
      subdivision,
      transposedNotes: transposedCount,
      snappedNotes: snappedCount,
      trimmedNotes,
      clippedNotes,
      warnings,
    },
  };
}

/** Convert a full song into sequential MIDI files that each respect Song Maker's 16-bar limit. */
export function convertMidiToSongMakerParts(input, settings = {}) {
  const converted = convertMidiToSongMaker(input, { ...settings, maxBars: MAX_CONVERSION_BARS, buildMidi: false });
  const { beats, subdivision } = converted.options;
  const stepsPerBar = beats * subdivision;
  const partCount = Math.max(1, Math.ceil(converted.options.bars / MAX_BARS));
  const parts = [];

  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const startBar = partIndex * MAX_BARS;
    const bars = Math.min(MAX_BARS, converted.options.bars - startBar);
    const startStep = startBar * stepsPerBar;
    const endStep = startStep + bars * stepsPerBar;
    const clip = events => events
      .filter(note => note.startStep < endStep && note.startStep + note.durationSteps > startStep)
      .map(note => {
        const clippedStart = Math.max(note.startStep, startStep);
        const clippedEnd = Math.min(note.startStep + note.durationSteps, endStep);
        return { ...note, startStep: clippedStart - startStep, durationSteps: Math.max(1, clippedEnd - clippedStart) };
      });
    const notes = clip(converted.notes);
    const drums = clip(converted.drums);
    const options = { ...converted.options, bars };
    parts.push({
      part: partIndex + 1,
      total_parts: partCount,
      start_bar: startBar + 1,
      end_bar: startBar + bars,
      bars,
      note_count: notes.length + drums.length,
      options,
      notes,
      drums,
      midi: createSongMakerMidi({ options, notes, drums, stepsPerBar }),
    });
  }

  return {
    options: converted.options,
    summary: { ...converted.summary, partCount, partBars: MAX_BARS },
    warnings: converted.summary.warnings,
    parts,
  };
}

function encodeVlq(value) {
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
  const ordered = [...events].sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  ordered.push({ tick: endTick, priority: 9, data: [0xff, 0x2f, 0x00] });
  const bytes = [];
  let previousTick = 0;
  for (const event of ordered) {
    const tick = Math.max(previousTick, event.tick);
    bytes.push(...encodeVlq(tick - previousTick), ...event.data);
    previousTick = tick;
  }
  return [0x4d, 0x54, 0x72, 0x6b, (bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255, (bytes.length >>> 8) & 255, bytes.length & 255, ...bytes];
}

function createSongMakerMidi({ options, notes, drums }) {
  const { subdivision, tempo, bars, beats, instrument, percussion } = options;
  const ticksPerStep = PPQ_OUT / subdivision;
  const endTick = bars * beats * PPQ_OUT;
  const micros = Math.max(1, Math.round(60e6 / tempo));
  const tempoTrack = makeTrack([{ tick: 0, priority: 0, data: [0xff, 0x51, 0x03, (micros >>> 16) & 255, (micros >>> 8) & 255, micros & 255] }], endTick);
  const program = { piano: 1, marimba: 13, synth: 82 }[instrument] ?? 13;
  const melodyEvents = [{ tick: 0, priority: 1, data: [0xc1, program] }];
  for (const note of notes) {
    const start = note.startStep * ticksPerStep;
    const end = Math.min(endTick, start + note.durationSteps * ticksPerStep);
    melodyEvents.push({ tick: start, priority: 2, data: [0x91, note.pitch, 100] });
    melodyEvents.push({ tick: end, priority: 0, data: [0x81, note.pitch, 0] });
  }
  const melodyTrack = makeTrack(melodyEvents, endTick);
  const percussionEventNotes = {
    electronic: { low: 35, high: 39 },
    kit: { low: 36, high: 38 },
    woodblock: { low: 77, high: 76 },
    bongo: { low: 61, high: 60 },
  }[percussion] ?? { low: 35, high: 39 };
  const drumEvents = [];
  for (const note of drums) {
    const pitch = note.row === 1 ? percussionEventNotes.high : percussionEventNotes.low;
    const start = note.startStep * ticksPerStep;
    const end = Math.min(endTick, start + note.durationSteps * ticksPerStep);
    drumEvents.push({ tick: start, priority: 2, data: [0x99, pitch, 100] });
    drumEvents.push({ tick: end, priority: 0, data: [0x89, pitch, 0] });
  }
  const percussionTrack = makeTrack(drumEvents, endTick);
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, (PPQ_OUT >>> 8) & 255, PPQ_OUT & 255];
  return new Uint8Array([...header, ...tempoTrack, ...melodyTrack, ...percussionTrack]);
}
