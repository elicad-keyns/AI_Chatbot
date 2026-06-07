const form = document.querySelector("#settingsForm");
const apiKeyInput = document.querySelector("#apiKey");
const modelInput = document.querySelector("#model");
const customModelInput = document.querySelector("#customModel");
const modelSupportHint = document.querySelector("#modelSupportHint");
const instructionsInput = document.querySelector("#instructions");
const useExpertsInput = document.querySelector("#useExperts");
const expertList = document.querySelector("#expertList");
const addExpertButton = document.querySelector("#addExpert");
const promptInput = document.querySelector("#prompt");
const temperatureInput = document.querySelector("#temperature");
const topPInput = document.querySelector("#topP");
const presencePenaltyInput = document.querySelector("#presencePenalty");
const frequencyPenaltyInput = document.querySelector("#frequencyPenalty");
const maxOutputTokensInput = document.querySelector("#maxOutputTokens");
const textVerbosityInput = document.querySelector("#textVerbosity");
const topKInput = document.querySelector("#topK");
const topVInput = document.querySelector("#topV");
const reasoningEffortInput = document.querySelector("#reasoningEffort");
const reasoningHint = document.querySelector("#reasoningHint");
const extraJsonInput = document.querySelector("#extraJson");
const requestPreview = document.querySelector("#requestPreview");
const responsePreview = document.querySelector("#responsePreview");
const metricLatency = document.querySelector("#metricLatency");
const metricInputTokens = document.querySelector("#metricInputTokens");
const metricOutputTokens = document.querySelector("#metricOutputTokens");
const metricTotalTokens = document.querySelector("#metricTotalTokens");
const metricCost = document.querySelector("#metricCost");
const statusPill = document.querySelector("#statusPill");
const sendButton = document.querySelector("#sendButton");
const resetButton = document.querySelector("#resetButton");
const toggleParsedButton = document.querySelector("#toggleParsed");
const copyRequestButton = document.querySelector("#copyRequest");
const copyResponseButton = document.querySelector("#copyResponse");

const parameterInputs = [
  temperatureInput,
  topPInput,
  presencePenaltyInput,
  frequencyPenaltyInput,
  maxOutputTokensInput,
  textVerbosityInput,
  topKInput,
  topVInput,
  reasoningEffortInput
];

const parameterNotes = {
  temperature: document.querySelector("#temperatureNote"),
  top_p: document.querySelector("#topPNote"),
  presence_penalty: document.querySelector("#presencePenaltyNote"),
  frequency_penalty: document.querySelector("#frequencyPenaltyNote")
};

const gpt5Profile = {
  family: "gpt-5",
  defaultReasoning: "medium",
  reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  samplingRequiresReasoningNone: true,
  supportsSampling: true,
  supportsTextVerbosity: true
};

const gpt5LegacyProfile = {
  ...gpt5Profile,
  reasoningEfforts: ["none", "low", "medium", "high"]
};

const gptTextProfile = {
  family: "gpt-text",
  defaultReasoning: null,
  reasoningEfforts: [],
  samplingRequiresReasoningNone: false,
  supportsSampling: true,
  supportsTextVerbosity: false
};

const oSeriesProfile = {
  family: "o-series",
  defaultReasoning: "medium",
  reasoningEfforts: ["low", "medium", "high"],
  samplingRequiresReasoningNone: false,
  supportsSampling: false,
  supportsTextVerbosity: false
};

