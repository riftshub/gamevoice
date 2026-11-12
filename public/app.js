const $ = id => document.getElementById(id);
let token = '', sequence = 0, stream, context, analyser, timer, calibrationTimer, samples, baseline = .004, threshold = .025, muted = false, busy = false, lastSend = 0, calibrating = false;
const calibrationSamples = [];
function status(text, type = '') { $('status').textContent = text; $('statusLight').className = type; }
function error(text = '') { $('error').textContent = text; }
async function post(path, body, auth) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(7000) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || 'Connection failed'), { status: response.status }); return result;
}
function stopCapture() {
  clearInterval(timer); clearTimeout(calibrationTimer); calibrating = false; $('calibrate').disabled = false; timer = undefined; if (stream) stream.getTracks().forEach(t => t.stop()); stream = undefined;
  if (context) context.close().catch(() => {}); context = undefined; analyser = undefined; muted = false; $('mute').textContent = 'MUTE'; $('level').value = 0; $('db').textContent = '−∞ dB'; $('capture').hidden = true;
}
function disconnect(message = '') {
  stopCapture(); token = ''; sequence = 0; $('pairForm').hidden = false; $('linked').hidden = true; $('disconnect').hidden = true; $('start').hidden = false; status('NOT PAIRED'); error(message);
}
$('pairForm').addEventListener('submit', async event => {
  event.preventDefault(); error(); $('pairButton').disabled = true;
  try { const result = await post('/api/pair', { code: $('code').value }); token = result.deviceToken; sequence = 0; $('pairForm').hidden = true; $('linked').hidden = false; $('disconnect').hidden = false; status('PAIRED / MICROPHONE OFF', 'on'); }
  catch (e) { error(e.message); } finally { $('pairButton').disabled = false; }
});
async function tick() {
  if (!analyser || !token) return;
  analyser.getFloatTimeDomainData(samples);
  let mean = 0; for (const value of samples) mean += value; mean /= samples.length;
  let square = 0; for (const value of samples) square += (value - mean) ** 2;
  const rms = Math.sqrt(square / samples.length); const db = 20 * Math.log10(Math.max(rms, 1e-7));
  $('level').value = muted ? 0 : Math.min(1, rms * 4); $('db').textContent = muted ? 'MUTED' : `${Math.round(db)} dB`;
  if (calibrating) calibrationSamples.push(rms);
  const intensity = muted || calibrating || rms < threshold ? 0 : Math.max(0, Math.min(1, (rms - baseline) / .22));
  $('detection').textContent = muted ? 'MUTED' : calibrating ? 'CALIBRATING' : intensity > .05 ? 'HEARD' : 'QUIET';
  status(muted ? 'MICROPHONE MUTED' : calibrating ? 'MEASURING ROOM NOISE' : intensity > .05 ? 'SOUND DETECTED' : 'VOICE LINK ACTIVE', intensity > .05 ? 'loud' : 'on');
  const time = performance.now();
  if (busy || time - lastSend < (intensity > .05 ? 250 : 2500)) return;
  busy = true; lastSend = time; const currentToken = token;
  try { await post('/api/level', { intensity, sequence: ++sequence }, currentToken); if (currentToken === token) error(); }
  catch (e) { if (currentToken === token) { if (e.status === 401) disconnect('The link expired. Press V in the game for a new code.'); else { status('CONNECTION INTERRUPTED'); error('Reconnecting. In-game sounds still work while the voice link is unavailable.'); } } }
  finally { busy = false; }
}
$('start').addEventListener('click', async () => {
  error(); $('start').disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs HTTPS or localhost in a supported browser.');
    context = new AudioContext(); await context.resume(); stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
    analyser = context.createAnalyser(); analyser.fftSize = 2048; context.createMediaStreamSource(stream).connect(analyser); samples = new Float32Array(analyser.fftSize);
    $('start').hidden = true; $('capture').hidden = false; timer = setInterval(tick, 50); status('VOICE LINK ACTIVE', 'on');
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => disconnect('Microphone access ended. Pair again to reconnect.'));
  } catch (e) { stopCapture(); error(e.name === 'NotAllowedError' ? 'Microphone permission was declined. Allow it in your browser to enable the voice link.' : e.message); }
  finally { $('start').disabled = false; }
});
$('calibrate').addEventListener('click', () => {
  if (calibrating || !analyser || muted) return; calibrating = true; calibrationSamples.length = 0; $('calibrate').disabled = true; $('calibration').textContent = 'Stay quiet for three seconds…';
  calibrationTimer = setTimeout(() => {
    calibrationSamples.sort((a, b) => a - b); baseline = calibrationSamples[Math.floor(calibrationSamples.length * .9)] || .004; threshold = Math.max(.018, baseline * 3.5);
    calibrating = false; $('calibrate').disabled = false; $('calibration').textContent = 'Calibration complete. Speak normally to check the meter.';
  }, 3000);
});
$('mute').addEventListener('click', () => { muted = !muted; if (stream) stream.getAudioTracks().forEach(t => t.enabled = !muted); $('mute').textContent = muted ? 'UNMUTE' : 'MUTE'; lastSend = 0; });
$('disconnect').addEventListener('click', () => disconnect());
window.addEventListener('pagehide', () => stopCapture());
