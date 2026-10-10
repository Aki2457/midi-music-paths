import { generateMidi } from './core.mjs';

const form = document.querySelector('#settings-form');
const styleField = document.querySelector('#style');
const trackField = document.querySelector('#track-field');
const trackCount = document.querySelector('#track-count');
const downloadButton = document.querySelector('#download');
const variationButton = document.querySelector('#variation');
const status = document.querySelector('#status');
const canvas = document.querySelector('#piano-roll');
const ctx = canvas.getContext('2d');
let currentMidi = null;
let objectUrl = null;
let lastSettings = null;

const presets = {
  melody: { style: 'melody', key: 0, scale: 'major', tempo: 96, bars: 4, density: 2, trackCount: 12 },
  ensemble: { style: 'ensemble', key: 7, scale: 'major', tempo: 108, bars: 8, density: 2, trackCount: 12 },
  long: { style: 'ensemble', key: 2, scale: 'minor', tempo: 92, bars: 20, density: 2, trackCount: 12 },
  slow: { style: 'melody', key: 0, scale: 'minor', tempo: 30, bars: 4, density: 1, trackCount: 12 },
  fast: { style: 'drums', key: 0, scale: 'major', tempo: 210, bars: 8, density: 3, trackCount: 12 },
  tracks: { style: 'polyphony', key: 5, scale: 'pentatonic', tempo: 120, bars: 8, density: 2, trackCount: 12 },
};

function randomSeed() {
  if (globalThis.crypto?.getRandomValues) {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0] || 1;
  }
  return Math.floor(Math.random() * 0xffffffff) || 1;
}

function readSettings() {
  const data = new FormData(form);
  return {
    style: data.get('style'),
    key: Number(data.get('key')),
    scale: data.get('scale'),
    tempo: Number(data.get('tempo')),
    bars: Number(data.get('bars')),
    density: Number(data.get('density')),
    trackCount: Number(data.get('trackCount')),
    seed: randomSeed(),
  };
}

function syncTrackField() {
  const visible = styleField.value === 'polyphony';
  trackField.hidden = !visible;
  trackCount.disabled = !visible;
}

function invalidateResult() {
  currentMidi = null;
  downloadButton.disabled = true;
  status.textContent = 'Settings changed. Generate again to make a MIDI with these choices.';
}

function stat(value, label) {
  const node = document.createElement('div');
  node.className = 'stat';
  const strong = document.createElement('b');
  strong.textContent = value;
  const caption = document.createElement('span');
  caption.textContent = label;
  node.append(strong, caption);
  return node;
}

function paintPreview(midi) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(300, Math.round(rect.width * dpr));
  const height = Math.round(rect.height * dpr);
  canvas.width = width;
  canvas.height = height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = width / dpr;
  const h = height / dpr;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  const left = 27;
  const right = 10;
  const top = 9;
  const bottom = 16;
  const gridW = w - left - right;
  const gridH = h - top - bottom;
  const totalTicks = midi.settings.bars * 1920;
  const pitches = midi.notes.map((note) => note.pitch);
  const low = Math.max(0, Math.min(...pitches, 36) - 2);
  const high = Math.min(127, Math.max(...pitches, 84) + 2);
  const pitchSpan = Math.max(12, high - low);
  const colors = ['#638b56', '#8b74ae', '#d18b69', '#5a8a99', '#a17b4c', '#7b9f87', '#bb7390', '#5872a2', '#8e9a52', '#ad6a52', '#6d927f', '#766086'];
  ctx.font = '8px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let pitch = low; pitch <= high; pitch += 1) {
    const y = top + ((high - pitch) / pitchSpan) * gridH;
    if (pitch % 12 === 0) {
      ctx.strokeStyle = '#e7ece4';
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w - right, y); ctx.stroke();
      ctx.fillStyle = '#899188';
      ctx.fillText(`C${Math.floor(pitch / 12) - 1}`, 5, y);
    }
  }
  for (let bar = 0; bar <= midi.settings.bars; bar += 1) {
    const x = left + (bar / midi.settings.bars) * gridW;
    ctx.strokeStyle = bar === 0 ? '#dfe6dc' : '#edf0eb';
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + gridH); ctx.stroke();
    if (bar < midi.settings.bars && (midi.settings.bars <= 12 || bar % 2 === 0)) {
      ctx.fillStyle = '#a0a89f';
      ctx.fillText(String(bar + 1), x + 3, h - 7);
    }
  }
  for (const note of midi.notes) {
    const x = left + (note.start / totalTicks) * gridW;
    const noteW = Math.max(2, (note.duration / totalTicks) * gridW);
    const y = top + ((high - note.pitch) / pitchSpan) * gridH;
    const noteH = Math.max(3, Math.min(8, gridH / (pitchSpan + 1) * 0.73));
    ctx.fillStyle = colors[note.trackIndex % colors.length];
    ctx.globalAlpha = 0.87;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y - noteH / 2, Math.min(noteW, w - x), noteH, 2);
    else ctx.rect(x, y - noteH / 2, Math.min(noteW, w - x), noteH);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function renderResult(midi) {
  const stats = document.querySelector('#stats');
  stats.replaceChildren(
    stat(String(midi.stats.noteCount), 'notes'),
    stat(`${midi.settings.bars}`, midi.settings.bars === 1 ? 'bar' : 'bars'),
    stat(`${midi.settings.tempo} BPM`, `${midi.settings.keyName} ${midi.settings.scale}`),
    stat(`${Math.round(midi.stats.durationSeconds)} sec`, `${midi.stats.fileSize} bytes`),
  );
  document.querySelector('#format-badge').textContent = `TYPE ${midi.stats.midiFormat}`;
  const trackList = document.querySelector('#track-list');
  trackList.replaceChildren(...midi.tracks.map((track) => {
    const pill = document.createElement('span');
    pill.className = 'track-pill';
    pill.textContent = `${track.name} · ${track.noteCount}`;
    return pill;
  }));
  trackList.hidden = midi.tracks.length < 2;
  paintPreview(midi);
}

