const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Courier = require('../models/Courier');
const AuditLog = require('../models/AuditLog');
const { authenticate } = require('../middleware/auth');

// ============================================================
// BULK DATA CORRECTION CENTER
// ============================================================

const VALID_OPERATIONS = ['set', 'prepend', 'append', 'upper', 'lower', 'trim', 'capitalize'];

function handleError(res, error, statusCode = 500) {
  console.error(error);
  res.status(statusCode).json({
    success: false,
    message: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
  });
}

async function createAuditLog(action, performedBy, details) {
  try {
    await AuditLog.create({
      action,
      performedBy: performedBy || null,
      details,
      timestamp: new Date()
    });
  } catch (auditErr) {
    console.error('Failed to save audit log:', auditErr.message);
    // Non-fatal: don't let audit log failure crash the operation
  }
}

// 1. FIND & REPLACE - Preview changes
router.post('/find-replace/preview', authenticate, async (req, res) => {
  try {
    const { field, findValue, replaceValue, filters = {} } = req.body;
    if (!field || !findValue) {
      return res.status(400).json({ success: false, message: 'Field and findValue are required' });
    }

    const query = { isArchived: { $ne: true }, [field]: { $regex: findValue, $options: 'i' } };
    
    // Apply additional filters
    if (filters.company) query.company = filters.company;
    if (filters.courier) query.courier = filters.courier;
    if (filters.dateFrom || filters.dateTo) {
      query.date = {};
      if (filters.dateFrom) query.date.$gte = filters.dateFrom;
      if (filters.dateTo) query.date.$lte = filters.dateTo;
    }

    const records = await Courier.find(query)
      .select('_id date from to company courier awb ' + field)
      .lean()
      .limit(500);

    const preview = records.map(r => ({
      _id: r._id,
      date: r.date,
      from: r.from,
      to: r.to,
      company: r.company,
      courier: r.courier,
      awb: r.awb,
      field: field,
      oldValue: r[field] || '',
      newValue: (r[field] || '').replace(new RegExp(findValue, 'gi'), replaceValue || '')
    }));

    res.json({
      success: true,
      data: {
        total: preview.length,
        recordsAffected: preview.length,
        preview
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

// 2. FIND & REPLACE - Execute
router.post('/find-replace/execute', authenticate, async (req, res) => {
  try {
    const { field, findValue, replaceValue, recordIds, filters = {} } = req.body;
    if (!field || !findValue) {
      return res.status(400).json({ success: false, message: 'Field and findValue are required' });
    }

    const query = { isArchived: { $ne: true }, [field]: { $regex: findValue, $options: 'i' } };
    if (recordIds && recordIds.length > 0) {
      query._id = { $in: recordIds.map(id => new mongoose.Types.ObjectId(id)) };
    }
    if (filters.company) query.company = filters.company;
    if (filters.courier) query.courier = filters.courier;

    // Get records before update for audit
    const recordsBefore = await Courier.find(query).lean();

    // Build bulkWrite operations
    const bulkOps = recordsBefore.map(record => ({
      updateOne: {
        filter: { _id: record._id },
        update: { $set: { [field]: (record[field] || '').replace(new RegExp(findValue, 'gi'), replaceValue || '') } }
      }
    }));

    if (bulkOps.length === 0) {
      return res.json({ success: true, data: { modified: 0, message: 'No matching records found' } });
    }

    const result = await Courier.bulkWrite(bulkOps);

    // Save audit log
    await createAuditLog('BULK_FIND_REPLACE', req.user._id, {
      field,
      findValue,
      replaceValue,
      recordsAffected: result.modifiedCount || bulkOps.length,
      filters: JSON.stringify(filters),
      recordIds: recordIds?.length || 'all'
    });

    // Store the undo data in a temporary collection or return undo token
    const undoData = recordsBefore.map(r => ({
      _id: r._id,
      field,
      oldValue: r[field]
    }));

    res.json({
      success: true,
      data: {
        modified: result.modifiedCount || 0,
        matched: result.matchedCount || 0,
        recordsAffected: bulkOps.length,
        undoToken: Buffer.from(JSON.stringify(undoData)).toString('base64')
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

// 3. MERGE DUPLICATES - Preview
router.post('/merge-duplicates/preview', authenticate, async (req, res) => {
  try {
    const { field } = req.body;
    if (!field) {
      return res.status(400).json({ success: false, message: 'Field name is required' });
    }

    // Find duplicates using aggregation
    const duplicates = await Courier.aggregate([
      { $match: { isArchived: { $ne: true }, [field]: { $ne: '', $exists: true } } },
      {
        $group: {
          _id: { $toLower: { $trim: { input: `$${field}` } } },
          originalValues: { $addToSet: `$${field}` },
          count: { $sum: 1 },
          records: { $push: { _id: '$_id', value: `$${field}` } }
        }
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const preview = duplicates.map(d => ({
      normalizedValue: d._id,
      originalValues: d.originalValues,
      recordCount: d.count,
      records: d.records
    }));

    res.json({
      success: true,
      data: {
        total: preview.length,
        groups: preview
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

// 4. MERGE DUPLICATES - Execute (normalize to canonical value)
router.post('/merge-duplicates/execute', authenticate, async (req, res) => {
  try {
    const { field, canonicalMap } = req.body;
    // canonicalMap = { "oldValue1": "canonicalValue", "oldValue2": "canonicalValue", ... }
    if (!field || !canonicalMap || typeof canonicalMap !== 'object') {
      return res.status(400).json({ success: false, message: 'Field and canonicalMap are required' });
    }

    const entries = Object.entries(canonicalMap);

    // Validate inputs
    if (entries.length === 0) {
      return res.status(400).json({ success: false, message: 'canonicalMap must have at least one entry' });
    }

    // Use a session + transaction for atomicity
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      let totalModified = 0;

      // Build bulk operations for each mapping
      const bulkOps = [];
      for (const [oldValue, newValue] of entries) {
        if (oldValue !== newValue) {
          // Update all records with oldValue to newValue
          const updateResult = await Courier.updateMany(
            { isArchived: { $ne: true }, [field]: oldValue },
            { $set: { [field]: newValue } },
            { session }
          );
          totalModified += updateResult.modifiedCount || 0;
        }
      }

      if (totalModified === 0) {
        await session.abortTransaction();
        session.endSession();
        return res.json({ success: true, data: { modified: 0, message: 'No changes needed' } });
      }

      await session.commitTransaction();
      session.endSession();

      // Audit log (outside transaction to avoid blocking)
      await createAuditLog('BULK_MERGE_DUPLICATES', req.user._id, {
        field,
        mappings: JSON.stringify(canonicalMap),
        recordsAffected: totalModified
      });

      res.json({
        success: true,
        data: {
          modified: totalModified,
          recordsAffected: entries.length,
          mergedRecords: totalModified,
          deletedDuplicates: entries.length
        }
      });
    } catch (txnErr) {
      // Rollback on failure
      await session.abortTransaction();
      session.endSession();
      throw txnErr;
    }
  } catch (error) {
    handleError(res, error);
  }
});

// 5. BULK UPDATE - Preview changes
router.post('/bulk-update/preview', authenticate, async (req, res) => {
  try {
    const { field, operation, value, filters = {} } = req.body;
    // operation: 'set', 'prepend', 'append', 'upper', 'lower', 'trim'
    if (!field || !operation) {
      return res.status(400).json({ success: false, message: 'Field and operation are required' });
    }

    if (!VALID_OPERATIONS.includes(operation)) {
      return res.status(400).json({ success: false, message: `Invalid operation. Must be one of: ${VALID_OPERATIONS.join(', ')}` });
    }

    const query = { isArchived: { $ne: true } };
    if (filters.company) query.company = filters.company;
    if (filters.courier) query.courier = filters.courier;
    if (filters.sender) query.from = filters.sender;
    if (filters.receiver) query.to = filters.receiver;
    if (filters.dateFrom || filters.dateTo) {
      query.date = {};
      if (filters.dateFrom) query.date.$gte = filters.dateFrom;
      if (filters.dateTo) query.date.$lte = filters.dateTo;
    }

    const records = await Courier.find(query)
      .select('_id date from to company courier awb ' + field)
      .lean()
      .limit(500);

    const preview = records.map(r => {
      const oldVal = r[field] || '';
      let newVal = oldVal;
      switch (operation) {
        case 'set': newVal = value || ''; break;
        case 'prepend': newVal = (value || '') + oldVal; break;
        case 'append': newVal = oldVal + (value || ''); break;
        case 'upper': newVal = oldVal.toUpperCase(); break;
        case 'lower': newVal = oldVal.toLowerCase(); break;
        case 'trim': newVal = oldVal.trim(); break;
        case 'capitalize': newVal = oldVal.replace(/\b\w/g, c => c.toUpperCase()); break;
      }
      return {
        _id: r._id,
        date: r.date,
        from: r.from,
        to: r.to,
        company: r.company,
        courier: r.courier,
        awb: r.awb,
        field,
        oldValue: oldVal,
        newValue: newVal
      };
    });

    res.json({
      success: true,
      data: {
        total: preview.length,
        recordsAffected: preview.length,
        preview
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

// 6. BULK UPDATE - Execute
router.post('/bulk-update/execute', authenticate, async (req, res) => {
  try {
    const { field, operation, value, recordIds, filters = {} } = req.body;
    if (!field || !operation) {
      return res.status(400).json({ success: false, message: 'Field and operation are required' });
    }

    if (!VALID_OPERATIONS.includes(operation)) {
      return res.status(400).json({ success: false, message: `Invalid operation. Must be one of: ${VALID_OPERATIONS.join(', ')}` });
    }

    const query = { isArchived: { $ne: true } };
    if (recordIds && recordIds.length > 0) {
      query._id = { $in: recordIds.map(id => new mongoose.Types.ObjectId(id)) };
    }
    if (filters.company) query.company = filters.company;
    if (filters.courier) query.courier = filters.courier;

    const records = await Courier.find(query).lean();

    // Build bulkWrite with custom update per record
    const bulkOps = records.map(r => {
      const oldVal = r[field] || '';
      let newVal = oldVal;
      switch (operation) {
        case 'set': newVal = value || ''; break;
        case 'prepend': newVal = (value || '') + oldVal; break;
        case 'append': newVal = oldVal + (value || ''); break;
        case 'upper': newVal = oldVal.toUpperCase(); break;
        case 'lower': newVal = oldVal.toLowerCase(); break;
        case 'trim': newVal = oldVal.trim(); break;
        case 'capitalize': newVal = oldVal.replace(/\b\w/g, c => c.toUpperCase()); break;
      }
      return {
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { [field]: newVal } }
        }
      };
    });

    if (bulkOps.length === 0) {
      return res.json({ success: true, data: { modified: 0, message: 'No records found' } });
    }

    const result = await Courier.bulkWrite(bulkOps);

    // Audit log
    await createAuditLog('BULK_UPDATE', req.user._id, {
      field,
      operation,
      value: value || '',
      recordsAffected: result.modifiedCount || bulkOps.length,
      filters: JSON.stringify(filters)
    });

    // Store undo data
    const undoData = records.map(r => ({
      _id: r._id,
      field,
      oldValue: r[field]
    }));

    res.json({
      success: true,
      data: {
        modified: result.modifiedCount || 0,
        matched: result.matchedCount || 0,
        recordsAffected: bulkOps.length,
        undoToken: Buffer.from(JSON.stringify(undoData)).toString('base64')
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

// 7. UNDO - Rollback changes
router.post('/undo', authenticate, async (req, res) => {
  try {
    const { undoToken } = req.body;
    if (!undoToken) {
      return res.status(400).json({ success: false, message: 'Undo token is required' });
    }

    let undoData;
    try {
      undoData = JSON.parse(Buffer.from(undoToken, 'base64').toString('utf-8'));
    } catch (parseErr) {
      return res.status(400).json({ success: false, message: 'Invalid undo token format' });
    }

    if (!Array.isArray(undoData) || undoData.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid undo data' });
    }

    // Build bulkWrite to restore original values
    const bulkOps = undoData.map(item => ({
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(item._id) },
        update: { $set: { [item.field]: item.oldValue } }
      }
    }));

    const result = await Courier.bulkWrite(bulkOps);

    // Audit log for rollback
    await createAuditLog('BULK_UNDO', req.user._id, {
      recordsRestored: undoData.length,
      fields: [...new Set(undoData.map(d => d.field))]
    });

    res.json({
      success: true,
      data: {
        restored: result.modifiedCount || 0,
        recordsAffected: undoData.length
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

// 8. AUDIT LOG for bulk operations
router.get('/audit-log', authenticate, async (req, res) => {
  try {
    const { limit = 50, page = 1 } = req.query;

    const total = await AuditLog.countDocuments({});
    const logs = await AuditLog.find({})
      .sort({ timestamp: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: {
        logs: logs.map(l => ({
          _id: l._id,
          action: l.action,
          performedBy: l.user || 'system',
          details: typeof l.details === 'object' ? l.details : {},
          timestamp: l.timestamp || l.createdAt
        })),
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
