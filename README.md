# OpenAI API Parameter Lab

## Day 11: Memory Layer Agent

Open `http://localhost:3000/memory_chat` to use the separate memory assistant.

The memory agent uses three explicit memory layers:

- `data/memory-short-term.json` - current chat only. Stores messages, temporary notes, and a compressed summary of older messages when the sliding window overflows.
- `data/memory-working.json` - active task memory shared across memory chats for the same user. Stores goals, constraints, task decisions, and current state.
- `data/memory-long-term.json` - durable user memory shared across all memory chats for the same user. Stores sticky facts such as name, preferences, role, language, projects, and reusable knowledge.

For every request the agent sends:

1. The compressed short-term summary, if the chat has more messages than the selected window.
2. The latest `N` short-term messages from the selected window.
3. Working memory, when enabled.
4. Long-term memory, when enabled.
5. The current user message.

The UI includes registration/login, chat selection, model selection, OpenAI API key input, manual memory writes, token estimates, and debug panels showing the memory snapshot and exact request body prepared for OpenAI.

## Local Run

```bash
npm start
```

Then open:

- `http://localhost:3000/memory_chat` for the memory-layer agent.
- `http://localhost:3000/chat` for the classic chat.
- `http://localhost:3000` for the parameter lab.

## Railway

Railway uses `npm start`.

You can enter the OpenAI API key in the UI or set:

```bash
OPENAI_API_KEY=sk-...
```

For persistent memory on Railway, attach a Volume and either mount it so Railway exposes `RAILWAY_VOLUME_MOUNT_PATH`, or set `DATA_DIR` to the mounted path. Without a Volume, JSON files live inside the container filesystem and can disappear after restarts, redeploys, or instance changes.
