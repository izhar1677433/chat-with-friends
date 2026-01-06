const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  // Incoming friend requests (users who sent a request to this user)
  friendRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  // Outgoing friend requests (users this user has sent a request to)
  sentRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);
