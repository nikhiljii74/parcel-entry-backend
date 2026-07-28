const express = require("express");
const router = express.Router();
const { OpenAI } = require("openai");
const { authenticate } = require("../middleware/auth");
const Courier = require("../models/Courier");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const AIChat = require("../models/AIChat");

// Initialize DeepSeek client (OpenAI-compatible)
const getDeepSeekClient = () => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  if (!apiKey || apiKey === 'sk-placeholder') return null;
  return new OpenAI({ apiKey, baseURL });
};

// --- SYSTEM PROMPTS ---
const SYSTEM_PROMPTS = {
  default: `You are an AI logistics assistant for Premier Asia Courier Management System. 
Answer questions using the MongoDB data provided in context. Be concise, professional, and data-driven.
Use markdown for formatting when appropriate. Never make up data — only report what's in the provided context.`,

  mis: `You are an AI MIS (Management Information System) generator for a logistics company.
Generate professional MIS reports using the MongoDB data provided. Structure reports with:
1. Executive Summary
2. Key Performance Indicators
3. Operational Analysis
4. Trends & Insights
5. Recommendations

Use markdown tables and bullet points. Be data-driven and specific.`,

  insights: `You are an AI business analyst for a logistics company.
Generate actionable business insights from the provided data. Focus on:
1. Operational efficiency
2. Delivery performance
3. Volume trends
4. Risk areas
5. Recommendations for improvement
Be specific with numbers and percentages.`,

  forecast: `You are an AI predictive analytics specialist for logistics.
Analyze historical trends from the provided data and generate forecasts for:
1. Expected shipment volume
2. Delivery timelines
3. Potential bottlenecks
4. Resource recommendations
Base predictions on observable patterns in the data.`,

  search: `You are an AI search assistant for a courier management database.
Translate natural language queries into structured data interpretations.
Extract filters like: date ranges, courier names, companies, statuses, locations.
Return the structured filter parameters that can be used to query the database.`
};

// --- HELPERS ---
function generateSessionId() {
  return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

async function fetchMongoDBContext(query = {}) {
  const filter = { isArchived: { $ne: true }, ...query };
  const [total, delivered, pending, incoming, outgoing, recentEntries, users, auditCount] = await Promise.all([
    Courier.countDocuments(filter),
    Courier.countDocuments({ ...filter, delivered: { $exists: true, $ne: '', $nin: [null, ''] } }),
    Courier.countDocuments({ ...filter, $or: [{ delivered: { $in: ['', null] } }, { delivered: { $exists: false } }] }),
    Courier.countDocuments({ ...filter, type: 'Incoming' }),
    Courier.countDocuments({ ...filter, type: 'Outgoing' }),
    Courier.find(filter).sort({ createdAt: -1 }).limit(10).select('date company courier awb type delivered price').lean(),
    User.countDocuments(),
    AuditLog.countDocuments()
  ]);

  return {
    stats: { total, delivered, pending, incoming, outgoing, users, auditLogs: auditCount },
    recentEntries: recentEntries.map(e => ({
      date: e.date, company: e.company, courier: e.courier, awb: e.awb, type: e.type, delivered: !!e.delivered, price: e.price
    })),
    timestamp: new Date().toISOString()
  };
}

async function callDeepSeek(messages, options = {}) {
  const client = getDeepSeekClient();
  if (!client) {
    return { success: false, error: 'DeepSeek API key not configured. Set DEEPSEEK_API_KEY in .env' };
  }

  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  const temperature = parseFloat(process.env.DEEPSEEK_TEMPERATURE || '0.7');
  const maxTokens = parseInt(process.env.DEEPSEEK_MAX_TOKENS || '2048');

  try {
    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature: options.temperature || temperature,
      max_tokens: options.maxTokens || maxTokens,
      stream: false,
    });

    return {
      success: true,
      content: completion.choices[0]?.message?.content || '',
      usage: completion.usage
    };
  } catch (error) {
    console.error('DeepSeek API error:', error.message);
    return { success: false, error: `AI service error: ${error.message}` };
  }
}

// ============================================================
// AI CHAT
// ============================================================

