const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");
const messageList = document.querySelector("#messageList");
const sendMessageButton = document.querySelector("#sendMessage");
const chatStatus = document.querySelector("#chatStatus");
const chatModel = document.querySelector("#chatModel");
const customModel = document.querySelector("#customModel");
const customModelWrap = document.querySelector("#customModelWrap");
const shortTermWindow = document.querySelector("#shortTermWindow");
const includeWorkingMemory = document.querySelector("#includeWorkingMemory");
const includeLongTermMemory = document.querySelector("#includeLongTermMemory");
const chatApiKey = document.querySelector("#chatApiKey");
const clearChatButton = document.querySelector("#clearChat");
const newChatButton = document.querySelector("#newChat");
const chatList = document.querySelector("#chatList");
const activeChatTitle = document.querySelector("#activeChatTitle");
const themeToggle = document.querySelector("#themeToggle");
const themeIcon = document.querySelector("#themeIcon");
const authOverlay = document.querySelector("#authOverlay");
const authForm = document.querySelector("#authForm");
const authLogin = document.querySelector("#authLogin");
const authPassword = document.querySelector("#authPassword");
const authError = document.querySelector("#authError");
const registerButton = document.querySelector("#registerButton");
const logoutButton = document.querySelector("#logoutButton");
const userBadge = document.querySelector("#userBadge");
const metricCurrentTokens = document.querySelector("#metricCurrentTokens");
const metricShortTokens = document.querySelector("#metricShortTokens");
const metricWorkingTokens = document.querySelector("#metricWorkingTokens");
const metricLongTokens = document.querySelector("#metricLongTokens");
const metricRequestTokens = document.querySelector("#metricRequestTokens");
const metricTokenLimit = document.querySelector("#metricTokenLimit");
const tokenWarning = document.querySelector("#tokenWarning");
const memoryPreview = document.querySelector("#memoryPreview");
const requestPreview = document.querySelector("#requestPreview");
const responsePreview = document.querySelector("#responsePreview");
const refreshDebugButton = document.querySelector("#refreshDebug");
const memoryLayer = document.querySelector("#memoryLayer");
const memoryCategory = document.querySelector("#memoryCategory");
const memoryKey = document.querySelector("#memoryKey");
const memoryValue = document.querySelector("#memoryValue");
const saveMemoryButton = document.querySelector("#saveMemory");
const showMemoryTextButton = document.querySelector("#showMemoryText");
const memoryTextOverlay = document.querySelector("#memoryTextOverlay");
const closeMemoryTextButton = document.querySelector("#closeMemoryText");
const memoryTextContent = document.querySelector("#memoryTextContent");

let chats = [];
let activeChatId = null;
let currentUser = null;
let tokenPreviewTimer = null;
const messages = [];

function pretty(value) {
  return JSON.stringify(value || null, null, 2);
}

function getSavedTheme() {
  const savedTheme = localStorage.getItem("theme");
  if (savedTheme === "dark" || savedTheme === "light") return savedTheme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeIcon.textContent = theme === "dark" ? "☀" : "☾";
}

function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", nextTheme);
  applyTheme(nextTheme);
}

function setStatus(text, mode = "ready") {
  chatStatus.textContent = text;
  chatStatus.classList.toggle("loading", mode === "loading");
  chatStatus.classList.toggle("error", mode === "error");
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("ru-RU") : "0";
}

function getSelectedModel() {
  return chatModel.value === "custom" ? customModel.value.trim() : chatModel.value;
}

function getActiveChat() {
  return chats.find((chat) => chat.id === activeChatId) || null;
}

function getSettingsPayload() {
  return {
    shortTermWindow: shortTermWindow.value,
    includeWorkingMemory: includeWorkingMemory.checked,
    includeLongTermMemory: includeLongTermMemory.checked
  };
}

function applyChatSettings(chat) {
  const settings = chat?.settings || {};
  shortTermWindow.value = String(settings.shortTermWindow || 10);
  includeWorkingMemory.checked = settings.includeWorkingMemory !== false;
  includeLongTermMemory.checked = settings.includeLongTermMemory !== false;
}

