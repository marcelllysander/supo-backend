module.exports = (req, res) => {
  const server = process.env.MIDTRANS_SERVER_KEY || "";
  const client = process.env.MIDTRANS_CLIENT_KEY || "";
  const isProduction = String(process.env.MIDTRANS_IS_PRODUCTION) === "true";

  res.status(200).json({
    hasServerKey: server.length > 0,
    hasClientKey: client.length > 0,
    serverKeyPrefix: server.slice(0, 15),
    serverKeyLength: server.length,
    clientKeyPrefix: client.slice(0, 15),
    clientKeyLength: client.length,
    isProduction,
    vercelEnv: process.env.VERCEL_ENV || null,
  });
};
