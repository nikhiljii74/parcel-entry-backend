const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Courier = require('../models/Courier');
const Buyer = require('../models/Buyer');
const Receiver = require('../models/Receiver');
const { authenticate } = require('../middleware/auth');

// ============================================================
// Helper: shared date filter builder
// ============================================================
function buildDateFilter(dateFrom, dateTo) {
  const dateFilter = {};
  if (dateFrom) dateFilter.$gte = dateFrom;
  if (dateTo) dateFilter.$lte = dateTo;
  return Object.keys(dateFilter).length ? { date: dateFilter } : {};
}

function deliveredCond() {
  return { $gt: [{ $strLenCP: { $ifNull: ['$delivered', ''] } }, 0] };
}

function pendingCond() {
  return { $eq: [{ $strLenCP: { $ifNull: ['$delivered', ''] } }, 0] };
}

function safePrice() {
  return {
    $cond: {
      if: { $gt: [{ $strLenCP: { $ifNull: ['$price', ''] } }, 0] },
      then: { $toDouble: '$price' },
      else: 0
    }
  };
}

// ============================================================
// 1. MongoDB STORAGE WIDGET DATA
// ============================================================
router.get('/mongodb-stats', authenticate, async (_req, res) => {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      return res.json({ success: true, data: { status: 'disconnected' } });
    }

    // Default values in case Atlas restricts certain commands
    let serverStatus = {};
    let dbStats = {};
    let connectionInfo = { current: 0, available: 0, totalCreated: 0, active: 0, threadsRunning: 0 };
    let version = 'unknown';
    let uptime = 0;
    let replicaSet = 'Standalone';
    let storageData = { dataSize: 0, indexSize: 0, storageSize: 0, totalSize: 0, freeStorage: 0, fsTotalSize: 0, fsUsedSize: 0 };

    // Try to get server status (may fail on Atlas)
    try {
      const adminDb = db.admin();
      serverStatus = await adminDb.serverStatus();
      version = serverStatus.version || 'unknown';
      uptime = serverStatus.uptime || 0;
      replicaSet = serverStatus.repl?.setName || 'Standalone';
      connectionInfo = {
        current: serverStatus.connections?.current || 0,
        available: serverStatus.connections?.available || 0,
        totalCreated: serverStatus.connections?.totalCreated || 0,
        active: serverStatus.connections?.active || 0,
        threadsRunning: serverStatus.globalLock?.currentQueue?.total || 0
      };
    } catch (err) {
      console.error('serverStatus failed (Atlas restricted):', err.message);
    }

    // Try to get DB stats (may fail on Atlas)
    try {
      dbStats = await db.stats();
      storageData = {
        dataSize: dbStats.dataSize || 0,
        indexSize: dbStats.indexSize || 0,
        storageSize: dbStats.storageSize || 0,
        totalSize: (dbStats.dataSize || 0) + (dbStats.indexSize || 0),
        freeStorage: dbStats.freeStorageSize || 0,
        fsTotalSize: dbStats.fsTotalSize || 0,
        fsUsedSize: dbStats.fsUsedSize || 0
      };
    } catch (err) {
      console.error('db.stats failed (Atlas restricted):', err.message);
    }

    // Get collections list with doc counts and sizes
    let collections = [];
    let collectionDetails = [];
    try {
      collections = await db.listCollections().toArray();
    } catch (err) {
      console.error('listCollections failed (Atlas restricted):', err.message);
    }

    for (const col of collections) {
      try {
        const colStats = await db.collection(col.name).stats();
        collectionDetails.push({
          name: col.name,
          documents: colStats.count || 0,
          avgObjSize: colStats.avgObjSize || 0,
          totalSize: colStats.size || 0,
          indexSize: colStats.totalIndexSize || 0,
          storageSize: colStats.storageSize || 0
        });
      } catch (err) {
        // Fallback: try estimatedDocumentCount instead
        try {
          const docCount = await db.collection(col.name).estimatedDocumentCount();
          collectionDetails.push({
            name: col.name,
            documents: docCount,
            avgObjSize: 0,
            totalSize: 0,
            indexSize: 0,
            storageSize: 0
          });
        } catch (fallbackErr) {
          console.error(`Failed to get stats for collection ${col.name}:`, fallbackErr.message);
          collectionDetails.push({
            name: col.name,
            documents: 0,
            avgObjSize: 0,
            totalSize: 0,
            indexSize: 0,
            storageSize: 0
          });
        }
      }
    }

    res.json({
      success: true,
      data: {
        status: 'connected',
        connectionState: mongoose.connection.readyState,
        cluster: {
          host: mongoose.connection.host || 'localhost',
          port: mongoose.connection.port || 27017,
          name: mongoose.connection.name || 'courier_db',
          replicaSet
        },
        storage: storageData,
        collections: collectionDetails,
        totalDocuments: collectionDetails.reduce((sum, c) => sum + c.documents, 0),
        totalCollections: collectionDetails.length,
        connections: connectionInfo,
        uptime,
        version,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    const errorMsg = error.message || 'Unknown error';
    console.error(`[mongodb-stats] Fatal error: ${errorMsg}`);
    console.error(`[mongodb-stats] Stack: ${error.stack || 'N/A'}`);
    console.error(`[mongodb-stats] ReadyState: ${mongoose.connection.readyState}`);
    console.error(`[mongodb-stats] Database: ${mongoose.connection.name || 'unknown'}`);
    console.error(`[mongodb-stats] Host: ${mongoose.connection.host || 'unknown'}`);
    res.status(500).json({
      success: false,
      message: errorMsg,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ============================================================
// 2. BI DASHBOARD - ENTERPRISE KPI DATA
// ============================================================
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    // ---- KPI Aggregations ----
    const [kpiResult, monthlyTrend, courierBreakdown, companyBreakdown, topDestinations, topSenders] = await Promise.all([
      // Overall KPIs
      Courier.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
            incoming: { $sum: { $cond: [{ $eq: ['$type', 'Incoming'] }, 1, 0] } },
            outgoing: { $sum: { $cond: [{ $eq: ['$type', 'Outgoing'] }, 1, 0] } },
            totalExpenditure: { $sum: safePrice() },
            uniqueCouriers: { $addToSet: '$courier' },
            uniqueCompanies: { $addToSet: '$company' },
            uniqueDestinations: { $addToSet: '$to' },
            uniqueSenders: { $addToSet: '$from' }
          }
        }
      ]),

      // Monthly trend (last 12 months)
      Courier.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: { $substr: ['$date', 0, 7] },
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
            totalExpenditure: { $sum: safePrice() }
          }
        },
        { $sort: { _id: 1 } },
        { $limit: 12 },
        {
          $project: {
            month: '$_id',
            total: 1,
            delivered: 1,
            pending: { $subtract: ['$total', '$delivered'] },
            expenditure: { $round: ['$totalExpenditure', 2] },
            _id: 0
          }
        }
      ]),

      // Courier breakdown
      Courier.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: '$courier',
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
            totalExpenditure: { $sum: safePrice() }
          }
        },
        { $sort: { total: -1 } },
        { $limit: 10 },
        {
          $project: {
            name: '$_id',
            total: 1,
            delivered: 1,
            deliveryRate: {
              $cond: [{ $gt: ['$total', 0] }, { $round: [{ $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 1] }, 0]
            },
            expenditure: { $round: ['$totalExpenditure', 2] },
            _id: 0
          }
        }
      ]),

      // Company breakdown
      Courier.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: '$company',
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
            totalExpenditure: { $sum: safePrice() }
          }
        },
        { $sort: { total: -1 } },
        { $limit: 10 },
        {
          $project: {
            name: '$_id',
            total: 1,
            delivered: 1,
            deliveryRate: {
              $cond: [{ $gt: ['$total', 0] }, { $round: [{ $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 1] }, 0]
            },
            expenditure: { $round: ['$totalExpenditure', 2] },
            _id: 0
          }
        }
      ]),

      // Top destinations
      Courier.aggregate([
        { $match: matchFilter },
        { $group: { _id: { $ifNull: ['$to', 'Unknown'] }, total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 10 },
        { $project: { destination: '$_id', total: 1, _id: 0 } }
      ]),

      // Top senders
      Courier.aggregate([
        { $match: matchFilter },
        { $group: { _id: { $ifNull: ['$from', 'Unknown'] }, total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 10 },
        { $project: { sender: '$_id', total: 1, _id: 0 } }
      ])
    ]);

    const kpi = kpiResult[0] || {
      total: 0, delivered: 0, incoming: 0, outgoing: 0,
      totalExpenditure: 0, uniqueCouriers: [], uniqueCompanies: [],
      uniqueDestinations: [], uniqueSenders: []
    };

    res.json({
      success: true,
      data: {
        kpis: {
          total: kpi.total,
          delivered: kpi.delivered,
          pending: kpi.total - kpi.delivered,
          incoming: kpi.incoming,
          outgoing: kpi.outgoing,
          totalExpenditure: Math.round(kpi.totalExpenditure * 100) / 100,
          deliveryRate: kpi.total > 0 ? Math.round((kpi.delivered / kpi.total) * 1000) / 10 : 0,
          uniqueCouriers: kpi.uniqueCouriers.filter(Boolean).length,
          uniqueCompanies: kpi.uniqueCompanies.filter(Boolean).length,
          uniqueDestinations: kpi.uniqueDestinations.filter(Boolean).length,
          uniqueSenders: kpi.uniqueSenders.filter(Boolean).length
        },
        monthlyTrend,
        courierBreakdown: courierBreakdown.filter(c => c.name),
        companyBreakdown: companyBreakdown.filter(c => c.name),
        topDestinations: topDestinations.filter(d => d.destination),
        topSenders: topSenders.filter(s => s.sender)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ============================================================
// 3. PMA SUMMARY
// ============================================================
router.get('/summary/pma', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    const results = await Courier.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
          pending: { $sum: { $cond: [pendingCond(), 1, 0] } },
          incoming: { $sum: { $cond: [{ $eq: ['$type', 'Incoming'] }, 1, 0] } },
          outgoing: { $sum: { $cond: [{ $eq: ['$type', 'Outgoing'] }, 1, 0] } },
          totalExpenditure: { $sum: safePrice() },
          uniqueCouriers: { $addToSet: '$courier' },
          uniqueCompanies: { $addToSet: '$company' },
          uniqueDestinations: { $addToSet: '$to' },
          uniqueSenders: { $addToSet: '$from' }
        }
      },
      {
        $project: {
          _id: 0,
          total: 1,
          delivered: 1,
          pending: 1,
          incoming: 1,
          outgoing: 1,
          totalExpenditure: { $round: ['$totalExpenditure', 2] },
          deliveryRate: {
            $cond: [{ $gt: ['$total', 0] }, { $round: [{ $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 1] }, 0]
          },
          uniqueCouriers: { $size: { $ifNull: ['$uniqueCouriers', []] } },
          uniqueCompanies: { $size: { $ifNull: ['$uniqueCompanies', []] } },
          uniqueDestinations: { $size: { $ifNull: ['$uniqueDestinations', []] } },
          uniqueSenders: { $size: { $ifNull: ['$uniqueSenders', []] } }
        }
      }
    ]);

    // Get monthly breakdown for PMA
    const monthlyBreakdown = await Courier.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { $substr: ['$date', 0, 7] },
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
          totalExpenditure: { $sum: safePrice() }
        }
      },
      { $sort: { _id: 1 } },
      { $limit: 12 },
      {
        $project: {
          month: '$_id',
          total: 1,
          delivered: 1,
          pending: { $subtract: ['$total', '$delivered'] },
          expenditure: { $round: ['$totalExpenditure', 2] },
          _id: 0
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        summary: results[0] || {
          total: 0, delivered: 0, pending: 0, incoming: 0, outgoing: 0,
          totalExpenditure: 0, deliveryRate: 0,
          uniqueCouriers: 0, uniqueCompanies: 0, uniqueDestinations: 0, uniqueSenders: 0
        },
        monthlyBreakdown
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ============================================================
// 4. BUYER SUMMARY
// ============================================================
router.get('/summary/buyer', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    const results = await Courier.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { $ifNull: ['$company', 'Unknown'] },
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
          pending: { $sum: { $cond: [pendingCond(), 1, 0] } },
          incoming: { $sum: { $cond: [{ $eq: ['$type', 'Incoming'] }, 1, 0] } },
          outgoing: { $sum: { $cond: [{ $eq: ['$type', 'Outgoing'] }, 1, 0] } },
          totalExpenditure: { $sum: safePrice() },
          couriers: { $addToSet: '$courier' },
          destinations: { $addToSet: '$to' }
        }
      },
      {
        $addFields: {
          deliveryRate: {
            $cond: [{ $gt: ['$total', 0] }, { $round: [{ $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 1] }, 0]
          }
        }
      },
      { $sort: { total: -1 } },
      {
        $project: {
          buyer: '$_id',
          total: 1,
          delivered: 1,
          pending: 1,
          incoming: 1,
          outgoing: 1,
          totalExpenditure: { $round: ['$totalExpenditure', 2] },
          deliveryRate: 1,
          uniqueCouriers: { $size: '$couriers' },
          uniqueDestinations: { $size: '$destinations' },
          _id: 0
        }
      }
    ]);

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ============================================================
// 5. RECEIVER SUMMARY
// ============================================================
router.get('/summary/receiver', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    const results = await Courier.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { $ifNull: ['$to', 'Unknown'] },
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
          pending: { $sum: { $cond: [pendingCond(), 1, 0] } },
          totalExpenditure: { $sum: safePrice() },
          couriers: { $addToSet: '$courier' },
          companies: { $addToSet: '$company' },
          senders: { $addToSet: '$from' }
        }
      },
      {
        $addFields: {
          deliveryRate: {
            $cond: [{ $gt: ['$total', 0] }, { $round: [{ $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 1] }, 0]
          }
        }
      },
      { $sort: { total: -1 } },
      {
        $project: {
          receiver: '$_id',
          total: 1,
          delivered: 1,
          pending: 1,
          totalExpenditure: { $round: ['$totalExpenditure', 2] },
          deliveryRate: 1,
          uniqueCouriers: { $size: '$couriers' },
          uniqueCompanies: { $size: '$companies' },
          uniqueSenders: { $size: '$senders' },
          _id: 0
        }
      }
    ]);

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ============================================================
// 6. SENDER SUMMARY
// ============================================================
router.get('/summary/sender', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    const results = await Courier.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { $ifNull: ['$from', 'Unknown'] },
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
          pending: { $sum: { $cond: [pendingCond(), 1, 0] } },
          totalExpenditure: { $sum: safePrice() },
          couriers: { $addToSet: '$courier' },
          companies: { $addToSet: '$company' },
          destinations: { $addToSet: '$to' }
        }
      },
      {
        $addFields: {
          deliveryRate: {
            $cond: [{ $gt: ['$total', 0] }, { $round: [{ $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 1] }, 0]
          }
        }
      },
      { $sort: { total: -1 } },
      {
        $project: {
          sender: '$_id',
          total: 1,
          delivered: 1,
          pending: 1,
          totalExpenditure: { $round: ['$totalExpenditure', 2] },
          deliveryRate: 1,
          uniqueCouriers: { $size: '$couriers' },
          uniqueCompanies: { $size: '$companies' },
          uniqueDestinations: { $size: '$destinations' },
          _id: 0
        }
      }
    ]);

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ============================================================
// 7. COUNTRY SUMMARY
// ============================================================
router.get('/summary/country', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    // Group by both 'from' and 'to' as country indicators
    const fromCountries = await Courier.aggregate([
      { $match: { ...matchFilter, from: { $exists: true, $ne: '' } } },
      { $group: { _id: '$from', total: { $sum: 1 }, delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } } } }
    ]);

    const toCountries = await Courier.aggregate([
      { $match: { ...matchFilter, to: { $exists: true, $ne: '' } } },
      { $group: { _id: '$to', total: { $sum: 1 }, delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } } } }
    ]);

    // Merge country data
    const countryMap = new Map();
    for (const c of fromCountries) {
      countryMap.set(c._id, { country: c._id, originTotal: c.total, originDelivered: c.delivered, destinationTotal: 0, destinationDelivered: 0 });
    }
    for (const c of toCountries) {
      if (countryMap.has(c._id)) {
        const existing = countryMap.get(c._id);
        existing.destinationTotal = c.total;
        existing.destinationDelivered = c.delivered;
      } else {
        countryMap.set(c._id, { country: c._id, originTotal: 0, originDelivered: 0, destinationTotal: c.total, destinationDelivered: c.delivered });
      }
    }

    const results = Array.from(countryMap.values())
      .map(c => ({
        ...c,
        total: c.originTotal + c.destinationTotal,
        delivered: c.originDelivered + c.destinationDelivered,
        deliveryRate: (c.originTotal + c.destinationTotal) > 0
          ? Math.round(((c.originDelivered + c.destinationDelivered) / (c.originTotal + c.destinationTotal)) * 1000) / 10
          : 0
      }))
      .sort((a, b) => b.total - a.total);

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ============================================================
// 8. COURIER SUMMARY (enhanced version)
// ============================================================
router.get('/summary/courier', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    const results = await Courier.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { $ifNull: ['$courier', 'Unknown'] },
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
          pending: { $sum: { $cond: [pendingCond(), 1, 0] } },
          incoming: { $sum: { $cond: [{ $eq: ['$type', 'Incoming'] }, 1, 0] } },
          outgoing: { $sum: { $cond: [{ $eq: ['$type', 'Outgoing'] }, 1, 0] } },
          totalExpenditure: { $sum: safePrice() },
          companies: { $addToSet: '$company' },
          destinations: { $addToSet: '$to' },
          senders: { $addToSet: '$from' }
        }
      },
      {
        $addFields: {
          deliveryRate: {
            $cond: [{ $gt: ['$total', 0] }, { $round: [{ $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 1] }, 0]
          }
        }
      },
      { $sort: { total: -1 } },
      {
        $project: {
          courier: '$_id',
          total: 1,
          delivered: 1,
          pending: 1,
          incoming: 1,
          outgoing: 1,
          totalExpenditure: { $round: ['$totalExpenditure', 2] },
          deliveryRate: 1,
          uniqueCompanies: { $size: '$companies' },
          uniqueDestinations: { $size: '$destinations' },
          uniqueSenders: { $size: '$senders' },
          _id: 0
        }
      }
    ]);

    // Get totals across all couriers
    const totals = await Courier.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
          totalExpenditure: { $sum: safePrice() }
        }
      }
    ]);

    res.json({
      success: true,
      data: results,
      summary: totals[0] ? {
        total: totals[0].total,
        delivered: totals[0].delivered,
        totalExpenditure: Math.round(totals[0].totalExpenditure * 100) / 100
      } : { total: 0, delivered: 0, totalExpenditure: 0 }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ============================================================
// 9. COMPANY SUMMARY (enhanced version)
// ============================================================
router.get('/summary/company', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    const results = await Courier.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { $ifNull: ['$company', 'Unknown'] },
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
          pending: { $sum: { $cond: [pendingCond(), 1, 0] } },
          incoming: { $sum: { $cond: [{ $eq: ['$type', 'Incoming'] }, 1, 0] } },
          outgoing: { $sum: { $cond: [{ $eq: ['$type', 'Outgoing'] }, 1, 0] } },
          totalExpenditure: { $sum: safePrice() },
          couriers: { $addToSet: '$courier' },
          destinations: { $addToSet: '$to' },
          senders: { $addToSet: '$from' }
        }
      },
      {
        $addFields: {
          deliveryRate: {
            $cond: [{ $gt: ['$total', 0] }, { $round: [{ $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 1] }, 0]
          }
        }
      },
      { $sort: { total: -1 } },
      {
        $project: {
          company: '$_id',
          total: 1,
          delivered: 1,
          pending: 1,
          incoming: 1,
          outgoing: 1,
          totalExpenditure: { $round: ['$totalExpenditure', 2] },
          deliveryRate: 1,
          uniqueCouriers: { $size: '$couriers' },
          uniqueDestinations: { $size: '$destinations' },
          uniqueSenders: { $size: '$senders' },
          _id: 0
        }
      }
    ]);

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ============================================================
// 10. ADVANCED MIS - Multi-select filtering with drill-down
// ============================================================
router.post('/mis/query', authenticate, async (req, res) => {
  try {
    const {
      senders = [],
      receivers = [],
      buyers = [],
      pma = [],
      companies = [],
      couriers = [],
      countries = [],
      vendors = [],
      statuses = [],
      dateFrom, dateTo,
      awb = [],
      page = 1,
      limit = 100,
      sortField = 'date',
      sortOrder = -1
    } = req.body;

    const filter = { isArchived: { $ne: true } };

    // Multi-select filters
    if (senders.length > 0) filter.from = { $in: senders };
    if (receivers.length > 0) filter.to = { $in: receivers };
    if (buyers.length > 0) filter.company = { $in: buyers };
    if (pma.length > 0) filter.company = { $in: pma };
    if (companies.length > 0) filter.company = { $in: companies };
    if (couriers.length > 0) filter.courier = { $in: couriers };
    if (countries.length > 0) filter.$or = [{ from: { $in: countries } }, { to: { $in: countries } }];
    if (vendors.length > 0) filter.courier = { $in: vendors };
    if (awb.length > 0) filter.awb = { $in: awb };

    // Date filter
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    if (dateFilter.date) filter.date = dateFilter.date;

    // Status filter
    if (statuses.length > 0) {
      const statusConditions = [];
      if (statuses.includes('delivered')) {
        statusConditions.push({ delivered: { $exists: true, $ne: '', $nin: [null, ''] } });
      }
      if (statuses.includes('pending')) {
        statusConditions.push({ $or: [{ delivered: { $in: ['', null] } }, { delivered: { $exists: false } }] });
      }
      if (statuses.includes('in_transit') || statuses.includes('CREATED') || statuses.includes('RETURNED') || statuses.includes('CANCELLED')) {
        const validStatuses = statuses.filter(s => ['CREATED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'RETURNED', 'CANCELLED'].includes(s));
        if (validStatuses.length > 0) {
          statusConditions.push({ status: { $in: validStatuses } });
        }
      }
      if (statusConditions.length > 0) {
        filter.$and = filter.$and || [];
        filter.$and.push(...statusConditions.map(cond => {
          if (filter.$or && !cond.$or) return cond;
          return cond;
        }));
        // Rebuild if we have $or at top level from countries
        if (statusConditions.length === 1 && filter.$or) {
          // Keep existing $or, add status condition
        }
      }
    }

    // Get total count
    const total = await Courier.countDocuments(filter);

    // Get filtered data
    const entries = await Courier.find(filter)
      .sort({ [sortField]: sortOrder, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    // Get filter values for dropdowns (distinct values)
    const [distinctSenders, distinctReceivers, distinctCompanies, distinctCouriers] = await Promise.all([
      Courier.distinct('from', { isArchived: { $ne: true }, from: { $ne: '', $exists: true } }),
      Courier.distinct('to', { isArchived: { $ne: true }, to: { $ne: '', $exists: true } }),
      Courier.distinct('company', { isArchived: { $ne: true }, company: { $ne: '', $exists: true } }),
      Courier.distinct('courier', { isArchived: { $ne: true }, courier: { $ne: '', $exists: true } })
    ]);

    res.json({
      success: true,
      data: {
        entries,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit),
        filters: {
          senders: distinctSenders.filter(Boolean).sort(),
          receivers: distinctReceivers.filter(Boolean).sort(),
          companies: distinctCompanies.filter(Boolean).sort(),
          couriers: distinctCouriers.filter(Boolean).sort()
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ============================================================
// 11. DRILL-DOWN from any summary
// ============================================================
router.post('/drilldown', authenticate, async (req, res) => {
  try {
    const {
      dimension, // 'sender', 'receiver', 'buyer', 'courier', 'company', 'country', 'pma'
      value,
      dateFrom, dateTo,
      page = 1,
      limit = 100
    } = req.body;

    const filter = { isArchived: { $ne: true } };
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    if (dateFilter.date) filter.date = dateFilter.date;

    switch (dimension) {
      case 'sender': filter.from = value; break;
      case 'receiver': filter.to = value; break;
      case 'buyer':
      case 'company':
      case 'pma': filter.company = value; break;
      case 'courier': filter.courier = value; break;
      case 'country': filter.$or = [{ from: value }, { to: value }]; break;
      default: filter.from = value;
    }

    const total = await Courier.countDocuments(filter);
    const entries = await Courier.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: { entries, total, page: parseInt(page), totalPages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

module.exports = router;