function updateTokenMetrics(stats) {
  const tokenStats = stats || {};
  metricCurrentTokens.textContent = formatNumber(tokenStats.currentMessageTokens);
  metricShortTokens.textContent = formatNumber(tokenStats.historyTokens);
  metricWorkingTokens.textContent = formatNumber(tokenStats.workingMemoryTokens);
  metricLongTokens.textContent = formatNumber(tokenStats.longTermMemoryTokens);
  metricRequestTokens.textContent = formatNumber(tokenStats.requestTokens);
  metricTokenLimit.textContent = formatNumber(tokenStats.contextLimit);

  tokenWarning.classList.toggle("error", tokenStats.warningLevel === "error");
  tokenWarning.classList.toggle("warning", tokenStats.warningLevel === "warning");
  if (!tokenStats.contextLimit) {
    tokenWarning.textContent = "";
  } else if (tokenStats.overLimit) {
    tokenWarning.textContent = `Контекст переполнен: ${formatNumber(tokenStats.requestTokens)} из ${formatNumber(tokenStats.contextLimit)} токенов.`;
  } else {
    const layers = tokenStats.layers || {};
    tokenWarning.textContent = `В запрос попадёт short-term: ${formatNumber(layers.short_term?.includedMessageCount)} сообщений, working: ${formatNumber(layers.working?.itemCount)} записей, long-term: ${formatNumber(layers.long_term?.itemCount)} записей.`;
  }
}

function setCurrentUser(user) {
  currentUser = user || null;
  userBadge.textContent = currentUser?.login || "";
  userBadge.classList.toggle("hidden", !currentUser);
  logoutButton.classList.toggle("hidden", !currentUser);
}

function showAuth(message = "") {
  authError.textContent = message;
  authOverlay.classList.remove("hidden");
  authLogin.focus();
}

function hideAuth() {
  authOverlay.classList.add("hidden");
  authError.textContent = "";
}

