
"use strict";
const $ = (id)=>document.getElementById(id);

let audioCtx = null;
let unlocked = false;

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function fmtTime(sec){
  if(!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec/60);
  const s = Math.floor(sec%60);
  return `${m}:${String(s).padStart(2,"0")}`;
}

function reverseBuffer(buf){
  const ctx = buf.context || audioCtx;
  const rev = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for(let ch=0; ch<buf.numberOfChannels; ch++){
    const src = buf.getChannelData(ch);
    const dst = rev.getChannelData(ch);
    for(let i=0, j=src.length-1; i<src.length; i++, j--){
      dst[i] = src[j];
    }
  }
  return rev;
}

async function decodeDeckBuffer(deck){
  if(!audioCtx || !deck.audio?.src) return;
  try{
    const res = await fetch(deck.audio.src, {cache:"no-store"});
    const ab = await res.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(ab.slice(0));
    deck.buffer = decoded;
    deck.bufferRev = reverseBuffer(decoded);
  }catch(e){
    // ignore
  }
}


function setMixView(x){
  const fill = $("mixfill");
  if(fill) fill.style.width = `${Math.round(clamp01(x)*100)}%`;
}

function makeImpulse(ctx, seconds, decay){
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for(let ch=0; ch<2; ch++){
    const data = buf.getChannelData(ch);
    for(let i=0;i<len;i++){
      data[i] = (Math.random()*2-1) * Math.pow(1 - i/len, decay);
    }
  }
  return buf;
}

function estimateBPM(samples, sr){
  const hop = 1024;
  const env = [];
  for(let i=0;i<samples.length;i+=hop){
    let sum=0;
    for(let j=0;j<hop && i+j<samples.length;j++){
      const s=samples[i+j];
      sum += s*s;
    }
    env.push(Math.sqrt(sum/hop));
  }
  const mean = env.reduce((a,b)=>a+b,0)/Math.max(1,env.length);
  for(let i=0;i<env.length;i++) env[i]=Math.max(0, env[i]-mean);
  const minBpm=70, maxBpm=160;
  const minLag = Math.floor((60/maxBpm) * (sr/hop));
  const maxLag = Math.floor((60/minBpm) * (sr/hop));
  let bestLag = 0, best = -1;
  for(let lag=minLag; lag<=maxLag; lag++){
    let c=0;
    for(let i=0;i+lag<env.length;i++) c += env[i]*env[i+lag];
    if(c>best){ best=c; bestLag=lag; }
  }
  if(bestLag<=0) return null;
  const bpm = 60 / (bestLag * (hop/sr));
  return Math.round(bpm*10)/10;
}

function drawWave(canvas, buffer, color){
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = "rgba(0,0,0,.12)";
  ctx.fillRect(0,0,w,h);
  if(!buffer || buffer.length<10) return;
  const step = Math.ceil(buffer.length / w);
  const amp = h/2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for(let x=0;x<w;x++){
    let min=1, max=-1;
    const start = x*step;
    for(let i=0;i<step && start+i<buffer.length;i++){
      const v = buffer[start+i];
      if(v<min) min=v;
      if(v>max) max=v;
    }
    ctx.moveTo(x, amp + min*amp);
    ctx.lineTo(x, amp + max*amp);
  }
  ctx.stroke();
}
function drawPlayhead(canvas, t, dur){
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w=canvas.width, h=canvas.height;
  if(!isFinite(t) || !isFinite(dur) || dur<=0) return;
  const x = clamp01(t/dur)*w;
  ctx.strokeStyle = "rgba(255,255,255,.75)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();
}
function drawHotMarks(canvas, hot, dur, rgba){
  if(!canvas || !isFinite(dur) || dur<=0) return;
  const ctx = canvas.getContext("2d");
  const w=canvas.width, h=canvas.height;
  ctx.fillStyle = rgba;
  hot.forEach((t)=>{
    if(t==null) return;
    const x = clamp01(t/dur)*w;
    ctx.fillRect(x-1, 0, 3, h);
  });
}

class Deck {
  constructor(name){
    this.name = name;
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.crossOrigin = "anonymous";
    this.srcNode = null;
    this.gain = null;
    this.filter = null;
    this.echoDelay = null;
    this.echoFB = null;
    this.echoMix = null;
    this.convolver = null;
    this.reverbMix = null;

    this.buffer = null;
    this.duration = 0;
    this.hot = Array(8).fill(null);
    this.bpm = null;

    this.platterAngle = 0;
    this.platterVel = 0;
  }

