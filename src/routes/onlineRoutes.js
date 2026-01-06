const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const User = require("../models/User");
const online = require("../onlineUsers");

// Get online status of all friends
router.get("/friends-status", auth, async (req, res) => {
  try {
    const friendsIds = req.user.friends || []; // friends array in user document

    const friendsStatus = await Promise.all(
      friendsIds.map(async (friendId) => {
        const user = await User.findById(friendId).select("name email");
        return {
          id: friendId,
          username: user?.name || "Unknown",
          email: user?.email || "Unknown",
          online: online.isOnline(friendId),
        };
      })
    );

    res.status(200).json({ friends: friendsStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;
