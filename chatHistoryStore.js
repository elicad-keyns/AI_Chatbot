const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_HISTORY_FILE = path.join(__dirname, "data", "chat-history.json");
const VALID_ROLES = new Set(["user", "assistant"]);

class ChatHistoryStore {
  constructor(filePath = process.env.CHAT_HISTORY_FILE || DEFAULT_HISTORY_FILE) {
    this.filePath = filePath;
    this.messages = [];
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.messages = [];
        return this.getMessages();
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      const payload = JSON.parse(raw || "{}");
      this.messages = this.sanitizeMessages(payload.messages);
      return this.getMessages();
    } catch {
      this.messages = [];
      return this.getMessages();
    }
  }

  getMessages() {
    return this.messages.map((message) => ({ ...message }));
  }

  addMessages(messages) {
    const nextMessages = this.sanitizeMessages(messages);
    if (!nextMessages.length) return this.getMessages();

    this.messages.push(...nextMessages);
    this.save();
    return this.getMessages();
  }

  clear() {
    this.messages = [];
    this.save();
    return this.getMessages();
  }

  save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });

    const payload = {
      updatedAt: new Date().toISOString(),
      messages: this.messages
    };
    const tempFilePath = `${this.filePath}.tmp`;

    fs.writeFileSync(tempFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempFilePath, this.filePath);
  }

  sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return [];

    return messages
      .map((message) => ({
        role: VALID_ROLES.has(message?.role) ? message.role : "user",
        content: String(message?.content || "").trim()
      }))
      .filter((message) => message.content)
      .slice(-60);
  }
}

module.exports = ChatHistoryStore;
