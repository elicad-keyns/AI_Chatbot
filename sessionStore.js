const fs = require("node:fs");
const path = require("node:path");
const { dataPath } = require("./storagePaths");

const DEFAULT_SESSIONS_FILE = dataPath("sessions.json");

class SessionStore {
  constructor(filePath = process.env.SESSIONS_FILE || DEFAULT_SESSIONS_FILE) {
    this.filePath = filePath;
    this.sessions = new Map();
    this.load();
  }

  get(token) {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.delete(token);
      return null;
    }
    return session;
  }

  set(token, session) {
    this.sessions.set(token, {
      userId: String(session?.userId || ""),
      expiresAt: Number(session?.expiresAt || 0)
    });
    this.save();
  }

  delete(token) {
    const deleted = this.sessions.delete(token);
    if (deleted) this.save();
    return deleted;
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8") || "{}");
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      const now = Date.now();
      sessions.forEach((item) => {
        const token = String(item?.token || "").trim();
        const userId = String(item?.userId || "").trim();
        const expiresAt = Number(item?.expiresAt || 0);
        if (token && userId && expiresAt > now) {
          this.sessions.set(token, { userId, expiresAt });
        }
      });
    } catch {
      this.sessions.clear();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = {
      updatedAt: new Date().toISOString(),
      sessions: Array.from(this.sessions.entries())
        .filter(([, session]) => session.expiresAt > Date.now())
        .map(([token, session]) => ({
          token,
          userId: session.userId,
          expiresAt: session.expiresAt
        }))
    };
    const tempFilePath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempFilePath, this.filePath);
  }
}

module.exports = SessionStore;
