const express = require('express');
const router = express.Router();
const Receiver = require('../models/Receiver');
const Courier = require('../models/Courier');
const { authenticate, authorize } = require('../middleware/auth');

// GET all receivers (with search)
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
    const receivers = await Receiver.find(filter).sort({ displayName: 1, name: 1 }).lean();
    res.json({ success: true, data: receivers });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// GET single receiver
router.get('/:id', authenticate, async (req, res) => {
  try {
    const receiver = await Receiver.findById(req.params.id).lean();
    if (!receiver) return res.status(404).json({ success: false, error: { message: 'Receiver not found' } });
    res.json({ success: true, data: receiver });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// POST create receiver (auto-populate from courier if exists)
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, displayName, company, address, country, phone, email } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: { message: 'Name is required' } });
    }
    const normalized = name.trim().toLowerCase();

    const existing = await Receiver.findOne({ name: normalized });
    if (existing) {
      return res.status(409).json({ success: false, error: { message: 'Receiver already exists' }, data: existing });
    }

    let autoCompany = company || '';
    let autoAddress = address || '';
    let autoCountry = country || '';

    if (!company || !address || !country) {
      const courierRecord = await Courier.findOne({
        $or: [
          { to: { $regex: new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
          { company: { $regex: new RegExp(normalized, 'i') } }
        ],
        isArchived: { $ne: true }
      }).sort({ createdAt: -1 }).select('company to from').lean();

      if (courierRecord) {
        if (!company) autoCompany = courierRecord.company || '';
        if (!address) autoAddress = courierRecord.to || '';
        if (!country) autoCountry = courierRecord.from || '';
      }
    }

    const receiver = new Receiver({
      name: normalized,
      displayName: displayName || name.trim(),
      company: autoCompany,
      address: autoAddress,
      country: autoCountry,
      phone: phone || '',
      email: email || '',
      createdBy: req.user._id
    });
    await receiver.save();
    res.status(201).json({ success: true, data: receiver });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// PUT update receiver
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

    const receiver = await Receiver.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
    if (!receiver) return res.status(404).json({ success: false, error: { message: 'Receiver not found' } });
    res.json({ success: true, data: receiver });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// DELETE receiver
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const receiver = await Receiver.findByIdAndDelete(req.params.id);
    if (!receiver) return res.status(404).json({ success: false, error: { message: 'Receiver not found' } });
    res.json({ success: true, message: 'Receiver deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// POST auto-populate from courier records
router.post('/auto-populate', authenticate, async (req, res) => {
  try {
    const result = await Courier.aggregate([
      { $match: { isArchived: { $ne: true }, to: { $exists: true, $ne: '' } } },
      { $group: { _id: { $toLower: { $trim: { input: '$to' } } }, original: { $first: '$to' }, company: { $first: '$company' }, from: { $first: '$from' } } },
      { $project: { _id: 0, name: '$_id', displayName: '$original', company: 1, country: '$from' } }
    ]);

    let created = 0;
    for (const item of result) {
      if (!item.name || item.name === 'unknown') continue;
      const exists = await Receiver.findOne({ name: item.name.trim().toLowerCase() });
      if (!exists) {
        await new Receiver({
          name: item.name.trim().toLowerCase(),
          displayName: item.displayName,
          company: item.company || '',
          country: item.country || ''
        }).save();
        created++;
      }
    }
    res.json({ success: true, message: `Auto-populated ${created} receivers`, created });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

module.exports = router;