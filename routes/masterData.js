const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { Sender, PMA, Company, Country, Vendor } = require('../models/Master');
const Courier = require('../models/Courier');

// ============================================================
// GENERIC MASTER DATA CRUD FACTORY
// ============================================================
function createMasterRoutes(model, name) {
  const r = express.Router();

  // List with search & pagination
  r.get('/', authenticate, async (req, res) => {
    try {
      const { search, active, page = 1, limit = 100 } = req.query;
      const filter = {};
      if (active !== undefined) filter.isActive = active === 'true';
      if (search) {
        filter.$or = [
          { name: { $regex: search, $options: 'i' } },
          { displayName: { $regex: search, $options: 'i' } },
          { company: { $regex: search, $options: 'i' } }
        ];
      }
      const total = await model.countDocuments(filter);
      const items = await model.find(filter)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean();

      res.json({ success: true, data: items, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
    } catch (error) {
      res.status(500).json({ success: false, error: { message: error.message } });
    }
  });

  // Get by ID
  r.get('/:id', authenticate, async (req, res) => {
    try {
      const item = await model.findById(req.params.id).lean();
      if (!item) return res.status(404).json({ success: false, error: { message: `${name} not found` } });
      res.json({ success: true, data: item });
    } catch (error) {
      res.status(500).json({ success: false, error: { message: error.message } });
    }
  });

  // Create
  r.post('/', authenticate, async (req, res) => {
    try {
      const data = { ...req.body, createdBy: req.user._id };
      const item = await model.create(data);
      res.status(201).json({ success: true, data: item });
    } catch (error) {
      if (error.code === 11000) return res.status(400).json({ success: false, error: { message: `${name} already exists` } });
      res.status(500).json({ success: false, error: { message: error.message } });
    }
  });

  // Update
  r.put('/:id', authenticate, async (req, res) => {
    try {
      const item = await model.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
      if (!item) return res.status(404).json({ success: false, error: { message: `${name} not found` } });
      res.json({ success: true, data: item });
    } catch (error) {
      res.status(500).json({ success: false, error: { message: error.message } });
    }
  });

  // Delete
  r.delete('/:id', authenticate, async (req, res) => {
    try {
      const item = await model.findByIdAndDelete(req.params.id);
      if (!item) return res.status(404).json({ success: false, error: { message: `${name} not found` } });
      res.json({ success: true, message: `${name} deleted` });
    } catch (error) {
      res.status(500).json({ success: false, error: { message: error.message } });
    }
  });

  // Auto-populate from Courier entries
  r.post('/auto-populate', authenticate, async (req, res) => {
    try {
      const fieldMap = {
        'Sender': 'from',
        'PMA': 'company',
        'Company': 'company',
        'Country': 'to',
        'Vendor': 'courier'
      };
      const courierField = fieldMap[name] || 'from';

      const distinctValues = await Courier.distinct(courierField, {
        [courierField]: { $ne: '', $exists: true },
        isArchived: { $ne: true }
      });

      let created = 0;
      for (const val of distinctValues) {
        if (!val) continue;
        try {
          await model.create({ name: val.toLowerCase(), displayName: val.trim(), source: 'auto_populated' });
          created++;
        } catch (e) {
          if (e.code !== 11000) console.error(`Auto-populate ${name} error:`, e.message);
        }
      }

      res.json({ success: true, data: { created, total: distinctValues.length } });
    } catch (error) {
      res.status(500).json({ success: false, error: { message: error.message } });
    }
  });

  // Bulk import
  r.post('/bulk-import', authenticate, async (req, res) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: { message: 'Items array is required' } });
      }

      let created = 0, skipped = 0;
      for (const item of items) {
        try {
          await model.create({ ...item, createdBy: req.user._id });
          created++;
        } catch (e) {
          if (e.code === 11000) skipped++;
          else console.error(`Bulk import ${name} error:`, e.message);
        }
      }

      res.json({ success: true, data: { created, skipped } });
    } catch (error) {
      res.status(500).json({ success: false, error: { message: error.message } });
    }
  });

  return r;
}

// Mount all master data routes
router.use('/senders', createMasterRoutes(Sender, 'Sender'));
router.use('/pma', createMasterRoutes(PMA, 'PMA'));
router.use('/companies', createMasterRoutes(Company, 'Company'));
router.use('/countries', createMasterRoutes(Country, 'Country'));
router.use('/vendors', createMasterRoutes(Vendor, 'Vendor'));

// Get all distinct values from courier entries for each dimension
router.get('/distinct-values', authenticate, async (_req, res) => {
  try {
    const [senders, receivers, companies, couriers, countries] = await Promise.all([
      Courier.distinct('from', { isArchived: { $ne: true }, from: { $ne: '', $exists: true } }),
      Courier.distinct('to', { isArchived: { $ne: true }, to: { $ne: '', $exists: true } }),
      Courier.distinct('company', { isArchived: { $ne: true }, company: { $ne: '', $exists: true } }),
      Courier.distinct('courier', { isArchived: { $ne: true }, courier: { $ne: '', $exists: true } }),
      Courier.distinct('to', { isArchived: { $ne: true }, to: { $ne: '', $exists: true } })
    ]);

    res.json({
      success: true,
      data: {
        senders: senders.filter(Boolean).sort(),
        receivers: receivers.filter(Boolean).sort(),
        companies: companies.filter(Boolean).sort(),
        couriers: couriers.filter(Boolean).sort(),
        countries: countries.filter(Boolean).sort()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

module.exports = router;