const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { dataPath } = require("./storagePaths");

const DEFAULT_SHORT_TERM_FILE = dataPath("memory-short-term.json");
const DEFAULT_WORKING_FILE = dataPath("memory-working.json");
const DEFAULT_LONG_TERM_FILE = dataPath("memory-long-term.json");
const MAX_MESSAGES_PER_CHAT = 120;
const MAX_DEBUG_EVENTS = 30;
const DEFAULT_CHAT_SETTINGS = {
  shortTermWindow: 10,
  includeWorkingMemory: true,
  includeLongTermMemory: true
};

class MemoryLayerStore {
  constructor(options = {}) {
    this.shortTermFilePath = options.shortTermFilePath || process.env.MEMORY_SHORT_TERM_FILE || DEFAULT_SHORT_TERM_FILE;
    this.workingFilePath = options.workingFilePath || process.env.MEMORY_WORKING_FILE || DEFAULT_WORKING_FILE;
    this.longTermFilePath = options.longTermFilePath || process.env.MEMORY_LONG_TERM_FILE || DEFAULT_LONG_TERM_FILE;
    this.shortTerm = { chats: [] };
    this.working = { users: [] };
    this.longTerm = { users: [] };
    this.load();
  }

  load() {
    this.shortTerm = this.readPayload(this.shortTermFilePath, { chats: [] });
    this.working = this.readPayload(this.workingFilePath, { users: [] });
    this.longTerm = this.readPayload(this.longTermFilePath, { users: [] });
    this.shortTerm.chats = this.sanitizeShortTermChats(this.shortTerm.chats);
    const workingUsers = Array.isArray(this.working.users) && this.working.users.length
      ? this.working.users
      : this.migrateWorkingChats(this.working.chats);
    this.working.users = this.sanitizeWorkingUsers(workingUsers);
    this.longTerm.users = this.sanitizeLongTermUsers(this.longTerm.users);
  }