const modelProfiles = {
  "gpt-5.5": gpt5Profile,
  "gpt-5.4": gpt5Profile,
  "gpt-5.4-mini": gpt5Profile,
  "gpt-5.4-nano": gpt5Profile,
  "gpt-5.2": gpt5LegacyProfile,
  "gpt-5.2-pro": gpt5LegacyProfile,
  "gpt-5.2-chat-latest": gpt5LegacyProfile,
  "gpt-5.2-codex": gpt5LegacyProfile,
  "gpt-5.1": gpt5LegacyProfile,
  "gpt-5.1-chat-latest": gpt5LegacyProfile,
  "gpt-5.1-codex": gpt5LegacyProfile,
  "gpt-5.1-codex-max": gpt5LegacyProfile,
  "gpt-5": gpt5LegacyProfile,
  "gpt-5-mini": gpt5LegacyProfile,
  "gpt-5-nano": gpt5LegacyProfile,
  "gpt-5-pro": gpt5LegacyProfile,
  "gpt-5-chat-latest": gpt5LegacyProfile,
  "gpt-5-codex": gpt5LegacyProfile,
  "gpt-4.1": gptTextProfile,
  "gpt-4.1-mini": gptTextProfile,
  "gpt-4.1-nano": gptTextProfile,
  "gpt-4o": gptTextProfile,
  "gpt-4o-mini": gptTextProfile,
  "o3": oSeriesProfile,
  "o3-mini": oSeriesProfile,
  "o3-pro": oSeriesProfile,
  "o4-mini": oSeriesProfile,
  custom: {
    family: "custom",
    defaultReasoning: null,
    reasoningEfforts: [],
    samplingRequiresReasoningNone: false,
    supportsSampling: true,
    supportsTextVerbosity: true
  }
};

const modelPricing = {
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2-chat-latest": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2-pro": { input: 21, cachedInput: null, output: 168 },
  "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.1-chat-latest": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.1-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.1-codex-max": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5-chat-latest": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
  "gpt-5-pro": { input: 15, cachedInput: null, output: 120 },
  "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4 },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  o3: { input: 2, cachedInput: 0.5, output: 8 },
  "o3-mini": { input: 1.1, cachedInput: 0.55, output: 4.4 },
  "o3-pro": { input: 20, cachedInput: null, output: 80 },
  "o4-mini": { input: 1.1, cachedInput: 0.275, output: 4.4 }
};

const defaultExperts = [
  {
    role: "Аналитик",
    focus: "Оцени рынок, риски, метрики и бизнес-эффект."
  },
  {
    role: "Инженер",
    focus: "Оцени реализацию, ограничения, архитектуру и технические риски."
  },
  {
    role: "Критик",
    focus: "Найди слабые места, спорные допущения и что нужно проверить."
  }
];

let experts = defaultExperts.map((expert) => ({ ...expert }));
let lastResponse = null;
let responseMode = "json";

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function maskApiKey(value) {
  const key = value.trim();
  if (!key) return "";
  if (key.length <= 10) return "sk-***";
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

function setStatus(text, mode = "ready") {
  statusPill.textContent = text;
  statusPill.classList.toggle("loading", mode === "loading");
  statusPill.classList.toggle("error", mode === "error");
}

function parseExtraJson() {
  const raw = extraJsonInput.value.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extra JSON должен быть объектом.");
  }
  return parsed;
}

function hasValue(input) {
  return String(input.value).trim() !== "";
}

function numericValue(input) {
  return Number(input.value);
}

function getSelectedModel() {
  if (modelInput.value === "custom") {
    return customModelInput.value.trim();
  }
  return modelInput.value;
}

function getProfile() {
  return modelProfiles[modelInput.value] || modelProfiles.custom;
}

function getPricing() {
  return modelPricing[getSelectedModel()] || null;
}

function getEffectiveReasoningEffort() {
  const profile = getProfile();
  return reasoningEffortInput.value || profile.defaultReasoning || "";
}

function canUseSampling() {
  const profile = getProfile();
  if (!profile.supportsSampling) return false;
  if (!profile.samplingRequiresReasoningNone) return true;
  return getEffectiveReasoningEffort() === "none";
}

