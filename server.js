const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const auth = require("./src/middleware/auth");
const onlineUsers = require("./src/onlineUsers");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", require("./src/routes/auth"));
app.use("/api/friends", require("./src/routes/friends"));
app.use("/api/messages", require("./src/routes/messages"));

// MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log(err));

// Socket.IO
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("No token"));
  try {
    const jwt = require("jsonwebtoken");
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret123");
    socket.userId = decoded.id;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  onlineUsers.add(socket.userId, socket.id);
  console.log("User online:", socket.userId);

  socket.on("sendMessage", ({ to, text }) => {
    const receiverSocketId = onlineUsers.getSocketId(to);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("receiveMessage", {
        from: socket.userId,
        text,
      });
    }
  });

  socket.on("disconnect", () => {
    onlineUsers.remove(socket.userId);
    console.log("User disconnected:", socket.userId);
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
