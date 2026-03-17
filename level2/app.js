"use strict";
const $ = (id)=>document.getElementById(id);

let audioCtx = null;
let unlocked = false;
let masterGain = null;
let masterAnalyser = null;
let recordDest = null;
let crossValue = 0.5;

function clamp01(v){ return Math.max(0, Math.min(1, v)); }
function fmtTime(sec){ if(!isFinite(sec)||sec<0) return "0:00"; const m=Math.floor(sec/60), s=Math.floor(sec%60); return `${m}:${String(s).padStart(2,"0")}`; }

function reverseBuffer(buf){
  const rev = audioCtx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for(let c=0;c<buf.numberOfChannels;c++){
    const src=buf.getChannelData(c), dst=rev.getChannelData(c);
    for(let i=0,j=src.length-1;i<src.length;i++,j--) dst[i]=src[j];
  }
  return rev;
}

function drawWave(canvas, data, color){
  if(!canvas) return;
  const ctx=canvas.getContext("2d"), w=canvas.width, h=canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle="rgba(0,0,0,.2)"; ctx.fillRect(0,0,w,h);
  if(!data || !data.length) return;
  const step=Math.ceil(data.length/w), amp=h/2;
  ctx.strokeStyle=color; ctx.beginPath();
  for(let x=0;x<w;x++){
    let min=1,max=-1, base=x*step;
    for(let i=0;i<step && base+i<data.length;i++){ const v=data[base+i]; if(v<min) min=v; if(v>max) max=v; }
    ctx.moveTo(x, amp+min*amp); ctx.lineTo(x, amp+max*amp);
  }
  ctx.stroke();
}


function resolveMediaUrl(url){
  if(!url) return "";
  if(/^https?:\/\//i.test(url)) return url;
  if(url.startsWith("../") || url.startsWith("/")) return url;
  if(url.startsWith("audio/")) return "../"+url;
  return "../audio/"+url;
}

function estimateRms(analyser){
  if(!analyser) return 0;
  const arr=new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(arr);
  let sum=0; for(let i=0;i<arr.length;i++) sum+=arr[i]*arr[i];
  return Math.sqrt(sum/arr.length);
}

class Deck{
  constructor(name){
    this.name=name;
    this.audio=new Audio();
    this.audio.preload="auto";
    this.audio.crossOrigin="anonymous";
    this.src=null; this.gain=null; this.filter=null; this.echoDelay=null; this.echoFB=null; this.echoMix=null; this.reverbMix=null; this.convolver=null;
    this.analyser=null;
    this.duration=0; this.waveform=null; this.scratchBuffer=null; this.scratchBufferRev=null;
    this.platterAngle=0; this.platterVel=0; this.isScratching=false;
    this.cuePoint=0;
    this.hot=Array(8).fill(null);
  }

  connect(){
    if(this.src) return;
    this.src=audioCtx.createMediaElementSource(this.audio);
    this.gain=audioCtx.createGain();
    this.filter=audioCtx.createBiquadFilter(); this.filter.type="lowpass"; this.filter.frequency.value=20000;
    this.echoDelay=audioCtx.createDelay(1.0); this.echoFB=audioCtx.createGain(); this.echoMix=audioCtx.createGain();
    this.echoDelay.delayTime.value=0.23; this.echoFB.gain.value=0.35; this.echoMix.gain.value=0;
    this.convolver=audioCtx.createConvolver(); this.convolver.buffer=makeImpulse(1.4,2.1);
    this.reverbMix=audioCtx.createGain(); this.reverbMix.gain.value=0;
    this.analyser=audioCtx.createAnalyser(); this.analyser.fftSize=1024;

    this.src.connect(this.filter);
    this.filter.connect(this.gain);

    this.filter.connect(this.echoDelay); this.echoDelay.connect(this.echoFB); this.echoFB.connect(this.echoDelay); this.echoDelay.connect(this.echoMix); this.echoMix.connect(this.gain);
    this.filter.connect(this.convolver); this.convolver.connect(this.reverbMix); this.reverbMix.connect(this.gain);

    this.gain.connect(this.analyser); this.analyser.connect(masterGain);
  }

  setGain(v){ if(this.gain) this.gain.gain.value=clamp01(v); }
  setFilterNorm(v){ if(!this.filter) return; const f=120*Math.pow(20000/120, clamp01(v)); this.filter.frequency.value=f; }
  setEchoWet(v){ if(this.echoMix) this.echoMix.gain.value=clamp01(v); }
  setReverbWet(v){ if(this.reverbMix) this.reverbMix.gain.value=clamp01(v); }

  async loadFile(file){
    this.audio.src=URL.createObjectURL(file);
    await this.audio.load();
    const ab=await file.arrayBuffer();
    const decoded=await audioCtx.decodeAudioData(ab.slice(0));
    this.duration=decoded.duration||0;
    const ch=decoded.getChannelData(0);
    this.waveform=ch.slice(0, Math.min(ch.length, 1200*600));
    this.scratchBuffer=decoded; this.scratchBufferRev=reverseBuffer(decoded);
    this.cuePoint=0;
    this.hot=Array(8).fill(null);
  }

  tick(dt){
    if(this.isScratching) return;
    const target=!this.audio.paused ? 3.0 : 0;
    this.platterVel += (target-this.platterVel)*Math.min(1,dt*6);
    this.platterAngle += this.platterVel*dt;
  }
}

function makeImpulse(seconds, decay){
  const len=Math.floor(audioCtx.sampleRate*seconds);
  const buf=audioCtx.createBuffer(2,len,audioCtx.sampleRate);
  for(let c=0;c<2;c++){
    const d=buf.getChannelData(c);
    for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/len,decay);
  }
  return buf;
}

