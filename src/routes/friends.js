const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const User = require("../models/User");
const onlineUsers = require("../onlineUsers");

// Add friend
router.post("/add", auth, async (req, res) => {
  try {
    const { friendEmail } = req.body;
    if (!friendEmail) return res.status(400).json({ message: "friendEmail required" });

    const email = friendEmail.trim().toLowerCase();
    const me = await User.findById(req.user.id);
    if (me.email === email) return res.status(400).json({ message: "Cannot add yourself" });

    const friend = await User.findOne({ email });
    if (!friend) return res.status(404).json({ message: "Friend not found" });

    if (me.friends.some(id => id.equals(friend._id))) return res.status(400).json({ message: "Already friends" });

    me.friends.push(friend._id);
    friend.friends.push(me._id);
    await me.save();
    await friend.save();

    res.json({ message: "Friend added" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// Get friends list
router.get("/", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id).populate("friends", "name email");
    const friends = me.friends.map(f => ({
      id: f._id,
      name: f.name,
      email: f.email,
      online: onlineUsers.isOnline(f._id)
    }));
    res.json({ friends });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
