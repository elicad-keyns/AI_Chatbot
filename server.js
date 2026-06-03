const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const OPENAI_URL = "https://api.openai.com/v1/responses";
const MAX_BODY_BYTES = 1024 * 1024;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let body = "";

    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function safeStaticPath(urlPath) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const decodedPath = decodeURIComponent(cleanPath.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, decodedPath));
  return filePath.startsWith(PUBLIC_DIR) ? filePath : null;
}

async function handleOpenAiProxy(req, res) {
  try {
    const rawBody = await readRequestBody(req);
    const payload = JSON.parse(rawBody || "{}");
    const apiKey = String(payload.apiKey || process.env.OPENAI_API_KEY || "").trim();
    const requestBody = payload.requestBody;

    if (!apiKey) {
      sendJson(res, 400, {
        error: "API key is required. Enter it in the settings panel or set OPENAI_API_KEY on Railway."
      });
      return;
    }

    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
      sendJson(res, 400, {
        error: "requestBody must be a JSON object."
      });
      return;
    }

    const openAiResponse = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    const responseText = await openAiResponse.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { raw: responseText };
    }

    sendJson(res, openAiResponse.status, {
      ok: openAiResponse.ok,
      status: openAiResponse.status,
      statusText: openAiResponse.statusText,
      data
    });
  } catch (error) {
    const statusCode = error.message.includes("large") ? 413 : 500;
    sendJson(res, statusCode, {
      error: error.message
    });
  }
}

function serveStatic(req, res) {
  const filePath = safeStaticPath(req.url);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream"
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/openai") {
    handleOpenAiProxy(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
});

server.listen(PORT, () => {
  console.log(`OpenAI API parameter lab is running on http://localhost:${PORT}`);
});
