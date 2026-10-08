import { parseMidi, convertMidiToSongMakerParts } from '../test-support/song-maker-core.mjs';
import { isMidiFilename } from '../ktk-converter/converter-core.js';

const $ = selector => document.querySelector(selector);
const input = $('#midi-file');
const dropzone = $('#dropzone');
const convertButton = $('#convert');
const resultBox = $('#result');
const status = $('#status');
let selectedFile = null;
let midiBytes = null;
let parsed = null;
let converted = null;

function showStatus(message, kind = 'info') {
  status.textContent = message;
  status.classList.toggle('error', kind === 'error');
  status.hidden = false;
}
function clearStatus() { status.hidden = true; status.textContent = ''; status.classList.remove('error'); }
function safeStem(name) { return name.replace(/\.midi?$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'song'; }
function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
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
function downloadMidi(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
function clearResult() {
  converted = null;
  resultBox.hidden = true;
  $('#parts').replaceChildren();
  $('#stats').replaceChildren();
}
function renderResult() {
  const partList = $('#parts');
  partList.replaceChildren();
  $('#stats').replaceChildren(
    addStat('Total bars', converted.summary.bars),
    addStat('Parts', converted.parts.length),
    addStat('Grid notes', converted.summary.melodyNotes + converted.summary.drumNotes),
    addStat('Tempo', `${converted.summary.tempo} BPM`),
  );
  $('#part-count').textContent = `${converted.parts.length} part${converted.parts.length === 1 ? '' : 's'}`;
  converted.parts.forEach(part => {
    const card = document.createElement('article');
    card.className = 'part-card';
    const description = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `Part ${part.part} of ${part.total_parts}`;
    const detail = document.createElement('span');
    detail.textContent = `Bars ${part.start_bar}–${part.end_bar} · ${part.note_count.toLocaleString()} notes`;
    description.append(title, detail);
    const button = document.createElement('button');
    button.className = 'download-button';
    button.type = 'button';
    button.textContent = 'Download .mid';
    button.addEventListener('click', () => {
      const digits = String(part.part).padStart(2, '0');
      downloadMidi(part.midi, `${safeStem(selectedFile.name)}-part-${digits}.mid`);
    });
    card.append(description, button);
    partList.append(card);
  });
  const notes = converted.warnings.length
    ? converted.warnings.join(' ')
    : 'All converted grid notes fit within the exported parts. Bar breaks do not discard later notes.';
  const limitWarning = converted.summary.trimmedNotes
    ? ` This source exceeds the ${converted.summary.bars.toLocaleString()}-bar conversion ceiling; ${converted.summary.trimmedNotes} notes beyond it were omitted.`
    : '';
  $('#conversion-note').textContent = `${notes}${limitWarning}`;
  resultBox.hidden = false;
}
async function loadFile(file) {
  selectedFile = null;
  midiBytes = null;
  parsed = null;
  clearResult();
  clearStatus();
  convertButton.disabled = true;
  if (!file) return;
  if (!isMidiFilename(file.name)) {
    input.value = '';
    $('#file-note').textContent = 'Your file is parsed and converted locally.';
    showStatus('Choose a Standard MIDI file ending in .mid or .midi.', 'error');
    return;
  }
  try {
    midiBytes = new Uint8Array(await file.arrayBuffer());
    parsed = parseMidi(midiBytes);
    selectedFile = file;
    $('#file-note').textContent = `${file.name} · ${parsed.notes.length.toLocaleString()} notes · ${parsed.sourceTempo} BPM · ${formatTime(parsed.durationSeconds)} · parsed on this device`;
    $('#tempo').value = String(Math.max(40, Math.min(240, parsed.sourceTempo)));
    convertButton.disabled = false;
  } catch (error) {
    midiBytes = null;
    parsed = null;
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
convertButton.addEventListener('click', () => {
  if (!midiBytes || !parsed) return;
  convertButton.disabled = true;
  clearResult();
  clearStatus();
  showStatus('Converting the complete song into local MIDI parts…');
  try {
    converted = convertMidiToSongMakerParts(midiBytes, {
      tempo: Number($('#tempo').value),
      beats: Number($('#beats').value),
      subdivision: Number($('#subdivision').value),
    });
    renderResult();
    status.hidden = true;
    resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    convertButton.disabled = !selectedFile;
  }
});
