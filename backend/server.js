const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Улучшенное состояние
const canvasState = {
    backgroundImage: null,
    drawings: new Map(), // Используем Map для быстрого доступа
    users: new Set()
};

// Загрузка фона
app.post('/upload-background', async (req, res) => {
    try {
        const { imageData, fileName, imageUrl } = req.body;
        
        if (!imageData && !imageUrl) {
            return res.status(400).json({ error: 'No image data provided' });
        }

        let imageBuffer;
        if (imageData) {
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
            imageBuffer = Buffer.from(base64Data, 'base64');
        } else {
            // Загрузка по URL
            const response = await fetch(imageUrl);
            imageBuffer = Buffer.from(await response.arrayBuffer());
        }

        const fileExtension = 'png'; // Всегда PNG для консистентности
        const uniqueFileName = `background-${Date.now()}.${fileExtension}`;
        const filePath = path.join(__dirname, 'uploads', uniqueFileName);

        await fs.writeFile(filePath, imageBuffer);

        const backgroundUrl = `/uploads/${uniqueFileName}`;
        canvasState.backgroundImage = backgroundUrl;
        canvasState.drawings.clear(); // Очищаем рисунки при смене фона

        io.emit('backgroundChanged', { backgroundUrl });
        io.emit('canvasCleared');

        res.json({ success: true, backgroundUrl });
    } catch (error) {
        console.error('Ошибка загрузки фона:', error);
        res.status(500).json({ error: 'Ошибка загрузки фона' });
    }
});

// Socket handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    canvasState.users.add(socket.id);

    // Отправляем текущее состояние
    socket.emit('initialState', {
        backgroundImage: canvasState.backgroundImage,
        drawings: Array.from(canvasState.drawings.values()),
        users: Array.from(canvasState.users)
    });

    io.emit('usersUpdate', Array.from(canvasState.users));

    socket.on('newLine', (lineMeta) => {
        const line = {
            ...lineMeta,
            userId: socket.id,
            timestamp: Date.now()
        };
        
        canvasState.drawings.set(lineMeta.id, line);
        socket.broadcast.emit('newLine', line);
    });

    socket.on('pointsBatch', ({ id, points }) => {
        const line = canvasState.drawings.get(id);
        if (line) {
            if (!line.points) line.points = [];
            line.points.push(...points);
            socket.broadcast.emit('pointsBatch', { id, points });
        }
    });

    socket.on('endLine', ({ id }) => {
        socket.broadcast.emit('endLine', { id });
    });

    socket.on('deleteLine', (lineId) => {
        canvasState.drawings.delete(lineId);
        io.emit('lineDeleted', lineId);
    });

    socket.on('clearCanvas', () => {
        canvasState.drawings.clear();
        io.emit('canvasCleared');
    });

    socket.on('uploadBackground', async (data) => {
        try {
            // Аналогично HTTP endpoint
            const { imageData, fileName, imageUrl } = data;
            let imageBuffer;

            if (imageData) {
                const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
                imageBuffer = Buffer.from(base64Data, 'base64');
            } else {
                const response = await fetch(imageUrl);
                imageBuffer = Buffer.from(await response.arrayBuffer());
            }

            const uniqueFileName = `background-${Date.now()}.png`;
            const filePath = path.join(__dirname, 'uploads', uniqueFileName);

            await fs.writeFile(filePath, imageBuffer);

            const backgroundUrl = `/uploads/${uniqueFileName}`;
            canvasState.backgroundImage = backgroundUrl;
            canvasState.drawings.clear();

            io.emit('backgroundChanged', { backgroundUrl });
            io.emit('canvasCleared');
        } catch (error) {
            console.error('Background upload error:', error);
            socket.emit('error', { message: 'Failed to upload background' });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        canvasState.users.delete(socket.id);
        io.emit('usersUpdate', Array.from(canvasState.users));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // Создаем папку uploads если не существует
    fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
});