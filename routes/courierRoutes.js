const express = require("express");
const router = express.Router();
const Courier = require("../models/Courier");
const { authenticate, authorize } = require("../middleware/auth");
const trackAudit = require("../middleware/auditLog");

// CREATE - Authenticated users only
router.post("/", authenticate, trackAudit('CREATE'), async (req, res) => {
  try {
    const existingEntry = await Courier.findOne({ awb: req.body.awb });
    if (existingEntry && req.body.awb && !req.body.awb.toUpperCase().includes('HAND') && !req.body.awb.toUpperCase().includes('CARRY')) {
      return res.status(409).json({ 
        success: false, 
        error: { code: 'DUPLICATE_AWB', message: 'AWB number already exists' } 
      });
    }

    const newEntry = new Courier({
      ...req.body,
      createdBy: req.user._id
    });
    await newEntry.save();
    res.status(201).json({ success: true, data: newEntry });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to save entry" } });
  }
});

// READ ALL - Authenticated with pagination, filtering, sorting
router.get("/", authenticate, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      search,
      company,
      courier,
      type,
      status,
      dateFrom,
      dateTo,
      location
    } = req.query;

    const filter = { isArchived: { $ne: true } };

    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [
        { company: regex },
        { courier: regex },
        { awb: regex },
        { from: regex },
        { to: regex },
        { location: regex },
        { content: regex },
        { invoiceNumber: regex }
      ];
    }

    if (company) filter.company = new RegExp(company, 'i');
    if (courier) filter.courier = new RegExp(courier, 'i');
    if (type) filter.type = type;
    if (location) filter.location = new RegExp(location, 'i');

    if (status === 'delivered') {
      filter.delivered = { $exists: true, $ne: '', $ne: null };
    } else if (status === 'pending') {
      filter.$or = filter.$or || [];
      filter.$or.push({ delivered: { $in: ['', null] } }, { delivered: { $exists: false } });
    }

    if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) filter.date.$gte = dateFrom;
      if (dateTo) filter.date.$lte = dateTo;
    }

    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [entries, total] = await Promise.all([
      Courier.find(filter).sort(sortObj).skip(skip).limit(parseInt(limit)).lean(),
      Courier.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: entries,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to fetch entries" } });
  }
});

// READ SINGLE
router.get("/:id", authenticate, async (req, res) => {
  try {
    const entry = await Courier.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ success: false, error: { message: "Entry not found" } });
    }
    res.json({ success: true, data: entry });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Failed to fetch entry" } });
  }
});

// UPDATE
router.put('/:id', authenticate, trackAudit('UPDATE'), async (req, res) => {
  try {
    const updatedEntry = await Courier.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedBy: req.user._id },
      { new: true, runValidators: true }
    );
    if (!updatedEntry) {
      return res.status(404).json({ success: false, error: { message: "Entry not found" } });
    }
    res.json({ success: true, data: updatedEntry });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: "Error updating courier entry" } });
  }
});

// SOFT DELETE (Archive)
router.delete('/:id', authenticate, trackAudit('DELETE'), async (req, res) => {
  try {
    const entry = await Courier.findByIdAndUpdate(
      req.params.id,
      { isArchived: true, archivedAt: new Date() },
      { new: true }
    );
    if (!entry) {
      return res.status(404).json({ success: false, error: { message: "Entry not found" } });
    }
    res.json({ success: true, message: "Entry archived successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: "Failed to archive entry" } });
  }
});

module.exports = router;