const PRESETS=[
  {label:"AIR",f:.85,e:0,r:0},{label:"SUB",f:.18,e:0,r:0},{label:"ECHO",f:.55,e:.62,r:0},{label:"HALL",f:.70,e:0,r:.62},
  {label:"SWEEP",f:.92,e:.2,r:.05},{label:"WARM",f:.62,e:0,r:.18},{label:"SPACE",f:.72,e:.25,r:.72},{label:"CUT",f:.1,e:0,r:0}
];

function buildFx(containerId, deck){
  const wrap=$(containerId); wrap.innerHTML="";
  PRESETS.forEach((p)=>{
    const b=document.createElement("button"); b.className="fxbtn"; b.textContent=p.label;
    b.addEventListener("click", ()=>{
      const was=b.classList.contains("on");
      wrap.querySelectorAll(".fxbtn").forEach(x=>x.classList.remove("on"));
      if(was){ deck.setFilterNorm(1); deck.setEchoWet(0); deck.setReverbWet(0); return; }
      b.classList.add("on"); deck.setFilterNorm(p.f); deck.setEchoWet(p.e); deck.setReverbWet(p.r);
    });
    wrap.appendChild(b);
  });
}

const deckA=new Deck("A");
const deckB=new Deck("B");

const sampleBank=Array(16).fill(null);
const sampleVoices=Array(16).fill(null);
let manifest=null;

function playScratchGrain(deck,tSec,dir){
  if(!audioCtx || !deck.scratchBuffer || !deck.scratchBufferRev) return;
  const dur=deck.scratchBuffer.duration||0; if(dur<=0) return;
  const speed=Math.abs(dir);
  const grainDur=Math.max(0.014,0.03-Math.min(0.012,speed*0.00002));
  const rate=Math.max(0.86,Math.min(1.22,1+dir*0.00034));
  const gainVal=Math.max(0.24,Math.min(0.68,0.34+speed*0.00012));
  const now=audioCtx.currentTime;
  const g=audioCtx.createGain();
  g.gain.setValueAtTime(0.0001,now);
  g.gain.linearRampToValueAtTime(gainVal,now+0.0035);
  g.gain.exponentialRampToValueAtTime(0.0001,now+grainDur);
  g.connect(masterGain);

  const src=audioCtx.createBufferSource(); src.playbackRate.value=rate;
  if(dir>=0){ src.buffer=deck.scratchBuffer; src.start(now,Math.max(0,Math.min(dur-grainDur,tSec)),grainDur); }
  else{ src.buffer=deck.scratchBufferRev; const off=Math.max(0,Math.min(dur-grainDur,(dur-tSec)-grainDur)); src.start(now,off,grainDur); }
  src.connect(g); src.stop(now+grainDur+0.006);
}

