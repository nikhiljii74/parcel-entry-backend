const express = require('express');
const router = express.Router();
const Courier = require('../models/Courier');
const { authenticate } = require('../middleware/auth');

// ========== SHARED HELPERS ==========

function buildDateFilter(dateFrom, dateTo) {
  const dateFilter = {};
  if (dateFrom) dateFilter.$gte = dateFrom;
  if (dateTo) dateFilter.$lte = dateTo;
  return Object.keys(dateFilter).length ? { date: dateFilter } : {};
}

// Helper: returns true (1) if delivered field exists and is non-empty
function deliveredCond() {
  return { $gt: [{ $strLenCP: { $ifNull: ['$delivered', ''] } }, 0] };
}

function pendingCond() {
  return { $eq: [{ $strLenCP: { $ifNull: ['$delivered', ''] } }, 0] };
}

// Safe price conversion: handle empty strings that $toDouble can't parse
function safePrice() {
  return {
    $cond: {
      if: { $gt: [{ $strLenCP: { $ifNull: ['$price', ''] } }, 0] },
      then: { $toDouble: '$price' },
      else: 0
    }
  };
}

// ========== AGGREGATION: SUMMARY BY COURIER ==========
router.get('/by-courier', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    const results = await Courier.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: '$courier',
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
          pending: { $sum: { $cond: [pendingCond(), 1, 0] } },
          incoming: { $sum: { $cond: [{ $eq: ['$type', 'Incoming'] }, 1, 0] } },
          outgoing: { $sum: { $cond: [{ $eq: ['$type', 'Outgoing'] }, 1, 0] } },
          totalExpenditure: { $sum: safePrice() }
        }
      },
      {
        $addFields: {
          deliveryRate: {
            $cond: [{ $gt: ['$total', 0] }, { $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 0]
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
          deliveryRate: { $round: ['$deliveryRate', 1] },
          _id: 0
        }
      }
    ]);

    // Get total across all couriers
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

