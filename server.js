const express = require("express");
const path = require("path");
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
// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'src', 'uploads')));

// Routes
app.use("/api/auth", require("./src/routes/auth"));
app.use("/api/friends", require("./src/routes/friends"));
app.use("/api/messages", require("./src/routes/messages"));
app.use("/api/online", require("./src/routes/onlineRoutes"));
app.use("/api/calls", require("./src/routes/calls"));
app.use("/api/webrtc", require("./src/routes/webrtc"));

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

// Check and auto-fix one-way friendships
app.get('/api/debug/fix-friendships', auth, async (req, res) => {
  try {
    const User = require('./src/models/User');
    const me = await User.findById(req.user._id).populate('friends', 'name email friends');
    const issues = [];
    const fixed = [];

    for (const friend of me.friends) {
      const friendHasMe = friend.friends.some(id => String(id) === String(me._id));
      if (!friendHasMe) {
        issues.push({
          friend: { id: friend._id, name: friend.name },
          problem: `One-way friendship: You have ${friend.name} but they don't have you`
        });
        // Auto-fix: add me to their friends list
        friend.friends.push(me._id);
        await friend.save();
        fixed.push({ friend: friend.name, action: 'Added you to their friends list ✅' });
      }
    }

    return res.json({
      user: { id: me._id, name: me.name, friendsCount: me.friends.length },
      issues: issues.length > 0 ? issues : undefined,
      fixed: fixed.length > 0 ? fixed : undefined,
      message: fixed.length > 0
        ? `✅ Fixed ${fixed.length} one-way friendship(s)! Refresh both clients.`
        : '✅ All friendships are bidirectional!'
    });
  } catch (err) {
    console.error('Fix friendships error:', err);
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

// Helper function to notify friends when a user goes online/offline
async function notifyFriendsOnlineStatus(userId, isOnline) {
  try {
    const User = require('./src/models/User');
    const user = await User.findById(userId).select('friends name');
    console.log(`📡 notifyFriendsOnlineStatus: userId=${userId}, name=${user?.name}, isOnline=${isOnline}, friendsCount=${user?.friends?.length || 0}`);

    if (!user || !user.friends || user.friends.length === 0) {
      console.log(`⚠️ User ${userId} has no friends to notify`);
      return;
    }

    // Emit to each friend's room
    user.friends.forEach(friendId => {
      const friendRoom = `user:${friendId.toString()}`;
      console.log(`  → Emitting friendOnlineStatus to room: ${friendRoom}, payload: { userId: ${userId.toString()}, online: ${isOnline} }`);
      io.to(friendRoom).emit('friendOnlineStatus', {
        userId: userId.toString(),
        online: isOnline
      });
    });

    console.log(`✅ Notified ${user.friends.length} friends that ${user.name} is ${isOnline ? 'online' : 'offline'}`);
  } catch (err) {
    console.error('❌ Error notifying friends online status:', err);
  }
}

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
  console.log(`🔌 New socket connection: ${socket.id}`);

  // If userId was set during handshake, register immediately
  if (socket.userId) {
    try {
      console.log(`✅ Handshake auth successful for userId: ${socket.userId}`);
      onlineUsers.add(socket.userId, socket.id);
      socket.join(`user:${socket.userId}`);
      console.log(`✅ Socket ${socket.id} joined room: user:${socket.userId}`);

      // Single broadcast after registration (notifyFriendsOnlineStatus will be called by user-online event)
      io.emit('online-users', Object.keys(onlineUsers.list()));
      console.log('📢 Broadcasted online users to all clients');
    } catch (e) { console.error('❌ Error in handshake registration:', e) }
  } else {
    console.log(`⏳ Socket ${socket.id} connected without userId, waiting for register event`)
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
        // Join user-specific room for targeted events
        socket.join(`user:${socket.userId}`);
        console.log('✅ User joined room: user:' + socket.userId);
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
      socket.join(`user:${userId}`);
      console.log('✅ User joined room: user:' + userId);

      console.log('register: socket registered', socket.id, 'userId:', userId)
      socket.emit('registered')
      // Note: user-online event will handle the broadcast
    } catch (err) {
      console.error('register handler error', err && err.message)
    }
  })

  // Explicit user-online event (single source of truth for broadcasts)
  socket.on('user-online', (userId) => {
    if (!userId) return console.log('⚠️ user-online: no userId provided');

    const uid = String(userId);
    console.log(`📢 user-online event received: userId=${uid}, socketId=${socket.id}`);

    // If socket doesn't have userId yet, set it now
    if (!socket.userId) {
      socket.userId = uid;
      socket.join(`user:${uid}`);
      console.log(`✅ Socket ${socket.id} set userId via user-online: ${uid}`);
    }

    // Ensure user is in online users map
    onlineUsers.add(uid, socket.id);

    // Wait a bit to avoid race conditions with disconnect events
    setTimeout(() => {
      // Notify friends and broadcast (single authoritative broadcast)
      notifyFriendsOnlineStatus(uid, true);
      io.emit('online-users', Object.keys(onlineUsers.list()));
      console.log('📢 Broadcasted online users:', Object.keys(onlineUsers.list()));
    }, 100);
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

      // Fallback: emit to receiver's user room to ensure delivery even if map is stale
      try {
        const roomName = `user:${String(to)}`;
        console.log('   → Emitting newMessage to receiver room:', roomName)
        io.to(roomName).emit('newMessage', savedPayload);
      } catch (e) { console.error('room emit to receiver failed', e) }

      // Send to sender (for multi-tab/device sync)
      if (senderSocketIds.length > 0) {
        senderSocketIds.forEach(socketId => {
          console.log('   → Emitting newMessage to sender socket:', socketId)
          io.to(socketId).emit('newMessage', savedPayload);
        });
        console.log('✅ Sent to sender:', senderSocketIds.length, 'socket(s)')
      }

      // Also emit to sender's user room as extra redundancy
      try {
        const senderRoom = `user:${String(socket.userId)}`;
        io.to(senderRoom).emit('newMessage', savedPayload);
      } catch (e) { console.error('room emit to sender failed', e) }

      // ✅ Acknowledge to sender
      if (typeof ack === 'function') ack({ ok: true, data: savedPayload });
      console.log('✅ Acknowledgment sent to sender')
    } catch (err) {
      console.error('sendMessage persist error', err)
      if (typeof ack === 'function') ack({ ok: false, message: 'persist error' })
    }
  });

  // --------------------------
  // Voice call (WebRTC) signaling
  // --------------------------
  // Client -> server: 'call-user' { to: <userId>, offer, metadata }
  // Server -> target: 'incoming-call' { from, offer, metadata }
  socket.on('call-user', (payload, ack) => {
    try {
      console.log('call-user event received from socket:', socket.id, 'userId:', socket.userId, 'payload keys:', Object.keys(payload || {}));
      const to = payload && (payload.to || payload.userId || payload.target);
      const offer = payload && payload.offer;
      const metadata = payload && payload.metadata;
      if (!to) {
        console.log('call-user: missing target in payload');
        return typeof ack === 'function' ? ack({ ok: false, message: 'missing target' }) : null;
      }

      const targets = onlineUsers.getSocketIds(String(to)) || [];
      console.log('call-user: resolved targets for', to, targets);
      if (targets.length === 0) {
        console.log('call-user: target is offline or has no sockets:', to);
        if (typeof ack === 'function') ack({ ok: false, message: 'user offline' });
        return;
      }

      targets.forEach(tid => {
        try {
          io.to(tid).emit('incoming-call', { from: String(socket.userId || null), offer, metadata });
          console.log('call-user: emitted incoming-call to socket', tid);
        } catch (e) { console.error('incoming-call emit error', e) }
      });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      console.error('call-user handler error', err);
      if (typeof ack === 'function') ack({ ok: false, message: 'server error' });
    }
  });

  // Alias handlers to support different client event names
  const handleCallOffer = (payload, ack) => {
    try {
      // Reuse same semantics as 'call-user'
      const to = payload && (payload.to || payload.userId || payload.target || payload.receiver);
      const offer = payload && (payload.offer || payload.sdp || payload.description);
      const metadata = payload && payload.metadata;
      if (!to) return typeof ack === 'function' ? ack({ ok: false, message: 'missing target' }) : null;

      const targets = onlineUsers.getSocketIds(String(to)) || [];
      if (targets.length === 0) {
        if (typeof ack === 'function') ack({ ok: false, message: 'user offline' });
        console.log(`call-offer: target ${to} offline`);
        return;
      }

      targets.forEach(tid => {
        try {
          io.to(tid).emit('incoming-call', { from: String(socket.userId || null), offer, metadata });
        } catch (e) { console.error('incoming-call emit error (alias)', e) }
      });
      if (typeof ack === 'function') ack({ ok: true });
      console.log(`call-offer: forwarded offer from ${socket.userId} to ${to} sockets:`, targets);
    } catch (err) {
      console.error('call-offer handler error', err);
      if (typeof ack === 'function') ack({ ok: false, message: 'server error' });
    }
  };

  socket.on('call-offer', handleCallOffer);
  socket.on('offer', handleCallOffer);
  socket.on('call', handleCallOffer);

  // Client -> server: 'answer-call' { to: <userId>, answer }
  // Server -> target: 'call-accepted' { from, answer }
  socket.on('answer-call', (payload, ack) => {
    try {
      const to = payload && (payload.to || payload.userId || payload.target);
      const answer = payload && payload.answer;
      if (!to) return typeof ack === 'function' ? ack({ ok: false, message: 'missing target' }) : null;

      const targets = onlineUsers.getSocketIds(String(to)) || [];
      targets.forEach(tid => {
        try { io.to(tid).emit('call-accepted', { from: String(socket.userId || null), answer }); } catch (e) { console.error('call-accepted emit error', e) }
      });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      console.error('answer-call handler error', err);
      if (typeof ack === 'function') ack({ ok: false, message: 'server error' });
    }
  });

  // Client -> server: 'ice-candidate' { to: <userId>, candidate }
  // Server -> target: 'ice-candidate' { from, candidate }
  socket.on('ice-candidate', (payload) => {
    try {
      const to = payload && (payload.to || payload.userId || payload.target);
      const candidate = payload && payload.candidate;
      if (!to || !candidate) return;
      const targets = onlineUsers.getSocketIds(String(to)) || [];
      targets.forEach(tid => {
        try { io.to(tid).emit('ice-candidate', { from: String(socket.userId || null), candidate }); } catch (e) { console.error('ice-candidate emit error', e) }
      });
    } catch (err) { console.error('ice-candidate handler error', err) }
  });

  // Client -> server: 'end-call' { to: <userId>, reason }
  // Server -> target: 'call-ended' { from, reason }
  socket.on('end-call', (payload) => {
    try {
      const to = payload && (payload.to || payload.userId || payload.target);
      const reason = payload && payload.reason;
      if (!to) return;
      const targets = onlineUsers.getSocketIds(String(to)) || [];
      targets.forEach(tid => {
        try { io.to(tid).emit('call-ended', { from: String(socket.userId || null), reason }); } catch (e) { console.error('call-ended emit error', e) }
      });
    } catch (err) { console.error('end-call handler error', err) }
  });

  // --------------------------
  // Audio stream relay (simple Socket.IO binary relay)
  // Note: This relays audio data via Socket.IO and is NOT a production SFU/TURN solution.
  // Clients should send small binary chunks (ArrayBuffer/Buffer) in 'audio-chunk' events.
  // --------------------------
  socket.on('start-audio-stream', (payload, ack) => {
    try {
      const to = payload && (payload.to || payload.target || payload.userId);
      const metadata = payload && payload.metadata;
      if (!to) return typeof ack === 'function' ? ack({ ok: false, message: 'missing target' }) : null;

      const targets = onlineUsers.getSocketIds(String(to)) || [];
      const fromId = String(socket.userId || null);
      targets.forEach(tid => {
        try { io.to(tid).emit('start-audio-stream', { from: fromId, metadata }); } catch (e) { console.error('start-audio-stream emit error', e) }
      });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      console.error('start-audio-stream handler error', err);
      if (typeof ack === 'function') ack({ ok: false, message: 'server error' });
    }
  });

  // payload: { to, chunk }
  socket.on('audio-chunk', (payload) => {
    try {
      const to = payload && (payload.to || payload.target || payload.userId);
      const chunk = payload && payload.chunk;
      if (!to || !chunk) return;
      const targets = onlineUsers.getSocketIds(String(to)) || [];
      const fromId = String(socket.userId || null);
      targets.forEach(tid => {
        try { io.to(tid).emit('audio-chunk', { from: fromId, chunk }); } catch (e) { console.error('audio-chunk emit error', e) }
      });
    } catch (err) { console.error('audio-chunk handler error', err) }
  });

  socket.on('stop-audio-stream', (payload) => {
    try {
      const to = payload && (payload.to || payload.target || payload.userId);
      const reason = payload && payload.reason;
      if (!to) return;
      const targets = onlineUsers.getSocketIds(String(to)) || [];
      const fromId = String(socket.userId || null);
      targets.forEach(tid => {
        try { io.to(tid).emit('stop-audio-stream', { from: fromId, reason }); } catch (e) { console.error('stop-audio-stream emit error', e) }
      });
    } catch (err) { console.error('stop-audio-stream handler error', err) }
  });

  socket.on("disconnect", () => {
    const userId = socket.userId;
    try { onlineUsers.remove(socket.userId, socket.id); } catch (e) { }
    console.log("User disconnected:", socket.userId, socket.id);

    // Notify all friends that this user is now offline (only if no other sockets)
    if (userId && !onlineUsers.isOnline(userId)) {
      notifyFriendsOnlineStatus(userId, false);

      // Broadcast updated online users list to ALL clients
      io.emit('online-users', Object.keys(onlineUsers.list()));
      console.log('📢 Broadcasted online users to all clients (user offline)');
    }
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
