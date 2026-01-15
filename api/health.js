// File: api/health.js
// Endpoint simple untuk test apakah backend hidup

module.exports = (req, res) => {
  // Hanya return JSON sederhana
  res.status(200).json({ 
    ok: true, 
    message: "SUPO backend alive",
    timestamp: new Date().toISOString()
  });
};
