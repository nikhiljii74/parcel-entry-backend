const mongoose = require('mongoose');

const buyerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true,
    lowercase: true
  },
  displayName: { type: String, trim: true },
  company: { type: String, trim: true, default: '' },
  address: { type: String, trim: true, default: '' },
  country: { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, default: '' },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// Compound index for case-insensitive search
buyerSchema.index({ displayName: 'text', company: 'text', email: 'text' });

module.exports = mongoose.model('Buyer', buyerSchema);