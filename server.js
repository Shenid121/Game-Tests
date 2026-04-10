const crypto = require("crypto");
const express = require("express");
const http = require("http");
const path = require("path");
const QRCode = require("qrcode");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const sessions = new Map();

function randomToken(size = 16) {
  return crypto.randomBytes(size).toString("hex");
}

function safeTeamName(name, fallback) {
  const cleaned = String(name || "").trim().slice(0, 32);
  return cleaned || fallback;
}

function makeBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").trim().toLowerCase();
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : (req.protocol || "http");
  const host = String(req.get("host") || "").trim();
  if (!host) {
    return "http://localhost:3000";
  }
  return `${proto}://${host}`;
}

function normalizeBaseUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return "";
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;

  try {
    const url = new URL(withScheme);
    if (!(url.protocol === "http:" || url.protocol === "https:")) {
      return "";
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

app.post("/api/session", async (req, res) => {
  try {
    const teamAName = safeTeamName(req.body?.teamAName, "Team A");
    const teamBName = safeTeamName(req.body?.teamBName, "Team B");

    const sessionId = randomToken(10);
    const hostKey = randomToken(18);
    const tokenA = randomToken(12);
    const tokenB = randomToken(12);

    const bodyBaseUrl = normalizeBaseUrl(req.body?.publicBaseUrl);
    const envBaseUrl = normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
    const baseUrl = bodyBaseUrl || envBaseUrl || makeBaseUrl(req);
    const urlA = `${baseUrl}/phone.html?session=${encodeURIComponent(sessionId)}&team=A&token=${encodeURIComponent(tokenA)}&name=${encodeURIComponent(teamAName)}`;
    const urlB = `${baseUrl}/phone.html?session=${encodeURIComponent(sessionId)}&team=B&token=${encodeURIComponent(tokenB)}&name=${encodeURIComponent(teamBName)}`;

    const [qrADataUrl, qrBDataUrl] = await Promise.all([
      QRCode.toDataURL(urlA, { margin: 1, width: 260 }),
      QRCode.toDataURL(urlB, { margin: 1, width: 260 })
    ]);

    sessions.set(sessionId, {
      createdAt: Date.now(),
      hostKey,
      activeTeam: null,
      tokens: { A: tokenA, B: tokenB },
      hostSocket: null,
      phoneSockets: { A: new Set(), B: new Set() }
    });

    res.json({
      sessionId,
      hostKey,
      qrADataUrl,
      qrBDataUrl,
      urlA,
      urlB
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to create phone session" });
  }
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const role = url.searchParams.get("role");
  const sessionId = url.searchParams.get("session");

  if (!sessionId || !sessions.has(sessionId)) {
    ws.close(1008, "Invalid session");
    return;
  }

  const session = sessions.get(sessionId);
  ws._sessionId = sessionId;
  ws._role = role;

  if (role === "host") {
    const hostKey = url.searchParams.get("hostKey") || "";
    if (hostKey !== session.hostKey) {
      ws.close(1008, "Unauthorized host");
      return;
    }

    session.hostSocket = ws;
    sendJson(ws, { type: "host-ready" });
  } else if (role === "phone") {
    const team = (url.searchParams.get("team") || "").toUpperCase();
    const token = url.searchParams.get("token") || "";

    if (!(team === "A" || team === "B") || token !== session.tokens[team]) {
      ws.close(1008, "Unauthorized phone" );
      return;
    }

    ws._team = team;
    session.phoneSockets[team].add(ws);
    sendJson(ws, { type: "phone-ready", team });

    if (session.activeTeam === "A" || session.activeTeam === "B") {
      sendJson(ws, { type: "active-team", team: session.activeTeam });
    }

    if (session.hostSocket) {
      sendJson(session.hostSocket, {
        type: "presence",
        connectedA: session.phoneSockets.A.size,
        connectedB: session.phoneSockets.B.size
      });
    }
  } else {
    ws.close(1008, "Invalid role");
    return;
  }

  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (ws._role === "host") {
      if (msg?.type === "active-team") {
        const requested = String(msg.team || "").toUpperCase();
        const team = requested === "A" || requested === "B" || requested === "BOTH" || requested === "NONE"
          ? requested
          : "A";
        session.activeTeam = team;
        for (const phoneWs of session.phoneSockets.A) {
          sendJson(phoneWs, { type: "active-team", team });
        }
        for (const phoneWs of session.phoneSockets.B) {
          sendJson(phoneWs, { type: "active-team", team });
        }
      }
      return;
    }

    if (ws._role === "phone" && msg?.type === "pick") {
      const value = Number(msg.value);
      if (!Number.isInteger(value) || value < 1 || value > 4) {
        return;
      }

      if (session.hostSocket) {
        sendJson(session.hostSocket, {
          type: "phone-pick",
          team: ws._team,
          value
        });
      }
    }
  });

  ws.on("close", () => {
    if (ws._role === "host") {
      if (session.hostSocket === ws) {
        session.hostSocket = null;
      }
      return;
    }

    if (ws._role === "phone" && (ws._team === "A" || ws._team === "B")) {
      session.phoneSockets[ws._team].delete(ws);
      if (session.hostSocket) {
        sendJson(session.hostSocket, {
          type: "presence",
          connectedA: session.phoneSockets.A.size,
          connectedB: session.phoneSockets.B.size
        });
      }
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    const hasSockets = Boolean(session.hostSocket) || session.phoneSockets.A.size > 0 || session.phoneSockets.B.size > 0;
    const isExpired = now - session.createdAt > 1000 * 60 * 60 * 6;
    if (!hasSockets && isExpired) {
      sessions.delete(sessionId);
    }
  }
}, 60_000);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Jungle Sort Showdown running on http://localhost:${port}`);
});