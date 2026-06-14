const tokenMeter = require("./tokenMeter");

const DEFAULT_RECENT_MESSAGE_LIMIT = 8;
const DEFAULT_SUMMARY_BATCH_SIZE = 10;
const DEFAULT_SUMMARY_MAX_CHARS = 3000;

class ContextManager {
  constructor(options = {}) {
    this.recentMessageLimit = Number(options.recentMessageLimit || process.env.CHAT_RECENT_MESSAGES || DEFAULT_RECENT_MESSAGE_LIMIT);
    this.summaryBatchSize = Number(options.summaryBatchSize || process.env.CHAT_SUMMARY_BATCH_SIZE || DEFAULT_SUMMARY_BATCH_SIZE);
    this.summaryMaxChars = Number(options.summaryMaxChars || process.env.CHAT_SUMMARY_MAX_CHARS || DEFAULT_SUMMARY_MAX_CHARS);

    if (!Number.isFinite(this.recentMessageLimit) || this.recentMessageLimit < 2) {
      this.recentMessageLimit = DEFAULT_RECENT_MESSAGE_LIMIT;
    }

    if (!Number.isFinite(this.summaryBatchSize) || this.summaryBatchSize < 2) {
      this.summaryBatchSize = DEFAULT_SUMMARY_BATCH_SIZE;
    }
  }

  createMemory(memory = {}) {
    return {
      summary: String(memory.summary || "").trim(),
      summarizedMessageCount: Number(memory.summarizedMessageCount || 0),
      originalTokenEstimate: Number(memory.originalTokenEstimate || 0),
      summaryTokenEstimate: Number(memory.summaryTokenEstimate || 0),
      compressionRuns: Number(memory.compressionRuns || 0),
      recentMessageLimit: Number(memory.recentMessageLimit || this.recentMessageLimit),
      summaryBatchSize: Number(memory.summaryBatchSize || this.summaryBatchSize),
      updatedAt: memory.updatedAt || null
    };
  }

  createPolicy(settings = {}) {
    const summaryBatchSize = Number(settings.summaryBatchSize || this.summaryBatchSize);

    return {
      recentMessageLimit: this.recentMessageLimit,
      summaryBatchSize: Number.isFinite(summaryBatchSize)
        ? Math.max(2, Math.round(summaryBatchSize))
        : this.summaryBatchSize
    };
  }

  getCompressibleCount(messages, settings = {}) {
    const policy = this.createPolicy(settings);
    const safeMessages = Array.isArray(messages) ? messages : [];
    const excessCount = safeMessages.length - policy.recentMessageLimit;
    return excessCount >= policy.summaryBatchSize ? excessCount : 0;
  }

  buildContextMessages(memory, messages, options = {}) {
    const compressionEnabled = options.compressionEnabled !== false;
    const safeMemory = this.createMemory(memory);
    const safeMessages = Array.isArray(messages) ? messages : [];

    if (!compressionEnabled || !safeMemory.summary) {
      return safeMessages;
    }

    return [
      {
        role: "summary",
        content: [
          "Conversation summary from earlier messages.",
          "Use it as context, but prefer the recent verbatim messages when there is a conflict.",
          "",
          safeMemory.summary
        ].join("\n")
      },
      ...safeMessages
    ];
  }

  buildMetrics({ memory, storedHistoryMessages, currentMessage, instructions, model, compressionEnabled = true, settings = {} }) {
    const policy = this.createPolicy(settings);
    const safeMemory = this.createMemory(memory);
    const safeStoredHistory = Array.isArray(storedHistoryMessages) ? storedHistoryMessages : [];
    const compressionActive = compressionEnabled !== false;
    const compressedHistoryMessages = this.buildContextMessages(safeMemory, safeStoredHistory, {
      compressionEnabled: compressionActive
    });
    const currentMessageTokens = tokenMeter.estimateTextTokens(currentMessage);
    const instructionTokens = tokenMeter.estimateTextTokens(instructions);
    const compressedHistoryTokens = tokenMeter.estimateMessagesTokens(compressedHistoryMessages);
    const storedHistoryTokens = tokenMeter.estimateMessagesTokens(safeStoredHistory);
    const fullHistoryTokens = safeMemory.originalTokenEstimate + storedHistoryTokens;
    const requestTokens = compressedHistoryTokens + currentMessageTokens + instructionTokens + 8;
    const fullRequestTokens = fullHistoryTokens + currentMessageTokens + instructionTokens + 8;
    const savedTokens = compressionActive ? Math.max(0, fullRequestTokens - requestTokens) : 0;
    const contextLimit = tokenMeter.getModelContextLimit(model);
    const remainingTokens = contextLimit - requestTokens;
    const usageRatio = contextLimit ? requestTokens / contextLimit : 0;
    const cost = tokenMeter.estimateCost(requestTokens, 0, model);

    return {
      model,
      estimate: true,
      currentMessageTokens,
      historyTokens: compressedHistoryTokens,
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
      compression: {
        configured: compressionActive,
        enabled: compressionActive && Boolean(safeMemory.summary),
        recentMessageLimit: policy.recentMessageLimit,
        summaryBatchSize: policy.summaryBatchSize,
        summarizedMessageCount: safeMemory.summarizedMessageCount,
        recentMessageCount: safeStoredHistory.length,
        summaryTokens: compressionActive ? tokenMeter.estimateTextTokens(safeMemory.summary) : 0,
        compressedHistoryTokens,
        fullHistoryTokens,
        compressedRequestTokens: requestTokens,
        fullRequestTokens,
        savedTokens,
        savingsRatio: fullRequestTokens ? savedTokens / fullRequestTokens : 0,
        compressionRuns: safeMemory.compressionRuns
      }
    };
  }

