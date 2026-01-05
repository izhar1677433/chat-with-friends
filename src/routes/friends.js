// friends.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const User = require("../models/User");
const onlineUsers = require("../onlineUsers");

// Add friend
router.post("/add", auth, async (req, res) => {
  try {
    console.log("REQ.USER:", req.user); // 🔍 debug
    const { friendEmail } = req.body;
    if (!friendEmail)
      return res.status(400).json({ message: "friendEmail required" });

    const me = await User.findById(req.user._id);
    if (!me) return res.status(401).json({ message: "Unauthorized - user not found" });

    const friend = await User.findOne({ email: friendEmail });
    if (!friend) return res.status(404).json({ message: "User not found" });

    if (friend._id.toString() === me._id.toString())
      return res.status(400).json({ message: "You cannot add yourself" });

    if (me.friends.some(id => id.toString() === friend._id.toString()))
      return res.status(400).json({ message: "Already friends" });

    me.friends.push(friend._id);
    friend.friends.push(me._id);

    await me.save();
    await friend.save();

    res.json({
      message: "Friend added successfully",
      friend: {
        id: friend._id,
        name: friend.name,
        email: friend.email,
      },
    });
  } catch (err) {
    console.error("Add friend error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get friends list
router.get("/", auth, async (req, res) => {
  try {
    console.log("REQ.USER:", req.user); // 🔍 debug
    const me = await User.findById(req.user._id).populate(
      "friends",
      "name email"
    );

    if (!me) return res.status(401).json({ message: "Unauthorized - user not found" });

    const friends = me.friends.map(f => ({
      id: f._id,
      name: f.name,
      email: f.email,
      online: onlineUsers.isOnline(f._id),
    }));

    res.json({ friends });
  } catch (err) {
    console.error("Get friends error:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// ✅ GET single friend by ID
router.get("/:id", auth, async (req, res) => {
  try {
    const friendId = req.params.id;

    // Validate Mongo ID
    if (!friendId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: "Invalid friend ID" });
    }

    const friend = await User.findById(friendId).select("name email");
    if (!friend) return res.status(404).json({ message: "Friend not found" });

    // Optional: check if this friend is actually in your friends list
    const me = await User.findById(req.user._id);
    if (!me.friends.includes(friend._id)) {
      return res.status(403).json({ message: "This user is not your friend" });
    }

    res.json({
      id: friend._id,
      name: friend.name,
      email: friend.email,
      online: onlineUsers.isOnline(friend._id)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// friends.js  (add this route anywhere before module.exports)

// GET /api/friends/search/:name  – search friends by name (case-insensitive)
// GET single friend by ID
router.get("/:id", auth, async (req, res) => {
  try {
    const friendId = req.params.id;
    if (!friendId.match(/^[0-9a-fA-F]{24}$/))
      return res.status(400).json({ message: "Invalid friend ID" });

    const friend = await User.findById(friendId).select("name email");
    if (!friend) return res.status(404).json({ message: "Friend not found" });

    const me = await User.findById(req.user._id);
    if (!me.friends.includes(friend._id))
      return res.status(403).json({ message: "This user is not your friend" });

    res.json({
      id: friend._id,
      name: friend.name,
      email: friend.email,
      online: onlineUsers.isOnline(friend._id),
    });
  } catch (err) {
    console.error("Get single friend error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
