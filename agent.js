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

  resolveCompressionEnabled(chat, explicitValue) {
    if (typeof explicitValue === "boolean") return explicitValue;
    return chat?.settings?.compressionEnabled !== false;
  }

  resolveSummaryBatchSize(chat, explicitValue) {
    const value = Number(explicitValue || chat?.settings?.summaryBatchSize || 10);
    return Number.isFinite(value) ? Math.max(2, Math.round(value)) : 10;
  }

  getTokenSummary({ userId, chatId, message = "", model, compressionEnabled, summaryBatchSize }) {
    const selectedModel = String(model || this.defaultModel).trim() || this.defaultModel;
    const chat = chatId ? this.getChat(userId, chatId) : null;
    const historyMessages = chat?.messages || [];
    const resolvedCompressionEnabled = this.resolveCompressionEnabled(chat, compressionEnabled);
    const resolvedSummaryBatchSize = this.resolveSummaryBatchSize(chat, summaryBatchSize);

    return this.contextManager.buildMetrics({
      memory: chat?.memory,
      storedHistoryMessages: historyMessages,
      currentMessage: message,
      instructions: this.instructions,
      model: selectedModel,
      compressionEnabled: resolvedCompressionEnabled,
      settings: {
        summaryBatchSize: resolvedSummaryBatchSize
      }
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
          role: item?.role === "summary" ? "summary" : item?.role === "assistant" ? "assistant" : "user",
          content: String(item?.content || "").trim()
        }))
        .filter((item) => item.content)
      : [];

    return safeMessages
      .map((item) => {
        const label = item.role === "summary" ? "Context summary" : item.role === "assistant" ? "Assistant" : "User";
        return `${label}: ${item.content}`;
      })
      .join("\n\n");
  }

  async streamResponse({ apiKey, userId, chatId, message, model, compressionEnabled, summaryBatchSize, signal, onReady, onText, onComplete }) {
    const userMessage = String(message || "").trim();
    if (!userMessage) {
      throw new Error("Message is required.");
    }

    const chat = this.historyStore.ensureChat(userId, chatId, {
      title: this.historyStore.titleFromMessage(userMessage),
      settings: {
        compressionEnabled: compressionEnabled !== false,
        summaryBatchSize: this.resolveSummaryBatchSize(null, summaryBatchSize)
      }
    });
    const readyChat = this.getChat(userId, chat.id) || chat;
    onReady?.(readyChat);

    const compressionActive = this.resolveCompressionEnabled(readyChat, compressionEnabled);
    const resolvedSummaryBatchSize = this.resolveSummaryBatchSize(readyChat, summaryBatchSize);
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
    const activeChat = compressedChat || this.getChat(userId, chat.id) || readyChat;
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
    const promptMetrics = this.contextManager.buildMetrics({
      memory: activeChat.memory,
      storedHistoryMessages: requestMessages.slice(0, -1),
      currentMessage: userMessage,
      instructions: this.instructions,
      model: selectedModel,
      compressionEnabled: compressionActive,
      settings: {
        summaryBatchSize: resolvedSummaryBatchSize
      }
    });

    if (promptMetrics.overLimit) {
      throw new Error(`Token limit exceeded: request uses about ${promptMetrics.requestTokens} tokens, model limit is ${promptMetrics.contextLimit}.`);
    }

    const contextMessages = this.contextManager.buildContextMessages(activeChat.memory, requestMessages, {
      compressionEnabled: compressionActive
    });
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
      const updatedChat = this.historyStore.addMessages(userId, chat.id, [
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
      onComplete?.({
        response: openAiResult,
        chat: updatedChat,
        tokenStats: finalMetrics
      });
    }
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
