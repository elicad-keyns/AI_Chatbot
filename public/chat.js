const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");
const messageList = document.querySelector("#messageList");
const sendMessageButton = document.querySelector("#sendMessage");
const chatStatus = document.querySelector("#chatStatus");
const chatModel = document.querySelector("#chatModel");
const customModel = document.querySelector("#customModel");
const customModelWrap = document.querySelector("#customModelWrap");
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
const metricHistoryTokens = document.querySelector("#metricHistoryTokens");
const metricRequestTokens = document.querySelector("#metricRequestTokens");
const metricResponseTokens = document.querySelector("#metricResponseTokens");
const metricTokenLimit = document.querySelector("#metricTokenLimit");
const metricTokenCost = document.querySelector("#metricTokenCost");
const tokenWarning = document.querySelector("#tokenWarning");

let chats = [];
let activeChatId = null;
let currentUser = null;
let tokenPreviewTimer = null;
const messages = [];

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

function getSelectedModel() {
  return chatModel.value === "custom" ? customModel.value.trim() : chatModel.value;
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("ru-RU") : "0";
}

function formatUsd(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return "$0.000000";
  if (amount < 0.000001) return "< $0.000001";
  return `$${amount.toFixed(6)}`;
}

function updateTokenMetrics(stats) {
  const tokenStats = stats || {};
  metricCurrentTokens.textContent = formatNumber(tokenStats.currentMessageTokens);
  metricHistoryTokens.textContent = formatNumber(tokenStats.historyTokens);
  metricRequestTokens.textContent = formatNumber(tokenStats.requestTokens);
  metricResponseTokens.textContent = formatNumber(tokenStats.responseTokens);
  metricTokenLimit.textContent = formatNumber(tokenStats.contextLimit);
  metricTokenCost.textContent = formatUsd(tokenStats.estimatedCostUsd);

  tokenWarning.classList.toggle("error", tokenStats.warningLevel === "error");
  tokenWarning.classList.toggle("warning", tokenStats.warningLevel === "warning");

  if (!tokenStats.contextLimit) {
    tokenWarning.textContent = "";
  } else if (tokenStats.overLimit) {
    tokenWarning.textContent = `Контекст переполнен: ${formatNumber(tokenStats.requestTokens)} из ${formatNumber(tokenStats.contextLimit)} токенов. Запрос не будет отправлен.`;
  } else if (tokenStats.warningLevel === "warning") {
    tokenWarning.textContent = `Контекст почти заполнен: ${formatNumber(tokenStats.requestTokens)} из ${formatNumber(tokenStats.contextLimit)} токенов.`;
  } else {
    tokenWarning.textContent = `Осталось примерно ${formatNumber(tokenStats.remainingTokens)} токенов контекста.`;
  }
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

  const response = await fetch("/api/chat/tokens", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chatId: activeChatId,
      message: chatInput.value,
      model: getSelectedModel()
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

function setCurrentUser(user) {
  currentUser = user || null;
  userBadge.textContent = currentUser?.login || "";
  userBadge.classList.toggle("hidden", !currentUser);
  logoutButton.classList.toggle("hidden", !currentUser);
  if (!currentUser) {
    updateTokenMetrics(null);
  }
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
  await loadChats(null);
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
    addMessage("assistant", "Привет! Войдите в аккаунт, выберите чат слева или начните новый диалог. Я буду помнить контекст внутри выбранного чата.");
  }
}

function renderChatList() {
  chatList.innerHTML = "";

  if (!chats.length) {
    const empty = document.createElement("p");
    empty.className = "chat-list-empty";
    empty.textContent = currentUser ? "История пока пуста." : "Войдите, чтобы увидеть свои чаты.";
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
    button.dataset.chatId = chat.id;

    const title = document.createElement("strong");
    title.textContent = chat.title || "Новый чат";

    const preview = document.createElement("span");
    preview.textContent = chat.preview || `${chat.messageCount || 0} сообщений`;

    button.append(title, preview);
    button.addEventListener("click", () => loadChat(chat.id));

    const deleteButton = document.createElement("button");
    deleteButton.className = "icon-button delete-chat-button";
    deleteButton.type = "button";
    deleteButton.title = "Удалить чат";
    deleteButton.setAttribute("aria-label", "Удалить чат");
    deleteButton.textContent = "×";
    deleteButton.addEventListener("click", () => {
      deleteChat(chat.id).catch(() => {
        setStatus("ошибка", "error");
      });
    });

    row.append(button, deleteButton);
    chatList.append(row);
  });
}

function setActiveChat(chat) {
  activeChatId = chat?.id || null;
  activeChatTitle.textContent = chat?.title || "Новый чат";
  updateTokenMetrics(chat?.tokenStats);
  renderChatList();
}

function upsertChat(chat) {
  if (!chat?.id) return;

  const existingIndex = chats.findIndex((item) => item.id === chat.id);
  if (existingIndex === -1) {
    chats.unshift(chat);
  } else {
    chats[existingIndex] = {
      ...chats[existingIndex],
      ...chat
    };
  }

  chats.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  if (chat.id === activeChatId) {
    activeChatTitle.textContent = chat.title || "Новый чат";
    if (chat.tokenStats) {
      updateTokenMetrics(chat.tokenStats);
    }
  }
  renderChatList();
}

function updateLastAssistantMessage(text) {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === "assistant") {
    lastMessage.content = text;
  }
}

