import { parseMidi } from '../test-support/song-maker-core.mjs';
import { isMidiFilename } from '../ktk-converter/converter-core.js';

const $ = selector => document.querySelector(selector);
const input = $('#midi-file');
const dropzone = $('#dropzone');
const player = $('#player');
const status = $('#status');
const playButton = $('#play-pause');
const stopButton = $('#stop');
const seek = $('#seek');
const speed = $('#speed');
const timeReadout = $('#time-readout');
const canvas = $('#timeline');

let parsed = null;
let notes = [];
let audioContext = null;
let masterGain = null;
let activeSources = new Set();
let scheduleTimer = null;
let animationFrame = null;
let playing = false;
let playhead = 0;
let playbackStartOffset = 0;
let playbackStartedAt = 0;
let playbackRate = 1;
let nextNoteIndex = 0;
let wasPlayingBeforeSeek = false;
let timelineBaseCanvas = null;
let timelineBaseMidi = null;

function showStatus(message, kind = 'info') {
  status.textContent = message;
  status.classList.toggle('error', kind === 'error');
  status.hidden = false;
}
function clearStatus() { status.hidden = true; status.textContent = ''; status.classList.remove('error'); }
function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
function safeStem(name) { return name.replace(/\.midi?$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'MIDI'; }
function addStat(label, value) {
  const card = document.createElement('div');
  card.className = 'stat';
  const strong = document.createElement('b');
  strong.textContent = String(value);
  const caption = document.createElement('span');
  caption.textContent = label;
  card.append(strong, caption);
  return card;
}
function currentPosition() {
  if (!playing || !audioContext) return playhead;
  return Math.min(parsed?.durationSeconds || 0, playbackStartOffset + (audioContext.currentTime - playbackStartedAt) * playbackRate);
}
function updateTransport() {
  if (!parsed) return;
  const position = currentPosition();
  if (!playing) playhead = Math.max(0, Math.min(parsed.durationSeconds, playhead));
  seek.value = String(position);
  timeReadout.value = `${formatTime(position)} / ${formatTime(parsed.durationSeconds)}`;
  timeReadout.textContent = timeReadout.value;
  playButton.textContent = playing ? 'Pause' : 'Play';
  playButton.disabled = false;
  stopButton.disabled = false;
  if (playing && position >= parsed.durationSeconds) finishPlayback();
}
function updateFrame() {
  updateTransport();
  drawTimeline();
  if (playing) animationFrame = requestAnimationFrame(updateFrame);
}
function ensureAudio() {
  if (audioContext) return audioContext;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('This browser does not support Web Audio playback. Try a recent version of Chrome, Edge, Firefox, or Safari.');
  audioContext = new AudioContextClass();
  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 16;
  compressor.ratio.value = 8;
  compressor.connect(audioContext.destination);
  masterGain = audioContext.createGain();
  masterGain.gain.value = 0.68;
  masterGain.connect(compressor);
  return audioContext;
}
function stopScheduledNotes() {
  for (const source of activeSources) {
    try { source.stop(); } catch {}
    try { source.disconnect(); } catch {}
  }
  activeSources.clear();
}
function lowerBoundStart(seconds) {
  let low = 0, high = notes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (notes[middle].startSeconds < seconds) low = middle + 1;
    else high = middle;
  }
  return low;
}
function scheduleNote(note, fromSourceSeconds) {
  const startSeconds = Math.max(note.startSeconds, fromSourceSeconds);
  const endSeconds = note.endSeconds;
  if (endSeconds <= startSeconds) return;

  const context = audioContext;
  const startAt = Math.max(context.currentTime, playbackStartedAt + (startSeconds - playbackStartOffset) / playbackRate);
  const duration = (endSeconds - startSeconds) / playbackRate;
  if (duration <= 0) return;
  const endAt = startAt + duration;
  const attack = Math.min(0.025, duration * 0.25);
  const release = Math.min(0.07, duration * 0.35);
  const releaseStart = Math.max(startAt + attack, endAt - release);
  const velocity = Math.max(1, Math.min(127, note.velocity || 88)) / 127;
  const peak = 0.045 * Math.pow(velocity, 0.72);

  const oscillator = context.createOscillator();
  oscillator.type = 'triangle';
  oscillator.frequency.value = 440 * 2 ** ((note.pitch - 69) / 12);
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 6800;
  filter.Q.value = 0.55;
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0.0001, startAt);
  envelope.gain.linearRampToValueAtTime(peak, startAt + attack);
  envelope.gain.setValueAtTime(peak, releaseStart);
  envelope.gain.linearRampToValueAtTime(0.0001, endAt);
  oscillator.connect(filter);
  filter.connect(envelope);
  envelope.connect(masterGain);
  activeSources.add(oscillator);
  oscillator.addEventListener('ended', () => {
    activeSources.delete(oscillator);
    try { oscillator.disconnect(); filter.disconnect(); envelope.disconnect(); } catch {}
  }, { once: true });
  oscillator.start(startAt);
  oscillator.stop(endAt + 0.005);
}
function scheduleWindow() {
  if (!playing || !audioContext || !parsed) return;
  const now = audioContext.currentTime;
  if (currentPosition() >= parsed.durationSeconds) { finishPlayback(); return; }
  const horizon = playbackStartOffset + (now + 0.34 - playbackStartedAt) * playbackRate;
  while (nextNoteIndex < notes.length && notes[nextNoteIndex].startSeconds <= horizon) {
    const note = notes[nextNoteIndex++];
    if (note.endSeconds > playbackStartOffset) scheduleNote(note, playbackStartOffset);
  }
}
function pausePlayback() {
  if (!playing) return;
  playhead = currentPosition();
  playing = false;
  clearInterval(scheduleTimer);
  scheduleTimer = null;
  stopScheduledNotes();
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  updateTransport();
  drawTimeline();
}
function finishPlayback() {
  playing = false;
  playhead = parsed?.durationSeconds || 0;
  clearInterval(scheduleTimer);
  scheduleTimer = null;
  stopScheduledNotes();
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  updateTransport();
  drawTimeline();
}
function startPlayback(position = playhead) {
  if (!parsed) return;
  const context = ensureAudio();
  context.resume().catch(error => showStatus(`Audio could not start: ${error.message}`, 'error'));
  playhead = Math.max(0, Math.min(parsed.durationSeconds, position));
  if (playhead >= parsed.durationSeconds) playhead = 0;
  stopScheduledNotes();
  clearInterval(scheduleTimer);
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  playbackStartOffset = playhead;
  playbackStartedAt = context.currentTime;
  playbackRate = Number(speed.value) || 1;
  nextNoteIndex = lowerBoundStart(playhead);
  playing = true;
  for (const note of notes) {
    if (note.startSeconds >= playhead) break;
    if (note.endSeconds > playhead) scheduleNote(note, playhead);
  }
  scheduleWindow();
  scheduleTimer = setInterval(scheduleWindow, 55);
  updateTransport();
  animationFrame = requestAnimationFrame(updateFrame);
}
function drawTimeline() {
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.round(box.width * ratio);
  const height = Math.round(box.height * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const w = box.width, h = box.height;
  if (!timelineBaseCanvas || timelineBaseCanvas.width !== width || timelineBaseCanvas.height !== height || timelineBaseMidi !== parsed) {
    timelineBaseCanvas = document.createElement('canvas');
    timelineBaseCanvas.width = width;
    timelineBaseCanvas.height = height;
    timelineBaseMidi = parsed;
    const base = timelineBaseCanvas.getContext('2d');
    base.setTransform(ratio, 0, 0, ratio, 0, 0);
    base.fillStyle = '#ffffff';
    base.fillRect(0, 0, w, h);
    if (parsed && notes.length) {
      const pitches = notes.map(note => note.pitch);
      const low = Math.min(...pitches), high = Math.max(...pitches);
      const span = Math.max(1, high - low + 1);
      base.strokeStyle = '#edf1e8';
      base.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        const y = Math.round(h * i / 5) + 0.5;
        base.beginPath(); base.moveTo(0, y); base.lineTo(w, y); base.stroke();
      }
      for (const note of notes) {
        const x = Math.max(0, note.startSeconds / parsed.durationSeconds * w);
        const noteWidth = Math.max(1, (note.endSeconds - note.startSeconds) / parsed.durationSeconds * w);
        const y = h - ((note.pitch - low + 0.5) / span) * (h - 8) - 4;
        base.fillStyle = note.channel === 9 ? '#a789d5' : '#77a660';
        base.globalAlpha = 0.76;
        base.fillRect(x, Math.max(2, y), noteWidth, Math.max(2, Math.min(7, (h - 8) / span)));
      }
      base.globalAlpha = 1;
    }
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, w, h);
  context.drawImage(timelineBaseCanvas, 0, 0, w, h);
  if (!parsed || !notes.length) return;
  const position = currentPosition();
  const cursorX = Math.max(0, Math.min(w, position / parsed.durationSeconds * w));
  context.strokeStyle = '#e77f5b';
  context.lineWidth = 1.5;
  context.beginPath(); context.moveTo(cursorX, 0); context.lineTo(cursorX, h); context.stroke();
}
function renderStats() {
  const stats = $('#stats');
  stats.replaceChildren(
    addStat('Notes', parsed.notes.length.toLocaleString()),
    addStat('Source tempo', `${parsed.sourceTempo} BPM`),
    addStat('Length', formatTime(parsed.durationSeconds)),
    addStat('Tracks', parsed.trackCount),
  );
}
async function loadFile(file) {
  pausePlayback();
  parsed = null;
  notes = [];
  player.hidden = true;
  clearStatus();
  if (!file) return;
  if (!isMidiFilename(file.name)) {
    input.value = '';
    showStatus('Choose a Standard MIDI file ending in .mid or .midi.', 'error');
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    parsed = parseMidi(bytes);
    notes = parsed.notes.map(note => ({ ...note })).sort((a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch);
    playhead = 0;
    $('#player-title').textContent = safeStem(file.name);
    $('#format-label').textContent = `${parsed.format === 0 ? 'Type 0' : 'Type 1'} · PPQ ${parsed.ppq}`;
    $('#file-note').textContent = `${file.name} · parsed locally and ready to play`;
    seek.min = '0'; seek.max = String(parsed.durationSeconds); seek.step = '0.01'; seek.value = '0';
    playButton.disabled = false; stopButton.disabled = false; seek.disabled = false;
    renderStats();
    player.hidden = false;
    drawTimeline();
    updateTransport();
  } catch (error) {
    parsed = null;
    notes = [];
    input.value = '';
    showStatus(error instanceof Error ? error.message : String(error), 'error');
  }
}

input.addEventListener('change', () => loadFile(input.files?.[0] || null));
dropzone.addEventListener('dragenter', event => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', event => { event.preventDefault(); dropzone.classList.remove('dragging'); });
dropzone.addEventListener('drop', event => {
  event.preventDefault(); dropzone.classList.remove('dragging');
  loadFile(event.dataTransfer?.files?.[0] || null);
});
dropzone.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
});
playButton.addEventListener('click', () => {
  if (playing) { pausePlayback(); return; }
  try { startPlayback(playhead); }
  catch (error) { showStatus(error instanceof Error ? error.message : String(error), 'error'); }
});
stopButton.addEventListener('click', () => {
  pausePlayback();
  playhead = 0;
  updateTransport();
  drawTimeline();
});
seek.addEventListener('pointerdown', () => { wasPlayingBeforeSeek = playing; if (playing) pausePlayback(); });
seek.addEventListener('input', () => {
  playhead = Number(seek.value) || 0;
  updateTransport();
  drawTimeline();
});
seek.addEventListener('change', () => {
  if (wasPlayingBeforeSeek) startPlayback(playhead);
  wasPlayingBeforeSeek = false;
});
speed.addEventListener('input', () => {
  playbackRate = Number(speed.value) || 1;
  $('#speed-readout').value = `${Math.round(playbackRate * 100)}%`;
  $('#speed-readout').textContent = $('#speed-readout').value;
  if (playing) {
    const position = currentPosition();
    pausePlayback();
    startPlayback(position);
  }
});
window.addEventListener('resize', drawTimeline);