  async compressIfNeeded({ apiKey, apiUrl, fetchImpl, model, memory, messages, settings = {}, signal }) {
    const policy = this.createPolicy(settings);
    const safeMessages = Array.isArray(messages) ? messages : [];
    const compressibleCount = this.getCompressibleCount(safeMessages, policy);

    if (!compressibleCount) {
      return {
        memory: this.createMemory(memory),
        messages: safeMessages,
        compressed: false
      };
    }

    const chunk = safeMessages.slice(0, compressibleCount);
    const remainingMessages = safeMessages.slice(compressibleCount);
    const previousMemory = this.createMemory(memory);
    const chunkTokenEstimate = tokenMeter.estimateMessagesTokens(chunk);
    let summary = "";

    try {
      summary = await this.createSummaryWithModel({
        apiKey,
        apiUrl,
        fetchImpl,
        model,
        previousSummary: previousMemory.summary,
        messages: chunk,
        signal
      });
    } catch {
      summary = this.createLocalSummary(previousMemory.summary, chunk);
    }

    const nextMemory = this.createMemory({
      summary,
      summarizedMessageCount: previousMemory.summarizedMessageCount + chunk.length,
      originalTokenEstimate: previousMemory.originalTokenEstimate + chunkTokenEstimate,
      summaryTokenEstimate: tokenMeter.estimateTextTokens(summary),
      compressionRuns: previousMemory.compressionRuns + 1,
      recentMessageLimit: policy.recentMessageLimit,
      summaryBatchSize: policy.summaryBatchSize,
      updatedAt: new Date().toISOString()
    });

    return {
      memory: nextMemory,
      messages: remainingMessages,
      compressed: true,
      compressedMessageCount: chunk.length
    };
  }

  async createSummaryWithModel({ apiKey, apiUrl, fetchImpl, model, previousSummary, messages, signal }) {
    if (!apiKey || !apiUrl || typeof fetchImpl !== "function") {
      throw new Error("Summary request is not configured.");
    }

    const response = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        instructions: [
          "You compress chat history for another assistant.",
          "Keep durable facts, user goals, constraints, decisions, names, preferences, open tasks, and unresolved questions.",
          "Remove greetings, filler, duplicates, and wording that is not needed later.",
          "Return a compact structured summary in the user's main language when possible."
        ].join(" "),
        input: this.buildSummaryInput(previousSummary, messages),
        max_output_tokens: 700,
        store: false
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(`Summary request failed: ${response.status}`);
    }

    const payload = await response.json();
    const text = this.extractResponseText(payload).trim();
    if (!text) {
      throw new Error("Summary response was empty.");
    }

    return this.limitSummary(text);
  }

  buildSummaryInput(previousSummary, messages) {
    const historyText = messages
      .map((message, index) => {
        const label = message.role === "assistant" ? "Assistant" : "User";
        return `${index + 1}. ${label}: ${String(message.content || "").trim()}`;
      })
      .join("\n\n");

    return [
      "Previous summary:",
      String(previousSummary || "").trim() || "(none)",
      "",
      "Messages to fold into the summary:",
      historyText
    ].join("\n");
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

  createLocalSummary(previousSummary, messages) {
    const lines = [];
    const currentSummary = String(previousSummary || "").trim();
    if (currentSummary) {
      lines.push(currentSummary);
    }

    lines.push("Compressed older messages:");
    messages.forEach((message) => {
      const label = message.role === "assistant" ? "Assistant" : "User";
      const compactContent = String(message.content || "").replace(/\s+/g, " ").trim();
      if (compactContent) {
        lines.push(`- ${label}: ${compactContent.slice(0, 260)}`);
      }
    });

    return this.limitSummary(lines.join("\n"));
  }

  limitSummary(summary) {
    const compactSummary = String(summary || "").trim();
    if (compactSummary.length <= this.summaryMaxChars) return compactSummary;
    return compactSummary.slice(0, this.summaryMaxChars - 3).trimEnd() + "...";
  }
}

module.exports = ContextManager;