// Send message to AI chat
router.post("/chat", authenticate, async (req, res) => {
  try {
    const { message, sessionId: existingSessionId } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: { message: 'Message is required' } });
    }

    const sessionId = existingSessionId || generateSessionId();
    const userId = req.user._id;

    // Fetch MongoDB context
    const dbContext = await fetchMongoDBContext();

    // Build messages array
    const messages = [
      { role: 'system', content: SYSTEM_PROMPTS.default },
      { role: 'system', content: `Current database context (${new Date().toISOString()}):\n${JSON.stringify(dbContext, null, 2)}` },
      { role: 'user', content: message }
    ];

    // Call DeepSeek
    const aiResponse = await callDeepSeek(messages);

    // Save to chat history
    const chatData = {
      userId,
      sessionId,
      title: message.length > 50 ? message.substring(0, 50) + '...' : message,
      messages: [
        { role: 'user', content: message, timestamp: new Date() },
        { role: 'assistant', content: aiResponse.success ? aiResponse.content : `Error: ${aiResponse.error}`, timestamp: new Date() }
      ]
    };

    await AIChat.findOneAndUpdate(
      { sessionId, userId },
      {
        $setOnInsert: { userId, sessionId, title: message.substring(0, 100) },
        $push: { messages: { $each: chatData.messages } },
        $set: { updatedAt: new Date() }
      },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      data: {
        sessionId,
        response: aiResponse.success ? aiResponse.content : aiResponse.error,
        error: aiResponse.success ? null : aiResponse.error
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: 'AI chat failed', details: error.message } });
  }
});

// Get chat history
router.get("/chat/history", authenticate, async (req, res) => {
  try {
    const sessions = await AIChat.find({ userId: req.user._id })
      .select('sessionId title pinned createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();

    res.json({ success: true, data: sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: 'Failed to fetch chat history' } });
  }
});

// Get single chat session with messages
router.get("/chat/session/:sessionId", authenticate, async (req, res) => {
  try {
    const chat = await AIChat.findOne({ sessionId: req.params.sessionId, userId: req.user._id }).lean();
    if (!chat) return res.status(404).json({ success: false, error: { message: 'Chat session not found' } });

    res.json({ success: true, data: chat });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: 'Failed to fetch chat session' } });
  }
});

// Toggle pin chat
router.post("/chat/pin/:sessionId", authenticate, async (req, res) => {
  try {
    const chat = await AIChat.findOne({ sessionId: req.params.sessionId, userId: req.user._id });
    if (!chat) return res.status(404).json({ success: false, error: { message: 'Chat session not found' } });

    chat.pinned = !chat.pinned;
    await chat.save();

    res.json({ success: true, data: { pinned: chat.pinned } });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: 'Failed to toggle pin' } });
  }
});

// Clear chat history (delete all sessions for user)
router.delete("/chat/history", authenticate, async (req, res) => {
  try {
    await AIChat.deleteMany({ userId: req.user._id });
    res.json({ success: true, message: 'Chat history cleared' });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: 'Failed to clear chat history' } });
  }
});

// Delete single session
router.delete("/chat/session/:sessionId", authenticate, async (req, res) => {
  try {
    await AIChat.deleteOne({ sessionId: req.params.sessionId, userId: req.user._id });
    res.json({ success: true, message: 'Chat session deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: 'Failed to delete chat session' } });
  }
});

// ============================================================
// AI MIS GENERATOR
// ============================================================

router.post("/mis", authenticate, async (req, res) => {
  try {
    const { type = 'daily', dateFrom, dateTo } = req.body;
    const validTypes = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'executive', 'courier_performance', 'customer'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ success: false, error: { message: `Invalid MIS type. Valid: ${validTypes.join(', ')}` } });
    }

    // Determine date range
    const now = new Date();
    let startDate, endDate;
    if (dateFrom && dateTo) {
      startDate = dateFrom;
      endDate = dateTo;
    } else {
      endDate = now.toISOString().split('T')[0];
      switch (type) {
        case 'daily':
          startDate = endDate;
          break;
        case 'weekly': {
          const d = new Date(now);
          d.setDate(d.getDate() - 7);
          startDate = d.toISOString().split('T')[0];
          break;
        }
        case 'monthly': {
          const d = new Date(now.getFullYear(), now.getMonth(), 1);
          startDate = d.toISOString().split('T')[0];
          break;
        }
        case 'quarterly': {
          const d = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
          startDate = d.toISOString().split('T')[0];
          break;
        }
        case 'yearly': {
          startDate = `${now.getFullYear()}-01-01`;
          break;
        }
        default:
          startDate = '';
      }
    }

    // Fetch comprehensive data
    const dateFilter = {};
    if (startDate) dateFilter.$gte = startDate;
    if (endDate) dateFilter.$lte = endDate;

    const queryFilter = { isArchived: { $ne: true } };
    if (startDate || endDate) queryFilter.date = dateFilter;

    const entries = await Courier.find(queryFilter).lean();
    const total = entries.length;
    const delivered = entries.filter(e => e.delivered).length;
    const pending = entries.filter(e => !e.delivered).length;
    const incoming = entries.filter(e => e.type === 'Incoming').length;
    const outgoing = entries.filter(e => e.type === 'Outgoing').length;
    let totalExpenditure = 0;
    entries.forEach(e => { const p = parseFloat(e.price || '0'); if (!isNaN(p)) totalExpenditure += p; });

    // Courier breakdown
    const courierCounts = {};
    entries.forEach(e => { const c = e.courier || 'Unknown'; courierCounts[c] = (courierCounts[c] || 0) + 1; });

    // Company breakdown
    const companyCounts = {};
    entries.forEach(e => { const c = e.company || 'Unknown'; companyCounts[c] = (companyCounts[c] || 0) + 1; });

    // Daily trend for period
    const dailyCounts = {};
    entries.forEach(e => { if (e.date) dailyCounts[e.date] = (dailyCounts[e.date] || 0) + 1; });

    // Build context for AI
    const misContext = {
      reportType: type,
      period: { start: startDate || 'All time', end: endDate || 'All time' },
      generatedAt: new Date().toISOString(),
      stats: { total, delivered, pending, incoming, outgoing, totalExpenditure, deliveryRate: total > 0 ? Math.round((delivered / total) * 100) : 0 },
      topCouriers: Object.entries(courierCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
      topCompanies: Object.entries(companyCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
      dailyTrend: Object.entries(dailyCounts).sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count })),
      totalEntries: entries.length
    };

    const messages = [
      { role: 'system', content: SYSTEM_PROMPTS.mis },
      { role: 'system', content: `MIS Data for ${type.toUpperCase()} report:\n${JSON.stringify(misContext, null, 2)}` },
      { role: 'user', content: `Generate a professional ${type} MIS report for Premier Asia Courier Management System.` }
    ];

    const aiResponse = await callDeepSeek(messages);

    res.json({
      success: true,
      data: {
        type,
        period: misContext.period,
        stats: misContext.stats,
        topCouriers: misContext.topCouriers,
        topCompanies: misContext.topCompanies,
        dailyTrend: misContext.dailyTrend,
        report: aiResponse.success ? aiResponse.content : `Error generating MIS: ${aiResponse.error}`,
        generatedAt: misContext.generatedAt
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: 'MIS generation failed', details: error.message } });
  }
});

