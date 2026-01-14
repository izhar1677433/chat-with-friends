const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const callManager = require('../callManager');

// Helper to get io and onlineUsers
function getIo() {
    return global.io;
}
function getOnlineUsers() {
    return require('../onlineUsers');
}

// POST /api/calls/start
// Body: { to: <userId>, metadata?: {...} }
router.post('/start', auth, async (req, res) => {
    try {
        const from = req.user && req.user._id;
        const to = req.body.to || req.body.target;
        const metadata = req.body.metadata || {};
        if (!to) return res.status(400).json({ message: 'missing target' });
        if (String(to) === String(from)) return res.status(400).json({ message: 'cannot call yourself' });

        const call = await callManager.createCall({ from, to, metadata });

        // Emit incoming-call via Socket.IO to target sockets (if online)
        try {
            const onlineUsers = getOnlineUsers();
            const targets = onlineUsers.getSocketIds(String(to)) || [];
            const io = getIo();
            if (targets.length > 0 && io) {
                targets.forEach(tid => {
                    try { io.to(tid).emit('incoming-call', { callId: call.id, from: String(from), metadata }); } catch (e) { }
                });
            }
        } catch (e) { console.error('emit incoming-call error', e) }

        return res.status(201).json({ ok: true, call });
    } catch (err) {
        console.error('start call error', err);
        return res.status(500).json({ message: 'server error' });
    }
});

// POST /api/calls/:id/accept
router.post('/:id/accept', auth, async (req, res) => {
    try {
        const id = req.params.id;
        const userId = String(req.user && req.user._id);
        const call = callManager.getCall(id);
        if (!call) return res.status(404).json({ message: 'call not found' });
        // Only callee may accept
        if (String(call.to) !== String(userId)) return res.status(403).json({ message: 'not allowed' });

        const updated = await callManager.acceptCall(id);

        // Notify initiator sockets
        try {
            const onlineUsers = getOnlineUsers();
            const io = getIo();
            const targets = onlineUsers.getSocketIds(String(call.from)) || [];
            targets.forEach(tid => {
                try { io.to(tid).emit('call-accepted', { callId: id, from: userId }); } catch (e) { }
            });
        } catch (e) { console.error('emit call-accepted error', e) }

        return res.json({ ok: true, call: updated });
    } catch (err) {
        console.error('accept call error', err);
        return res.status(500).json({ message: 'server error' });
    }
});

// POST /api/calls/:id/end
router.post('/:id/end', auth, async (req, res) => {
    try {
        const id = req.params.id;
        const userId = String(req.user && req.user._id);
        const reason = req.body.reason || req.query.reason || 'ended by user';
        const call = callManager.getCall(id);
        if (!call) return res.status(404).json({ message: 'call not found' });
        // Only participants can end
        if (String(call.from) !== userId && String(call.to) !== userId) return res.status(403).json({ message: 'not allowed' });

        const ended = await callManager.endCall(id, reason);

        // Notify the other participant
        try {
            const onlineUsers = getOnlineUsers();
            const io = getIo();
            const other = String(call.from) === userId ? call.to : call.from;
            const targets = onlineUsers.getSocketIds(String(other)) || [];
            targets.forEach(tid => {
                try { io.to(tid).emit('call-ended', { callId: id, from: userId, reason }); } catch (e) { }
            });
        } catch (e) { console.error('emit call-ended error', e) }

        return res.json({ ok: true, call: ended });
    } catch (err) {
        console.error('end call error', err);
        return res.status(500).json({ message: 'server error' });
    }
});

// GET /api/calls/:id
router.get('/:id', auth, (req, res) => {
    try {
        const id = req.params.id;
        const call = callManager.getCall(id);
        if (!call) return res.status(404).json({ message: 'call not found' });
        return res.json({ ok: true, call });
    } catch (err) {
        console.error('get call error', err);
        return res.status(500).json({ message: 'server error' });
    }
});

// GET /api/calls (list for current user)
router.get('/', auth, (req, res) => {
    try {
        const userId = String(req.user && req.user._id);
        const list = callManager.listCallsForUser(userId);
        return res.json({ ok: true, calls: list });
    } catch (err) {
        console.error('list calls error', err);
        return res.status(500).json({ message: 'server error' });
    }
});

module.exports = router;
