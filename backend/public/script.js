(() => {
const SEND_INTERVAL_MS = 80;
const MAX_POINTS_PER_BATCH = 80;
const MIN_CANVAS = 800;

class SketchApp {
  constructor() {
    this.backgroundCanvas = document.getElementById('backgroundCanvas');
    this.drawingsCanvas = document.getElementById('drawingsCanvas');
    this.overlayCanvas = document.getElementById('overlayCanvas');
    this.canvasWrap = document.getElementById('canvasWrap');
    this.loadingEl = document.getElementById('loading');

    this.toolSelect = document.querySelector('.tool[data-tool="brush"]');
    this.colorPicker = document.getElementById('colorPicker');
    this.brushSizeInput = document.getElementById('brushSize');

    this.bgModal = document.getElementById('backgroundModal');
    this.bgInput = document.getElementById('backgroundInput');
    this.bgUrl = document.getElementById('backgroundUrl');
    this.loadBgBtn = document.getElementById('loadBackgroundBtn');
    this.modalClose = document.getElementById('modalClose');

    this.socket = io();

    this.bgCtx = this.backgroundCanvas.getContext('2d');
    this.drawCtx = this.drawingsCanvas.getContext('2d');
    this.ovCtx = this.overlayCanvas.getContext('2d');

    this.dpr = window.devicePixelRatio || 1;
    this.currentTool = 'brush';
    this.currentColor = '#ff6b6b';
    this.brushSize = 3;

    this.isDrawing = false;
    this.currentLineId = null;
    this.backgroundImage = null;
    this.drawings = new Map();
    this.pointsBuffer = {};

    this.bindUI();
    this.setupSocket();
    this.adjustCanvases();
    window.addEventListener('resize', this.debounce(() => this.adjustCanvases(), 100));
    this.startSender();
  }

  bindUI(){
    document.querySelectorAll('.tool').forEach(btn => {
      btn.addEventListener('click', () => this.currentTool = btn.dataset.tool);
    });
    this.colorPicker.addEventListener('change', e => this.currentColor = e.target.value);
    this.brushSizeInput.addEventListener('input', e => this.brushSize = +e.target.value);

    document.getElementById('backgroundBtn').addEventListener('click', () => this.openModal());
    document.getElementById('clearBtn').addEventListener('click', () => {
      if(confirm('Очистить холст?')){
        this.socket.emit('clearCanvas');
        this.drawings.clear();
        this.clearCanvas(this.drawingsCanvas);
      }
    });
    this.modalClose.addEventListener('click', ()=>this.closeModal());
    this.loadBgBtn.addEventListener('click', ()=>this.uploadBackground());

    const overlay = this.overlayCanvas;
    overlay.addEventListener("pointerdown", e => { overlay.setPointerCapture(e.pointerId); this.onPointerDown(this.getCanvasPos(e)); });
    overlay.addEventListener("pointermove", e => this.onPointerMove(this.getCanvasPos(e)));
    overlay.addEventListener("pointerup", e => { overlay.releasePointerCapture(e.pointerId); this.onPointerUp(); });
    overlay.addEventListener("pointercancel", () => this.onPointerUp());
  }

  setupSocket(){
    this.socket.on('connect', () => console.log("socket connected"));
    this.socket.on('initialState', s => this.loadState(s));
    this.socket.on('usersUpdate', users => document.getElementById('usersCount').textContent = users.length);
    this.socket.on('newLine', line => { if(!this.drawings.has(line.id)) this.drawings.set(line.id, {...line, points:[]}); });
    this.socket.on('pointsBatch', ({id, points}) => {
      const line = this.drawings.get(id);
      if(!line) return;
      const start = line.points.length;
      line.points.push(...points);
      this.drawSegmentBatch(line, start, line.points.length);
    });
    this.socket.on('lineDeleted', id => { this.drawings.delete(id); this.redrawAll(); });
    this.socket.on('canvasCleared', () => { this.drawings.clear(); this.clearCanvas(this.drawingsCanvas); });
    this.socket.on('backgroundChanged', ({backgroundUrl}) => this.setBackground(backgroundUrl));
  }

  loadState(state){
    if(state.backgroundImage) this.setBackground(state.backgroundImage);
    this.drawings.clear();
    (state.drawings||[]).forEach(d=>this.drawings.set(d.id,d));
    this.redrawAll();
    this.loadingEl.style.display="none";
  }

  setBackground(url){
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { this.backgroundImage = img; this.drawBackground(); };
    img.src = url;
  }

  drawBackground(){
    const c = this.backgroundCanvas, ctx = this.bgCtx;
    ctx.clearRect(0,0,c.width,c.height);
    if(!this.backgroundImage) return;
    ctx.drawImage(this.backgroundImage, 0,0,this.backgroundImage.width,this.backgroundImage.height,0,0,c.width/this.dpr,c.height/this.dpr);
  }

  getCanvasPos(e){
    const rect = this.overlayCanvas.getBoundingClientRect();
    return { x:(e.clientX-rect.left)*(this.overlayCanvas.width/rect.width), y:(e.clientY-rect.top)*(this.overlayCanvas.height/rect.height) };
  }

  adjustCanvases(){
    const rect = this.canvasWrap.getBoundingClientRect();
    let size = window.innerWidth < 820 ? Math.min(window.innerWidth, window.innerHeight) : Math.min(Math.max(rect.width, MIN_CANVAS), Math.max(rect.height, MIN_CANVAS));
    this.dpr = window.devicePixelRatio || 1;
    [this.backgroundCanvas, this.drawingsCanvas, this.overlayCanvas].forEach(c => {
      c.style.width = c.style.height = size+"px";
      c.width = c.height = Math.floor(size*this.dpr);
      const ctx=c.getContext("2d"); ctx.setTransform(this.dpr,0,0,this.dpr,0,0); ctx.lineCap=ctx.lineJoin="round";
    });
    if(this.backgroundImage) this.drawBackground();
    this.redrawAll();
  }

  onPointerDown(pos){
    this.isDrawing = true;
    this.currentLineId = this.makeId();
    const line = { id:this.currentLineId, tool:this.currentTool, points:[pos], color:this.currentColor, width:this.brushSize };
    this.drawings.set(line.id,line);
    this.pointsBuffer[line.id] = [pos];
    this.socket.emit('newLine',{id:line.id,tool:line.tool,color:line.color,width:line.width});
    if(line.tool==="brush") this.drawDot(pos.x,pos.y,line.color,line.width);
  }

  onPointerMove(pos){
    if(!this.isDrawing) return;
    const line = this.drawings.get(this.currentLineId);
    if(!line) return;
    const last=line.points[line.points.length-1];
    if(Math.abs(last.x-pos.x)<1 && Math.abs(last.y-pos.y)<1) return;
    const p={x:Math.round(pos.x),y:Math.round(pos.y)};
    line.points.push(p);
    this.pointsBuffer[line.id].push(p);
    this.drawSegmentImmediate(line);
  }

  onPointerUp(){
    if(!this.isDrawing) return;
    this.isDrawing=false;
    this.socket.emit('endLine',{id:this.currentLineId});
    this.currentLineId=null;
  }

  drawDot(x,y,color,size){
    const ctx=this.drawCtx;
    ctx.beginPath(); ctx.arc(x,y,size/2,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
  }

  drawSegmentImmediate(line){
    const pts=line.points; if(pts.length<2) return;
    const n=Math.min(pts.length,32), startIndex=pts.length-n;
    const ctx=this.drawCtx; ctx.beginPath();
    ctx.moveTo(pts[startIndex].x,pts[startIndex].y);
    for(let i=startIndex+1;i<pts.length;i++) ctx.lineTo(pts[i].x,pts[i].y);
    ctx.lineWidth=line.width; ctx.strokeStyle=line.color; ctx.stroke();
  }

  drawSegmentBatch(line,start,end){
    const pts=line.points; if(pts.length<2) return;
    const ctx=this.drawCtx; ctx.beginPath();
    ctx.moveTo(pts[Math.max(0,start)].x, pts[Math.max(0,start)].y);
    for(let i=Math.max(0,start)+1;i<end;i++){ const p=pts[i]; if(!p) continue; ctx.lineTo(p.x,p.y); }
    ctx.lineWidth=line.width; ctx.strokeStyle=line.color; ctx.stroke();
  }

  drawWholeLine(line){
    if(!line.points.length) return;
    const ctx=this.drawCtx; ctx.beginPath();
    ctx.moveTo(line.points[0].x,line.points[0].y);
    for(let i=1;i<line.points.length;i++) ctx.lineTo(line.points[i].x,line.points[i].y);
    ctx.lineWidth=line.width; ctx.strokeStyle=line.color; ctx.stroke();
  }

  redrawAll(){ this.clearCanvas(this.drawingsCanvas); for(const l of this.drawings.values()) this.drawWholeLine(l); }
  clearCanvas(c){ c.getContext("2d").clearRect(0,0,c.width,c.height); }

  openModal(){ this.bgModal.style.display="flex"; }
  closeModal(){ this.bgModal.style.display="none"; }

  uploadBackground(){
    const file=this.bgInput.files?.[0]; if(file){
      const r=new FileReader();
      r.onload=ev=>{
        fetch("/upload-background",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({imageData:ev.target.result,fileName:file.name})});
        this.closeModal();
      }; r.readAsDataURL(file); return;
    }
    const url=this.bgUrl.value.trim(); if(!url) return alert("Введите URL");
    const img=new Image(); img.crossOrigin="anonymous";
    img.onload=()=>{
      const tmp=document.createElement("canvas"); tmp.width=img.width; tmp.height=img.height;
      tmp.getContext("2d").drawImage(img,0,0); const data=tmp.toDataURL("image/png");
      fetch("/upload-background",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({imageData:data,fileName:"bg-url.png"})});
      this.closeModal();
    };
    img.onerror=()=>alert("Ошибка загрузки URL"); img.src=url;
  }

  startSender(){
    setInterval(()=>{
      for(const id in this.pointsBuffer){
        const buf=this.pointsBuffer[id];
        if(!buf.length){ delete this.pointsBuffer[id]; continue; }
        const pack=buf.splice(0,MAX_POINTS_PER_BATCH);
        this.socket.emit("pointsBatch",{id,points:pack});
        if(!buf.length) delete this.pointsBuffer[id];
      }
    },SEND_INTERVAL_MS);
  }

  makeId(){ return `${this.socket.id}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }
  debounce(f,t=100){ let id; return (...a)=>{ clearTimeout(id); id=setTimeout(()=>f(...a),t); }; }
}

document.addEventListener("DOMContentLoaded",()=>{ window.app=new SketchApp(); });
})();
