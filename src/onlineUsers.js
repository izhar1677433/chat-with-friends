const online = new Map();

module.exports = {
  // Add a socket id for a user (support multiple connections per user)
  add: (userId, socketId) => {
    if (!userId) return;
    const key = String(userId);
    const set = online.get(key) || new Set();
    set.add(socketId);
    online.set(key, set);
  },
  // Remove a specific socket id for a user; if no socketId provided remove all
  remove: (userId, socketId) => {
    if (!userId) return;
    const key = String(userId);
    if (!socketId) return online.delete(key);
    const set = online.get(key);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) online.delete(key);
    else online.set(key, set);
  },
  // Get all socket ids for a user (array)
  getSocketIds: (userId) => {
    if (!userId) return [];
    const set = online.get(String(userId));
    return set ? Array.from(set) : [];
  },
  // Backwards-compat: return first socket id or undefined
  getSocketId: (userId) => {
    const ids = module.exports.getSocketIds(userId);
    return ids.length ? ids[0] : undefined;
  },
  isOnline: (userId) => {
    if (!userId) return false;
    return online.has(String(userId));
  }
  ,
  // Return a plain object snapshot of the online map for debugging
  list: () => {
    const obj = {};
    for (const [k, set] of online.entries()) {
      obj[k] = Array.from(set);
    }
    return obj;
  }
};