  listChats(userId) {
    return this.shortTerm.chats
      .filter((chat) => chat.userId === userId)
      .map((chat) => this.toChatSummary(chat))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  createChat(userId, options = {}) {
    const now = new Date().toISOString();
    const chat = {
      id: options.id || crypto.randomUUID(),
      userId,
      title: this.cleanTitle(options.title) || "Memory chat",
      createdAt: options.createdAt || now,
      updatedAt: options.updatedAt || now,
      settings: this.sanitizeSettings(options.settings),
      messages: [],
      notes: [],
      debugEvents: [],
      lastRequest: null,
      lastResponse: null
    };

    this.shortTerm.chats.unshift(chat);
    this.ensureWorkingMemory(userId);
    this.ensureLongTermMemory(userId);
    this.saveShortTerm();
    this.saveWorking();
    this.saveLongTerm();
    return this.getChat(userId, chat.id);
  }

  ensureChat(userId, chatId, options = {}) {
    const existing = chatId ? this.findShortTermChat(userId, chatId) : null;
    if (existing) {
      this.ensureWorkingMemory(userId);
      this.ensureLongTermMemory(userId);
      return this.getChat(userId, existing.id);
    }

    return this.createChat(userId, options);
  }

  getChat(userId, chatId) {
    const chat = this.findShortTermChat(userId, chatId);
    if (!chat) return null;

    return {
      ...this.toChatSummary(chat),
      messages: chat.messages.map((message) => ({ ...message })),
      shortTermMemory: this.toShortTermMemory(chat),
      workingMemory: this.clone(this.ensureWorkingMemory(userId)),
      longTermMemory: this.clone(this.ensureLongTermMemory(userId)),
      debug: this.getDebug(userId, chat.id)
    };
  }

  updateChatSettings(userId, chatId, settings = {}) {
    const chat = this.findShortTermChat(userId, chatId);
    if (!chat) return null;

    chat.settings = this.sanitizeSettings({
      ...chat.settings,
      ...settings
    });
    chat.updatedAt = new Date().toISOString();
    this.sortShortTermChats();
    this.saveShortTerm();
    return this.getChat(userId, chatId);
  }

  addMessage(userId, chatId, message) {
    const chat = this.findShortTermChat(userId, chatId);
    if (!chat) return null;

    const cleanMessage = this.sanitizeMessage(message);
    if (!cleanMessage) return this.getChat(userId, chatId);

    chat.messages.push(cleanMessage);
    chat.messages = chat.messages.slice(-MAX_MESSAGES_PER_CHAT);
    chat.updatedAt = new Date().toISOString();

    if (chat.title === "Memory chat" && cleanMessage.role === "user") {
      chat.title = this.titleFromMessage(cleanMessage.content);
    }

    this.sortShortTermChats();
    this.saveShortTerm();
    return this.getChat(userId, chatId);
  }

  addMessages(userId, chatId, messages = []) {
    let chat = null;
    messages.forEach((message) => {
      chat = this.addMessage(userId, chatId, message);
    });
    return chat || this.getChat(userId, chatId);
  }

  saveManualMemory({ userId, chatId, layer, category, key, value, reason }) {
    const cleanLayer = this.cleanLayer(layer);
    const cleanKey = this.cleanKey(key);
    const cleanValue = this.cleanValue(value, 2000);
    if (!cleanLayer || !cleanValue) {
      throw new Error("Memory layer and value are required.");
    }

    return this.applyMemoryWrite({
      userId,
      chatId,
      layer: cleanLayer,
      category,
      key: cleanKey || this.defaultKeyForLayer(cleanLayer),
      value: cleanValue,
      reason: this.cleanValue(reason, 300) || "Manual debug save"
    });
  }

  applyMemoryWrite({ userId, chatId, layer, category, key, value, reason, source = "router" }) {
    const now = new Date().toISOString();
    const cleanLayer = this.cleanLayer(layer);
    const cleanKey = this.cleanKey(key) || this.defaultKeyForLayer(cleanLayer);
    const cleanValue = this.cleanValue(value, 2000);
    const cleanReason = this.cleanValue(reason, 300);
    if (!cleanLayer || !cleanValue) return null;

    const record = {
      id: crypto.randomUUID(),
      layer: cleanLayer,
      category: this.cleanKey(category) || this.defaultCategoryForLayer(cleanLayer),
      key: cleanKey,
      value: cleanValue,
      source,
      reason: cleanReason,
      createdAt: now
    };

    if (cleanLayer === "short_term") {
      const chat = this.findShortTermChat(userId, chatId);
      if (!chat) return null;
      chat.notes.push(record);
      chat.notes = chat.notes.slice(-40);
      chat.updatedAt = now;
      this.saveShortTerm();
      return record;
    }

    if (cleanLayer === "working") {
      const memory = this.ensureWorkingMemory(userId);
      if (!memory) return null;
      memory.items[record.key] = record;
      memory.updatedAt = now;
      this.saveWorking();
      return record;
    }

    if (cleanLayer === "long_term") {
      const memory = this.ensureLongTermMemory(userId);
      memory.items[record.key] = record;
      memory.updatedAt = now;
      this.saveLongTerm();
      return record;
    }

    return null;
  }

  clearMessages(userId, chatId) {
    const chat = this.findShortTermChat(userId, chatId);
    if (!chat) return null;

    chat.messages = [];
    chat.notes = [];
    chat.lastRequest = null;
    chat.lastResponse = null;
    chat.updatedAt = new Date().toISOString();
    this.sortShortTermChats();
    this.saveShortTerm();
    return this.getChat(userId, chatId);
  }

  deleteChat(userId, chatId) {
    const initialLength = this.shortTerm.chats.length;
    this.shortTerm.chats = this.shortTerm.chats.filter((chat) => chat.userId !== userId || chat.id !== chatId);
    if (this.shortTerm.chats.length === initialLength) return false;

    this.saveShortTerm();
    return true;
  }

  recordDebug(userId, chatId, event) {
    const chat = this.findShortTermChat(userId, chatId);
    if (!chat) return null;

    const debugEvent = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...this.clone(event)
    };

    chat.debugEvents.unshift(debugEvent);
    chat.debugEvents = chat.debugEvents.slice(0, MAX_DEBUG_EVENTS);
    chat.lastRequest = event?.request || chat.lastRequest || null;
    chat.lastResponse = event?.response || chat.lastResponse || null;
    chat.updatedAt = new Date().toISOString();
    this.saveShortTerm();
    return debugEvent;
  }

  getDebug(userId, chatId) {
    const chat = this.findShortTermChat(userId, chatId);
    if (!chat) return null;

    return {
      lastRequest: this.clone(chat.lastRequest),
      lastResponse: this.clone(chat.lastResponse),
      events: (chat.debugEvents || []).map((event) => this.clone(event))
    };
  }