function generate(settings = readSettings()) {
  const tempo = Number(document.querySelector('#tempo').value);
  const bars = Number(document.querySelector('#bars').value);
  const count = Number(trackCount.value);
  if (!Number.isInteger(tempo) || tempo < 30 || tempo > 210) {
    document.querySelector('#tempo').focus();
    status.textContent = 'Choose a tempo from 30 to 210 BPM.';
    return;
  }
  if (!Number.isInteger(bars) || bars < 1 || bars > 32) {
    document.querySelector('#bars').focus();
    status.textContent = 'Choose a length from 1 to 32 bars.';
    return;
  }
  if (styleField.value === 'polyphony' && (!Number.isInteger(count) || count < 1 || count > 12)) {
    trackCount.focus();
    status.textContent = 'Choose from 1 to 12 tracks.';
    return;
  }
  lastSettings = { ...settings };
  currentMidi = generateMidi(settings);
  renderResult(currentMidi);
  downloadButton.disabled = false;
  const filename = `midi-maker-${currentMidi.settings.keyName.toLowerCase().replace('♯', 'sharp').replace('♭', 'flat')}-${currentMidi.settings.tempo}bpm-${currentMidi.settings.bars}bars.mid`;
  downloadButton.dataset.filename = filename;
  status.textContent = `${currentMidi.stats.noteCount} notes in ${currentMidi.stats.trackCount} musical ${currentMidi.stats.trackCount === 1 ? 'track' : 'tracks'}. Ready to use in Song Maker, the KTK Converter, or any MIDI player.`;
}

function markChanged() {
  syncTrackField();
  invalidateResult();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  generate();
});
form.addEventListener('change', markChanged);
form.addEventListener('input', markChanged);

document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    const values = presets[button.dataset.preset];
    for (const [name, value] of Object.entries(values)) {
      const input = form.elements.namedItem(name);
      if (input) input.value = String(value);
    }
    syncTrackField();
    generate({ ...values, seed: randomSeed() });
  });
});

downloadButton.addEventListener('click', () => {
  if (!currentMidi) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(new Blob([currentMidi.bytes], { type: 'audio/midi' }));
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = downloadButton.dataset.filename || 'generated-midi.mid';
  document.body.append(link);
  link.click();
  link.remove();
  status.textContent = `Downloaded ${link.download}. Choose it in the MIDI tool you want to test.`;
});

variationButton.addEventListener('click', () => {
  if (lastSettings) generate({ ...lastSettings, seed: randomSeed() });
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (currentMidi) paintPreview(currentMidi); }, 100);
});

syncTrackField();
generate({ style: 'melody', key: 0, scale: 'major', tempo: 96, bars: 4, density: 2, trackCount: 12, seed: randomSeed() });
