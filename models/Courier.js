const mongoose = require("mongoose");

const courierSchema = new mongoose.Schema({
  date: String,
  from: String,       // ✅ From (sender/recipient)
  to: String,
  company: String,
  courier: String,
  awb: String,
  invoiceNumber: String,  // ✅ New field added here
  content: String,
  delivered: String,  // Delivered date
  type: String        // Incoming / Outgoing
});

module.exports = mongoose.model("Courier", courierSchema);
