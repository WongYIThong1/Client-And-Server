# Repository Guidelines

## Project Structure & Module Organization
- `server/` Node.js WebSocket gateway; entry `index.js`, Supabase helper `supabase.js`, runtime config in `.env` (copy from `config.example.txt`).
- `client/` Go WebSocket client; entry `main.go`, module metadata in `go.mod`.
- Logs and build artifacts are not tracked; keep secrets out of git (`.env`, `cert.pem`, `key.pem`).

## Build, Test, and Development Commands
- Server install: `cd server && npm install`.
- Run server: `npm start` (WS), `npm run dev` (watch mode). Drop `cert.pem`/`key.pem` alongside `index.js` to enable WSS automatically.
- Client deps: `cd client && go mod download`.
- Run client: `go run main.go` (or `go build -o client main.go && ./client`).
- Manual integration check: start server, then run client and provide a valid API key; expect `auth_success`, periodic `ping/pong`, and echo back on `data` messages.

## Coding Style & Naming Conventions
- Server uses ES modules; prefer `const`/`let`, 2-space indentation, trailing semicolons, and JSON messages shaped like `{ type, message, data }`.
- Avoid magic strings: reuse message `type` values (`auth`, `auth_success`, `auth_failed`, `ping`, `pong`, `data`, `error`).
- Go code should stay `gofmt` clean; keep exported names in PascalCase, locals in camelCase, and reuse `Message` struct fields when extending payloads.

## Testing Guidelines
- No automated test suite yet; when adding, keep Node tests near `server/` (e.g., `server/tests/`) and Go tests beside sources as `*_test.go`.
- For websocket flows, add integration tests that assert auth handshake, heartbeat (`ping/pong`), and rejection of invalid tokens.
- Aim for coverage on auth paths and connection lifecycle; document any flaky network-dependent tests.

## Commit & Pull Request Guidelines
- Use short, imperative commit subjects ("Add heartbeat timeout", "Handle invalid token"); group related changes per commit.
- PRs should describe behavior changes, include run results for `npm start`/`go run main.go` smoke tests, and mention any config needs (`.env`, TLS certs).
- Link to issue IDs when applicable and include before/after notes for protocol or message schema tweaks.

## Security & Configuration Tips
- Required env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `PORT` (default 5000). Never commit real keys.
- TLS: place `cert.pem` and `key.pem` in `server/` for WSS; otherwise traffic is plaintext WS.
- The Go client sets `InsecureSkipVerify` when using `wss://`; replace with verified certs for production and remove that flag.
