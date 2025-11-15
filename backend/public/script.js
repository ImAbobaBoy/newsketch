// script.js
class DrawingApp {
  constructor() {
    this.backgroundCanvas = document.getElementById('backgroundCanvas');
    this.drawingsCanvas = document.getElementById('drawingsCanvas');
    this.overlayCanvas = document.getElementById('overlayCanvas');

    this.bgCtx = this.backgroundCanvas.getContext('2d');
    this.drawCtx = this.drawingsCanvas.getContext('2d');
    this.overlayCtx = this.overlayCanvas.getContext('2d');

    this.socket = io();

    this.currentTool = 'brush';
    this.currentColor = '#ff0000';
    this.brushSize = 3;

    this.isDrawing = false;
    this.currentLineId = null;

    // Map: id -> { tool, points, color, width }
    this.drawings = new Map();

    // Local buffer for outgoing points
    this.pointsBuffer = {}; // id -> [points]

    // Batch send interval (ms)
    this.sendInterval = 40;

    this.backgroundImage = null;

    this.setupUI();
    this.setupSocket();
    this.resizeCanvases();
    window.addEventListener('resize', () => this.resizeCanvases());
    this.startSender();
    this.animationLoop();
  }

  setupUI() {
    document.getElementById('toolSelect').addEventListener('change', e => this.currentTool = e.target.value);
    document.getElementById('colorPicker').addEventListener('change', e => this.currentColor = e.target.value);
    const brushSize = document.getElementById('brushSize');
    const sizeValue = document.getElementById('sizeValue');
    brushSize.addEventListener('input', e => { this.brushSize = +e.target.value; sizeValue.textContent = this.brushSize; });

    document.getElementById('clearBtn').addEventListener('click', () => {
      if (confirm('Очистить холст?')) {
        this.socket.emit('clearCanvas');
        this.drawings.clear();
        this.clearCanvasLayer(this.drawingsCanvas);
      }
    });

    document.getElementById('backgroundBtn').addEventListener('click', () => {
      document.getElementById('backgroundModal').style.display = 'block';
    });

    this.setupModal();
    this.setupCanvasEvents();
  }

  setupModal() {
    const modal = document.getElementById('backgroundModal');
    const close = modal.querySelector('.close');
    close.onclick = () => modal.style.display = 'none';
    window.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };

    document.getElementById('loadBackgroundBtn').addEventListener('click', () => this.uploadBackground());
  }

  uploadBackground() {
    const fileInput = document.getElementById('backgroundInput');
    const urlInput = document.getElementById('backgroundUrl');

    if (fileInput.files && fileInput.files[0]) {
      const f = fileInput.files[0];
      const reader = new FileReader();
      reader.onload = (ev) => {
        fetch('/upload-background', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ imageData: ev.target.result, fileName: f.name })
        }).then(r => r.json()).then(d => {
          if (d.success) document.getElementById('backgroundModal').style.display = 'none';
          else alert('Error: ' + d.error);
        }).catch(err => alert('Ошибка: ' + err));
      };
      reader.readAsDataURL(f);
    } else if (urlInput.value) {
      this.loadImageFromUrl(urlInput.value);
    } else alert('Выберите файл или введите URL');
  }

  loadImageFromUrl(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img,0,0);
      const data = canvas.toDataURL('image/png');
      fetch('/upload-background', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ imageData: data, fileName: 'bg-url.png' })
      }).then(r=>r.json()).then(d => {
        if (d.success) document.getElementById('backgroundModal').style.display = 'none';
        else alert('Ошибка: ' + d.error);
      }).catch(err => alert('Ошибка: ' + err));
    };
    img.onerror = () => alert('Не удалось загрузить изображение по URL');
    img.src = url;
  }

  setupSocket() {
    this.socket.on('initialState', (state) => {
      // background
      if (state.backgroundImage) this.setBackground(state.backgroundImage);
      // drawings
      this.drawings.clear();
      (state.drawings || []).forEach(d => this.drawings.set(d.id, d));
      // draw existing drawings onto drawingsCanvas
      this.redrawAllDrawings();
      document.getElementById('usersCount').textContent = state.users.length || 0;
      document.getElementById('loading').style.display = 'none';
    });

    this.socket.on('usersUpdate', users => {
      document.getElementById('usersCount').textContent = users.length;
    });

    this.socket.on('newLine', (line) => {
      // prepare empty line
      if (!this.drawings.has(line.id)) {
        this.drawings.set(line.id, { ...line, points: line.points || [] });
      }
    });

    this.socket.on('pointsBatch', ({ id, points }) => {
      const existing = this.drawings.get(id);
      if (existing) {
        existing.points.push(...points);
        // draw only the received points on drawingsCanvas
        this.drawPointsOnDrawingsCanvas(existing, points);
      } else {
        // create and draw
        this.drawings.set(id, { id, tool:'brush', points:[...points], color:'#000', width:2 });
        this.drawPointsOnDrawingsCanvas(this.drawings.get(id), points, true);
      }
    });

    this.socket.on('lineDeleted', (id) => {
      this.drawings.delete(id);
      this.redrawAllDrawings(); // we could optimize to redraw everything or per-line; for simplicity redraw all
    });

    this.socket.on('canvasCleared', () => {
      this.drawings.clear();
      this.clearCanvasLayer(this.drawingsCanvas);
    });

    this.socket.on('backgroundChanged', ({ backgroundUrl }) => {
      this.setBackground(backgroundUrl);
    });
  }

  // Canvas events (mouse + touch)
  setupCanvasEvents() {
    const overlay = this.overlayCanvas;
    // pointer events unify mouse/touch
    overlay.style.touchAction = 'none';

    overlay.addEventListener('pointerdown', (e) => {
      overlay.setPointerCapture(e.pointerId);
      const pos = this.getCanvasPos(e);
      this.pointerDown(pos);
    });

    overlay.addEventListener('pointermove', (e) => {
      const pos = this.getCanvasPos(e);
      this.pointerMove(pos);
    });

    overlay.addEventListener('pointerup', (e) => {
      overlay.releasePointerCapture(e.pointerId);
      this.pointerUp();
    });

    overlay.addEventListener('pointercancel', () => this.pointerUp());
  }

  pointerDown(pos) {
    if (this.currentTool === 'diamond') {
      // immediate diamond
      const id = this.makeId();
      const points = this.makeDiamondPoints(pos.x, pos.y);
      const line = { id, tool:'diamond', points, color:this.currentColor, width:this.brushSize };
      this.drawings.set(id, line);
      this.drawWholeLineOnDrawingsCanvas(line);
      // send metadata + full points once
      this.socket.emit('newLine', { id, tool: 'diamond', color: this.currentColor, width: this.brushSize });
      this.socket.emit('pointsBatch', { id, points });
      this.socket.emit('endLine', { id });
      return;
    }

    this.isDrawing = true;
    this.currentLineId = this.makeId();
    // create local line structure
    const lineMeta = { id: this.currentLineId, tool: this.currentTool, points: [pos], color: this.currentColor, width: this.brushSize };
    this.drawings.set(this.currentLineId, { ...lineMeta });

    // ensure buffer exists
    this.pointsBuffer[this.currentLineId] = [pos];

    // notify server that line started
    this.socket.emit('newLine', { id: this.currentLineId, tool: this.currentTool, color: this.currentColor, width: this.brushSize });

    // preview initial point on overlay for shapes
    if (this.currentTool !== 'brush' && this.currentTool !== 'eraser') {
      // shapes use overlay to preview; other handlers will update overlay
      this.overlayStartPos = pos;
      this.overlayCurrentPos = pos;
      this.renderOverlay();
    } else {
      // for brush, draw immediately a dot on drawingsCanvas to give instant feedback
      this.drawDotOnDrawingsCanvas(pos.x, pos.y, this.currentColor, this.brushSize);
    }
  }

  pointerMove(pos) {
    if (!this.isDrawing) return;

    if (this.currentTool === 'eraser') {
      this.handleEraser(pos);
      return;
    }

    if (this.currentTool === 'brush') {
      // append point locally and draw immediately on drawings canvas
      const line = this.drawings.get(this.currentLineId);
      line.points.push(pos);
      this.pointsBuffer[this.currentLineId] = this.pointsBuffer[this.currentLineId] || [];
      this.pointsBuffer[this.currentLineId].push(pos);

      this.drawSegmentOnDrawingsCanvas(line, pos);
    } else {
      // shapes & line: update overlay preview
      this.overlayCurrentPos = pos;
      this.renderOverlay();
    }
  }

  pointerUp() {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    if (this.currentTool === 'brush') {
      // flush immediate: points will be sent by batcher soon; we can also mark end
      this.socket.emit('endLine', { id: this.currentLineId });
    } else if (this.currentTool === 'eraser') {
      // nothing special
    } else {
      // finalize shape: compute final points, draw onto drawingsCanvas and send
      const shapePoints = this.generateShapePoints(this.currentTool, this.overlayStartPos, this.overlayCurrentPos, this.brushSize);
      const line = this.drawings.get(this.currentLineId);
      line.points = shapePoints;
      this.drawWholeLineOnDrawingsCanvas(line);
      // ensure buffer sends the full shape
      this.pointsBuffer[this.currentLineId] = shapePoints.slice();
      // server notifications
      this.socket.emit('endLine', { id: this.currentLineId });
    }

    // clear overlay
    this.clearCanvasLayer(this.overlayCanvas);
    this.currentLineId = null;
  }

  // ---- drawing helpers ----
  makeId() { return `${this.socket.id || 'anon'}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`; }

  getCanvasPos(e) {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const dpr = this.dpr || 1;
    return {
      x: (e.clientX - rect.left) * (this.overlayCanvas.width / rect.width) / dpr,
      y: (e.clientY - rect.top) * (this.overlayCanvas.height / rect.height) / dpr
    };
  }

  // draw single dot (initial point)
  drawDotOnDrawingsCanvas(x, y, color, size) {
    const ctx = this.drawCtx;
    ctx.beginPath();
    ctx.arc(x, y, size/2, 0, Math.PI*2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // draw a single new segment for brush: from previous point to new point
  drawSegmentOnDrawingsCanvas(line, newPoint) {
    const pts = line.points;
    if (pts.length < 2) return;
    const p1 = pts[pts.length - 2];
    const p2 = pts[pts.length - 1];
    const ctx = this.drawCtx;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.stroke();
  }

  drawPointsOnDrawingsCanvas(line, points, drawFirst = false) {
    // If drawFirst true, draw full segments from line.points
    const ctx = this.drawCtx;
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width;
    ctx.lineJoin = ctx.lineCap = 'round';

    // If there are previous points, start from last existing
    let startIndex = 0;
    if (!drawFirst && line.points.length > points.length) {
      startIndex = line.points.length - points.length - 1;
      if (startIndex < 0) startIndex = 0;
    }

    for (let i = 0; i < points.length; i++) {
      const idx = startIndex + i;
      if (idx === 0 && !drawFirst) continue;
      const pPrev = (line.points[idx - 1]) || points[Math.max(0, i - 1)];
      const pCurr = points[i];
      if (!pPrev) continue;
      ctx.beginPath();
      ctx.moveTo(pPrev.x, pPrev.y);
      ctx.lineTo(pCurr.x, pCurr.y);
      ctx.stroke();
    }
  }

  drawWholeLineOnDrawingsCanvas(line) {
    if (!line.points || line.points.length < 1) return;
    const ctx = this.drawCtx;
    ctx.beginPath();
    ctx.moveTo(line.points[0].x, line.points[0].y);
    for (let i = 1; i < line.points.length; i++) {
      ctx.lineTo(line.points[i].x, line.points[i].y);
    }
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.stroke();
  }

  redrawAllDrawings() {
    // clear draw canvas and re-draw all lines from Map
    this.clearCanvasLayer(this.drawingsCanvas);
    for (const line of this.drawings.values()) {
      this.drawWholeLineOnDrawingsCanvas(line);
    }
  }

  clearCanvasLayer(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // ---- overlay rendering for shapes ----
  renderOverlay() {
    this.clearCanvasLayer(this.overlayCanvas);
    if (!this.overlayStartPos || !this.overlayCurrentPos) return;
    const a = this.overlayStartPos;
    const b = this.overlayCurrentPos;
    const ctx = this.overlayCtx;
    ctx.lineWidth = this.brushSize;
    ctx.strokeStyle = this.currentColor;
    ctx.fillStyle = this.currentColor;
    ctx.lineJoin = ctx.lineCap = 'round';

    switch (this.currentTool) {
      case 'line':
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); break;
      case 'rectangle':
        const x = Math.min(a.x,b.x), y = Math.min(a.y,b.y);
        const w = Math.abs(a.x-b.x), h = Math.abs(a.y-b.y);
        ctx.strokeRect(x,y,w,h); break;
      case 'circle':
        const rx = (b.x - a.x), ry = (b.y - a.y);
        const r = Math.sqrt(rx*rx + ry*ry);
        ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, Math.PI*2); ctx.stroke(); break;
      default: break;
    }
  }

  generateShapePoints(tool, a, b, size) {
    // Convert shapes to point arrays for server/clients.
    const points = [];
    if (!a || !b) return points;
    if (tool === 'line') {
      points.push(a, b);
    } else if (tool === 'rectangle') {
      points.push({x:a.x, y:a.y}, {x:b.x, y:a.y}, {x:b.x, y:b.y}, {x:a.x, y:b.y}, {x:a.x, y:a.y});
    } else if (tool === 'circle') {
      // sample circle into points (~32)
      const rx = b.x - a.x, ry = b.y - a.y;
      const r = Math.sqrt(rx*rx + ry*ry);
      const steps = 32;
      for (let i=0;i<=steps;i++){
        const theta = (i/steps) * Math.PI * 2;
        points.push({ x: a.x + Math.cos(theta)*r, y: a.y + Math.sin(theta)*r });
      }
    } else if (tool === 'diamond') {
      return this.makeDiamondPoints(a.x, a.y);
    }
    return points;
  }

  makeDiamondPoints(cx, cy) {
    const s = this.brushSize * 4;
    return [
      {x:cx, y:cy - s},
      {x:cx + s, y:cy},
      {x:cx, y:cy + s},
      {x:cx - s, y:cy},
      {x:cx, y:cy - s}
    ];
  }

  // ---- eraser ----
  handleEraser(pos) {
    // Simple strategy: find lines with any point within radius and delete them
    const r = this.brushSize * 2;
    const toDelete = [];
    for (const [id, line] of this.drawings) {
      for (let i=0;i<line.points.length;i++) {
        const p = line.points[i];
        const dx = p.x - pos.x, dy = p.y - pos.y;
        if (dx*dx + dy*dy <= r*r) { toDelete.push(id); break; }
      }
    }
    toDelete.forEach(id => {
      this.drawings.delete(id);
      this.socket.emit('deleteLine', id);
    });
    if (toDelete.length) this.redrawAllDrawings();
  }

  // ---- batching sender ----
  startSender() {
    this.sendTimer = setInterval(() => {
      const keys = Object.keys(this.pointsBuffer);
      for (const id of keys) {
        const pts = this.pointsBuffer[id];
        if (!pts || pts.length === 0) continue;
        // send copy and clear buffer for that id
        const toSend = pts.splice(0, pts.length);
        this.socket.emit('pointsBatch', { id, points: toSend });
        // if buffer empty, delete it
        if (this.pointsBuffer[id].length === 0) delete this.pointsBuffer[id];
      }
    }, this.sendInterval);
  }

  // ---- background handling ----
  setBackground(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.backgroundImage = img;
      this.drawBackground();
    };
    img.src = url;
  }

  drawBackground() {
    if (!this.backgroundImage) return;
    const ctx = this.bgCtx;
    // draw to fit canvas
    ctx.clearRect(0,0,this.backgroundCanvas.width, this.backgroundCanvas.height);
    ctx.drawImage(this.backgroundImage, 0, 0, this.backgroundCanvas.width, this.backgroundCanvas.height);
  }

  // ---- canvas sizing (retina) ----
  resizeCanvases() {
    const wrap = document.querySelector('.canvas-wrap');
    const rect = wrap.getBoundingClientRect();
    const width = Math.max(800, rect.width);
    const height = Math.max(600, rect.height - 10);
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;

    [this.backgroundCanvas, this.drawingsCanvas, this.overlayCanvas].forEach((c) => {
      c.style.width = width + 'px';
      c.style.height = height + 'px';
      c.width = Math.floor(width * dpr);
      c.height = Math.floor(height * dpr);
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // make drawing coordinates in CSS pixels
      ctx.lineCap = ctx.lineJoin = 'round';
    });

    // redraw background and drawings to new sizes
    if (this.backgroundImage) this.drawBackground();
    this.redrawAllDrawings();
  }

  // main animation loop (for overlay updates only)
  animationLoop() {
    const tick = () => {
      // overlay already drawn on events; keep loop for future animation needs
      requestAnimationFrame(tick);
    };
    tick();
  }
}

document.addEventListener('DOMContentLoaded', () => new DrawingApp());
