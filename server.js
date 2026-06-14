const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ChatAgent = require("./agent");
const UserStore = require("./userStore");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const OPENAI_URL = "https://api.openai.com/v1/responses";
const MAX_BODY_BYTES = 1024 * 1024;
const chatAgent = new ChatAgent();
const userStore = new UserStore();
const sessions = new Map();
const SESSION_COOKIE = "chat_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

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

function sendAuthRequired(res) {
  sendJson(res, 401, { error: "Authentication required." });
}

function sendSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getUrl(req) {
  return new URL(req.url, `http://${req.headers.host || "localhost"}`);
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) return cookies;
      const name = decodeURIComponent(part.slice(0, separatorIndex));
      const value = decodeURIComponent(part.slice(separatorIndex + 1));
      cookies[name] = value;
      return cookies;
    }, {});
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
}

function getAuthenticatedUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  const user = userStore.getUserById(session.userId);
  if (!user) {
    sessions.delete(token);
    return null;
  }

  return user;
}

function createSession(res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    userId: user.id,
    expiresAt: Date.now() + (SESSION_MAX_AGE_SECONDS * 1000)
  });
  setSessionCookie(res, token);
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

async function handleChatStream(req, res) {
  let abortController;

  try {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendAuthRequired(res);
      return;
    }

    const rawBody = await readRequestBody(req);
    const payload = JSON.parse(rawBody || "{}");
    const apiKey = String(payload.apiKey || process.env.OPENAI_API_KEY || "").trim();
    const chatId = String(payload.chatId || "").trim();
    const message = String(payload.message || "").trim();
    const model = String(payload.model || "").trim();
    const compressionEnabled = typeof payload.compressionEnabled === "boolean"
      ? payload.compressionEnabled
      : undefined;
    const summaryBatchSize = Number(payload.summaryBatchSize || 0) || undefined;
    const contextStrategy = String(payload.contextStrategy || "").trim() || undefined;
    const windowSize = Number(payload.windowSize || 0) || undefined;

    if (!apiKey) {
      sendJson(res, 400, {
        error: "API key is required. Set OPENAI_API_KEY on Railway or enter a key in chat settings."
      });
      return;
    }

    if (!message) {
      sendJson(res, 400, {
        error: "Message is required."
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    await chatAgent.streamResponse({
      apiKey,
      userId: user.id,
      chatId,
      message,
      model,
      compressionEnabled,
      summaryBatchSize,
      contextStrategy,
      windowSize,
      signal: abortController.signal,
      onReady: (chat) => {
        if (!res.writableEnded) {
          sendSse(res, "chat", {
            chat: {
              id: chat.id,
              title: chat.title,
              updatedAt: chat.updatedAt,
              messageCount: chat.messageCount,
              settings: chat.settings || null,
              memory: chat.memory || null,
              activeBranchId: chat.activeBranchId || null,
              activeBranchName: chat.activeBranchName || null,
              branches: chat.branches || [],
              checkpoint: chat.checkpoint || null
            }
          });
        }
      },
      onText: (delta) => {
        if (!res.writableEnded) {
          sendSse(res, "delta", { delta });
        }
      },
      onComplete: ({ response, chat }) => {
        if (!res.writableEnded) {
          sendSse(res, "meta", {
            id: response?.id || null,
            model: response?.model || model || null,
            usage: response?.usage || null,
            tokenStats: chat?.tokenStats || null,
            chat: chat
              ? {
                id: chat.id,
                title: chat.title,
                updatedAt: chat.updatedAt,
                messageCount: chat.messageCount,
                settings: chat.settings || null,
                memory: chat.memory || null,
                activeBranchId: chat.activeBranchId || null,
                activeBranchName: chat.activeBranchName || null,
                branches: chat.branches || [],
                checkpoint: chat.checkpoint || null,
                tokenStats: chat.tokenStats || null
              }
              : null
          });
        }
      }
    });

    if (!res.writableEnded) {
      sendSse(res, "done", {});
      res.end();
    }
  } catch (error) {
    if (error.name === "AbortError") return;

    if (res.headersSent) {
      if (!res.writableEnded) {
        sendSse(res, "error", { error: error.message });
        res.end();
      }
      return;
    }

    sendJson(res, error.message.includes("large") ? 413 : 500, {
      error: error.message
    });
  }
}

async function handleChatTokenPreview(req, res) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    sendAuthRequired(res);
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const rawBody = await readRequestBody(req);
  const payload = JSON.parse(rawBody || "{}");
  const tokenStats = chatAgent.getTokenSummary({
    userId: user.id,
    chatId: String(payload.chatId || "").trim(),
    message: String(payload.message || ""),
    model: String(payload.model || ""),
    compressionEnabled: typeof payload.compressionEnabled === "boolean"
      ? payload.compressionEnabled
      : undefined,
    summaryBatchSize: Number(payload.summaryBatchSize || 0) || undefined,
    contextStrategy: String(payload.contextStrategy || "").trim() || undefined,
    windowSize: Number(payload.windowSize || 0) || undefined
  });

  sendJson(res, 200, { tokenStats });
}

async function handleChats(req, res) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    sendAuthRequired(res);
    return;
  }

  const url = getUrl(req);
  const parts = url.pathname.split("/").filter(Boolean);
  const chatId = parts[2] || "";

  if (parts.length === 2 && req.method === "GET") {
    sendJson(res, 200, {
      chats: chatAgent.listChats(user.id)
    });
    return;
  }

  if (parts.length === 2 && req.method === "POST") {
    const rawBody = await readRequestBody(req);
    const payload = JSON.parse(rawBody || "{}");
    const chat = chatAgent.createChat(user.id, {
      title: payload.title,
      settings: {
        compressionEnabled: payload.compressionEnabled !== false,
        summaryBatchSize: payload.summaryBatchSize,
        contextStrategy: payload.contextStrategy,
        windowSize: payload.windowSize
      }
    });

    sendJson(res, 201, { chat });
    return;
  }

  if (parts.length === 3 && req.method === "GET") {
    const chat = chatAgent.getChat(user.id, chatId);
    if (!chat) {
      sendJson(res, 404, { error: "Chat not found." });
      return;
    }

    sendJson(res, 200, { chat });
    return;
  }

  if (parts.length === 3 && req.method === "PATCH") {
    const rawBody = await readRequestBody(req);
    const payload = JSON.parse(rawBody || "{}");
    const nextSettings = {};
    if (typeof payload.compressionEnabled === "boolean") {
      nextSettings.compressionEnabled = payload.compressionEnabled;
    }
    if (payload.summaryBatchSize !== undefined) {
      nextSettings.summaryBatchSize = payload.summaryBatchSize;
    }
    if (payload.contextStrategy !== undefined) {
      nextSettings.contextStrategy = payload.contextStrategy;
    }
    if (payload.windowSize !== undefined) {
      nextSettings.windowSize = payload.windowSize;
    }

    const chat = chatAgent.updateChatSettings(user.id, chatId, nextSettings);

    if (!chat) {
      sendJson(res, 404, { error: "Chat not found." });
      return;
    }

    sendJson(res, 200, { chat });
    return;
  }

  if (parts.length === 4 && parts[3] === "checkpoint" && req.method === "POST") {
    const chat = chatAgent.saveCheckpoint(user.id, chatId);
    if (!chat) {
      sendJson(res, 404, { error: "Chat not found." });
      return;
    }

    sendJson(res, 200, { chat });
    return;
  }

  if (parts.length === 4 && parts[3] === "branches" && req.method === "POST") {
    const rawBody = await readRequestBody(req);
    const payload = JSON.parse(rawBody || "{}");
    const chat = chatAgent.createBranch(user.id, chatId, payload.name);
    if (!chat) {
      sendJson(res, 404, { error: "Chat not found." });
      return;
    }

    sendJson(res, 201, { chat });
    return;
  }

  if (parts.length === 5 && parts[3] === "branches" && req.method === "POST") {
    const chat = chatAgent.switchBranch(user.id, chatId, parts[4]);
    if (!chat) {
      sendJson(res, 404, { error: "Branch not found." });
      return;
    }

    sendJson(res, 200, { chat });
    return;
  }

  if (parts.length === 3 && req.method === "DELETE") {
    const deleted = chatAgent.deleteChat(user.id, chatId);
    if (!deleted) {
      sendJson(res, 404, { error: "Chat not found." });
      return;
    }

    sendJson(res, 200, {
      chats: chatAgent.listChats(user.id)
    });
    return;
  }

  if (parts.length === 4 && parts[3] === "messages" && req.method === "DELETE") {
    const chat = chatAgent.clearHistory(user.id, chatId);
    if (!chat) {
      sendJson(res, 404, { error: "Chat not found." });
      return;
    }

    sendJson(res, 200, { chat });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
}

