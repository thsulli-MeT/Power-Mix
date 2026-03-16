"use strict";
const $ = (id)=>document.getElementById(id);

let audioCtx = null;
let unlocked = false;
let masterGain = null;
let masterAnalyser = null;
let recordDest = null;

function clamp01(v){ return Math.max(0, Math.min(1, v)); }
function fmtTime(sec){
  if(!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2,"0")}`;
}

function reverseBuffer(buf){
  const rev = audioCtx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for(let c=0;c<buf.numberOfChannels;c++){
    const src = buf.getChannelData(c);
    const dst = rev.getChannelData(c);
    for(let i=0,j=src.length-1;i<src.length;i++,j--) dst[i] = src[j];
  }
  return rev;
}

class Deck{
  constructor(name){
    this.name = name;
    this.audio = new Audio();
    this.audio.crossOrigin = "anonymous";
    this.audio.preload = "auto";
    this.src = null;
    this.gain = null;
    this.analyser = null;

    this.duration = 0;
    this.waveform = null;
    this.scratchBuffer = null;
    this.scratchBufferRev = null;

    this.platterAngle = 0;
    this.platterVel = 0;
    this.isScratching = false;
  }

  connect(){
    if(this.src) return;
    this.src = audioCtx.createMediaElementSource(this.audio);
    this.gain = audioCtx.createGain();
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.gain.gain.value = 0.9;

    this.src.connect(this.gain);
    this.gain.connect(this.analyser);
    this.analyser.connect(masterGain);
  }

  setGain(v){ if(this.gain) this.gain.gain.value = clamp01(v); }

  async loadFile(file){
    this.audio.src = URL.createObjectURL(file);
    await this.audio.load();
    const ab = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(ab.slice(0));
    this._setDecoded(decoded);
  }

  _setDecoded(decoded){
    this.duration = decoded.duration || 0;
    const ch = decoded.getChannelData(0);
    this.waveform = ch.slice(0, Math.min(ch.length, 1200*600));
    this.scratchBuffer = decoded;
    this.scratchBufferRev = reverseBuffer(decoded);
  }

  tick(dt){
    if(this.isScratching) return;
    const playing = !this.audio.paused;
    const target = playing ? 3.1 : 0;
    this.platterVel += (target - this.platterVel) * Math.min(1, dt*6);
    this.platterAngle += this.platterVel * dt;
  }
}

const deckA = new Deck("A");
const deckB = new Deck("B");

function drawWave(canvas, data, color){
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = "rgba(0,0,0,.2)";
  ctx.fillRect(0,0,w,h);
  if(!data || !data.length) return;
  const step = Math.ceil(data.length / w);
  const amp = h / 2;
  ctx.strokeStyle = color;
  ctx.beginPath();
  for(let x=0;x<w;x++){
    let min=1,max=-1;
    const base = x*step;
    for(let i=0;i<step && base+i<data.length;i++){
      const v = data[base+i];
      if(v<min) min=v;
      if(v>max) max=v;
    }
    ctx.moveTo(x, amp + min*amp);
    ctx.lineTo(x, amp + max*amp);
  }
  ctx.stroke();
}

function playScratchGrain(deck, tSec, direction){
  if(!deck.scratchBuffer || !deck.scratchBufferRev || !audioCtx) return;
  const dur = deck.scratchBuffer.duration || 0;
  if(dur <= 0) return;

  const speed = Math.abs(direction);
  const grainDur = Math.max(0.014, 0.03 - Math.min(0.012, speed * 0.00002));
  const rate = Math.max(0.86, Math.min(1.22, 1 + direction * 0.00034));
  const gainVal = Math.max(0.24, Math.min(0.68, 0.34 + speed * 0.00012));

  const now = audioCtx.currentTime;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(gainVal, now + 0.0035);
  g.gain.exponentialRampToValueAtTime(0.0001, now + grainDur);
  g.connect(masterGain);

  const src = audioCtx.createBufferSource();
  src.playbackRate.value = rate;
  if(direction >= 0){
    src.buffer = deck.scratchBuffer;
    src.start(now, Math.max(0, Math.min(dur-grainDur, tSec)), grainDur);
  }else{
    src.buffer = deck.scratchBufferRev;
    const off = Math.max(0, Math.min(dur-grainDur, (dur - tSec) - grainDur));
    src.start(now, off, grainDur);
  }
  src.connect(g);
  src.stop(now + grainDur + 0.006);
}

function wireScratch(elId, deck){
  const el = $(elId);
  let dragging = false;
  let lastAngle = 0;
  let lastMoveAt = 0;
  let lastSpeed = 0;
  let wasPlaying = false;
  let lastGrainAt = 0;

  const secsPerRad = 0.085;
  const threshold = 0.006;

  const pointerAngle = (e)=>{
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width/2;
    const cy = r.top + r.height/2;
    return Math.atan2(e.clientY - cy, e.clientX - cx);
  };
  const norm = (a)=>{
    if(a > Math.PI) return a - Math.PI*2;
    if(a < -Math.PI) return a + Math.PI*2;
    return a;
  };

  el.addEventListener("pointerdown", (e)=>{
    if(!deck.audio.src) return;
    el.setPointerCapture(e.pointerId);
    dragging = true;
    lastAngle = pointerAngle(e);
    lastMoveAt = performance.now();
    lastSpeed = 0;
    lastGrainAt = 0;
    wasPlaying = !deck.audio.paused;
    deck.isScratching = true;
    deck.audio.pause();
  });

  el.addEventListener("pointermove", (e)=>{
    if(!dragging) return;
    const a = pointerAngle(e);
    const da = norm(a - lastAngle);
    const now = performance.now();
    const dt = Math.max(0.001, (now - lastMoveAt) / 1000);
    lastSpeed = da / dt;

    const dur = deck.duration || deck.audio.duration || 0;
    const t = Math.max(0, Math.min(dur, (deck.audio.currentTime||0) + da * secsPerRad));
    deck.audio.currentTime = t;

    if(Math.abs(da) >= threshold && (now - lastGrainAt) > 8){
      playScratchGrain(deck, t, da * 650);
      lastGrainAt = now;
    }

    deck.platterAngle += da;
    lastMoveAt = now;
    lastAngle = a;
  });

  const end = ()=>{
    if(!dragging) return;
    dragging = false;
    deck.isScratching = false;
    deck.platterVel = Math.max(-14, Math.min(14, lastSpeed*0.3));
    if(wasPlaying) deck.audio.play();
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

function buildMeter(container, count){
  container.innerHTML = "";
  const cells = [];
  for(let i=0;i<count;i++){
    const d = document.createElement("div");
    d.className = "led-cell";
    container.appendChild(d);
    cells.push(d);
  }
  return cells;
}

function paintMeter(cells, norm){
  const on = Math.round(norm * cells.length);
  cells.forEach((c, i)=>{
    c.classList.remove("on","warn","clip");
    if(i < on){
      const high = i > cells.length - 3;
      const mid = i > cells.length - 6;
      c.classList.add(high ? "clip" : mid ? "warn" : "on");
    }
  });
}

function rmsFromAnalyser(analyser){
  if(!analyser) return 0;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for(let i=0;i<data.length;i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

function encodeWav(audioBuffer){
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + length * blockAlign);
  const view = new DataView(buffer);

  const writeStr = (off, str)=>{ for(let i=0;i<str.length;i++) view.setUint8(off+i, str.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + length * blockAlign, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, length * blockAlign, true);

  let offset = 44;
  for(let i=0;i<length;i++){
    for(let c=0;c<channels;c++){
      const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(c)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([buffer], {type:"audio/wav"});
}

const recorder = {
  mediaRecorder: null,
  chunks: [],
  startedAt: 0,
  timer: null,
  timeout: null,
  audio: null,
  url: null,
  maxMs: 180000
};

async function startRecording(){
  if(!audioCtx || !recordDest) return;
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  recorder.chunks = [];
  recorder.mediaRecorder = new MediaRecorder(recordDest.stream, { mimeType: mime });
  recorder.mediaRecorder.ondataavailable = (e)=>{ if(e.data.size) recorder.chunks.push(e.data); };
  recorder.mediaRecorder.onstop = async ()=>{
    const blob = new Blob(recorder.chunks, {type: mime});
    const ab = await blob.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(ab.slice(0));
    const wav = encodeWav(decoded);
    if(recorder.url) URL.revokeObjectURL(recorder.url);
    recorder.url = URL.createObjectURL(wav);
    recorder.audio = new Audio(recorder.url);
    const dl = $("downloadRecord");
    dl.href = recorder.url;
    dl.setAttribute("aria-disabled", "false");
    $("playRecordBtn").disabled = false;
  };

  recorder.mediaRecorder.start(300);
  recorder.startedAt = performance.now();
  $("recordBtn").classList.add("engaged");
  $("stopRecordBtn").disabled = false;
  $("playRecordBtn").disabled = true;
  $("downloadRecord").setAttribute("aria-disabled", "true");

  const tick = ()=>{
    const elapsed = Math.max(0, performance.now() - recorder.startedAt);
    $("recordTimer").textContent = `${fmtTime(elapsed/1000)} / 3:00`;
  };
  tick();
  recorder.timer = setInterval(tick, 250);
  recorder.timeout = setTimeout(stopRecording, recorder.maxMs);
}

function stopRecording(){
  if(!recorder.mediaRecorder || recorder.mediaRecorder.state === "inactive") return;
  recorder.mediaRecorder.stop();
  clearInterval(recorder.timer);
  clearTimeout(recorder.timeout);
  $("recordBtn").classList.remove("engaged");
  $("stopRecordBtn").disabled = true;
}

async function enableAudio(){
  if(unlocked) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1;
  masterAnalyser = audioCtx.createAnalyser();
  masterAnalyser.fftSize = 1024;
  recordDest = audioCtx.createMediaStreamDestination();

  masterGain.connect(masterAnalyser);
  masterAnalyser.connect(audioCtx.destination);
  masterGain.connect(recordDest);

  deckA.connect();
  deckB.connect();

  unlocked = true;
  $("enableAudio").classList.add("engaged");
  $("enableAudio").textContent = "Audio Ready";
}

function wireLoad(buttonId, deck, nameId){
  $(buttonId).addEventListener("click", async ()=>{
    if(!unlocked) await enableAudio();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".wav,.mp3,audio/*";
    input.onchange = async ()=>{
      const file = input.files && input.files[0];
      if(!file) return;
      await deck.loadFile(file);
      $(nameId).textContent = file.name;
      drawWave($(deck===deckA?"waveA":"waveB"), deck.waveform, deck===deckA?"#ff5f6d":"#36d8ff");
    };
    input.click();
  });
}

function wirePlay(buttonId, deck){
  const btn = $(buttonId);
  btn.addEventListener("click", ()=>{
    if(!deck.audio.src) return;
    if(deck.audio.paused){ deck.audio.play(); btn.classList.add("engaged"); }
    else { deck.audio.pause(); btn.classList.remove("engaged"); }
  });
}

function wireMixer(){
  const cross = $("cross");
  const volA = $("volA");
  const volB = $("volB");

  const apply = ()=>{
    const x = parseFloat(cross.value);
    const a = Math.cos(x * Math.PI / 2);
    const b = Math.sin(x * Math.PI / 2);
    deckA.setGain(a * parseFloat(volA.value));
    deckB.setGain(b * parseFloat(volB.value));
  };
  cross.addEventListener("input", apply);
  volA.addEventListener("input", apply);
  volB.addEventListener("input", apply);
  apply();

  $("runTransition").addEventListener("click", ()=>{
    const from = parseFloat(cross.value);
    const to = from < 0.5 ? 1 : 0;
    const start = performance.now();
    const dur = 1300;
    const step = (now)=>{
      const t = Math.min(1, (now-start)/dur);
      cross.value = String(from + (to-from)*t);
      cross.dispatchEvent(new Event("input"));
      if(t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function wireRecording(){
  $("recordBtn").addEventListener("click", async ()=>{
    if(!unlocked) await enableAudio();
    startRecording();
  });
  $("stopRecordBtn").addEventListener("click", stopRecording);
  $("playRecordBtn").addEventListener("click", ()=>{ if(recorder.audio) recorder.audio.play(); });
}

function wire(){
  $("enableAudio").addEventListener("click", enableAudio);
  wireLoad("loadLocalA", deckA, "trackAName");
  wireLoad("loadLocalB", deckB, "trackBName");
  wirePlay("playA", deckA);
  wirePlay("playB", deckB);
  wireScratch("platterA", deckA);
  wireScratch("platterB", deckB);
  wireMixer();
  wireRecording();
}

const meterA = buildMeter($("meterA"), 12);
const meterB = buildMeter($("meterB"), 12);
const meterMaster = buildMeter($("meterMaster"), 24);

let last = performance.now();
function loop(now){
  const dt = Math.min(0.05, (now-last)/1000);
  last = now;
  deckA.tick(dt);
  deckB.tick(dt);

  $("platterA").style.transform = `rotate(${deckA.platterAngle}rad)`;
  $("platterB").style.transform = `rotate(${deckB.platterAngle}rad)`;
  $("timeA").textContent = `${fmtTime(deckA.audio.currentTime)} / ${fmtTime(deckA.duration || deckA.audio.duration || 0)}`;
  $("timeB").textContent = `${fmtTime(deckB.audio.currentTime)} / ${fmtTime(deckB.duration || deckB.audio.duration || 0)}`;

  if(unlocked){
    paintMeter(meterA, Math.min(1, rmsFromAnalyser(deckA.analyser) * 3.4));
    paintMeter(meterB, Math.min(1, rmsFromAnalyser(deckB.analyser) * 3.4));
    paintMeter(meterMaster, Math.min(1, rmsFromAnalyser(masterAnalyser) * 3.6));
  }

  requestAnimationFrame(loop);
}

wire();
requestAnimationFrame(loop);
