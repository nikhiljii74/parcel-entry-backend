const mongoose = require('mongoose');

const receiverSchema = new mongoose.Schema({
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

receiverSchema.index({ displayName: 'text', company: 'text', email: 'text' });

module.exports = mongoose.model('Receiver', receiverSchema);