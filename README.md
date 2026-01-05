<img src="images/icon.png" width="100" />

# Copilot Bridge (VS Code Extension)

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/thinkability.copilot-bridge)](https://marketplace.visualstudio.com/items?itemName=thinkability.copilot-bridge)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/d/thinkability.copilot-bridge?label=installs)](https://marketplace.visualstudio.com/items?itemName=thinkability.copilot-bridge)

> **A local interface for GitHub Copilot built on the official VS Code Language Models API.**

Copilot Bridge lets you access your personal Copilot session locally through an OpenAI-compatible interface — **without calling any private GitHub endpoints**. It’s designed for developers experimenting with AI agents, CLI tools, and custom integrations inside their own editor environment.

> **API Surface:** Uses only the public VS Code **Language Model API** (`vscode.lm`) for model discovery and chat. No private Copilot endpoints, tokens, or protocol emulation.
---

## ✨ Key Features

- Local HTTP server locked to `127.0.0.1`
- OpenAI-style `/v1/chat/completions`, `/v1/responses`, `/v1/models`, and `/health` endpoints
- Google Gemini API format support: `/v1/models/{model}:generateContent` and `:streamGenerateContent`
- OpenAI Responses API support for advanced integrations
- SSE streaming for incremental responses
- Real-time model discovery via VS Code Language Model API
- Concurrency and rate limits to keep VS Code responsive
- Mandatory bearer token authentication with `HTTP 401 Unauthorized` protection
- Lightweight Polka-based server integrated directly with the VS Code runtime

---

## ⚖️ Compliance & Usage Notice

- Uses **only** the public VS Code Language Models API.
- Does **not** contact or emulate private GitHub Copilot endpoints.
- Requires an active GitHub Copilot subscription.
- Subject to [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) and the [Github Acceptable Use Policy](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies).
- Intended for **personal, local experimentation** only.
- No affiliation with GitHub or Microsoft.

> ❗ The author provides this project as a technical demonstration. Use responsibly and ensure your own compliance with applicable terms.

---

## 🚧 Scope and Limitations

| ✅ Supported | 🚫 Not Supported |
|--------------|------------------|
| Local, single-user loopback use | Multi-user or shared deployments |
| Testing local agents or CLI integrations | Continuous automation or CI/CD use |
| Educational / experimental use | Public or commercial API hosting |

---

## 🧠 Motivation

Copilot Bridge was built to demonstrate how VS Code’s **Language Model API** can power local-first AI tooling.  
It enables developers to reuse OpenAI-compatible SDKs and workflows while keeping all traffic on-device.

This is **not** a Copilot proxy, wrapper, or reverse-engineered client — it’s a bridge built entirely on the editor’s public extension surface.

---

## ⚠️ Disclaimer

This software is provided *as is* for research and educational purposes.  
Use at your own risk.  
You are solely responsible for ensuring compliance with your Copilot license and applicable terms.  
The author collects no data and has no access to user prompts or completions.

---

## 🚀 Quick Start

### Requirements
- Visual Studio Code Desktop with GitHub Copilot signed in  
- (Optional) Node.js 18+ and npm for local builds

### Installation

1. Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=thinkability.copilot-bridge) or load the `.vsix`.
2. Set **Copilot Bridge › Token** to a secret value (Settings UI or JSON). Requests without this token receive `401 Unauthorized`.
3. Open the **Command Palette** → “Copilot Bridge: Enable” to start the bridge.
4. Check status anytime with “Copilot Bridge: Status” or by hovering the status bar item (it links directly to the token setting when missing).
5. Keep VS Code open — the bridge runs only while the editor is active.

---

## 📡 Using the Bridge

Replace `PORT` with the one shown in “Copilot Bridge: Status”. Use the same token value you configured in VS Code:

```bash
export PORT=12345                 # Replace with the port from the status command
export BRIDGE_TOKEN="<your-copilot-bridge-token>"
```

List models:

```bash
curl -H "Authorization: Bearer $BRIDGE_TOKEN" \
  http://127.0.0.1:$PORT/v1/models
```

Stream a completion:

```bash
curl -N \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-copilot","messages":[{"role":"user","content":"hello"}]}' \
  http://127.0.0.1:$PORT/v1/chat/completions
```

Use with OpenAI SDK:

```ts
import OpenAI from "openai";

if (!process.env.BRIDGE_TOKEN) {
  throw new Error("Set BRIDGE_TOKEN to the same token configured in VS Code settings (bridge.token).");
}

const client = new OpenAI({
  baseURL: `http://127.0.0.1:${process.env.PORT}/v1`,
  apiKey: process.env.BRIDGE_TOKEN,
});

const rsp = await client.chat.completions.create({
  model: "gpt-4o-copilot",
  messages: [{ role: "user", content: "hello" }],
});

console.log(rsp.choices[0].message?.content);
```

### Google Gemini API Compatibility

The bridge also supports Google Gemini API format for compatibility with tools like LiteLLM:

```bash
# Non-streaming request
curl -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}' \
  http://127.0.0.1:$PORT/v1/models/gemini-2.5-pro:generateContent

# Streaming request
curl -N \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}' \
  http://127.0.0.1:$PORT/v1/models/gemini-2.5-pro:streamGenerateContent
```

The bridge automatically converts between Gemini and OpenAI formats internally, allowing you to use tools that expect Gemini API endpoints.

### OpenAI Responses API Format

The bridge supports the OpenAI Responses API format (`/v1/responses`) for advanced integrations:

```bash
# Streaming request
curl -N \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-copilot",
    "input": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "stream": true
  }' \
  http://127.0.0.1:$PORT/v1/responses

# Non-streaming request
curl -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-copilot",
    "input": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "stream": false
  }' \
  http://127.0.0.1:$PORT/v1/responses
```

The Responses API uses `input` array instead of `messages`, and returns structured `response.created`, `response.output_item`, and `response.completed` events for streaming requests. This format is compatible with tools like [OpenAI Codex](https://deepwiki.com/openai/codex/4.5-app-server-and-ide-integration).

---

## 🧩 Architecture

The extension uses VS Code’s built-in Language Model API to select available Copilot chat models.  
Requests are normalized and sent through VS Code itself, never directly to GitHub Copilot servers.  
Responses stream back via SSE with concurrency controls for editor stability.


### How it calls models (pseudocode)

```ts
import * as vscode from "vscode";

const models = await vscode.lm.selectChatModels({
  where: { vendor: "copilot", supports: { reasoning: true } }
});
const model = models[0] ?? (await vscode.lm.selectChatModels({}))[0];
if (!model) throw new Error("No language models available (vscode.lm)");

const stream = await model.sendRequest(
  { kind: "chat", messages: [{ role: "user", content: "hello" }] },
  { temperature: 0.2 }
);

