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

      // Basic validation (robust): ensure either trimmed text or at least one uploaded file
      const hasText = typeof text === 'string' && String(text).trim().length > 0;
      const hasFiles = Array.isArray(files) && files.length > 0;
      if (!receiver || (!hasText && !hasFiles)) {
        console.log('❌ REST /send: missing fields', { receiver, hasText, files: files.length });
        return res.status(400).json({
          message: "receiver and (text or attachments) are required",
          received: { body: req.body, files: (req.files || []).map(f => f.fieldname) }
        });
      }

      // Validate receiver is a valid ObjectId to avoid Mongoose CastError
      const mongoose = require('mongoose');
      if (!mongoose.Types.ObjectId.isValid(String(receiver))) {
        console.log('❌ REST /send: invalid receiver id', receiver)
        return res.status(400).json({ message: 'Invalid receiver id' });
      }

      // Validate: prevent sending to self
      if (String(receiver) === String(req.user._id)) {
        console.log('❌ REST /send: cannot send to self')
        return res.status(400).json({ message: "Cannot send message to yourself" });
      }

      // Find sender (logged-in user)
      let senderUser = null
      try { senderUser = await User.findById(req.user._id) } catch (e) { console.error('DB error finding sender', e); return res.status(500).json({ message: 'Server error finding sender' }) }
      if (!senderUser) return res.status(404).json({ message: "Sender not found" });

      // Find receiver
      let receiverUser = null
      try { receiverUser = await User.findById(receiver) } catch (e) { console.error('DB error finding receiver', e); return res.status(500).json({ message: 'Server error finding receiver' }) }
      if (!receiverUser) return res.status(404).json({ message: "Receiver not found" });

      // Map uploaded files to attachment metadata
      let attachments = []
      try {
        attachments = (req.files || []).map((f) => {
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
        })
      } catch (e) {
        console.error('Error processing uploaded files', e)
        return res.status(500).json({ message: 'Error processing uploaded files' })
      }

      // Create message (DB only - we will also emit via Socket.IO so REST clients receive realtime notifications)
      // Use trimmed text and existing `attachments` array
      let message = null
      try {
        const hasText = typeof text === "string" && text.trim().length > 0;
        const hasFiles = attachments && attachments.length > 0;
        if (!hasText && !hasFiles) {
          return res.status(400).json({ message: "text ya attachment lazmi hai" });
        }

        // Build payload using model-ready values (senderUser._id and receiverUser._id are ObjectIds)
        const createPayload = {
          sender: senderUser._id,
          receiver: receiverUser._id,
          attachments
        };
        if (hasText) createPayload.text = String(text).trim();

        // Insert into DB
        message = await Message.create(createPayload);
        console.log('✅ REST: Message saved to DB:', message._id)
      } catch (e) {
        console.error('❌ REST: failed to create message', e)
        if (e && e.name === 'ValidationError') {
          const errors = {}
          Object.keys(e.errors || {}).forEach(k => {
            const it = e.errors[k]
            errors[k] = {
              message: it.message,
              kind: it.kind,
              path: it.path,
              value: it.value
            }
          })
          console.error('Validation errors:', errors)
          return res.status(400).json({ message: 'Validation error', errors })
        }
        return res.status(500).json({ message: 'Server error creating message', error: e && e.message ? e.message : String(e) })
      }

      // Try to emit via Socket.IO so receiver(s) get notified in real-time
      try {
        const io = global.io;
        const onlineUsers = require('../onlineUsers');
        const clientTempId = req.body.clientTempId || req.body.client_temp_id || req.body.tempId || undefined;
        const savedPayload = {
          _id: String(message._id),
          clientTempId: clientTempId,
          sender: String(message.sender),
          receiver: String(message.receiver),
          createdAt: message.timestamp || message.createdAt || new Date().toISOString(),
          attachments: Array.isArray(message.attachments) ? message.attachments : []
        };
        // Only include `text` in payload when it's non-empty so clients treat it as optional




        if (message.text && String(message.text).trim().length > 0) savedPayload.text = message.text;

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

      // Include clientTempId in response data so client can reconcile optimistic message
      const respData = (message && message.toObject) ? message.toObject() : message;
      // Remove empty text so client treats text as optional
      if (respData && (!respData.text || String(respData.text).trim() === '')) delete respData.text;
      if (respData) respData.clientTempId = clientTempId;
      return res.json({ message: "Message sent successfully", data: respData });
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
