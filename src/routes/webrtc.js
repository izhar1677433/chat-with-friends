const express = require('express');
const router = express.Router();

// GET /api/webrtc/config
router.get('/config', (req, res) => {
    try {
        const iceServers = [
            { urls: 'stun:stun.l.google.com:19302' }
        ];

        // Optional TURN server via env (TURN_URL, TURN_USER, TURN_PASS)
        if (process.env.TURN_URL) {
            const turn = { urls: process.env.TURN_URL };
            if (process.env.TURN_USER) turn.username = process.env.TURN_USER;
            if (process.env.TURN_PASS) turn.credential = process.env.TURN_PASS;
            iceServers.push(turn);
        }

        return res.json({ ok: true, iceServers });
    } catch (err) {
        console.error('webrtc config error', err);
        return res.status(500).json({ message: 'server error' });
    }
});

module.exports = router;