function wireScratch(platterId, deck){
  const el=$(platterId);
  let dragging=false,lastAngle=0,lastMoveAt=0,lastSpeed=0,wasPlaying=false,lastGrainAt=0;
  const secsPerRad=0.085, threshold=0.006;
  const pointerAngle=(e)=>{ const r=el.getBoundingClientRect(); return Math.atan2(e.clientY-(r.top+r.height/2), e.clientX-(r.left+r.width/2)); };
  const norm=(a)=> a>Math.PI ? a-Math.PI*2 : (a<-Math.PI ? a+Math.PI*2 : a);

  el.addEventListener("pointerdown",(e)=>{
    if(!deck.audio.src) return;
    el.setPointerCapture(e.pointerId);
    dragging=true; lastAngle=pointerAngle(e); lastMoveAt=performance.now(); lastSpeed=0; lastGrainAt=0;
    wasPlaying=!deck.audio.paused; deck.isScratching=true; deck.audio.pause();
  });
  el.addEventListener("pointermove",(e)=>{
    if(!dragging) return;
    const a=pointerAngle(e), da=norm(a-lastAngle), now=performance.now(), dt=Math.max(0.001,(now-lastMoveAt)/1000);
    lastSpeed=da/dt;
    const dur=deck.duration||deck.audio.duration||0;
    const t=Math.max(0,Math.min(dur,(deck.audio.currentTime||0)+da*secsPerRad));
    deck.audio.currentTime=t;
    if(Math.abs(da)>=threshold && (now-lastGrainAt)>8){ playScratchGrain(deck,t,da*650); lastGrainAt=now; }
    deck.platterAngle += da;
    lastMoveAt=now; lastAngle=a;
  });
  const end=()=>{ if(!dragging) return; dragging=false; deck.isScratching=false; deck.platterVel=Math.max(-14,Math.min(14,lastSpeed*0.3)); if(wasPlaying) deck.audio.play(); };
  el.addEventListener("pointerup",end); el.addEventListener("pointercancel",end);
}



function buildHot(containerId, deck){
  const wrap=$(containerId); if(!wrap) return; wrap.innerHTML="";
  for(let i=0;i<8;i++){
    const b=document.createElement("button"); b.className="hot-btn"; b.textContent=String(i+1);
    const x=document.createElement("span"); x.className="hs-x"; x.textContent="×"; b.appendChild(x);
    const refresh=()=>b.classList.toggle("is-set", deck.hot[i]!=null);
    b.addEventListener("click",(e)=>{
      if(e.target===x || e.shiftKey){ deck.hot[i]=null; refresh(); return; }
      if(deck.hot[i]==null) deck.hot[i]=deck.audio.currentTime||0;
      else deck.audio.currentTime=deck.hot[i];
      refresh();
    });
    refresh(); wrap.appendChild(b);
  }
}

