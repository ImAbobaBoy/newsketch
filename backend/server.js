const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

let canvasState = {
  backgroundImage: null,
  drawings: [], // { id, userId, tool, points, color, width, timestamp }
  users: []
};

// upload-background route
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

    return res.json({ success:true, backgroundUrl });
  } catch (error) {
    console.error('Ошибка загрузки фона:', error);
    return res.status(500).json({ error: 'Ошибка загрузки фона' });
  }
});

app.get('/state', (req, res) => res.json(canvasState));

io.on('connection', (socket) => {
  console.log('Connected', socket.id);
  canvasState.users.push({ id: socket.id, connectedAt: new Date().toISOString() });

  // send initial state (clone to avoid accidental mutation)
  socket.emit('initialState', {
    backgroundImage: canvasState.backgroundImage,
    drawings: canvasState.drawings.map(d => ({ ...d })),
    users: canvasState.users
  });

  io.emit('usersUpdate', canvasState.users);

  socket.on('newLine', (lineMeta) => {
    try {
      if (!lineMeta || !lineMeta.id) return;
      const line = {
        id: lineMeta.id,
        userId: socket.id,
        tool: lineMeta.tool || 'brush',
        points: [],
        color: lineMeta.color || '#000',
        width: lineMeta.width || 2,
        timestamp: new Date().toISOString()
      };
      canvasState.drawings.push(line);
      socket.broadcast.emit('newLine', line);
    } catch (err) {
      console.error('newLine error', err);
    }
  });

  socket.on('pointsBatch', ({ id, points }) => {
    try {
      if (!id || !Array.isArray(points)) return;
      const idx = canvasState.drawings.findIndex(d => d.id === id);
      if (idx >= 0) {
        // push points as-is
        canvasState.drawings[idx].points.push(...points);
      } else {
        // create minimal record (tolerate race)
        canvasState.drawings.push({
          id,
          userId: socket.id,
          tool: 'brush',
          points: [...points],
          color: '#000',
          width: 2,
          timestamp: new Date().toISOString()
        });
      }
      socket.broadcast.emit('pointsBatch', { id, points });
    } catch (err) {
      console.error('pointsBatch error', err);
    }
  });

  socket.on('endLine', ({ id }) => {
    socket.broadcast.emit('endLine', { id });
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
    console.log('Disconnected', socket.id);
    canvasState.users = canvasState.users.filter(u => u.id !== socket.id);
    io.emit('usersUpdate', canvasState.users);
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