// ============================================================
// AI BUSINESS INSIGHTS
// ============================================================

router.get("/insights", authenticate, async (req, res) => {
  try {
    const dbContext = await fetchMongoDBContext();
    const entries = await Courier.find({ isArchived: { $ne: true } }).select('date price weight content company courier type delivered').lean();

    // Additional analysis
    const missingData = entries.filter(e => !e.weight || !e.price || !e.content).length;

    const awbCounts = {};
    entries.forEach(e => { if (e.awb) awbCounts[e.awb.toUpperCase()] = (awbCounts[e.awb.toUpperCase()] || 0) + 1; });
    const duplicates = Object.values(awbCounts).filter(c => c > 1).length;

    const messages = [
      { role: 'system', content: SYSTEM_PROMPTS.insights },
      { role: 'system', content: `Current database snapshot:\n${JSON.stringify({ ...dbContext, missingData, duplicates, totalRows: entries.length }, null, 2)}` },
      { role: 'user', content: 'Generate comprehensive business insights and recommendations.' }
    ];

    const aiResponse = await callDeepSeek(messages);

    res.json({
      success: true,
      data: {
        stats: dbContext.stats,
        alerts: { duplicates, missingData, criticalPending: dbContext.stats.pending },
        insights: aiResponse.success ? aiResponse.content : aiResponse.error,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: 'Insights generation failed' } });
  }
});

// ============================================================
// AI FORECAST
// ============================================================

router.post("/forecast", authenticate, async (req, res) => {
  try {
    const { period = 30 } = req.body; // days to look ahead

    // Get historical data for trend analysis
    const entries = await Courier.find({ isArchived: { $ne: true } })
      .select('date type delivered createdAt')
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();

    // Aggregate daily counts for last N days
    const dailyData = {};
    entries.forEach(e => {
      if (e.date) dailyData[e.date] = (dailyData[e.date] || 0) + 1;
    });

    const sortedDays = Object.entries(dailyData).sort((a, b) => a[0].localeCompare(b[0]));
    const volumes = sortedDays.map(([, c]) => c);
    const avgVolume = volumes.length > 0 ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length) : 0;
    const maxVolume = volumes.length > 0 ? Math.max(...volumes) : 0;
    const minVolume = volumes.length > 0 ? Math.min(...volumes) : 0;

    const messages = [
      { role: 'system', content: SYSTEM_PROMPTS.forecast },
      { role: 'system', content: `Historical data for forecasting (${period} day look-ahead):\n${JSON.stringify({
        dailyVolumes: sortedDays.slice(-90), // Last 90 days
        stats: { avgVolume, maxVolume, minVolume, totalDays: sortedDays.length, totalEntries: entries.length },
        period
      }, null, 2)}` },
      { role: 'user', content: `Generate a ${period}-day forecast for shipment volumes, delivery timelines, and potential bottlenecks.` }
    ];

    const aiResponse = await callDeepSeek(messages);

    res.json({
      success: true,
      data: {
        forecast: aiResponse.success ? aiResponse.content : aiResponse.error,
        historicalData: {
          dailyVolumes: sortedDays.slice(-30),
          avgVolume,
          maxVolume,
          minVolume
        },
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: 'Forecast generation failed' } });
  }
});