function buildSamplePad(i){
  const b=document.createElement("button"); b.className="sample-pad"+(sampleVoices[i]?" latched":"");
  const label=(sampleBank[i]?.name||`PAD ${i+1}`).replace(/\.(wav|mp3)$/i,"");
  b.textContent=label.length>10?label.slice(0,10)+"…":label;
  b.addEventListener("click", async (e)=>{
    if(e.shiftKey){
      const input=document.createElement("input"); input.type="file"; input.accept=".wav,.mp3,audio/*";
      input.onchange=async ()=>{ const file=input.files&&input.files[0]; if(!file) return; if(!unlocked) await enableAudio(); const ab=await file.arrayBuffer(); const decoded=await audioCtx.decodeAudioData(ab.slice(0)); sampleBank[i]={name:file.name, buffer:decoded}; renderSamplePads(); };
      input.click();
      return;
    }
    if(!unlocked) await enableAudio();
    const it=sampleBank[i]; if(!it?.buffer) return;
    if(sampleVoices[i]){ try{ sampleVoices[i].stop(); }catch(_){ } sampleVoices[i]=null; renderSamplePads(); return; }
    const src=audioCtx.createBufferSource(); src.buffer=it.buffer; src.loop=true; src.connect(masterGain); src.start(); sampleVoices[i]=src;
    src.onended=()=>{ if(sampleVoices[i]===src) sampleVoices[i]=null; renderSamplePads(); };
    renderSamplePads();
  });
  return b;
}

function renderSamplePads(){
  const wrapA=$("samplePadsA"), wrapB=$("samplePadsB");
  if(!wrapA || !wrapB) return;
  wrapA.innerHTML=""; wrapB.innerHTML="";
  for(let i=0;i<8;i++) wrapA.appendChild(buildSamplePad(i));
  for(let i=8;i<16;i++) wrapB.appendChild(buildSamplePad(i));
}

async function loadManifest(){
  try{ const res=await fetch("../audio/library.json",{cache:"no-store"}); manifest=await res.json(); return manifest; }catch(e){ manifest=null; return null; }
}

async function loadSampleFromUrl(slot,url,name){
  if(!audioCtx) return;
  const srcUrl=resolveMediaUrl(url);
  const res=await fetch(encodeURI(srcUrl),{cache:"no-store"}); if(!res.ok) return;
  const ab=await res.arrayBuffer(); const decoded=await audioCtx.decodeAudioData(ab.slice(0));
  sampleBank[slot]={name:name||url.split("/").pop(), buffer:decoded, url:srcUrl};
  renderSamplePads();
}

async function initSamplesFromManifest(){
  if(!manifest) return;
  const s=Array.isArray(manifest.samples)?manifest.samples:[];
  for(let i=0;i<8;i++){
    const p=s[i]?.path||s[i]?.file; if(!p) continue;
    const n=s[i]?.name||s[i]?.title||p.split("/").pop();
    sampleBank[i]={name:n, buffer:null, url:p};
    if(unlocked) await loadSampleFromUrl(i,p,n);
  }
  renderSamplePads();
}

async function scanAudio(){
  if(!manifest) await loadManifest();
  if(manifest?.library?.length){
    return manifest.library.map(it=>({name:it.title||it.name||it.file||it.path, url:resolveMediaUrl(it.path||it.file)}));
  }
  if(manifest?.tracks?.length){
    return manifest.tracks.map(it=>({name:it.title||it.name||it.file||it.path, url:resolveMediaUrl(it.file||it.path)}));
  }
  return [];
}

async function renderLibrary(){
  const wrap=$("libList"); if(!wrap) return; wrap.innerHTML="";
  const items=await scanAudio();
  items.forEach((it)=>{
    const row=document.createElement("div"); row.className="lib-row";
    const n=document.createElement("div"); n.className="lib-name"; n.textContent=it.name;
    const a=document.createElement("button"); a.className="small-btn"; a.textContent="Load A";
    const b=document.createElement("button"); b.className="small-btn"; b.textContent="Load B";
    a.onclick=async ()=>{ if(!unlocked) await enableAudio(); const src=encodeURI(it.url); const res=await fetch(src); const ab=await res.arrayBuffer(); const dec=await audioCtx.decodeAudioData(ab.slice(0)); deckA.duration=dec.duration||0; const ch=dec.getChannelData(0); deckA.waveform=ch.slice(0,Math.min(ch.length,1200*600)); deckA.scratchBuffer=dec; deckA.scratchBufferRev=reverseBuffer(dec); deckA.audio.src=src; deckA.audio.load(); $("trackAName").textContent=it.name; drawWave($("waveA"),deckA.waveform,"#ff5f6d"); };
    b.onclick=async ()=>{ if(!unlocked) await enableAudio(); const src=encodeURI(it.url); const res=await fetch(src); const ab=await res.arrayBuffer(); const dec=await audioCtx.decodeAudioData(ab.slice(0)); deckB.duration=dec.duration||0; const ch=dec.getChannelData(0); deckB.waveform=ch.slice(0,Math.min(ch.length,1200*600)); deckB.scratchBuffer=dec; deckB.scratchBufferRev=reverseBuffer(dec); deckB.audio.src=src; deckB.audio.load(); $("trackBName").textContent=it.name; drawWave($("waveB"),deckB.waveform,"#36d8ff"); };
    row.append(n,a,b); wrap.appendChild(row);
  });
}