  getLayerSnapshot(userId, chatId) {
    const chat = this.findShortTermChat(userId, chatId);
    if (!chat) return null;

    return {
      short_term: this.toShortTermMemory(chat),
      working: this.clone(this.ensureWorkingMemory(userId)),
      long_term: this.clone(this.ensureLongTermMemory(userId))
    };
  }

  ensureWorkingMemory(userId) {
    let memory = this.working.users.find((item) => item.userId === userId);
    if (memory) return memory;

    memory = {
      userId,
      scope: "current_task",
      items: {},
      updatedAt: null
    };
    this.working.users.push(memory);
    return memory;
  }

  ensureLongTermMemory(userId) {
    let memory = this.longTerm.users.find((item) => item.userId === userId);
    if (memory) return memory;

    memory = {
      userId,
      items: {},
      updatedAt: null
    };
    this.longTerm.users.push(memory);
    return memory;
  }

  toChatSummary(chat) {
    const lastMessage = chat.messages[chat.messages.length - 1] || null;
    const working = this.ensureWorkingMemory(chat.userId);
    const longTerm = this.ensureLongTermMemory(chat.userId);

    return {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messageCount: chat.messages.length,
      preview: lastMessage?.content || "",
      settings: this.sanitizeSettings(chat.settings),
      memoryCounts: {
        shortTermMessages: chat.messages.length,
        shortTermNotes: chat.notes.length,
        workingItems: Object.keys(working?.items || {}).length,
        longTermItems: Object.keys(longTerm?.items || {}).length
      }
    };
  }

  toShortTermMemory(chat) {
    return {
      chatId: chat.id,
      userId: chat.userId,
      description: "Current dialogue layer: recent messages and temporary notes for this chat only.",
      messages: chat.messages.map((message) => ({ ...message })),
      notes: chat.notes.map((note) => ({ ...note })),
      updatedAt: chat.updatedAt
    };
  }

