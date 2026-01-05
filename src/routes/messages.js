const router = require("express").Router();
const auth = require("../middleware/auth");
const Message = require("../models/Message");
const User = require("../models/User");

router.post("/send", auth, async (req, res) => {
  try {
    const { friendId, message } = req.body;
    if (!friendId || !message) return res.status(400).json({ message: "friendId and message required" });

    const me = await User.findById(req.user.id);
    const friend = await User.findById(friendId);
    if (!friend) return res.status(404).json({ message: "Friend not found" });

    if (!me.friends.some(id => id.equals(friend._id))) return res.status(403).json({ message: "You are not friends" });

    const msg = await Message.create({ sender: me._id, receiver: friend._id, text: message });
    res.json({ message: "Message sent", data: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/:friendId", auth, async (req, res) => {
  try {
    const messages = await Message.find({
      $or: [
        { sender: req.user.id, receiver: req.params.friendId },
        { sender: req.params.friendId, receiver: req.user.id }
      ]
    }).sort({ createdAt: 1 });

    res.json({ messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