function encodeWav(audioBuffer){
  const ch=audioBuffer.numberOfChannels, sr=audioBuffer.sampleRate, len=audioBuffer.length, bps=2, align=ch*bps;
  const buffer=new ArrayBuffer(44+len*align); const view=new DataView(buffer);
  const ws=(o,s)=>{ for(let i=0;i<s.length;i++) view.setUint8(o+i,s.charCodeAt(i)); };
  ws(0,"RIFF"); view.setUint32(4,36+len*align,true); ws(8,"WAVE"); ws(12,"fmt "); view.setUint32(16,16,true);
  view.setUint16(20,1,true); view.setUint16(22,ch,true); view.setUint32(24,sr,true); view.setUint32(28,sr*align,true);
  view.setUint16(32,align,true); view.setUint16(34,16,true); ws(36,"data"); view.setUint32(40,len*align,true);
  let off=44;
  for(let i=0;i<len;i++) for(let c=0;c<ch;c++){ const s=Math.max(-1,Math.min(1,audioBuffer.getChannelData(c)[i])); view.setInt16(off,s<0?s*0x8000:s*0x7FFF,true); off+=2; }
  return new Blob([buffer],{type:"audio/wav"});
}

const recorder={mediaRecorder:null,chunks:[],startedAt:0,timer:null,timeout:null,audio:null,url:null,maxMs:180000,decoded:null};

async function renderRecordedWave(decoded){
  recorder.decoded=decoded;
  const ch=decoded.getChannelData(0);
  drawWave($("recordWave"), ch, "#9eff8f");
}

async function startRecording(){
  if(!audioCtx || !recordDest) return;
  const mime=MediaRecorder.isTypeSupported("audio/webm;codecs=opus")?"audio/webm;codecs=opus":"audio/webm";
  recorder.chunks=[];
  recorder.mediaRecorder=new MediaRecorder(recordDest.stream,{mimeType:mime});
  recorder.mediaRecorder.ondataavailable=(e)=>{ if(e.data.size) recorder.chunks.push(e.data); };
  recorder.mediaRecorder.onstop=async ()=>{
    const blob=new Blob(recorder.chunks,{type:mime});
    const ab=await blob.arrayBuffer();
    const decoded=await audioCtx.decodeAudioData(ab.slice(0));
    await renderRecordedWave(decoded);
    const wav=encodeWav(decoded);
    if(recorder.url) URL.revokeObjectURL(recorder.url);
    recorder.url=URL.createObjectURL(wav); recorder.audio=new Audio(recorder.url);
    const dl=$("downloadRecord"); dl.href=recorder.url; dl.setAttribute("aria-disabled","false");
    $("playRecordBtn").disabled=false;
  };

  recorder.mediaRecorder.start(300);
  recorder.startedAt=performance.now();
  $("recordBtn").classList.add("engaged");
  $("stopRecordBtn").disabled=false;
  $("playRecordBtn").disabled=true;
  $("downloadRecord").setAttribute("aria-disabled","true");

  const tick=()=>{ const elapsed=Math.max(0,performance.now()-recorder.startedAt); $("recordTimer").textContent=`${fmtTime(elapsed/1000)} / 3:00`; };
  tick(); recorder.timer=setInterval(tick,250); recorder.timeout=setTimeout(stopRecording,recorder.maxMs);
}

