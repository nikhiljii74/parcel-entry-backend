// 📁 models/Courier.js
const mongoose = require("mongoose");

const courierSchema = new mongoose.Schema({
  date: String,
  to: String,
  company: String,
  courier: String,
  awb: String,
  content: String,
  delivered: String,  // delivered date
  type: String        // Incoming / Outgoing
});

module.exports = mongoose.model("Courier", courierSchema);