  connect(){
    if(!audioCtx) return;
    if(this.srcNode) return;

    this.srcNode = audioCtx.createMediaElementSource(this.audio);
    this.gain = audioCtx.createGain();
    this.filter = audioCtx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 20000;

    this.echoDelay = audioCtx.createDelay(1.0);
    this.echoFB = audioCtx.createGain();
    this.echoMix = audioCtx.createGain();
    this.echoDelay.delayTime.value = 0.22;
    this.echoFB.gain.value = 0.35;
    this.echoMix.gain.value = 0.0;

    this.convolver = audioCtx.createConvolver();
    this.reverbMix = audioCtx.createGain();
    this.reverbMix.gain.value = 0.0;
    this.convolver.buffer = makeImpulse(audioCtx, 1.6, 2.0);

    this.srcNode.connect(this.filter);
    this.filter.connect(this.gain);

    this.filter.connect(this.echoDelay);
    this.echoDelay.connect(this.echoFB);
    this.echoFB.connect(this.echoDelay);
    this.echoDelay.connect(this.echoMix);

    this.filter.connect(this.convolver);
    this.convolver.connect(this.reverbMix);

    this.echoMix.connect(this.gain);
    this.reverbMix.connect(this.gain);

    this.gain.connect(audioCtx.destination);
  }

  setGain(v){ if(this.gain) this.gain.gain.value = v; }
  setFilterNorm(v){
    if(!this.filter) return;
    const f = 120 * Math.pow(20000/120, clamp01(v));
    this.filter.frequency.value = f;
  }
  setEchoWet(v){ if(this.echoMix) this.echoMix.gain.value = clamp01(v); }
  setReverbWet(v){ if(this.reverbMix) this.reverbMix.gain.value = clamp01(v); }
  setPlaybackRate(r){ this.audio.playbackRate = r; }

  async loadFromFile(file){
    this.audio.src = URL.createObjectURL(file);
    await this.audio.load();
    if(audioCtx){
      const ab = await file.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(ab.slice(0));
      this._setDecoded(decoded);
    }
  }
  async loadFromUrl(url){
    this.audio.src = url;
    await this.audio.load();
    if(audioCtx){
      const res = await fetch(url);
      const ab = await res.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(ab.slice(0));
      this._setDecoded(decoded);
    }
  }
  _setDecoded(decoded){
    this.duration = decoded.duration || 0;
    const ch0 = decoded.getChannelData(0);
    this.buffer = ch0.slice(0, Math.min(ch0.length, 1200*600));
    this.bpm = estimateBPM(ch0, decoded.sampleRate);
  }
  playPause(){ this.audio.paused ? this.audio.play() : this.audio.pause(); }
  cue(){ /* placeholder */ }

  setHot(i){ this.hot[i] = this.audio.currentTime || 0; }
  jumpHot(i){ const t=this.hot[i]; if(t!=null) this.audio.currentTime = t; }
  clearHot(i){ this.hot[i]=null; }

  tick(dt){
    const playing = !this.audio.paused && isFinite(this.audio.currentTime);
    const baseRps = playing ? (this.audio.playbackRate||1) * 0.55 : 0.0;
    this.platterVel += (baseRps*2*Math.PI - this.platterVel) * Math.min(1, dt*6);
    this.platterAngle += this.platterVel * dt;
  }
}

let deckA = new Deck("A");
let deckB = new Deck("B");
let nextTransitionDir = "AtoB";


const sampleBank = Array(8).fill(null); // {name, buffer}
const sampleVoices = Array(8).fill(null); // {src, gain}

async function loadSampleIntoSlot(slot, file){
  if(!audioCtx) return;
  const ab = await file.arrayBuffer();
  const decoded = await audioCtx.decodeAudioData(ab.slice(0));
  sampleBank[slot] = { name: file.name, buffer: decoded };
  renderSamplePads();
  if(deckA?.audio?.src) decodeDeckBuffer(deckA);
  if(deckB?.audio?.src) decodeDeckBuffer(deckB);
}

