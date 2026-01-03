
const mongoose = require('mongoose');


const auditLogSchema = new mongoose.Schema({
  action: {
    type: String,
    required: true,
    enum: ['CREATE', 'UPDATE', 'DELETE'], 
  },
  user: {
    type: String,
    required: true, 
  },
  details: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now, 
  },
});


const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;  
