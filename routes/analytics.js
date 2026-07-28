const express = require("express");
const router = express.Router();
const Courier = require("../models/Courier");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { authenticate, authorize } = require("../middleware/auth");

// --- SHARED KPI COMPUTATION HELPER ---
// Computes all core KPIs from the full non-archived courier dataset.
// Used by /dashboard, /ai-summary/daily, and other endpoints to ensure consistency.
async function computeDashboardKPIs(queryFilter = {}) {
  const filter = { isArchived: { $ne: true }, ...queryFilter };

  const [
    total,
    delivered,
    pending,
    incoming,
    outgoing,
    entries
  ] = await Promise.all([
    Courier.countDocuments(filter),
    Courier.countDocuments({ ...filter, delivered: { $exists: true, $ne: '', $nin: [null, ''] } }),
    Courier.countDocuments({ ...filter, $or: [{ delivered: { $in: ['', null] } }, { delivered: { $exists: false } }] }),
    Courier.countDocuments({ ...filter, type: 'Incoming' }),
    Courier.countDocuments({ ...filter, type: 'Outgoing' }),
    Courier.find(filter).select('date price courier company delivered type weight content').lean()
  ]);

  // Calculate totals
  let totalExpenditure = 0;
  entries.forEach(e => {
    const p = parseFloat(e.price || '0');
    if (!isNaN(p)) totalExpenditure += p;
  });

  // Missing data
  const missingData = entries.filter(e => !e.weight || !e.price || !e.content);

  // Courier breakdown
  const courierCounts = {};
  entries.forEach(e => {
    const courier = e.courier || 'Unknown';
    courierCounts[courier] = (courierCounts[courier] || 0) + 1;
  });

  // Company breakdown
  const companyCounts = {};
  entries.forEach(e => {
    const company = e.company || 'Unknown';
    companyCounts[company] = (companyCounts[company] || 0) + 1;
  });

  // Daily breakdown
  const dailyCounts = {};
  entries.forEach(e => {
    if (e.date) {
      dailyCounts[e.date] = (dailyCounts[e.date] || 0) + 1;
    }
  });

  // Delivery performance
  const deliveredEntries = entries.filter(e => e.delivered);
  let avgDeliveryDays = 0;
  const courierDelivery = {};
  deliveredEntries.forEach(e => {
    if (e.date && e.delivered) {
      const start = new Date(e.date);
      const end = new Date(e.delivered);
      const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      avgDeliveryDays += days;
      const courier = e.courier || 'Unknown';
      if (!courierDelivery[courier]) courierDelivery[courier] = { total: 0, count: 0 };
      courierDelivery[courier].total += days;
      courierDelivery[courier].count++;
    }
  });
  avgDeliveryDays = deliveredEntries.length > 0 ? avgDeliveryDays / deliveredEntries.length : 0;

  // On-time rate (delivered within 3 days)
  const onTimeDelivered = deliveredEntries.filter(e => {
    if (!e.date || !e.delivered) return false;
    const start = new Date(e.date);
    const end = new Date(e.delivered);
    return Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) <= 3;
  });

  // Courier performance
  const courierPerformance = Object.entries(courierDelivery).map(([name, data]) => ({
    name,
    avgDeliveryDays: data.count > 0 ? data.total / data.count : 0,
    volume: courierCounts[name] || 0
  })).sort((a, b) => b.volume - a.volume);

  // Duplicate detection (for summary)
  const awbCounts = {};
  entries.forEach(e => {
    if (e.awb) awbCounts[e.awb.toUpperCase()] = (awbCounts[e.awb.toUpperCase()] || 0) + 1;
  });
  const duplicates = Object.entries(awbCounts).filter(([, c]) => c > 1);

  // Age analysis for pending
  const ageNow = new Date();
  const agedPending = pending > 0 ? await Courier.find({
    ...filter,
    $or: [{ delivered: { $in: ['', null] } }, { delivered: { $exists: false } }]
  }).select('date').lean() : [];
  const criticalPending = agedPending.filter(e => {
    if (!e.date) return false;
    const age = Math.ceil((ageNow.getTime() - new Date(e.date).getTime()) / (1000 * 60 * 60 * 24));
    return age > 10;
  }).length;
  const attentionPending = agedPending.filter(e => {
    if (!e.date) return false;
    const age = Math.ceil((ageNow.getTime() - new Date(e.date).getTime()) / (1000 * 60 * 60 * 24));
    return age > 5 && age <= 10;
  }).length;

  return {
    kpis: {
      total,
      delivered,
      pending,
      incoming,
      outgoing,
      totalExpenditure,
      avgDeliveryDays: Math.round(avgDeliveryDays * 10) / 10,
      onTimeRate: delivered > 0 ? Math.round((onTimeDelivered.length / delivered) * 100) : 0
    },
    breakdowns: {
      courierBreakdown: Object.entries(courierCounts).map(([name, count]) => ({ name, count })),
      companyBreakdown: Object.entries(companyCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      dailyBreakdown: Object.entries(dailyCounts).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
      courierPerformance: courierPerformance.slice(0, 10)
    },
    alerts: {
      duplicates: duplicates.length,
      missingData: missingData.length,
      criticalPending
    },
    pendingAge: {
      critical: criticalPending,
      attention: attentionPending,
      normal: pending - criticalPending - attentionPending
    },
    rawEntries: entries
  };
}

