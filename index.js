const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// --- SECURITY MIDDLEWARE ---
app.use(helmet());

// CORS - Restricted origins
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:5173', 'http://localhost:3000'];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
  maxAge: 86400
}));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { success: false, error: { message: 'Too many requests, please try again later.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: { message: 'Too many login attempts, please try again later.' } },
});

app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);

// Body parsing with size limit
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// --- ROUTES IMPORT ---
const courierRoutes = require('./routes/courierRoutes');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const auditLogRoutes = require('./routes/auditLog');
const analyticsRoutes = require('./routes/analytics');
const aiRoutes = require('./routes/ai');
const notificationRoutes = require('./routes/notifications');
const settingsRoutes = require('./routes/settings');
const misRoutes = require('./routes/mis');
const biRoutes = require('./routes/bi');
const bulkCorrectionRoutes = require('./routes/bulkCorrection');
const masterDataRoutes = require('./routes/masterData');
const exportEngineRoutes = require('./routes/exportEngine');
const buyerRoutes = require('./routes/buyers');
const receiverRoutes = require('./routes/receivers');

// --- API ENDPOINTS ---
app.use('/api/couriers', courierRoutes);
app.use('/api/buyers', buyerRoutes);
app.use('/api/receivers', receiverRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/audit-logs', auditLogRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/mis', misRoutes);
app.use('/api/bi', biRoutes);
app.use('/api/bulk', bulkCorrectionRoutes);
app.use('/api/master', masterDataRoutes);
app.use('/api/export', exportEngineRoutes);

// Health check (lightweight)
app.get('/api/health', async (_req, res) => {
  try {
    const dbState = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    res.json({
      success: true,
      data: {
        server: 'running',
        database: dbState,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, data: { server: 'running', database: 'error' } });
  }
});

// Root
app.get('/', (_req, res) => {
  res.json({ 
    success: true, 
    message: 'Premier Asia Courier Management API', 
    version: '2.0.0',
    status: 'operational' 
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, error: { message: 'Route not found' } });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Server Error:', err.message);
  res.status(err.status || 500).json({ 
    success: false, 
    error: { 
      message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error' 
    } 
  });
});

// --- MONGODB CONNECTION ---
mongoose
  .connect(process.env.MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(() => {
    console.log('MongoDB connected successfully');
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });

module.exports = app;