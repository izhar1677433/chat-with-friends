const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // MUST MATCH FIELD
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  attachments: [
    {
      filename: { type: String },
      originalName: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      url: { type: String },
      type: { type: String, enum: ["image", "video", "file"], default: "file" }
    }
  ]
});

module.exports = mongoose.model("Message", MessageSchema);
