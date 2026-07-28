const express = require("express");
const router = express.Router();
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { authenticate, authorize } = require("../middleware/auth");

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

// Middleware: Verify Token & Check Admin
const verifyAdmin = async (req, res, next) => {
  const token = req.header("Authorization");
  if (!token) return res.status(401).json({ success: false, error: { code: 'NO_TOKEN', message: "Access Denied" } });

  try {
    const verified = jwt.verify(token.replace('Bearer ', ''), JWT_SECRET);
    const user = await User.findById(verified.id);
    
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: "User not found" } });
    }

    // ENFORCE ADMIN ROLE CHECK
    if (user.role !== 'admin' && user.username !== 'admin') { 
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: "Admin access required" } });
    }
    
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: "Invalid Token" } });
  }
};

// 1. GET ALL USERS (Admin only)
router.get("/users", verifyAdmin, async (req, res) => {
  try {
    const users = await User.find({}, "-password");
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: "Failed to fetch users" } });
  }
});

// 2. TOGGLE BLOCK STATUS (Admin only)
router.post("/toggle-block", verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);
    
    if (!user) return res.status(404).json({ success: false, error: { message: "User not found" } });

    if (user.username === 'admin') {
      return res.status(403).json({ success: false, error: { message: "Cannot block Super Admin" } });
    }

    user.isBlocked = !user.isBlocked;
    if (user.isBlocked) user.isOnline = false;
    
    await user.save();
    res.json({ success: true, message: "User status updated", data: { isBlocked: user.isBlocked } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: "Failed to update status" } });
  }
});

module.exports = router;