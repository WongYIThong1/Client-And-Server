# Repository Guidelines

## Project Structure & Module Organization
- `server/`: Node.js WebSocket gateway; entry `index.js`; Supabase helper `supabase.js`; runtime config from `.env` (copy `config.example.txt`).
- `client/`: Go WebSocket client; entry `main.go`; module metadata in `go.mod`.
- Logs/build artifacts are untracked; keep secrets (`.env`, `cert.pem`, `key.pem`) out of git.

## Build, Test, and Development Commands
- `cd server && npm install`: install server dependencies.
- `npm start`: start WS server; drop `cert.pem`/`key.pem` beside `index.js` to enable WSS automatically.
- `npm run dev`: watch mode for server.
- `cd client && go mod download`: fetch Go dependencies.
- `go run main.go` or `go build -o client main.go && ./client`: run client; provide valid API key when prompted.
- Manual integration: start server then client; expect `auth_success`, periodic `ping/pong`, and echoed `data` messages.

## Coding Style & Naming Conventions
- Server: ES modules, 2-space indentation, prefer `const`/`let`, trailing semicolons. JSON messages shaped `{ type, message, data }`; reuse type values (`auth`, `auth_success`, `auth_failed`, `ping`, `pong`, `data`, `error`).
- Client: `gofmt` clean; exported names PascalCase, locals camelCase; extend `Message` struct fields instead of ad-hoc maps.

## Testing Guidelines
- No automated suite yet. Place Node tests under `server/tests/`; Go tests beside sources as `*_test.go`.
- Cover auth handshake, heartbeat (`ping/pong`), and invalid-token rejection. Document any flaky network-dependent tests.

## Commit & Pull Request Guidelines
- Commits: short, imperative subjects (e.g., "Add heartbeat timeout", "Handle invalid token"); group related changes.
- PRs: describe behavior change, include run results for `npm start` / `go run main.go`, note config needs (env vars, TLS certs), link issues when applicable, mention protocol or schema tweaks.

## Security & Configuration Tips
- Required env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `PORT` (default 5000). Never commit real keys.
- TLS: place `cert.pem` and `key.pem` in `server/` for WSS; otherwise traffic uses plaintext WS.
- Go client sets `InsecureSkipVerify` for `wss://`; replace with verified certs and remove that flag in production.
