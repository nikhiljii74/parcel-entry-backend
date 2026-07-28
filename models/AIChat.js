const mongoose = require("mongoose");

const aiChatSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sessionId: { type: String, required: true, index: true },
  title: { type: String, default: 'New Chat' },
  pinned: { type: Boolean, default: false },
  messages: [{
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
  }],
}, { timestamps: true });

aiChatSchema.index({ userId: 1, updatedAt: -1 });

module.exports = mongoose.model("AIChat", aiChatSchema);