class DrawingApp {
    constructor() {
        this.canvas = document.getElementById('drawingCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.socket = io();
        
        this.isDrawing = false;
        this.currentTool = 'brush';
        this.currentColor = '#ff0000';
        this.brushSize = 3;
        this.backgroundImage = null;
        this.drawings = new Map(); // Храним линии в Map для быстрого доступа
        this.currentLineId = null;
        
        // Для оптимизации перерисовки
        this.needsRedraw = true;
        this.animationId = null;
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.setupSocketListeners();
        this.setupCanvas();
        this.startAnimationLoop();
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
        
        // Обработка изменения размера окна
        window.addEventListener('resize', () => {
            this.redrawCanvas();
        });
    }
    
    setupCanvasEvents() {
        // Mouse events
        this.canvas.addEventListener('mousedown', this.startDrawing.bind(this));
        this.canvas.addEventListener('mousemove', this.draw.bind(this));
        this.canvas.addEventListener('mouseup', this.stopDrawing.bind(this));
        this.canvas.addEventListener('mouseout', this.stopDrawing.bind(this));
        
        // Touch events - исправляем для мобильных
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
            this.needsRedraw = true;
        });
        
        this.socket.on('lineDeleted', (lineId) => {
            this.drawings.delete(lineId);
            this.needsRedraw = true;
        });
        
        this.socket.on('canvasCleared', () => {
            this.drawings.clear();
            this.needsRedraw = true;
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
    
    startAnimationLoop() {
        const animate = () => {
            if (this.needsRedraw) {
                this.redrawCanvas();
                this.needsRedraw = false;
            }
            this.animationId = requestAnimationFrame(animate);
        };
        animate();
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
    
    startDrawing(e) {
        const pos = this.getCanvasCoordinates(e);
        
        if (this.currentTool === 'diamond') {
            this.drawDiamond(pos.x, pos.y);
            return;
        }
        
        this.isDrawing = true;
        this.currentLineId = `${this.socket.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        const drawingData = {
            id: this.currentLineId,
            tool: this.currentTool,
            points: [pos],
            color: this.currentColor,
            width: this.brushSize
        };
        
        this.addDrawing(drawingData);
        this.socket.emit('drawing', drawingData);
    }
    
    draw(e) {
        if (!this.isDrawing) return;
        
        const pos = this.getCanvasCoordinates(e);
        
        if (this.currentTool === 'eraser') {
            this.handleEraser(pos.x, pos.y);
        } else {
            this.addPointToCurrentLine(pos.x, pos.y);
        }
    }
    
    stopDrawing() {
        if (!this.isDrawing) return;
        this.isDrawing = false;
        this.currentLineId = null;
    }
    
    addPointToCurrentLine(x, y) {
        if (!this.currentLineId) return;
        
        const drawing = this.drawings.get(this.currentLineId);
        if (drawing) {
            drawing.points.push({x, y});
            
            this.socket.emit('drawing', {
                id: this.currentLineId,
                tool: this.currentTool,
                points: drawing.points,
                color: this.currentColor,
                width: this.brushSize
            });
            
            this.needsRedraw = true;
        }
    }
    
    drawDiamond(x, y) {
        const size = this.brushSize * 4;
        const points = [
            {x, y: y - size}, // верх
            {x: x + size, y}, // право
            {x, y: y + size}, // низ
            {x: x - size, y}, // лево
            {x, y: y - size}  // замкнуть
        ];
        
        const diamondId = `${this.socket.id}-diamond-${Date.now()}`;
        const drawingData = {
            id: diamondId,
            tool: 'diamond',
            points: points,
            color: this.currentColor,
            width: this.brushSize
        };
        
        this.addDrawing(drawingData);
        this.socket.emit('drawing', drawingData);
        this.needsRedraw = true;
    }
    
    handleEraser(x, y) {
        const eraserRadius = this.brushSize * 2;
        const linesToDelete = [];
        
        // Проверяем все линии на пересечение с ластиком
        for (const [lineId, drawing] of this.drawings) {
            for (let i = 0; i < drawing.points.length - 1; i++) {
                const p1 = drawing.points[i];
                const p2 = drawing.points[i + 1];
                
                if (this.isPointNearLine({x, y}, p1, p2, eraserRadius)) {
                    linesToDelete.push(lineId);
                    break;
                }
            }
        }
        
        // Удаляем найденные линии
        linesToDelete.forEach(lineId => {
            this.drawings.delete(lineId);
            this.socket.emit('deleteLine', lineId);
        });
        
        this.needsRedraw = true;
    }
    
    isPointNearLine(point, lineStart, lineEnd, radius) {
        // Вычисляем расстояние от точки до отрезка
        const A = point.x - lineStart.x;
        const B = point.y - lineStart.y;
        const C = lineEnd.x - lineStart.x;
        const D = lineEnd.y - lineStart.y;
        
        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;
        
        if (lenSq !== 0) {
            param = dot / lenSq;
        }
        
        let xx, yy;
        
        if (param < 0) {
            xx = lineStart.x;
            yy = lineStart.y;
        } else if (param > 1) {
            xx = lineEnd.x;
            yy = lineEnd.y;
        } else {
            xx = lineStart.x + param * C;
            yy = lineStart.y + param * D;
        }
        
        const dx = point.x - xx;
        const dy = point.y - yy;
        return Math.sqrt(dx * dx + dy * dy) <= radius;
    }
    
    addDrawing(drawingData) {
        this.drawings.set(drawingData.id, {
            tool: drawingData.tool,
            points: [...drawingData.points],
            color: drawingData.color,
            width: drawingData.width
        });
    }
    
    redrawCanvas() {
        // Очищаем canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Рисуем фон
        if (this.backgroundImage) {
            this.ctx.drawImage(this.backgroundImage, 0, 0, this.canvas.width, this.canvas.height);
        }
        
        // Рисуем все линии
        for (const drawing of this.drawings.values()) {
            this.drawSingleLine(drawing);
        }
    }
    
    drawSingleLine(drawing) {
        if (drawing.points.length < 2) return;
        
        this.ctx.beginPath();
        this.ctx.moveTo(drawing.points[0].x, drawing.points[0].y);
        
        for (let i = 1; i < drawing.points.length; i++) {
            this.ctx.lineTo(drawing.points[i].x, drawing.points[i].y);
        }
        
        this.ctx.strokeStyle = drawing.color;
        this.ctx.lineWidth = drawing.width;
        this.ctx.stroke();
    }
    
    clearCanvas() {
        if (confirm('Очистить весь холст? Все рисунки будут удалены.')) {
            this.socket.emit('clearCanvas');
            this.drawings.clear();
            this.needsRedraw = true;
        }
    }
    
    // Touch handlers
    handleTouchStart(e) {
        this.startDrawing(e);
    }
    
    handleTouchMove(e) {
        this.draw(e);
    }
    
    handleTouchEnd(e) {
        this.stopDrawing();
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
            this.backgroundImage = img;
            this.needsRedraw = true;
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
        this.needsRedraw = true;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new DrawingApp();
});