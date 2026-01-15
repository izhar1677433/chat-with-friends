const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const onlineUsers = require('../onlineUsers');

module.exports = function (app, io) {
    app.use(cors());
    app.use(express.json());
    app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

    // Register existing routes
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/friends', require('../routes/friends'));
    app.use('/api/messages', require('../routes/messages'));
    app.use('/api/online', require('../routes/onlineRoutes'));
    try { app.use('/api/webrtc', require('../routes/webrtc')); } catch (e) { /* optional */ }

    // Debug route: dump online users mapping (protected)
    app.get('/api/debug/online', auth, (req, res) => {
        try {
            return res.json({ online: onlineUsers.list() });
        } catch (err) {
            console.error('Debug online error:', err);
            return res.status(500).json({ message: 'Server error' });
        }
    });

    // Helper: notify friends of online status
    async function notifyFriendsOnlineStatus(userId, isOnline) {
        try {
            const User = require('../models/User');
            const user = await User.findById(userId).select('friends name');
            if (!user || !user.friends || user.friends.length === 0) return;
            user.friends.forEach(friendId => {
                const friendRoom = `user:${friendId.toString()}`;
                io.to(friendRoom).emit('friendOnlineStatus', { userId: userId.toString(), online: isOnline });
            });
        } catch (err) {
            console.error('Error notifying friends online status:', err);
        }
    }

    // MongoDB connect (best-effort)
    if (process.env.MONGO_URI) {
        mongoose.connect(process.env.MONGO_URI).then(() => console.log('MongoDB connected (appController)')).catch(err => console.log('MongoDB connection error', err));
    }

    const rooms = new Map();

    io.use((socket, next) => {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (token) {
            try {
                const jwt = require('jsonwebtoken');
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret123');
                socket.userId = decoded.id || decoded._id || null;
            } catch (err) { /* allow unauthenticated connections */ }
        }
        next();
    });

    io.on('connection', (socket) => {
        console.log('Socket connected', socket.id, 'userId=', socket.userId);

        if (socket.userId) {
            onlineUsers.add(socket.userId, socket.id);
            socket.join(`user:${socket.userId}`);
            io.emit('online-users', Object.keys(onlineUsers.list()));
        }

        socket.on('register', (payload) => {
            try {
                const jwt = require('jsonwebtoken');
                if (!payload || !payload.token) {
                    const uid = payload && payload.userId;
                    if (!uid) return;
                    socket.userId = String(uid);
                    onlineUsers.add(socket.userId, socket.id);
                    socket.join(`user:${socket.userId}`);
                    socket.emit('registered');
                    return;
                }
                const decoded = jwt.verify(payload.token, process.env.JWT_SECRET || 'secret123');
                const userId = (decoded && (decoded.id || decoded._id)) ? String(decoded.id || decoded._id) : null;
                if (!userId) return;
                socket.userId = userId;
                onlineUsers.add(userId, socket.id);
                socket.join(`user:${userId}`);
                socket.emit('registered');
            } catch (err) {
                console.error('register error', err && err.message);
            }
        });

        socket.on('user-online', (userId) => {
            if (!userId) return;
            const uid = String(userId);
            if (!socket.userId) {
                socket.userId = uid;
                socket.join(`user:${uid}`);
            }
            onlineUsers.add(uid, socket.id);
            setTimeout(() => {
                notifyFriendsOnlineStatus(uid, true);
                io.emit('online-users', Object.keys(onlineUsers.list()));
            }, 100);
        });

        // Existing offer/answer/ice handlers
        socket.on('offer', ({ roomId, to, sdp }) => {
            if (roomId) { socket.to(roomId).emit('offer', { from: socket.userId || socket.id, sdp }); return; }
            if (!to) return;
            const targets = onlineUsers.getSocketIds(String(to)) || [];
            targets.forEach(tid => io.to(tid).emit('offer', { from: socket.userId || socket.id, sdp }));
        });

        socket.on('answer', ({ roomId, to, sdp }) => {
            if (roomId) { socket.to(roomId).emit('answer', { from: socket.userId || socket.id, sdp }); return; }
            if (!to) return;
            const targets = onlineUsers.getSocketIds(String(to)) || [];
            targets.forEach(tid => io.to(tid).emit('answer', { from: socket.userId || socket.id, sdp }));
        });

        socket.on('ice-candidate', ({ roomId, to, candidate }) => {
            if (roomId) { socket.to(roomId).emit('ice-candidate', { from: socket.userId || socket.id, candidate }); return; }
            if (!to) return;
            const targets = onlineUsers.getSocketIds(String(to)) || [];
            targets.forEach(tid => io.to(tid).emit('ice-candidate', { from: socket.userId || socket.id, candidate }));
        });

        // New: handle 'webrtc-offer' event (for clients that use this event name)
        socket.on('webrtc-offer', async (data, callback) => {
            try {
                console.log('📞 webrtc-offer received:', {
                    from: data && data.from,
                    to: data && data.to,
                    type: data && data.type
                });

                const to = data && (data.to || data.target);
                if (!to) {
                    if (typeof callback === 'function') callback({ success: false, error: 'missing recipient' });
                    return;
                }

                // Prefer a single socket id; fallback to array
                const receiverSocketId = onlineUsers.getSocketId ? onlineUsers.getSocketId(String(to)) : (onlineUsers.getSocketIds(String(to)) || [])[0];

                if (receiverSocketId) {
                    io.to(receiverSocketId).emit('webrtc-offer', {
                        from: data.from || socket.userId || socket.id,
                        to: String(to),
                        type: data.type,
                        sdp: data.sdp,
                        timestamp: new Date()
                    });

                    if (typeof callback === 'function') callback({ success: true, message: 'Offer forwarded' });
                } else {
                    if (typeof callback === 'function') callback({ success: false, error: 'User offline' });
                }
            } catch (err) {
                console.error('webrtc-offer handler error', err);
                if (typeof callback === 'function') callback({ success: false, error: 'server error' });
            }
        });

        // Voice handlers
        socket.on('start-voice-call', ({ to, roomId, metadata }, ack) => {
            try {
                if (!to && !roomId) return ack && ack({ ok: false, message: 'missing target' });
                if (roomId) { io.to(String(roomId)).emit('start-voice-call', { from: socket.userId || socket.id, metadata }); return ack && ack({ ok: true }); }
                const targets = onlineUsers.getSocketIds(String(to)) || [];
                if (targets.length === 0) return ack && ack({ ok: false, message: 'user offline' });
                targets.forEach(tid => io.to(tid).emit('start-voice-call', { from: socket.userId || socket.id, metadata }));
                return ack && ack({ ok: true });
            } catch (err) { console.error('start-voice-call error', err); return ack && ack({ ok: false, message: 'server error' }); }
        });

        socket.on('voice-chunk', ({ to, roomId, chunk }) => {
            try {
                if (!chunk) return;
                if (roomId) { socket.to(String(roomId)).emit('voice-chunk', { from: socket.userId || socket.id, chunk }); return; }
                const targets = onlineUsers.getSocketIds(String(to)) || [];
                targets.forEach(tid => io.to(tid).emit('voice-chunk', { from: socket.userId || socket.id, chunk }));
            } catch (err) { console.error('voice-chunk error', err); }
        });

        socket.on('stop-voice-call', ({ to, roomId, reason }) => {
            try {
                if (!to && !roomId) return;
                if (roomId) { io.to(String(roomId)).emit('stop-voice-call', { from: socket.userId || socket.id, reason }); return; }
                const targets = onlineUsers.getSocketIds(String(to)) || [];
                targets.forEach(tid => io.to(tid).emit('stop-voice-call', { from: socket.userId || socket.id, reason }));
            } catch (err) { console.error('stop-voice-call error', err); }
        });

        socket.on('sendMessage', async (payload, ack) => {
            const to = payload && (payload.to || payload.receiver || payload.toId || payload.receiverId || payload.receiver_id);
            const text = payload && (payload.text || payload.message || payload.content);
            const clientTempId = payload && (payload.clientTempId || payload._id || payload.tempId);
            if (!to) return ack && ack({ ok: false, message: 'missing recipient' });
            if (!text) return ack && ack({ ok: false, message: 'missing text' });
            if (String(to) === String(socket.userId)) return ack && ack({ ok: false, message: 'cannot send to self' });

            const isBot = String(to) === 'bot' || (typeof text === 'string' && text.trim().startsWith('/bot'));
            if (isBot) {
                const reply = `Bot: I received your message: "${String(text).replace('/bot', '').trim()}"`;
                io.to(socket.id).emit('receiveMessage', { from: 'bot', text: reply });
                return ack && ack({ ok: true, data: { _id: Date.now().toString(), text: reply, sender: 'bot' } });
            }

            try {
                const Message = require('../models/Message');
                const saved = await Message.create({ sender: socket.userId, receiver: to, text });
                const savedPayload = {
                    _id: String(saved._id),
                    text: saved.text,
                    sender: String(saved.sender),
                    receiver: String(saved.receiver),
                    createdAt: saved.timestamp || saved.createdAt || new Date().toISOString(),
                    clientTempId: clientTempId || undefined,
                };

                const receiverSocketIds = onlineUsers.getSocketIds(String(to)) || [];
                const senderSocketIds = onlineUsers.getSocketIds(String(socket.userId)) || [];

                if (receiverSocketIds.length > 0) receiverSocketIds.forEach(sid => io.to(sid).emit('newMessage', savedPayload));
                io.to(`user:${String(to)}`).emit('newMessage', savedPayload);
                if (senderSocketIds.length > 0) senderSocketIds.forEach(sid => io.to(sid).emit('newMessage', savedPayload));
                io.to(`user:${String(socket.userId)}`).emit('newMessage', savedPayload);

                return ack && ack({ ok: true, data: savedPayload });
            } catch (err) {
                console.error('sendMessage persist error', err);
                return ack && ack({ ok: false, message: 'persist error' });
            }
        });

        socket.on('disconnect', () => {
            const userId = socket.userId;
            try { onlineUsers.remove(socket.userId, socket.id); } catch (e) { }
            if (userId && !onlineUsers.isOnline(userId)) {
                notifyFriendsOnlineStatus(userId, false);
                io.emit('online-users', Object.keys(onlineUsers.list()));
            }

            for (const [roomId, room] of rooms.entries()) {
                if (room.users && room.users.delete && socket.userId) {
                    room.users.delete(socket.userId);
                    io.to(roomId).emit('room-users', Array.from(room.users));
                    if (room.users.size === 0) rooms.delete(roomId);
                }
            }
        });
    });
};
