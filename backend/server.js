// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

let canvasState = {
  backgroundImage: null,
  drawings: [], // { id, userId, tool, points, color, width, timestamp }
  users: []
};

// upload-background route (kept compatible)
app.post('/upload-background', (req, res) => {
  try {
    const { imageData, fileName } = req.body;
    if (!imageData) return res.status(400).json({ error: 'No image data provided' });

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

    res.json({ success: true, backgroundUrl });
  } catch (error) {
    console.error('Ошибка загрузки фона:', error);
    res.status(500).json({ error: 'Ошибка загрузки фона' });
  }
});

app.get('/state', (req, res) => res.json(canvasState));

// Socket handling: optimized events
io.on('connection', (socket) => {
  console.log('Connected', socket.id);
  canvasState.users.push({ id: socket.id, connectedAt: new Date() });

  // initial state send
  socket.emit('initialState', canvasState);
  io.emit('usersUpdate', canvasState.users);

  // Create new empty line (meta)
  socket.on('newLine', (lineMeta) => {
    // lineMeta: { id, tool, color, width, userId? }
    const line = {
      id: lineMeta.id,
      userId: socket.id,
      tool: lineMeta.tool,
      points: [], // will be filled by pointsBatch
      color: lineMeta.color,
      width: lineMeta.width,
      timestamp: new Date()
    };
    canvasState.drawings.push(line);
    // broadcast creation so others can prepare
    socket.broadcast.emit('newLine', line);
  });

  // Receive batch of points for a line
  socket.on('pointsBatch', ({ id, points }) => {
    // points: [{x,y}, ...]
    const idx = canvasState.drawings.findIndex(d => d.id === id);
    if (idx >= 0) {
      canvasState.drawings[idx].points.push(...points);
    } else {
      // in case newLine not sent/received, create minimal record
      canvasState.drawings.push({
        id,
        userId: socket.id,
        tool: 'brush',
        points: [...points],
        color: '#000',
        width: 2,
        timestamp: new Date()
      });
    }
    // broadcast to other clients
    socket.broadcast.emit('pointsBatch', { id, points });
  });

  // End of line (optional, for finalization)
  socket.on('endLine', ({ id }) => {
    socket.broadcast.emit('endLine', { id });
  });

  // Delete a line
  socket.on('deleteLine', (lineId) => {
    canvasState.drawings = canvasState.drawings.filter(d => d.id !== lineId);
    io.emit('lineDeleted', lineId);
  });

  // Clear canvas
  socket.on('clearCanvas', () => {
    canvasState.drawings = [];
    io.emit('canvasCleared');
  });

  socket.on('disconnect', () => {
    console.log('Disconnected', socket.id);
    canvasState.users = canvasState.users.filter(u => u.id !== socket.id);
    io.emit('usersUpdate', canvasState.users);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
