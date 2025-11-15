// script.js — Canvas Engine 2.0 optimized for 10-20 users
(() => {
  // Config
  const SEND_INTERVAL_MS = 40;        // batching interval
  const MAX_POINTS_PER_BATCH = 300;   // safety cap per batch
  const MIN_CANVAS_WIDTH = 800;
  const MIN_CANVAS_HEIGHT = 600;

  class SketchApp {
    constructor() {
      // DOM
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
      // mobile duplications
      this.toolSelectMobile = document.getElementById('toolSelectMobile');
      this.colorPickerMobile = document.getElementById('colorPickerMobile');
      this.brushSizeMobile = document.getElementById('brushSizeMobile');

      // modal
      this.bgModal = document.getElementById('backgroundModal');
      this.bgInput = document.getElementById('backgroundInput');
      this.bgUrl   = document.getElementById('backgroundUrl');
      this.loadBgBtn = document.getElementById('loadBackgroundBtn');
      this.modalClose = document.getElementById('modalClose');

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
      this.overlayStart = null;
      this.overlayCur = null;
      this.backgroundImage = null; // Image object
      this.drawings = new Map(); // id -> { id, tool, points, color, width }

      // outgoing buffer: id -> [points]
      this.pointsBuffer = {};

      // bind and init
      this.bindUI();
      this.setupSocket();
      this.adjustCanvases();
      window.addEventListener('resize', this.debounce(() => this.adjustCanvases(), 150));
      this.startSender();
      requestAnimationFrame(()=>this.renderLoop());
    }

    bindUI() {
      // desktop controls
      this.toolSelect.addEventListener('change', e => this.setTool(e.target.value));
      this.colorPicker.addEventListener('change', e => this.setColor(e.target.value));
      this.brushSizeInput.addEventListener('input', e => { this.setBrushSize(+e.target.value); });

      // mobile controls sync
      if (this.toolSelectMobile) {
        this.toolSelectMobile.addEventListener('change', e => {
          this.toolSelect.value = e.target.value;
          this.setTool(e.target.value);
        });
      }
      if (this.colorPickerMobile) {
        this.colorPickerMobile.addEventListener('change', e => {
          this.colorPicker.value = e.target.value;
          this.setColor(e.target.value);
        });
      }
      if (this.brushSizeMobile) {
        this.brushSizeMobile.addEventListener('input', e => {
          this.brushSizeInput.value = e.target.value;
          this.setBrushSize(+e.target.value);
        });
      }

      // top buttons
      document.getElementById('backgroundBtn').addEventListener('click', () => this.openModal());
      document.getElementById('clearBtn').addEventListener('click', () => {
        if (confirm('Очистить холст?')) {
          this.socket.emit('clearCanvas');
          this.drawings.clear();
          this.clearCanvas(this.drawingsCanvas);
        }
      });

      // modal
      this.modalClose.addEventListener('click', () => this.closeModal());
      this.loadBgBtn.addEventListener('click', () => this.uploadBackground());
      // file input change handled in uploadBackground

      // pointer events on overlay
      const overlay = this.overlayCanvas;
      overlay.style.touchAction = 'none';
      overlay.addEventListener('pointerdown', e => {
        overlay.setPointerCapture(e.pointerId);
        const pos = this.getCanvasPos(e);
        this.onPointerDown(pos);
      });
      overlay.addEventListener('pointermove', e => {
        const pos = this.getCanvasPos(e);
        this.onPointerMove(pos);
      });
      overlay.addEventListener('pointerup', e => {
        overlay.releasePointerCapture(e.pointerId);
        this.onPointerUp();
      });
      overlay.addEventListener('pointercancel', () => this.onPointerUp());
    }

    setTool(t) { this.currentTool = t; this.toolSelect.value = t; if (this.toolSelectMobile) this.toolSelectMobile.value = t; }
    setColor(c) { this.currentColor = c; this.colorPicker.value = c; if (this.colorPickerMobile) this.colorPickerMobile.value = c; }
    setBrushSize(s) { this.brushSize = s; this.brushSizeInput.value = s; if (this.brushSizeMobile) this.brushSizeMobile.value = s; this.sizeValue.textContent = s; }

    // socket handlers
    setupSocket() {
      this.socket.on('connect', () => console.log('socket connected', this.socket.id));
      this.socket.on('initialState', state => this.loadState(state));
      this.socket.on('usersUpdate', users => { document.getElementById('usersCount').textContent = (users||[]).length; });
      this.socket.on('newLine', line => {
        if (!this.drawings.has(line.id)) this.drawings.set(line.id, { ...line, points: line.points || [] });
      });
      this.socket.on('pointsBatch', ({ id, points }) => {
        const line = this.drawings.get(id);
        if (line) {
          // append and draw only new part
          const startIndex = line.points.length;
          line.points.push(...points);
          this.drawSegmentBatch(line, startIndex, line.points.length);
        } else {
          // create and draw full
          const newLine = { id, tool: 'brush', points: [...points], color: '#111', width: 2 };
          this.drawings.set(id, newLine);
          this.drawWholeLine(newLine);
        }
      });
      this.socket.on('endLine', ({ id }) => {
        // optional finalization handling
      });
      this.socket.on('lineDeleted', id => {
        this.drawings.delete(id);
        this.redrawAll();
      });
      this.socket.on('canvasCleared', () => {
        this.drawings.clear();
        this.clearCanvas(this.drawingsCanvas);
      });
      this.socket.on('backgroundChanged', ({ backgroundUrl }) => {
        this.setBackground(backgroundUrl);
      });
    }

    loadState(state) {
      // background
      if (state.backgroundImage) this.setBackground(state.backgroundImage);
      // drawings
      this.drawings.clear();
      (state.drawings || []).forEach(d => this.drawings.set(d.id, d));
      this.redrawAll();
      this.loadingEl.style.display = 'none';
      document.getElementById('usersCount').textContent = (state.users || []).length;
    }

    // background: ensure square draw centered
    setBackground(url) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.backgroundImage = img;
        this.drawBackground();
      };
      img.onerror = () => console.warn('background load error', url);
      img.src = url;
    }

    drawBackground() {
      const c = this.backgroundCanvas, ctx = this.bgCtx;
      ctx.clearRect(0,0,c.width,c.height);
      if (!this.backgroundImage) return;
      // compute square size and center
      const cw = c.width / this.dpr, ch = c.height / this.dpr;
      const size = Math.min(cw, ch);
      // drawImage uses canvas pixels already transformed by dpr => we've set transform to dpr already
      const dx = (cw - size) / 2;
      const dy = (ch - size) / 2;
      ctx.drawImage(this.backgroundImage, 0, 0, this.backgroundImage.width, this.backgroundImage.height, dx, dy, size, size);
    }

    // pointer handlers
    onPointerDown(pos) {
      if (this.currentTool === 'diamond') {
        const id = this.makeId();
        const points = this.makeDiamond(pos.x, pos.y);
        const line = { id, tool: 'diamond', points, color: this.currentColor, width: this.brushSize };
        this.drawings.set(id, line);
        this.drawWholeLine(line);
        this.socket.emit('newLine', { id, tool: 'diamond', color: this.currentColor, width: this.brushSize });
        this.socket.emit('pointsBatch', { id, points });
        this.socket.emit('endLine', { id });
        return;
      }

      this.isDrawing = true;
      this.currentLineId = this.makeId();
      const newLine = { id: this.currentLineId, tool: this.currentTool, points: [{...pos}], color: this.currentColor, width: this.brushSize };
      this.drawings.set(this.currentLineId, newLine);
      this.pointsBuffer[this.currentLineId] = [ {...pos} ];
      this.socket.emit('newLine', { id: this.currentLineId, tool: this.currentTool, color: this.currentColor, width: this.brushSize });

      if (this.currentTool === 'brush') {
        this.drawDot(pos.x, pos.y, this.currentColor, this.brushSize);
      } else if (this.currentTool === 'eraser') {
        // handle eraser immediate
        this.handleEraser(pos);
      } else {
        // shapes: prepare overlay preview
        this.overlayStart = pos;
        this.overlayCur = pos;
        this.clearCanvas(this.overlayCanvas);
      }
    }

    onPointerMove(pos) {
      if (!this.isDrawing) return;
      if (this.currentTool === 'eraser') {
        this.handleEraser(pos);
        return;
      }
      if (this.currentTool === 'brush') {
        const line = this.drawings.get(this.currentLineId);
        line.points.push({...pos});
        this.pointsBuffer[this.currentLineId] = this.pointsBuffer[this.currentLineId] || [];
        this.pointsBuffer[this.currentLineId].push({...pos});
        // draw immediately last segment
        this.drawSegmentImmediate(line);
      } else {
        // shapes preview on overlay
        this.overlayCur = pos;
        this.renderOverlay();
      }
    }

    onPointerUp() {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      // finalize
      if (this.currentTool === 'brush') {
        this.socket.emit('endLine', { id: this.currentLineId });
      } else if (this.currentTool !== 'eraser') {
        const points = this.generateShapePoints(this.currentTool, this.overlayStart, this.overlayCur, this.brushSize);
        const line = this.drawings.get(this.currentLineId);
        line.points = points;
        this.drawWholeLine(line);
        // push all to buffer
        this.pointsBuffer[this.currentLineId] = points.slice();
        this.socket.emit('endLine', { id: this.currentLineId });
      }
      this.currentLineId = null;
      this.clearCanvas(this.overlayCanvas);
    }

    // draw helpers
    drawDot(x,y,color,size){
      const ctx = this.drawCtx;
      ctx.beginPath();
      ctx.arc(x,y,size/2,0,Math.PI*2);
      ctx.fillStyle = color; ctx.fill();
    }

    drawSegmentImmediate(line){
      const pts = line.points;
      if (pts.length < 2) return;
      const p1 = pts[pts.length-2], p2 = pts[pts.length-1];
      const ctx = this.drawCtx;
      ctx.beginPath();
      ctx.moveTo(p1.x,p1.y);
      ctx.lineTo(p2.x,p2.y);
      ctx.strokeStyle = line.color; ctx.lineWidth = line.width;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.stroke();
    }

    drawSegmentBatch(line, start, end){
      if (!line.points || line.points.length < 2) return;
      const ctx = this.drawCtx;
      ctx.strokeStyle = line.color; ctx.lineWidth = line.width;
      ctx.lineCap = ctx.lineJoin = 'round';
      // draw from start to end indices
      for (let i = Math.max(1, start); i < end; i++){
        const a = line.points[i-1], b = line.points[i];
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x,a.y);
        ctx.lineTo(b.x,b.y);
        ctx.stroke();
      }
    }

    drawWholeLine(line){
      if (!line.points || line.points.length < 1) return;
      const ctx = this.drawCtx;
      ctx.beginPath();
      ctx.moveTo(line.points[0].x, line.points[0].y);
      for (let i=1;i<line.points.length;i++){
        ctx.lineTo(line.points[i].x, line.points[i].y);
      }
      ctx.strokeStyle = line.color; ctx.lineWidth = line.width;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.stroke();
    }

    drawWholeLineFromMapEntry(entry) {
      this.drawWholeLine(entry);
    }

    redrawAll(){
      this.clearCanvas(this.drawingsCanvas);
      for (const line of this.drawings.values()) {
        this.drawWholeLine(line);
      }
    }

    clearCanvas(canvas){
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,canvas.width,canvas.height);
    }

    // overlay preview for shapes
    renderOverlay(){
      this.clearCanvas(this.overlayCanvas);
      if (!this.overlayStart || !this.overlayCur) return;
      const a = this.overlayStart, b = this.overlayCur;
      const ctx = this.ovCtx;
      ctx.lineWidth = this.brushSize;
      ctx.strokeStyle = this.currentColor;
      ctx.setLineDash([6,6]);
      ctx.beginPath();
      if (this.currentTool === 'line'){
        ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      } else if (this.currentTool === 'rectangle'){
        const x = Math.min(a.x,b.x), y = Math.min(a.y,b.y), w = Math.abs(a.x-b.x), h = Math.abs(a.y-b.y);
        ctx.strokeRect(x,y,w,h);
      } else if (this.currentTool === 'circle'){
        const dx = b.x - a.x, dy = b.y - a.y;
        const r = Math.sqrt(dx*dx + dy*dy);
        ctx.beginPath(); ctx.arc(a.x,a.y,r,0,Math.PI*2); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // shape conversion
    generateShapePoints(tool,a,b,size){
      if (!a || !b) return [];
      if (tool === 'line') return [a,b];
      if (tool === 'rectangle') return [
        {x:a.x,y:a.y},{x:b.x,y:a.y},{x:b.x,y:b.y},{x:a.x,y:b.y},{x:a.x,y:a.y}
      ];
      if (tool === 'circle') {
        const dx = b.x - a.x, dy = b.y - a.y;
        const r = Math.sqrt(dx*dx + dy*dy);
        const steps = 40;
        const res = [];
        for (let i=0;i<=steps;i++){
          const th = (i/steps)*Math.PI*2;
          res.push({ x: a.x + Math.cos(th)*r, y: a.y + Math.sin(th)*r });
        }
        return res;
      }
      return [];
    }

    makeDiamond(cx,cy){
      const s = this.brushSize * 4;
      return [{x:cx,y:cy-s},{x:cx+s,y:cy},{x:cx,y:cy+s},{x:cx-s,y:cy},{x:cx,y:cy-s}];
    }

    handleEraser(pos){
      const r = this.brushSize * 2;
      const toDelete = [];
      for (const [id,line] of this.drawings){
        for (let i=0;i<line.points.length;i++){
          const p = line.points[i];
          const dx = p.x - pos.x, dy = p.y - pos.y;
          if (dx*dx + dy*dy <= r*r){ toDelete.push(id); break; }
        }
      }
      if (toDelete.length){
        toDelete.forEach(id => {
          this.drawings.delete(id);
          this.socket.emit('deleteLine', id);
        });
        this.redrawAll();
      }
    }

    // sender: periodic batching
    startSender(){
      this.sendTimer = setInterval(() => {
        for (const id of Object.keys(this.pointsBuffer)){
          const buf = this.pointsBuffer[id];
          if (!buf || buf.length === 0) { delete this.pointsBuffer[id]; continue; }
          const sendCount = Math.min(MAX_POINTS_PER_BATCH, buf.length);
          const toSend = buf.splice(0, sendCount);
          // send as JSON; for production consider msgpack/protobuf binary encode
          this.socket.emit('pointsBatch', { id, points: toSend });
          if (buf.length === 0) delete this.pointsBuffer[id];
        }
      }, SEND_INTERVAL_MS);
    }

    // utils
    makeId(){ return `${this.socket.id||'anon'}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }

    getCanvasPos(e){
      const rect = this.overlayCanvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (this.overlayCanvas.width / rect.width) / this.dpr;
      const y = (e.clientY - rect.top)  * (this.overlayCanvas.height / rect.height) / this.dpr;
      return { x, y };
    }

    // canvas sizing, retina
    adjustCanvases(){
      // size to wrapper size, with min dims
      const rect = this.canvasWrap.getBoundingClientRect();
      const cssW = Math.max(rect.width, MIN_CANVAS_WIDTH);
      const cssH = Math.max(rect.height, MIN_CANVAS_HEIGHT);
      this.dpr = window.devicePixelRatio || 1;

      [this.backgroundCanvas, this.drawingsCanvas, this.overlayCanvas].forEach(c => {
        c.style.width = cssW + 'px';
        c.style.height = cssH + 'px';
        c.width = Math.floor(cssW * this.dpr);
        c.height = Math.floor(cssH * this.dpr);
        const ctx = c.getContext('2d');
        ctx.setTransform(this.dpr,0,0,this.dpr,0,0);
        ctx.lineJoin = ctx.lineCap = 'round';
      });

      // redraw background and drawings to new size
      if (this.backgroundImage) this.drawBackground();
      this.redrawAll();
    }

    renderLoop(){
      // overlay drawn reactively on events; keep loop for animations if needed
      requestAnimationFrame(()=>this.renderLoop());
    }

    // modal handling + upload background
    openModal(){
      this.bgModal.setAttribute('aria-hidden','false');
      this.bgModal.style.display = 'flex';
    }
    closeModal(){
      this.bgModal.setAttribute('aria-hidden','true');
      this.bgModal.style.display = 'none';
    }
    uploadBackground(){
      const file = this.bgInput.files && this.bgInput.files[0];
      if (file){
        const reader = new FileReader();
        reader.onload = (ev) => {
          fetch('/upload-background', {
            method:'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ imageData: ev.target.result, fileName: file.name })
          }).then(r=>r.json()).then(j => {
            if (j.success) this.closeModal(); else alert('Ошибка: ' + (j.error || 'unknown'));
          }).catch(err => alert('Ошибка загрузки: ' + err));
        };
        reader.readAsDataURL(file);
      } else if (this.bgUrl.value.trim()){
        const url = this.bgUrl.value.trim();
        // convert remote image to dataURL via temporary canvas (CORS free if server allows)
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const tmp = document.createElement('canvas');
          tmp.width = img.width; tmp.height = img.height;
          tmp.getContext('2d').drawImage(img,0,0);
          const data = tmp.toDataURL('image/png');
          fetch('/upload-background', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ imageData: data, fileName: 'bg-url.png' })
          }).then(r=>r.json()).then(j => {
            if (j.success) this.closeModal(); else alert('Ошибка: ' + (j.error || 'unknown'));
          }).catch(err => alert('Ошибка: ' + err));
        };
        img.onerror = () => alert('Не удалось загрузить изображение по URL (CORS или неверный URL)');
        img.src = url;
      } else {
        alert('Выберите файл или вставьте URL');
      }
    }

    // util: debounce
    debounce(fn, t=100){ let id; return (...a) => { clearTimeout(id); id = setTimeout(()=>fn(...a), t); }; }
  }

  // init
  document.addEventListener('DOMContentLoaded', () => {
    window.app = new SketchApp();
  });

})();
