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
    const { receiver, text } = req.body; // Must match schema

    if (!receiver || !text) {
      return res.status(400).json({ message: "receiver and text are required" });
    }

    // Find sender (logged-in user)
    const senderUser = await User.findById(req.user._id);
    if (!senderUser) return res.status(404).json({ message: "Sender not found" });

    // Find receiver
    const receiverUser = await User.findById(receiver);
    if (!receiverUser) return res.status(404).json({ message: "Receiver not found" });

    // Create message
    const message = await Message.create({
      sender: senderUser._id,
      receiver: receiverUser._id,
      text
    });

    res.json({ message: "Message sent successfully", data: message });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// --------------------------
// Optional: GET messages for a user
// --------------------------
router.get("/", auth, async (req, res) => {
  try {
    const messages = await Message.find({
      $or: [
        { sender: req.user._id },
        { receiver: req.user._id }
      ]
    }).populate("sender", "name email")
      .populate("receiver", "name email")
      .sort({ timestamp: 1 });

    res.json({ messages });
  } catch (err) {
    console.error("Get messages error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
