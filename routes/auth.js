const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { authenticate } = require("../middleware/auth");

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '1h';

// REGISTER
router.post("/register", async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: { message: "Username and password are required" } });
  }

  if (password.length < 6) {
    return res.status(400).json({ success: false, error: { message: "Password must be at least 6 characters" } });
  }

  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(409).json({ success: false, error: { message: "Username already exists" } });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = new User({ 
      username, 
      password: hashedPassword,
      role: role || "staff" 
    });
    await user.save();
    res.status(201).json({ success: true, message: "User registered successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: "Registration failed" } });
  }
});

// LOGIN
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: { message: "Username and password are required" } });
  }

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ success: false, error: { code: "USER_NOT_FOUND", message: "Invalid credentials" } });
    }

    if (user.isBlocked) {
      return res.status(403).json({ success: false, error: { code: "ACCOUNT_BLOCKED", message: "Your account has been blocked. Contact administrator." } });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
      await user.save();
      return res.status(401).json({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } });
    }

    // Device detection
    const userAgent = req.headers["user-agent"] || "";
    let deviceType = "Desktop/PC";
    if (/mobile/i.test(userAgent)) deviceType = "Mobile Device";
    else if (/iphone|ipad/i.test(userAgent)) deviceType = "iPhone/iPad";

    user.device = deviceType;
    user.isOnline = true;
    user.lastActive = new Date();
    user.lastLoginAt = new Date();
    user.failedLoginAttempts = 0;
    user.loginCount = (user.loginCount || 0) + 1;
    await user.save();

    const token = jwt.sign(
      { id: user._id, role: user.role }, 
      JWT_SECRET, 
      { expiresIn: JWT_EXPIRY }
    );

    res.json({ 
      success: true, 
      data: { 
        token, 
        username: user.username, 
        role: user.role 
      } 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: "Login failed" } });
  }
});

// LOGOUT
router.post("/logout", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (user) {
      user.isOnline = false;
      user.lastActive = new Date();
      await user.save();
    }
    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: "Logout failed" } });
  }
});

// GET CURRENT USER PROFILE
router.get("/me", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    if (!user) {
      return res.status(404).json({ success: false, error: { message: "User not found" } });
    }
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: "Failed to fetch profile" } });
  }
});

module.exports = router;