function handleChatHistory(req, res) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    sendAuthRequired(res);
    return;
  }

  const firstChat = chatAgent.listChats(user.id)[0] || null;

  if (req.method === "GET") {
    sendJson(res, 200, {
      messages: firstChat ? chatAgent.getHistory(user.id, firstChat.id) : []
    });
    return;
  }

  if (req.method === "DELETE") {
    if (!firstChat) {
      sendJson(res, 200, { messages: [] });
      return;
    }

    sendJson(res, 200, {
      messages: chatAgent.clearHistory(user.id, firstChat.id)?.messages || []
    });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
}

async function handleAuth(req, res) {
  const url = getUrl(req);
  const pathName = url.pathname;

  if (pathName === "/api/auth/me" && req.method === "GET") {
    const user = getAuthenticatedUser(req);
    sendJson(res, 200, { user });
    return;
  }

  if (pathName === "/api/auth/logout" && req.method === "POST") {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if ((pathName === "/api/auth/login" || pathName === "/api/auth/register") && req.method === "POST") {
    const rawBody = await readRequestBody(req);
    const payload = JSON.parse(rawBody || "{}");
    const login = payload.login;
    const password = payload.password;
    const user = pathName === "/api/auth/register"
      ? userStore.createUser(login, password)
      : userStore.verifyUser(login, password);

    if (!user) {
      sendJson(res, 401, { error: "Invalid login or password." });
      return;
    }

    createSession(res, user);
    sendJson(res, pathName === "/api/auth/register" ? 201 : 200, { user });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
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
  const url = getUrl(req);

  if (req.method === "POST" && url.pathname === "/api/openai") {
    handleOpenAiProxy(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/auth/")) {
    handleAuth(req, res).catch((error) => {
      const statusCode = error.message.includes("exists") ? 409 : 400;
      sendJson(res, statusCode, { error: error.message });
    });
    return;
  }

  if (url.pathname === "/api/chat/tokens") {
    handleChatTokenPreview(req, res).catch((error) => {
      sendJson(res, error.message.includes("large") ? 413 : 500, {
        error: error.message
      });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    handleChatStream(req, res);
    return;
  }

  if (url.pathname === "/api/chat/history") {
    handleChatHistory(req, res);
    return;
  }

  if (url.pathname === "/api/chats" || url.pathname.startsWith("/api/chats/")) {
    handleChats(req, res).catch((error) => {
      sendJson(res, error.message.includes("large") ? 413 : 500, {
        error: error.message
      });
    });
    return;
  }

  if (req.method === "GET") {
    if (url.pathname === "/chat" || url.pathname === "/chat/") {
      req.url = "/chat.html";
    }

    serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
});

server.listen(PORT, () => {
  console.log(`OpenAI API parameter lab is running on http://localhost:${PORT}`);
});
