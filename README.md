# HOOX · Telegram Worker

**The notification plane — pushes trade confirmations, AI market briefs, and kill-switch alerts to Telegram. Also listens: copilot commands, RAG queries, operator chat.**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Part of the [HOOX](https://github.com/hoox-sh/hoox) edge-trading mesh — a production-grade algorithmic trading framework on Cloudflare Workers.**  
**Site:** [hoox.sh](https://hoox.sh) · **Docs:** [docs.hoox.sh](https://docs.hoox.sh) · **Paper:** [`hoox-arxiv-paper-core.pdf`](https://github.com/hoox-sh/hoox/blob/main/papers/hoox-arxiv-paper-core.pdf)

---

The telegram-worker is the bi-directional notification hub for the HOOX mesh. Six workers — [`hoox`](../hoox), [`trade-worker`](../trade-worker), [`agent-worker`](../agent-worker), [`report-worker`](../report-worker), [`web3-wallet-worker`](../web3-wallet-worker), and [`email-worker`](../email-worker) — fire notifications through its service binding. Outbound messages (trade confirmations, AI-generated market summaries, emergency risk alerts, PDF delivery notices) are sent via the Telegram Bot API to configured `chat_id` targets.

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
| Inbound (callers) | [`hoox`](../hoox), [`trade-worker`](../trade-worker), [`agent-worker`](../agent-worker), [`report-worker`](../report-worker), [`web3-wallet-worker`](../web3-wallet-worker), [`email-worker`](../email-worker) | `TELEGRAM_SERVICE` |

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

### License

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — part of the HOOX open-core mesh.
