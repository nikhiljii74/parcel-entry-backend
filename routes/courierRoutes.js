const express = require("express");
const router = express.Router();
const Courier = require("../models/Courier");

router.post("/", async (req, res) => {
  try {
    const newEntry = new Courier(req.body);
    await newEntry.save();
    res.status(201).json(newEntry);
  } catch (error) {
    res.status(500).json({ message: "Failed to save entry", error });
  }
});


router.get("/", async (req, res) => {
  try {
    const entries = await Courier.find().sort({ createdAt: -1 });
    res.json(entries);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch entries", error });
  }
});


router.delete('/:id', async (req, res) => {
  try {
    await Courier.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Entry deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete entry", error: err });
  }
});


router.put('/:id', async (req, res) => {
  try {
    const updatedCourier = await Courier.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    res.status(200).json(updatedCourier);
  } catch (error) {
    res.status(500).json({ message: "Error updating courier entry", error });
  }
});

module.exports = router;
