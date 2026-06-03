const form = document.querySelector("#settingsForm");
const apiKeyInput = document.querySelector("#apiKey");
const modelInput = document.querySelector("#model");
const customModelInput = document.querySelector("#customModel");
const instructionsInput = document.querySelector("#instructions");
const expertList = document.querySelector("#expertList");
const addExpertButton = document.querySelector("#addExpert");
const promptInput = document.querySelector("#prompt");
const temperatureInput = document.querySelector("#temperature");
const topPInput = document.querySelector("#topP");
const presencePenaltyInput = document.querySelector("#presencePenalty");
const frequencyPenaltyInput = document.querySelector("#frequencyPenalty");
const maxOutputTokensInput = document.querySelector("#maxOutputTokens");
const topKInput = document.querySelector("#topK");
const topVInput = document.querySelector("#topV");
const reasoningEffortInput = document.querySelector("#reasoningEffort");
const extraJsonInput = document.querySelector("#extraJson");
const requestPreview = document.querySelector("#requestPreview");
const responsePreview = document.querySelector("#responsePreview");
const statusPill = document.querySelector("#statusPill");
const sendButton = document.querySelector("#sendButton");
const resetButton = document.querySelector("#resetButton");
const toggleParsedButton = document.querySelector("#toggleParsed");
const copyRequestButton = document.querySelector("#copyRequest");
const copyResponseButton = document.querySelector("#copyResponse");

const sliders = [
  [temperatureInput, document.querySelector("#temperatureValue")],
  [topPInput, document.querySelector("#topPValue")],
  [presencePenaltyInput, document.querySelector("#presencePenaltyValue")],
  [frequencyPenaltyInput, document.querySelector("#frequencyPenaltyValue")]
];

let lastResponse = null;
let responseMode = "json";
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

function getSelectedModel() {
  if (modelInput.value === "custom") {
    return customModelInput.value.trim();
  }
  return modelInput.value;
}

function buildExpertsInstructions() {
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
  const requestBody = {
    model,
    input: prompt,
    temperature: Number(temperatureInput.value),
    top_p: Number(topPInput.value),
    max_output_tokens: Number(maxOutputTokensInput.value),
    presence_penalty: Number(presencePenaltyInput.value),
    frequency_penalty: Number(frequencyPenaltyInput.value),
    ...extraJson
  };

  if (instructions || expertsInstructions) {
    requestBody.instructions = [instructions, expertsInstructions].filter(Boolean).join("\n\n");
  }

  if (reasoningEffortInput.value) {
    requestBody.reasoning = {
      ...(requestBody.reasoning || {}),
      effort: reasoningEffortInput.value
    };
  }

  if (topKInput.value.trim()) {
    requestBody.top_k = Number(topKInput.value);
  }

  if (topVInput.value.trim()) {
    requestBody.top_v = Number(topVInput.value);
  }

  return requestBody;
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

function updateRequestPreview() {
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
  syncSliderLabels();
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

function syncSliderLabels() {
  sliders.forEach(([input, output]) => {
    output.value = Number(input.value).toFixed(2);
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

sliders.forEach(([input]) => {
  input.addEventListener("input", () => {
    syncSliderLabels();
    updateRequestPreview();
  });
});

[
  apiKeyInput,
  modelInput,
  customModelInput,
  instructionsInput,
  promptInput,
  maxOutputTokensInput,
  topKInput,
  topVInput,
  reasoningEffortInput,
  extraJsonInput
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
syncSliderLabels();
updateRequestPreview();
updateResponsePreview();
