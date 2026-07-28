// File: seed.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./models/User'); // User Model import kiya
require('dotenv').config(); // Database connection ke liye

const seedUsers = async () => {
  try {
    // 1. Database Connect karein
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Database Connected for Seeding...");

    // 2. Purane Saare Users Delete karein (Clean Start)
    await User.deleteMany({});
    console.log("🗑️  Old Users Deleted.");

    // 3. Passwords ko Encrypt (Hash) karein
    const adminPassword = await bcrypt.hash("admin123", 10); 
    const pmaPassword = await bcrypt.hash("pma123", 10);     
    // 4. Naye Users Tayar karein
    const users = [
      {
        username: "admin",
        password: adminPassword,
        role: "admin",      // Iske paas Shield Icon dikhega
        isBlocked: false,
        device: "Server Created",
        isOnline: false
      },
      {
        username: "pma",
        password: pmaPassword,
        role: "staff",      // Iske paas Shield Icon NAHI dikhega
        isBlocked: false,
        device: "Server Created",
        isOnline: false
      }
    ];

    // 5. Database mein Save karein
    await User.insertMany(users);
    console.log("🎉 SUCCESS! 2 Users Created:");
    console.log("   1. Username: admin | Password: admin123");
    console.log("   2. Username: pma   | Password: pma123");

    // 6. Connection Band karein
    mongoose.connection.close();
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
};

seedUsers();