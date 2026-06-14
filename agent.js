const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ChatHistoryStore = require("./chatHistoryStore");
const ContextManager = require("./contextManager");
const tokenMeter = require("./tokenMeter");

class ChatAgent {
  constructor(options = {}) {
    this.apiUrl = options.apiUrl || OPENAI_RESPONSES_URL;
    this.fetch = options.fetchImpl || fetch;
    this.defaultModel = options.defaultModel || "gpt-4.1-mini";
    this.historyStore = options.historyStore || new ChatHistoryStore(options.historyFilePath);
    this.contextManager = options.contextManager || new ContextManager(options.contextOptions);
    this.instructions = options.instructions || [
      "You are a helpful AI chat agent.",
      "Answer clearly, naturally, and in the same language the user uses when possible."
    ].join(" ");
  }

  listChats(userId) {
    return this.historyStore.listChats(userId);
  }

  createChat(userId, options) {
    return this.historyStore.createChat(userId, options);
  }

  getChat(userId, chatId) {
    return this.historyStore.getChat(userId, chatId);
  }

  getHistory(userId, chatId) {
    return this.historyStore.getMessages(userId, chatId);
  }

  clearHistory(userId, chatId) {
    return this.historyStore.clearChat(userId, chatId);
  }

  deleteChat(userId, chatId) {
    return this.historyStore.deleteChat(userId, chatId);
  }

  updateChatSettings(userId, chatId, settings) {
    return this.historyStore.updateChatSettings(userId, chatId, settings);
  }

  saveCheckpoint(userId, chatId) {
    return this.historyStore.saveCheckpoint(userId, chatId);
  }

  createBranch(userId, chatId, name) {
    return this.historyStore.createBranch(userId, chatId, name);
  }

  switchBranch(userId, chatId, branchId) {
    return this.historyStore.switchBranch(userId, chatId, branchId);
  }

  resolveCompressionEnabled(chat, explicitValue) {
    if (typeof explicitValue === "boolean") return explicitValue;
    return chat?.settings?.compressionEnabled !== false;
  }

  resolveSummaryBatchSize(chat, explicitValue) {
    const value = Number(explicitValue || chat?.settings?.summaryBatchSize || 10);
    return Number.isFinite(value) ? Math.max(2, Math.round(value)) : 10;
  }

  resolveWindowSize(chat, explicitValue) {
    const value = Number(explicitValue || chat?.settings?.windowSize || 8);
    return Number.isFinite(value) ? Math.min(40, Math.max(2, Math.round(value))) : 8;
  }

  resolveContextStrategy(chat, explicitValue) {
    const strategy = String(explicitValue || chat?.settings?.contextStrategy || "sliding");
    return ["sliding", "facts", "branching"].includes(strategy) ? strategy : "sliding";
  }

  getTokenSummary({ userId, chatId, message = "", model, compressionEnabled, summaryBatchSize, contextStrategy, windowSize }) {
    const selectedModel = String(model || this.defaultModel).trim() || this.defaultModel;
    const chat = chatId ? this.getChat(userId, chatId) : null;
    const historyMessages = chat?.messages || [];
    const strategy = this.resolveContextStrategy(chat, contextStrategy);
    const resolvedWindowSize = this.resolveWindowSize(chat, windowSize);
    const contextMessages = this.buildStrategyMessages({
      strategy,
      facts: chat?.memory?.facts,
      messages: historyMessages,
      windowSize: resolvedWindowSize
    });

    return this.buildStrategyMetrics({
      strategy,
      windowSize: resolvedWindowSize,
      contextMessages,
      storedHistoryMessages: historyMessages,
      currentMessage: message,
      instructions: this.instructions,
      model: selectedModel
    });
  }

  buildRequestBody({ messages, model }) {
    const selectedModel = String(model || this.defaultModel).trim() || this.defaultModel;
    const conversation = this.buildConversationInput(messages);

    return {
      model: selectedModel,
      instructions: this.instructions,
      input: conversation,
      stream: true,
      store: false
    };
  }

  buildConversationInput(messages) {
    const safeMessages = Array.isArray(messages)
      ? messages
        .map((item) => ({
          role: item?.role === "facts" ? "facts" : item?.role === "summary" ? "summary" : item?.role === "assistant" ? "assistant" : "user",
          content: String(item?.content || "").trim()
        }))
        .filter((item) => item.content)
      : [];

    return safeMessages
      .map((item) => {
        const label = item.role === "facts" ? "Sticky facts" : item.role === "summary" ? "Context summary" : item.role === "assistant" ? "Assistant" : "User";
        return `${label}: ${item.content}`;
      })
      .join("\n\n");
  }