// Stream chunks → SSE to localhost client; no private Copilot protocol used.
```

---

## ⚙️ Language Model Tools & Agent Mode

VS Code provides a **Language Model Tools** API that lets extensions register *executable tools* which a model can call when running in an agent/tool-calling mode. This is a separate capability from the plain `chat` flow — tools are not invoked by merely passing `LanguageModelChatMessage` objects; they require tool registration and an agent-aware exchange.

- Define tools in `package.json` with `contributes.languageModelTools` (name, toolReferenceName, displayName, description, etc.).

```json
"contributes": {
  "languageModelTools": [
    {
      "name": "my_tool",
      "toolReferenceName": "myTool",
      "displayName": "My Tool",
      "description": "Does something",
      "canBeReferencedInPrompt": true
    }
  ]
}
```

- Register tool implementations in code with `vscode.lm.registerTool('my_tool', impl)`. When running in agent mode VS Code will provide registered tools to the model; the model can request a tool call, VS Code executes it, and the result is returned to the model for further reasoning.

```ts
vscode.lm.registerTool('my_tool', new MyToolImplementation());
```

Notes & limitations:

- `LanguageModelChatMessage` is a chat-only message type and by itself does not enable tool calling.
- To use tools you need an agent context (or an explicit prompt that references a tool) and a model/provider that supports tool-calling/agent behavior.
- Copilot Bridge includes conversions and streaming support for tool-call payloads, but the bridge cannot make tools magically available — tools must be registered in the editor and the model must be able to call them.

If you want the bridge to *actively support agent/tool workflows*, the extension that needs the tool must register it with `vscode.lm` (or we can add helper examples to the repo). Let me know if you want me to add a short example extension or more docs here.

---

## 🔧 Configuration

| Setting | Default | Description |
|----------|----------|-------------|
| `bridge.enabled` | false | Start automatically with VS Code |
| `bridge.port` | 0 | Ephemeral port |
| `bridge.token` | "" | Bearer token required for every request (leave empty to block API access) |
| `bridge.historyWindow` | 3 | Retained conversation turns |
| `bridge.maxConcurrent` | 1 | Max concurrent requests |
| `bridge.verbose` | false | Enable verbose logging |

> ℹ️ The bridge always binds to `127.0.0.1` and cannot be exposed to other interfaces.

> 💡 Hover the status bar item to confirm the token status; missing tokens show a warning link that opens the relevant setting.

---

## 🪶 Logging & Diagnostics

1. Enable `bridge.verbose`.
2. Open **View → Output → “Copilot Bridge”**.
3. Observe connection events, health checks, and streaming traces.

---

## 🔒 Security

> ⚠️ This extension is intended for **localhost use only**.  
> Never expose the endpoint to external networks.

- Loopback-only binding (non-configurable)  
- Mandatory bearer token gating (requests rejected without the correct header)  
- **Telemetry:** none collected or transmitted.

---

## 🧾 Changelog

- **v1.2.0** – Authentication token now mandatory; status bar hover warns when missing  
- **v1.1.1** – Locked the HTTP server to localhost for improved safety  
- **v1.1.0** – Performance improvements (~30%)  
- **v1.0.0** – Modular core, OpenAI typings, tool-calling support  
- **v0.2.2** – Polka integration, improved model family selection  
- **v0.1.0–0.1.5** – Initial releases and bug fixes

---

## 🤝 Contributing

Pull requests and discussions are welcome.  
Please open an [issue](https://github.com/larsbaunwall/vscode-copilot-bridge/issues) to report bugs or suggest features.

---

## 📄 License

Apache 2.0 © 2025 [Lars Baunwall]  
Independent project — not affiliated with GitHub or Microsoft.  
For compliance or takedown inquiries, please open a GitHub issue.

---

### ❓ FAQ

#### Can I run this on a server?
No. Copilot Bridge is designed for **localhost-only**, single-user, interactive use.  
Running it on a shared host or exposing it over a network would violate its intended scope and could breach the Copilot terms.  
The host is bound to `127.0.0.1` (non-configurable).

#### Does it send any data to the author?
No. The bridge never transmits telemetry, prompts, or responses to any external service.  
All traffic stays on your machine and flows through VS Code’s built-in model interface.

#### What happens if Copilot is unavailable?
The `/health` endpoint will report a diagnostic reason such as `copilot_unavailable` or `missing_language_model_api`.  
This means VS Code currently has no accessible models via `vscode.lm`. Once Copilot becomes available again, the bridge will resume automatically.

#### Can I use non-Copilot models?
Yes, if other providers register with `vscode.lm`. The bridge will detect any available chat-capable models and use the first suitable one it finds.

#### How is this different from reverse-engineered Copilot proxies?
Reverse-engineered proxies call private endpoints directly or reuse extracted tokens.  
Copilot Bridge does neither—it communicates only through VS Code’s sanctioned **Language Model API**, keeping usage transparent and compliant.