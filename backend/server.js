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
      backgroundUrl
    });
    
  } catch (error) {
    console.error('Ошибка загрузки фона:', error);
    res.status(500).json({ error: 'Ошибка загрузки фона' });
  }
});

app.get('/state', (req, res) => {
  res.json(canvasState);
});

io.on('connection', (socket) => {
  console.log('Новый пользователь подключен:', socket.id);
  
  canvasState.users.push({
    id: socket.id,
    connectedAt: new Date()
  });
  
  socket.emit('initialState', canvasState);
  io.emit('usersUpdate', canvasState.users);
  
  socket.on('drawing', (drawingData) => {
    if (!drawingData.id) {
      drawingData.id = `${socket.id}-${Date.now()}`;
    }
    
    const existingIndex = canvasState.drawings.findIndex(d => d.id === drawingData.id);
    
    if (existingIndex >= 0) {
      canvasState.drawings[existingIndex] = {
        ...canvasState.drawings[existingIndex],
        ...drawingData
      };
    } else {
      canvasState.drawings.push({
        id: drawingData.id,
        userId: socket.id,
        tool: drawingData.tool,
        points: drawingData.points,
        color: drawingData.color,
        width: drawingData.width,
        timestamp: new Date()
      });
    }
    
    socket.broadcast.emit('drawing', drawingData);
  });
  
  socket.on('deleteLine', (lineId) => {
    canvasState.drawings = canvasState.drawings.filter(d => d.id !== lineId);
    io.emit('lineDeleted', lineId);
  });
  
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