# HOOX · Telegram Worker

**The notification plane — pushes trade confirmations, AI market briefs, and kill-switch alerts to Telegram. Also listens: copilot commands, RAG queries, operator chat.**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Part of the [HOOX](https://github.com/hoox-sh/hoox) edge-trading mesh — a production-grade algorithmic trading framework on Cloudflare Workers.**  
**Site:** [hoox.sh](https://hoox.sh) · **Docs:** [docs.hoox.sh](https://docs.hoox.sh) · **Paper:** [`hoox-arxiv-paper-core.pdf`](https://github.com/hoox-sh/hoox/blob/main/papers/hoox-arxiv-paper-core.pdf)

---

The telegram-worker is the bi-directional notification hub for the HOOX mesh. Six workers — [`hoox`](https://github.com/hoox-sh/hoox-worker), [`trade-worker`](https://github.com/hoox-sh/trade-worker), [`agent-worker`](https://github.com/hoox-sh/agent-worker), [`report-worker`](https://github.com/hoox-sh/report-worker), [`web3-wallet-worker`](https://github.com/hoox-sh/web3-wallet-worker), and [`email-worker`](https://github.com/hoox-sh/email-worker) — fire notifications through its service binding. Outbound messages (trade confirmations, AI-generated market summaries, emergency risk alerts, PDF delivery notices) are sent via the Telegram Bot API to configured `chat_id` targets.

Inbound, the worker processes Telegram commands (`/ask`, `/search`) with optional Workers AI summarization and RAG context retrieval through Cloudflare Vectorize (`my-rag-index`). Embeddings are generated on-the-fly and queried against the RAG index for context-aware responses.

### Fan-In Architecture

```
hoox ─────────┐
trade-worker ─┤
agent-worker ─┤
report-worker ─┼──► telegram-worker ──► Telegram Bot API
email-worker ─┤        │
web3-wallet ──┘        │
                       ├──► Workers AI (summarization)
                       ├──► Vectorize (RAG context)
                       └──► R2 (media/shared files)
```

### Service Bindings

| Direction         | Worker                                                                                                                                                                                                         | Binding            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Inbound (callers) | [`hoox`](https://github.com/hoox-sh/hoox-worker), [`trade-worker`](https://github.com/hoox-sh/trade-worker), [`agent-worker`](https://github.com/hoox-sh/agent-worker), [`report-worker`](https://github.com/hoox-sh/report-worker), [`web3-wallet-worker`](https://github.com/hoox-sh/web3-wallet-worker), [`email-worker`](https://github.com/hoox-sh/email-worker) | `TELEGRAM_SERVICE` |

### Entry Points

| Method | Path       | Auth         | Description                                     |
| ------ | ---------- | ------------ | ----------------------------------------------- |
| `POST` | `/webhook` | Internal key | Primary notification endpoint (service binding) |
| `POST` | `/process` | Internal key | Legacy notification processing                  |
| `GET`  | `/health`  | None         | Liveness probe                                  |

### Capabilities

- **Trade confirmations**: structured order summaries with symbol, side, qty, price, fill time
- **AI briefs**: portfolio summaries generated via Workers AI, routed through configured model
- **Kill-switch alerts**: immediate push when agent-worker engages global circuit breaker
- **RAG queries**: `/ask` commands search Vectorize index for context-aware responses
- **PDF delivery**: report-worker fires notification on new R2 report generation
- **Embeddings**: on-the-fly text embedding generation for semantic search

### Development

```bash
bun test workers/telegram-worker
```

### Mesh interconnect

| Direction | Peers |
| --------- | ----- |
| **Called by** | [hoox-worker](https://github.com/hoox-sh/hoox-worker), [trade-worker](https://github.com/hoox-sh/trade-worker), [agent-worker](https://github.com/hoox-sh/agent-worker), [report-worker](https://github.com/hoox-sh/report-worker), [web3-wallet-worker](https://github.com/hoox-sh/web3-wallet-worker), [email-worker](https://github.com/hoox-sh/email-worker). |
| **This worker calls** | See list below |

- **[analytics-worker](https://github.com/hoox-sh/analytics-worker)** — ANALYTICS_SERVICE — delivery telemetry

Full mesh (all isolates live as git submodules under [`hoox-sh/hoox`](https://github.com/hoox-sh/hoox) `workers/`):

| Isolate | Role | Repository |
| ------- | ---- | ---------- |
| [hoox-worker](https://github.com/hoox-sh/hoox-worker) | Public webhook gateway (WAF, idempotency, dispatch) | monorepo `workers/hoox-worker` |
| [trade-worker](https://github.com/hoox-sh/trade-worker) | Multi-exchange order execution (Binance / Bybit / MEXC) | monorepo `workers/trade-worker` |
| [agent-worker](https://github.com/hoox-sh/agent-worker) | AI risk manager (5-min cron, kill switch) | monorepo `workers/agent-worker` |
| [d1-worker](https://github.com/hoox-sh/d1-worker) | D1 SQL proxy + settings / balances / positions | monorepo `workers/d1-worker` |
| [telegram-worker](https://github.com/hoox-sh/telegram-worker) | Alerts, bot commands, RAG copilot | monorepo `workers/telegram-worker` |
| [email-worker](https://github.com/hoox-sh/email-worker) | Mailgun / email signal parsing → trade | monorepo `workers/email-worker` |
| [analytics-worker](https://github.com/hoox-sh/analytics-worker) | Analytics Engine write + query path | monorepo `workers/analytics-worker` |
| [report-worker](https://github.com/hoox-sh/report-worker) | PDF reports via Browser Rendering → R2 | monorepo `workers/report-worker` |
| [web3-wallet-worker](https://github.com/hoox-sh/web3-wallet-worker) | On-chain wallet identity (ethers.js) | monorepo `workers/web3-wallet-worker` |
| [dashboard](https://github.com/hoox-sh/hoox/tree/main/workers/dashboard) | Next.js ops console (OpenNext, public) | monorepo `workers/dashboard` |

### Docs & monorepo

| Resource | Link |
| -------- | ---- |
| Isolate profile (operators) | [https://docs.hoox.sh/docs/devops/workers/telegram-worker](https://docs.hoox.sh/docs/devops/workers/telegram-worker) |
| Parent monorepo | [github.com/hoox-sh/hoox](https://github.com/hoox-sh/hoox) |
| This repository | [github.com/hoox-sh/telegram-worker](https://github.com/hoox-sh/telegram-worker) |
| Workers index | [docs.hoox.sh → Workers](https://docs.hoox.sh/docs/devops/workers) |
| CLI | `@hoox-sh/hoox-cli` · `hoox deploy worker telegram-worker` |

### License

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — part of the HOOX open-core mesh.
