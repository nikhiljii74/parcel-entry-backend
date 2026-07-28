const mongoose = require("mongoose");

const courierSchema = new mongoose.Schema({
  date: { type: String, index: true },
  from: { type: String, index: true },
  to: { type: String, index: true },
  company: { type: String, index: true },
  location: { type: String },
  courier: { type: String, index: true },
  awb: { type: String, index: true },
  invoiceNumber: { type: String },
  content: { type: String },
  delivered: { type: String },
  type: { type: String, enum: ['Incoming', 'Outgoing'], index: true },
  price: { type: String },
  weight: { type: String },
  status: { type: String, enum: ['CREATED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'CANCELLED'], default: 'CREATED', index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isArchived: { type: Boolean, default: false, index: true },
  archivedAt: { type: Date }
}, { timestamps: true });

// Compound Indexes for common queries
courierSchema.index({ date: -1, courier: 1 });
courierSchema.index({ date: -1, company: 1 });
courierSchema.index({ courier: 1, status: 1 });
courierSchema.index({ type: 1, status: 1 });
courierSchema.index({ createdBy: 1, createdAt: -1 });
courierSchema.index({ isArchived: 1, createdAt: -1 });

// Text index for search
courierSchema.index({ 
  company: 'text', 
  courier: 'text', 
  awb: 'text', 
  from: 'text', 
  to: 'text', 
  location: 'text', 
  content: 'text' 
});

module.exports = mongoose.model("Courier", courierSchema);