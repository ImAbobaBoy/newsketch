const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Настройка multer для загрузки изображений
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `background-${Date.now()}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Только изображения!'));
    }
  }
});

// Хранилище состояния (в памяти, для продакшена лучше Redis)
let canvasState = {
  backgroundImage: null,
  drawings: [],
  users: []
};

// API Routes
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const backgroundUrl = `/uploads/${req.file.filename}`;
  canvasState.backgroundImage = backgroundUrl;
  
  // Очищаем старые рисунки при загрузке нового фона
  canvasState.drawings = [];
  
  // Уведомляем всех клиентов о новом фоне
  io.emit('backgroundChanged', { backgroundUrl });
  
  res.json({ 
    success: true, 
    backgroundUrl,
    message: 'Фон успешно загружен' 
  });
});

app.get('/state', (req, res) => {
  res.json(canvasState);
});

// Socket.io обработчики
io.on('connection', (socket) => {
  console.log('Новый пользователь подключен:', socket.id);
  
  // Добавляем пользователя
  canvasState.users.push({
    id: socket.id,
    connectedAt: new Date()
  });
  
  // Отправляем текущее состояние новому пользователю
  socket.emit('initialState', canvasState);
  
  // Уведомляем всех о новом пользователе
  io.emit('usersUpdate', canvasState.users);
  
  // Обработка рисования
  socket.on('drawing', (data) => {
    // Добавляем рисунок в историю
    const drawing = {
      id: Date.now().toString(),
      userId: socket.id,
      tool: data.tool,
      points: data.points,
      color: data.color,
      width: data.width,
      timestamp: new Date()
    };
    
    canvasState.drawings.push(drawing);
    
    // Рассылаем всем остальным пользователям
    socket.broadcast.emit('drawing', drawing);
  });
  
  // Обработка очистки холста
  socket.on('clearCanvas', () => {
    canvasState.drawings = [];
    io.emit('canvasCleared');
  });
  
  // Обработка отключения
  socket.on('disconnect', () => {
    console.log('Пользователь отключен:', socket.id);
    
    // Удаляем пользователя
    canvasState.users = canvasState.users.filter(user => user.id !== socket.id);
    io.emit('usersUpdate', canvasState.users);
  });
});

// Создаем папку для загрузок
const fs = require('fs');
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Для фронтенда: http://localhost:${PORT}`);
});