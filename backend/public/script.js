class DrawingApp {
    constructor() {
        this.canvas = document.getElementById('drawingCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.socket = io();
        
        this.isDrawing = false;
        this.lastX = 0;
        this.lastY = 0;
        this.currentTool = 'brush';
        this.currentColor = '#ff0000';
        this.brushSize = 3;
        this.backgroundImage = null;
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.setupSocketListeners();
        this.setupCanvas();
    }
    
    setupEventListeners() {
        // Инструменты
        document.getElementById('toolSelect').addEventListener('change', (e) => {
            this.currentTool = e.target.value;
        });
        
        // Цвет
        document.getElementById('colorPicker').addEventListener('change', (e) => {
            this.currentColor = e.target.value;
        });
        
        // Размер кисти
        const brushSize = document.getElementById('brushSize');
        const sizeValue = document.getElementById('sizeValue');
        
        brushSize.addEventListener('input', (e) => {
            this.brushSize = parseInt(e.target.value);
            sizeValue.textContent = this.brushSize;
        });
        
        // Очистка
        document.getElementById('clearBtn').addEventListener('click', () => {
            this.clearCanvas();
        });
        
        // Загрузка фона
        document.getElementById('backgroundBtn').addEventListener('click', () => {
            this.openBackgroundModal();
        });
        
        // Модальное окно
        this.setupModal();
        
        // События canvas
        this.setupCanvasEvents();
    }
    
    setupCanvasEvents() {
        this.canvas.addEventListener('mousedown', this.startDrawing.bind(this));
        this.canvas.addEventListener('mousemove', this.draw.bind(this));
        this.canvas.addEventListener('mouseup', this.stopDrawing.bind(this));
        this.canvas.addEventListener('mouseout', this.stopDrawing.bind(this));
        
        // Touch события для мобильных устройств
        this.canvas.addEventListener('touchstart', this.handleTouch.bind(this));
        this.canvas.addEventListener('touchmove', this.handleTouch.bind(this));
        this.canvas.addEventListener('touchend', this.stopDrawing.bind(this));
    }
    
    setupSocketListeners() {
        // Получение начального состояния
        this.socket.on('initialState', (state) => {
            console.log('Получено начальное состояние:', state);
            this.loadState(state);
        });
        
        // Новые рисунки от других пользователей
        this.socket.on('drawing', (drawingData) => {
            this.drawRemote(drawingData);
        });
        
        // Очистка холста
        this.socket.on('canvasCleared', () => {
            this.clearLocalCanvas();
        });
        
        // Смена фона
        this.socket.on('backgroundChanged', (data) => {
            this.loadBackgroundImage(data.backgroundUrl);
        });
        
        // Обновление пользователей
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
        this.isDrawing = true;
        const pos = this.getMousePos(e);
        [this.lastX, this.lastY] = [pos.x, pos.y];
        
        // Для инструментов, которые рисуют сразу (точки)
        if (this.currentTool === 'brush' || this.currentTool === 'eraser') {
            this.drawDot(pos.x, pos.y);
        }
    }
    
    draw(e) {
        if (!this.isDrawing) return;
        
        const pos = this.getMousePos(e);
        const points = [
            { x: this.lastX, y: this.lastY },
            { x: pos.x, y: pos.y }
        ];
        
        switch (this.currentTool) {
            case 'brush':
            case 'eraser':
                this.drawLine(points);
                this.sendDrawingData(points);
                break;
            case 'line':
                this.previewLine(this.lastX, this.lastY, pos.x, pos.y);
                break;
            case 'rectangle':
                this.previewRect(this.lastX, this.lastY, pos.x, pos.y);
                break;
            case 'circle':
                this.previewCircle(this.lastX, this.lastY, pos.x, pos.y);
                break;
        }
        
        [this.lastX, this.lastY] = [pos.x, pos.y];
    }
    
    stopDrawing(e) {
        if (!this.isDrawing) return;
        
        const pos = this.getMousePos(e);
        
        if (this.currentTool === 'line') {
            this.drawFinalLine(this.lastX, this.lastY, pos.x, pos.y);
            this.sendDrawingData([{x: this.lastX, y: this.lastY}, {x: pos.x, y: pos.y}], 'line');
        } else if (this.currentTool === 'rectangle') {
            this.drawFinalRect(this.lastX, this.lastY, pos.x, pos.y);
            this.sendDrawingData([{x: this.lastX, y: this.lastY}, {x: pos.x, y: pos.y}], 'rectangle');
        } else if (this.currentTool === 'circle') {
            this.drawFinalCircle(this.lastX, this.lastY, pos.x, pos.y);
            this.sendDrawingData([{x: this.lastX, y: this.lastY}, {x: pos.x, y: pos.y}], 'circle');
        }
        
        this.isDrawing = false;
        this.redrawCanvas(); // Убираем превью
    }
    
    drawLine(points) {
        this.ctx.beginPath();
        this.ctx.moveTo(points[0].x, points[0].y);
        this.ctx.lineTo(points[1].x, points[1].y);
        this.ctx.stroke();
    }
    
    drawDot(x, y) {
        this.ctx.beginPath();
        this.ctx.arc(x, y, this.brushSize / 2, 0, Math.PI * 2);
        this.ctx.fill();
        
        // Отправляем точку как линию с одинаковыми координатами
        this.sendDrawingData([{x, y}, {x, y}]);
    }
    
    previewLine(x1, y1, x2, y2) {
        this.redrawCanvas(); // Перерисовываем canvas для превью
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.stroke();
    }
    
    drawFinalLine(x1, y1, x2, y2) {
        this.redrawCanvas();
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.stroke();
    }
    
    previewRect(x1, y1, x2, y2) {
        this.redrawCanvas();
        this.ctx.beginPath();
        this.ctx.rect(x1, y1, x2 - x1, y2 - y1);
        this.ctx.stroke();
    }
    
    drawFinalRect(x1, y1, x2, y2) {
        this.redrawCanvas();
        this.ctx.beginPath();
        this.ctx.rect(x1, y1, x2 - x1, y2 - y1);
        this.ctx.stroke();
    }
    
    previewCircle(x1, y1, x2, y2) {
        this.redrawCanvas();
        const radius = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
        this.ctx.beginPath();
        this.ctx.arc(x1, y1, radius, 0, Math.PI * 2);
        this.ctx.stroke();
    }
    
    drawFinalCircle(x1, y1, x2, y2) {
        this.redrawCanvas();
        const radius = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
        this.ctx.beginPath();
        this.ctx.arc(x1, y1, radius, 0, Math.PI * 2);
        this.ctx.stroke();
    }
    
    drawRemote(drawingData) {
        const originalColor = this.ctx.strokeStyle;
        const originalWidth = this.ctx.lineWidth;
        
        this.ctx.strokeStyle = drawingData.color;
        this.ctx.lineWidth = drawingData.width;
        
        if (drawingData.tool === 'brush' || drawingData.tool === 'eraser') {
            this.drawLine(drawingData.points);
        } else if (drawingData.tool === 'line') {
            const points = drawingData.points;
            this.drawFinalLine(points[0].x, points[0].y, points[1].x, points[1].y);
        } else if (drawingData.tool === 'rectangle') {
            const points = drawingData.points;
            this.drawFinalRect(points[0].x, points[0].y, points[1].x, points[1].y);
        } else if (drawingData.tool === 'circle') {
            const points = drawingData.points;
            this.drawFinalCircle(points[0].x, points[0].y, points[1].x, points[1].y);
        }
        
        this.ctx.strokeStyle = originalColor;
        this.ctx.lineWidth = originalWidth;
    }
    
    sendDrawingData(points, tool = null) {
        const drawingTool = tool || this.currentTool;
        const drawingColor = drawingTool === 'eraser' ? '#000000' : this.currentColor;
        
        this.socket.emit('drawing', {
            tool: drawingTool,
            points: points,
            color: drawingColor,
            width: this.brushSize
        });
    }
    
    clearCanvas() {
        if (confirm('Очистить весь холст? Все рисунки будут удалены.')) {
            this.socket.emit('clearCanvas');
            this.clearLocalCanvas();
        }
    }
    
    clearLocalCanvas() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (this.backgroundImage) {
            this.ctx.drawImage(this.backgroundImage, 0, 0, this.canvas.width, this.canvas.height);
        }
    }
    
    redrawCanvas() {
        this.clearLocalCanvas();
        // Здесь можно добавить перерисовку всех элементов, если нужно
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
            this.loadBackground();
        };
    }
    
    openBackgroundModal() {
        document.getElementById('backgroundModal').style.display = 'block';
    }
    
    loadBackground() {
        const fileInput = document.getElementById('backgroundInput');
        const urlInput = document.getElementById('backgroundUrl');
        
        if (fileInput.files && fileInput.files[0]) {
            const file = fileInput.files[0];
            const reader = new FileReader();
            
            reader.onload = (e) => {
                this.setBackgroundImage(e.target.result);
                document.getElementById('backgroundModal').style.display = 'none';
            };
            
            reader.readAsDataURL(file);
        } else if (urlInput.value) {
            this.setBackgroundImage(urlInput.value);
            document.getElementById('backgroundModal').style.display = 'none';
        } else {
            alert('Пожалуйста, выберите файл или введите URL');
        }
    }
    
    setBackgroundImage(src) {
        const img = new Image();
        img.onload = () => {
            this.backgroundImage = img;
            this.redrawCanvas();
            // Здесь можно добавить отправку на сервер, когда реализуем загрузку
            console.log('Фон загружен:', src);
        };
        img.onerror = () => {
            alert('Ошибка загрузки изображения');
        };
        img.src = src;
    }
    
    loadBackgroundImage(url) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            this.backgroundImage = img;
            this.redrawCanvas();
        };
        img.src = url;
    }
    
    loadState(state) {
        if (state.backgroundImage) {
            this.loadBackgroundImage(state.backgroundImage);
        }
        
        // Загружаем историю рисунков
        state.drawings.forEach(drawing => {
            this.drawRemote(drawing);
        });
        
        document.getElementById('usersCount').textContent = state.users.length;
        document.getElementById('loading').style.display = 'none';
    }
}

// Инициализация приложения когда DOM загружен
document.addEventListener('DOMContentLoaded', () => {
    new DrawingApp();
});