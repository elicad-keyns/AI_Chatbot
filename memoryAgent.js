const MemoryLayerStore = require("./memoryLayerStore");
const tokenMeter = require("./tokenMeter");

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

class MemoryAgent {
  constructor(options = {}) {
    this.apiUrl = options.apiUrl || OPENAI_RESPONSES_URL;
    this.fetch = options.fetchImpl || fetch;
    this.defaultModel = options.defaultModel || "gpt-4.1-mini";
    this.store = options.store || new MemoryLayerStore(options.storeOptions);
    this.instructions = options.instructions || [
      "You are an assistant with explicit memory layers.",
      "Use short-term memory for the current dialogue, working memory for the active task, and long-term memory for stable profile, decisions, and knowledge.",
      "Do not claim that something is remembered unless it appears in the provided memory context.",
      "Answer in the user's language when possible."
    ].join(" ");
  }

  listChats(userId) {
    return this.store.listChats(userId);
  }

  createChat(userId, options) {
    return this.store.createChat(userId, options);
  }

  getChat(userId, chatId) {
    return this.store.getChat(userId, chatId);
  }

  updateChatSettings(userId, chatId, settings) {
    return this.store.updateChatSettings(userId, chatId, settings);
  }

  clearHistory(userId, chatId) {
    return this.store.clearMessages(userId, chatId);
  }

  deleteChat(userId, chatId) {
    return this.store.deleteChat(userId, chatId);
  }

  saveManualMemory(payload) {
    const record = this.store.saveManualMemory(payload);
    const chat = this.getChat(payload.userId, payload.chatId);
    return { record, chat };
  }

  getDebug(userId, chatId) {
    return this.store.getDebug(userId, chatId);
  }

  getMemorySnapshot(userId, chatId) {
    return this.store.getLayerSnapshot(userId, chatId);
  }

  getTokenSummary({ userId, chatId, message = "", model, shortTermWindow, includeWorkingMemory, includeLongTermMemory }) {
    const selectedModel = this.resolveModel(model);
    const chat = chatId ? this.getChat(userId, chatId) : {
      messages: [],
      settings: {},
      shortTermMemory: { notes: [] },
      workingMemory: { items: {} },
      longTermMemory: { items: {} }
    };
    const settings = this.resolveSettings(chat, {
      shortTermWindow,
      includeWorkingMemory,
      includeLongTermMemory
    });
    const context = this.buildLayeredContext({
      chat,
      userMessage: message,
      settings
    });
    const requestTokens = tokenMeter.estimateTextTokens(context.input) + tokenMeter.estimateTextTokens(context.instructions) + 8;
    const contextLimit = tokenMeter.getModelContextLimit(selectedModel);
    const cost = tokenMeter.estimateCost(requestTokens, 0, selectedModel);

    return {
      model: selectedModel,
      estimate: true,
      currentMessageTokens: tokenMeter.estimateTextTokens(message),
      historyTokens: tokenMeter.estimateTextTokens(context.blocks.shortTerm),
      workingMemoryTokens: tokenMeter.estimateTextTokens(context.blocks.working),
      longTermMemoryTokens: tokenMeter.estimateTextTokens(context.blocks.longTerm),
      instructionTokens: tokenMeter.estimateTextTokens(context.instructions),
      requestTokens,
      responseTokens: 0,
      totalTokens: requestTokens,
      contextLimit,
      remainingTokens: contextLimit - requestTokens,
      usageRatio: contextLimit ? requestTokens / contextLimit : 0,
      overLimit: requestTokens > contextLimit,
      warningLevel: requestTokens > contextLimit ? "error" : requestTokens / contextLimit >= 0.8 ? "warning" : "ok",
      estimatedCostUsd: cost.total,
      layers: context.layerStats
    };
  }