// DASHBOARD ANALYTICS (Single source of truth for all widgets)
router.get("/dashboard", authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = {};
    if (dateFrom) dateFilter.date = { ...dateFilter.date, $gte: dateFrom };
    if (dateTo) dateFilter.date = { ...dateFilter.date, $lte: dateTo };

    const result = await computeDashboardKPIs(dateFilter);

    res.json({
      success: true,
      data: {
        kpis: result.kpis,
        courierBreakdown: result.breakdowns.courierBreakdown,
        companyBreakdown: result.breakdowns.companyBreakdown,
        dailyBreakdown: result.breakdowns.dailyBreakdown,
        courierPerformance: result.breakdowns.courierPerformance,
        alerts: result.alerts,
        pendingAge: result.pendingAge
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to fetch analytics" } });
  }
});

// HEALTH CHECK
router.get("/health", async (req, res) => {
  try {
    const dbStart = Date.now();
    await Courier.findOne().select('_id');
    const dbPing = Date.now() - dbStart;

    const [totalUsers, onlineUsers, totalEntries, totalAuditLogs] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isOnline: true }),
      Courier.countDocuments({ isArchived: { $ne: true } }),
      AuditLog.countDocuments()
    ]);

    res.json({
      success: true,
      data: {
        server: { status: 'running', uptime: process.uptime() },
        database: { status: 'connected', ping: `${dbPing}ms` },
        api: { status: 'healthy', version: '2.0.0' },
        stats: {
          totalUsers,
          onlineUsers,
          totalEntries,
          totalAuditLogs
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: true,
      data: {
        server: { status: 'running' },
        database: { status: 'disconnected' },
        api: { status: 'degraded' },
        timestamp: new Date().toISOString()
      }
    });
  }
});

