
const express = require('express');
const router = express.Router();
const AuditLog = require('../models/AuditLog');

router.get("/", async (req, res) => {
  try {
    const logs = await AuditLog.find().sort({ createdAt: -1 }); 
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch audit logs", error });
  }
});

module.exports = router;  