function buildExpertsInstructions() {
  if (!useExpertsInput.checked) return "";

  const activeExperts = experts
    .map((expert) => ({
      role: expert.role.trim(),
      focus: expert.focus.trim()
    }))
    .filter((expert) => expert.role || expert.focus);

  if (!activeExperts.length) return "";

  const expertLines = activeExperts.map((expert, index) => {
    const role = expert.role || `Эксперт ${index + 1}`;
    const focus = expert.focus || "Дай независимую оценку запроса.";
    return `${index + 1}. ${role}: ${focus}`;
  });

  return [
    "Ответь как группа экспертов.",
    "Сначала дай короткий общий вывод, затем отдельные секции по каждому эксперту, затем финальный консенсус.",
    "Состав группы:",
    ...expertLines
  ].join("\n");
}

function buildRequestBody() {
  const model = getSelectedModel();
  const instructions = instructionsInput.value.trim();
  const expertsInstructions = buildExpertsInstructions();
  const prompt = promptInput.value.trim();
  const extraJson = parseExtraJson();
  const profile = getProfile();
  const requestBody = {
    model,
    input: prompt
  };

  if (instructions || expertsInstructions) {
    requestBody.instructions = [instructions, expertsInstructions].filter(Boolean).join("\n\n");
  }

  if (profile.reasoningEfforts.length && reasoningEffortInput.value) {
    requestBody.reasoning = {
      ...(requestBody.reasoning || {}),
      effort: reasoningEffortInput.value
    };
  }

  if (hasValue(maxOutputTokensInput)) {
    requestBody.max_output_tokens = numericValue(maxOutputTokensInput);
  }

  if (profile.supportsTextVerbosity && textVerbosityInput.value) {
    requestBody.text = {
      ...(requestBody.text || {}),
      verbosity: textVerbosityInput.value
    };
  }

  if (canUseSampling()) {
    if (hasValue(temperatureInput)) requestBody.temperature = numericValue(temperatureInput);
    if (hasValue(topPInput)) requestBody.top_p = numericValue(topPInput);
  }

  return {
    ...requestBody,
    ...extraJson
  };
}

function buildPreview() {
  const requestBody = buildRequestBody();
  return {
    method: "POST",
    url: "https://api.openai.com/v1/responses",
    headers: {
      Authorization: apiKeyInput.value.trim() ? `Bearer ${maskApiKey(apiKeyInput.value)}` : "Bearer <api-key>",
      "Content-Type": "application/json"
    },
    body: requestBody
  };
}

function extractOutputText(payload) {
  const data = payload?.data || payload;

  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n").trim() || "Текст не найден в ответе.";
}

function formatTokens(value) {
  return Number.isFinite(value) ? value.toLocaleString("ru-RU") : "-";
}

