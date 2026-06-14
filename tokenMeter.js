const DEFAULT_CONTEXT_LIMIT = 128000;

const MODEL_CONTEXT_LIMITS = {
  "gpt-4.1": 1000000,
  "gpt-4.1-mini": 1000000,
  "gpt-4.1-nano": 1000000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-5": 400000,
  "gpt-5-mini": 400000,
  "gpt-5-nano": 400000
};

const MODEL_PRICES_PER_MILLION = {
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 }
};

function getModelContextLimit(model) {
  return MODEL_CONTEXT_LIMITS[model] || DEFAULT_CONTEXT_LIMIT;
}

function getModelPrices(model) {
  return MODEL_PRICES_PER_MILLION[model] || MODEL_PRICES_PER_MILLION["gpt-4.1-mini"];
}

function estimateTextTokens(value) {
  const text = String(value || "").trim();
  if (!text) return 0;

  const compact = text.replace(/\s+/g, " ");
  const wordLike = compact.match(/[\p{L}\p{N}_]+/gu) || [];
  const punctuation = compact.match(/[^\s\p{L}\p{N}_]/gu) || [];
  const cyrillicChars = compact.match(/\p{Script=Cyrillic}/gu) || [];
  const baseEstimate = Math.ceil(compact.length / (cyrillicChars.length ? 3.2 : 4));
  const structuralEstimate = Math.ceil((wordLike.length * 1.25) + (punctuation.length * 0.35));

  return Math.max(1, baseEstimate, structuralEstimate);
}

function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;

  return messages.reduce((total, message) => {
    const contentTokens = estimateTextTokens(message?.content);
    return total + contentTokens + 4;
  }, 0);
}

function estimateCost(inputTokens, outputTokens, model) {
  const prices = getModelPrices(model);
  const inputCost = (Number(inputTokens || 0) * prices.input) / 1000000;
  const outputCost = (Number(outputTokens || 0) * prices.output) / 1000000;
  return {
    input: inputCost,
    output: outputCost,
    total: inputCost + outputCost
  };
}

function buildPromptMetrics({ historyMessages, currentMessage, instructions, model }) {
  const currentMessageTokens = estimateTextTokens(currentMessage);
  const historyTokens = estimateMessagesTokens(historyMessages);
  const instructionTokens = estimateTextTokens(instructions);
  const requestTokens = historyTokens + currentMessageTokens + instructionTokens + 8;
  const contextLimit = getModelContextLimit(model);
  const remainingTokens = contextLimit - requestTokens;
  const usageRatio = contextLimit ? requestTokens / contextLimit : 0;
  const cost = estimateCost(requestTokens, 0, model);

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
    estimatedCostUsd: cost.total
  };
}

function buildFinalMetrics({ promptMetrics, usage, responseText, model }) {
  const inputTokens = usage?.input_tokens || usage?.prompt_tokens || promptMetrics.requestTokens;
  const responseTokens = usage?.output_tokens || usage?.completion_tokens || estimateTextTokens(responseText);
  const totalTokens = usage?.total_tokens || inputTokens + responseTokens;
  const cost = estimateCost(inputTokens, responseTokens, model);

  return {
    ...promptMetrics,
    estimate: !usage,
    requestTokens: inputTokens,
    responseTokens,
    totalTokens,
    remainingTokens: promptMetrics.contextLimit - inputTokens,
    usageRatio: promptMetrics.contextLimit ? inputTokens / promptMetrics.contextLimit : 0,
    overLimit: inputTokens > promptMetrics.contextLimit,
    warningLevel: inputTokens > promptMetrics.contextLimit ? "error" : inputTokens / promptMetrics.contextLimit >= 0.8 ? "warning" : "ok",
    estimatedCostUsd: cost.total,
    inputCostUsd: cost.input,
    outputCostUsd: cost.output
  };
}

module.exports = {
  buildFinalMetrics,
  buildPromptMetrics,
  estimateCost,
  estimateMessagesTokens,
  estimateTextTokens,
  getModelContextLimit
};