function playSample(slot){
  if(!audioCtx) return;
  const s = sampleBank[slot];
  if(!s || !s.buffer) return;

  // toggle off if already playing
  if(sampleVoices[slot]){
    try{ sampleVoices[slot].src.stop(); }catch(_){}
    sampleVoices[slot] = null;
    const pad = document.querySelector(`[data-sample="${slot}"]`);
    if(pad) pad.classList.remove("latched");
    return;
  }

  const src = audioCtx.createBufferSource();
  src.buffer = s.buffer;
  src.loop = true;

  const g = audioCtx.createGain();
  g.gain.value = 0.9;

  src.connect(g);
  g.connect(audioCtx.destination);
  src.start();

  sampleVoices[slot] = {src, gain:g};

  const pad = document.querySelector(`[data-sample="${slot}"]`);
  if(pad) pad.classList.add("latched");

  src.onended = ()=>{
    if(sampleVoices[slot]?.src === src){
      sampleVoices[slot] = null;
      const p = document.querySelector(`[data-sample="${slot}"]`);
      if(p) p.classList.remove("latched");
    }
  };
}

function renderSamplePads(){
  const wrap = $("samplePads");
  if(!wrap) return;
  wrap.innerHTML = "";
  for(let i=0;i<8;i++){
    const pad = document.createElement("button");
    pad.className = `sample-pad pad-${i+1}` + (sampleVoices[i] ? " latched" : "");
    pad.dataset.sample = String(i);
    const label = sampleBank[i]?.name ? sampleBank[i].name.replace(/\.(wav|mp3)$/i,"") : `PAD ${i+1}`;
    pad.textContent = label.length>12 ? label.slice(0,12)+"…" : label;

    pad.title = "Click: toggle play/stop. Shift+Click: assign a local sample";

    pad.addEventListener("click", async (e)=>{
      if(e.altKey){
        if(!manifest) await loadManifest();
        const items = (manifest && Array.isArray(manifest.library)) ? manifest.library : [];
        showPickerPopup(items, "Pick a sample for PAD "+(i+1), async (it)=>{
          if(!unlocked) await enableAudio();
          await loadManifest();
          const url = it.path || it.file;
          const name = it.title || it.name || (url? url.split("/").pop():"sample");
          await loadSampleFromURL(i, url, name);
        });
        return;
      }

      if(e.shiftKey){
        const input=document.createElement("input");
        input.type="file"; input.accept=".wav,.mp3,audio/*";
        input.onchange = async ()=>{
          const file=input.files && input.files[0];
          if(!file) return;
          if(!unlocked) await enableAudio();
          await loadSampleIntoSlot(i, file);
        };
        input.click();
        return;
      }
      if(!unlocked) await enableAudio();
      playSample(i);
      renderSamplePads();
    });

    wrap.appendChild(pad);
  }

  const noteId = "sampleNote";
  if(!$(noteId)){
    const n = document.createElement("div");
    n.id = noteId;
    n.className = "sample-note";
    n.textContent = "Power Mix-Beta
HOW TO USE YOUR OWN TRACKS
Shift+Click on the Sample or Track Load button and locate the .wav or .mp3 from your machine.

BASIC DJ STRATEGIES
1) Power Transitions (why they exist)
No beatmatch yet — the Power Mix Transitions are built to make swaps feel musical without BPM matching. Try them when both decks are playing.

2) Timeline Jump (the secret weapon)
Click the waveform to instantly jump to any moment. Use it to skip intros, jump to a drop, or recover fast if you miss a cue.

3) Hot Spots as “moment samples” (your discovery)
Set Hot Spots on a hit/word/drum fill. Jump to it live like a sample, then release back into the track when you’re done.

4) Chase Mix (same track, two decks)
Load the same track on A and B. Use crossfader + Hot Spots to bounce between them for motion, stutters, and call/response.

5) Echo/Space Fade (smooth exits)
Tap ECHO or SPACE on the outgoing deck, then fade it down/cross out. It leaves a tail so the cut doesn’t feel harsh.

6) “Cut Drop” — line up B at a strong moment, then CUT on the beat.

CHECK BACK FOR MORE OPTIONS CONTROLS AND FEATURES- Scratching, recording , sharing. 
SUBSCRIBE and by some Merch to keep this machine a rollin.";
    wrap.parentElement?.appendChild(n);
  }
}

const PRESETS = [
  {label:"AIR",   bg:"linear-gradient(90deg,#35d7ff,#b24bff)", filt:.85, echo:0,   rev:0},
  {label:"SUB",   bg:"linear-gradient(90deg,#ff4b4b,#ffb14b)", filt:.18, echo:0,   rev:0},
  {label:"ECHO",  bg:"linear-gradient(90deg,#f2ff4b,#35d7ff)", filt:.55, echo:.65, rev:0},
  {label:"HALL",  bg:"linear-gradient(90deg,#b24bff,#35d7ff)", filt:.70, echo:0,   rev:.65},
  {label:"SWEEP", bg:"linear-gradient(90deg,#37ff7a,#35d7ff)", filt:.92, echo:.18, rev:.05},
  {label:"WARM",  bg:"linear-gradient(90deg,#ff8a00,#ff4b4b)", filt:.62, echo:0,   rev:.18},
  {label:"SPACE", bg:"linear-gradient(90deg,#d8a6ff,#35d7ff)", filt:.72, echo:.22, rev:.78},
  {label:"CUT",   bg:"linear-gradient(90deg,#5b7cff,#35d7ff)", filt:.10, echo:0,   rev:0},
];

