# Devon AI Public API

Drop these files into your `db-v2` repo. No auth required, no new dependencies, no changes to existing files.

## File layout

```
app/api/v1/
├── route.ts                              ← GET  /api/v1
├── chat/
│   └── route.ts                          ← POST /api/v1/chat
└── conversations/
    ├── route.ts                          ← POST /api/v1/conversations
    └── [id]/
        ├── messages/
        │   └── route.ts                  ← GET  /api/v1/conversations/:id/messages
        └── stop/
            └── route.ts                  ← POST /api/v1/conversations/:id/stop
```

## Endpoints

### `GET /api/v1` — Health check
No body required.

### `POST /api/v1/chat` — Send a message

```json
{
  "message": "Hello Devon!",
  "conversation_id": "optional-existing-id",
  "user_id": "optional-stable-caller-id",
  "stream": false
}
```

**Buffered response** (`stream: false`, default):
```json
{
  "conversation_id": "abc-123",
  "reply": "Hello! How can I help?",
  "stopped": false,
  "usage": { "turns": 1 }
}
```

**Streaming response** (`stream: true`) — Server-Sent Events:
```
event: text_delta
data: {"delta":"Hello! "}

event: text_delta
data: {"delta":"How can I help?"}

event: done
data: {"stopped":false}
```
The `X-Devon-Conversation-Id` response header carries the conversation ID.

### `POST /api/v1/conversations` — List conversations

```json
{ "user_id": "me", "limit": 20, "order": "desc" }
```

### `GET /api/v1/conversations/:id/messages` — Message history

Query params: `limit` (default 20), `order` (default `asc`)

### `POST /api/v1/conversations/:id/stop` — Stop generation

No body required.

## Quick test

```bash
# Health
curl https://browser.lovedub.net/api/v1

# Buffered chat
curl -X POST https://browser.lovedub.net/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello Devon!"}'

# Streaming chat
curl -N -X POST https://browser.lovedub.net/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What time is it?", "stream": true}'

# Continue a conversation (paste the conversation_id from the first response)
curl -X POST https://browser.lovedub.net/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What did I just ask?", "conversation_id": "PASTE_ID_HERE", "user_id": "me"}'

# List conversations
curl -X POST https://browser.lovedub.net/api/v1/conversations \
  -H "Content-Type: application/json" \
  -d '{"user_id": "me"}'

# Read messages
curl "https://browser.lovedub.net/api/v1/conversations/CONV_ID/messages"
```
