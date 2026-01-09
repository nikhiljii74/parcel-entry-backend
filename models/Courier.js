const mongoose = require("mongoose");

const courierSchema = new mongoose.Schema({
  date: String,
  from: String,
  to: String,
  company: String,
  location: String, 
  courier: String,
  awb: String,
  invoiceNumber: String,
  content: String,
  delivered: String,
  type: String,

  // ✅ New Fields added for Update
  price: String,   // Booking Amount (e.g. "150")
  weight: String   // Parcel Weight (e.g. "500g")
  

}, { timestamps: true });

module.exports = mongoose.model("Courier", courierSchema);