  async streamResponse({ apiKey, userId, chatId, message, model, compressionEnabled, summaryBatchSize, contextStrategy, windowSize, signal, onReady, onText, onComplete }) {
    const userMessage = String(message || "").trim();
    if (!userMessage) {
      throw new Error("Message is required.");
    }

    const chat = this.historyStore.ensureChat(userId, chatId, {
      title: this.historyStore.titleFromMessage(userMessage),
      settings: {
        compressionEnabled: compressionEnabled !== false,
        summaryBatchSize: this.resolveSummaryBatchSize(null, summaryBatchSize),
        contextStrategy: this.resolveContextStrategy(null, contextStrategy),
        windowSize: this.resolveWindowSize(null, windowSize)
      }
    });
    const readyChat = this.getChat(userId, chat.id) || chat;
    onReady?.(readyChat);

    const strategy = this.resolveContextStrategy(readyChat, contextStrategy);
    const resolvedWindowSize = this.resolveWindowSize(readyChat, windowSize);
    const compressionActive = false;
    const resolvedSummaryBatchSize = this.resolveSummaryBatchSize(readyChat, summaryBatchSize);
    let activeChat = readyChat;

    if (strategy === "facts") {
      activeChat = await this.updateFactsForChat({
        apiKey,
        userId,
        chatId: chat.id,
        model: String(model || this.defaultModel).trim() || this.defaultModel,
        userMessage,
        signal
      }) || activeChat;
    }

    const compressedChat = compressionActive
      ? await this.compressChatContext({
        apiKey,
        userId,
        chatId: chat.id,
        model: String(model || this.defaultModel).trim() || this.defaultModel,
        settings: {
          summaryBatchSize: resolvedSummaryBatchSize
        },
        signal
      })
      : null;
    activeChat = compressedChat || this.getChat(userId, chat.id) || activeChat;
    if (compressedChat) {
      onReady?.(activeChat);
    }

    const requestMessages = [
      ...(activeChat.messages || []),
      {
        role: "user",
        content: userMessage
      }
    ];
    const selectedModel = String(model || this.defaultModel).trim() || this.defaultModel;
    const contextMessages = this.buildStrategyMessages({
      strategy,
      facts: activeChat.memory?.facts,
      messages: requestMessages,
      windowSize: resolvedWindowSize
    });
    const promptMetrics = this.buildStrategyMetrics({
      strategy,
      windowSize: resolvedWindowSize,
      contextMessages,
      storedHistoryMessages: requestMessages.slice(0, -1),
      currentMessage: userMessage,
      instructions: this.instructions,
      model: selectedModel
    });

    if (promptMetrics.overLimit) {
      throw new Error(`Token limit exceeded: request uses about ${promptMetrics.requestTokens} tokens, model limit is ${promptMetrics.contextLimit}.`);
    }

    const requestBody = this.buildRequestBody({ messages: contextMessages, model: selectedModel });
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

    if (assistantMessage.trim()) {
      const finalMetrics = tokenMeter.buildFinalMetrics({
        promptMetrics,
        usage: openAiResult?.usage,
        responseText: assistantMessage,
        model: selectedModel
      });
      let updatedChat = this.historyStore.addMessages(userId, chat.id, [
        {
          role: "user",
          content: userMessage
        },
        {
          role: "assistant",
          content: assistantMessage,
          tokenStats: finalMetrics
        }
      ], finalMetrics);

      if (strategy === "sliding" && updatedChat) {
        updatedChat = this.historyStore.replaceChatContext(userId, chat.id, {
          memory: updatedChat.memory,
          messages: updatedChat.messages.slice(-resolvedWindowSize)
        }) || updatedChat;
      }

      onComplete?.({
        response: openAiResult,
        chat: updatedChat,
        tokenStats: finalMetrics
      });
    }
  }

  buildStrategyMessages({ strategy, facts, messages, windowSize }) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const recentMessages = safeMessages.slice(-windowSize);

    if (strategy !== "facts") {
      return recentMessages;
    }

