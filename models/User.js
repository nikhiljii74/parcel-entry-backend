const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },
  email: { type: String, unique: true, sparse: true },
  fullName: { type: String },
  role: { type: String, enum: ['admin', 'manager', 'staff', 'viewer'], default: "staff" },
  isBlocked: { type: Boolean, default: false },
  device: { type: String, default: "Unknown" },
  lastActive: { type: Date, default: Date.now },
  isOnline: { type: Boolean, default: false },
  lastLoginAt: { type: Date },
  loginCount: { type: Number, default: 0 },
  failedLoginAttempts: { type: Number, default: 0 }
}, { timestamps: true });

userSchema.index({ role: 1 });
userSchema.index({ isOnline: 1 });
userSchema.index({ isBlocked: 1 });

module.exports = mongoose.model("User", userSchema);