const mongoose = require("mongoose");

const courierSchema = new mongoose.Schema({
  date: String,
  from: String,
  to: String,
  company: String,
  
  location: String,   // ✅ Ye line add karni thi bas
  
  courier: String,
  awb: String,
  invoiceNumber: String,
  content: String,
  delivered: String,
  type: String
}, { timestamps: true }); // (Optional: timestamps se createdAt automatic mil jata hai)

module.exports = mongoose.model("Courier", courierSchema);