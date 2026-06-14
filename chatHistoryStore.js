const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_HISTORY_FILE = path.join(__dirname, "data", "chat-history.json");
const VALID_ROLES = new Set(["user", "assistant"]);
const MAX_MESSAGES_PER_CHAT = 80;

class ChatHistoryStore {
  constructor(filePath = process.env.CHAT_HISTORY_FILE || DEFAULT_HISTORY_FILE) {
    this.filePath = filePath;
    this.chats = [];
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.chats = [];
        return this.listChats();
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      const payload = JSON.parse(raw || "{}");
      this.chats = this.sanitizeChats(payload.chats || this.migrateLegacyMessages(payload.messages));
      return this.listChats();
    } catch {
      this.chats = [];
      return this.listChats();
    }
  }

  listChats() {
    return this.chats
      .map((chat) => this.toChatSummary(chat))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  createChat(options = {}) {
    const now = new Date().toISOString();
    const chat = {
      id: options.id || crypto.randomUUID(),
      title: this.cleanTitle(options.title) || "Новый чат",
      createdAt: options.createdAt || now,
      updatedAt: options.updatedAt || now,
      messages: []
    };

    this.chats.unshift(chat);
    this.save();
    return this.cloneChat(chat);
  }

  ensureChat(chatId, options = {}) {
    const existingChat = chatId ? this.findChat(chatId) : null;
    if (existingChat) return existingChat;
    return this.createChat(options);
  }

  getChat(chatId) {
    const chat = this.findChat(chatId);
    return chat ? this.cloneChat(chat) : null;
  }

  getMessages(chatId) {
    const chat = this.findChat(chatId);
    return chat ? chat.messages.map((message) => ({ ...message })) : [];
  }

  addMessages(chatId, messages) {
    const chat = this.findChat(chatId);
    if (!chat) return null;

    const nextMessages = this.sanitizeMessages(messages);
    if (!nextMessages.length) return this.cloneChat(chat);

    chat.messages.push(...nextMessages);
    chat.messages = chat.messages.slice(-MAX_MESSAGES_PER_CHAT);
    chat.updatedAt = new Date().toISOString();

    if (chat.title === "Новый чат") {
      const firstUserMessage = nextMessages.find((message) => message.role === "user");
      if (firstUserMessage) {
        chat.title = this.titleFromMessage(firstUserMessage.content);
      }
    }

    this.sortChats();
    this.save();
    return this.cloneChat(chat);
  }

  clearChat(chatId) {
    const chat = this.findChat(chatId);
    if (!chat) return null;

    chat.messages = [];
    chat.updatedAt = new Date().toISOString();
    this.sortChats();
    this.save();
    return this.cloneChat(chat);
  }

  deleteChat(chatId) {
    const initialLength = this.chats.length;
    this.chats = this.chats.filter((chat) => chat.id !== chatId);
    if (this.chats.length === initialLength) return false;

    this.save();
    return true;
  }

  save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });

    const payload = {
      updatedAt: new Date().toISOString(),
      chats: this.chats
    };
    const tempFilePath = `${this.filePath}.tmp`;

    fs.writeFileSync(tempFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempFilePath, this.filePath);
  }

  findChat(chatId) {
    return this.chats.find((chat) => chat.id === chatId) || null;
  }

  sortChats() {
    this.chats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  sanitizeChats(chats) {
    if (!Array.isArray(chats)) return [];

    const seenIds = new Set();
    return chats
      .map((chat) => {
        const id = String(chat?.id || crypto.randomUUID()).trim();
        if (!id || seenIds.has(id)) return null;
        seenIds.add(id);

        const now = new Date().toISOString();
        return {
          id,
          title: this.cleanTitle(chat?.title) || "Новый чат",
          createdAt: this.cleanDate(chat?.createdAt) || now,
          updatedAt: this.cleanDate(chat?.updatedAt) || now,
          messages: this.sanitizeMessages(chat?.messages)
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return [];

    return messages
      .map((message) => ({
        role: VALID_ROLES.has(message?.role) ? message.role : "user",
        content: String(message?.content || "").trim()
      }))
      .filter((message) => message.content)
      .slice(-MAX_MESSAGES_PER_CHAT);
  }

  migrateLegacyMessages(messages) {
    const safeMessages = this.sanitizeMessages(messages);
    if (!safeMessages.length) return [];

    const now = new Date().toISOString();
    const firstUserMessage = safeMessages.find((message) => message.role === "user");
    return [
      {
        id: crypto.randomUUID(),
        title: firstUserMessage ? this.titleFromMessage(firstUserMessage.content) : "Старый чат",
        createdAt: now,
        updatedAt: now,
        messages: safeMessages
      }
    ];
  }

  toChatSummary(chat) {
    const lastMessage = chat.messages[chat.messages.length - 1] || null;
    return {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messageCount: chat.messages.length,
      preview: lastMessage?.content || ""
    };
  }

  cloneChat(chat) {
    return {
      ...this.toChatSummary(chat),
      messages: chat.messages.map((message) => ({ ...message }))
    };
  }

  cleanTitle(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 64);
  }

  titleFromMessage(message) {
    const title = this.cleanTitle(message);
    return title.length > 42 ? `${title.slice(0, 39)}...` : title || "Новый чат";
  }

  cleanDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
}

module.exports = ChatHistoryStore;
