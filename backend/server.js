const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({limit: '10mb'}));
app.use(express.static('public'));

// Оптимизированное хранилище
let canvasState = {
  backgroundImage: null,
  lines: new Map(), // Map для быстрого доступа: id -> {points, color, width}
  users: []
};

// Ограничители для производительности
const MAX_LINES = 200;
const MAX_POINTS_PER_LINE = 1000;

io.on('connection', (socket) => {
  console.log('Новый пользователь:', socket.id);
  
  canvasState.users.push({ id: socket.id, connectedAt: new Date() });
  
  // Отправляем оптимизированное состояние
  const linesArray = Array.from(canvasState.lines.entries()).map(([id, line]) => ({
    id, points: line.points, color: line.color, width: line.width
  }));
  
  socket.emit('initialState', {
    backgroundImage: canvasState.backgroundImage,
    lines: linesArray,
    users: canvasState.users
  });
  
  io.emit('usersUpdate', canvasState.users);

  // ОПТИМИЗИРОВАННАЯ ЛОГИКА ПЕРЕДАЧИ
  socket.on('startLine', (data) => {
    const { id, color, width } = data;
    
    // Новая линия
    canvasState.lines.set(id, {
      points: [],
      color: color,
      width: width,
      userId: socket.id
    });
    
    // Ограничиваем общее количество линий
    if (canvasState.lines.size > MAX_LINES) {
      const firstKey = canvasState.lines.keys().next().value;
      canvasState.lines.delete(firstKey);
    }
    
    socket.broadcast.emit('startLine', data);
  });

  socket.on('addPoints', (data) => {
    const { id, points } = data;
    const line = canvasState.lines.get(id);
    
    if (line) {
      // Добавляем только новые точки с ограничением
      line.points = [...line.points, ...points].slice(-MAX_POINTS_PER_LINE);
      
      // Отправляем только новые точки
      socket.broadcast.emit('addPoints', data);
    }
  });

  socket.on('endLine', (id) => {
    socket.broadcast.emit('endLine', id);
  });

  socket.on('deleteLine', (id) => {
    canvasState.lines.delete(id);
    io.emit('deleteLine', id);
  });

  socket.on('clearCanvas', () => {
    canvasState.lines.clear();
    io.emit('clearCanvas');
  });

  socket.on('uploadBackground', (data) => {
    canvasState.backgroundImage = data.backgroundUrl;
    socket.broadcast.emit('backgroundChanged', data);
  });

  socket.on('disconnect', () => {
    canvasState.users = canvasState.users.filter(user => user.id !== socket.id);
    io.emit('usersUpdate', canvasState.users);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});