// ============================================================
// AI SEARCH (Natural Language → Query Params)
// ============================================================

router.post("/search", authenticate, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || !query.trim()) {
      return res.status(400).json({ success: false, error: { message: 'Search query is required' } });
    }

    const dbContext = await fetchMongoDBContext();

    const messages = [
      { role: 'system', content: SYSTEM_PROMPTS.search },
      { role: 'system', content: `Available couriers: ${dbContext.recentEntries.map(e => e.courier).filter(Boolean).join(', ')}\nAvailable companies: ${dbContext.recentEntries.map(e => e.company).filter(Boolean).join(', ')}` },
      { role: 'user', content: `Parse this natural language query into structured search parameters: "${query}"\nReturn ONLY a JSON object with possible keys: search, company, courier, type, status, dateFrom, dateTo, location. If no relevant filter found, return {}.` }
    ];

    const aiResponse = await callDeepSeek(messages, { temperature: 0.3 });

    let searchParams = {};
    if (aiResponse.success) {
      try {
        // Extract JSON from response
        const match = aiResponse.content.match(/\{[\s\S]*\}/);
        if (match) searchParams = JSON.parse(match[0]);
      } catch {
        // Use whole query as search term
        searchParams = { search: query };
      }
    }

    // Execute search
    const dbQuery = { isArchived: { $ne: true } };
    if (searchParams.search) {
      const regex = new RegExp(searchParams.search, 'i');
      dbQuery.$or = [{ company: regex }, { courier: regex }, { awb: regex }, { location: regex }, { from: regex }, { to: regex }, { content: regex }];
    }
    if (searchParams.company) dbQuery.company = new RegExp(searchParams.company, 'i');
    if (searchParams.courier) dbQuery.courier = new RegExp(searchParams.courier, 'i');
    if (searchParams.type) dbQuery.type = searchParams.type;
    if (searchParams.location) dbQuery.location = new RegExp(searchParams.location, 'i');
    if (searchParams.status === 'delivered') dbQuery.delivered = { $exists: true, $ne: '', $nin: [null, ''] };
    if (searchParams.status === 'pending') dbQuery.$or = [{ delivered: { $in: ['', null] } }, { delivered: { $exists: false } }];
    if (searchParams.dateFrom || searchParams.dateTo) {
      dbQuery.date = {};
      if (searchParams.dateFrom) dbQuery.date.$gte = searchParams.dateFrom;
      if (searchParams.dateTo) dbQuery.date.$lte = searchParams.dateTo;
    }

    const results = await Courier.find(dbQuery).sort({ createdAt: -1 }).limit(50).lean();

    res.json({
      success: true,
      data: {
        parsedQuery: searchParams,
        resultsCount: results.length,
        results,
        aiInterpretation: aiResponse.content
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: 'AI search failed', details: error.message } });
  }
});

// ============================================================
// AI RECOMMENDATIONS
// ============================================================

router.get("/recommendations", authenticate, async (req, res) => {
  try {
    const dbContext = await fetchMongoDBContext();
    const entries = await Courier.find({ isArchived: { $ne: true } }).select('date price weight content company courier type delivered').lean();
    const missingData = entries.filter(e => !e.weight || !e.price || !e.content).length;

    const messages = [
      { role: 'system', content: 'You are an AI logistics consultant. Provide 5-7 actionable recommendations based on the data. Each recommendation should have a title and description. Return as markdown with bullet points.' },
      { role: 'system', content: `Database context:\n${JSON.stringify({ ...dbContext, missingData, totalRecords: entries.length }, null, 2)}` },
      { role: 'user', content: 'Generate actionable recommendations to improve logistics operations, reduce costs, and improve delivery performance.' }
    ];

    const aiResponse = await callDeepSeek(messages);

    res.json({
      success: true,
      data: {
        recommendations: aiResponse.success ? aiResponse.content : aiResponse.error,
        stats: dbContext.stats,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { message: 'Recommendations generation failed' } });
  }
});

module.exports = router;