function stopRecording(){
  if(!recorder.mediaRecorder || recorder.mediaRecorder.state==="inactive") return;
  recorder.mediaRecorder.stop(); clearInterval(recorder.timer); clearTimeout(recorder.timeout);
  $("recordBtn").classList.remove("engaged"); $("stopRecordBtn").disabled=true;
}

async function enableAudio(){
  if(unlocked) return;
  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  masterGain=audioCtx.createGain(); masterGain.gain.value=1;
  masterAnalyser=audioCtx.createAnalyser(); masterAnalyser.fftSize=1024;
  recordDest=audioCtx.createMediaStreamDestination();
  masterGain.connect(masterAnalyser); masterAnalyser.connect(audioCtx.destination); masterGain.connect(recordDest);
  deckA.connect(); deckB.connect();
  buildFx("fxBtnsA",deckA); buildFx("fxBtnsB",deckB);
  unlocked=true; $("enableAudio").classList.add("engaged"); $("enableAudio").textContent="Audio Ready";
}

function setCross(v){
  crossValue=clamp01(v);
  const track=$("crossTrack"), handle=$("crossHandle");
  const w=track.clientWidth;
  handle.style.left=`${crossValue*w}px`;
  track.setAttribute("aria-valuenow", String(crossValue.toFixed(3)));

  const a=Math.cos(crossValue*Math.PI/2), b=Math.sin(crossValue*Math.PI/2);
  const va=parseFloat($("volA").value), vb=parseFloat($("volB").value);
  deckA.setGain(a*va); deckB.setGain(b*vb);
}

function wireCrossFader(){
  const track=$("crossTrack");
  const move=(clientX)=>{ const r=track.getBoundingClientRect(); setCross((clientX-r.left)/r.width); };
  track.addEventListener("pointerdown",(e)=>{ track.setPointerCapture(e.pointerId); move(e.clientX); });
  track.addEventListener("pointermove",(e)=>{ if(e.buttons) move(e.clientX); });
  track.addEventListener("keydown",(e)=>{ if(e.key==="ArrowLeft") setCross(crossValue-0.02); if(e.key==="ArrowRight") setCross(crossValue+0.02); });
  setCross(0.5);
}

function wireLoad(btnId, deck, nameId, waveId){
  $(btnId).addEventListener("click", async ()=>{
    if(!unlocked) await enableAudio();
    const input=document.createElement("input"); input.type="file"; input.accept=".wav,.mp3,audio/*";
    input.onchange=async ()=>{ const file=input.files && input.files[0]; if(!file) return; await deck.loadFile(file); $(nameId).textContent=file.name; drawWave($(waveId), deck.waveform, waveId==="waveA"?"#ff5f6d":"#36d8ff"); };
    input.click();
  });
}

function wireDeckControls(){
  wireLoad("loadLocalA",deckA,"trackAName","waveA");
  wireLoad("loadLocalB",deckB,"trackBName","waveB");

  const toggle=(deck,btn)=>{ if(!deck.audio.src) return; if(deck.audio.paused){ deck.audio.play(); btn.classList.add("engaged"); } else { deck.audio.pause(); btn.classList.remove("engaged"); } };
  $("playA").addEventListener("click",()=>toggle(deckA,$("playA")));
  $("playB").addEventListener("click",()=>toggle(deckB,$("playB")));
  $("stopA").addEventListener("click",()=>{ if(!deckA.audio.src) return; deckA.audio.pause(); deckA.audio.currentTime=0; $("playA").classList.remove("engaged"); });
  $("stopB").addEventListener("click",()=>{ if(!deckB.audio.src) return; deckB.audio.pause(); deckB.audio.currentTime=0; $("playB").classList.remove("engaged"); });

  $("cueA").addEventListener("click",()=>{ if(!deckA.audio.src) return; if(deckA.audio.paused){ deckA.cuePoint=deckA.audio.currentTime||0; } else { deckA.audio.currentTime=deckA.cuePoint||0; deckA.audio.pause(); $("playA").classList.remove("engaged"); } });
  $("cueB").addEventListener("click",()=>{ if(!deckB.audio.src) return; if(deckB.audio.paused){ deckB.cuePoint=deckB.audio.currentTime||0; } else { deckB.audio.currentTime=deckB.cuePoint||0; deckB.audio.pause(); $("playB").classList.remove("engaged"); } });

  $("volA").addEventListener("input",()=>setCross(crossValue));
  $("volB").addEventListener("input",()=>setCross(crossValue));

  wireScratch("platterA",deckA); wireScratch("platterB",deckB);
}

