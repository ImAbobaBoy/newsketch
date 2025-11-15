(() => {
  const SEND_INTERVAL_MS = 60;
  const MAX_POINTS_PER_BATCH = 120;
  const MIN_CANVAS = 800;

  class SketchApp {
    constructor() {
      this.backgroundCanvas = document.getElementById('backgroundCanvas');
      this.drawingsCanvas   = document.getElementById('drawingsCanvas');
      this.overlayCanvas    = document.getElementById('overlayCanvas');
      this.canvasWrap       = document.getElementById('canvasWrap');
      this.loadingEl        = document.getElementById('loading');

      this.toolSelect = document.getElementById('toolSelect');
      this.colorPicker = document.getElementById('colorPicker');
      this.brushSizeInput = document.getElementById('brushSize');
      this.sizeValue = document.getElementById('sizeValue');
      this.undoBtn = document.getElementById('undoBtn');

      this.bgModal = document.getElementById('backgroundModal');
      this.bgInput = document.getElementById('backgroundInput');
      this.bgUrl   = document.getElementById('backgroundUrl');
      this.loadBgBtn = document.getElementById('loadBackgroundBtn');
      this.modalClose = document.getElementById('modalClose');
      this.cancelBgBtn = document.getElementById('cancelBgBtn');

      this.colorPickerMobile = document.getElementById('colorPickerMobile');
      this.brushSizeMobile = document.getElementById('brushSizeMobile');

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
      this.createdLinesOrder = [];
      this.lineSeq = 0;

      this.pendingDraws = [];

      this.bindUI();
      this.setupSocket();
      this.adjustCanvases();

      window.addEventListener('resize', this.debounce(() => this.adjustCanvases(), 120));
      this.startSender();
      requestAnimationFrame(() => this.renderLoop());
    }

    bindUI() {
      if(this.toolSelect) this.toolSelect.addEventListener('change', e => this.setTool(e.target.value));
      if(this.colorPicker) this.colorPicker.addEventListener('change', e => this.setColor(e.target.value));
      if(this.brushSizeInput) this.brushSizeInput.addEventListener('input', e => this.setBrushSize(+e.target.value));
      if(this.undoBtn) this.undoBtn.addEventListener('click', () => this.undoLast());

      if(this.colorPickerMobile) this.colorPickerMobile.addEventListener('change', e => {
        this.colorPicker.value = e.target.value; this.setColor(e.target.value);
      });
      if(this.brushSizeMobile) this.brushSizeMobile.addEventListener('input', e => {
        this.brushSizeInput.value = e.target.value; this.setBrushSize(+e.target.value);
      });

      document.getElementById('backgroundBtn').addEventListener('click', () => this.openModal());
      document.getElementById('clearBtn').addEventListener('click', () => {
        if(confirm('Очистить холст?')){
          this.socket.emit('clearCanvas');
          this.drawings.clear();
          this.createdLinesOrder = [];
          this.clearCanvas(this.drawingsCanvas);
        }
      });

      this.modalClose.addEventListener('click', () => this.closeModal());
      this.cancelBgBtn.addEventListener('click', () => this.closeModal());
      this.loadBgBtn.addEventListener('click', () => this.uploadBackground());

      document.querySelectorAll('.tool, .mtool').forEach(btn => {
        btn.addEventListener('click', e => {
          const t = e.currentTarget.dataset.tool;
          if(!t) return;
          this.setTool(t);
          if(this.toolSelect) this.toolSelect.value = t;
        });
      });

      const overlay = this.overlayCanvas;
      overlay.style.touchAction = "none";
      overlay.addEventListener("pointerdown", e => { overlay.setPointerCapture(e.pointerId); this.onPointerDown(this.getCanvasPos(e)); });
      overlay.addEventListener("pointermove", e => this.onPointerMove(this.getCanvasPos(e)));
      overlay.addEventListener("pointerup", () => this.onPointerUp());
      overlay.addEventListener("pointercancel", () => this.onPointerUp());
    }

    setTool(v){ this.currentTool = v; }
    setColor(v){ this.currentColor = v; }
    setBrushSize(v){ this.brushSize = v; this.sizeValue.textContent = v; }

    setupSocket(){
      this.socket.on('connect', () => console.log('socket connected', this.socket.id));
      this.socket.on('initialState', s => this.loadState(s));
      this.socket.on('usersUpdate', users => document.getElementById('usersCount').textContent = (users?.length)||0);
      this.socket.on('newLine', line => { if(!line?.id) return; if(!this.drawings.has(line.id)){ this.drawings.set(line.id, {...line, points:line.points||[]}); if(line.points?.length) this.drawWholeLine(this.drawings.get(line.id)); }});
      this.socket.on('pointsBatch', ({id, points}) => { if(!id||!points) return; let line=this.drawings.get(id); if(!line){ line={id,tool:'brush',color:'#000',width:2,points:[]}; this.drawings.set(id,line);} const start=line.points.length; line.points.push(...points); this.drawSegmentBatch(line,start,line.points.length);});
      this.socket.on('lineDeleted', id => { this.drawings.delete(id); this.createdLinesOrder=this.createdLinesOrder.filter(x=>x!==id); this.redrawAll(); });
      this.socket.on('canvasCleared', () => { this.drawings.clear(); this.createdLinesOrder=[]; this.clearCanvas(this.drawingsCanvas); });
      this.socket.on('backgroundChanged', ({backgroundUrl}) => { if(backgroundUrl) this.setBackground(backgroundUrl); });
    }

    loadState(state){
      if(!state) return;
      if(state.backgroundImage) this.setBackground(state.backgroundImage);
      this.drawings.clear();
      (state.drawings||[]).forEach(d=>this.drawings.set(d.id,d));
      this.redrawAll();
      this.loadingEl.style.display='none';
    }

    setBackground(url){
      const img=new Image();
      img.crossOrigin="anonymous";
      img.onload=()=>{ this.backgroundImage=img; this.drawBackground(); };
      img.onerror=()=>console.warn('Ошибка загрузки фона',url);
      img.src=url;
    }

    drawBackground(){
      const c=this.backgroundCanvas, ctx=this.bgCtx;
      ctx.clearRect(0,0,c.width,c.height);
      if(!this.backgroundImage) return;
      const img=this.backgroundImage, side=c.width/this.dpr;
      let drawWidth=side, drawHeight=side;
      const ratio=img.width/img.height;
      if(ratio>1){ drawWidth=side; drawHeight=side/ratio; }
      else{ drawHeight=side; drawWidth=side*ratio; }
      ctx.drawImage(img,0,0,img.width,img.height,0,0,drawWidth,drawHeight);
    }

    onPointerDown(pos){
      this.isDrawing=true; this.lineSeq+=1;
      this.currentLineId=`${this.socket.id||'anon'}-${Date.now()}-${this.lineSeq}`;
      const line={id:this.currentLineId,tool:this.currentTool,points:[pos],color:this.currentColor,width:this.brushSize};
      this.drawings.set(line.id,{...line,points:[pos]});
      this.pointsBuffer[line.id]=[pos];
      this.socket.emit('newLine',{id:line.id,tool:line.tool,color:line.color,width:line.width});
      this.createdLinesOrder.push(line.id);
      if(line.tool==='brush') this.drawDot(pos.x,pos.y,line.color,line.width);
    }

    onPointerMove(pos){
      if(!this.isDrawing) return;
      const line=this.drawings.get(this.currentLineId);
      if(!line) return;
      const p={x:Math.round(pos.x),y:Math.round(pos.y)};
      line.points.push(p);
      this.pointsBuffer[line.id]=this.pointsBuffer[line.id]||[];
      this.pointsBuffer[line.id].push(p);
      this.pendingDraws.push({line,points:[line.points[line.points.length-2],p]});
    }

    onPointerUp(){
      if(!this.isDrawing) return;
      this.isDrawing=false;
      if(this.currentLineId){ this.socket.emit('endLine',{id:this.currentLineId}); this.currentLineId=null; }
    }

    drawDot(x,y,color,size){
      const ctx=this.drawCtx;
      ctx.beginPath();
      ctx.arc(x,y,size/2,0,Math.PI*2);
      ctx.fillStyle=color;
      ctx.fill();
    }

    drawSegmentBatch(line,start,end){
      const ctx=this.drawCtx; ctx.lineWidth=line.width; ctx.strokeStyle=line.color;
      for(let i=Math.max(1,start);i<end;i++){ const a=line.points[i-1],b=line.points[i]; if(!a||!b) continue; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); }
    }

    drawWholeLine(line){
      if(line.points.length<2) return;
      this.drawSegmentBatch(line,0,line.points.length);
    }

    renderLoop(){
      if(this.pendingDraws.length){
        const ctx=this.drawCtx; ctx.lineCap=ctx.lineJoin='round';
        this.pendingDraws.forEach(item=>{
          const [a,b]=item.points; if(!a||!b) return;
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.strokeStyle=item.line.color; ctx.lineWidth=item.line.width; ctx.stroke();
        });
        this.pendingDraws=[];
      }
      requestAnimationFrame(()=>this.renderLoop());
    }

    startSender(){
      setInterval(()=>{
        Object.entries(this.pointsBuffer).forEach(([id,points])=>{
          if(points.length>0){
            this.socket.emit('pointsBatch',{id,points});
            this.pointsBuffer[id]=[];
          }
        });
      },SEND_INTERVAL_MS);
    }

    clearCanvas(c){ c.getContext('2d').clearRect(0,0,c.width,c.height); if(c===this.drawingsCanvas) this.drawBackground(); }
    redrawAll(){ this.clearCanvas(this.drawingsCanvas); this.drawings.forEach(line=>this.drawWholeLine(line)); }

    undoLast(){
      const id=this.createdLinesOrder.pop();
      if(!id) return;
      this.drawings.delete(id);
      this.socket.emit('deleteLine',id);
      this.redrawAll();
    }

    adjustCanvases(){
      const rect=this.canvasWrap.getBoundingClientRect();
      const size=Math.max(MIN_CANVAS,Math.min(rect.width,rect.height));
      [this.backgroundCanvas,this.drawingsCanvas,this.overlayCanvas].forEach(c=>{
        c.width=size*this.dpr;
        c.height=size*this.dpr;
        c.style.width=`${size}px`;
        c.style.height=`${size}px`;
      });
      this.drawBackground();
      this.redrawAll();
    }

    getCanvasPos(e){
      const rect=this.overlayCanvas.getBoundingClientRect();
      const scaleX=this.overlayCanvas.width/rect.width;
      const scaleY=this.overlayCanvas.height/rect.height;
      return {x:(e.clientX-rect.left)*scaleX, y:(e.clientY-rect.top)*scaleY};
    }

    openModal(){ this.bgModal.style.display='flex'; this.bgModal.setAttribute('aria-hidden','false'); }
    closeModal(){ this.bgModal.style.display='none'; this.bgModal.setAttribute('aria-hidden','true'); }

    uploadBackground(){
      let file=this.bgInput.files[0];
      let url=this.bgUrl.value.trim();
      if(file){
        const reader=new FileReader();
        reader.onload=e=>{ this.setBackground(e.target.result); this.socket.emit('backgroundChange',{backgroundUrl:e.target.result}); this.closeModal(); };
        reader.readAsDataURL(file);
      } else if(url){ this.setBackground(url); this.socket.emit('backgroundChange',{backgroundUrl:url}); this.closeModal(); }
      else alert('Выберите файл или вставьте URL');
    }

    debounce(fn,delay){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args),delay); }; }
  }

  window.addEventListener('load',()=>window.sketchApp=new SketchApp());
})();
