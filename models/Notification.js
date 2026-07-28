const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  type: {
    type: String,
    enum: ['shipment_created', 'shipment_updated', 'shipment_delivered', 'shipment_delayed', 'duplicate_awb', 'pending_alert', 'missing_data', 'system_alert', 'database_alert', 'ai_insight'],
    required: true
  },
  title: { type: String, required: true },
  message: { type: String, required: true },
  severity: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
  read: { type: Boolean, default: false, index: true },
  link: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);