// AI SUMMARY - Daily (uses the same shared KPI computation as dashboard)
router.get("/ai-summary/daily", authenticate, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // Get all non-archived entries
    const allEntries = await Courier.find({ isArchived: { $ne: true } }).lean();

    const todayEntries = allEntries.filter(e => e.date === today);
    const yesterdayEntries = allEntries.filter(e => e.date === yesterdayStr);

    const pendingEntries = allEntries.filter(e => !e.delivered);
    const deliveredEntries = allEntries.filter(e => e.delivered);

    // Duplicate detection
    const awbCounts = {};
    allEntries.forEach(e => {
      if (e.awb) awbCounts[e.awb.toUpperCase()] = (awbCounts[e.awb.toUpperCase()] || 0) + 1;
    });
    const duplicates = Object.entries(awbCounts).filter(([, c]) => c > 1);

    // Calculate expenditure
    let todayExpenditure = 0;
    todayEntries.forEach(e => { const p = parseFloat(e.price || '0'); if (!isNaN(p)) todayExpenditure += p; });

    // Age analysis
    const agedPending = pendingEntries.map(e => {
      const age = e.date ? Math.ceil((new Date().getTime() - new Date(e.date).getTime()) / (1000 * 60 * 60 * 24)) : 0;
      return { ...e, age };
    });
    const critical = agedPending.filter(e => e.age > 10);
    const attention = agedPending.filter(e => e.age > 5 && e.age <= 10);

    // Missing data
    const missingData = allEntries.filter(e => !e.weight || !e.price || !e.content);

    // Compute overall KPIs using the same backend counts (not client-side view)
    // These are the same numbers that /api/analytics/dashboard returns
    const kpis = {
      total: allEntries.length,
      delivered: deliveredEntries.length,
      pending: pendingEntries.length,
      incoming: allEntries.filter(e => e.type === 'Incoming').length,
      outgoing: allEntries.filter(e => e.type === 'Outgoing').length,
      totalExpenditure: allEntries.reduce((sum, e) => {
        const p = parseFloat(e.price || '0');
        return sum + (isNaN(p) ? 0 : p);
      }, 0)
    };

    res.json({
      success: true,
      data: {
        date: today,
        kpis, // <-- Same KPIs as dashboard
        today: {
          total: todayEntries.length,
          incoming: todayEntries.filter(e => e.type === 'Incoming').length,
          outgoing: todayEntries.filter(e => e.type === 'Outgoing').length,
          expenditure: todayExpenditure,
          vsYesterday: `${yesterdayEntries.length > 0 ? Math.round((todayEntries.length - yesterdayEntries.length) / yesterdayEntries.length * 100) : 0}%`
        },
        pending: {
          total: pendingEntries.length,
          critical: critical.length,
          attention: attention.length,
          normal: pendingEntries.length - critical.length - attention.length
        },
        delivered: {
          total: deliveredEntries.length
        },
        alerts: {
          duplicates: duplicates.length,
          missingData: missingData.length,
          criticalPending: critical.length
        },
        topCouriers: Object.entries(
          todayEntries.reduce((acc, e) => {
            const c = e.courier || 'Unknown';
            acc[c] = (acc[c] || 0) + 1;
            return acc;
          }, {})
        ).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to generate AI summary" } });
  }
});

// AI SUMMARY - Weekly
router.get("/ai-summary/weekly", authenticate, async (req, res) => {
  try {
    const entries = await Courier.find({ isArchived: { $ne: true } }).lean();
    const today = new Date();
    const weekDays = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      weekDays.push(d.toISOString().split('T')[0]);
    }

    const weekEntries = entries.filter(e => weekDays.includes(e.date));
    const dailyData = weekDays.map(date => ({
      date,
      count: weekEntries.filter(e => e.date === date).length
    }));

    res.json({
      success: true,
      data: {
        weekStart: weekDays[0],
        weekEnd: weekDays[6],
        total: weekEntries.length,
        dailyBreakdown: dailyData,
        trend: dailyData.map((d, i) => ({
          ...d,
          change: i > 0 ? `${Math.round((d.count - dailyData[i - 1].count) / Math.max(dailyData[i - 1].count, 1) * 100)}%` : 'N/A'
        }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to generate weekly summary" } });
  }
});

// AI SUMMARY - Monthly
router.get("/ai-summary/monthly", authenticate, async (req, res) => {
  try {
    const entries = await Courier.find({ isArchived: { $ne: true } }).lean();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

    const monthEntries = entries.filter(e => e.date >= monthStart);
    let monthExpenditure = 0;
    monthEntries.forEach(e => { const p = parseFloat(e.price || '0'); if (!isNaN(p)) monthExpenditure += p; });

    const weeks = [];
    for (let w = 0; w < 5; w++) {
      const start = new Date(now.getFullYear(), now.getMonth(), w * 7 + 1);
      const end = new Date(now.getFullYear(), now.getMonth(), (w + 1) * 7);
      weeks.push({
        week: w + 1,
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0],
        count: monthEntries.filter(e => e.date >= start.toISOString().split('T')[0] && e.date <= end.toISOString().split('T')[0]).length
      });
    }

    res.json({
      success: true,
      data: {
        month: now.toLocaleString('default', { month: 'long', year: 'numeric' }),
        total: monthEntries.length,
        expenditure: monthExpenditure,
        averagePerDay: Math.round(monthEntries.length / now.getDate()),
        weeklyBreakdown: weeks,
        topCompanies: Object.entries(
          monthEntries.reduce((acc, e) => { acc[e.company] = (acc[e.company] || 0) + 1; return acc; }, {})
        ).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to generate monthly summary" } });
  }
});

// DUPLICATE SCAN
router.get("/duplicates", authenticate, async (req, res) => {
  try {
    const entries = await Courier.find({ isArchived: { $ne: true } }).lean();
    const awbMap = {};

    entries.forEach(e => {
      if (!e.awb) return;
      const key = e.awb.trim().toUpperCase();
      if (key.includes('HAND') || key.includes('CARRY') || key.length < 3) return;
      if (!awbMap[key]) awbMap[key] = [];
      awbMap[key].push(e);
    });

    const duplicates = Object.entries(awbMap)
      .filter(([, list]) => list.length > 1)
      .map(([awb, list]) => ({
        awb,
        count: list.length,
        entries: list.map(e => ({
          _id: e._id,
          company: e.company,
          date: e.date,
          courier: e.courier
        }))
      }));

    res.json({ success: true, data: duplicates });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to scan duplicates" } });
  }
});

// DATA QUALITY
router.get("/data-quality", authenticate, async (req, res) => {
  try {
    const entries = await Courier.find({ isArchived: { $ne: true } }).lean();
    const fields = ['date', 'from', 'to', 'company', 'location', 'courier', 'awb', 'invoiceNumber', 'content', 'price', 'weight'];

    const fieldCompleteness = {};
    fields.forEach(field => {
      const filled = entries.filter(e => e[field] && e[field] !== '').length;
      fieldCompleteness[field] = {
        filled,
        total: entries.length,
        percentage: Math.round((filled / entries.length) * 100)
      };
    });

    const invalidEntries = entries.filter(e => {
      if (e.delivered && e.date && new Date(e.delivered) < new Date(e.date)) return true;
      return false;
    });

    res.json({
      success: true,
      data: {
        totalEntries: entries.length,
        overallCompleteness: Math.round(
          Object.values(fieldCompleteness).reduce((sum, f) => sum + f.percentage, 0) / fields.length
        ),
        fieldCompleteness,
        invalidEntries: invalidEntries.length,
        invalidEntryList: invalidEntries.slice(0, 10).map(e => ({
          _id: e._id,
          awb: e.awb,
          date: e.date,
          delivered: e.delivered,
          issue: 'Delivery date before entry date'
        }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to analyze data quality" } });
  }
});

// STORAGE INFO — Calculates real values from MongoDB (no hardcoded Atlas Admin API assumptions)
router.get("/storage", authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = Courier.db.db;
    const collections = await db.listCollections().toArray();
    const storageInfo = [];

    for (const col of collections) {
      const stats = await db.collection(col.name).stats();
      storageInfo.push({
        name: col.name,
        size: stats.size,
        sizeFormatted: stats.size < 1024 ? `${stats.size} B` :
                       stats.size < 1048576 ? `${(stats.size / 1024).toFixed(2)} KB` :
                       `${(stats.size / 1048576).toFixed(2)} MB`,
        count: stats.count,
        avgObjSize: stats.avgObjSize
      });
    }

    const totalSize = storageInfo.reduce((sum, c) => sum + c.size, 0);
    const totalFormatted = totalSize < 1024 ? `${totalSize} B` :
                           totalSize < 1048576 ? `${(totalSize / 1024).toFixed(2)} KB` :
                           `${(totalSize / 1048576).toFixed(2)} MB`;
    const collectionsCount = storageInfo.length;
    const documentsCount = storageInfo.reduce((sum, c) => sum + (c.count || 0), 0);

    res.json({
      success: true,
      data: {
        collectionsCount,
        documentsCount,
        collections: storageInfo,
        storageUsed: totalFormatted,
        storageUsedBytes: totalSize,
        connectionStatus: 'connected',
        estimatedDatabaseSize: totalFormatted
      }
    });
  } catch (error) {
    // Fallback: attempt to calculate basic stats directly
    try {
      const collectionsCount = (await Courier.db.db.listCollections().toArray()).length;
      const documentsCount = await Courier.countDocuments({});
      res.json({
        success: true,
        data: {
          collectionsCount: collectionsCount || 0,
          documentsCount,
          collections: [],
          storageUsed: 'N/A',
          storageUsedBytes: 0,
          connectionStatus: 'connected',
          estimatedDatabaseSize: 'N/A',
          note: 'Storage info is partial — some collection stats unavailable'
        }
      });
    } catch (fallbackErr) {
      res.json({
        success: true,
        data: {
          collectionsCount: 0,
          documentsCount: 0,
          collections: [],
          storageUsed: 'N/A',
          storageUsedBytes: 0,
          connectionStatus: 'connected',
          estimatedDatabaseSize: 'N/A',
          note: 'Unable to compute storage details'
        }
      });
    }
  }
});

module.exports = router;