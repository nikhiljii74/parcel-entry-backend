const express = require('express');
const router = express.Router();
const Buyer = require('../models/Buyer');
const Courier = require('../models/Courier');
const { authenticate, authorize } = require('../middleware/auth');

// GET all buyers (with search)
router.get('/', authenticate, async (req, res) => {
  try {
    const { search, active } = req.query;
    const filter = {};
    if (active === 'true') filter.isActive = true;
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { name: regex },
        { displayName: regex },
        { company: regex },
        { email: regex },
        { phone: regex }
      ];
    }
    const buyers = await Buyer.find(filter).sort({ displayName: 1, name: 1 }).lean();
    res.json({ success: true, data: buyers });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// GET single buyer
router.get('/:id', authenticate, async (req, res) => {
  try {
    const buyer = await Buyer.findById(req.params.id).lean();
    if (!buyer) return res.status(404).json({ success: false, error: { message: 'Buyer not found' } });
    res.json({ success: true, data: buyer });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// POST create buyer (auto-populate from courier if exists)
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, displayName, company, address, country, phone, email } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: { message: 'Name is required' } });
    }
    const normalized = name.trim().toLowerCase();

    // Check duplicate (case-insensitive)
    const existing = await Buyer.findOne({ name: normalized });
    if (existing) {
      return res.status(409).json({ success: false, error: { message: 'Buyer already exists' }, data: existing });
    }

    // Auto-populate from courier records if available
    let autoCompany = company || '';
    let autoAddress = address || '';
    let autoCountry = country || '';

    if (!company || !address || !country) {
      const courierRecord = await Courier.findOne({
        $or: [
          { from: { $regex: new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
          { company: { $regex: new RegExp(normalized, 'i') } }
        ],
        isArchived: { $ne: true }
      }).sort({ createdAt: -1 }).select('company to from').lean();

      if (courierRecord) {
        if (!company) autoCompany = courierRecord.company || '';
        if (!address) autoAddress = courierRecord.from || '';
        if (!country) autoCountry = courierRecord.to || '';
      }
    }

    const buyer = new Buyer({
      name: normalized,
      displayName: displayName || name.trim(),
      company: autoCompany,
      address: autoAddress,
      country: autoCountry,
      phone: phone || '',
      email: email || '',
      createdBy: req.user._id
    });
    await buyer.save();
    res.status(201).json({ success: true, data: buyer });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// PUT update buyer
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { displayName, company, address, country, phone, email, isActive } = req.body;
    const update = {};
    if (displayName !== undefined) update.displayName = displayName;
    if (company !== undefined) update.company = company;
    if (address !== undefined) update.address = address;
    if (country !== undefined) update.country = country;
    if (phone !== undefined) update.phone = phone;
    if (email !== undefined) update.email = email;
    if (isActive !== undefined) update.isActive = isActive;

    const buyer = await Buyer.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
    if (!buyer) return res.status(404).json({ success: false, error: { message: 'Buyer not found' } });
    res.json({ success: true, data: buyer });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// DELETE buyer
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const buyer = await Buyer.findByIdAndDelete(req.params.id);
    if (!buyer) return res.status(404).json({ success: false, error: { message: 'Buyer not found' } });
    res.json({ success: true, message: 'Buyer deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// POST auto-populate from courier records
router.post('/auto-populate', authenticate, async (req, res) => {
  try {
    const result = await Courier.aggregate([
      { $match: { isArchived: { $ne: true }, from: { $exists: true, $ne: '' } } },
      { $group: { _id: { $toLower: { $trim: { input: '$from' } } }, original: { $first: '$from' }, company: { $first: '$company' }, to: { $first: '$to' } } },
      { $project: { _id: 0, name: '$_id', displayName: '$original', company: 1, country: '$to' } }
    ]);

    let created = 0;
    for (const item of result) {
      if (!item.name || item.name === 'unknown') continue;
      const exists = await Buyer.findOne({ name: item.name.trim().toLowerCase() });
      if (!exists) {
        await new Buyer({
          name: item.name.trim().toLowerCase(),
          displayName: item.displayName,
          company: item.company || '',
          country: item.country || ''
        }).save();
        created++;
      }
    }
    res.json({ success: true, message: `Auto-populated ${created} buyers`, created });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

module.exports = router;