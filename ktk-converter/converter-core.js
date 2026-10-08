/* Browser-side port of ktk-midi-converter-v2. No file data leaves this page. */
export class ConversionError extends Error {
  constructor(message) { super(message); this.name = 'ConversionError'; }
}

const MAX_LANES = 8;
const DEFAULT_KTK_TPQ = 192;
const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

export function isMidiFilename(name) { return /\.midi?$/i.test(String(name ?? '')); }

function readVLQ(data, cursor) {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    if (cursor.pos >= data.length) throw new ConversionError('truncated MIDI variable-length quantity');
    const byte = data[cursor.pos++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  throw new ConversionError('MIDI variable-length quantity exceeds four bytes');
}

function hasAscii(data, offset, text) {
  if (offset + text.length > data.length) return false;
  for (let i = 0; i < text.length; i++) if (data[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function readChunk(data, offset, expected) {
  if (offset + 8 > data.length || !hasAscii(data, offset, expected))
    throw new ConversionError(`expected ${expected} chunk`);
  const size = new DataView(data.buffer, data.byteOffset + offset + 4, 4).getUint32(0, false);
  const start = offset + 8;
  const end = start + size;
  if (end > data.length) throw new ConversionError(`truncated ${expected} chunk`);
  return { bytes: data.subarray(start, end), end };
}

function pushRepair(repairs, action) {
  action.repair_index = repairs.length + 1;
  repairs.push(action);
}

export function parseMidiBytes(input, { bestEffortNoteRepair = false } = {}) {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (raw.length < 14 || !hasAscii(raw, 0, 'MThd'))
    throw new ConversionError('not a Standard MIDI file (missing MThd header)');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerLength = view.getUint32(4, false);
  if (headerLength < 6 || 8 + headerLength > raw.length)
    throw new ConversionError('invalid or truncated MIDI header');
  const format = view.getUint16(8, false);
  const trackCount = view.getUint16(10, false);
  const division = view.getUint16(12, false);
  if (![0, 1].includes(format))
    throw new ConversionError('MIDI format 2 is unsupported because its tracks are independent sequences');
  if (division & 0x8000)
    throw new ConversionError('SMPTE-timed MIDI is unsupported; use PPQN (ticks-per-quarter) timing');
  const ppqn = division;
  if (ppqn <= 0) throw new ConversionError('MIDI ticks-per-quarter must be positive');

  let offset = 8 + headerLength;
  const tracks = [];
  const tempos = [];
  const meters = [];
  const keySignatures = [];
  const repairActions = [];

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    const chunk = readChunk(raw, offset, 'MTrk');
    offset = chunk.end;
    const bytes = chunk.bytes;
    const cursor = { pos: 0 };
    let tick = 0;
    let runningStatus = null;
    let name = `Track ${trackIndex + 1}`;
    let instrumentName = '';
    const trackNameEvents = [];
    const instrumentNameEvents = [];
    const opened = new Map();
    const notes = [];
    const programs = [];
    let endOfTrackTick = null;

    while (cursor.pos < bytes.length) {
      tick += readVLQ(bytes, cursor);
      if (cursor.pos >= bytes.length) throw new ConversionError(`truncated event in MIDI track ${trackIndex}`);
      const first = bytes[cursor.pos];
      let status;
      if (first & 0x80) {
        status = first;
        cursor.pos++;
        if (status >= 0x80 && status <= 0xef) runningStatus = status;
      } else {
        if (runningStatus === null)
          throw new ConversionError(`data byte without running status in MIDI track ${trackIndex}`);
        status = runningStatus;
      }

      if (status === 0xff) {
        if (cursor.pos >= bytes.length) throw new ConversionError('truncated MIDI meta event');
        const metaType = bytes[cursor.pos++];
        const size = readVLQ(bytes, cursor);
        const end = cursor.pos + size;
        if (end > bytes.length) throw new ConversionError('truncated MIDI meta payload');
        const payload = bytes.subarray(cursor.pos, end);
        cursor.pos = end;
        if (metaType === 0x03) {
          const decodedName = decoder.decode(payload);
          if (decodedName) { name = decodedName; trackNameEvents.push({ tick, name: decodedName }); }
        } else if (metaType === 0x04) {
          const decodedName = decoder.decode(payload);
          if (decodedName) { instrumentName = decodedName; instrumentNameEvents.push({ tick, name: decodedName }); }
        } else if (metaType === 0x51) {
          if (size !== 3) throw new ConversionError('invalid MIDI tempo meta event');
          const tempo = payload[0] * 65536 + payload[1] * 256 + payload[2];
          if (tempo <= 0) throw new ConversionError('MIDI tempo must be positive');
          tempos.push([tick, tempo]);
        } else if (metaType === 0x58) {
          if (size < 2 || payload[1] > 7) throw new ConversionError('invalid MIDI time-signature meta event');
          meters.push([tick, [payload[0], 2 ** payload[1]]]);
        } else if (metaType === 0x59) {
          if (size < 2) throw new ConversionError('invalid MIDI key-signature meta event');
          const sf = payload[0] < 128 ? payload[0] : payload[0] - 256;
          if (sf < -7 || sf > 7 || ![0, 1].includes(payload[1]))
            throw new ConversionError('invalid MIDI key-signature value');
          keySignatures.push([tick, [sf, payload[1]]]);
        } else if (metaType === 0x2f) {
          if (size !== 0) throw new ConversionError('invalid MIDI end-of-track event');
          endOfTrackTick = tick;
          break;
        }
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const size = readVLQ(bytes, cursor);
        if (cursor.pos + size > bytes.length) throw new ConversionError('truncated MIDI system-exclusive event');
        cursor.pos += size;
        runningStatus = null;
        continue;
      }
      if (status >= 0xf0) {
        const lengths = new Map([[0xf1, 1], [0xf2, 2], [0xf3, 1], [0xf6, 0], [0xf8, 0], [0xf9, 0], [0xfa, 0], [0xfb, 0], [0xfc, 0], [0xfd, 0], [0xfe, 0]]);
        if (!lengths.has(status)) throw new ConversionError(`unsupported MIDI system status 0x${status.toString(16).padStart(2, '0')}`);
        const count = lengths.get(status);
        if (cursor.pos + count > bytes.length) throw new ConversionError('truncated MIDI system event');
        cursor.pos += count;
        if (status < 0xf8) runningStatus = null;
        continue;
      }

      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const count = [0xc0, 0xd0].includes(kind) ? 1 : 2;
      if (cursor.pos + count > bytes.length) throw new ConversionError(`truncated channel event in MIDI track ${trackIndex}`);
      const a = bytes[cursor.pos++];
      const b = count === 2 ? bytes[cursor.pos++] : 0;
      if (a >= 128 || (count === 2 && b >= 128))
        throw new ConversionError('MIDI channel-event data byte has its status bit set');
      if (kind === 0x90 && b > 0) {
        const key = `${channel}:${a}`;
        if (!opened.has(key)) opened.set(key, []);
        opened.get(key).push([tick, b]);
      } else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
        const key = `${channel}:${a}`;
        const queue = opened.get(key) || [];
        if (queue.length === 0) {
          if (!bestEffortNoteRepair)
            throw new ConversionError(`unmatched note-off (track ${trackIndex}, channel ${channel}, pitch ${a}, tick ${tick})`);
          const repairIndex = repairActions.length + 1;
          const sourceEvent = kind === 0x80 ? 'note_off' : 'note_on_velocity_zero';
          const warning = `Ignored unmatched ${sourceEvent} (repair ${repairIndex}) at track ${trackIndex}, channel ${channel}, pitch ${a}, tick ${tick}.`;
          pushRepair(repairActions, { action: 'ignored_unmatched_note_off', track: trackIndex, channel, pitch: a, tick,
            source_event: sourceEvent, source_status: status, release_velocity: b, warning });
          continue;
        }
        const [start, velocity] = queue.shift();
        if (queue.length === 0) opened.delete(key);
        if (tick <= start) throw new ConversionError(`zero/negative note duration (track ${trackIndex}, pitch ${a}, tick ${tick})`);
        notes.push({ track_index: trackIndex, channel, start_tick: start, duration_ticks: tick - start, pitch: a, velocity });
      } else if (kind === 0xc0) {
        programs.push({ tick, channel, program: a });
      }
    }

    const dangling = [...opened.entries()].filter(([, queue]) => queue.length > 0);
    if (dangling.length) {
      if (!bestEffortNoteRepair) throw new ConversionError(`unclosed note-on events in MIDI track ${trackIndex}: ${JSON.stringify(dangling.slice(0, 3))}`);
      if (endOfTrackTick === null)
        throw new ConversionError(`cannot repair unclosed note-on events in MIDI track ${trackIndex}: track has no end-of-track event`);
      for (const [key, queue] of dangling) {
        const [channelText, pitchText] = key.split(':');
        const channel = Number(channelText), pitch = Number(pitchText);
        for (let i = 0; i < queue.length; i++) {
          const [start, velocity] = queue[i];
          const duration = endOfTrackTick - start;
          if (duration <= 0)
            throw new ConversionError(`cannot repair zero/negative note duration (track ${trackIndex}, channel ${channel}, pitch ${pitch}, start tick ${start}, end-of-track tick ${endOfTrackTick})`);
          notes.push({ track_index: trackIndex, channel, start_tick: start, duration_ticks: duration, pitch, velocity });
          const repairIndex = repairActions.length + 1;
          const warning = `Closed open note-on (repair ${repairIndex}) at track ${trackIndex}, channel ${channel}, pitch ${pitch}: start tick ${start}, end-of-track tick ${endOfTrackTick}, repaired duration ${duration} ticks.`;
          pushRepair(repairActions, { action: 'closed_open_note_at_end_of_track', track: trackIndex, channel, pitch,
            start_tick: start, end_of_track_tick: endOfTrackTick, duration_ticks: duration, velocity,
            queue_order: i + 1, warning });
        }
      }
    }
    notes.sort((a, b) => a.start_tick - b.start_tick || a.pitch - b.pitch || a.duration_ticks - b.duration_ticks || a.channel - b.channel);
    tracks.push({ index: trackIndex, name, notes, program_changes: programs, instrument_name: instrumentName,
      track_name_events: trackNameEvents, instrument_name_events: instrumentNameEvents });
  }
  return { format, ppqn, tracks, tempos, meters, key_signatures: keySignatures,
    best_effort_note_repair: bestEffortNoteRepair, repair_actions: repairActions };
}

function valueKey(value) { return JSON.stringify(value); }
function constantGlobal(events, fallback, label) {
  const byTick = new Map();
  for (const [tick, value] of events) {
    if (!byTick.has(tick)) byTick.set(tick, new Map());
    byTick.get(tick).set(valueKey(value), value);
  }
  for (const [tick, values] of byTick) {
    if (values.size > 1) {
      const list = [...values.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      throw new ConversionError(`conflicting ${label} events at MIDI tick ${tick}: ${JSON.stringify(list)}`);
    }
  }
  let current = byTick.has(0) ? [...byTick.get(0).values()][0] : fallback;
  for (const tick of [...byTick.keys()].sort((a, b) => a - b)) {
    const value = [...byTick.get(tick).values()][0];
    if (tick > 0 && valueKey(value) !== valueKey(current))
      throw new ConversionError(`unsupported mid-song ${label} change at MIDI tick ${tick}: ${JSON.stringify(current)} -> ${JSON.stringify(value)}; KTK rule-track serialization for such changes is not verified`);
    current = value;
  }
  return current;
}

function normalizeInstrumentName(name) {
  return String(name).normalize('NFKC').toLowerCase().replaceAll('ß', 'ss').replace(/[^\p{L}\p{N}]/gu, '');
}
function presetAliasMap(presets) {
  const map = new Map();
  for (const [name, preset] of Object.entries(presets)) {
    const recog = preset.auto_recognition || {};
    for (const label of [name, String(preset.programName || ''), ...(recog.aliases || [])]) {
      const normalized = normalizeInstrumentName(label);
      if (normalized) {
        if (!map.has(normalized)) map.set(normalized, new Set());
        map.get(normalized).add(name);
      }
    }
  }
  return map;
}
function gmProgramMap(presets, percussion = false) {
  const key = percussion ? 'gm_percussion_program_changes' : 'gm_program_changes';
  const map = new Map();
  for (const [presetName, preset] of Object.entries(presets)) {
    for (const mapping of (preset.auto_recognition || {})[key] || []) {
      if (!map.has(mapping.program)) map.set(mapping.program, []);
      map.get(mapping.program).push([presetName, mapping.gm_name]);
    }
  }
  return map;
}
function ktkPresetPayload(preset) {
  return Object.fromEntries(Object.entries(preset).filter(([key]) => key !== 'auto_recognition').map(([key, value]) => [key, structuredClone(value)]));
}
function uniqueBy(items, makeKey) {
  const found = new Map();
  for (const item of items) found.set(makeKey(item), item);
  return [...found.values()];
}

function resolveAutoInstrument(track, allTracks, presets, lane, fallback) {
  const aliases = presetAliasMap(presets);
  const gmPrograms = gmProgramMap(presets);
  const gmPercussionPrograms = gmProgramMap(presets, true);
  const labels = [];
  for (const event of track.track_name_events) labels.push({ kind: 'track_name', value: event.name });
  for (const event of track.instrument_name_events) labels.push({ kind: 'instrument_name', value: event.name });
  const defaultName = `Track ${track.index + 1}`;
  if (track.name && (track.name !== defaultName || track.track_name_events.length === 0)) labels.push({ kind: 'track_name', value: track.name });
  if (track.instrument_name && track.instrument_name_events.length === 0) labels.push({ kind: 'instrument_name', value: track.instrument_name });
  const distinctLabels = uniqueBy(labels, x => `${x.kind}\u0000${x.value}`);
  const matchedNameKeys = new Set();
  const matchedNameSources = new Map();
  for (const label of distinctLabels) {
    const matches = aliases.get(normalizeInstrumentName(label.value)) || new Set();
    for (const presetName of matches) {
      matchedNameKeys.add(presetName);
      if (!matchedNameSources.has(presetName)) matchedNameSources.set(presetName, new Set());
      matchedNameSources.get(presetName).add(label.kind);
    }
  }

  const noteChannels = [...new Set(track.notes.map(note => note.channel))].sort((a, b) => a - b);
  const changesByChannel = new Map();
  for (const sourceTrack of allTracks) for (const change of sourceTrack.program_changes) {
    if (!changesByChannel.has(change.channel)) changesByChannel.set(change.channel, []);
    changesByChannel.get(change.channel).push({ ...change, source_track: sourceTrack.index, source_track_name: sourceTrack.name });
  }
  const channelMatches = new Map();
  const channelChangeDetails = [];
  const conflictReasons = [];
  const unknownReasons = [];
  for (const channel of noteChannels) {
    const changes = [...(changesByChannel.get(channel) || [])].sort((a, b) => a.tick - b.tick || a.source_track - b.source_track);
    const programs = [...new Set(changes.map(change => change.program))].sort((a, b) => a - b);
    const detail = { channel, channel_number: channel + 1, program_numbers: programs, program_changes: changes };
    channelChangeDetails.push(detail);
    if (programs.length > 1) {
      conflictReasons.push(`MIDI channel ${channel + 1} changes among Program Change values ${JSON.stringify(programs)}; a KTK lane cannot represent that instrument change over time`);
      continue;
    }
    if (programs.length === 0) { unknownReasons.push(`MIDI channel ${channel + 1} has no Program Change metadata`); continue; }
    const program = programs[0];
    const matches = (channel === 9 ? gmPercussionPrograms : gmPrograms).get(program) || [];
    const matchedKeys = [...new Set(matches.map(match => match[0]))];
    if (matchedKeys.length > 1) conflictReasons.push(`MIDI Program Change ${program} has multiple configured KTK matches ${JSON.stringify(matchedKeys.sort())}`);
    else if (matchedKeys.length === 1) {
      channelMatches.set(channel, matchedKeys[0]);
      detail.gm_program_name = matches[0][1];
      detail.mapped_ktk_preset = matchedKeys[0];
    } else if (channel === 9) unknownReasons.push('MIDI channel 10 is the GM percussion channel; no verified GM-kit-to-KTK preset mapping is configured');
    else unknownReasons.push(`GM Program Change ${program} is not mapped to a verified KTK preset`);
  }
  const pcKeys = new Set(channelMatches.values());
  if (pcKeys.size > 1) conflictReasons.push(`note-bearing MIDI channels identify different KTK presets ${JSON.stringify([...pcKeys].sort())}`);
  if (matchedNameKeys.size > 1) conflictReasons.push(`track/instrument names match different KTK presets ${JSON.stringify([...matchedNameKeys].sort())}`);
  if (matchedNameKeys.size && pcKeys.size && (matchedNameKeys.size !== pcKeys.size || [...matchedNameKeys].some(key => !pcKeys.has(key))))
    conflictReasons.push(`track/instrument name match ${JSON.stringify([...matchedNameKeys].sort())} disagrees with stable GM Program Change match ${JSON.stringify([...pcKeys].sort())}`);

  const uniqueConflicts = [...new Set(conflictReasons)];
  let chosen = null, source = 'fallback', confidence = 'none', reason;
  if (uniqueConflicts.length) reason = uniqueConflicts.join('; ');
  else if (matchedNameKeys.size) {
    chosen = [...matchedNameKeys][0];
    const nameSources = matchedNameSources.get(chosen) || new Set();
    const allChannelsPcMatch = noteChannels.length > 0 && channelMatches.size === noteChannels.length && pcKeys.size === 1 && pcKeys.has(chosen);
    source = allChannelsPcMatch ? 'track/instrument name and GM Program Change' : [...nameSources].sort().join('+');
    confidence = 'high';
    const aliasValues = distinctLabels.filter(label => aliases.has(normalizeInstrumentName(label.value))).map(label => label.value);
    reason = `Exact normalized track/instrument name match for ${JSON.stringify(aliasValues)} selects preset '${chosen}'.`;
    if (allChannelsPcMatch) reason += ' Stable GM Program Change metadata agrees.';
    else if (unknownReasons.length) reason += ` Name match is used; ${[...new Set(unknownReasons)].join('; ')}.`;
  } else if (noteChannels.length && channelMatches.size === noteChannels.length && pcKeys.size === 1) {
    chosen = [...pcKeys][0]; source = 'GM Program Change'; confidence = 'high';
    const names = [...new Set(channelChangeDetails.filter(detail => detail.mapped_ktk_preset === chosen && detail.gm_program_name).map(detail => detail.gm_program_name))].sort();
    reason = `Every note-bearing MIDI channel has one stable, explicitly mapped GM Program Change (${names.join(', ')}); mapped to preset '${chosen}'.`;
  } else {
    reason = [...new Set(unknownReasons)].join('; ') || 'No exact supported instrument name or stable mapped GM Program Change was found.';
    const unmatched = distinctLabels.filter(label => !aliases.has(normalizeInstrumentName(label.value))).map(label => label.value);
    if (unmatched.length) reason += `; track/instrument name(s) ${JSON.stringify(unmatched)} did not match configured aliases`;
  }
  if (chosen === null) {
    if (fallback === 'error')
      throw new ConversionError(`automatic instrument recognition could not select a preset for KTK lane ${lane + 1} (MIDI track ${track.index}): ${reason}. Use an explicit instrument preset or select a configured fallback.`);
    chosen = fallback;
    reason += `; using configured fallback preset '${fallback}'.`;
  }
  return [chosen, { ktk_lane: lane, source_track: track.index, midi_track_name: track.name,
    midi_instrument_name: track.instrument_name, midi_name_labels: distinctLabels, note_channels: noteChannels,
    program_change_channels: channelChangeDetails, detected_midi_source: source, chosen_ktk_preset: chosen,
    confidence, reason }];
}

function quantizeNonnegative(value, multiplier, divisor, mode) {
  const scaled = value * multiplier;
  const quotient = Math.floor(scaled / divisor);
  const remainder = scaled % divisor;
  const exact = remainder === 0;
  if (mode === 'exact' && !exact)
    throw new ConversionError(`MIDI time value ${value} ticks is not exact on the selected ${multiplier}-unit KTK quarter grid with ${divisor} MIDI ticks/quarter; choose nearest timing to allow reported rounding`);
  return [quotient + (remainder * 2 >= divisor ? 1 : 0), exact];
}

export function convertMidiToKtk(midi, template, presets, options = {}) {
  const { sourceName = 'converted.mid', ktkTpq = DEFAULT_KTK_TPQ, pitchOffset = 0,
    quantization = 'nearest', instrument = 'pianica', instrumentFallback = 'pianica',
    keyNumber = null, tempoOverride = null } = options;
  if (!Number.isInteger(ktkTpq) || ktkTpq <= 0) throw new ConversionError('KTK units per quarter must be a positive integer');
  if (!['exact', 'nearest'].includes(quantization)) throw new ConversionError("quantization must be 'exact' or 'nearest'");
  if (instrument !== 'auto' && !Object.hasOwn(presets, instrument))
    throw new ConversionError(`unknown instrument preset '${instrument}'; choose from: ${Object.keys(presets).sort().join(', ')}`);
  if (instrument === 'auto' && instrumentFallback !== 'error' && !Object.hasOwn(presets, instrumentFallback))
    throw new ConversionError(`unknown instrument fallback preset '${instrumentFallback}'; choose from: ${Object.keys(presets).sort().join(', ')}, error`);
  if (!Number.isInteger(pitchOffset)) throw new ConversionError('pitch offset must be an integer number of semitones');
  if (keyNumber !== null && !Number.isInteger(keyNumber)) throw new ConversionError('KTK key number must be an integer');
  if (tempoOverride !== null && (!Number.isInteger(tempoOverride) || tempoOverride < 30 || tempoOverride > 210))
    throw new ConversionError('tempo override must be an integer BPM in the documented KTK range 30–210');

  const activeTracks = midi.tracks.filter(track => track.notes.length > 0);
  if (!activeTracks.length) throw new ConversionError('MIDI contains no completed note events');
  const laneForTrack = new Map();
  const lanePresetNames = new Map();
  const instrumentRecognition = [];
  const presetForTrack = new Map();
  let inactivePresetName, preset;
  if (instrument === 'auto') {
    activeTracks.forEach((track, sourceIndex) => {
      const [selected, recognition] = resolveAutoInstrument(track, midi.tracks, presets, sourceIndex, instrumentFallback);
      presetForTrack.set(track.index, selected);
      instrumentRecognition.push(recognition);
    });
    inactivePresetName = instrumentFallback in presets ? instrumentFallback : presetForTrack.get(activeTracks[0].index);
    preset = null;
  } else {
    activeTracks.forEach(track => presetForTrack.set(track.index, instrument));
    inactivePresetName = instrument;
    preset = ktkPresetPayload(presets[instrument]);
  }
  if (activeTracks.length <= MAX_LANES) {
    activeTracks.forEach((track, lane) => laneForTrack.set(track.index, lane));
  } else if (instrument === 'auto') {
    const tracksByPreset = new Map();
    for (const track of activeTracks) {
      const presetName = presetForTrack.get(track.index);
      if (!tracksByPreset.has(presetName)) tracksByPreset.set(presetName, []);
      tracksByPreset.get(presetName).push(track);
    }
    if (tracksByPreset.size > MAX_LANES)
      throw new ConversionError(`${activeTracks.length} note-bearing tracks resolve to ${tracksByPreset.size} different instruments, exceeding the eight-lane KTK capacity; choose one explicit instrument to combine the tracks, or resolve the MIDI to eight or fewer instrument groups`);
    let lane = 0;
    for (const tracks of tracksByPreset.values()) {
      for (const track of tracks) laneForTrack.set(track.index, lane);
      lanePresetNames.set(lane, presetForTrack.get(tracks[0].index));
      lane++;
    }
  } else {
    activeTracks.forEach((track, sourceIndex) => laneForTrack.set(track.index, sourceIndex % MAX_LANES));
  }
  for (const track of activeTracks) {
    const lane = laneForTrack.get(track.index);
    const selected = presetForTrack.get(track.index);
    if (!lanePresetNames.has(lane)) lanePresetNames.set(lane, selected);
  }
  for (const recognition of instrumentRecognition)
    recognition.ktk_lane = laneForTrack.get(recognition.source_track);
  const activeLaneCount = new Set(laneForTrack.values()).size;

  const tempoUs = constantGlobal(midi.tempos, 500000, 'tempo');
  const meter = constantGlobal(midi.meters, [4, 4], 'time-signature');
  const [numerator, denominator] = meter;
  if (numerator < 1 || numerator > 6 || ![2, 4, 8].includes(denominator))
    throw new ConversionError(`meter ${numerator}/${denominator} is outside the documented KTK meter choices`);
  const bpmExact = 60000000 / tempoUs;
  const sourceBpmRounded = Math.floor(bpmExact + 0.5);
  const bpm = tempoOverride === null ? Math.max(30, Math.min(210, sourceBpmRounded)) : tempoOverride;
  let playbackEffect = 'not overridden', playbackWarning = null;
  if (tempoOverride !== null) {
    if (bpm < bpmExact) {
      playbackEffect = 'slower'; playbackWarning = `Tempo override changes the source tempo from ${bpmExact.toFixed(5)} BPM to ${bpm} BPM; playback will be slower because note ticks are unchanged.`;
    } else if (bpm > bpmExact) {
      playbackEffect = 'faster'; playbackWarning = `Tempo override changes the source tempo from ${bpmExact.toFixed(5)} BPM to ${bpm} BPM; playback will be faster because note ticks are unchanged.`;
    } else {
      playbackEffect = 'unchanged'; playbackWarning = `Tempo override is ${bpm} BPM, matching the source tempo; playback speed is unchanged.`;
    }
  } else if (bpm !== sourceBpmRounded) {
    playbackEffect = bpm < bpmExact ? 'slower' : 'faster';
    playbackWarning = `Source tempo ${bpmExact.toFixed(5)} BPM is outside the documented KTK range 30–210; output was automatically set to ${bpm} BPM. Note ticks were unchanged, so playback will be ${playbackEffect}.`;
  }
  if ((ktkTpq * numerator * 4) % denominator !== 0)
    throw new ConversionError('selected meter does not fit evenly on the configured KTK quarter-note grid');
  const barTicks = ktkTpq * numerator * 4 / denominator;
  const keySignature = constantGlobal(midi.key_signatures, [0, 0], 'key-signature');
  if (midi.key_signatures.length && keyNumber === null)
    throw new ConversionError(`MIDI contains key signature ${JSON.stringify(keySignature)}; KTK keyNumber mapping is not verified. Enter an explicit KTK key number after choosing the intended KTK key.`);
  const keyNumberSource = keyNumber !== null ? 'explicit key-number override' : 'sample-observed default 0; KTK numeric key mapping remains unverified';

  const project = structuredClone(template);
  let safeName = String(sourceName).split(/[\\/]/).pop() || 'converted.mid';
  safeName = safeName.replace(/\.[^.]*$/, '') || safeName;
  project.songName = safeName;
  project.BPM = bpm;
  project.timeSignature = [numerator, denominator];
  project.keyNumber = keyNumber !== null ? keyNumber : 0;

  const laneEvents = new Map(Array.from({ length: MAX_LANES }, (_, lane) => [lane, []]));
  const allNotes = [];
  const eventRecords = [];
  let exactStartCount = 0, exactLengthCount = 0;
  const startErrors = [], lengthErrors = [];
  for (const track of activeTracks) {
    const lane = laneForTrack.get(track.index);
    for (const note of track.notes) {
      const [start, startExact] = quantizeNonnegative(note.start_tick, ktkTpq, midi.ppqn, quantization);
      let [length, lengthExact] = quantizeNonnegative(note.duration_ticks, ktkTpq, midi.ppqn, quantization);
      if (startExact) exactStartCount++;
      if (lengthExact) exactLengthCount++;
      if (length < 1) length = 1;
      const pitch = note.pitch + pitchOffset;
      if (pitch < 0 || pitch > 127)
        throw new ConversionError(`MIDI pitch ${note.pitch} plus configured offset ${pitchOffset} gives ${pitch}, outside 0–127; the accepted KTK pitch range is not fully documented`);
      laneEvents.get(lane).push([start, length, pitch]);
      allNotes.push([lane, start, length, pitch]);
      startErrors.push(Math.abs(start * midi.ppqn - note.start_tick * ktkTpq) / ktkTpq);
      lengthErrors.push(Math.abs(length * midi.ppqn - note.duration_ticks * ktkTpq) / ktkTpq);
      eventRecords.push({ source_track: track.index, source_channel: note.channel, midi_start_tick: note.start_tick,
        midi_duration_ticks: note.duration_ticks, midi_pitch: note.pitch, ktk_lane: lane, ktk_start: start,
        ktk_length: length, ktk_pitch: pitch, velocity_not_stored: note.velocity });
    }
  }
  const lastEnd = Math.max(...allNotes.map(([, start, length]) => start + length));
  const barCount = Math.max(1, Math.ceil(lastEnd / barTicks));
  project.numberOfDisplayedTracks = MAX_LANES;
  project.seqData = Array.from({ length: MAX_LANES }, () => Array.from({ length: barCount }, () => ({ noteData: [] })));
  project.ruleTrackData = Array.from({ length: barCount }, () => ({}));
  project.activeRange = [1, barCount];
  project.activeDetailRange = [1, 1];
  project.loopRange = [1, 1];
  project.activeTrackNumber = 0;
  project.instrumentTracks = [];
  for (let lane = 0; lane < MAX_LANES; lane++) {
    const presetName = lanePresetNames.get(lane) || inactivePresetName;
    const lanePreset = ktkPresetPayload(presets[presetName]);
    lanePreset.instrumentTrackOnOff = lane < activeLaneCount;
    project.instrumentTracks.push(lanePreset);
  }
  for (const [lane, start, length, pitch] of allNotes) {
    const barIndex = Math.floor(start / barTicks);
    const localStart = start % barTicks;
    project.seqData[lane][barIndex].noteData.push({ timing: localStart, length, pitch });
  }
  for (const bars of project.seqData) for (const bar of bars)
    bar.noteData.sort((a, b) => a.timing - b.timing || a.pitch - b.pitch || a.length - b.length);

  const recovered = [];
  for (let lane = 0; lane < project.seqData.length; lane++)
    for (let barIndex = 0; barIndex < project.seqData[lane].length; barIndex++)
      for (const item of project.seqData[lane][barIndex].noteData)
        recovered.push([lane, barIndex * barTicks + item.timing, item.length, item.pitch]);
  const canonical = items => items.map(item => JSON.stringify(item)).sort();
  if (JSON.stringify(canonical(recovered)) !== JSON.stringify(canonical(allNotes)))
    throw new Error('serialized KTK note-event multiset does not match converted MIDI events');

  const maximumError = Math.max(0, ...startErrors, ...lengthErrors);
  const maxErrorMilliseconds = maximumError * tempoUs / midi.ppqn / 1000;
  const programs = midi.tracks.flatMap(track => track.program_changes.map(change => ({ track: track.index, track_name: track.name, ...change })));
  const warnings = [
    ...midi.repair_actions.map(action => action.warning),
    ...(activeTracks.length > activeLaneCount
      ? [`${activeTracks.length} MIDI note-bearing tracks were combined into ${activeLaneCount} KTK lanes to fit the eight-lane format; no note events were discarded, but merged source-track identity is not retained.`]
      : []),
    ...instrumentRecognition.filter(item => item.confidence === 'none').map(item => `KTK lane ${item.ktk_lane + 1} used fallback preset '${item.chosen_ktk_preset}': ${item.reason}`),
    ...(playbackWarning ? [playbackWarning] : [])
  ];
  const report = {
    converter: 'ktk-midi-converter-v2', source_name: String(sourceName).split(/[\\/]/).pop(),
    midi_format: midi.format, midi_ppqn: midi.ppqn, ktk_units_per_quarter: ktkTpq,
    timing_scale_status: 'sample-derived inference; app compatibility is unverified', quantization,
    pitch_mapping: { formula: 'KTK pitch = MIDI note number + pitch_offset', pitch_offset: pitchOffset,
      status: 'identity matches sample-style pitch values and manual C4 naming only provisionally; app round-trip unverified' },
    instrument_preset: instrument, instrument_preset_metadata: preset,
    note_recovery_mode: midi.best_effort_note_repair ? 'best_effort' : 'strict',
    repair_actions: structuredClone(midi.repair_actions), warnings,
    source_tracks: midi.tracks.map(track => ({ track: track.index, name: track.name, note_count: track.notes.length,
      ktk_lane: laneForTrack.has(track.index) ? laneForTrack.get(track.index) : null })),
    source_program_changes_not_applied: instrument !== 'auto' ? programs : [],
    ...(instrument === 'auto' ? { source_program_changes_observed: programs } : {}),
    ...(instrument === 'auto' ? {
      instrument_recognition: { mode: 'auto', fallback_preset: instrumentFallback, lanes: instrumentRecognition },
      lane_instrument_preset_metadata: Object.fromEntries([...lanePresetNames].map(([lane, name]) => [String(lane), ktkPresetPayload(presets[name])]))
    } : {}),
    tempo: { source_microseconds_per_quarter: tempoUs, source_bpm_exact: bpmExact, source_bpm_rounded: sourceBpmRounded,
      output_bpm: bpm, ktk_bpm_integer: bpm, tempo_override_bpm: tempoOverride,
      override_applied: tempoOverride !== null, source_tempo_clamped: tempoOverride === null && bpm !== sourceBpmRounded,
      playback_effect: playbackEffect, playback_warning: playbackWarning,
      output_minus_source_bpm: bpm - bpmExact, rounding_error_bpm: tempoOverride !== null ? null : bpm - sourceBpmRounded,
      source_event_count: midi.tempos.length },
    meter: { numerator, denominator, source_event_count: midi.meters.length },
    key_signature_events: midi.key_signatures.map(([tick, signature]) => ({ tick, sf: signature[0], mode: signature[1] })),
    ktk_key_number: project.keyNumber, ktk_key_number_source: keyNumberSource, note_count: allNotes.length,
    lane_count_used: activeLaneCount, bar_count: barCount,
    lane_merging: { source_track_count: activeTracks.length, lane_count: activeLaneCount,
      merged: activeTracks.length > activeLaneCount,
      strategy: instrument === 'auto' ? 'merge tracks sharing a selected preset when needed' : 'distribute overflow tracks across the eight lanes when needed' },
    off_grid_start_count: startErrors.length - exactStartCount,
    off_grid_length_count: lengthErrors.length - exactLengthCount,
    maximum_absolute_timing_error_midi_ticks: maximumError,
    maximum_absolute_timing_error_milliseconds: maxErrorMilliseconds, notes: eventRecords,
    limitations: [
      'No KTK app round-trip has been performed; timing and pitch interoperability are not confirmed.',
      'KTK noteData does not store MIDI velocity, channel, or track name.',
      ...(activeTracks.length > activeLaneCount ? ['When multiple MIDI tracks share one KTK lane, their original track identity cannot be recovered from the project.'] : []),
      instrument === 'auto'
        ? 'Automatic instrument recognition only uses exact configured names and stable, explicitly mapped GM Program Change values; unrecognized, unsupported percussion, or conflicting metadata uses the configured fallback.'
        : 'One selected KTK preset is applied to all note-bearing lanes; MIDI program changes are reported but not applied.',
      'Mid-song tempo, meter, and key changes are rejected because the sampled KTK rule-track encoding is unverified.',
      'KTK keyNumber mapping is unknown; MIDI key signatures require an explicit key-number override.'
    ]
  };
  if (midi.repair_actions.length)
    report.limitations.push('Best-effort note repair changes malformed MIDI note structure; repaired durations reflect the selected recovery assumptions.');
  return { project, report };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function write16(view, offset, value) { view.setUint16(offset, value, true); }
function write32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
function concatBytes(parts) {
  const size = parts.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/* A minimal standards-compliant ZIP using the STORE method; KTK wraps this ZIP in `ktk `. */
export function encodeKtk(project) {
  const content = encoder.encode(JSON.stringify(project));
  const name = encoder.encode('zipInside');
  const crc = crc32(content);
  const local = new Uint8Array(30 + name.length);
  const localView = new DataView(local.buffer);
  write32(localView, 0, 0x04034b50); write16(localView, 4, 20); write16(localView, 6, 0x0800);
  write16(localView, 8, 0); write16(localView, 10, 0); write16(localView, 12, 0x21);
  write32(localView, 14, crc); write32(localView, 18, content.length); write32(localView, 22, content.length);
  write16(localView, 26, name.length); write16(localView, 28, 0); local.set(name, 30);
  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  write32(centralView, 0, 0x02014b50); write16(centralView, 4, 20); write16(centralView, 6, 20);
  write16(centralView, 8, 0x0800); write16(centralView, 10, 0); write16(centralView, 12, 0); write16(centralView, 14, 0x21);
  write32(centralView, 16, crc); write32(centralView, 20, content.length); write32(centralView, 24, content.length);
  write16(centralView, 28, name.length); write16(centralView, 30, 0); write16(centralView, 32, 0);
  write16(centralView, 34, 0); write16(centralView, 36, 0); write32(centralView, 38, 0); write32(centralView, 42, 0);
  central.set(name, 46);
  const centralOffset = local.length + content.length;
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50); write16(endView, 4, 0); write16(endView, 6, 0);
  write16(endView, 8, 1); write16(endView, 10, 1); write32(endView, 12, central.length);
  write32(endView, 16, centralOffset); write16(endView, 20, 0);
  return concatBytes([encoder.encode('ktk '), local, content, central, end]);
}

export function countProjectNotes(project) {
  return project.seqData.reduce((total, lane) => total + lane.reduce((sum, bar) => sum + (bar.noteData || []).length, 0), 0);
}

export function projectEventMultiset(project, ktkTpq = DEFAULT_KTK_TPQ) {
  const found = new Map();
  const meter = project.timeSignature || [4, 4];
  const barTicks = ktkTpq * meter[0] * 4 / meter[1];
  project.seqData.forEach((lane, laneIndex) => lane.forEach((bar, barIndex) => (bar.noteData || []).forEach(note => {
    const key = JSON.stringify([laneIndex, barIndex * barTicks + note.timing, note.length, note.pitch]);
    found.set(key, (found.get(key) || 0) + 1);
  })));
  return found;
}