  async streamResponse({ apiKey, userId, chatId, message, model, shortTermWindow, includeWorkingMemory, includeLongTermMemory, manualMemoryWrites, signal, onReady, onText, onComplete }) {
    const userMessage = String(message || "").trim();
    if (!userMessage) throw new Error("Message is required.");

    const selectedModel = this.resolveModel(model);
    let chat = this.store.ensureChat(userId, chatId, {
      title: this.store.titleFromMessage(userMessage),
      settings: {
        shortTermWindow,
        includeWorkingMemory,
        includeLongTermMemory
      }
    });

    chat = this.store.addMessage(userId, chat.id, {
      role: "user",
      content: userMessage
    }) || chat;

    const memoryWrites = [
      ...this.normalizeManualWrites(manualMemoryWrites),
      ...this.routeMemoryWrites(userMessage)
    ];

    const savedWrites = memoryWrites
      .map((write) => this.store.applyMemoryWrite({
        ...write,
        userId,
        chatId: chat.id
      }))
      .filter(Boolean);

    chat = this.getChat(userId, chat.id) || chat;
    onReady?.(chat);

    const settings = this.resolveSettings(chat, {
      shortTermWindow,
      includeWorkingMemory,
      includeLongTermMemory
    });
    const context = this.buildLayeredContext({
      chat,
      userMessage,
      settings
    });
    const requestBody = this.buildRequestBody({
      model: selectedModel,
      instructions: context.instructions,
      input: context.input
    });
    const promptMetrics = this.getTokenSummary({
      userId,
      chatId: chat.id,
      message: userMessage,
      model: selectedModel,
      shortTermWindow: settings.shortTermWindow,
      includeWorkingMemory: settings.includeWorkingMemory,
      includeLongTermMemory: settings.includeLongTermMemory
    });

    if (promptMetrics.overLimit) {
      throw new Error(`Token limit exceeded: request uses about ${promptMetrics.requestTokens} tokens, model limit is ${promptMetrics.contextLimit}.`);
    }

    this.store.recordDebug(userId, chat.id, {
      type: "request_prepared",
      request: {
        route: "/api/chat_memory",
        receivedParameters: {
          chatId: chat.id,
          model: selectedModel,
          shortTermWindow: settings.shortTermWindow,
          includeWorkingMemory: settings.includeWorkingMemory,
          includeLongTermMemory: settings.includeLongTermMemory,
          manualMemoryWrites: this.normalizeManualWrites(manualMemoryWrites)
        },
        memoryWrites: savedWrites,
        memorySnapshot: this.getMemorySnapshot(userId, chat.id),
        contextBlocks: context.blocks,
        openAiRequestBody: requestBody,
        tokenStats: promptMetrics
      },
      response: null
    });

    const response = await this.fetch(this.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal
    });

    if (!response.ok) {
      throw new Error(await this.formatOpenAiError(response));
    }

    let assistantMessage = "";
    let openAiResult = null;

