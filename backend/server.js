const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json({limit: '10mb'}));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

let canvasState = {
  backgroundImage: null,
  drawings: [],
  users: []
};

// API для загрузки фона
app.post('/upload-background', (req, res) => {
  try {
    const { imageData, fileName } = req.body;
    
    if (!imageData) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    const fileExtension = fileName ? fileName.split('.').pop() : 'png';
    const uniqueFileName = `background-${Date.now()}.${fileExtension}`;
    const filePath = path.join('uploads', uniqueFileName);
    
    fs.writeFileSync(filePath, buffer);
    
    const backgroundUrl = `/uploads/${uniqueFileName}`;
    canvasState.backgroundImage = backgroundUrl;
    canvasState.drawings = [];
    
    io.emit('backgroundChanged', { backgroundUrl });
    io.emit('canvasCleared');
    
    res.json({ 
      success: true, 
      backgroundUrl,
      message: 'Фон успешно загружен и синхронизирован' 
    });
    
  } catch (error) {
    console.error('Ошибка загрузки фона:', error);
    res.status(500).json({ error: 'Ошибка загрузки фона' });
  }
});

app.get('/state', (req, res) => {
  res.json(canvasState);
});

// Socket.io обработчики
io.on('connection', (socket) => {
  console.log('Новый пользователь подключен:', socket.id);
  
  canvasState.users.push({
    id: socket.id,
    connectedAt: new Date()
  });
  
  socket.emit('initialState', canvasState);
  io.emit('usersUpdate', canvasState.users);
  
  // Обработка начала рисования линии
  socket.on('startLine', (lineId) => {
    canvasState.drawings.push({
      id: lineId,
      userId: socket.id,
      tool: 'brush',
      points: [],
      color: '#000000',
      width: 3,
      timestamp: new Date()
    });
  });
  
  // Обработка добавления точек в линию
  socket.on('addPoints', (data) => {
    const drawing = canvasState.drawings.find(d => d.id === data.lineId);
    if (drawing) {
      drawing.points.push(...data.points);
      drawing.color = data.color;
      drawing.width = data.width;
      drawing.tool = data.tool;
      
      // Рассылаем обновление всем остальным
      socket.broadcast.emit('drawingUpdate', {
        lineId: data.lineId,
        points: data.points,
        color: data.color,
        width: data.width,
        tool: data.tool
      });
    }
  });
  
  // Обработка завершения линии
  socket.on('endLine', (lineId) => {
    const drawing = canvasState.drawings.find(d => d.id === lineId);
    if (drawing) {
      drawing.completed = true;
    }
  });
  
  // Обработка удаления линии
  socket.on('deleteLine', (lineId) => {
    canvasState.drawings = canvasState.drawings.filter(d => d.id !== lineId);
    io.emit('lineDeleted', lineId);
  });
  
  // Обработка очистки холста
  socket.on('clearCanvas', () => {
    canvasState.drawings = [];
    io.emit('canvasCleared');
  });
  
  socket.on('disconnect', () => {
    console.log('Пользователь отключен:', socket.id);
    canvasState.users = canvasState.users.filter(user => user.id !== socket.id);
    io.emit('usersUpdate', canvasState.users);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});