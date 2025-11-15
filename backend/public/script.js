class OptimizedDrawingApp {
    constructor() {
        this.canvas = document.getElementById('drawingCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.socket = io();
        
        // ОСНОВНЫЕ ПЕРЕМЕННЫЕ
        this.isDrawing = false;
        this.currentTool = 'brush';
        this.currentColor = '#ff0000';
        this.brushSize = 3;
        
        // ОПТИМИЗИРОВАННОЕ ХРАНИЛИЩЕ
        this.lines = new Map(); // id -> {points, color, width, canvas}
        this.lineCanvases = new Map(); // id -> canvas элемент (кэш рендеринга)
        
        // ТЕКУЩАЯ ЛИНИЯ
        this.currentLineId = null;
        this.currentLineCanvas = null;
        this.lastPoint = null;
        
        // ДЛЯ ЛАСТИКА
        this.eraserPath = [];
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.setupSocketListeners();
        this.setupCanvas();
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
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('mouseout', this.handleMouseUp.bind(this));
        
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
        
        this.socket.on('startLine', (data) => {
            this.startRemoteLine(data);
        });
        
        this.socket.on('addPoints', (data) => {
            this.addPointsToRemoteLine(data);
        });
        
        this.socket.on('endLine', (id) => {
            this.finalizeRemoteLine(id);
        });
        
        this.socket.on('deleteLine', (id) => {
            this.deleteLine(id);
        });
        
        this.socket.on('clearCanvas', () => {
            this.clearLocalCanvas();
        });
        
        this.socket.on('backgroundChanged', (data) => {
            this.loadBackgroundImage(data.backgroundUrl);
        });
        
        this.socket.on('usersUpdate', (users) => {
            document.getElementById('usersCount').textContent = users.length;
        });
    }
    
    setupCanvas() {
        this.ctx.lineJoin = 'round';
        this.ctx.lineCap = 'round';
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
    
    // ОСНОВНОЙ АЛГОРИТМ РИСОВАНИЯ
    handleMouseDown(e) {
        const pos = this.getCanvasCoordinates(e);
        
        if (this.currentTool === 'diamond') {
            this.drawDiamond(pos.x, pos.y);
            return;
        }
        
        this.isDrawing = true;
        this.lastPoint = pos;
        
        if (this.currentTool === 'eraser') {
            this.eraserPath = [pos];
            this.handleEraser(pos.x, pos.y);
        } else {
            this.startNewLine(pos.x, pos.y);
        }
    }
    
    handleMouseMove(e) {
        if (!this.isDrawing) return;
        
        const pos = this.getCanvasCoordinates(e);
        
        if (this.currentTool === 'eraser') {
            this.eraserPath.push(pos);
            this.handleEraser(pos.x, pos.y);
        } else {
            this.continueLine(pos.x, pos.y);
        }
    }
    
    handleMouseUp() {
        if (!this.isDrawing) return;
        
        if (this.currentTool === 'eraser') {
            this.eraserPath = [];
        } else if (this.currentLineId) {
            this.finalizeCurrentLine();
        }
        
        this.isDrawing = false;
        this.lastPoint = null;
    }
    
    // АЛГОРИТМ ЛИНИИ: РАЗДЕЛЕНИЕ НА ЭТАПЫ
    startNewLine(x, y) {
        this.currentLineId = `line-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Создаем отдельный canvas для этой линии
        this.currentLineCanvas = document.createElement('canvas');
        this.currentLineCanvas.width = this.canvas.width;
        this.currentLineCanvas.height = this.canvas.height;
        const lineCtx = this.currentLineCanvas.getContext('2d');
        lineCtx.lineJoin = 'round';
        lineCtx.lineCap = 'round';
        lineCtx.strokeStyle = this.currentColor;
        lineCtx.lineWidth = this.brushSize;
        
        // Начинаем путь
        lineCtx.beginPath();
        lineCtx.moveTo(x, y);
        
        // Сохраняем в хранилище
        this.lines.set(this.currentLineId, {
            points: [{x, y}],
            color: this.currentColor,
            width: this.brushSize,
            canvas: this.currentLineCanvas
        });
        
        // Отправляем на сервер
        this.socket.emit('startLine', {
            id: this.currentLineId,
            color: this.currentColor,
            width: this.brushSize
        });
        
        // Рисуем первую точку
        this.drawToMainCanvas();
    }
    
    continueLine(x, y) {
        if (!this.currentLineId || !this.currentLineCanvas) return;
        
        const line = this.lines.get(this.currentLineId);
        const lineCtx = this.currentLineCanvas.getContext('2d');
        
        // Добавляем точку
        line.points.push({x, y});
        
        // Рисуем отрезок на canvas линии
        lineCtx.lineTo(x, y);
        lineCtx.stroke();
        
        // Отправляем ТОЛЬКО НОВЫЕ точки
        this.socket.emit('addPoints', {
            id: this.currentLineId,
            points: [{x, y}]
        });
        
        // Обновляем основной canvas
        this.drawToMainCanvas();
        
        this.lastPoint = {x, y};
    }
    
    finalizeCurrentLine() {
        if (!this.currentLineId) return;
        
        // Сохраняем canvas линии в кэш
        this.lineCanvases.set(this.currentLineId, this.currentLineCanvas);
        
        // Уведомляем сервер об окончании
        this.socket.emit('endLine', this.currentLineId);
        
        this.currentLineId = null;
        this.currentLineCanvas = null;
    }
    
    drawToMainCanvas() {
        // Очищаем основной canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Рисуем фон (если есть)
        if (this.backgroundImage) {
            this.ctx.drawImage(this.backgroundImage, 0, 0, this.canvas.width, this.canvas.height);
        }
        
        // Рисуем ВСЕ сохраненные линии из кэша
        for (const lineCanvas of this.lineCanvases.values()) {
            this.ctx.drawImage(lineCanvas, 0, 0);
        }
        
        // Рисуем текущую линию поверх
        if (this.currentLineCanvas) {
            this.ctx.drawImage(this.currentLineCanvas, 0, 0);
        }
    }
    
    // АЛГОРИТМ ЛАСТИКА
    handleEraser(x, y) {
        const eraserRadius = this.brushSize * 2;
        const linesToDelete = [];
        
        // Проверяем все линии на пересечение с путем ластика
        for (const [lineId, line] of this.lines) {
            if (this.isLineNearEraserPath(line.points, this.eraserPath, eraserRadius)) {
                linesToDelete.push(lineId);
            }
        }
        
        // Удаляем найденные линии
        linesToDelete.forEach(lineId => {
            this.deleteLine(lineId);
            this.socket.emit('deleteLine', lineId);
        });
        
        this.drawToMainCanvas();
    }
    
    isLineNearEraserPath(linePoints, eraserPath, radius) {
        // Проверяем пересечение линии с путем ластика
        for (let i = 0; i < linePoints.length - 1; i++) {
            const lineStart = linePoints[i];
            const lineEnd = linePoints[i + 1];
            
            for (let j = 0; j < eraserPath.length; j++) {
                const eraserPoint = eraserPath[j];
                
                if (this.distanceToSegment(eraserPoint, lineStart, lineEnd) <= radius) {
                    return true;
                }
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
        
        if (lenSq !== 0) param = dot / lenSq;
        
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
    
    // РОМБ
    drawDiamond(x, y) {
        const size = this.brushSize * 4;
        const points = [
            {x, y: y - size},
            {x: x + size, y},
            {x, y: y + size},
            {x: x - size, y},
            {x, y: y - size}
        ];
        
        const diamondId = `diamond-${Date.now()}`;
        this.startNewLine(x, y - size);
        
        const line = this.lines.get(diamondId);
        if (line) {
            line.points = points;
            
            // Рисуем ромб на canvas линии
            const lineCtx = line.canvas.getContext('2d');
            lineCtx.beginPath();
            lineCtx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                lineCtx.lineTo(points[i].x, points[i].y);
            }
            lineCtx.stroke();
            
            this.finalizeCurrentLine();
            this.drawToMainCanvas();
        }
    }
    
    // УДАЛЕНИЕ ЛИНИИ
    deleteLine(lineId) {
        this.lines.delete(lineId);
        this.lineCanvases.delete(lineId);
    }
    
    // СИНХРОНИЗАЦИЯ С СЕРВЕРОМ
    startRemoteLine(data) {
        const { id, color, width } = data;
        
        const lineCanvas = document.createElement('canvas');
        lineCanvas.width = this.canvas.width;
        lineCanvas.height = this.canvas.height;
        const lineCtx = lineCanvas.getContext('2d');
        lineCtx.lineJoin = 'round';
        lineCtx.lineCap = 'round';
        lineCtx.strokeStyle = color;
        lineCtx.lineWidth = width;
        
        this.lines.set(id, {
            points: [],
            color: color,
            width: width,
            canvas: lineCanvas
        });
    }
    
    addPointsToRemoteLine(data) {
        const { id, points } = data;
        const line = this.lines.get(id);
        
        if (line && line.canvas) {
            const lineCtx = line.canvas.getContext('2d');
            
            points.forEach(point => {
                line.points.push(point);
                
                if (line.points.length === 1) {
                    lineCtx.beginPath();
                    lineCtx.moveTo(point.x, point.y);
                } else {
                    lineCtx.lineTo(point.x, point.y);
                    lineCtx.stroke();
                }
            });
            
            this.drawToMainCanvas();
        }
    }
    
    finalizeRemoteLine(id) {
        const line = this.lines.get(id);
        if (line) {
            this.lineCanvases.set(id, line.canvas);
        }
    }
    
    clearLocalCanvas() {
        this.lines.clear();
        this.lineCanvases.clear();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        if (this.backgroundImage) {
            this.ctx.drawImage(this.backgroundImage, 0, 0, this.canvas.width, this.canvas.height);
        }
    }
    
    clearCanvas() {
        if (confirm('Очистить весь холст?')) {
            this.socket.emit('clearCanvas');
            this.clearLocalCanvas();
        }
    }
    
    // Touch handlers
    handleTouchStart(e) { this.handleMouseDown(e); }
    handleTouchMove(e) { this.handleMouseMove(e); }
    handleTouchEnd(e) { this.handleMouseUp(e); }

    // Background methods (остаются без изменений)
    setupModal() {
        const modal = document.getElementById('backgroundModal');
        const closeBtn = document.querySelector('.close');
        const loadBtn = document.getElementById('loadBackgroundBtn');
        
        closeBtn.onclick = () => modal.style.display = 'none';
        window.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        loadBtn.onclick = () => this.uploadBackgroundToServer();
    }
    
    openBackgroundModal() {
        document.getElementById('backgroundModal').style.display = 'block';
    }
    
    uploadBackgroundToServer() {
        const fileInput = document.getElementById('backgroundInput');
        const urlInput = document.getElementById('backgroundUrl');
        
        if (fileInput.files?.[0]) {
            const file = fileInput.files[0];
            const reader = new FileReader();
            
            reader.onload = (e) => {
                const imageData = e.target.result;
                this.socket.emit('uploadBackground', { backgroundUrl: imageData });
                document.getElementById('backgroundModal').style.display = 'none';
            };
            
            reader.readAsDataURL(file);
        } else if (urlInput.value) {
            this.socket.emit('uploadBackground', { backgroundUrl: urlInput.value });
            document.getElementById('backgroundModal').style.display = 'none';
        } else {
            alert('Выберите файл или введите URL');
        }
    }
    
    loadBackgroundImage(url) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            this.backgroundImage = img;
            this.drawToMainCanvas();
        };
        img.src = url;
    }
    
    loadState(state) {
        if (state.backgroundImage) {
            this.loadBackgroundImage(state.backgroundImage);
        }
        
        // Загружаем линии из состояния
        (state.lines || []).forEach(lineData => {
            this.startRemoteLine({
                id: lineData.id,
                color: lineData.color,
                width: lineData.width
            });
            
            this.addPointsToRemoteLine({
                id: lineData.id,
                points: lineData.points
            });
            
            this.finalizeRemoteLine(lineData.id);
        });
        
        document.getElementById('usersCount').textContent = state.users.length;
        document.getElementById('loading').style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new OptimizedDrawingApp();
});