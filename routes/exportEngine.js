const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const Courier = require('../models/Courier');

// ============================================================
// EXPORT ENGINE - Excel, PDF, CSV
// ============================================================

// Helper functions
function buildDateFilter(dateFrom, dateTo) {
  const dateFilter = {};
  if (dateFrom) dateFilter.$gte = dateFrom;
  if (dateTo) dateFilter.$lte = dateTo;
  return Object.keys(dateFilter).length ? { date: dateFilter } : {};
}

// Generic export endpoint returning structured data for any frontend export
router.post('/data', authenticate, async (req, res) => {
  try {
    const {
      type = 'all', // 'all', 'summary', 'detailed'
      dimension, // 'pma', 'buyer', 'receiver', 'sender', 'company', 'country', 'courier', 'vendor'
      dateFrom, dateTo,
      filters = {},
      format = 'json', // 'json', 'csv'
      page = 1,
      limit = 10000
    } = req.body;

    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const matchFilter = { isArchived: { $ne: true }, ...dateFilter };

    // Apply additional filters
    if (filters.sender) matchFilter.from = filters.sender;
    if (filters.receiver) matchFilter.to = filters.receiver;
    if (filters.company) matchFilter.company = filters.company;
    if (filters.courier) matchFilter.courier = filters.courier;

    if (type === 'detailed') {
      const entries = await Courier.find(matchFilter)
        .sort({ date: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean();

      const total = await Courier.countDocuments(matchFilter);

      const headers = ['Date', 'AWB', 'From', 'To', 'Company', 'Courier', 'Type', 'Delivered', 'Price', 'Weight', 'Content', 'Invoice', 'Status'];
      const csvRows = entries.map(e => headers.map(h =>
        `"${(e[h.toLowerCase().replace(' ', '')] || e[h.toLowerCase()] || '').toString().replace(/"/g, '""')}"`
      ).join(','));

      res.json({
        success: true,
        data: {
          entries,
          total,
          headers,
          csv: [headers.join(','), ...csvRows].join('\n'),
          generatedAt: new Date().toISOString()
        }
      });
    } else if (type === 'summary' && dimension) {
      const groupField = {
        pma: '$company', buyer: '$company', receiver: '$to',
        sender: '$from', company: '$company', country: '$to',
        courier: '$courier', vendor: '$courier'
      }[dimension] || '$from';

      const results = await Courier.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: { $ifNull: [groupField, 'Unknown'] },
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$delivered', ''] } }, 0] }, 1, 0] } },
            pending: { $sum: { $cond: [{ $eq: [{ $strLenCP: { $ifNull: ['$delivered', ''] } }, 0] }, 1, 0] } },
            totalExpenditure: {
              $sum: {
                $cond: {
                  if: { $gt: [{ $strLenCP: { $ifNull: ['$price', ''] } }, 0] },
                  then: { $toDouble: '$price' },
                  else: 0
                }
              }
            }
          }
        },
        { $sort: { total: -1 } },
        {
          $project: {
            _id: 0,
            name: '$_id',
            total: 1,
            delivered: 1,
            pending: 1,
            deliveryRate: {
              $cond: [{ $gt: ['$total', 0] }, { $round: [{ $multiply: [{ $divide: ['$delivered', '$total'] }, 100] }, 1] }, 0]
            },
            totalExpenditure: { $round: ['$totalExpenditure', 2] }
          }
        }
      ]);

      const headers = ['Name', 'Total', 'Delivered', 'Pending', 'Delivery Rate %', 'Total Expenditure'];
      const csvRows = results.map(r => headers.map(h =>
        `"${r[h.toLowerCase().replace(' ', '_').replace('%', '')] ?? ''}"`
      ).join(','));

      res.json({
        success: true,
        data: {
          entries: results,
          total: results.length,
          headers,
          csv: [headers.join(','), ...csvRows].join('\n'),
          generatedAt: new Date().toISOString()
        }
      });
    } else {
      // All data - general summary
      const results = await Courier.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$delivered', ''] } }, 0] }, 1, 0] } },
            incoming: { $sum: { $cond: [{ $eq: ['$type', 'Incoming'] }, 1, 0] } },
            outgoing: { $sum: { $cond: [{ $eq: ['$type', 'Outgoing'] }, 1, 0] } },
            totalExpenditure: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$price', ''] } }, 0] }, { $toDouble: '$price' }, 0] } }
          }
        }
      ]);

      const entries = await Courier.find(matchFilter).sort({ date: -1 }).limit(1000).lean();

      res.json({
        success: true,
        data: {
          summary: results[0] || { total: 0, delivered: 0, incoming: 0, outgoing: 0, totalExpenditure: 0 },
          entries,
          total: entries.length,
          generatedAt: new Date().toISOString()
        }
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// Export as CSV (direct download)
router.get('/csv', authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo, company, courier } = req.query;
    const filter = { isArchived: { $ne: true } };
    const dateFilter = buildDateFilter(dateFrom, dateTo);
    if (dateFilter.date) filter.date = dateFilter.date;
    if (company) filter.company = company;
    if (courier) filter.courier = courier;

    const entries = await Courier.find(filter)
      .sort({ date: -1 })
      .select('date from to company courier awb type delivered price weight content invoiceNumber status')
      .lean();

    const headers = ['Date', 'From', 'To', 'Company', 'Courier', 'AWB', 'Type', 'Delivered', 'Price', 'Weight', 'Content', 'Invoice', 'Status'];
    const csv = [headers.join(',')];
    entries.forEach(e => {
      csv.push(headers.map(h => {
        const key = h.toLowerCase();
        const val = e[key] || e[key.replace(/\s/g, '')] || '';
        return `"${String(val).replace(/"/g, '""')}"`;
      }).join(','));
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=courier_export_${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv.join('\n'));
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

module.exports = router;