function parseSseEvents(buffer, onEvent) {
  let normalized = buffer.replace(/\r\n/g, "\n");
  let boundaryIndex = normalized.indexOf("\n\n");

  while (boundaryIndex !== -1) {
    const rawEvent = normalized.slice(0, boundaryIndex);
    normalized = normalized.slice(boundaryIndex + 2);
    const lines = rawEvent.split("\n");
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const dataText = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (dataText) {
      onEvent(eventName, JSON.parse(dataText));
    }

    boundaryIndex = normalized.indexOf("\n\n");
  }

  return normalized;
}

async function readChatStream(response, assistantText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseEvents(buffer, (eventName, payload) => {
      if (eventName === "chat" && payload.chat) {
        setActiveChat(payload.chat);
        upsertChat(payload.chat);
      }

      if (eventName === "delta") {
        fullText += payload.delta || "";
        assistantText.textContent = fullText;
        updateLastAssistantMessage(fullText);
        messageList.scrollTop = messageList.scrollHeight;
      }

      if (eventName === "meta" && payload.chat) {
        upsertChat(payload.chat);
        updateTokenMetrics(payload.tokenStats || payload.chat.tokenStats);
      }

      if (eventName === "error") {
        throw new Error(payload.error || "Stream error.");
      }
    });
  }

  if (!fullText.trim()) {
    assistantText.textContent = "Ответ не был получен.";
    updateLastAssistantMessage(assistantText.textContent);
  }
}

async function loadChats(preferredChatId = activeChatId) {
  const response = await fetch("/api/chats");
  if (response.status === 401) {
    showAuth();
    return;
  }

  if (!response.ok) {
    throw new Error(`Chats request failed: ${response.status}`);
  }

  const payload = await response.json();
  chats = Array.isArray(payload.chats) ? payload.chats : [];
  renderChatList();

  const nextChatId = preferredChatId && chats.some((chat) => chat.id === preferredChatId)
    ? preferredChatId
    : chats[0]?.id || null;

  if (nextChatId) {
    await loadChat(nextChatId);
    return;
  }

  setActiveChat(null);
  renderMessages([]);
  updateTokenMetrics(null);
}

async function loadChat(chatId) {
  const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
  if (response.status === 401) {
    showAuth();
    return;
  }

  if (!response.ok) {
    throw new Error(`Chat request failed: ${response.status}`);
  }

  const payload = await response.json();
  const chat = payload.chat;
  upsertChat(chat);
  setActiveChat(chat);
  renderMessages(chat.messages);
  updateTokenMetrics(chat.tokenStats);
  setStatus("готов");
  scheduleTokenPreview();
}

async function createNewChat() {
  if (!currentUser) {
    showAuth();
    return;
  }

  const response = await fetch("/api/chats", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: "Новый чат"
    })
  });

  if (response.status === 401) {
    showAuth();
    return;
  }

  if (!response.ok) {
    throw new Error(`Create chat failed: ${response.status}`);
  }

  const payload = await response.json();
  const chat = payload.chat;
  upsertChat(chat);
  setActiveChat(chat);
  renderMessages([]);
  updateTokenMetrics(null);
  scheduleTokenPreview();
  chatInput.focus();
}

async function deleteChat(chatId) {
  if (!currentUser) {
    showAuth();
    return;
  }

  if (!chatId) return;
  if (!window.confirm("Удалить этот чат?")) return;

  const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: "DELETE"
  });

  if (response.status === 401) {
    showAuth();
    return;
  }

  if (!response.ok) {
    throw new Error(`Delete chat failed: ${response.status}`);
  }

  const payload = await response.json();
  chats = Array.isArray(payload.chats) ? payload.chats : [];

  if (activeChatId === chatId) {
    const nextChat = chats[0] || null;
    if (nextChat) {
      await loadChat(nextChat.id);
    } else {
      setActiveChat(null);
      renderMessages([]);
      updateTokenMetrics(null);
      setStatus("готов");
    }
    return;
  }

  renderChatList();
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
  scheduleTokenPreview();

  const assistantText = addMessage("assistant", "");
  messages.push({ role: "assistant", content: "" });
  sendMessageButton.disabled = true;
  chatInput.disabled = true;
  setStatus("стрим", "loading");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apiKey: chatApiKey.value,
        chatId: activeChatId,
        model,
        message: content
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

    await readChatStream(response, assistantText);
    setStatus("готов");
  } catch (error) {
    assistantText.textContent = error.message;
    updateLastAssistantMessage(error.message);
    setStatus("ошибка", "error");
  } finally {
    sendMessageButton.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
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
  if (chatModel.value === "custom") {
    customModel.focus();
  }
  scheduleTokenPreview();
});

customModel.addEventListener("input", scheduleTokenPreview);

newChatButton.addEventListener("click", () => {
  createNewChat().catch(() => {
    setStatus("ошибка", "error");
  });
});

clearChatButton.addEventListener("click", () => {
  if (!currentUser) {
    showAuth();
    return;
  }

  if (!activeChatId) {
    renderMessages([]);
    return;
  }

  fetch(`/api/chats/${encodeURIComponent(activeChatId)}/messages`, { method: "DELETE" })
    .then((response) => {
      if (response.status === 401) {
        showAuth();
        return null;
      }

      if (!response.ok) throw new Error(`Clear failed: ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      if (!payload) return;
      upsertChat(payload.chat);
      setActiveChat(payload.chat);
      renderMessages([]);
      setStatus("готов");
      chatInput.focus();
    })
    .catch(() => {
      setStatus("ошибка", "error");
    });
});

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
checkAuth().catch(() => {
  renderMessages([]);
  setStatus("ошибка", "error");
  showAuth();
});
