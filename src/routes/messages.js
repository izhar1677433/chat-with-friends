// routes/messages.js

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth"); // your auth middleware
const User = require("../models/User");
const Message = require("../models/Message");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const name = Date.now() + "-" + Math.round(Math.random() * 1e9) + ext;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB per file
});

// --------------------------
// POST /api/messages/send
// --------------------------
router.post("/send",
  auth,
  // Wrap multer so we can catch multer-specific errors (file size, invalid file) and return clear 4xx responses
  (req, res, next) => {
    // Accept any file field names to be more tolerant of different client field names
    upload.any()(req, res, function (err) {
      if (err) {
        console.error('MULTER ERROR on /api/messages/send:', err)
        // Multer-specific errors should be returned as 400 with message
        return res.status(400).json({ message: 'File upload error', error: err.message });
      }
      // Log received file fieldnames for debugging
      if (Array.isArray(req.files) && req.files.length > 0) {
        console.log('MULTER: received files fields:', req.files.map(f => ({ field: f.fieldname, originalname: f.originalname })))
      }
      next();
    })
  },
  async (req, res) => {
    try {
      // Accept multiple possible body shapes for robustness
      const receiver = req.body.receiver || req.body.to || req.body.receiverId || req.body.toId;
      const text = req.body.text || req.body.message || req.body.content;
      const files = req.files || [];
      console.log('📨 REST /send:', { from: req.user._id, to: receiver, text: text ? text.substring(0, 20) + '...' : null, files: files.length })

      if (!receiver || (!text && files.length === 0)) {
        console.log('❌ REST /send: missing fields')
        return res.status(400).json({ message: "receiver and (text or attachments) are required", received: req.body });
      }

      // Validate: prevent sending to self
      if (String(receiver) === String(req.user._id)) {
        console.log('❌ REST /send: cannot send to self')
        return res.status(400).json({ message: "Cannot send message to yourself" });
      }

      // Find sender (logged-in user)
      const senderUser = await User.findById(req.user._id);
      if (!senderUser) return res.status(404).json({ message: "Sender not found" });

      // Find receiver
      const receiverUser = await User.findById(receiver);
      if (!receiverUser) return res.status(404).json({ message: "Receiver not found" });

      // Map uploaded files to attachment metadata
      const attachments = (req.files || []).map((f) => {
        let kind = "file";
        if (f.mimetype && f.mimetype.startsWith("image/")) kind = "image";
        else if (f.mimetype && f.mimetype.startsWith("video/")) kind = "video";
        return {
          filename: f.filename,
          originalName: f.originalname,
          mimeType: f.mimetype,
          size: f.size,
          url: `/uploads/${f.filename}`,
          type: kind
        };
      });

      // Create message (DB only - we will also emit via Socket.IO so REST clients receive realtime notifications)
      // Ensure `text` is always defined (allow attachment-only messages)
      const message = await Message.create({
        sender: senderUser._id,
        receiver: receiverUser._id,
        text: text || '',
        attachments
      });

      console.log('✅ REST: Message saved to DB:', message._id)

      // Try to emit via Socket.IO so receiver(s) get notified in real-time
      try {
        const io = global.io;
        const onlineUsers = require('../onlineUsers');
        const savedPayload = {
          _id: String(message._id),
          text: message.text,
          sender: String(message.sender),
          receiver: String(message.receiver),
          createdAt: message.timestamp || message.createdAt || new Date().toISOString(),
          attachments: Array.isArray(message.attachments) ? message.attachments : []
        };

        // Emit directly to any known socket ids for the receiver
        const receiverSocketIds = onlineUsers.getSocketIds(String(receiverUser._id)) || [];
        if (receiverSocketIds.length > 0) {
          receiverSocketIds.forEach(sid => {
            try { io.to(sid).emit('newMessage', savedPayload) } catch (e) { /* ignore per-socket errors */ }
          })
          console.log('📤 REST: emitted newMessage to receiver sockets:', receiverSocketIds)
        }

        // Also emit to the receiver's user room (fallback)
        try { io.to(`user:${String(receiverUser._id)}`).emit('newMessage', savedPayload) } catch (e) { }

        // Emit to sender's sockets/room for multi-tab sync
        const senderSocketIds = onlineUsers.getSocketIds(String(senderUser._id)) || [];
        senderSocketIds.forEach(sid => { try { io.to(sid).emit('newMessage', savedPayload) } catch (e) { } });
        try { io.to(`user:${String(senderUser._id)}`).emit('newMessage', savedPayload) } catch (e) { }
      } catch (emitErr) {
        console.error('❌ REST: failed to emit newMessage via Socket.IO:', emitErr)
      }

      return res.json({ message: "Message sent successfully", data: message });
    } catch (err) {
      console.error("Send message error:", err);
      if (err && err.name === 'ValidationError') {
        // Mongoose validation (e.g., required fields)
        return res.status(400).json({ message: 'Validation error', errors: err.errors });
      }
      res.status(500).json({ message: "Server error" });
    }
  }
);

// --------------------------
// GET messages between current user and a specific friend
// --------------------------
router.get("/", auth, async (req, res) => {
  try {
    const { friendId } = req.query;

    if (!friendId) {
      return res.status(400).json({ message: "friendId query parameter required" });
    }

    // Only get messages between current user and the specific friend
    const messages = await Message.find({
      $or: [
        { sender: req.user._id, receiver: friendId },
        { sender: friendId, receiver: req.user._id }
      ]
    }).populate("sender", "name email")
      .populate("receiver", "name email")
      .sort({ timestamp: 1 });

    console.log(`📬 GET messages: user ${req.user._id} ↔ friend ${friendId}, found ${messages.length} messages`);
    res.json({ messages });
  } catch (err) {
    console.error("Get messages error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