function formatLatency(ms) {
  if (!Number.isFinite(ms)) return "-";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} с` : `${Math.round(ms)} мс`;
}

function formatCost(value) {
  if (!Number.isFinite(value)) return "нет цены";
  if (value === 0) return "$0.000000";
  if (value < 0.000001) return "< $0.000001";
  return `$${value.toFixed(6)}`;
}

function getUsageFromResponse(payload) {
  return payload?.data?.usage || payload?.usage || null;
}

function getCachedInputTokens(usage) {
  return usage?.input_tokens_details?.cached_tokens
    || usage?.prompt_tokens_details?.cached_tokens
    || 0;
}

function estimateCost(usage) {
  const pricing = getPricing();
  if (!pricing || !usage) return null;

  const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
  const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
  const cachedTokens = Math.min(getCachedInputTokens(usage), inputTokens);
  const uncachedInputTokens = Math.max(inputTokens - cachedTokens, 0);
  const cachedInputPrice = pricing.cachedInput ?? pricing.input;

  return (
    (uncachedInputTokens * pricing.input)
    + (cachedTokens * cachedInputPrice)
    + (outputTokens * pricing.output)
  ) / 1_000_000;
}

function updateMetrics(payload, latencyMs) {
  const usage = getUsageFromResponse(payload);
  const inputTokens = usage?.input_tokens || usage?.prompt_tokens;
  const outputTokens = usage?.output_tokens || usage?.completion_tokens;
  const totalTokens = usage?.total_tokens
    || (Number(inputTokens || 0) + Number(outputTokens || 0));
  const cost = estimateCost(usage);

  metricLatency.textContent = formatLatency(latencyMs);
  metricInputTokens.textContent = formatTokens(inputTokens);
  metricOutputTokens.textContent = formatTokens(outputTokens);
  metricTotalTokens.textContent = formatTokens(totalTokens);
  metricCost.textContent = !usage
    ? "нет данных"
    : cost === null
      ? "нет цены"
      : `≈ ${formatCost(cost)}`;
}

function resetMetrics() {
  metricLatency.textContent = "-";
  metricInputTokens.textContent = "-";
  metricOutputTokens.textContent = "-";
  metricTotalTokens.textContent = "-";
  metricCost.textContent = "-";
}

function setInputEnabled(input, enabled) {
  input.disabled = !enabled;
  input.closest("label")?.classList.toggle("control-disabled", !enabled);
}

function setSelectOptionsEnabled(select, allowedValues) {
  Array.from(select.options).forEach((option) => {
    option.disabled = Boolean(option.value) && !allowedValues.includes(option.value);
  });

  if (select.value && !allowedValues.includes(select.value)) {
    select.value = "";
  }
}

function updateControlAvailability() {
  const profile = getProfile();
  const effectiveEffort = getEffectiveReasoningEffort();
  const samplingAvailable = canUseSampling();

  setSelectOptionsEnabled(reasoningEffortInput, profile.reasoningEfforts);
  setInputEnabled(reasoningEffortInput, profile.reasoningEfforts.length > 0);
  setInputEnabled(temperatureInput, samplingAvailable);
  setInputEnabled(topPInput, samplingAvailable);
  setInputEnabled(textVerbosityInput, profile.supportsTextVerbosity);
  setInputEnabled(presencePenaltyInput, false);
  setInputEnabled(frequencyPenaltyInput, false);
  setInputEnabled(topKInput, false);
  setInputEnabled(topVInput, false);

  if (!profile.supportsSampling) {
    modelSupportHint.textContent = `Reasoning по умолчанию: ${profile.defaultReasoning}. Sampling-поля для этой модели не отправляются.`;
  } else if (profile.samplingRequiresReasoningNone) {
    modelSupportHint.textContent = `Reasoning по умолчанию: ${profile.defaultReasoning}. Sampling-поля отправляются только при reasoning.effort = none.`;
  } else {
    modelSupportHint.textContent = "Для этой модели доступны базовые sampling-поля, если оставить их непустыми.";
  }

  reasoningHint.textContent = profile.reasoningEfforts.length
    ? `Текущий эффективный режим: ${effectiveEffort || "не задан"}. Пусто означает дефолт модели.`
    : "Эта модель не использует reasoning.effort в запросе.";

  const samplingNote = samplingAvailable
    ? "Будет отправлено, если поле заполнено."
    : "Недоступно при текущем reasoning-режиме.";
  parameterNotes.temperature.textContent = samplingNote;
  parameterNotes.top_p.textContent = samplingNote;
  parameterNotes.presence_penalty.textContent = "Не отправляется: не указано в Responses API.";
  parameterNotes.frequency_penalty.textContent = "Не отправляется: не указано в Responses API.";
}

function updateRequestPreview() {
  updateControlAvailability();
  try {
    requestPreview.textContent = pretty(buildPreview());
    setStatus("готов");
  } catch (error) {
    requestPreview.textContent = pretty({ error: error.message });
    setStatus("ошибка", "error");
  }
}

function updateResponsePreview() {
  if (!lastResponse) {
    responsePreview.textContent = "Ответ появится здесь после запроса.";
    return;
  }

  responsePreview.textContent = responseMode === "text"
    ? extractOutputText(lastResponse)
    : pretty(lastResponse);
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function resetForm() {
  form.reset();
  customModelInput.classList.add("hidden");
  experts = defaultExperts.map((expert) => ({ ...expert }));
  lastResponse = null;
  responseMode = "json";
  toggleParsedButton.textContent = "Текст";
  renderExperts();
  resetMetrics();
  updateRequestPreview();
  updateResponsePreview();
}

function renderExperts() {
  expertList.innerHTML = "";

  experts.forEach((expert, index) => {
    const row = document.createElement("div");
    row.className = "expert-row";

    const roleInput = document.createElement("input");
    roleInput.type = "text";
    roleInput.value = expert.role;
    roleInput.placeholder = "Роль";
    roleInput.setAttribute("aria-label", "Роль эксперта");
    roleInput.addEventListener("input", () => {
      experts[index].role = roleInput.value;
      updateRequestPreview();
    });

    const focusInput = document.createElement("textarea");
    focusInput.rows = 2;
    focusInput.value = expert.focus;
    focusInput.placeholder = "Фокус эксперта";
    focusInput.setAttribute("aria-label", "Фокус эксперта");
    focusInput.addEventListener("input", () => {
      experts[index].focus = focusInput.value;
      updateRequestPreview();
    });

    const removeButton = document.createElement("button");
    removeButton.className = "icon-button remove-expert";
    removeButton.type = "button";
    removeButton.title = "Удалить эксперта";
    removeButton.setAttribute("aria-label", "Удалить эксперта");
    removeButton.textContent = "×";
    removeButton.addEventListener("click", () => {
      experts.splice(index, 1);
      renderExperts();
      updateRequestPreview();
    });

    row.append(roleInput, focusInput, removeButton);
    expertList.append(row);
  });
}

async function sendRequest(event) {
  event.preventDefault();

  let requestBody;
  try {
    requestBody = buildRequestBody();
  } catch (error) {
    lastResponse = { error: error.message };
    responseMode = "json";
    updateResponsePreview();
    setStatus("ошибка", "error");
    return;
  }

  sendButton.disabled = true;
  setStatus("запрос", "loading");
  responsePreview.textContent = "Выполняется запрос...";
  resetMetrics();

  try {
    const startedAt = performance.now();
    const response = await fetch("/api/openai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apiKey: apiKeyInput.value,
        requestBody
      })
    });
    const latencyMs = performance.now() - startedAt;

    lastResponse = await response.json();
    updateMetrics(lastResponse, latencyMs);
    responseMode = "json";
    toggleParsedButton.textContent = "Текст";
    updateResponsePreview();
    setStatus(response.ok ? "готов" : "ошибка", response.ok ? "ready" : "error");
  } catch (error) {
    lastResponse = { error: error.message };
    responseMode = "json";
    updateResponsePreview();
    setStatus("ошибка", "error");
  } finally {
    sendButton.disabled = false;
  }
}

[
  apiKeyInput,
  modelInput,
  customModelInput,
  instructionsInput,
  useExpertsInput,
  promptInput,
  extraJsonInput,
  ...parameterInputs
].forEach((input) => {
  input.addEventListener("input", updateRequestPreview);
  input.addEventListener("change", updateRequestPreview);
});

modelInput.addEventListener("change", () => {
  customModelInput.classList.toggle("hidden", modelInput.value !== "custom");
  if (modelInput.value === "custom") {
    customModelInput.focus();
  }
});

addExpertButton.addEventListener("click", () => {
  experts.push({
    role: "",
    focus: ""
  });
  renderExperts();
  updateRequestPreview();
  const newestRoleInput = expertList.querySelector(".expert-row:last-child input");
  newestRoleInput?.focus();
});

toggleParsedButton.addEventListener("click", () => {
  responseMode = responseMode === "json" ? "text" : "json";
  toggleParsedButton.textContent = responseMode === "json" ? "Текст" : "JSON";
  updateResponsePreview();
});

copyRequestButton.addEventListener("click", async () => {
  await copyText(requestPreview.textContent);
});

copyResponseButton.addEventListener("click", async () => {
  await copyText(responsePreview.textContent);
});

resetButton.addEventListener("click", resetForm);
form.addEventListener("submit", sendRequest);

renderExperts();
resetMetrics();
updateRequestPreview();
updateResponsePreview();