function buildFx(containerId, which){
  const wrap = $(containerId);
  if(!wrap) return;
  wrap.innerHTML = "";
  PRESETS.forEach((p, idx)=>{
    const b=document.createElement("button");
    b.className="fxbtn";
    b.textContent=p.label;
    b.style.background=p.bg;
    b.style.color="rgba(0,0,0,.82)";
    b.dataset.on="0";
    b.addEventListener("click", ()=>{
      const deck = (which==="A") ? deckA : deckB;
      const wasOn = b.dataset.on==="1";
      wrap.querySelectorAll(".fxbtn").forEach(x=>{ x.dataset.on="0"; x.classList.remove("latched"); });
      if(wasOn){
        deck.setFilterNorm(1.0); deck.setEchoWet(0.0); deck.setReverbWet(0.0);
        return;
      }
      b.dataset.on="1"; b.classList.add("latched");
      deck.setFilterNorm(p.filt); deck.setEchoWet(p.echo); deck.setReverbWet(p.rev);
    });
    wrap.appendChild(b);
  });
}

function buildHot(containerId, which){
  const wrap = $(containerId);
  if(!wrap) return;
  wrap.innerHTML="";
  for(let i=0;i<8;i++){
    const btn=document.createElement("button");
    btn.className=`hot-btn hot-${i+1}`;
    btn.textContent=String(i+1);

    const x=document.createElement("span");
    x.className="hs-x"; x.textContent="×";
    btn.appendChild(x);

    const refresh = ()=>{
      const deck = (which==="A") ? deckA : deckB;
      btn.classList.toggle("is-set", deck.hot[i]!=null);
    };

    btn.addEventListener("click",(e)=>{
      const deck = (which==="A") ? deckA : deckB;
      if(e.target && e.target.classList && e.target.classList.contains("hs-x")){
        deck.clearHot(i); refresh(); return;
      }
      if(e.shiftKey){ deck.clearHot(i); refresh(); return; }
      if(deck.hot[i]==null) deck.setHot(i);
      else deck.jumpHot(i);
      refresh();
    });

    wrap.appendChild(btn);
  }
}

async function enableAudio(){
  if(unlocked) return;
  audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  await audioCtx.resume();
  deckA.connect();
  deckB.connect();
  unlocked = true;
  if(!manifest) await loadManifest();
  try{
    if(manifest?.preload?.A) await deckA.loadFromUrl(encodeURI(manifest.preload.A));
    if(manifest?.preload?.B) await deckB.loadFromUrl(encodeURI(manifest.preload.B));
  }catch(e){ console.warn("Deck preload failed", e); }
  initSamplesFromManifest();
  try{ await preloadSamplesFromManifest(); }catch(e){ console.warn("Sample preload failed", e); }

  const btn = $("enableAudio");
  if(btn){
    btn.classList.remove("flash-until-enabled");
    btn.textContent="Audio Enabled";
    // after unlocking audio, preload decks & samples
    if(!manifest) await loadManifest();
    try{
      if(manifest?.preload?.A) await loadTrackToDeck(manifest.preload.A, "A");
      if(manifest?.preload?.B) await loadTrackToDeck(manifest.preload.B, "B");
      initSamplesFromManifest();
      await preloadSamplesFromManifest();
    }catch(e){ console.warn("Preload failed", e); }

  }
  const hint = document.querySelector(".start-hint");
  if(hint) hint.textContent = "Audio ready";
  loadManifest().then(()=>preloadFromManifest());
  renderSamplePads();
}

function redraw(){
  const cA=$("waveA"), cB=$("waveB");
  if(cA){ cA.width = Math.max(600, Math.floor(cA.clientWidth))*2; cA.height = 160; }
  if(cB){ cB.width = Math.max(600, Math.floor(cB.clientWidth))*2; cB.height = 160; }
  drawWave(cA, deckA.buffer, "rgba(255,75,75,.95)");
  drawWave(cB, deckB.buffer, "rgba(53,215,255,.95)");
}

