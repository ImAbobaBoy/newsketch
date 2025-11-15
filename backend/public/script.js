// script.js — SketchApp v2: stable square canvases + improved sync + mobile UI
(() => {
  const SEND_INTERVAL_MS = 60;         // чуть реже — меньше пакетов
  const MAX_POINTS_PER_BATCH = 120;    // меньше, чем раньше
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
      this.createdLinesOrder = [];  // for undo
      this.lineSeq = 0;             // sequence per client

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

      // other client created line
      this.socket.on('newLine', line => {
        if (!line || !line.id) return;
        if (!this.drawings.has(line.id)) {
          this.drawings.set(line.id, { ...line, points: line.points || [] });
          // don't draw full immediately — pointsBatch will add segments; but if points exist, draw whole.
          if ((line.points || []).length) this.drawWholeLine(this.drawings.get(line.id));
        }
      });

      // points
      this.socket.on('pointsBatch', ({ id, points }) => {
        if (!id || !points) return;
        let line = this.drawings.get(id);
        if (!line) {
          // create placeholder (server may have created earlier, but in case we never received newLine)
          line = { id, tool: 'brush', color: '#000', width: 2, points: [] };
          this.drawings.set(id, line);
        }
        const start = line.points.length;
        // push points
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
      // draw all existing
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
      img.onerror = () => {
        console.warn('Ошибка загрузки фона', url);
      };
      img.src = url;
    }

    drawBackground(){
      const c = this.backgroundCanvas;
      const ctx = this.bgCtx;
      ctx.clearRect(0,0,c.width,c.height);
      if (!this.backgroundImage) return;

      // fill square preserving aspect by cover
      const side = c.width / this.dpr;
      const img = this.backgroundImage;
      const ratioImg = img.width / img.height;
      const sidePx = side;

      // draw to fill (cover)
      let sw = img.width, sh = img.height, sx=0, sy=0;
      const canvasRatio = 1; // square
      if (ratioImg > canvasRatio) {
        // image wider => crop sides
        const newW = img.height * canvasRatio;
        sx = Math.round((img.width - newW) / 2);
        sw = newW;
      } else if (ratioImg < canvasRatio) {
        // image taller => crop top/bottom
        const newH = img.width / canvasRatio;
        sy = Math.round((img.height - newH) / 2);
        sh = newH;
      }

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

      // send meta (newLine)
      this.socket.emit('newLine', {
        id: line.id,
        tool: line.tool,
        color: line.color,
        width: line.width
      });

      // track order for undo
      this.createdLinesOrder.push(line.id);

      // draw initial dot for brush
      if (line.tool === 'brush') this.drawDot(pos.x, pos.y, line.color, line.width);
    }

    onPointerMove(pos){
      if (!this.isDrawing) return;
      const line = this.drawings.get(this.currentLineId);
      if (!line) return;
      // append and buffer (round to int to reduce packet size)
      const p = { x: Math.round(pos.x), y: Math.round(pos.y) };
      line.points.push(p);
      this.pointsBuffer[line.id] = this.pointsBuffer[line.id] || [];
      this.pointsBuffer[line.id].push(p);
      // immediate draw
      this.drawSegmentImmediate(line);
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
    drawDot(x,y,color,size){
      const ctx = this.drawCtx;
      ctx.beginPath();
      ctx.arc(x,y,size/2,0,Math.PI*2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    drawSegmentImmediate(line){
      const pts = line.points;
      if (pts.length < 2) return;
      const a = pts[pts.length-2], b = pts[pts.length-1];
      if (!a || !b) return;
      const ctx = this.drawCtx;
      ctx.beginPath();
      ctx.moveTo(a.x,a.y);
      ctx.lineTo(b.x,b.y);
      ctx.lineWidth = line.width;
      ctx.strokeStyle = line.color;
      ctx.stroke();
    }

    drawSegmentBatch(line, start, end){
      const ctx = this.drawCtx;
      ctx.lineWidth = line.width;
      ctx.strokeStyle = line.color;
      for (let i = Math.max(1, start); i < end; i++) {
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
      for (let i=1;i<line.points.length;i++) ctx.lineTo(line.points[i].x, line.points[i].y);
      ctx.lineWidth = line.width;
      ctx.strokeStyle = line.color;
      ctx.stroke();
    }

    redrawAll(){
      this.clearCanvas(this.drawingsCanvas);
      for (const l of this.drawings.values()) this.drawWholeLine(l);
    }

    clearCanvas(c){
      c.getContext('2d').clearRect(0,0,c.width,c.height);
    }

    /////////////////////////////////////////////
    // POSITION / SIZING
    /////////////////////////////////////////////
    getCanvasPos(e){
      const rect = this.overlayCanvas.getBoundingClientRect();
      const cssSize = rect.width; // square
      const scale = (this.overlayCanvas.width / this.dpr) / cssSize;
      return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
    }

    adjustCanvases(){
      const rect = this.canvasWrap.getBoundingClientRect();
      let size;
      if (window.innerWidth < 820) {
        size = Math.min(window.innerWidth - 24, window.innerHeight - 120);
      } else {
        const ww = Math.max(rect.width, MIN_CANVAS);
        const hh = Math.max(rect.height, MIN_CANVAS);
        size = Math.min(ww, hh);
      }

      this.dpr = window.devicePixelRatio || 1;

      [this.backgroundCanvas, this.drawingsCanvas, this.overlayCanvas].forEach(c => {
        c.style.width = size + 'px';
        c.style.height = size + 'px';
        c.width = Math.floor(size * this.dpr);
        c.height = Math.floor(size * this.dpr);
        const ctx = c.getContext('2d');
        ctx.setTransform(this.dpr,0,0,this.dpr,0,0);
        ctx.lineCap = ctx.lineJoin = 'round';
      });

      if (this.backgroundImage) this.drawBackground();
      this.redrawAll();
    }

    /////////////////////////////////////////////
    // BACKGROUND MODAL & upload
    /////////////////////////////////////////////
    openModal(){ this.bgModal.style.display = 'flex'; this.bgModal.setAttribute('aria-hidden','false'); }
    closeModal(){ this.bgModal.style.display = 'none'; this.bgModal.setAttribute('aria-hidden','true'); }

    uploadBackground(){
      const file = this.bgInput.files && this.bgInput.files[0];
      if (file) {
        const r = new FileReader();
        r.onload = ev => {
          fetch('/upload-background', {
            method:'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ imageData: ev.target.result, fileName: file.name })
          }).then(()=>this.closeModal());
        };
        r.readAsDataURL(file);
        return;
      }

      const url = this.bgUrl.value.trim();
      if (!url) return alert('Введите URL');
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const tmp = document.createElement('canvas');
        tmp.width = img.width; tmp.height = img.height;
        tmp.getContext('2d').drawImage(img,0,0);
        const data = tmp.toDataURL('image/png');
        fetch('/upload-background', {
          method:'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ imageData: data, fileName: 'bg-url.png' })
        }).then(()=>this.closeModal()).catch(()=>alert('Ошибка при загрузке'));
      };
      img.onerror = () => alert('Ошибка загрузки URL');
      img.src = url;
    }

    /////////////////////////////////////////////
    // SENDER
    /////////////////////////////////////////////
    startSender(){
      setInterval(() => {
        for (const id in this.pointsBuffer) {
          const buf = this.pointsBuffer[id];
          if (!buf || !buf.length) { delete this.pointsBuffer[id]; continue; }

          const pack = buf.splice(0, MAX_POINTS_PER_BATCH);
          // send compacted: coords are already rounded
          this.socket.emit('pointsBatch', { id, points: pack });

          if (!buf.length) delete this.pointsBuffer[id];
        }
      }, SEND_INTERVAL_MS);
    }

    /////////////////////////////////////////////
    // UNDO
    /////////////////////////////////////////////
    undoLast(){
      if (!this.createdLinesOrder.length) return;
      const lastId = this.createdLinesOrder.pop();
      this.drawings.delete(lastId);
      this.socket.emit('deleteLine', lastId);
      this.redrawAll();
    }

    /////////////////////////////////////////////
    // UTILS
    /////////////////////////////////////////////
    makeId(){
      return `${this.socket.id || 'anon'}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    }

    debounce(f,t=100){ let id; return (...a) => { clearTimeout(id); id = setTimeout(()=>f(...a),t); }; }

    renderLoop(){ requestAnimationFrame(()=>this.renderLoop()); }

  } // class end

  document.addEventListener('DOMContentLoaded', () => {
    window.app = new SketchApp();
  });

})();