    await this.readSseStream(response.body, {
      onEvent: (event) => {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          assistantMessage += event.delta;
          onText?.(event.delta);
          return;
        }

        if (event.type === "response.completed") {
          openAiResult = event.response || null;
          return;
        }

        if (event.type === "error") {
          const messageText = event.error?.message || event.message || "OpenAI stream returned an error.";
          throw new Error(messageText);
        }
      }
    });

    const finalMetrics = tokenMeter.buildFinalMetrics({
      promptMetrics,
      usage: openAiResult?.usage,
      responseText: assistantMessage,
      model: selectedModel
    });

    let updatedChat = this.store.addMessage(userId, chat.id, {
      role: "assistant",
      content: assistantMessage,
      tokenStats: finalMetrics
    });

    this.store.recordDebug(userId, chat.id, {
      type: "response_completed",
      request: {
        route: "/api/chat_memory",
        receivedParameters: {
          chatId: chat.id,
          model: selectedModel,
          shortTermWindow: settings.shortTermWindow,
          includeWorkingMemory: settings.includeWorkingMemory,
          includeLongTermMemory: settings.includeLongTermMemory
        },
        memoryWrites: savedWrites,
        memorySnapshot: this.getMemorySnapshot(userId, chat.id),
        contextBlocks: context.blocks,
        openAiRequestBody: requestBody,
        tokenStats: promptMetrics
      },
      response: {
        id: openAiResult?.id || null,
        model: openAiResult?.model || selectedModel,
        usage: openAiResult?.usage || null,
        textPreview: assistantMessage.slice(0, 1000),
        tokenStats: finalMetrics
      }
    });

    updatedChat = this.getChat(userId, chat.id) || updatedChat;
    onComplete?.({
      response: openAiResult,
      chat: updatedChat,
      tokenStats: finalMetrics,
      memoryWrites: savedWrites,
      debug: updatedChat.debug
    });
  }

  buildRequestBody({ model, instructions, input }) {
    return {
      model,
      instructions,
      input,
      stream: true,
      store: false
    };
  }

  buildLayeredContext({ chat, userMessage, settings }) {
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    const historyMessages = this.withoutCurrentUserMessage(messages, userMessage);
    const shortTermSummary = chat?.shortTermMemory?.summary?.text || "";
    const recentMessages = historyMessages
      .slice(-settings.shortTermWindow)
      .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
      .join("\n");
    const shortTermNotes = (chat?.shortTermMemory?.notes || [])
      .slice(-10)
      .map((note) => `${note.key}: ${note.value}`)
      .join("\n");
    const shortTermBlock = [
      "Layer: short_term",
      "Purpose: current dialogue only.",
      shortTermSummary
        ? `Compressed summary of older dialogue:\n${shortTermSummary}`
        : "Compressed summary of older dialogue: empty",
      recentMessages ? `Recent messages:\n${recentMessages}` : "Recent messages: empty",
      shortTermNotes ? `Temporary notes:\n${shortTermNotes}` : "Temporary notes: empty"
    ].join("\n");

    const workingItems = settings.includeWorkingMemory
      ? Object.values(chat?.workingMemory?.items || {})
      : [];
    const workingBlock = [
      "Layer: working",
      "Purpose: active task data, constraints, decisions, next steps.",
      workingItems.length
        ? workingItems.map((item) => `${item.category}.${item.key}: ${item.value}`).join("\n")
        : "No working memory supplied."
    ].join("\n");

    const longTermItems = settings.includeLongTermMemory
      ? Object.values(chat?.longTermMemory?.items || {})
      : [];
    const longTermBlock = [
      "Layer: long_term",
      "Purpose: stable user profile, durable decisions, reusable knowledge.",
      longTermItems.length
        ? longTermItems.map((item) => `${item.category}.${item.key}: ${item.value}`).join("\n")
        : "No long-term memory supplied."
    ].join("\n");

    const blocks = {
      shortTerm: shortTermBlock,
      working: workingBlock,
      longTerm: longTermBlock
    };

    return {
      instructions: this.instructions,
      blocks,
      layerStats: {
        short_term: {
          messageCount: historyMessages.length,
          compressedMessageCount: chat?.shortTermMemory?.summary?.messageCount || 0,
          includedMessageCount: Math.min(historyMessages.length, settings.shortTermWindow),
          noteCount: chat?.shortTermMemory?.notes?.length || 0
        },
        working: {
          enabled: settings.includeWorkingMemory,
          itemCount: workingItems.length
        },
        long_term: {
          enabled: settings.includeLongTermMemory,
          itemCount: longTermItems.length
        }
      },
      input: [
        "MEMORY CONTEXT",
        shortTermBlock,
        "",
        workingBlock,
        "",
        longTermBlock,
        "",
        "CURRENT USER MESSAGE",
        userMessage
      ].join("\n")
    };
  }

  withoutCurrentUserMessage(messages, userMessage) {
    if (!messages.length) return messages;
    const lastMessage = messages[messages.length - 1];
    const currentText = String(userMessage || "").trim();
    if (lastMessage?.role === "user" && String(lastMessage.content || "").trim() === currentText) {
      return messages.slice(0, -1);
    }
    return messages;
  }

  routeMemoryWrites(userMessage) {
    const text = String(userMessage || "").trim();
    const lower = text.toLowerCase();
    const writes = [];

    if (/(goal|task|need|build|make|create|implement|feature|constraint|current|цель|задач|нужно|надо|сделай|создай|реализ|фич|ограничени|текущ)/i.test(lower)) {
      writes.push({
        layer: "working",
        category: "task",
        key: "current_task",
        value: text,
        source: "router",
        reason: "Message describes the current task or task constraints."
      });
    }

    if (/(decided|decision|agreed|selected|architecture|решили|решение|договорились|выбрали|архитектур)/i.test(lower)) {
      writes.push({
        layer: "working",
        category: "decision",
        key: `decision_${Date.now()}`,
        value: text,
        source: "router",
        reason: "Message looks like a task-level decision."
      });
    }

    if (/(remember|my name is|i prefer|prefer|my profile|always answer|i like|i dislike|запомни|я предпочитаю|предпочитаю|меня зовут|мой профиль|всегда отвечай|люблю|не люблю)/i.test(lower)) {
      writes.push({
        layer: "long_term",
        category: "profile",
        key: this.inferLongTermKey(lower),
        value: text,
        source: "router",
        reason: "Message contains a durable user profile or preference signal."
      });
    }

    return writes;
  }

  normalizeManualWrites(writes) {
    if (!Array.isArray(writes)) return [];
    return writes
      .map((write) => ({
        layer: write?.layer,
        category: write?.category,
        key: write?.key,
        value: write?.value,
        reason: write?.reason || "Explicitly selected by user in debug memory tool.",
        source: "manual"
      }))
      .filter((write) => write.layer && String(write.value || "").trim());
  }

  inferLongTermKey(lowerText) {
    if (lowerText.includes("my name is") || lowerText.includes("меня зовут")) return "user_name";
    if (lowerText.includes("prefer") || lowerText.includes("предпочитаю")) return "preference";
    if (lowerText.includes("always answer") || lowerText.includes("всегда отвечай")) return "response_style";
    return "profile_note";
  }

  resolveModel(model) {
    return String(model || this.defaultModel).trim() || this.defaultModel;
  }

  resolveSettings(chat, explicit = {}) {
    const current = chat?.settings || {};
    const windowValue = Number(explicit.shortTermWindow || current.shortTermWindow || 10);
    return {
      shortTermWindow: Number.isFinite(windowValue) ? Math.min(40, Math.max(2, Math.round(windowValue))) : 10,
      includeWorkingMemory: typeof explicit.includeWorkingMemory === "boolean"
        ? explicit.includeWorkingMemory
        : current.includeWorkingMemory !== false,
      includeLongTermMemory: typeof explicit.includeLongTermMemory === "boolean"
        ? explicit.includeLongTermMemory
        : current.includeLongTermMemory !== false
    };
  }

  async formatOpenAiError(response) {
    const responseText = await response.text();
    try {
      const payload = JSON.parse(responseText);
      return payload?.error?.message || payload?.message || responseText;
    } catch {
      return responseText || `${response.status} ${response.statusText}`;
    }
  }

  async readSseStream(body, { onEvent }) {
    if (!body) {
      throw new Error("OpenAI response did not include a readable stream.");
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let boundaryIndex = buffer.indexOf("\n\n");

      while (boundaryIndex !== -1) {
        const rawEvent = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        this.parseSseEvent(rawEvent, onEvent);
        boundaryIndex = buffer.indexOf("\n\n");
      }
    }

    if (buffer.trim()) {
      this.parseSseEvent(buffer, onEvent);
    }
  }

  parseSseEvent(rawEvent, onEvent) {
    const data = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") return;
    onEvent(JSON.parse(data));
  }
}

module.exports = MemoryAgent;
