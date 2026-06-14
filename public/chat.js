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
const themeToggle = document.querySelector("#themeToggle");
const themeIcon = document.querySelector("#themeIcon");

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
      if (eventName === "delta") {
        fullText += payload.delta || "";
        assistantText.textContent = fullText;
        updateLastAssistantMessage(fullText);
        messageList.scrollTop = messageList.scrollHeight;
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

async function sendChatMessage(event) {
  event.preventDefault();

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
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apiKey: chatApiKey.value,
        model,
        message: content,
        messages: messages.slice(0, -1)
      })
    });

    if (!response.ok) {
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
});

clearChatButton.addEventListener("click", () => {
  messages.length = 0;
  messageList.innerHTML = "";
  setStatus("готов");
  chatInput.focus();
});

themeToggle.addEventListener("click", toggleTheme);
chatForm.addEventListener("submit", sendChatMessage);

applyTheme(getSavedTheme());
addMessage("assistant", "Привет! Я отдельный агент. Выберите модель, напишите запрос, и я отвечу потоком.");