function overlays(){
  const cA=$("waveA"), cB=$("waveB");
  drawWave(cA, deckA.buffer, "rgba(255,75,75,.95)");
  drawWave(cB, deckB.buffer, "rgba(53,215,255,.95)");
  drawHotMarks(cA, deckA.hot, deckA.duration || deckA.audio.duration || 0, "rgba(255,255,255,.35)");
  drawHotMarks(cB, deckB.hot, deckB.duration || deckB.audio.duration || 0, "rgba(255,255,255,.35)");
  drawPlayhead(cA, deckA.audio.currentTime, deckA.duration || deckA.audio.duration || 0);
  drawPlayhead(cB, deckB.audio.currentTime, deckB.duration || deckB.audio.duration || 0);
}



function playScratchGrain(deck, tSec, direction){
  if(!audioCtx || !deck.buffer || !deck.bufferRev) return;
  const dur = deck.buffer.duration || 0;
  if(dur<=0) return;

  const grainDur = 0.04; // 40ms
  const rate = 1.0 + Math.min(2.5, Math.abs(direction)*0.02);
  const gainVal = 0.6;

  const g = audioCtx.createGain();
  g.gain.value = gainVal;
  g.connect(audioCtx.destination);

  const src = audioCtx.createBufferSource();
  src.playbackRate.value = rate;

  if(direction >= 0){
    src.buffer = deck.buffer;
    const offset = Math.max(0, Math.min(dur - grainDur, tSec));
    src.connect(g);
    src.start(0, offset, grainDur);
  }else{
    src.buffer = deck.bufferRev;
    const revOffset = Math.max(0, Math.min(dur - grainDur, (dur - tSec) - grainDur));
    src.connect(g);
    src.start(0, revOffset, grainDur);
  }
}

let manifest = null;

async function loadManifest(){
  try{
    const res = await fetch("audio/library.json", {cache:"no-store"});
    if(!res.ok) throw new Error("manifest missing");
    manifest = await res.json();
    return manifest;
  }catch(e){
    manifest = null;
    return null;
  }
}

function ensureLibraryPopup(){
  if(document.getElementById("libPop")) return;
  const wrap=document.createElement("div");
  wrap.id="libPop";
  wrap.className="lib-pop";
  wrap.innerHTML = `
    <div class="backdrop" id="libBack"></div>
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;">
        <div style="font-weight:1000;letter-spacing:.04em;">Library</div>
        <button class="btn" id="libClose">Close</button>
      </div>
      <div class="hint" style="margin-bottom:12px;">Click = load to Deck A • Option/Alt+Click = load to Deck B</div>
      <div id="libList"></div>
    </div>`;
  document.body.appendChild(wrap);
  document.getElementById("libClose").onclick = ()=> wrap.classList.remove("show");
  document.getElementById("libBack").onclick = ()=> wrap.classList.remove("show");
}

function showLibraryPopup(items){
  ensureLibraryPopup();
  const pop=document.getElementById("libPop");
  const list=document.getElementById("libList");
  list.innerHTML="";
  items.forEach(it=>{
    const row=document.createElement("div");
    row.className="row";
    row.innerHTML = `<div>
        <div class="name">${it.title||it.name||it.file||it.path}</div>
        <div class="hint">${it.file||it.path}</div>
      </div>
      <div class="hint">A / B</div>`;
    row.addEventListener("click",(e)=>{
      const toB = e.altKey; // option on mac
      loadTrackToDeck(it.file||it.path, toB ? "B" : "A");
      pop.classList.remove("show");
    });
    list.appendChild(row);
  });
  pop.classList.add("show");
}
function showPickerPopup(items, titleText, onPick){
  ensureLibraryPopup();
  const pop=document.getElementById("libPop");
  const list=document.getElementById("libList");
  const title=document.getElementById("libTitle");
  if(title) title.textContent = titleText || "Library";
  list.innerHTML="";
  items.forEach(it=>{
    const row=document.createElement("div");
    row.className="row";
    const name = it.title || it.name || it.file || it.path || "";
    const file = it.file || it.path || "";
    row.innerHTML = `<div>
        <div class="name">${name}</div>
        <div class="hint">${file}</div>
      </div>
      <div class="hint">click</div>`;
    row.addEventListener("click", async (e)=>{
      pop.classList.remove("show");
      try{ await onPick(it, e); }catch(err){ console.warn(err); }
    });
    list.appendChild(row);
  });
  pop.classList.add("show");
}

