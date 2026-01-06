const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const auth = require("./src/middleware/auth");
const onlineUsers = require("./src/onlineUsers");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", require("./src/routes/auth"));
app.use("/api/friends", require("./src/routes/friends"));
app.use("/api/messages", require("./src/routes/messages"));
app.use("/api/online", require("./src/routes/onlineRoutes"));

// Debug route: dump online users mapping (protected)
app.get('/api/debug/online', auth, (req, res) => {
  try {
    const online = require('./src/onlineUsers');
    return res.json({ online: online.list() });
  } catch (err) {
    console.error('Debug online error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Detailed sockets debug (includes per-socket rooms and handshake info)
app.get('/api/debug/sockets', auth, (req, res) => {
  try {
    const online = require('./src/onlineUsers');
    const sockets = [];
    // io is available as global.io
    const serverIo = global.io;
    if (serverIo && serverIo.sockets && serverIo.sockets.sockets) {
      // In Socket.IO v4, sockets.sockets is a Map
      for (const [sid, sock] of serverIo.sockets.sockets) {
        sockets.push({
          socketId: sid,
          connected: !!sock.connected,
          userId: sock.userId || null,
          rooms: Array.from(sock.rooms || []),
          handshakeAuth: sock.handshake ? (sock.handshake.auth || {}) : {},
        })
      }
    }

    return res.json({ online: online.list(), sockets });
  } catch (err) {
    console.error('Debug sockets error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// MongoDB
console.log('DEBUG MONGO_URI:', process.env.MONGO_URI);
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB connected");

    // Drop the old username index if it exists
    try {
      const User = require("./src/models/User");
      await User.collection.dropIndex("username_1");
      console.log("Dropped old username index");
    } catch (err) {
      // Index might not exist, that's fine
      if (err.code !== 27) { // 27 = IndexNotFound
        console.log("No username index to drop (this is fine)");
      }
    }
  })
  .catch((err) => console.log(err));

// Socket.IO
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// make io available to route handlers if needed
global.io = io;

io.use((socket, next) => {
  // Try to decode token if present on handshake, but allow connections without it.
  const token = socket.handshake.auth && socket.handshake.auth.token;
  console.log('Socket handshake token:', token ? '[redacted]' : '<<missing>>')
  if (token) {
    try {
      const jwt = require("jsonwebtoken");
      const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret123");
      console.log('Socket handshake decoded id:', decoded?.id)
      socket.userId = decoded.id;
    } catch (err) {
      console.log('Socket handshake token invalid', err && err.message)
      // don't reject connection; allow client to register after connect
    }
  }
  next();
});

io.on("connection", (socket) => {
  // If userId was set during handshake, register immediately
  if (socket.userId) {
    try { onlineUsers.add(socket.userId, socket.id); } catch (e) { console.error(e) }
    console.log("User online (handshake):", socket.userId, 'socket:', socket.id);
  } else {
    console.log('Socket connected without userId, waiting for register event. socket:', socket.id)
  }

  // Allow clients to explicitly register after connect (fallback)
  socket.on('register', (payload) => {
    try {
      const jwt = require('jsonwebtoken');
      if (!payload || !payload.token) {
        // fallback: allow direct userId (less secure)
        const userIdFallback = payload && payload.userId;
        if (!userIdFallback) return console.log('register: no token or userId provided')
        socket.userId = String(userIdFallback);
        onlineUsers.add(socket.userId, socket.id);
        console.log('register (fallback): socket registered', socket.id, 'userId:', socket.userId)
        socket.emit('registered')
        return
      }

      // Verify token and extract user id (accept either `id` or `_id`)
      const decoded = jwt.verify(payload.token, process.env.JWT_SECRET || 'secret123');
      const userId = (decoded && (decoded.id || decoded._id)) ? String(decoded.id || decoded._id) : null;
      if (!userId) return console.log('register: token decoded but no user id present')

      socket.userId = userId;
      onlineUsers.add(userId, socket.id);
      console.log('register: socket registered', socket.id, 'userId:', userId)
      // acknowledge registration to client
      socket.emit('registered')
    } catch (err) {
      console.error('register handler error', err && err.message)
    }
  })


  socket.on("sendMessage", async (payload, ack) => {
    // Accept either { to, text } or { receiver, text } or full message object
    const to = payload && (payload.to || payload.receiver || payload.toId || payload.receiverId || payload.receiver_id);
    const text = payload && (payload.text || payload.message || payload.content);
    const clientTempId = payload && (payload.clientTempId || payload._id || payload.tempId)
    console.log('📨 sendMessage:', { from: socket.userId, to, text: text?.substring(0, 20) + '...', socketId: socket.id })

    // Validation: reject if receiver is missing or same as sender
    if (!to) {
      console.log('❌ sendMessage: missing recipient')
      if (typeof ack === 'function') ack({ ok: false, message: 'missing recipient' })
      return;
    }
    if (!text) {
      console.log('❌ sendMessage: missing text')
      if (typeof ack === 'function') ack({ ok: false, message: 'missing text' })
      return;
    }
    if (String(to) === String(socket.userId)) {
      console.log('❌ sendMessage: cannot send to self')
      if (typeof ack === 'function') ack({ ok: false, message: 'cannot send to self' })
      return;
    }

    // If message is addressed to the bot user id 'bot' or contains '/bot', respond from server-side bot
    const isBot = String(to) === 'bot' || (typeof text === 'string' && text.trim().startsWith('/bot'))
    if (isBot) {
      console.log('Bot received message from', socket.userId, text)
      const reply = `Bot: I received your message: "${String(text).replace('/bot', '').trim()}"`;
      io.to(socket.id).emit('receiveMessage', { from: 'bot', text: reply })
      if (typeof ack === 'function') ack({ ok: true, data: { _id: Date.now().toString(), text: reply, sender: 'bot' } })
      return
    }

    // Persist message to DB (always save, regardless of online status)
    try {
      const Message = require('./src/models/Message');
      const saved = await Message.create({ sender: socket.userId, receiver: to, text });
      const savedPayload = {
        _id: String(saved._id),
        text: saved.text,
        sender: String(saved.sender),
        receiver: String(saved.receiver),
        createdAt: saved.timestamp || saved.createdAt || new Date().toISOString(),
        clientTempId: clientTempId || undefined,
      };
      console.log('💾 Message saved to DB:', savedPayload._id)

      // ✅ Emit to RECEIVER's specific socket(s) (if online)
      const receiverSocketIds = onlineUsers.getSocketIds(String(to)) || [];
      const senderSocketIds = onlineUsers.getSocketIds(String(socket.userId)) || [];
      console.log('📤 Receiver:', to, 'sockets:', receiverSocketIds.length > 0 ? receiverSocketIds : 'OFFLINE')
      console.log('📤 Sender:', socket.userId, 'sockets:', senderSocketIds)

      // Send to receiver (if online)
      if (receiverSocketIds.length > 0) {
        receiverSocketIds.forEach(socketId => {
          console.log('   → Emitting newMessage to receiver socket:', socketId)
          io.to(socketId).emit('newMessage', savedPayload);
        });
        console.log('✅ Sent to receiver:', receiverSocketIds.length, 'socket(s)')
      } else {
        console.log('⚠️ Receiver offline - message saved to DB, will sync when online')
      }

      // Send to sender (for multi-tab/device sync)
      if (senderSocketIds.length > 0) {
        senderSocketIds.forEach(socketId => {
          console.log('   → Emitting newMessage to sender socket:', socketId)
          io.to(socketId).emit('newMessage', savedPayload);
        });
        console.log('✅ Sent to sender:', senderSocketIds.length, 'socket(s)')
      }

      // ✅ Acknowledge to sender
      if (typeof ack === 'function') ack({ ok: true, data: savedPayload });
      console.log('✅ Acknowledgment sent to sender')
    } catch (err) {
      console.error('sendMessage persist error', err)
      if (typeof ack === 'function') ack({ ok: false, message: 'persist error' })
    }
  });

  socket.on("disconnect", () => {
    try { onlineUsers.remove(socket.userId, socket.id); } catch (e) { }
    console.log("User disconnected:", socket.userId, socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