    const factsText = this.formatFacts(facts);
    return factsText
      ? [
        {
          role: "facts",
          content: factsText
        },
        ...recentMessages
      ]
      : recentMessages;
  }

  buildStrategyMetrics({ strategy, windowSize, contextMessages, storedHistoryMessages, currentMessage, instructions, model }) {
    const safeContextMessages = Array.isArray(contextMessages) ? contextMessages : [];
    const safeStoredHistory = Array.isArray(storedHistoryMessages) ? storedHistoryMessages : [];
    const currentMessageTokens = tokenMeter.estimateTextTokens(currentMessage);
    const instructionTokens = tokenMeter.estimateTextTokens(instructions);
    const historyTokens = tokenMeter.estimateMessagesTokens(safeContextMessages);
    const fullHistoryTokens = tokenMeter.estimateMessagesTokens(safeStoredHistory);
    const requestTokens = historyTokens + currentMessageTokens + instructionTokens + 8;
    const fullRequestTokens = fullHistoryTokens + currentMessageTokens + instructionTokens + 8;
    const savedTokens = Math.max(0, fullRequestTokens - requestTokens);
    const contextLimit = tokenMeter.getModelContextLimit(model);
    const remainingTokens = contextLimit - requestTokens;
    const usageRatio = contextLimit ? requestTokens / contextLimit : 0;
    const cost = tokenMeter.estimateCost(requestTokens, 0, model);

    return {
      model,
      estimate: true,
      currentMessageTokens,
      historyTokens,
      instructionTokens,
      requestTokens,
      responseTokens: 0,
      totalTokens: requestTokens,
      contextLimit,
      remainingTokens,
      usageRatio,
      overLimit: requestTokens > contextLimit,
      warningLevel: requestTokens > contextLimit ? "error" : usageRatio >= 0.8 ? "warning" : "ok",
      estimatedCostUsd: cost.total,
      strategy: {
        name: strategy,
        windowSize,
        contextMessageCount: safeContextMessages.length,
        storedMessageCount: safeStoredHistory.length,
        fullHistoryTokens,
        requestTokens,
        fullRequestTokens,
        savedTokens,
        savingsRatio: fullRequestTokens ? savedTokens / fullRequestTokens : 0
      },
      compression: {
        configured: false,
        enabled: false,
        recentMessageLimit: windowSize,
        summaryBatchSize: 0,
        summarizedMessageCount: 0,
        recentMessageCount: safeContextMessages.length,
        summaryTokens: 0,
        compressedHistoryTokens: historyTokens,
        fullHistoryTokens,
        compressedRequestTokens: requestTokens,
        fullRequestTokens,
        savedTokens,
        savingsRatio: fullRequestTokens ? savedTokens / fullRequestTokens : 0,
        compressionRuns: 0
      }
    };
  }

  formatFacts(facts = {}) {
    const entries = Object.entries(facts || {})
      .map(([key, value]) => [String(key || "").trim(), String(value || "").trim()])
      .filter(([key, value]) => key && value);

    return entries.map(([key, value]) => `${key}: ${value}`).join("\n");
  }

  async updateFactsForChat({ apiKey, userId, chatId, model, userMessage, signal }) {
    const chat = this.getChat(userId, chatId);
    if (!chat) return null;

    let facts;
    try {
      facts = await this.createFactsWithModel({
        apiKey,
        model,
        previousFacts: chat.memory?.facts || {},
        userMessage,
        signal
      });
    } catch {
      facts = this.createLocalFacts(chat.memory?.facts || {}, userMessage);
    }

    return this.historyStore.updateFacts(userId, chatId, facts);
  }

  async createFactsWithModel({ apiKey, model, previousFacts, userMessage, signal }) {
    const response = await this.fetch(this.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        instructions: [
          "Extract durable sticky facts from the user's message for a chat agent.",
          "Keep only stable key-value facts: goal, constraints, preferences, decisions, agreements, names, open_questions.",
          "Return only a compact JSON object. Do not include a summary or markdown."
        ].join(" "),
        input: [
          "Existing facts JSON:",
          JSON.stringify(previousFacts || {}),
          "",
          "Latest user message:",
          userMessage
        ].join("\n"),
        max_output_tokens: 500,
        store: false
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(`Facts update failed: ${response.status}`);
    }

    const payload = await response.json();
    const text = this.extractResponseText(payload);
    const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
    return this.cleanFacts({
      ...(previousFacts || {}),
      ...parsed
    });
  }

  extractResponseText(payload) {
    if (typeof payload?.output_text === "string") return payload.output_text;
    if (!Array.isArray(payload?.output)) return "";

    return payload.output
      .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .map((content) => content?.text || "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  createLocalFacts(previousFacts, userMessage) {
    return this.cleanFacts({
      ...(previousFacts || {}),
      latest_user_fact: String(userMessage || "").replace(/\s+/g, " ").trim().slice(0, 300)
    });
  }

  cleanFacts(facts) {
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

  async compressChatContext({ apiKey, userId, chatId, model, settings, signal }) {
    const chat = this.getChat(userId, chatId);
    if (!chat) return null;

    const result = await this.contextManager.compressIfNeeded({
      apiKey,
      apiUrl: this.apiUrl,
      fetchImpl: this.fetch,
      model,
      memory: chat.memory,
      messages: chat.messages,
      settings,
      signal
    });

    if (!result.compressed) return null;

    return this.historyStore.replaceChatContext(userId, chatId, {
      memory: result.memory,
      messages: result.messages
    });
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

    const event = JSON.parse(data);
    onEvent(event);
  }
}

module.exports = ChatAgent;
