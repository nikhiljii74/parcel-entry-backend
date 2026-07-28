const AuditLog = require('../models/AuditLog');

const trackAudit = (action) => {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      try {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          const logEntry = new AuditLog({
            action,
            user: req.user?.username || 'system',
            details: JSON.stringify({
              method: req.method,
              url: req.originalUrl,
              documentId: req.params?.id || (body && body._id) || null,
              body: req.method === 'POST' || req.method === 'PUT' ? req.body : undefined
            }),
            createdAt: new Date()
          });
          logEntry.save().catch(err => console.error('Audit log save failed:', err.message));
        }
      } catch (err) {
        console.error('Audit log error:', err.message);
      }
      return originalJson(body);
    };
    next();
  };
};

module.exports = trackAudit;