async function loadSampleFromURL(slot, url, name){
  if(!audioCtx) return;
  const safeUrl = encodeURI(url);
  const res = await fetch(safeUrl, { cache:"no-store" });
  if(!res.ok) throw new Error("Sample fetch failed: "+res.status);
  const ab = await res.arrayBuffer();
  const decoded = await audioCtx.decodeAudioData(ab.slice(0));
  sampleBank[slot] = { name: name || (url.split("/").pop()||"sample"), buffer: decoded, url: url };
  renderSamplePads();
}

function initSamplesFromManifest(){
  if(!manifest) return;
  const s = Array.isArray(manifest.samples) ? manifest.samples : [];
  for(let i=0;i<8;i++){
    if(s[i]){
      const p = s[i].path || s[i].file;
      sampleBank[i] = { name: s[i].name || s[i].title || (p? p.split("/").pop() : `PAD ${i+1}`), buffer: sampleBank[i]?.buffer||null, url: p };
    }
  }
  renderSamplePads();
}

async function preloadSamplesFromManifest(){
  if(!manifest || !audioCtx) return;
  const s = Array.isArray(manifest.samples) ? manifest.samples : [];
  for(let i=0;i<8;i++){
    const p = s[i]?.path || s[i]?.file;
    if(!p) continue;
    // skip if already decoded
    if(sampleBank[i]?.buffer) continue;
    await loadSampleFromURL(i, p, s[i]?.name);
  }
}


async function preloadFromManifest(){
  if(!manifest || !audioCtx) return;
  const t = Array.isArray(manifest.tracks) ? manifest.tracks : [];
  if(a) await loadTrackToDeck(a, "A");
  if(b) await loadTrackToDeck(b, "B");

  const s = Array.isArray(manifest.samples) ? manifest.samples : [];
  for(let i=0;i<8;i++){
    const item = s[i];
    if(!item?.file) continue;
    try{
      const res = await fetch(item.file, {cache:"no-store"});
      if(!res.ok) continue;
      const ab = await res.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(ab);
      sampleBank[i] = {name: item.name || item.file.split("/").pop(), buffer: decoded};
    }catch(_){}
  }
  if(typeof renderSamplePads === "function") renderSamplePads();
}

// This needs to hook into YOUR deck loading functions.
// We'll try multiple known patterns so it works across builds.
async function loadTrackToDeck(file, deckLetter){
  // 1) If deck objects exist with loadFromURL
  const deck = (deckLetter==="B") ? (window.decks && window.decks.B) : (window.decks && window.decks.A);
  if(deck && typeof deck.loadFromURL === "function"){
    await deck.loadFromURL(file);
    return;
  }
  // 2) If there are hidden file loaders, try global helpers
  if(typeof window.loadDeckFromURL === "function"){
    await window.loadDeckFromURL(deckLetter, file);
    return;
  }
  // 3) Fallback: simulate clicking library load if function exists
  if(typeof window.__loadUrlToDeck === "function"){
    await window.__loadUrlToDeck(deckLetter, file);
    return;
  }
  console.warn("No deck URL loader found; use library click to load manually.", file);
}

