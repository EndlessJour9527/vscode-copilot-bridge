# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Build the Project
To compile the TypeScript code:
```bash
npm run compile
```

### Watch for Changes
To recompile the code automatically on changes:
```bash
npm run watch
```

### Package the Extension
To create a `.vsix` package for the extension:
```bash
npm run package
```

### Run the Extension
To launch the extension in a development instance of VS Code:
```bash
code .
```

### Lint the Code
To check for linting issues:
```bash
npm run lint
```

### Run Tests
(Currently, no tests are implemented. If added, update this section.)

## High-Level Code Architecture

### Overview
This repository implements a VS Code extension that exposes GitHub Copilot through a local OpenAI-compatible HTTP bridge. The bridge uses the public VS Code Language Model API (`vscode.lm`) to interact with Copilot models.

### Key Components

#### 1. Extension Activation
- **File**: `src/extension.ts`
- Handles activation and deactivation of the extension, command registration, and bridge lifecycle management.

#### 2. HTTP Server
- **File**: `src/http/server.ts`
- Implements the Polka-based HTTP server, including middleware and error handling.

#### 3. API Routes
- **Directory**: `src/http/routes/`
- Contains route handlers for:
  - `/health`: Health checks.
  - `/v1/models`: Lists available models.
  - `/v1/chat/completions`: Handles chat completions.

#### 4. Copilot Integration
- **File**: `src/models.ts`
- Manages model selection and status updates using the VS Code Language Model API.

#### 5. Message Normalization
- **File**: `src/messages.ts`
- Converts user, assistant, and system messages into the format required by the Language Model API.

#### 6. State Management
- **Files**: `src/state.ts`, `src/status.ts`
- Maintains in-memory state for the server and updates the status bar in VS Code.

#### 7. Utilities
- **File**: `src/http/utils.ts`
- Provides helper functions for JSON responses and error handling.

#### 8. Configuration
- **File**: `src/config.ts`
- Reads and validates configuration settings from `package.json`.

#### 9. Logging
- **File**: `src/log.ts`
- Handles logging for debugging and diagnostics.

### Key Design Principles
- **Local-Only**: The bridge binds to `127.0.0.1` and is not intended for multi-user or remote deployments.
- **Authentication**: All API requests require a bearer token.
- **Streaming**: Responses use Server-Sent Events (SSE) for incremental updates.
- **Concurrency**: Limits are enforced to maintain VS Code responsiveness.

### Contribution Guidelines
- Follow the coding standards outlined in `AI Agent Contribution Guide`.
- Update documentation for any changes to public API contracts or configuration settings.
- Keep changes minimal and focused on the task at hand.

For more details, refer to the `README.md` and `AI Agent Contribution Guide` files.