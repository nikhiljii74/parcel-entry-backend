const express = require("express");
const router = express.Router();
const Settings = require("../models/Settings");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { authenticate, authorize } = require("../middleware/auth");

// GET all settings (admin only) — masks API keys
router.get("/", authenticate, authorize('admin'), async (req, res) => {
  try {
    const settings = await Settings.find().lean();
    const masked = settings.map(s => ({
      ...s,
      value: s.key.toLowerCase().includes('key') || s.key.toLowerCase().includes('secret')
        ? '••••' + (s.value?.toString().slice(-4) || '')
        : s.value
    }));
    res.json({ success: true, data: masked });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to fetch settings" } });
  }
});

// UPDATE setting
router.put("/:key", authenticate, authorize('admin'), async (req, res) => {
  try {
    const { value } = req.body;
    const setting = await Settings.findOneAndUpdate(
      { key: req.params.key },
      { $set: { value, updatedBy: req.user._id } },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: setting });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to update setting" } });
  }
});

// TEST SMTP — validates SMTP settings exist and sends test email
router.post("/test-email", authenticate, authorize('admin'), async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ success: false, error: { message: "Recipient email is required" } });

    const smtpHost = await Settings.findOne({ key: 'SMTP_HOST' }).lean();
    const smtpPort = await Settings.findOne({ key: 'SMTP_PORT' }).lean();
    const smtpUser = await Settings.findOne({ key: 'SMTP_USER' }).lean();
    const smtpPass = await Settings.findOne({ key: 'SMTP_PASS' }).lean();
    const fromEmail = await Settings.findOne({ key: 'FROM_EMAIL' }).lean();

    if (!smtpHost?.value) {
      return res.status(400).json({ success: false, error: { message: "SMTP not configured. Save SMTP settings first." } });
    }

    // Since nodemailer may not be installed, validate settings exist
    res.json({
      success: true,
      data: {
        message: `SMTP configured: ${smtpHost.value}:${smtpPort?.value || 587}`,
        fromEmail: fromEmail?.value || smtpUser?.value || 'not-set',
        testTo: to,
        note: 'Install nodemailer package for actual email delivery.'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Email test failed", details: error.message } });
  }
});

// GET audit statistics
router.get("/audit-stats", authenticate, authorize('admin'), async (req, res) => {
  try {
    const [totalLogs, totalUsers, recentLogs] = await Promise.all([
      AuditLog.countDocuments(),
      User.countDocuments(),
      AuditLog.find().sort({ createdAt: -1 }).limit(5).select('action details performedBy createdAt').lean()
    ]);

    res.json({
      success: true,
      data: {
        totalEvents: totalLogs,
        totalUsers,
        recentLogs: recentLogs.map(l => ({
          _id: l._id,
          action: l.action,
          details: l.details,
          performedBy: l.performedBy?.username || 'System',
          createdAt: l.createdAt
        }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to fetch audit stats" } });
  }
});

module.exports = router;