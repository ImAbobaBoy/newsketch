const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server,{ cors:{ origin:"*", methods:["GET","POST"] } });

app.use(cors());
app.use(express.json({ limit:'20mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

if(!fs.existsSync('uploads')) fs.mkdirSync('uploads');

let canvasState = { backgroundImage:null, drawings:[], users:[] };

app.post('/upload-background',(req,res)=>{
  try{
    const { imageData, fileName } = req.body;
    if(!imageData) return res.status(400).json({error:'No image data'});
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/,'');
    const buffer = Buffer.from(base64Data,'base64');
    const ext = fileName?.split('.').pop()||'png';
    const uniqueName = `background-${Date.now()}.${ext}`;
    const filePath = path.join('uploads',uniqueName);
    fs.writeFileSync(filePath,buffer);
    const backgroundUrl = `/uploads/${uniqueName}`;
    canvasState.backgroundImage = backgroundUrl;
    canvasState.drawings = [];
    io.emit('backgroundChanged',{backgroundUrl});
    io.emit('canvasCleared');
    res.json({success:true,backgroundUrl});
  }catch(e){ console.error(e); res.status(500).json({error:'Ошибка загрузки'}); }
});

app.get('/state',(req,res)=>res.json(canvasState));

io.on('connection',(socket)=>{
  canvasState.users.push({id:socket.id,connectedAt:new
