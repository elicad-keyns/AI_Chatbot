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

const modelProfiles = {
  "gpt-5.5": {
    family: "gpt-5.5",
    defaultReasoning: "medium",
    reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    samplingRequiresReasoningNone: true,
    supportsSampling: true
  },
  "gpt-5.4": {
    family: "gpt-5.4",
    defaultReasoning: "medium",
    reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    samplingRequiresReasoningNone: true,
    supportsSampling: true
  },
  "gpt-5.2": {
    family: "gpt-5.2",
    defaultReasoning: "medium",
    reasoningEfforts: ["none", "low", "medium", "high"],
    samplingRequiresReasoningNone: true,
    supportsSampling: true
  },
  "gpt-5.5-mini": {
    family: "gpt-5.5",
    defaultReasoning: "medium",
    reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    samplingRequiresReasoningNone: true,
    supportsSampling: true
  },
  "gpt-5.5-nano": {
    family: "gpt-5.5",
    defaultReasoning: "medium",
    reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    samplingRequiresReasoningNone: true,
    supportsSampling: true
  },
  "gpt-5.1": {
    family: "gpt-5.1",
    defaultReasoning: "none",
    reasoningEfforts: ["none", "low", "medium", "high"],
    samplingRequiresReasoningNone: true,
    supportsSampling: true
  },
  "gpt-4.1": {
    family: "gpt-4.1",
    defaultReasoning: null,
    reasoningEfforts: [],
    samplingRequiresReasoningNone: false,
    supportsSampling: true
  },
  custom: {
    family: "custom",
    defaultReasoning: null,
    reasoningEfforts: [],
    samplingRequiresReasoningNone: false,
    supportsSampling: true
  }
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

  if (textVerbosityInput.value) {
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
  setInputEnabled(presencePenaltyInput, false);
  setInputEnabled(frequencyPenaltyInput, false);
  setInputEnabled(topKInput, false);
  setInputEnabled(topVInput, false);

  modelSupportHint.textContent = profile.reasoningEfforts.length
    ? `Reasoning по умолчанию: ${profile.defaultReasoning}. Sampling-поля отправляются только при reasoning.effort = none.`
    : "Для этой модели доступны базовые sampling-поля, если оставить их непустыми.";

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

  try {
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

    lastResponse = await response.json();
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
updateRequestPreview();
updateResponsePreview();
