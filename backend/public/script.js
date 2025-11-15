class SketchApp {
    constructor() {
        this.canvases = {
            background: document.getElementById('backgroundCanvas'),
            drawings: document.getElementById('drawingsCanvas'),
            overlay: document.getElementById('overlayCanvas')
        };
        
        this.ctx = {
            bg: this.canvases.background.getContext('2d'),
            draw: this.canvases.drawings.getContext('2d'),
            overlay: this.canvases.overlay.getContext('2d')
        };

        this.socket = io();
        this.initProperties();
        this.bindEvents();
        this.setupSocket();
        this.adjustCanvases();
        
        window.addEventListener('resize', this.debounce(() => this.adjustCanvases(), 250));
    }

    initProperties() {
        this.currentTool = 'brush';
        this.currentColor = '#ff6b6b';
        this.brushSize = 3;
        this.isDrawing = false;
        this.currentLineId = null;
        this.startPos = null;
        this.dpr = window.devicePixelRatio || 1;
        
        this.backgroundImage = null;
        this.drawings = new Map();
        this.pointsBuffer = new Map();
        
        // Оптимизация: буферизация отправки
        this.sendInterval = 50; // ms
        this.lastSendTime = 0;
    }

    bindEvents() {
        // Инструменты
        document.querySelectorAll('.tool').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tool').forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
                this.setTool(e.target.dataset.tool);
            });
        });

        // Цвет и размер
        document.getElementById('colorPicker').addEventListener('change', (e) => {
            this.setColor(e.target.value);
            document.getElementById('colorPickerMobile').value = e.target.value;
        });

        document.getElementById('colorPickerMobile').addEventListener('change', (e) => {
            this.setColor(e.target.value);
            document.getElementById('colorPicker').value = e.target.value;
        });

        document.getElementById('brushSize').addEventListener('input', (e) => {
            this.setBrushSize(+e.target.value);
            document.getElementById('brushSizeMobile').value = e.target.value;
        });

        document.getElementById('brushSizeMobile').addEventListener('input', (e) => {
            this.setBrushSize(+e.target.value);
            document.getElementById('brushSize').value = e.target.value;
        });

        // Мобильные инструменты
        document.getElementById('toolSelectMobile').addEventListener('change', (e) => {
            this.setTool(e.target.value);
        });

        // Кнопки действий
        document.getElementById('clearBtn').addEventListener('click', () => this.clearCanvas());
        document.getElementById('backgroundBtn').addEventListener('click', () => this.openModal());
        
        // Модальное окно
        document.getElementById('modalClose').addEventListener('click', () => this.closeModal());
        document.getElementById('loadBackgroundBtn').addEventListener('click', () => this.uploadBackground());

        // События холста
        this.setupCanvasEvents();
    }

    setupCanvasEvents() {
        const overlay = this.canvases.overlay;
        
        overlay.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            
            const pos = this.getCanvasPos(e);
            this.startDrawing(pos);
            e.preventDefault();
        });

        overlay.addEventListener('pointermove', (e) => {
            const pos = this.getCanvasPos(e);
            this.continueDrawing(pos);
            e.preventDefault();
        });

        overlay.addEventListener('pointerup', (e) => {
            this.finishDrawing();
            e.preventDefault();
        });

        overlay.addEventListener('pointercancel', () => {
            this.finishDrawing();
        });

        // Предотвращаем контекстное меню
        overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    startDrawing(pos) {
        this.isDrawing = true;
        this.startPos = pos;
        this.currentLineId = this.generateId();

        const line = {
            id: this.currentLineId,
            tool: this.currentTool,
            points: [pos],
            color: this.currentColor,
            width: this.brushSize
        };

        this.drawings.set(line.id, line);
        this.pointsBuffer.set(line.id, [pos]);

        // Отправляем метаданные линии
        this.socket.emit('newLine', {
            id: line.id,
            tool: line.tool,
            color: line.color,
            width: line.width
        });

        // Рисуем начальную точку для кисти
        if (line.tool === 'brush') {
            this.drawDot(pos.x, pos.y, line.color, line.width);
        }
    }

    continueDrawing(pos) {
        if (!this.isDrawing) return;

        const line = this.drawings.get(this.currentLineId);
        if (!line) return;

        line.points.push(pos);
        
        // Буферизуем точки для отправки
        const buffer = this.pointsBuffer.get(this.currentLineId) || [];
        buffer.push(pos);
        this.pointsBuffer.set(this.currentLineId, buffer);

        // Отрисовка в реальном времени
        this.drawSegmentImmediate(line);
        
        // Отправка точек с троттлингом
        this.sendBufferedPoints();
    }

    finishDrawing() {
        if (!this.isDrawing) return;
        
        // Отправляем оставшиеся точки
        this.sendBufferedPoints(true);
        
        this.socket.emit('endLine', { id: this.currentLineId });
        this.isDrawing = false;
        this.currentLineId = null;
        this.startPos = null;
        
        // Очищаем оверлей
        this.ctx.overlay.clearRect(0, 0, 
            this.canvases.overlay.width, 
            this.canvases.overlay.height
        );
    }

    sendBufferedPoints(force = false) {
        const now = Date.now();
        if (!force && now - this.lastSendTime < this.sendInterval) return;

        for (const [id, points] of this.pointsBuffer) {
            if (points.length > 0) {
                const pointsToSend = [...points];
                this.pointsBuffer.set(id, []);
                
                this.socket.emit('pointsBatch', { 
                    id, 
                    points: pointsToSend 
                });
            }
        }
        
        this.lastSendTime = now;
    }

    drawSegmentImmediate(line) {
        const points = line.points;
        if (points.length < 2) return;

        const ctx = line.tool === 'eraser' ? this.ctx.draw : this.ctx.overlay;
        const a = points[points.length - 2];
        const b = points[points.length - 1];

        ctx.strokeStyle = line.tool === 'eraser' ? '#ffffff' : line.color;
        ctx.lineWidth = line.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }

    drawDot(x, y, color, size) {
        this.ctx.draw.beginPath();
        this.ctx.draw.arc(x, y, size / 2, 0, Math.PI * 2);
        this.ctx.draw.fillStyle = color;
        this.ctx.draw.fill();
    }

    // Остальные методы (setTool, setColor, setBrushSize, getCanvasPos, adjustCanvases и т.д.)
    // остаются аналогичными, но с оптимизациями

    setupSocket() {
        this.socket.on('connect', () => {
            console.log('Connected to server');
            document.getElementById('loading').style.display = 'none';
        });

        this.socket.on('usersUpdate', (users) => {
            document.getElementById('usersCount').textContent = users.length;
        });

        this.socket.on('initialState', (state) => this.loadState(state));
        this.socket.on('newLine', (line) => this.handleNewLine(line));
        this.socket.on('pointsBatch', (data) => this.handlePointsBatch(data));
        this.socket.on('lineDeleted', (id) => this.handleLineDeleted(id));
        this.socket.on('canvasCleared', () => this.handleCanvasCleared());
        this.socket.on('backgroundChanged', (data) => this.handleBackgroundChanged(data));

        this.socket.on('disconnect', () => {
            document.getElementById('loading').style.display = 'block';
        });
    }

    loadState(state) {
        if (state.backgroundImage) {
            this.setBackground(state.backgroundImage);
        }

        this.drawings.clear();
        (state.drawings || []).forEach(drawing => {
            this.drawings.set(drawing.id, drawing);
        });
        
        this.redrawAll();
        document.getElementById('loading').style.display = 'none';
    }

    handleNewLine(line) {
        if (!this.drawings.has(line.id)) {
            this.drawings.set(line.id, { ...line, points: [] });
        }
    }

    handlePointsBatch({ id, points }) {
        const line = this.drawings.get(id);
        if (line) {
            const startIndex = line.points.length;
            line.points.push(...points);
            this.drawSegmentBatch(line, startIndex);
        }
    }

    drawSegmentBatch(line, startIndex) {
        const ctx = this.ctx.draw;
        ctx.strokeStyle = line.color;
        ctx.lineWidth = line.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(line.points[0].x, line.points[0].y);
        
        for (let i = 1; i < line.points.length; i++) {
            ctx.lineTo(line.points[i].x, line.points[i].y);
        }
        
        ctx.stroke();
    }

    handleLineDeleted(id) {
        this.drawings.delete(id);
        this.redrawAll();
    }

    handleCanvasCleared() {
        this.drawings.clear();
        this.ctx.draw.clearRect(0, 0, 
            this.canvases.drawings.width, 
            this.canvases.drawings.height
        );
    }

    handleBackgroundChanged({ backgroundUrl }) {
        this.setBackground(backgroundUrl);
    }

    redrawAll() {
        this.ctx.draw.clearRect(0, 0, 
            this.canvases.drawings.width, 
            this.canvases.drawings.height
        );
        
        for (const line of this.drawings.values()) {
            this.drawWholeLine(line);
        }
    }

    drawWholeLine(line) {
        if (line.points.length < 2) return;

        const ctx = this.ctx.draw;
        ctx.strokeStyle = line.color;
        ctx.lineWidth = line.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(line.points[0].x, line.points[0].y);
        
        for (let i = 1; i < line.points.length; i++) {
            ctx.lineTo(line.points[i].x, line.points[i].y);
        }
        
        ctx.stroke();
    }

    clearCanvas() {
        if (confirm('Очистить холст?')) {
            this.socket.emit('clearCanvas');
        }
    }

    setBackground(url) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        img.onload = () => {
            this.backgroundImage = img;
            this.drawBackground();
        };
        
        img.onerror = () => {
            console.error('Failed to load background image');
        };
        
        img.src = url;
    }

    drawBackground() {
        const canvas = this.canvases.background;
        const ctx = this.ctx.bg;
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        if (this.backgroundImage) {
            const scale = Math.min(
                canvas.width / this.backgroundImage.width,
                canvas.height / this.backgroundImage.height
            );
            
            const width = this.backgroundImage.width * scale;
            const height = this.backgroundImage.height * scale;
            const x = (canvas.width - width) / 2;
            const y = (canvas.height - height) / 2;
            
            ctx.drawImage(this.backgroundImage, x, y, width, height);
        }
    }

    adjustCanvases() {
        const container = document.querySelector('.canvas-square');
        const rect = container.getBoundingClientRect();
        const size = Math.min(rect.width, rect.height);
        this.dpr = window.devicePixelRatio || 1;

        Object.values(this.canvases).forEach(canvas => {
            canvas.style.width = size + 'px';
            canvas.style.height = size + 'px';
            canvas.width = Math.floor(size * this.dpr);
            canvas.height = Math.floor(size * this.dpr);
            
            const ctx = canvas.getContext('2d');
            ctx.scale(this.dpr, this.dpr);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
        });

        // Перерисовываем содержимое
        this.drawBackground();
        this.redrawAll();
    }

    generateId() {
        return `${this.socket.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    openModal() {
        document.getElementById('backgroundModal').style.display = 'flex';
    }

    closeModal() {
        document.getElementById('backgroundModal').style.display = 'none';
    }

    uploadBackground() {
        const fileInput = document.getElementById('backgroundInput');
        const urlInput = document.getElementById('backgroundUrl');
        
        if (fileInput.files && fileInput.files[0]) {
            const file = fileInput.files[0];
            const reader = new FileReader();
            
            reader.onload = (e) => {
                this.socket.emit('uploadBackground', {
                    imageData: e.target.result,
                    fileName: file.name
                });
                this.closeModal();
            };
            
            reader.readAsDataURL(file);
        } else if (urlInput.value.trim()) {
            this.socket.emit('uploadBackground', {
                imageUrl: urlInput.value.trim()
            });
            this.closeModal();
        } else {
            alert('Выберите файл или введите URL');
        }
    }
}

// Инициализация при загрузке DOM
document.addEventListener('DOMContentLoaded', () => {
    window.sketchApp = new SketchApp();
});