// friends.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const User = require("../models/User");
const onlineUsers = require("../onlineUsers");

// Send friend request (creates a pending request instead of instant friendship)
router.post("/add", auth, async (req, res) => {
  try {
    const { friendId, friendEmail } = req.body;

    if (!friendId && !friendEmail)
      return res.status(400).json({ message: "friendId or friendEmail required" });

    const me = await User.findById(req.user._id);
    if (!me) return res.status(401).json({ message: "Unauthorized - user not found" });

    let friend;
    if (friendId) friend = await User.findById(friendId);
    else friend = await User.findOne({ email: friendEmail });

    if (!friend) return res.status(404).json({ message: "User not found" });
    if (friend._id.toString() === me._id.toString())
      return res.status(400).json({ message: "You cannot add yourself" });

    // Already friends?
    if (me.friends.some(id => id.toString() === friend._id.toString()))
      return res.status(400).json({ message: "Already friends" });

    // Already sent a request?
    if (me.sentRequests && me.sentRequests.some(id => id.toString() === friend._id.toString()))
      return res.status(400).json({ message: "Friend request already sent" });

    // If the friend already sent you a request, accept it automatically
    if (me.friendRequests && me.friendRequests.some(id => id.toString() === friend._id.toString())) {
      // Accept mutual
      me.friends.push(friend._id);
      friend.friends.push(me._id);

      // remove pending entries
      me.friendRequests = me.friendRequests.filter(id => id.toString() !== friend._id.toString());
      friend.sentRequests = (friend.sentRequests || []).filter(id => id.toString() !== me._id.toString());

      await me.save();
      await friend.save();

      // notify friend via their user room so all sockets receive it
      const room = `user:${friend._id.toString()}`;
      const acceptSocks = onlineUsers.getSocketIds(friend._id);
      console.log('Auto-accept notify target (room):', room, 'socketIds:', acceptSocks)
      if (global.io) {
        // emit to room
        global.io.to(room).emit('friendAccepted', { from: me._id.toString(), name: me.name });
        // also emit to individual sockets as a fallback
        acceptSocks.forEach(sid => {
          try { global.io.to(sid).emit('friendAccepted', { from: me._id.toString(), name: me.name }) } catch (e) { console.error('emit to sock failed', sid, e) }
        })
      }

      return res.json({ message: 'Friend request accepted automatically', friend: { id: friend._id, name: friend.name, email: friend.email } });
    }

    // Add to friend's incoming requests and to my sentRequests
    friend.friendRequests = Array.isArray(friend.friendRequests) ? friend.friendRequests : [];
    me.sentRequests = Array.isArray(me.sentRequests) ? me.sentRequests : [];

    friend.friendRequests.push(me._id);
    me.sentRequests.push(friend._id);

    await friend.save();
    await me.save();

    // notify friend via their user room so all sockets receive it
    const room = `user:${friend._id.toString()}`;
    const socks = onlineUsers.getSocketIds(friend._id) || [];
    // get actual room members from Socket.IO adapter for extra visibility
    let roomMembers = [];
    try { const r = global.io && global.io.of && global.io.of('/').adapter.rooms.get(room); roomMembers = r ? Array.from(r) : [] } catch (e) { roomMembers = [] }
    console.log('Friend request: target room:', room, 'roomMembers:', roomMembers, 'knownSocketIds:', socks)
    if (global.io) {
      // prefer room emit (reaches all sockets that joined the user room)
      global.io.to(room).emit('friendRequest', { from: me._id.toString(), name: me.name, email: me.email });
      // fallback: also emit to any socket ids we track in-memory
      if (Array.isArray(socks) && socks.length) {
        socks.forEach(sid => {
          if (!sid) return;
          try { global.io.to(sid).emit('friendRequest', { from: me._id.toString(), name: me.name, email: me.email }) } catch (e) { console.error('emit to sock failed', sid, e) }
        })
      }
    }

    res.json({ message: "Friend request sent", friend: { id: friend._id, name: friend.name, email: friend.email } });
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

// Search users (for adding friends)
router.post("/search", auth, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ message: "Search query required" });

    const me = await User.findById(req.user._id);
    if (!me) return res.status(401).json({ message: "Unauthorized" });

    // Search by name or email (case-insensitive)
    const users = await User.find({
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { email: { $regex: query, $options: 'i' } }
      ],
      _id: { $ne: me._id } // Exclude current user
    }).select('name email').limit(10);

    // Include relationship status flags for the client to render appropriately
    const usersWithStatus = users.map(user => {
      const isFriend = me.friends.some(friendId => friendId.toString() === user._id.toString());
      const isRequested = (me.sentRequests || []).some(id => id.toString() === user._id.toString());
      const incoming = (me.friendRequests || []).some(id => id.toString() === user._id.toString());
      return {
        id: user._id,
        name: user.name,
        email: user.email,
        isFriend,
        isRequested,
        incoming,
        online: onlineUsers.isOnline(user._id),
      };
    });

    res.json({ users: usersWithStatus });
  } catch (err) {
    console.error("Search users error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get incoming friend requests for current user
router.get('/requests', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user._id).populate('friendRequests', 'name email');
    if (!me) return res.status(401).json({ message: 'Unauthorized' });
    const requests = (me.friendRequests || []).map(u => ({ id: u._id, name: u.name, email: u.email }));
    res.json({ requests });
  } catch (err) {
    console.error('Get requests error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Respond to a friend request (accept or reject)
router.post('/requests/respond', auth, async (req, res) => {
  try {
    console.log('Respond request body:', req.body)
    // Accept multiple possible field names / shapes from client
    let requesterId = req.body && (req.body.requesterId || req.body.requester || req.body.id || req.body.requester_id || req.body.from);
    let action = req.body && (req.body.action || (req.body.accept ? 'accept' : (req.body.reject ? 'reject' : undefined)));
    // If client sent { accept: true } or { reject: true }
    if (typeof action === 'boolean') action = action ? 'accept' : 'reject';
    requesterId = requesterId ? String(requesterId) : requesterId;
    if (!requesterId || !['accept', 'reject'].includes(action)) return res.status(400).json({ message: 'Invalid parameters', received: req.body });

    const me = await User.findById(req.user._id);
    const requester = await User.findById(requesterId);
    if (!me || !requester) return res.status(404).json({ message: 'User not found' });

    // Ensure there is actually a request
    if (!me.friendRequests || !me.friendRequests.some(id => String(id) === String(requesterId))) {
      return res.status(400).json({ message: 'No such friend request' });
    }

    // Remove pending entries
    me.friendRequests = (me.friendRequests || []).filter(id => String(id) !== String(requesterId));
    requester.sentRequests = (requester.sentRequests || []).filter(id => String(id) !== String(me._id));

    if (action === 'accept') {
      // Add to friends mutually
      me.friends = me.friends || [];
      requester.friends = requester.friends || [];
      if (!me.friends.some(id => id.toString() === requesterId)) me.friends.push(requester._id);
      if (!requester.friends.some(id => id.toString() === me._id.toString())) requester.friends.push(me._id);

      await me.save();
      await requester.save();

      // notify requester via their room
      const requesterRoom = `user:${requester._id.toString()}`;
      const myRoom = `user:${me._id.toString()}`;
      const requesterSocks = onlineUsers.getSocketIds(requester._id) || [];
      const mySocks = onlineUsers.getSocketIds(me._id) || [];
      // also inspect adapter room members for debugging
      let reqRoomMembers = [], myRoomMembers = [];
      try { const r1 = global.io && global.io.of && global.io.of('/').adapter.rooms.get(requesterRoom); reqRoomMembers = r1 ? Array.from(r1) : [] } catch (e) { reqRoomMembers = [] }
      try { const r2 = global.io && global.io.of && global.io.of('/').adapter.rooms.get(myRoom); myRoomMembers = r2 ? Array.from(r2) : [] } catch (e) { myRoomMembers = [] }
      console.log('Accept notify rooms:', requesterRoom, myRoom, 'requesterRoomMembers:', reqRoomMembers, 'myRoomMembers:', myRoomMembers, 'requesterSocks:', requesterSocks, 'mySocks:', mySocks)
      if (global.io) {
        // emit to rooms
        global.io.to(requesterRoom).emit('friendAccepted', { from: me._id.toString(), name: me.name })
        global.io.to(myRoom).emit('friendAccepted', { from: requester._id.toString(), name: requester.name })
        global.io.to(requesterRoom).emit('friendsUpdated')
        global.io.to(myRoom).emit('friendsUpdated')
        // fallback per-socket emits
        if (Array.isArray(requesterSocks) && requesterSocks.length) requesterSocks.forEach(sid => { if (!sid) return; try { global.io.to(sid).emit('friendAccepted', { from: me._id.toString(), name: me.name }); global.io.to(sid).emit('friendsUpdated') } catch (e) { console.error(e) } })
        if (Array.isArray(mySocks) && mySocks.length) mySocks.forEach(sid => { if (!sid) return; try { global.io.to(sid).emit('friendAccepted', { from: requester._id.toString(), name: requester.name }); global.io.to(sid).emit('friendsUpdated') } catch (e) { console.error(e) } })
      }

      return res.json({ message: 'Friend request accepted' });
    } else {
      // reject: just save the removals
      await me.save();
      await requester.save();
      const requesterRoom = `user:${requester._id.toString()}`;
      const requesterSocks = onlineUsers.getSocketIds(requester._id) || [];
      let reqRoomMembers2 = [];
      try { const r3 = global.io && global.io.of && global.io.of('/').adapter.rooms.get(requesterRoom); reqRoomMembers2 = r3 ? Array.from(r3) : [] } catch (e) { reqRoomMembers2 = [] }
      console.log('Reject notify:', requesterRoom, 'requesterRoomMembers:', reqRoomMembers2, 'sockets:', requesterSocks)
      if (global.io) {
        global.io.to(requesterRoom).emit('friendRejected', { from: me._id.toString(), name: me.name });
        if (Array.isArray(requesterSocks) && requesterSocks.length) requesterSocks.forEach(sid => { if (!sid) return; try { global.io.to(sid).emit('friendRejected', { from: me._id.toString(), name: me.name }) } catch (e) { console.error(e) } })
      }
      return res.json({ message: 'Friend request rejected' });
    }
  } catch (err) {
    console.error('Respond request error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Search user by ID
router.get("/user/:userId", auth, async (req, res) => {
  try {
    const { userId } = req.params;

    // Validate MongoDB ObjectId format
    if (!userId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: "Invalid user ID format" });
    }

    const user = await User.findById(userId).select('name email');

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const me = await User.findById(req.user._id);
    const isFriend = me.friends.some(friendId => friendId.toString() === userId);

    res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isFriend: isFriend,
        online: onlineUsers.isOnline(user._id)
      }
    });
  } catch (err) {
    console.error("Search user by ID error:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// ✅ GET single friend by ID (from friends list only)
router.get("/:id", auth, async (req, res) => {
  try {
    const friendId = req.params.id;

    // Validate Mongo ID
    if (!friendId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: "Invalid friend ID" });
    }

    const friend = await User.findById(friendId).select("name email");
    if (!friend) return res.status(404).json({ message: "Friend not found" });

    // Check if this friend is actually in your friends list
    const me = await User.findById(req.user._id);
    if (!me.friends.some(id => id.toString() === friend._id.toString())) {
      return res.status(403).json({ message: "This user is not your friend" });
    }

    res.json({
      id: friend._id,
      name: friend.name,
      email: friend.email,
      online: onlineUsers.isOnline(friend._id)
    });
  } catch (err) {
    console.error("Get friend error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
