/**
 * server.js
 * CSP Demo (sử dụng cấu trúc thư mục bạn cung cấp)
 *
 * Routes:
 *  - /blocked
 *  - /hash
 *  - /nonce
 *  - /report-log  (giao diện realtime)
 *  - /api/logs    (API trả logs JSON)
 *  - /csp-report  (nhận CSP violation reports)
 *  - /analyze     (biểu đồ thống kê)
 *
 * Logs được lưu vào logs/violations.json (utils/logger.js)
 */
require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const {
  saveViolation,
  loadViolations,
  mergeDataFile,
} = require("./utils/logger");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3001;
const HOST = `http://localhost:${PORT}`;

// Middlewares
app.use(compression());
app.use(express.json({ type: ["application/json", "application/csp-report"] }));

// Development helper: disable aggressive caching for CSS/JS so updates apply immediately in browser
app.use((req, res, next) => {
  if (req.url && (req.url.endsWith(".css") || req.url.endsWith(".js"))) {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
    );
  }
  next();
});

app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));

// Ensure logs are loaded; if data/violations.json exists, merge into logs/violations.json
mergeDataFile(); // safe to call (no-op if no data/ file)

let cspViolations = loadViolations(); // in-memory cache

// helpers
function generateNonce() {
  return crypto.randomBytes(16).toString("base64");
}

// Root page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* --------------------------- Demo routes --------------------------- */

// /blocked  -> CSP blocks inline scripts
app.get("/blocked", (req, res) => {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    `report-uri ${HOST}/csp-report`,
  ].join("; ");
  res.setHeader("Content-Security-Policy", csp);
  res.sendFile(path.join(__dirname, "public", "blocked.html"));
});

// /hash -> compute sha256 of the exact inline script used in public/hash.html
app.get("/hash", (req, res) => {
  const htmlPath = path.join(__dirname, "public/hash.html");
  const csp = [
    "default-src 'self'",
    `script-src 'self' '${process.env.HASH_CSP}'`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    `report-uri ${HOST}/csp-report`, // <-- thêm dòng này
  ].join("; ");

  res.setHeader("Content-Security-Policy", csp);
  res.sendFile(htmlPath);
});
// /nonce -> generate nonce per response and inject into template
app.get("/nonce", (req, res) => {
  const nonce = generateNonce();
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    `report-uri ${HOST}/csp-report`,
  ].join("; ");
  res.setHeader("Content-Security-Policy", csp);

  const tplPath = path.join(__dirname, "public", "nonce_template.html");
  fs.readFile(tplPath, "utf8", (err, html) => {
    if (err) return res.status(500).send("Server error");
    const out = html.replace(/{{NONCE}}/g, nonce);
    res.send(out);
  });
});

/* --------------------------- Reporting --------------------------- */

// Accept CSP violation reports
app.post("/csp-report", (req, res) => {
  // Browsers typically send { "csp-report": { ... } } but some may send different shapes
  try {
    const body = req.body;
    let reportObj = null;
    if (body && body["csp-report"]) {
      reportObj = body["csp-report"];
    } else if (body && Object.keys(body).length > 0) {
      // accept raw body as a report
      reportObj = body;
    }
    if (reportObj) {
      reportObj.timestamp = new Date().toLocaleString("vi-VN");
      cspViolations.push(reportObj);
      saveViolation(reportObj);
      io.emit("newViolation", reportObj);
      console.log(
        "⚠️ CSP report saved:",
        reportObj["violated-directive"] || "unknown"
      );
    } else {
      console.warn("Received empty/unknown csp-report body:", body);
    }
  } catch (err) {
    console.error("Error handling csp-report:", err);
  }
  // Always respond 204 No Content for CSP reports
  res.status(204).end();
});

/* --------------------------- Dashboard / API --------------------------- */

app.get("/report-log", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "report_log.html"));
});

// API to return logs
app.get("/api/logs", (req, res) => {
  res.json(cspViolations);
});

// Analyzer page (if present)
app.get("/analyze", (req, res) => {
  const file = path.join(__dirname, "public", "analyze.html");
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send("Analyzer not available");
});

// --------------------------- Pass logging ---------------------------
let cspPasses = []; // array lưu pass

// Nhận log pass từ client
app.post("/api/log-pass", (req, res) => {
  const body = req.body;
  if (body) {
    cspPasses.push(body);
    console.log("✅ Script pass:", body.page);
  }
  res.status(204).end();
});

// API trả về cả pass + fail
app.get("/api/logs-full", (req, res) => {
  res.json({
    fail: cspViolations,
    pass: cspPasses,
  });
});

/* --------------------------- Socket.IO (realtime) --------------------------- */

io.on("connection", (socket) => {
  // send initial logs
  socket.emit("initLogs", cspViolations);
  console.log("📡 Dashboard client connected");
});

/* --------------------------- Start --------------------------- */

server.listen(PORT, () => {
  console.log(`🚀 CSP Demo running at ${HOST}`);
  console.log("Open /report-log for the dashboard, /analyze for charts.");
});
