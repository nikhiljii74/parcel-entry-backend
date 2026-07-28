const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");
const { authenticate } = require("../middleware/auth");

// GET notifications for current user
router.get("/", authenticate, async (req, res) => {
  try {
    const { limit = 50, unreadOnly } = req.query;
    const query = { userId: req.user._id };
    if (unreadOnly === 'true') query.read = false;

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    const unreadCount = await Notification.countDocuments({ userId: req.user._id, read: false });

    res.json({ success: true, data: notifications, unreadCount });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to fetch notifications" } });
  }
});

// MARK as read
router.post("/mark-read", authenticate, async (req, res) => {
  try {
    const { ids } = req.body;
    const query = { userId: req.user._id };
    if (Array.isArray(ids) && ids.length > 0) query._id = { $in: ids };

    await Notification.updateMany(query, { $set: { read: true } });
    res.json({ success: true, message: "Notifications marked as read" });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to mark notifications" } });
  }
});

module.exports = router;