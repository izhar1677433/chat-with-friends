const mongoose = require("mongoose");

const connectDB = async () => {
  const uri =
    process.env.MONGO_URI ||
    "mongodb+srv://izhar1677433:izhar1677433@cluster0.bwoaftn.mongodb.net/";
  await mongoose.connect(uri);
  console.log("MongoDB connected");
};

module.exports = connectDB;
