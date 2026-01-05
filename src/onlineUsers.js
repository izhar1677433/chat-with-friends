const online = new Map();

module.exports = {
  add: (userId, socketId) => online.set(userId.toString(), socketId),
  remove: (userId) => online.delete(userId.toString()),
  getSocketId: (userId) => online.get(userId.toString()),
  isOnline: (userId) => online.has(userId.toString())
};
