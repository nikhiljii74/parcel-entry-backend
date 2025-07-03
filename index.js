const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(express.json());
app.use(cors());


const courierRoutes = require("./routes/courierRoutes");
app.use("/api/couriers", courierRoutes);


const authRoutes = require("./routes/auth");
app.use("/api/auth", authRoutes);

const auditLogRoutes = require("./routes/auditLog");  
app.use("/api/auditLogs", auditLogRoutes); 


mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected successfully");

    app.listen(5000, () => {
      console.log("🚀 Server is running on http://localhost:5000");
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed:", err);
  });
app.get('/', (req, res) => {
  res.send('🚚 Parcel Entry Backend is Live!');
});
