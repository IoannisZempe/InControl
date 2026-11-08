# Contributing to InControl

Thanks for helping! InControl aims to be the place where you can see every AI agent you run, whatever IDE or terminal it lives in. Contributions of all sizes are welcome.

## Quick start

```bash
git clone https://github.com/IoannisZempe/InControl.git
cd InControl
npm install
npm start        # hub at http://localhost:4747
npm test
```

On macOS you can also run `npm run panel` to build and open the native side panel. This needs the Xcode command line tools.

## Project layout

| Path | What lives there |
|---|---|
| `src/server/` | Hub (HTTP + WebSocket), agent state store, simulator, macOS window focus |
| `src/connectors/` | Integrations: Claude Code hooks, MCP server, CLI wrapper |
| `src/sdk/` | Client SDKs for custom agents (JS, Python) |
| `public/` | Web UI shared by the side panel, browser and phone PWA (no build step) |
| `macos/` | Native Swift side panel |
| `test/` | `node:test` tests |

## Good first contributions

- **New connectors.** Add support for another agent or IDE, such as Zed, JetBrains AI, Gemini CLI, Copilot agent, or Devin. Put it in `src/connectors/` and document it in the README.
- **SDKs** in other languages (Go, Rust, Ruby). Each one is just a few HTTP calls.
- **Prompt detection.** Improve the `PROMPT_PATTERNS` in `cli-wrapper.js` for specific CLIs.
- **Window focus on Linux and Windows.** Extend `macos-focus.js`.
- **Roadmap items** in the README, such as pairing-token auth, Web Push, or persistence.

Look for issues labelled `good first issue` and `help wanted`.

## Workflow

1. If the change is big, open an issue or start a discussion first so we can agree on the approach.
2. Fork the repo, create a branch (`feat/zed-connector`, `fix/ws-reconnect`), and make your change.
3. Add or update tests and run `npm test`.
4. Open a PR using the template. Keep each PR focused on one thing.

## Guidelines

- **Keep dependencies minimal.** The runtime currently depends only on `ws` and `qrcode`. Explain any new dependency in your PR.
- **Never break the agent.** Connectors must fail silently if the hub isn't running.
- **Keep it local-first.** Nothing gets sent off the user's machine unless they explicitly opt in.
- Use plain modern JavaScript (ES modules, Node ≥ 20). The UI has no build step and no framework.
- Commit messages: [Conventional Commits](https://www.conventionalcommits.org/) are preferred (`feat:`, `fix:`, `docs:`).

## Agent event protocol

Every connector reports to the hub with the same payload (`POST /api/agents/event`):

```json
{ "id": "stable-id", "name": "Agent", "provider": "my-agent", "ide": "Zed",
  "workspace": "/path", "status": "working | needs_attention | idle",
  "currentTask": "…", "currentStep": "…" }
```

To ask the user a question, use `POST /api/agents/ask`. If you change the protocol, it must stay backward compatible.

By contributing you agree that your contributions are licensed under the MIT License.
