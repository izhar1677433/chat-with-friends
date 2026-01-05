// authMiddleware.js
const jwt = require("jsonwebtoken");

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    console.log("AUTH HEADER:", authHeader); // 🔍 debug

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized - missing token" });
    }

    const token = authHeader.split(" ")[1];
    console.log("TOKEN:", token); // 🔍 debug

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("DECODED:", decoded); // 🔍 debug

    const userId = decoded.id || decoded._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized - invalid token" });

    req.user = { _id: userId };
    next();
  } catch (err) {
    console.error("AUTH ERROR 👉", err.message);
    return res.status(401).json({ message: "Unauthorized - token error" });
  }
};
