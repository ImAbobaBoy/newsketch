(() => {
  const SEND_INTERVAL_MS = 60;
  const MAX_POINTS_PER_BATCH = 120;
  const MIN_CANVAS = 800;

  class SketchApp {
    constructor() {
      // canvases
      this.backgroundCanvas = document.getElementById('backgroundCanvas');
      this.drawingsCanvas   = document.getElementById('drawingsCanvas');
      this.overlayCanvas    = document.getElementById('overlayCanvas');
      this.canvasWrap       = document.getElementById('canvasWrap');
      this.loadingEl        = document.getElementById('loading');

      // controls
      this.toolSelect = document.getElementById('toolSelect');
      this.colorPicker = document.getElementById('colorPicker');
      this.brushSizeInput = document.getElementById('brushSize');
      this.sizeValue = document.getElementById('sizeValue');
      this.undoBtn = document.getElementById('undoBtn');

      // modal elements
      this.bgModal = document.getElementById('backgroundModal');
      this.bgInput = document.getElementById('backgroundInput');
      this.bgUrl   = document.getElementById('backgroundUrl');
      this.loadBgBtn = document.getElementById('loadBackgroundBtn');
      this.modalClose = document.getElementById('modalClose');
      this.cancelBgBtn = document.getElementById('cancelBgBtn');

      // mobile inputs
      this.colorPickerMobile = document.getElementById('colorPickerMobile');
      this.brushSizeMobile = document.getElementById('brushSizeMobile');

      // socket
      this.socket = io();

      // contexts
      this.bgCtx = this.backgroundCanvas.getContext('2d');
      this.drawCtx = this.drawingsCanvas.getContext('2d');
      this.ovCtx = this.overlayCanvas.getContext('2d');

      // state
      this.dpr = window.devicePixelRatio || 1;
      this.currentTool = 'brush';
      this.currentColor = '#ff6b6b';
      this.brushSize = 3;
      this.isDrawing = false;
      this.currentLineId = null;
      this.backgroundImage = null;
      this.drawings = new Map();    // id -> { id, tool, color, width, points:[] }
      this.pointsBuffer = {};       // id -> [point,...]
      this.createdLinesOrder = [];
      this.lineSeq = 0;
      this.pendingDraws = [];       // очередь сегментов для 60FPS

      this.bindUI();
      this.setupSocket();
      this.adjustCanvases();

      window.addEventListener('resize', this.debounce(() => this.adjustCanvases(), 120));
      this.startSender();
      requestAnimationFrame(() => this.renderLoop());
    }

    /////////////////////////////////////////////
    // UI
    /////////////////////////////////////////////
    bindUI() {
      if (this.toolSelect) this.toolSelect.addEventListener('change', e => this.setTool(e.target.value));
      if (this.colorPicker) this.colorPicker.addEventListener('change', e => this.setColor(e.target.value));
      if (this.brushSizeInput) this.brushSizeInput.addEventListener('input', e => this.setBrushSize(+e.target.value));
      if (this.undoBtn) this.undoBtn.addEventListener('click', () => this.undoLast());

      // mobile controls
      if (this.colorPickerMobile) this.colorPickerMobile.addEventListener('change', e => {
        this.colorPicker.value = e.target.value; this.setColor(e.target.value);
      });
      if (this.brushSizeMobile) this.brushSizeMobile.addEventListener('input', e => {
        this.brushSizeInput.value = e.target.value; this.setBrushSize(+e.target.value);
      });

      // top buttons
      document.getElementById('backgroundBtn').addEventListener('click', () => this.openModal());
      document.getElementById('clearBtn').addEventListener('click', () => {
        if (confirm('Очистить холст?')) {
          this.socket.emit('clearCanvas');
          this.drawings.clear();
          this.createdLinesOrder = [];
          this.clearCanvas(this.drawingsCanvas);
        }
      });

      this.modalClose.addEventListener('click', () => this.closeModal());
      this.cancelBgBtn.addEventListener('click', () => this.closeModal());
      this.loadBgBtn.addEventListener('click', () => this.uploadBackground());

      // sidebar/tool buttons
      document.querySelectorAll('.tool, .mtool').forEach(btn => {
        btn.addEventListener('click', e => {
          const t = e.currentTarget.dataset.tool;
          if (!t) return;
          this.setTool(t);
          if (this.toolSelect) this.toolSelect.value = t;
        });
      });

      // pointer events on overlay
      const overlay = this.overlayCanvas;
      overlay.style.touchAction = "none";
      overlay.addEventListener("pointerdown", e => {
        overlay.setPointerCapture(e.pointerId);
        const pos = this.getCanvasPos(e);
        this.onPointerDown(pos);
      });
      overlay.addEventListener("pointermove", e => {
        const pos = this.getCanvasPos(e);
        this.onPointerMove(pos);
      });
      overlay.addEventListener("pointerup", e => {
        overlay.releasePointerCapture(e.pointerId);
        this.onPointerUp();
      });
      overlay.addEventListener("pointercancel", () => this.onPointerUp());
    }

    setTool(v){ this.currentTool = v; }
    setColor(v){ this.currentColor = v; }
    setBrushSize(v){ this.brushSize = v; this.sizeValue.textContent = v; }

    /////////////////////////////////////////////
    // SOCKET
    /////////////////////////////////////////////
    setupSocket() {
      this.socket.on('connect', () => console.log('socket connected', this.socket.id));
      this.socket.on('initialState', s => this.loadState(s));
      this.socket.on('usersUpdate', users => {
        document.getElementById('usersCount').textContent = (users && users.length) || 0;
      });

      this.socket.on('newLine', line => {
        if (!line || !line.id) return;
        if (!this.drawings.has(line.id)) {
          this.drawings.set(line.id, { ...line, points: line.points || [] });
          if ((line.points || []).length) this.drawWholeLine(this.drawings.get(line.id));
        }
      });

      this.socket.on('pointsBatch', ({ id, points }) => {
        if (!id || !points) return;
        let line = this.drawings.get(id);
        if (!line) {
          line = { id, tool: 'brush', color: '#000', width: 2, points: [] };
          this.drawings.set(id, line);
        }
        const start = line.points.length;
        line.points.push(...points);
        this.drawSegmentBatch(line, start, line.points.length);
      });

      this.socket.on('lineDeleted', id => {
        this.drawings.delete(id);
        this.createdLinesOrder = this.createdLinesOrder.filter(x => x !== id);
        this.redrawAll();
      });

      this.socket.on('canvasCleared', () => {
        this.drawings.clear();
        this.createdLinesOrder = [];
        this.clearCanvas(this.drawingsCanvas);
      });

      this.socket.on('backgroundChanged', ({ backgroundUrl }) => {
        if (backgroundUrl) this.setBackground(backgroundUrl);
      });
    }

    loadState(state){
      if (!state) return;
      if (state.backgroundImage) this.setBackground(state.backgroundImage);
      this.drawings.clear();
      (state.drawings || []).forEach(d => this.drawings.set(d.id, d));
      this.redrawAll();
      this.loadingEl.style.display = 'none';
    }

    /////////////////////////////////////////////
    // BACKGROUND
    /////////////////////////////////////////////
    setBackground(url){
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        this.backgroundImage = img;
        this.drawBackground();
      };
      img.onerror = () => { console.warn('Ошибка загрузки фона', url); };
      img.src = url;
    }

    drawBackground(){
      const c = this.backgroundCanvas;
      const ctx = this.bgCtx;
      ctx.clearRect(0,0,c.width,c.height);
      if (!this.backgroundImage) return;

      const sidePx = c.width / this.dpr;
      const img = this.backgroundImage;
      const ratioImg = img.width / img.height;

      let sw = img.width, sh = img.height, sx=0, sy=0;
      const canvasRatio = 1;
      if (ratioImg > canvasRatio) { sw = img.height; sx = (img.width - sw)/2; }
      else if (ratioImg < canvasRatio) { sh = img.width; sy = (img.height - sh)/2; }

      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sidePx, sidePx);
    }

    /////////////////////////////////////////////
    // POINTER
    /////////////////////////////////////////////
    onPointerDown(pos){
      this.isDrawing = true;
      this.lineSeq += 1;
      this.currentLineId = `${this.socket.id || 'anon'}-${Date.now()}-${this.lineSeq}`;

      const line = {
        id: this.currentLineId,
        tool: this.currentTool,
        points: [pos],
        color: this.currentColor,
        width: this.brushSize
      };

      this.drawings.set(line.id, { ...line, points: [pos] });
      this.pointsBuffer[line.id] = [pos];
      this.createdLinesOrder.push(line.id);

      this.socket.emit('newLine', { id: line.id, tool: line.tool, color: line.color, width: line.width });

      // draw initial dot for brush or eraser
      this.pendingDraws.push({ line, points: [pos,pos] });
    }

    onPointerMove(pos){
      if (!this.isDrawing) return;
      const line = this.drawings.get(this.currentLineId);
      if (!line) return;
      const p = { x: Math.round(pos.x), y: Math.round(pos.y) };
      line.points.push(p);
      this.pointsBuffer[line.id] = this.pointsBuffer[line.id] || [];
      this.pointsBuffer[line.id].push(p);
      this.pendingDraws.push({ line, points: [line.points[line.points.length-2], p] });
    }

    onPointerUp(){
      if (!this.isDrawing) return;
      this.isDrawing = false;
      if (this.currentLineId) {
        this.socket.emit('endLine', { id: this.currentLineId });
        this.currentLineId = null;
      }
    }

    /////////////////////////////////////////////
    // DRAW routines
    /////////////////////////////////////////////
    drawSegmentBatch(line, start, end){
      for(let i=Math.max(1,start); i<end; i++){
        const a=line.points[i-1], b=line.points[i];
        if(!a||!b) continue;
        this.pendingDraws.push({ line, points: [a,b] });
      }
    }

    drawWholeLine(line){
      if(line.points.length<2) return;
      this.drawSegmentBatch(line,0,line.points.length);
    }

    renderLoop(){
      if(this.pendingDraws.length){
        const ctx = this.drawCtx;
        ctx.lineCap = ctx.lineJoin = 'round';
        this.pendingDraws.forEach(item=>{
          const [a,b] = item.points;
          if(!a||!b) return;
          ctx.beginPath();
          ctx.moveTo(a.x,a.y);
          ctx.lineTo(b.x,b.y);
          ctx.strokeStyle = item.line.tool==='eraser'?'rgba(0,0,0,1)':item.line.color;
          ctx.lineWidth = item.line.width;
          ctx.globalCompositeOperation = item.line.tool==='eraser'?'destination-out':'source-over';
          ctx.stroke();
          ctx.globalCompositeOperation='source-over';
        });
        this.pendingDraws = [];
      }
      requestAnimationFrame(()=>this.renderLoop());
    }

    /////////////////////////////////////////////
    // SENDER
    /////////////////////////////////////////////
    startSender(){
      setInterval(()=>{
        for(const id in this.pointsBuffer){
          const buf = this.pointsBuffer[id];
          if(buf && buf.length){
            const pack = buf.splice(0, MAX_POINTS_PER_BATCH);
            this.socket.emit('pointsBatch',{id, points: pack});
          }
        }
      }, SEND_INTERVAL_MS);
    }

    /////////////////////////////////////////////
    // UNDO
    /////////////////////////////////////////////
    undoLast(){
      if(!this.createdLinesOrder.length) return;
      const lastId = this.createdLinesOrder.pop();
      this.drawings.delete(lastId);
      this.socket.emit('deleteLine', lastId);
      this.redrawAll();
    }

    /////////////////////////////////////////////
    // UTILS
    /////////////////////////////////////////////
    clearCanvas(c){ c.getContext('2d').clearRect(0,0,c.width,c.height); if(c===this.drawingsCanvas) this.drawBackground(); }
    redrawAll(){ this.clearCanvas(this.drawingsCanvas); for(const line of this.drawings.values()) this.drawWholeLine(line); }

    getCanvasPos(e){
      const rect=this.overlayCanvas.getBoundingClientRect();
      const scaleX=this.overlayCanvas.width/rect.width;
      const scaleY=this.overlayCanvas.height/rect.height;
      return { x:(e.clientX-rect.left)*scaleX, y:(e.clientY-rect.top)*scaleY };
    }

    adjustCanvases(){
      const rect = this.canvasWrap.getBoundingClientRect();
      let size;
      if(window.innerWidth<820){
        size = Math.min(window.innerWidth-24, window.innerHeight-120);
      } else {
        const ww = Math.max(rect.width, MIN_CANVAS);
        const hh = Math.max(rect.height, MIN_CANVAS);
        size = Math.min(ww, hh);
      }

      this.dpr = window.devicePixelRatio || 1;

      [this.backgroundCanvas,this.drawingsCanvas,this.overlayCanvas].forEach(c=>{
        c.style.width = size+'px';
        c.style.height = size+'px';
        c.width = Math.floor(size*this.dpr);
        c.height = Math.floor(size*this.dpr);
        const ctx=c.getContext('2d');
        ctx.setTransform(this.dpr,0,0,this.dpr,0,0);
        ctx.lineCap = ctx.lineJoin = 'round';
      });

      if(this.backgroundImage) this.drawBackground();
      this.redrawAll();
    }

    openModal(){ this.bgModal.style.display='flex'; this.bgModal.setAttribute('aria-hidden','false'); }
    closeModal(){ this.bgModal.style.display='none'; this.bgModal.setAttribute('aria-hidden','true'); }

    uploadBackground(){
      const file = this.bgInput.files && this.bgInput.files[0];
      const url = this.bgUrl.value.trim();

      if(file){
        const reader = new FileReader();
        reader.onload = ev=>{
          fetch('/upload-background',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ imageData: ev.target.result, fileName: file.name })
          }).then(()=>this.closeModal());
        };
        reader.readAsDataURL(file);
        return;
      }

      if(url){
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = ()=>{
          const tmp = document.createElement('canvas');
          tmp.width = img.width; tmp.height = img.height;
          tmp.getContext('2d').drawImage(img,0,0);
          const data = tmp.toDataURL('image/png');
          fetch('/upload-background',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ imageData: data, fileName: 'bg-url.png' })
          }).then(()=>this.closeModal());
        };
        img.onerror = ()=>alert('Ошибка загрузки URL');
        img.src = url;
        return;
      }

      alert('Выберите файл или вставьте URL');
    }

    debounce(fn,delay=100){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args),delay); }; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.app = new SketchApp();
  });

})();
