const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address']
  },
  password: {
    type: String,
    required: true,
    minlength: 8,
    maxlength: 14,
    validate: {
      validator: function (v) {
        // Must contain at least one uppercase letter, one digit and one symbol
        return /(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>\/?]).+/.test(v);
      },
      message: 'Password must be 8-14 chars and include 1 uppercase, 1 number and 1 symbol'
    }
  },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  // Incoming friend requests (users who sent a request to this user)
  friendRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  // Outgoing friend requests (users this user has sent a request to)
  sentRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);