// ========== AGGREGATION: SUMMARY BY COMPANY ==========
router.get('/by-company', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    const results = await Courier.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: '$company',
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [deliveredCond(), 1, 0] } },
          pending: { $sum: { $cond: [pendingCond(), 1, 0] } },
          incoming: { $sum: { $cond: [{ $eq: ['$type', 'Incoming'] }, 1, 0] } },
          outgoing: { $sum: { $cond: [{ $eq: ['$type', 'Outgoing'] }, 1, 0] } },
          totalExpenditure: { $sum: safePrice() },
          couriers: { $addToSet: '$courier' }
        }
      },
      {
        $addFields: {
          deliveryRate: {
            $cond: [{ $gt: ['$total', 0] }, { $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 0]
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
          deliveryRate: { $round: ['$deliveryRate', 1] },
          uniqueCouriers: { $size: '$couriers' },
          _id: 0
        }
      }
    ]);

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ========== AGGREGATION: SUMMARY BY DESTINATION (to) ==========
router.get('/by-destination', authenticate, async (req, res) => {
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
          companies: { $addToSet: '$company' },
          couriers: { $addToSet: '$courier' }
        }
      },
      { $sort: { total: -1 } },
      {
        $project: {
          destination: '$_id',
          total: 1,
          delivered: 1,
          pending: 1,
          uniqueCompanies: { $size: '$companies' },
          uniqueCouriers: { $size: '$couriers' },
          _id: 0
        }
      }
    ]);

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ========== AGGREGATION: SUMMARY BY SENDER (from) ==========
router.get('/by-sender', authenticate, async (req, res) => {
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
          companies: { $addToSet: '$company' }
        }
      },
      {
        $addFields: {
          deliveryRate: {
            $cond: [{ $gt: ['$total', 0] }, { $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 0]
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
          deliveryRate: { $round: ['$deliveryRate', 1] },
          _id: 0
        }
      }
    ]);

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ========== AGGREGATION: COMPREHENSIVE KPI SUMMARY ==========
router.get('/summary', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    const [kpiResult, topCourierResult, topCompanyResult, topDestinationResult, topSenderResult] = await Promise.all([
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
            uniqueDestinations: { $addToSet: '$to' }
          }
        }
      ]),
      Courier.aggregate([
        { $match: matchFilter },
        { $group: { _id: '$courier', total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 1 },
        { $project: { _id: 0, name: '$_id', total: 1 } }
      ]),
      Courier.aggregate([
        { $match: matchFilter },
        { $group: { _id: '$company', total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 1 },
        { $project: { _id: 0, name: '$_id', total: 1 } }
      ]),
      Courier.aggregate([
        { $match: matchFilter },
        { $group: { _id: '$to', total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 1 },
        { $project: { _id: 0, name: '$_id', total: 1 } }
      ]),
      Courier.aggregate([
        { $match: matchFilter },
        { $group: { _id: '$from', total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 1 },
        { $project: { _id: 0, name: '$_id', total: 1 } }
      ])
    ]);

    const kpi = kpiResult[0] || { total: 0, delivered: 0, incoming: 0, outgoing: 0, totalExpenditure: 0, uniqueCouriers: [], uniqueCompanies: [], uniqueDestinations: [] };
    const pending = kpi.total - kpi.delivered;

    res.json({
      success: true,
      data: {
        kpis: {
          total: kpi.total,
          delivered: kpi.delivered,
          pending,
          incoming: kpi.incoming,
          outgoing: kpi.outgoing,
          totalExpenditure: Math.round(kpi.totalExpenditure * 100) / 100,
          deliveryRate: kpi.total > 0 ? Math.round((kpi.delivered / kpi.total) * 1000) / 10 : 0,
          uniqueCouriers: kpi.uniqueCouriers.filter(Boolean).length,
          uniqueCompanies: kpi.uniqueCompanies.filter(Boolean).length,
          uniqueDestinations: kpi.uniqueDestinations.filter(Boolean).length
        },
        topPerformer: topCourierResult[0] || null,
        topCompany: topCompanyResult[0] || null,
        topDestination: topDestinationResult[0] || null,
        topSender: topSenderResult[0] || null
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ========== AGGREGATION: MONTHLY TREND ==========
router.get('/monthly-trend', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    const results = await Courier.aggregate([
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
      {
        $project: {
          month: '$_id',
          total: 1,
          delivered: 1,
          pending: { $subtract: ['$total', '$delivered'] },
          totalExpenditure: { $round: ['$totalExpenditure', 2] },
          _id: 0
        }
      }
    ]);

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ========== DRILL-DOWN: Entries for a specific filter ==========
router.get('/drilldown', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo, courier, company, destination, sender, status, type, limit = 500 } = req.query;
    const filter = { isArchived: { $ne: true } };

    const dateFilter = buildDateFilter(dateFrom, dateTo);
    if (dateFilter.date) filter.date = dateFilter.date;
    if (courier) filter.courier = courier;
    if (company) filter.company = company;
    if (destination) filter.to = destination;
    if (sender) filter.from = sender;
    if (type) filter.type = type;

    if (status === 'delivered') {
      filter.delivered = { $exists: true, $ne: '', $nin: [null, ''] };
    } else if (status === 'pending') {
      filter.$or = [{ delivered: { $in: ['', null] } }, { delivered: { $exists: false } }];
    }

    const entries = await Courier.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json({ success: true, data: entries, total: entries.length });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// ========== FULL DETAILED EXPORT DATA ==========
router.get('/export', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo, courier, company } = req.query;
    const filter = { isArchived: { $ne: true } };
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    if (dateFilter.date) filter.date = dateFilter.date;
    if (courier) filter.courier = courier;
    if (company) filter.company = company;

    const entries = await Courier.find(filter)
      .sort({ date: -1 })
      .select('date from to company courier awb type delivered price weight content invoiceNumber status')
      .lean();

    res.json({ success: true, data: entries, total: entries.length });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

module.exports = router;