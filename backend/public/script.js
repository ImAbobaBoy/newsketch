class DrawingApp {
    constructor() {
        this.canvas = document.getElementById('drawingCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.socket = io();
        
        this.isDrawing = false;
        this.currentLineId = null;
        this.currentTool = 'brush';
        this.currentColor = '#ff0000';
        this.brushSize = 3;
        this.backgroundImage = null;
        this.allDrawings = [];
        
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
        this.canvas.addEventListener('mousedown', this.startDrawing.bind(this));
        this.canvas.addEventListener('mousemove', this.draw.bind(this));
        this.canvas.addEventListener('mouseup', this.stopDrawing.bind(this));
        this.canvas.addEventListener('mouseout', this.stopDrawing.bind(this));
        
        this.canvas.addEventListener('touchstart', this.handleTouch.bind(this));
        this.canvas.addEventListener('touchmove', this.handleTouch.bind(this));
        this.canvas.addEventListener('touchend', this.stopDrawing.bind(this));
    }
    
    setupSocketListeners() {
        this.socket.on('initialState', (state) => {
            console.log('Получено начальное состояние:', state);
            this.loadState(state);
        });
        
        this.socket.on('drawingUpdate', (data) => {
            this.updateDrawing(data);
        });
        
        this.socket.on('lineDeleted', (lineId) => {
            this.deleteLine(lineId);
        });
        
        this.socket.on('canvasCleared', () => {
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
        this.ctx.lineWidth = this.brushSize;
        this.ctx.strokeStyle = this.currentColor;
    }
    
    startDrawing(e) {
        if (this.currentTool === 'eraser') {
            this.handleEraser(e);
            return;
        }
        
        this.isDrawing = true;
        const pos = this.getMousePos(e);
        
        // Создаем новую линию
        this.currentLineId = 'line-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        
        // Начинаем новую линию на сервере
        this.socket.emit('startLine', this.currentLineId);
        
        // Добавляем первую точку
        this.addPoint(pos.x, pos.y);
    }
    
    draw(e) {
        if (!this.isDrawing) return;
        
        const pos = this.getMousePos(e);
        
        if (this.currentTool === 'eraser') {
            this.handleEraser(e);
        } else {
            this.addPoint(pos.x, pos.y);
        }
    }
    
    stopDrawing() {
        if (!this.isDrawing) return;
        
        this.isDrawing = false;
        
        if (this.currentLineId) {
            this.socket.emit('endLine', this.currentLineId);
            this.currentLineId = null;
        }
    }
    
    addPoint(x, y) {
        if (!this.currentLineId) return;
        
        const point = { x, y };
        
        // Находим текущую линию
        let currentLine = this.allDrawings.find(d => d.id === this.currentLineId);
        if (!currentLine) {
            currentLine = {
                id: this.currentLineId,
                tool: this.currentTool,
                points: [point],
                color: this.currentColor,
                width: this.brushSize
            };
            this.allDrawings.push(currentLine);
        } else {
            currentLine.points.push(point);
        }
        
        // Перерисовываем холст
        this.redrawCanvas();
        
        // Отправляем точку на сервер
        this.socket.emit('addPoints', {
            lineId: this.currentLineId,
            points: [point],
            color: this.currentColor,
            width: this.brushSize,
            tool: this.currentTool
        });
    }
    
    handleEraser(e) {
        const pos = this.getMousePos(e);
        const eraserRadius = this.brushSize;
        
        // Ищем линии, которые пересекаются с ластиком
        const linesToDelete = [];
        
        this.allDrawings.forEach(drawing => {
            for (let i = 0; i < drawing.points.length - 1; i++) {
                const p1 = drawing.points[i];
                const p2 = drawing.points[i + 1];
                
                if (this.isPointNearLine(pos, p1, p2, eraserRadius)) {
                    linesToDelete.push(drawing.id);
                    break;
                }
            }
        });
        
        // Удаляем найденные линии
        linesToDelete.forEach(lineId => {
            this.deleteLine(lineId);
            this.socket.emit('deleteLine', lineId);
        });
        
        // Перерисовываем холст
        this.redrawCanvas();
    }
    
    isPointNearLine(point, lineStart, lineEnd, radius) {
        // Вычисляем расстояние от точки до линии
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
    
    updateDrawing(data) {
        let drawing = this.allDrawings.find(d => d.id === data.lineId);
        if (!drawing) {
            drawing = {
                id: data.lineId,
                tool: data.tool,
                points: [],
                color: data.color,
                width: data.width
            };
            this.allDrawings.push(drawing);
        }
        
        drawing.points.push(...data.points);
        drawing.color = data.color;
        drawing.width = data.width;
        drawing.tool = data.tool;
        
        this.redrawCanvas();
    }
    
    deleteLine(lineId) {
        this.allDrawings = this.allDrawings.filter(d => d.id !== lineId);
        this.redrawCanvas();
    }
    
    redrawCanvas() {
        this.clearLocalCanvas();
        
        // Рисуем все линии
        this.allDrawings.forEach(drawing => {
            if (drawing.points.length < 2) return;
            
            this.ctx.beginPath();
            this.ctx.moveTo(drawing.points[0].x, drawing.points[0].y);
            
            for (let i = 1; i < drawing.points.length; i++) {
                this.ctx.lineTo(drawing.points[i].x, drawing.points[i].y);
            }
            
            this.ctx.strokeStyle = drawing.color;
            this.ctx.lineWidth = drawing.width;
            this.ctx.stroke();
        });
    }
    
    clearLocalCanvas() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (this.backgroundImage) {
            this.ctx.drawImage(this.backgroundImage, 0, 0, this.canvas.width, this.canvas.height);
        }
    }
    
    clearCanvas() {
        if (confirm('Очистить весь холст? Все рисунки будут удалены.')) {
            this.socket.emit('clearCanvas');
            this.allDrawings = [];
            this.clearLocalCanvas();
        }
    }
    
    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        let clientX, clientY;
        
        if (e.type.includes('touch')) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }
        
        return {
            x: clientX - rect.left,
            y: clientY - rect.top
        };
    }
    
    handleTouch(e) {
        e.preventDefault();
        if (e.type === 'touchstart') {
            this.startDrawing(e);
        } else if (e.type === 'touchmove') {
            this.draw(e);
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
            this.backgroundImage = img;
            this.redrawCanvas();
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
        
        this.allDrawings = state.drawings || [];
        this.redrawCanvas();
        
        document.getElementById('usersCount').textContent = state.users.length;
        document.getElementById('loading').style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new DrawingApp();
});