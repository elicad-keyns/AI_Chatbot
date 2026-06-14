const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_HISTORY_FILE = path.join(__dirname, "data", "chat-history.json");
const VALID_ROLES = new Set(["user", "assistant"]);
const MAX_MESSAGES_PER_CHAT = 80;
const LEGACY_USER_ID = "legacy";
const EMPTY_MEMORY = {
  summary: "",
  facts: {},
  summarizedMessageCount: 0,
  originalTokenEstimate: 0,
  summaryTokenEstimate: 0,
  compressionRuns: 0,
  recentMessageLimit: 0,
  summaryBatchSize: 0,
  updatedAt: null
};
const DEFAULT_CHAT_SETTINGS = {
  compressionEnabled: true,
  summaryBatchSize: 10,
  contextStrategy: "sliding",
  windowSize: 8
};
const VALID_CONTEXT_STRATEGIES = new Set(["sliding", "facts", "branching"]);
const MAIN_BRANCH_ID = "main";

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
        return this.listChats(LEGACY_USER_ID);
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      const payload = JSON.parse(raw || "{}");
      this.chats = this.sanitizeChats(payload.chats || this.migrateLegacyMessages(payload.messages));
      return this.listChats(LEGACY_USER_ID);
    } catch {
      this.chats = [];
      return this.listChats(LEGACY_USER_ID);
    }
  }

  listChats(userId) {
    return this.chats
      .filter((chat) => chat.userId === userId)
      .map((chat) => this.toChatSummary(chat))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  createChat(userId, options = {}) {
    const now = new Date().toISOString();
    const chat = {
      id: options.id || crypto.randomUUID(),
      userId,
      title: this.cleanTitle(options.title) || "New chat",
      createdAt: options.createdAt || now,
      updatedAt: options.updatedAt || now,
      tokenStats: options.tokenStats || null,
      settings: this.sanitizeSettings(options.settings),
      memory: this.sanitizeMemory(options.memory),
      activeBranchId: MAIN_BRANCH_ID,
      checkpoint: null,
      branches: this.sanitizeBranches(options.branches, [], now),
      messages: []
    };

    this.chats.unshift(chat);
    this.save();
    return this.cloneChat(chat);
  }

  ensureChat(userId, chatId, options = {}) {
    const existingChat = chatId ? this.findChat(userId, chatId) : null;
    if (existingChat) return existingChat;
    return this.createChat(userId, options);
  }

  getChat(userId, chatId) {
    const chat = this.findChat(userId, chatId);
    return chat ? this.cloneChat(chat) : null;
  }

  getMessages(userId, chatId) {
    const chat = this.findChat(userId, chatId);
    return chat ? chat.messages.map((message) => ({ ...message })) : [];
  }

  getMemory(userId, chatId) {
    const chat = this.findChat(userId, chatId);
    return chat ? this.toMemorySummary(chat.memory) : null;
  }

  addMessages(userId, chatId, messages, tokenStats = null) {
    const chat = this.findChat(userId, chatId);
    if (!chat) return null;

    const nextMessages = this.sanitizeMessages(messages);
    if (!nextMessages.length) return this.cloneChat(chat);

    chat.messages.push(...nextMessages);
    chat.messages = chat.messages.slice(-MAX_MESSAGES_PER_CHAT);
    this.syncActiveBranch(chat);
    chat.updatedAt = new Date().toISOString();
    if (tokenStats) {
      chat.tokenStats = tokenStats;
    }

    if (chat.title === "New chat") {
      const firstUserMessage = nextMessages.find((message) => message.role === "user");
      if (firstUserMessage) {
        chat.title = this.titleFromMessage(firstUserMessage.content);
      }
    }

    this.sortChats();
    this.save();
    return this.cloneChat(chat);
  }

  replaceChatContext(userId, chatId, { messages, memory }) {
    const chat = this.findChat(userId, chatId);
    if (!chat) return null;

    chat.messages = this.sanitizeMessages(messages);
    chat.memory = this.sanitizeMemory(memory);
    this.syncActiveBranch(chat);
    chat.updatedAt = new Date().toISOString();
    this.sortChats();
    this.save();
    return this.cloneChat(chat);
  }

  updateFacts(userId, chatId, facts = {}) {
    const chat = this.findChat(userId, chatId);
    if (!chat) return null;

    chat.memory = this.sanitizeMemory({
      ...chat.memory,
      facts
    });
    chat.updatedAt = new Date().toISOString();
    this.sortChats();
    this.save();
    return this.cloneChat(chat);
  }

  saveCheckpoint(userId, chatId) {
    const chat = this.findChat(userId, chatId);
    if (!chat) return null;

    const now = new Date().toISOString();
    chat.checkpoint = {
      id: crypto.randomUUID(),
      createdAt: now,
      branchId: chat.activeBranchId || MAIN_BRANCH_ID,
      messages: this.sanitizeMessages(chat.messages)
    };
    chat.updatedAt = now;
    this.sortChats();
    this.save();
    return this.cloneChat(chat);
  }

  createBranch(userId, chatId, name = "") {
    const chat = this.findChat(userId, chatId);
    if (!chat) return null;

    this.syncActiveBranch(chat);
    const now = new Date().toISOString();
    const branch = {
      id: crypto.randomUUID(),
      name: this.cleanTitle(name) || `Branch ${chat.branches.length + 1}`,
      createdAt: now,
      updatedAt: now,
      messages: this.sanitizeMessages(chat.checkpoint?.messages || chat.messages)
    };

    chat.branches.push(branch);
    chat.activeBranchId = branch.id;
    chat.messages = branch.messages.map((message) => ({ ...message }));
    chat.updatedAt = now;
    this.sortChats();
    this.save();
    return this.cloneChat(chat);
  }

  switchBranch(userId, chatId, branchId) {
    const chat = this.findChat(userId, chatId);
    if (!chat) return null;

    this.syncActiveBranch(chat);
    const nextBranch = chat.branches.find((branch) => branch.id === branchId);
    if (!nextBranch) return null;

    chat.activeBranchId = nextBranch.id;
    chat.messages = nextBranch.messages.map((message) => ({ ...message }));
    chat.updatedAt = new Date().toISOString();
    this.sortChats();
    this.save();
    return this.cloneChat(chat);
  }

  updateChatSettings(userId, chatId, settings = {}) {
    const chat = this.findChat(userId, chatId);
    if (!chat) return null;

    chat.settings = this.sanitizeSettings({
      ...chat.settings,
      ...settings
    });
    chat.updatedAt = new Date().toISOString();
    this.sortChats();
    this.save();
    return this.cloneChat(chat);
  }

  clearChat(userId, chatId) {
    const chat = this.findChat(userId, chatId);
    if (!chat) return null;

    chat.messages = [];
    this.syncActiveBranch(chat);
    chat.memory = this.sanitizeMemory();
    chat.tokenStats = null;
    chat.updatedAt = new Date().toISOString();
    this.sortChats();
    this.save();
    return this.cloneChat(chat);
  }

  deleteChat(userId, chatId) {
    const initialLength = this.chats.length;
    this.chats = this.chats.filter((chat) => chat.id !== chatId || chat.userId !== userId);
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

  findChat(userId, chatId) {
    return this.chats.find((chat) => chat.id === chatId && chat.userId === userId) || null;
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
          userId: String(chat?.userId || LEGACY_USER_ID).trim() || LEGACY_USER_ID,
          title: this.cleanTitle(chat?.title) || "New chat",
          createdAt: this.cleanDate(chat?.createdAt) || now,
          updatedAt: this.cleanDate(chat?.updatedAt) || now,
          tokenStats: this.sanitizeTokenStats(chat?.tokenStats),
          settings: this.sanitizeSettings(chat?.settings),
          memory: this.sanitizeMemory(chat?.memory),
          activeBranchId: String(chat?.activeBranchId || MAIN_BRANCH_ID),
          checkpoint: this.sanitizeCheckpoint(chat?.checkpoint),
          branches: this.sanitizeBranches(chat?.branches, chat?.messages, now),
          messages: this.sanitizeMessages(chat?.messages)
        };
      })
      .map((chat) => this.hydrateActiveBranch(chat))
      .filter(Boolean)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return [];

    return messages
      .map((message) => ({
        role: VALID_ROLES.has(message?.role) ? message.role : "user",
        content: String(message?.content || "").trim(),
        tokenStats: this.sanitizeTokenStats(message?.tokenStats)
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
        userId: LEGACY_USER_ID,
        title: firstUserMessage ? this.titleFromMessage(firstUserMessage.content) : "Legacy chat",
        createdAt: now,
        updatedAt: now,
        tokenStats: null,
        settings: this.sanitizeSettings(),
        memory: this.sanitizeMemory(),
        activeBranchId: MAIN_BRANCH_ID,
        checkpoint: null,
        branches: this.sanitizeBranches(null, safeMessages, now),
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
      messageCount: this.getVisibleMessageCount(chat),
      preview: lastMessage?.content || "",
      settings: this.sanitizeSettings(chat.settings),
      memory: this.toMemorySummary(chat.memory),
      activeBranchId: chat.activeBranchId || MAIN_BRANCH_ID,
      activeBranchName: this.getActiveBranch(chat)?.name || "Main",
      branches: this.toBranchSummaries(chat.branches),
      checkpoint: chat.checkpoint
        ? {
          id: chat.checkpoint.id,
          createdAt: chat.checkpoint.createdAt,
          branchId: chat.checkpoint.branchId,
          messageCount: chat.checkpoint.messages.length
        }
        : null,
      tokenStats: this.sanitizeTokenStats(chat.tokenStats)
    };
  }

  cloneChat(chat) {
    return {
      ...this.toChatSummary(chat),
      messages: chat.messages.map((message) => ({ ...message }))
    };
  }

  syncActiveBranch(chat) {
    if (!Array.isArray(chat.branches) || !chat.branches.length) {
      chat.branches = this.sanitizeBranches(null, chat.messages, new Date().toISOString());
      chat.activeBranchId = MAIN_BRANCH_ID;
    }

    const branch = this.getActiveBranch(chat);
    if (!branch) return;

    branch.messages = this.sanitizeMessages(chat.messages);
    branch.updatedAt = new Date().toISOString();
  }

  getActiveBranch(chat) {
    if (!Array.isArray(chat?.branches)) return null;
    return chat.branches.find((branch) => branch.id === chat.activeBranchId) || chat.branches[0] || null;
  }

  hydrateActiveBranch(chat) {
    if (!chat) return null;
    if (!chat.branches.length) {
      chat.branches = this.sanitizeBranches(null, chat.messages, new Date().toISOString());
    }

    const activeBranch = chat.branches.find((branch) => branch.id === chat.activeBranchId) || chat.branches[0];
    chat.activeBranchId = activeBranch.id;
    chat.messages = activeBranch.messages.map((message) => ({ ...message }));
    return chat;
  }

  sanitizeBranches(branches, fallbackMessages = [], now = new Date().toISOString()) {
    const safeFallbackMessages = this.sanitizeMessages(fallbackMessages);
    if (!Array.isArray(branches) || !branches.length) {
      return [
        {
          id: MAIN_BRANCH_ID,
          name: "Main",
          createdAt: now,
          updatedAt: now,
          messages: safeFallbackMessages
        }
      ];
    }

    const seenIds = new Set();
    return branches
      .map((branch, index) => {
        const id = String(branch?.id || (index === 0 ? MAIN_BRANCH_ID : crypto.randomUUID())).trim();
        if (!id || seenIds.has(id)) return null;
        seenIds.add(id);

        return {
          id,
          name: this.cleanTitle(branch?.name) || (index === 0 ? "Main" : `Branch ${index + 1}`),
          createdAt: this.cleanDate(branch?.createdAt) || now,
          updatedAt: this.cleanDate(branch?.updatedAt) || now,
          messages: this.sanitizeMessages(branch?.messages)
        };
      })
      .filter(Boolean);
  }

  sanitizeCheckpoint(checkpoint) {
    if (!checkpoint || typeof checkpoint !== "object") return null;

    return {
      id: String(checkpoint.id || crypto.randomUUID()),
      createdAt: this.cleanDate(checkpoint.createdAt) || new Date().toISOString(),
      branchId: String(checkpoint.branchId || MAIN_BRANCH_ID),
      messages: this.sanitizeMessages(checkpoint.messages)
    };
  }

  toBranchSummaries(branches) {
    if (!Array.isArray(branches)) return [];

    return branches.map((branch) => {
      const lastMessage = branch.messages[branch.messages.length - 1] || null;
      return {
        id: branch.id,
        name: branch.name,
        createdAt: branch.createdAt,
        updatedAt: branch.updatedAt,
        messageCount: branch.messages.length,
        preview: lastMessage?.content || ""
      };
    });
  }

  cleanTitle(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 64);
  }

  titleFromMessage(message) {
    const title = this.cleanTitle(message);
    return title.length > 42 ? `${title.slice(0, 39)}...` : title || "New chat";
  }

  cleanDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  getVisibleMessageCount(chat) {
    const memory = this.sanitizeMemory(chat?.memory);
    const messageCount = Array.isArray(chat?.messages) ? chat.messages.length : 0;
    return memory.summarizedMessageCount + messageCount;
  }

  sanitizeMemory(memory = {}) {
    if (!memory || typeof memory !== "object") return { ...EMPTY_MEMORY };

    return {
      summary: String(memory.summary || "").trim(),
      facts: this.sanitizeFacts(memory.facts),
      summarizedMessageCount: Math.max(0, Number(memory.summarizedMessageCount || 0)),
      originalTokenEstimate: Math.max(0, Number(memory.originalTokenEstimate || 0)),
      summaryTokenEstimate: Math.max(0, Number(memory.summaryTokenEstimate || 0)),
      compressionRuns: Math.max(0, Number(memory.compressionRuns || 0)),
      recentMessageLimit: Math.max(0, Number(memory.recentMessageLimit || 0)),
      summaryBatchSize: Math.max(0, Number(memory.summaryBatchSize || 0)),
      updatedAt: this.cleanDate(memory.updatedAt) || null
    };
  }

  sanitizeSettings(settings = {}) {
    if (!settings || typeof settings !== "object") return { ...DEFAULT_CHAT_SETTINGS };

    const summaryBatchSize = Number(settings.summaryBatchSize || DEFAULT_CHAT_SETTINGS.summaryBatchSize);

    const windowSize = Number(settings.windowSize || DEFAULT_CHAT_SETTINGS.windowSize);
    const contextStrategy = VALID_CONTEXT_STRATEGIES.has(settings.contextStrategy)
      ? settings.contextStrategy
      : DEFAULT_CHAT_SETTINGS.contextStrategy;

    return {
      compressionEnabled: settings.compressionEnabled !== false,
      summaryBatchSize: Number.isFinite(summaryBatchSize)
        ? Math.min(80, Math.max(2, Math.round(summaryBatchSize)))
        : DEFAULT_CHAT_SETTINGS.summaryBatchSize,
      contextStrategy,
      windowSize: Number.isFinite(windowSize)
        ? Math.min(40, Math.max(2, Math.round(windowSize)))
        : DEFAULT_CHAT_SETTINGS.windowSize
    };
  }

  sanitizeFacts(facts = {}) {
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) return {};

    return Object.entries(facts).reduce((result, [key, value]) => {
      const cleanKey = String(key || "").trim().slice(0, 60);
      const cleanValue = String(value || "").trim().slice(0, 500);
      if (cleanKey && cleanValue) {
        result[cleanKey] = cleanValue;
      }
      return result;
    }, {});
  }

  toMemorySummary(memory = {}) {
    const safeMemory = this.sanitizeMemory(memory);
    return {
      ...safeMemory,
      hasSummary: Boolean(safeMemory.summary),
      summaryPreview: safeMemory.summary.slice(0, 240),
      facts: this.sanitizeFacts(safeMemory.facts)
    };
  }

  sanitizeTokenStats(stats) {
    if (!stats || typeof stats !== "object") return null;

    return {
      model: String(stats.model || ""),
      estimate: Boolean(stats.estimate),
      currentMessageTokens: Number(stats.currentMessageTokens || 0),
      historyTokens: Number(stats.historyTokens || 0),
      instructionTokens: Number(stats.instructionTokens || 0),
      requestTokens: Number(stats.requestTokens || 0),
      responseTokens: Number(stats.responseTokens || 0),
      totalTokens: Number(stats.totalTokens || 0),
      contextLimit: Number(stats.contextLimit || 0),
      remainingTokens: Number(stats.remainingTokens || 0),
      usageRatio: Number(stats.usageRatio || 0),
      overLimit: Boolean(stats.overLimit),
      warningLevel: String(stats.warningLevel || "ok"),
      estimatedCostUsd: Number(stats.estimatedCostUsd || 0),
      inputCostUsd: Number(stats.inputCostUsd || 0),
      outputCostUsd: Number(stats.outputCostUsd || 0),
      strategy: this.sanitizeStrategyStats(stats.strategy),
      compression: this.sanitizeCompressionStats(stats.compression)
    };
  }

  sanitizeStrategyStats(stats) {
    if (!stats || typeof stats !== "object") {
      return {
        name: "sliding",
        windowSize: 0,
        contextMessageCount: 0,
        storedMessageCount: 0,
        fullHistoryTokens: 0,
        requestTokens: 0,
        fullRequestTokens: 0,
        savedTokens: 0,
        savingsRatio: 0
      };
    }

    return {
      name: String(stats.name || "sliding"),
      windowSize: Number(stats.windowSize || 0),
      contextMessageCount: Number(stats.contextMessageCount || 0),
      storedMessageCount: Number(stats.storedMessageCount || 0),
      fullHistoryTokens: Number(stats.fullHistoryTokens || 0),
      requestTokens: Number(stats.requestTokens || 0),
      fullRequestTokens: Number(stats.fullRequestTokens || 0),
      savedTokens: Number(stats.savedTokens || 0),
      savingsRatio: Number(stats.savingsRatio || 0)
    };
  }

  sanitizeCompressionStats(stats) {
    if (!stats || typeof stats !== "object") {
      return {
        enabled: false,
        configured: true,
        recentMessageLimit: 0,
        summaryBatchSize: 0,
        summarizedMessageCount: 0,
        recentMessageCount: 0,
        summaryTokens: 0,
        compressedHistoryTokens: 0,
        fullHistoryTokens: 0,
        compressedRequestTokens: 0,
        fullRequestTokens: 0,
        savedTokens: 0,
        savingsRatio: 0,
        compressionRuns: 0
      };
    }

    return {
      enabled: Boolean(stats.enabled),
      configured: stats.configured !== false,
      recentMessageLimit: Number(stats.recentMessageLimit || 0),
      summaryBatchSize: Number(stats.summaryBatchSize || 0),
      summarizedMessageCount: Number(stats.summarizedMessageCount || 0),
      recentMessageCount: Number(stats.recentMessageCount || 0),
      summaryTokens: Number(stats.summaryTokens || 0),
      compressedHistoryTokens: Number(stats.compressedHistoryTokens || 0),
      fullHistoryTokens: Number(stats.fullHistoryTokens || 0),
      compressedRequestTokens: Number(stats.compressedRequestTokens || 0),
      fullRequestTokens: Number(stats.fullRequestTokens || 0),
      savedTokens: Number(stats.savedTokens || 0),
      savingsRatio: Number(stats.savingsRatio || 0),
      compressionRuns: Number(stats.compressionRuns || 0)
    };
  }
}

module.exports = ChatHistoryStore;
