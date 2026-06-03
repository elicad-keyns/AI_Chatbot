# OpenAI API Parameter Lab

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

Поддержаны базовые поля `model`, `input`, `instructions`, `temperature`, `top_p`, `max_output_tokens`, `presence_penalty`, `frequency_penalty`, `reasoning.effort`, а также экспериментальные `top_k`, `top_v` и поле `Extra JSON` для дополнительных параметров.
