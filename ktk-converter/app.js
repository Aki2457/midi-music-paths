import { ConversionError, parseMidiBytes, convertMidiToKtk, encodeKtk, countProjectNotes, isMidiFilename } from './converter-core.js';

const $ = selector => document.querySelector(selector);
const fileInput = $('#midi-file');
const dropzone = $('#dropzone');
const convertButton = $('#convert');
const instrumentSelect = $('#instrument');
const fallbackSelect = $('#fallback');
const autoOptions = $('#auto-options');
const statusBox = $('#status');
const resultBox = $('#result');
let selectedFile = null;
let converted = null;
let outputNames = null;
let appDataPromise = null;

function loadAppData() {
  if (!appDataPromise) {
    appDataPromise = Promise.all([
      fetch('./assets/template.json').then(response => { if (!response.ok) throw new Error('Could not load the built-in KTK template.'); return response.json(); }),
      fetch('./instrument_presets.json').then(response => { if (!response.ok) throw new Error('Could not load the instrument presets.'); return response.json(); })
    ]).then(([template, presets]) => ({ template, presets }));
  }
  return appDataPromise;
}

function showStatus(message, kind = 'info') {
  statusBox.textContent = message;
  statusBox.classList.toggle('error', kind === 'error');
  statusBox.hidden = false;
}
function clearStatus() { statusBox.hidden = true; statusBox.textContent = ''; statusBox.classList.remove('error'); }
function resetResult() { converted = null; outputNames = null; resultBox.hidden = true; }

function setFile(file) {
  clearStatus();
  resetResult();
  if (!file) return;
  if (!isMidiFilename(file.name)) {
    selectedFile = null;
    fileInput.value = '';
    $('#file-chip').hidden = true;
    $('#file-title').textContent = 'Drop a MIDI file here';
    showStatus('Please choose a Standard MIDI file with a .mid or .midi extension.', 'error');
    convertButton.disabled = true;
    return;
  }
  selectedFile = file;
  $('#file-name').textContent = file.name;
  $('#file-chip').hidden = false;
  $('#file-title').textContent = 'MIDI file selected';
  $('#file-help').textContent = 'Ready to inspect locally · choose an instrument below';
  convertButton.disabled = false;
}

function clearFile(event) {
  event?.stopPropagation();
  selectedFile = null;
  fileInput.value = '';
  $('#file-chip').hidden = true;
  $('#file-title').textContent = 'Drop a MIDI file here';
  $('#file-help').innerHTML = 'or <span class="browse-link">browse files</span> · .mid / .midi';
  convertButton.disabled = true;
  resetResult();
  clearStatus();
}

function updateInstrumentMode() {
  const isAuto = instrumentSelect.value === 'auto';
  autoOptions.hidden = !isAuto;
  $('#instrument-hint').textContent = isAuto
    ? 'Recognition is opt-in and conservative. Only exact configured names or a stable mapped GM program are used; no audio analysis.'
    : 'The selected KTK preset is applied to each note-bearing MIDI track. Program changes are reported, not copied.';
}

function safeStem(name) { return name.replace(/\.midi?$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'converted'; }
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function runConversion() {
  if (!selectedFile) return;
  convertButton.disabled = true;
  resetResult();
  clearStatus();
  showStatus('Reading and converting in this browser…');
  convertButton.querySelector('span').textContent = 'Converting…';
  try {
    const bytes = new Uint8Array(await selectedFile.arrayBuffer());
    const bestEffortNoteRepair = $('#repair').checked;
    const midi = parseMidiBytes(bytes, { bestEffortNoteRepair });
    const { template, presets } = await loadAppData();
    const rawKey = $('#key-number').value.trim();
    const rawTempo = $('#tempo-override').value.trim();
    const rawPitch = $('#pitch-offset').value.trim();
    const options = {
      sourceName: selectedFile.name,
      instrument: instrumentSelect.value,
      instrumentFallback: fallbackSelect.value,
      quantization: $('#exact').checked ? 'exact' : 'nearest',
      bestEffortNoteRepair,
      keyNumber: rawKey === '' ? null : Number(rawKey),
      tempoOverride: $('#tempo-enabled').checked ? Number(rawTempo) : null,
      pitchOffset: rawPitch === '' ? 0 : Number(rawPitch)
    };
    const result = convertMidiToKtk(midi, template, presets, options);
    const ktkBytes = encodeKtk(result.project);
    const stem = safeStem(selectedFile.name);
    converted = { ...result, ktkBytes };
    outputNames = { ktk: `${stem}.ktk`, report: `${stem}.ktk.report.json` };
    const noteCount = countProjectNotes(result.project);
    $('#stats').replaceChildren(...[
      ['Notes', noteCount], ['Active lanes', result.report.lane_count_used], ['Bars', result.report.bar_count],
      ['Output BPM', result.report.tempo.output_bpm]
    ].map(([label, value]) => {
      const card = document.createElement('div'); card.className = 'stat';
      const strong = document.createElement('b'); strong.textContent = String(value);
      const caption = document.createElement('span'); caption.textContent = label;
      card.append(strong, caption); return card;
    }));
    const caveats = [];
    if (result.report.off_grid_start_count || result.report.off_grid_length_count)
      caveats.push(`${result.report.off_grid_start_count} off-grid starts and ${result.report.off_grid_length_count} off-grid lengths rounded to the nearest 192-unit grid.`);
    if (result.report.warnings.length) caveats.push(...result.report.warnings);
    $('#result-caveat').textContent = caveats.length ? caveats.join(' ') : 'No note repairs or timing adjustments were needed. Compatibility remains sample-inferred; see the JSON report for details.';
    resultBox.hidden = false;
    statusBox.hidden = true;
    resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    const message = error instanceof ConversionError || error instanceof Error ? error.message : String(error);
    showStatus(message, 'error');
  } finally {
    convertButton.disabled = !selectedFile;
    convertButton.querySelector('span').textContent = 'Convert to .ktk';
  }
}

function downloadKtk() {
  if (!converted) return;
  downloadBlob(new Blob([converted.ktkBytes], { type: 'application/octet-stream' }), outputNames.ktk);
}
function downloadReport() {
  if (!converted) return;
  const text = JSON.stringify(converted.report, null, 2) + '\n';
  downloadBlob(new Blob([text], { type: 'application/json;charset=utf-8' }), outputNames.report);
}

fileInput.addEventListener('change', () => setFile(fileInput.files?.[0] || null));
dropzone.addEventListener('click', event => {
  if (event.target.closest('#remove-file')) return;
  fileInput.click();
});
dropzone.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
});
$('#remove-file').addEventListener('click', clearFile);
for (const eventName of ['dragenter', 'dragover']) dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.add('dragging'); });
for (const eventName of ['dragleave', 'drop']) dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.remove('dragging'); });
dropzone.addEventListener('drop', event => setFile(event.dataTransfer?.files?.[0] || null));
instrumentSelect.addEventListener('change', updateInstrumentMode);
$('#tempo-enabled').addEventListener('change', event => { $('#tempo-override').disabled = !event.target.checked; });
convertButton.addEventListener('click', runConversion);
$('#download-ktk').addEventListener('click', downloadKtk);
$('#download-report').addEventListener('click', downloadReport);

loadAppData().catch(error => showStatus(error.message, 'error'));
