class OptimizedDrawingApp {
    constructor() {
        this.canvas = document.getElementById('drawingCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.socket = io();
        
        // Основные переменные
        this.isDrawing = false;
        this.currentTool = 'brush';
        this.currentColor = '#ff0000';
        this.brushSize = 3;
        
        // Оптимизация: два холста - один для фона, другой для рисунков
        this.backgroundCanvas = document.createElement('canvas');
        this.backgroundCtx = this.backgroundCanvas.getContext('2d');
        this.drawingCanvas = document.createElement('canvas');
        this.drawingCtx = this.drawingCanvas.getContext('2d');
        
        // Устанавливаем размеры
        this.backgroundCanvas.width = this.drawingCanvas.width = this.canvas.width;
        this.backgroundCanvas.height = this.drawingCanvas.height = this.canvas.height;
        
        // Хранилище данных
        this.drawings = new Map();
        this.currentLineId = null;
        this.pendingPoints = [];
        
        // Оптимизация рендеринга
        this.lastRenderTime = 0;
        this.renderInterval = 1000 / 30; // 30 FPS максимум
        this.needsRender = false;
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.setupSocketListeners();
        this.setupCanvas();
        this.startRenderLoop();
    }
    
    setupEventListeners() {
        document.getElementById('toolSelect').addEventListener('change', (e) => {
            this.currentTool = e.target.value;
        });
        
        document.getElementById('colorPicker').addEventListener('change', (e) => {
            this.currentColor = e.target.value;
        });
        
        const brushSize = document.getElementById('brushSize');
        const sizeValue = document.getElementById('sizeValue');
        
        brushSize.addEventListener('input', (e) => {
            this.brushSize = parseInt(e.target.value);
            sizeValue.textContent = this.brushSize;
        });
        
        document.getElementById('clearBtn').addEventListener('click', () => {
            this.clearCanvas();
        });
        
        document.getElementById('backgroundBtn').addEventListener('click', () => {
            this.openBackgroundModal();
        });
        
        this.setupModal();
        this.setupCanvasEvents();
    }
    
    setupCanvasEvents() {
        // Mouse events
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('mouseout', this.handleMouseUp.bind(this));
        
        // Touch events
        this.canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.handleTouchStart(e);
        });
        this.canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            this.handleTouchMove(e);
        });
        this.canvas.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.handleTouchEnd(e);
        });
    }
    
    setupSocketListeners() {
        this.socket.on('initialState', (state) => {
            this.loadState(state);
        });
        
        this.socket.on('drawing', (drawingData) => {
            this.addDrawing(drawingData);
            this.requestRender();
        });
        
        this.socket.on('lineDeleted', (lineId) => {
            this.drawings.delete(lineId);
            this.redrawDrawingCanvas();
            this.requestRender();
        });
        
        this.socket.on('canvasCleared', () => {
            this.drawings.clear();
            this.redrawDrawingCanvas();
            this.requestRender();
        });
        
        this.socket.on('backgroundChanged', (data) => {
            this.loadBackgroundImage(data.backgroundUrl);
        });
        
        this.socket.on('usersUpdate', (users) => {
            document.getElementById('usersCount').textContent = users.length;
        });
    }
    
    setupCanvas() {
        this.drawingCtx.lineJoin = 'round';
        this.drawingCtx.lineCap = 'round';
    }
    
    startRenderLoop() {
        const render = (timestamp) => {
            if (timestamp - this.lastRenderTime >= this.renderInterval && this.needsRender) {
                this.render();
                this.lastRenderTime = timestamp;
                this.needsRender = false;
            }
            requestAnimationFrame(render);
        };
        requestAnimationFrame(render);
    }
    
    requestRender() {
        this.needsRender = true;
    }
    
    render() {
        // Очищаем основной canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Рисуем фон
        this.ctx.drawImage(this.backgroundCanvas, 0, 0);
        
        // Рисуем рисунки
        this.ctx.drawImage(this.drawingCanvas, 0, 0);
    }
    
    getCanvasCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        
        let clientX, clientY;
        
        if (e.type.includes('touch')) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }
        
        return {
            x: (clientX - rect.left) * scaleX,
            y: (clientY - rect.top) * scaleY
        };
    }
    
    handleMouseDown(e) {
        const pos = this.getCanvasCoordinates(e);
        this.startDrawing(pos.x, pos.y);
    }
    
    handleMouseMove(e) {
        if (!this.isDrawing) return;
        
        const pos = this.getCanvasCoordinates(e);
        this.continueDrawing(pos.x, pos.y);
    }
    
    handleMouseUp() {
        this.stopDrawing();
    }
    
    handleTouchStart(e) {
        const pos = this.getCanvasCoordinates(e);
        this.startDrawing(pos.x, pos.y);
    }
    
    handleTouchMove(e) {
        if (!this.isDrawing) return;
        
        const pos = this.getCanvasCoordinates(e);
        this.continueDrawing(pos.x, pos.y);
    }
    
    handleTouchEnd() {
        this.stopDrawing();
    }
    
    startDrawing(x, y) {
        if (this.currentTool === 'diamond') {
            this.drawDiamond(x, y);
            return;
        }
        
        this.isDrawing = true;
        this.currentLineId = `${this.socket.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        this.pendingPoints = [{x, y}];
        
        // Начинаем рисовать на временном canvas
        this.drawingCtx.beginPath();
        this.drawingCtx.moveTo(x, y);
        this.drawingCtx.strokeStyle = this.currentColor;
        this.drawingCtx.lineWidth = this.brushSize;
    }
    
    continueDrawing(x, y) {
        if (!this.isDrawing || !this.currentLineId) return;
        
        if (this.currentTool === 'eraser') {
            this.handleEraser(x, y);
        } else {
            this.pendingPoints.push({x, y});
            
            // Рисуем линию
            this.drawingCtx.lineTo(x, y);
            this.drawingCtx.stroke();
            
            // Отправляем точки на сервер пакетами (для оптимизации)
            if (this.pendingPoints.length >= 3) {
                this.sendPendingPoints();
            }
        }
        
        this.requestRender();
    }
    
    stopDrawing() {
        if (!this.isDrawing) return;
        
        if (this.currentLineId && this.pendingPoints.length > 0) {
            // Отправляем оставшиеся точки
            this.sendPendingPoints();
        }
        
        this.isDrawing = false;
        this.currentLineId = null;
        this.pendingPoints = [];
    }
    
    sendPendingPoints() {
        if (!this.currentLineId || this.pendingPoints.length === 0) return;
        
        this.socket.emit('drawing', {
            id: this.currentLineId,
            tool: this.currentTool,
            points: [...this.pendingPoints],
            color: this.currentColor,
            width: this.brushSize
        });
        
        this.pendingPoints = [];
    }
    
    drawDiamond(x, y) {
        const size = this.brushSize * 4;
        const points = [
            {x, y: y - size},
            {x: x + size, y},
            {x, y: y + size},
            {x: x - size, y},
            {x, y: y - size}
        ];
        
        const diamondId = `${this.socket.id}-diamond-${Date.now()}`;
        
        // Рисуем ромб
        this.drawingCtx.beginPath();
        this.drawingCtx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            this.drawingCtx.lineTo(points[i].x, points[i].y);
        }
        this.drawingCtx.strokeStyle = this.currentColor;
        this.drawingCtx.lineWidth = this.brushSize;
        this.drawingCtx.stroke();
        
        // Отправляем на сервер
        this.socket.emit('drawing', {
            id: diamondId,
            tool: 'diamond',
            points: points,
            color: this.currentColor,
            width: this.brushSize
        });
        
        this.requestRender();
    }
    
    handleEraser(x, y) {
        const eraserRadius = this.brushSize * 3;
        const linesToDelete = [];
        
        // Оптимизированный поиск линий для удаления
        for (const [lineId, drawing] of this.drawings) {
            if (this.isLineNearPoint(drawing.points, {x, y}, eraserRadius)) {
                linesToDelete.push(lineId);
            }
        }
        
        // Удаляем найденные линии
        linesToDelete.forEach(lineId => {
            this.drawings.delete(lineId);
            this.socket.emit('deleteLine', lineId);
        });
        
        if (linesToDelete.length > 0) {
            this.redrawDrawingCanvas();
            this.requestRender();
        }
    }
    
    isLineNearPoint(points, point, radius) {
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];
            
            if (this.distanceToSegment(point, p1, p2) <= radius) {
                return true;
            }
        }
        return false;
    }
    
    distanceToSegment(p, p1, p2) {
        const A = p.x - p1.x;
        const B = p.y - p1.y;
        const C = p2.x - p1.x;
        const D = p2.y - p1.y;
        
        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;
        
        if (lenSq !== 0) {
            param = dot / lenSq;
        }
        
        let xx, yy;
        
        if (param < 0) {
            xx = p1.x;
            yy = p1.y;
        } else if (param > 1) {
            xx = p2.x;
            yy = p2.y;
        } else {
            xx = p1.x + param * C;
            yy = p1.y + param * D;
        }
        
        const dx = p.x - xx;
        const dy = p.y - yy;
        return Math.sqrt(dx * dx + dy * dy);
    }
    
    addDrawing(drawingData) {
        this.drawings.set(drawingData.id, {
            tool: drawingData.tool,
            points: drawingData.points,
            color: drawingData.color,
            width: drawingData.width
        });
        
        this.redrawDrawingCanvas();
    }
    
    redrawDrawingCanvas() {
        // Очищаем canvas с рисунками
        this.drawingCtx.clearRect(0, 0, this.drawingCanvas.width, this.drawingCanvas.height);
        
        // Рисуем все сохраненные линии
        for (const drawing of this.drawings.values()) {
            if (drawing.points.length < 2) continue;
            
            this.drawingCtx.beginPath();
            this.drawingCtx.moveTo(drawing.points[0].x, drawing.points[0].y);
            
            for (let i = 1; i < drawing.points.length; i++) {
                this.drawingCtx.lineTo(drawing.points[i].x, drawing.points[i].y);
            }
            
            this.drawingCtx.strokeStyle = drawing.color;
            this.drawingCtx.lineWidth = drawing.width;
            this.drawingCtx.stroke();
        }
    }
    
    clearCanvas() {
        if (confirm('Очистить весь холст? Все рисунки будут удалены.')) {
            this.socket.emit('clearCanvas');
            this.drawings.clear();
            this.drawingCtx.clearRect(0, 0, this.drawingCanvas.width, this.drawingCanvas.height);
            this.requestRender();
        }
    }
    
    setupModal() {
        const modal = document.getElementById('backgroundModal');
        const closeBtn = document.querySelector('.close');
        const loadBtn = document.getElementById('loadBackgroundBtn');
        
        closeBtn.onclick = () => {
            modal.style.display = 'none';
        };
        
        window.onclick = (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        };
        
        loadBtn.onclick = () => {
            this.uploadBackgroundToServer();
        };
    }
    
    openBackgroundModal() {
        document.getElementById('backgroundModal').style.display = 'block';
    }
    
    uploadBackgroundToServer() {
        const fileInput = document.getElementById('backgroundInput');
        const urlInput = document.getElementById('backgroundUrl');
        
        if (fileInput.files && fileInput.files[0]) {
            const file = fileInput.files[0];
            const reader = new FileReader();
            
            reader.onload = (e) => {
                const imageData = e.target.result;
                
                fetch('/upload-background', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        imageData: imageData,
                        fileName: file.name
                    })
                })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        document.getElementById('backgroundModal').style.display = 'none';
                    } else {
                        alert('Ошибка загрузки фона: ' + data.error);
                    }
                })
                .catch(error => {
                    console.error('Ошибка:', error);
                    alert('Ошибка загрузки фона');
                });
            };
            
            reader.readAsDataURL(file);
        } else if (urlInput.value) {
            this.loadImageFromUrl(urlInput.value);
        } else {
            alert('Пожалуйста, выберите файл или введите URL');
        }
    }
    
    loadImageFromUrl(url) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        img.onload = () => {
            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            tempCtx.drawImage(img, 0, 0);
            
            const imageData = tempCanvas.toDataURL('image/png');
            
            fetch('/upload-background', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    imageData: imageData,
                    fileName: 'background-from-url.png'
                })
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    document.getElementById('backgroundModal').style.display = 'none';
                } else {
                    alert('Ошибка загрузки фона: ' + data.error);
                }
            })
            .catch(error => {
                console.error('Ошибка:', error);
                alert('Ошибка загрузки фона');
            });
        };
        
        img.onerror = () => {
            alert('Ошибка загрузки изображения по URL');
        };
        
        img.src = url;
    }
    
    loadBackgroundImage(url) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            // Рисуем фон на background canvas
            this.backgroundCtx.clearRect(0, 0, this.backgroundCanvas.width, this.backgroundCanvas.height);
            this.backgroundCtx.drawImage(img, 0, 0, this.backgroundCanvas.width, this.backgroundCanvas.height);
            this.requestRender();
        };
        img.onerror = () => {
            console.error('Ошибка загрузки фонового изображения:', url);
        };
        img.src = url;
    }
    
    loadState(state) {
        if (state.backgroundImage) {
            this.loadBackgroundImage(state.backgroundImage);
        }
        
        this.drawings.clear();
        (state.drawings || []).forEach(drawing => {
            this.addDrawing(drawing);
        });
        
        document.getElementById('usersCount').textContent = state.users.length;
        document.getElementById('loading').style.display = 'none';
        this.requestRender();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new OptimizedDrawingApp();
});