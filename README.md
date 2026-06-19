# OpenAI API Parameter Lab

## Day 11: Memory Layer Agent

Open `http://localhost:3000/chat_memory` to use the separate memory assistant.

It uses a new `MemoryAgent` instead of the classic `/chat` agent and stores memory in three separate files:

- `data/memory-short-term.json` - current dialogue messages and temporary notes per chat.
- `data/memory-working.json` - active task data, constraints, decisions, and next steps per chat.
- `data/memory-long-term.json` - durable user profile, preferences, decisions, and reusable knowledge per user.

The UI supports registration/login, multiple saved memory chats, manual explicit memory writes, automatic memory routing logs, and debug panels showing the memory snapshot, request parameters sent to `/api/chat_memory`, the OpenAI request body, and response metadata.

For Railway deploys, attach a persistent Volume and either mount it so Railway exposes `RAILWAY_VOLUME_MOUNT_PATH`, or set `DATA_DIR` to the mounted path. Without a Volume, JSON files live inside the container filesystem and can disappear after restarts, redeploys, or instance changes.

Простой сайт для экспериментов с параметрами OpenAI API. Слева находятся настройки модели, API-ключа и параметров запроса, справа отображаются JSON запроса и JSON ответа. Ответ можно переключить в текстовый вид.

## Почему JavaScript и Node.js

Для Railway здесь лучше всего подходит JavaScript на Node.js без внешних зависимостей: проект быстро стартует через `npm start`, не требует сборки, а backend-прокси позволяет отправлять запросы в OpenAI без прямого обращения браузера к OpenAI API.

## Локальный запуск

```bash
npm start
```

Откройте `http://localhost:3000`.

## Railway

Railway автоматически использует `npm start`. Можно вводить API-ключ в интерфейсе или добавить переменную окружения:

```bash
OPENAI_API_KEY=sk-...
```

Если ключ введен в интерфейсе, он используется только для текущего запроса и не сохраняется сервером.

## Параметры

Основной запрос отправляется в OpenAI Responses API:

```http
POST https://api.openai.com/v1/responses
```

Все параметры, кроме `model` и `input`, необязательные. Если поле пустое, сайт не добавляет его в JSON запроса. Поэтому можно отправить минимальный запрос только с моделью и prompt.

Сайт учитывает выбранную модель:

- `reasoning.effort` показывается только для моделей, где оно применимо.
- `temperature` и `top_p` для GPT-5 reasoning-моделей отправляются только при `reasoning.effort = none`.
- `max_output_tokens` и `text.verbosity` отправляются только если заполнены.
- `presence_penalty`, `frequency_penalty`, `top_k`, `top_v` не отправляются автоматически, потому что они не указаны как параметры Responses API для этого запроса. Для экспериментов можно использовать `Extra JSON`.

В списке моделей есть группы `Frontier`, `GPT-5 family`, `GPT-4 family` и `Reasoning`. Dropdown рассчитан на текстовые запросы через Responses API, поэтому audio, image и realtime модели в него не добавлены.

## Метрики ответа

Над окнами JSON показываются время ответа, `input_tokens`, `output_tokens`, `total_tokens` и примерная стоимость. Токены берутся из поля `usage` в ответе OpenAI. Стоимость считается по встроенной таблице цен за 1M токенов, актуальной на момент обновления проекта; для моделей без цены сайт показывает `нет цены`.

## Тема

Кнопка рядом со статусом переключает светлую и темную тему. Выбор сохраняется в браузере через `localStorage`.

## Группа экспертов

В левой панели есть блок `Experts`. Каждый эксперт состоит из роли и фокуса. Например:

- `Аналитик` — оценивает рынок, риски, метрики и бизнес-эффект.
- `Инженер` — оценивает реализацию, ограничения и технические риски.
- `Критик` — ищет слабые места и спорные допущения.

Группа экспертов добавляется в `instructions` только если включен чекбокс `Использовать в запросе`. Это позволяет отправлять и минимальные запросы только с prompt.
