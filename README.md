# StandAI Node Server

Small Express server that proxies Azure AI Projects agents so you can request a joke and send feedback for improved responses. Telemetry is wired up with Azure Monitor and OpenTelemetry for tracing incoming requests and agent runs.

## Requirements

- Node.js 20+
- Azure identity capable of running `DefaultAzureCredential`
- An Azure AI Projects Agent configured for jokes (and optional feedback agent)

## Setup

1. Install dependencies:
   ```bash
   npm install
   # or
   yarn install
   ```
2. Create a `.env` file with the following variables:
   - `PROJECT_ENDPOINT` – Azure AI Projects endpoint (e.g. `https://...cognitiveservices.azure.com`)
   - `AGENT_ID` – Agent id used for `/joke`
   - `FEEDBACK_AGENT_ID` – Optional, defaults to `AGENT_ID`
   - `PORT` – Server port (defaults to `8000`)
   - `CORS_ORIGINS` – Comma separated origins or `*`
3. Start the server in dev mode:
   ```bash
   npm run dev
   # or
   yarn dev
   ```

## API

- `GET /joke` – Triggers the main agent and returns the generated joke plus the Azure thread id. Telemetry spans are recorded for the run, message contents, and usage counters.
- `GET /feedback?reaction=<like|dislike>&threadId=<thread>` – Lets you send the previous reaction back to the feedback agent so a new joke is produced in the same thread.

## Tooling

- `npm run lint` / `npm run lint:fix` — or `yarn lint` / `yarn lint:fix` — ESLint with Prettier rules enabled.
- `npm run format` — or `yarn format` — runs Prettier directly across the repo.

VS Code users can rely on the `.vscode/settings.json` file which formats on save via ESLint so Prettier fixes run transparently.