async function authenticate(mode) {
  const login = authLogin.value.trim();
  const password = authPassword.value;

  if (!login || !password) {
    showAuth("Введите логин и пароль.");
    return;
  }

  const response = await fetch(`/api/auth/${mode}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ login, password })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    showAuth(payload.error || "Не удалось войти.");
    return;
  }

  setCurrentUser(payload.user);
  authPassword.value = "";
  hideAuth();
  await loadChats();
}

async function checkAuth() {
  const response = await fetch("/api/auth/me");
  const payload = await response.json().catch(() => ({}));

  if (!payload.user) {
    setCurrentUser(null);
    chats = [];
    activeChatId = null;
    renderChatList();
    renderMessages([]);
    renderDebug(null, null);
    showAuth();
    return;
  }

  setCurrentUser(payload.user);
  hideAuth();
  await loadChats();
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  setCurrentUser(null);
  chats = [];
  activeChatId = null;
  renderChatList();
  renderMessages([]);
  renderDebug(null, null);
  showAuth();
}

function addMessage(role, content = "") {
  const message = document.createElement("article");
  message.className = `chat-message ${role}`;

  const label = document.createElement("span");
  label.className = "chat-message-label";
  label.textContent = role === "assistant" ? "Agent" : "You";

  const text = document.createElement("div");
  text.className = "chat-message-text";
  text.textContent = content;

  message.append(label, text);
  messageList.append(message);
  messageList.scrollTop = messageList.scrollHeight;
  return text;
}

function renderMessages(nextMessages) {
  messages.length = 0;
  messageList.innerHTML = "";
  const safeMessages = Array.isArray(nextMessages) ? nextMessages : [];

  safeMessages.forEach((message) => {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = String(message.content || "").trim();
    if (!content) return;
    messages.push({ role, content });
    addMessage(role, content);
  });

  if (!messages.length) {
    addMessage("assistant", "Привет. Это отдельный агент с явными слоями памяти. Создайте чат, напишите задачу и смотрите справа, что попало в short-term, working и long-term.");
  }
}

function renderChatList() {
  chatList.innerHTML = "";

  if (!chats.length) {
    const empty = document.createElement("p");
    empty.className = "chat-list-empty";
    empty.textContent = currentUser ? "Memory-чаты пока пустые." : "Войдите, чтобы увидеть свои memory-чаты.";
    chatList.append(empty);
    return;
  }

  chats.forEach((chat) => {
    const row = document.createElement("div");
    row.className = "chat-list-row";
    row.classList.toggle("active", chat.id === activeChatId);

    const button = document.createElement("button");
    button.className = "chat-list-item";
    button.type = "button";

    const title = document.createElement("strong");
    title.textContent = chat.title || "Memory chat";

    const counts = chat.memoryCounts || {};
    const preview = document.createElement("span");
    preview.textContent = `${counts.shortTermMessages || 0} msg | W:${counts.workingItems || 0} | L:${counts.longTermItems || 0}`;

    button.append(title, preview);
    button.addEventListener("click", () => loadChat(chat.id));

    const deleteButton = document.createElement("button");
    deleteButton.className = "icon-button delete-chat-button";
    deleteButton.type = "button";
    deleteButton.title = "Удалить чат";
    deleteButton.setAttribute("aria-label", "Удалить чат");
    deleteButton.textContent = "×";
    deleteButton.addEventListener("click", () => deleteChat(chat.id));

    row.append(button, deleteButton);
    chatList.append(row);
  });
}

function setActiveChat(chat) {
  activeChatId = chat?.id || null;
  activeChatTitle.textContent = chat?.title || "Новый memory chat";
  applyChatSettings(chat);
  renderChatList();
}

function upsertChat(chat) {
  if (!chat?.id) return;
  const index = chats.findIndex((item) => item.id === chat.id);
  if (index === -1) {
    chats.unshift(chat);
  } else {
    chats[index] = {
      ...chats[index],
      ...chat
    };
  }
  chats.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  renderChatList();
}

function renderDebug(memory, debug) {
  memoryPreview.textContent = memory ? pretty(memory) : "Память появится здесь после выбора или создания чата.";
  requestPreview.textContent = debug?.lastRequest ? pretty(debug.lastRequest) : "Request debug появится после первого сообщения.";
  responsePreview.textContent = debug?.lastResponse ? pretty(debug.lastResponse) : "Response debug появится после ответа модели.";
}

function renderChatDebug(chat) {
  if (!chat) {
    renderDebug(null, null);
    return;
  }
  renderDebug({
    short_term: chat.shortTermMemory,
    working: chat.workingMemory,
    long_term: chat.longTermMemory
  }, chat.debug);
}

function formatMemoryRecord(record, index) {
  const category = record?.category ? `[${record.category}] ` : "";
  const key = record?.key ? `${record.key}: ` : "";
  const value = String(record?.value || "").trim();
  const source = record?.source ? `\n  источник: ${record.source}` : "";
  const reason = record?.reason ? `\n  почему сохранено: ${record.reason}` : "";
  return `${index + 1}. ${category}${key}${value || "(пусто)"}${source}${reason}`;
}

function formatMemoryItems(items) {
  const records = Object.values(items || {});
  if (!records.length) return "- пока пусто";
  return records.map(formatMemoryRecord).join("\n\n");
}

function formatShortTermMemory(memory) {
  const messages = Array.isArray(memory?.messages) ? memory.messages : [];
  const notes = Array.isArray(memory?.notes) ? memory.notes : [];
  const recentMessages = messages.length
    ? messages.slice(-10).map((message, index) => {
      const role = message.role === "assistant" ? "Ассистент" : "Пользователь";
      return `${index + 1}. ${role}: ${message.content}`;
    }).join("\n")
    : "- сообщений пока нет";
  const noteText = notes.length
    ? notes.map(formatMemoryRecord).join("\n\n")
    : "- временных заметок нет";

  return [
    "КРАТКОСРОЧНАЯ ПАМЯТЬ",
    "Scope: только текущий чат.",
    "Сюда попадает текущий диалог и временные заметки, которые не должны жить между чатами.",
    "",
    "Последние сообщения:",
    recentMessages,
    "",
    "Временные заметки:",
    noteText
  ].join("\n");
}

function formatWorkingMemory(memory) {
  return [
    "РАБОЧАЯ ПАМЯТЬ",
    "Scope: текущая задача пользователя, общая между memory-чатами.",
    "Сюда попадают цель, ограничения, решения, открытые вопросы и состояние задачи.",
    "",
    formatMemoryItems(memory?.items)
  ].join("\n");
}

function formatLongTermMemory(memory) {
  return [
    "ДОЛГОВРЕМЕННАЯ ПАМЯТЬ",
    "Scope: профиль и знания пользователя, общие между всеми memory-чатами.",
    "Сюда попадают имя, роль, предпочтения, устойчивые решения и знания.",
    "",
    formatMemoryItems(memory?.items)
  ].join("\n");
}

function buildHumanMemoryText(chat) {
  if (!chat) {
    return "Выберите или создайте memory-чат, чтобы посмотреть слои памяти.";
  }

  return [
    formatShortTermMemory(chat.shortTermMemory),
    "",
    "----------------------------------------",
    "",
    formatWorkingMemory(chat.workingMemory),
    "",
    "----------------------------------------",
    "",
    formatLongTermMemory(chat.longTermMemory)
  ].join("\n");
}

function showHumanMemory() {
  const chat = getActiveChat();
  memoryTextContent.textContent = buildHumanMemoryText(chat);
  memoryTextOverlay.classList.remove("hidden");
}

function hideHumanMemory() {
  memoryTextOverlay.classList.add("hidden");
}

async function loadChats(preferredChatId = activeChatId) {
  const response = await fetch("/api/chat_memory/chats");
  if (response.status === 401) {
    showAuth();
    return;
  }
  if (!response.ok) throw new Error(`Load chats failed: ${response.status}`);

  const payload = await response.json();
  chats = Array.isArray(payload.chats) ? payload.chats : [];
  renderChatList();

  const nextChatId = preferredChatId && chats.some((chat) => chat.id === preferredChatId)
    ? preferredChatId
    : chats[0]?.id;

  if (nextChatId) {
    await loadChat(nextChatId);
  } else {
    setActiveChat(null);
    renderMessages([]);
    renderDebug(null, null);
  }
}

async function loadChat(chatId) {
  const response = await fetch(`/api/chat_memory/chats/${encodeURIComponent(chatId)}`);
  if (response.status === 401) {
    showAuth();
    return;
  }
  if (!response.ok) throw new Error(`Load chat failed: ${response.status}`);

  const payload = await response.json();
  upsertChat(payload.chat);
  setActiveChat(payload.chat);
  renderMessages(payload.chat.messages);
  renderChatDebug(payload.chat);
  scheduleTokenPreview();
}

async function createNewChat() {
  if (!currentUser) {
    showAuth();
    return;
  }

  const response = await fetch("/api/chat_memory/chats", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: "Memory chat",
      ...getSettingsPayload()
    })
  });

  if (response.status === 401) {
    showAuth();
    return;
  }
  if (!response.ok) throw new Error(`Create chat failed: ${response.status}`);

  const payload = await response.json();
  upsertChat(payload.chat);
  setActiveChat(payload.chat);
  renderMessages(payload.chat.messages);
  renderChatDebug(payload.chat);
}

async function saveActiveChatSettings() {
  if (!currentUser || !activeChatId) return;

  const response = await fetch(`/api/chat_memory/chats/${encodeURIComponent(activeChatId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(getSettingsPayload())
  });

  if (response.status === 401) {
    showAuth();
    return;
  }
  if (!response.ok) throw new Error(`Save settings failed: ${response.status}`);

  const payload = await response.json();
  upsertChat(payload.chat);
  setActiveChat(payload.chat);
  renderChatDebug(payload.chat);
  scheduleTokenPreview();
}

function scheduleTokenPreview() {
  clearTimeout(tokenPreviewTimer);
  tokenPreviewTimer = setTimeout(loadTokenPreview, 220);
}

async function loadTokenPreview() {
  if (!currentUser) {
    updateTokenMetrics(null);
    return;
  }

  const response = await fetch("/api/chat_memory/tokens", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chatId: activeChatId,
      message: chatInput.value,
      model: getSelectedModel(),
      ...getSettingsPayload()
    })
  });

  if (response.status === 401) {
    showAuth();
    return;
  }
  if (!response.ok) return;

  const payload = await response.json();
  updateTokenMetrics(payload.tokenStats);
}