  readPayload(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return this.clone(fallback);
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw || "{}");
    } catch {
      return this.clone(fallback);
    }
  }

  saveShortTerm() {
    this.writePayload(this.shortTermFilePath, {
      updatedAt: new Date().toISOString(),
      chats: this.shortTerm.chats
    });
  }

  saveWorking() {
    this.writePayload(this.workingFilePath, {
      updatedAt: new Date().toISOString(),
      users: this.working.users
    });
  }

  saveLongTerm() {
    this.writePayload(this.longTermFilePath, {
      updatedAt: new Date().toISOString(),
      users: this.longTerm.users
    });
  }

  writePayload(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempFilePath = `${filePath}.tmp`;
    fs.writeFileSync(tempFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempFilePath, filePath);
  }

  findShortTermChat(userId, chatId) {
    return this.shortTerm.chats.find((chat) => chat.userId === userId && chat.id === chatId) || null;
  }

  sortShortTermChats() {
    this.shortTerm.chats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  sanitizeShortTermChats(chats) {
    if (!Array.isArray(chats)) return [];
    const seen = new Set();
    return chats
      .map((chat) => {
        const id = String(chat?.id || crypto.randomUUID()).trim();
        const userId = String(chat?.userId || "").trim();
        if (!id || !userId || seen.has(`${userId}:${id}`)) return null;
        seen.add(`${userId}:${id}`);
        const now = new Date().toISOString();

        return {
          id,
          userId,
          title: this.cleanTitle(chat?.title) || "Memory chat",
          createdAt: this.cleanDate(chat?.createdAt) || now,
          updatedAt: this.cleanDate(chat?.updatedAt) || now,
          settings: this.sanitizeSettings(chat?.settings),
          messages: this.sanitizeMessages(chat?.messages),
          notes: this.sanitizeMemoryRecords(chat?.notes),
          debugEvents: Array.isArray(chat?.debugEvents) ? chat.debugEvents.slice(0, MAX_DEBUG_EVENTS) : [],
          lastRequest: this.clone(chat?.lastRequest || null),
          lastResponse: this.clone(chat?.lastResponse || null)
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  migrateWorkingChats(chats) {
    if (!Array.isArray(chats)) return [];
    const users = new Map();
    chats.forEach((memory) => {
      const userId = String(memory?.userId || "").trim();
      if (!userId) return;
      const existing = users.get(userId) || {
        userId,
        scope: "current_task",
        items: {},
        updatedAt: null
      };
      existing.items = {
        ...existing.items,
        ...this.sanitizeMemoryItems(memory?.items)
      };
      existing.updatedAt = this.latestDate(existing.updatedAt, memory?.updatedAt);
      users.set(userId, existing);
    });
    return Array.from(users.values());
  }

  sanitizeWorkingUsers(users) {
    if (!Array.isArray(users)) return [];
    return users
      .map((memory) => ({
        userId: String(memory?.userId || "").trim(),
        scope: this.cleanKey(memory?.scope) || "current_task",
        items: this.sanitizeMemoryItems(memory?.items),
        updatedAt: this.cleanDate(memory?.updatedAt) || null
      }))
      .filter((memory) => memory.userId);
  }

  sanitizeLongTermUsers(users) {
    if (!Array.isArray(users)) return [];
    return users
      .map((memory) => ({
        userId: String(memory?.userId || "").trim(),
        items: this.sanitizeMemoryItems(memory?.items),
        updatedAt: this.cleanDate(memory?.updatedAt) || null
      }))
      .filter((memory) => memory.userId);
  }

  sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
      .map((message) => this.sanitizeMessage(message))
      .filter(Boolean)
      .slice(-MAX_MESSAGES_PER_CHAT);
  }

  sanitizeMessage(message) {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const content = this.cleanValue(message?.content, 12000);
    if (!content) return null;
    return {
      role,
      content,
      createdAt: this.cleanDate(message?.createdAt) || new Date().toISOString()
    };
  }

  sanitizeMemoryItems(items) {
    if (!items || typeof items !== "object" || Array.isArray(items)) return {};
    return Object.entries(items).reduce((result, [key, value]) => {
      const record = this.sanitizeMemoryRecord(value, key);
      if (record) result[record.key] = record;
      return result;
    }, {});
  }

  sanitizeMemoryRecords(records) {
    if (!Array.isArray(records)) return [];
    return records.map((record) => this.sanitizeMemoryRecord(record)).filter(Boolean);
  }

  sanitizeMemoryRecord(record, fallbackKey = "") {
    const layer = this.cleanLayer(record?.layer) || "short_term";
    const key = this.cleanKey(record?.key || fallbackKey);
    const value = this.cleanValue(record?.value, 2000);
    if (!key || !value) return null;

    return {
      id: String(record?.id || crypto.randomUUID()),
      layer,
      category: this.cleanKey(record?.category) || this.defaultCategoryForLayer(layer),
      key,
      value,
      source: this.cleanKey(record?.source) || "router",
      reason: this.cleanValue(record?.reason, 300),
      createdAt: this.cleanDate(record?.createdAt) || new Date().toISOString()
    };
  }

  sanitizeSettings(settings = {}) {
    const window = Number(settings?.shortTermWindow || DEFAULT_CHAT_SETTINGS.shortTermWindow);
    return {
      shortTermWindow: Number.isFinite(window) ? Math.min(40, Math.max(2, Math.round(window))) : DEFAULT_CHAT_SETTINGS.shortTermWindow,
      includeWorkingMemory: settings?.includeWorkingMemory !== false,
      includeLongTermMemory: settings?.includeLongTermMemory !== false
    };
  }

  cleanLayer(value) {
    const layer = String(value || "").trim();
    return ["short_term", "working", "long_term"].includes(layer) ? layer : "";
  }

  defaultCategoryForLayer(layer) {
    if (layer === "working") return "task";
    if (layer === "long_term") return "profile";
    return "dialogue";
  }

  defaultKeyForLayer(layer) {
    if (layer === "working") return "current_task";
    if (layer === "long_term") return "profile_note";
    return "temporary_note";
  }

  cleanTitle(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 72);
  }

  titleFromMessage(message) {
    const title = this.cleanTitle(message);
    return title.length > 46 ? `${title.slice(0, 43)}...` : title || "Memory chat";
  }

  cleanKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80);
  }

  cleanValue(value, limit = 1000) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, limit);
  }

  cleanDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  latestDate(left, right) {
    const cleanLeft = this.cleanDate(left);
    const cleanRight = this.cleanDate(right);
    if (!cleanLeft) return cleanRight || null;
    if (!cleanRight) return cleanLeft;
    return cleanRight.localeCompare(cleanLeft) > 0 ? cleanRight : cleanLeft;
  }

  clone(value) {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  }
}

module.exports = MemoryLayerStore;