function wireTransitions(){
  $("runTransition").addEventListener("click",()=>{
    const style=$("transitionStyle").value;
    const dur=style==="quick"?550:style==="smooth"?1300:2400;
    const from=crossValue, to=from<0.5?1:0;
    const start=performance.now();
    const ease=(t)=> style==="quick" ? (t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2) : (style==="smooth"? t : t*t*(3-2*t));
    const step=(now)=>{ const t=Math.min(1,(now-start)/dur); setCross(from+(to-from)*ease(t)); if(t<1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

function buildMeter(container,count){ container.innerHTML=""; const cells=[]; for(let i=0;i<count;i++){ const d=document.createElement("div"); d.className="led-cell"; container.appendChild(d); cells.push(d); } return cells; }
function paintMeter(cells,n){ const on=Math.round(n*cells.length); cells.forEach((c,i)=>{ c.classList.remove("on","warn","clip"); if(i<on){ const hi=i>cells.length-3, mid=i>cells.length-6; c.classList.add(hi?"clip":mid?"warn":"on"); }}); }

function wireRecording(){
  $("recordBtn").addEventListener("click", async ()=>{ if(!unlocked) await enableAudio(); startRecording(); });
  $("stopRecordBtn").addEventListener("click", stopRecording);
  $("playRecordBtn").addEventListener("click", ()=>{ if(recorder.audio) recorder.audio.play(); });
}

const meterA=buildMeter($("meterA"),12);
const meterB=buildMeter($("meterB"),12);
const meterMaster=buildMeter($("meterMaster"),24);

function wire(){
  $("enableAudio").addEventListener("click", enableAudio);
  wireCrossFader();
  wireDeckControls();
  wireTransitions();
  wireRecording();
  buildHot("hotBtnsA",deckA);
  buildHot("hotBtnsB",deckB);
  renderSamplePads();
  loadManifest().then(()=>{ initSamplesFromManifest(); renderLibrary(); });
  $("scanAudio")?.addEventListener("click",()=>renderLibrary());
  $("clearQueue")?.addEventListener("click",()=>{ const w=$("libList"); if(w) w.innerHTML=""; });
}

let last=performance.now();
function loop(now){
  const dt=Math.min(0.05,(now-last)/1000); last=now;
  deckA.tick(dt); deckB.tick(dt);
  $("platterA").style.transform=`rotate(${deckA.platterAngle}rad)`;
  $("platterB").style.transform=`rotate(${deckB.platterAngle}rad)`;
  $("timeA").textContent=`${fmtTime(deckA.audio.currentTime)} / ${fmtTime(deckA.duration||deckA.audio.duration||0)}`;
  $("timeB").textContent=`${fmtTime(deckB.audio.currentTime)} / ${fmtTime(deckB.duration||deckB.audio.duration||0)}`;

  if(unlocked){
    paintMeter(meterA, Math.min(1, estimateRms(deckA.analyser)*3.4));
    paintMeter(meterB, Math.min(1, estimateRms(deckB.analyser)*3.4));
    paintMeter(meterMaster, Math.min(1, estimateRms(masterAnalyser)*3.6));
  }
  requestAnimationFrame(loop);
}

wire();
requestAnimationFrame(loop);