function parseSseEvents(buffer, onEvent) {
  let normalized = buffer.replace(/\r\n/g, "\n");
  let boundaryIndex = normalized.indexOf("\n\n");

  while (boundaryIndex !== -1) {
    const rawEvent = normalized.slice(0, boundaryIndex);
    normalized = normalized.slice(boundaryIndex + 2);

    const eventName = rawEvent
      .split("\n")
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim() || "message";
    const data = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (data) {
      onEvent(eventName, JSON.parse(data));
    }

    boundaryIndex = normalized.indexOf("\n\n");
  }

  return normalized;
}

async function readChatStream(response, assistantText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantContent = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer = parseSseEvents(buffer + decoder.decode(value, { stream: true }), (eventName, payload) => {
      if (eventName === "chat" && payload.chat) {
        upsertChat(payload.chat);
        setActiveChat(payload.chat);
        renderChatDebug(payload.chat);
        return;
      }

      if (eventName === "delta") {
        assistantContent += payload.delta || "";
        assistantText.textContent = assistantContent;
        messageList.scrollTop = messageList.scrollHeight;
        return;
      }

      if (eventName === "meta") {
        if (payload.chat) {
          upsertChat(payload.chat);
          setActiveChat(payload.chat);
          renderChatDebug(payload.chat);
        }
        updateTokenMetrics(payload.tokenStats);
        if (payload.debug) {
          renderDebug(payload.debug.lastRequest?.memorySnapshot || null, payload.debug);
        }
        return;
      }

      if (eventName === "error") {
        throw new Error(payload.error || "Stream failed.");
      }
    });
  }

  return assistantContent;
}

