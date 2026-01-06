// routes/messages.js

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth"); // your auth middleware
const User = require("../models/User");
const Message = require("../models/Message");

// --------------------------
// POST /api/messages/send
// --------------------------
router.post("/send", auth, async (req, res) => {
  try {
    // Accept multiple possible body shapes for robustness
    const receiver = req.body.receiver || req.body.to || req.body.receiverId || req.body.toId;
    const text = req.body.text || req.body.message || req.body.content;
    console.log('📨 REST /send:', { from: req.user._id, to: receiver, text: text?.substring(0, 20) + '...' })

    if (!receiver || !text) {
      console.log('❌ REST /send: missing fields')
      return res.status(400).json({ message: "receiver and text are required", received: req.body });
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

    // Create message (DB only - Socket.IO handles real-time emit)
    const message = await Message.create({
      sender: senderUser._id,
      receiver: receiverUser._id,
      text
    });

    console.log('✅ REST: Message saved to DB:', message._id, '- Socket.IO will handle real-time emit')
    res.json({ message: "Message sent successfully", data: message });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

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
