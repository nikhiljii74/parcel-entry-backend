const mongoose = require('mongoose');

// ============================================================
// MASTER DATA MODELS - Sender, PMA, Company, Country, Vendor
// ============================================================

const senderSchema = new mongoose.Schema({
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
  source: { type: String, enum: ['manual', 'auto_populated'], default: 'manual' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

senderSchema.index({ displayName: 'text', company: 'text', email: 'text' });

const pmaSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true,
    lowercase: true
  },
  displayName: { type: String, trim: true },
  code: { type: String, trim: true },
  address: { type: String, trim: true, default: '' },
  country: { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, default: '' },
  contactPerson: { type: String, trim: true },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

const companySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true,
    lowercase: true
  },
  displayName: { type: String, trim: true },
  address: { type: String, trim: true, default: '' },
  country: { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, default: '' },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

const countrySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true,
    lowercase: true
  },
  code: { type: String, trim: true },
  region: { type: String, trim: true },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

const vendorSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true,
    lowercase: true
  },
  displayName: { type: String, trim: true },
  courier: { type: String, trim: true },
  address: { type: String, trim: true, default: '' },
  country: { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, default: '' },
  contactPerson: { type: String, trim: true },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = {
  Sender: mongoose.models.Sender || mongoose.model('Sender', senderSchema),
  PMA: mongoose.models.PMA || mongoose.model('PMA', pmaSchema),
  Company: mongoose.models.Company || mongoose.model('Company', companySchema),
  Country: mongoose.models.Country || mongoose.model('Country', countrySchema),
  Vendor: mongoose.models.Vendor || mongoose.model('Vendor', vendorSchema),
};