async function sendChatMessage(event) {
  event.preventDefault();
  if (!currentUser) {
    showAuth();
    return;
  }

  const content = chatInput.value.trim();
  const model = getSelectedModel();
  if (!content || !model) {
    setStatus("ошибка", "error");
    return;
  }

  messages.push({ role: "user", content });
  addMessage("user", content);
  chatInput.value = "";
  chatInput.style.height = "";

  const assistantText = addMessage("assistant", "");
  messages.push({ role: "assistant", content: "" });
  sendMessageButton.disabled = true;
  chatInput.disabled = true;
  setStatus("стрим", "loading");

  try {
    const response = await fetch("/api/chat_memory", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apiKey: chatApiKey.value,
        chatId: activeChatId,
        model,
        message: content,
        ...getSettingsPayload()
      })
    });

    if (!response.ok) {
      if (response.status === 401) {
        showAuth();
        return;
      }
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Request failed: ${response.status}`);
    }

    const assistantContent = await readChatStream(response, assistantText);
    messages[messages.length - 1].content = assistantContent;
    setStatus("готов");
    await refreshDebug();
  } catch (error) {
    assistantText.textContent = error.message;
    setStatus("ошибка", "error");
  } finally {
    sendMessageButton.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
    scheduleTokenPreview();
  }
}

async function saveManualMemory() {
  if (!currentUser) {
    showAuth();
    return;
  }
  if (!activeChatId) {
    await createNewChat();
  }

  const value = memoryValue.value.trim();
  if (!value) {
    setStatus("нет значения", "error");
    return;
  }

  const response = await fetch(`/api/chat_memory/chats/${encodeURIComponent(activeChatId)}/memory`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      layer: memoryLayer.value,
      category: memoryCategory.value,
      key: memoryKey.value,
      value,
      reason: "Saved manually from /chat_memory debug tool."
    })
  });

  if (response.status === 401) {
    showAuth();
    return;
  }
  if (!response.ok) {
    setStatus("ошибка", "error");
    return;
  }

  const payload = await response.json();
  memoryValue.value = "";
  upsertChat(payload.chat);
  setActiveChat(payload.chat);
  renderChatDebug(payload.chat);
  setStatus("сохранено");
  scheduleTokenPreview();
}

async function refreshDebug() {
  if (!currentUser || !activeChatId) return;

  const response = await fetch(`/api/chat_memory/chats/${encodeURIComponent(activeChatId)}/debug`);
  if (response.status === 401) {
    showAuth();
    return;
  }
  if (!response.ok) return;

  const payload = await response.json();
  renderDebug(payload.memory, payload.debug);
}

async function deleteChat(chatId) {
  if (!chatId || !window.confirm("Удалить этот memory-чат?")) return;

  const response = await fetch(`/api/chat_memory/chats/${encodeURIComponent(chatId)}`, {
    method: "DELETE"
  });

  if (response.status === 401) {
    showAuth();
    return;
  }
  if (!response.ok) {
    setStatus("ошибка", "error");
    return;
  }

  const payload = await response.json();
  chats = Array.isArray(payload.chats) ? payload.chats : [];

  if (activeChatId === chatId) {
    const nextChat = chats[0] || null;
    if (nextChat) {
      await loadChat(nextChat.id);
    } else {
      activeChatId = null;
      setActiveChat(null);
      renderMessages([]);
      renderDebug(null, null);
    }
  }

  renderChatList();
}

async function clearChat() {
  if (!currentUser) {
    showAuth();
    return;
  }

  if (!activeChatId) {
    renderMessages([]);
    return;
  }

  const response = await fetch(`/api/chat_memory/chats/${encodeURIComponent(activeChatId)}/messages`, {
    method: "DELETE"
  });

  if (response.status === 401) {
    showAuth();
    return;
  }
  if (!response.ok) {
    setStatus("ошибка", "error");
    return;
  }

  const payload = await response.json();
  upsertChat(payload.chat);
  setActiveChat(payload.chat);
  renderMessages(payload.chat.messages);
  renderChatDebug(payload.chat);
  setStatus("готов");
}

function updateMemoryDefaults() {
  if (memoryLayer.value === "long_term") {
    memoryCategory.value = "profile";
    memoryKey.value = "preference";
  } else if (memoryLayer.value === "working") {
    memoryCategory.value = "task";
    memoryKey.value = "current_task";
  } else {
    memoryCategory.value = "dialogue";
    memoryKey.value = "temporary_note";
  }
}

chatInput.addEventListener("input", () => {
  chatInput.style.height = "";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 180)}px`;
  scheduleTokenPreview();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

chatModel.addEventListener("change", () => {
  customModelWrap.classList.toggle("hidden", chatModel.value !== "custom");
  if (chatModel.value === "custom") customModel.focus();
  scheduleTokenPreview();
});
customModel.addEventListener("input", scheduleTokenPreview);
shortTermWindow.addEventListener("change", () => saveActiveChatSettings().catch(() => setStatus("ошибка", "error")));
includeWorkingMemory.addEventListener("change", () => saveActiveChatSettings().catch(() => setStatus("ошибка", "error")));
includeLongTermMemory.addEventListener("change", () => saveActiveChatSettings().catch(() => setStatus("ошибка", "error")));
memoryLayer.addEventListener("change", updateMemoryDefaults);
showMemoryTextButton.addEventListener("click", showHumanMemory);
closeMemoryTextButton.addEventListener("click", hideHumanMemory);
memoryTextOverlay.addEventListener("click", (event) => {
  if (event.target === memoryTextOverlay) {
    hideHumanMemory();
  }
});
saveMemoryButton.addEventListener("click", () => saveManualMemory().catch(() => setStatus("ошибка", "error")));
refreshDebugButton.addEventListener("click", () => refreshDebug().catch(() => setStatus("ошибка", "error")));
newChatButton.addEventListener("click", () => createNewChat().catch(() => setStatus("ошибка", "error")));
clearChatButton.addEventListener("click", () => clearChat().catch(() => setStatus("ошибка", "error")));
themeToggle.addEventListener("click", toggleTheme);
chatForm.addEventListener("submit", sendChatMessage);
authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate("login").catch(() => showAuth("Не удалось войти."));
});
registerButton.addEventListener("click", () => {
  authenticate("register").catch(() => showAuth("Не удалось зарегистрироваться."));
});
logoutButton.addEventListener("click", () => {
  logout().catch(() => showAuth("Не удалось выйти."));
});

applyTheme(getSavedTheme());
renderDebug(null, null);
checkAuth().catch(() => {
  renderMessages([]);
  setStatus("ошибка", "error");
  showAuth();
});
