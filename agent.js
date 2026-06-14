const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

class ChatAgent {
  constructor(options = {}) {
    this.apiUrl = options.apiUrl || OPENAI_RESPONSES_URL;
    this.fetch = options.fetchImpl || fetch;
    this.defaultModel = options.defaultModel || "gpt-4.1-mini";
    this.instructions = options.instructions || [
      "You are a helpful AI chat agent.",
      "Answer clearly, naturally, and in the same language the user uses when possible."
    ].join(" ");
  }

  buildRequestBody({ message, messages, model }) {
    const selectedModel = String(model || this.defaultModel).trim() || this.defaultModel;
    const conversation = this.buildConversationInput(message, messages);

    return {
      model: selectedModel,
      instructions: this.instructions,
      input: conversation,
      stream: true,
      store: false
    };
  }

  buildConversationInput(message, messages) {
    const safeMessages = Array.isArray(messages)
      ? messages
        .map((item) => ({
          role: item?.role === "assistant" ? "assistant" : "user",
          content: String(item?.content || "").trim()
        }))
        .filter((item) => item.content)
        .slice(-20)
      : [];

    if (!safeMessages.length && message) {
      safeMessages.push({
        role: "user",
        content: String(message).trim()
      });
    }

    return safeMessages
      .map((item) => `${item.role === "assistant" ? "Assistant" : "User"}: ${item.content}`)
      .join("\n\n");
  }

  async streamResponse({ apiKey, message, messages, model, signal, onText, onComplete }) {
    const requestBody = this.buildRequestBody({ message, messages, model });
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

    await this.readSseStream(response.body, {
      onEvent: (event) => {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          onText(event.delta);
          return;
        }

        if (event.type === "response.completed") {
          onComplete?.(event.response || null);
          return;
        }

        if (event.type === "error") {
          const messageText = event.error?.message || event.message || "OpenAI stream returned an error.";
          throw new Error(messageText);
        }
      }
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