function wireScratch(platterId, deck){
  const el = $(platterId);
  if(!el) return;

  let dragging = false;
  let startX = 0;
  let startTime = 0;
  let wasPlaying = false;
  let lastY = 0;
  let lastGrainAt = 0;

  const jogPxToSeconds = 0.01; // horizontal jog
  const scratchThreshold = 3;  // px of vertical motion before we fire grain

  el.addEventListener("pointerdown", (e)=>{
    if(!deck.audio.src) return;
    el.setPointerCapture(e.pointerId);
    dragging = true;
    startX = e.clientX;
    startTime = deck.audio.currentTime || 0;
    wasPlaying = !deck.audio.paused;
    lastY = e.clientY;
    lastGrainAt = 0;

    // Pause media element; scratch audio comes from grains
    deck.audio.pause();
  });

  el.addEventListener("pointermove", (e)=>{
    if(!dragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - lastY;

    const dur = deck.duration || deck.audio.duration || 0;
    if(dur<=0) return;

    // horizontal jog moves playhead
    const t = Math.max(0, Math.min(dur, startTime + dx*jogPxToSeconds));
    deck.audio.currentTime = t;

    // vertical motion creates scratch grains
    const now = performance.now();
    if(Math.abs(dy) >= scratchThreshold && (now - lastGrainAt) > 18){
      // up = forward, down = backward
      playScratchGrain(deck, t, -dy);
      lastGrainAt = now;
    }

    deck.platterAngle += dx * 0.002;

    startX = e.clientX;
    startTime = t;
    lastY = e.clientY;
  });

  const end = ()=>{
    if(!dragging) return;
    dragging = false;
    if(wasPlaying) deck.audio.play();
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

function wire(){
  // show buttons immediately
  buildFx("fxBtnsA","A"); buildFx("fxBtnsB","B");
  buildHot("hotBtnsA","A"); buildHot("hotBtnsB","B");
  renderSamplePads();

  $("enableAudio")?.addEventListener("click", async ()=>{
    try{ await enableAudio(); }catch(err){ alert("Audio enable failed: "+(err?.message||err)); }
  });

  const pick = async (deck)=>{
    const input=document.createElement("input");
    input.type="file"; input.accept=".wav,.mp3,audio/*";
    input.onchange= async ()=>{
      const file=input.files && input.files[0];
      if(!file) return;
      if(!unlocked) await enableAudio();
      await deck.loadFromFile(file);
      updateMeta(); redraw();
    };
    input.click();
  };
  $("loadLocalA")?.addEventListener("click", ()=>pick(deckA));
  $("loadLocalB")?.addEventListener("click", ()=>pick(deckB));
  $("playA")?.addEventListener("click", ()=>deckA.playPause());
  $("playB")?.addEventListener("click", ()=>deckB.playPause());

  wireScratch("platterA", deckA);
  wireScratch("platterB", deckB);


  // crossfader
  const cross=$("cross");
  const volA=$("volA");
  const volB=$("volB");
  let volAVal=1.0;
  let volBVal=1.0;
  const apply=()=>{
    const x=parseFloat(cross?.value ?? "0.5");
    const a=Math.cos(x*Math.PI/2);
    const b=Math.sin(x*Math.PI/2);
    deckA.setGain(a*volAVal);
    deckB.setGain(b*volBVal);
    setMixView(x);
  };
  cross?.addEventListener("input", apply);
  volA?.addEventListener("input", ()=>{ volAVal=parseFloat(volA.value); apply(); });
  volB?.addEventListener("input", ()=>{ volBVal=parseFloat(volB.value); apply(); });
  setMixView(0.5);

  // waveform seek
  $("waveA")?.addEventListener("click",(e)=>seekFromWave(e, deckA, $("waveA")));
  $("waveB")?.addEventListener("click",(e)=>seekFromWave(e, deckB, $("waveB")));

  $("runTransition")?.addEventListener("click", async ()=>{ if(!unlocked) await enableAudio(); runTransition(); });

  // library scan
  $("scanAudio")?.addEventListener("click", async ()=>{
  try{
    const items = await scanAudio();
    renderLib(items);
    // also refresh sample labels
    if(!manifest) await loadManifest();
    initSamplesFromManifest();
    if(unlocked) await preloadSamplesFromManifest();
  }catch(err){
    console.warn(err);
    alert("Library refresh failed. Use http://localhost:8080 (not file://).");
  }
});
  $("clearQueue")?.addEventListener("click", ()=>{ const ll=$("libList"); if(ll) ll.innerHTML=""; });

  // shortcuts modal
  $("shortcutsBtn")?.addEventListener("click", ()=> $("shortcutsModal")?.classList.remove("hidden"));
  $("closeShortcuts")?.addEventListener("click", ()=> $("shortcutsModal")?.classList.add("hidden"));
}

function seekFromWave(e, deck, canvas){
  const dur = deck.duration || deck.audio.duration || 0;
  if(!dur || !canvas) return;
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left)/r.width;
  deck.audio.currentTime = clamp01(x)*dur;
}

async function scanAudio(){
  // Prefer manifest (works on GitHub Pages)
  if(!manifest) await loadManifest();
  if(manifest && Array.isArray(manifest.library) && manifest.library.length){
    return manifest.library.map(it=>{
      const url = it.path || it.file;
      const name = it.title || it.name || (url ? url.split("/").pop() : "track");
      return { name, url };
    });
  }
  // Fallback for local folder listing
  const res = await fetch("audio/");
  const txt = await res.text();
  const matches = [...txt.matchAll(/href="([^"]+\.(?:mp3|wav))"/gi)].map(m=>m[1]);
  const clean = Array.from(new Set(matches.map(m=>m.replace(/^\.?\//,""))));
  return clean.map(fn=>({name:fn, url:"audio/"+fn}));
}
function renderLib(items){
  const wrap=$("libList"); if(!wrap) return;
  wrap.innerHTML="";
  items.forEach(it=>{
    const row=document.createElement("div");
    row.className="lib-row";
    row.style.display="grid";
    row.style.gridTemplateColumns="1fr auto auto auto";
    row.style.gap="8px";
    row.style.alignItems="center";
    row.style.padding="8px";
    row.style.borderBottom="1px solid rgba(255,255,255,.06)";

    const name=document.createElement("div");
    name.textContent=it.name || "track";
    name.style.fontWeight="900"; name.style.opacity=".9";

    const a=document.createElement("button");
    a.className="btn ghost"; a.textContent="Load A";
    a.addEventListener("click", async ()=>{
      if(!unlocked) await enableAudio();
      await deckA.loadFromUrl(encodeURI(it.url)); updateMeta(); redraw();
    });

    const b=document.createElement("button");
    b.className="btn ghost"; b.textContent="Load B";
    b.addEventListener("click", async ()=>{
      if(!unlocked) await enableAudio();
      await deckB.loadFromUrl(encodeURI(it.url)); updateMeta(); redraw();
    });

    const sWrap=document.createElement("div");
    sWrap.className="sample-assign";
    for(let i=0;i<8;i++){
      const sb=document.createElement("button");
      sb.className="btn ghost sbtn";
      sb.textContent=String(i+1);
      sb.title="Assign to sample "+(i+1);
      sb.addEventListener("click", async (e)=>{
        e.stopPropagation();
        const url = it.url;
        const label = it.name || (url? url.split("/").pop():"sample");
        // assign label immediately
        sampleBank[i] = { name: label, buffer: sampleBank[i]?.buffer||null, url };
        renderSamplePads();
        if(!unlocked) return; // user can enable audio when ready
        try{ await loadSampleFromURL(i, url, label); }catch(err){ console.warn(err); }
      });
      sWrap.appendChild(sb);
    }

    row.appendChild(name); row.appendChild(a); row.appendChild(b); row.appendChild(sWrap);
    wrap.appendChild(row);
  });
}



function runTransition(){
  const cross = $("cross");
  if(!cross) return;
  const from = (nextTransitionDir==="AtoB") ? 0.0 : 1.0;
  const to   = (nextTransitionDir==="AtoB") ? 1.0 : 0.0;
  nextTransitionDir = (nextTransitionDir==="AtoB") ? "BtoA" : "AtoB";

  const start = performance.now();
  const dur = 1200;

  const step = (now)=>{
    const t = clamp01((now-start)/dur);
    const x = from + (to-from)*t;
    cross.value = String(x);
    cross.dispatchEvent(new Event("input"));
    if(t<1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function updateMeta(){
  $("trackAName").textContent = deckA.audio.src ? deckA.audio.src.split("/").pop() : "—";
  $("trackBName").textContent = deckB.audio.src ? deckB.audio.src.split("/").pop() : "—";
  $("bpmA").textContent = deckA.bpm ? String(deckA.bpm) : "—";
  $("bpmB").textContent = deckB.bpm ? String(deckB.bpm) : "—";
}

let lastT = performance.now();
function loop(now){
  const dt=Math.min(0.05,(now-lastT)/1000);
  lastT=now;
  deckA.tick(dt); deckB.tick(dt);

  const pA=$("platterA"), pB=$("platterB");
  if(pA) pA.style.transform=`rotate(${deckA.platterAngle}rad)`;
  if(pB) pB.style.transform=`rotate(${deckB.platterAngle}rad)`;

  $("timeA").textContent = `${fmtTime(deckA.audio.currentTime)} / ${fmtTime(deckA.duration||deckA.audio.duration||0)}`;
  $("timeB").textContent = `${fmtTime(deckB.audio.currentTime)} / ${fmtTime(deckB.duration||deckB.audio.duration||0)}`;

  overlays();
  requestAnimationFrame(loop);
}

window.addEventListener("resize", redraw);
wire();
redraw();
requestAnimationFrame(loop);

document.addEventListener("keydown",(e)=>{
  if((e.key||"").toLowerCase()==="l"){
    loadManifest().then(m=>{
      const items=(m && Array.isArray(m.tracks)) ? m.tracks : [];
      showLibraryPopup(items.map(x=>({name:x.name||x.file,file:x.file})));
    });
  }
});

window.addEventListener("DOMContentLoaded", async ()=>{
  await loadManifest();
  initSamplesFromManifest();
  const items = await scanAudio();
  renderLib(items);
});
