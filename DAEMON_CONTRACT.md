# BrowserPilot MCP Daemon + Adapter Contract

Status: contract-first specification; no production implementation is defined here.

## Assumptions

- No shared `docs/` directory currently exists, so this contract is placed at project root as `DAEMON_CONTRACT.md`.
- Existing files show the project currently uses Node.js ESM entrypoints under `host/` and a 4-byte little-endian length-prefixed JSON framing pattern.
- The confirmed architecture supersedes the current README description where the MCP server owns the TCP listener: after this change, only the daemon listens on TCP.
- The daemon listens only on `127.0.0.1:18765`.
- Claude MCP `start` is a stdio adapter process. It must not listen on any TCP port.
- The native host is a TCP client connecting to the daemon. It must not listen on any TCP port.
- npm-installed daemon lifecycle management is macOS user-level LaunchAgent management only; it must not create system-level LaunchDaemons or require root privileges.
- LaunchAgent execution must use the npm-installed CLI path resolution contract in this document, not source-tree-relative paths and not shell `PATH` lookup.
- Contract checks may inspect generated plist text and command plans, but must not execute `launchctl`, write `~/Library/LaunchAgents`, delete plist files, or start persistent services during tests.

## 1. Daemon TCP framing contract

### Transport

- Protocol: TCP.
- Bind address: `127.0.0.1` only.
- Port: `18765`.
- Server owner: `host/daemon.js` only.
- Clients:
  - `host/daemon-client.js` consumers, including `host/mcp-adapter.js`.
  - `host/native-host.js`.

### Frame format

Each daemon TCP frame is exactly:

| Offset | Size | Type | Meaning |
|---:|---:|---|---|
| 0 | 4 bytes | unsigned 32-bit little-endian integer | UTF-8 byte length of the JSON payload |
| 4 | `length` bytes | UTF-8 JSON text | One daemon protocol v1 message |

Rules:

- Length prefix includes only JSON payload bytes, not the 4-byte prefix.
- Payload must decode as UTF-8 and parse as a JSON object.
- A receiver must support fragmented TCP chunks by buffering until a full frame is available.
- A receiver must support multiple complete frames in one TCP chunk.
- A frame with invalid UTF-8, invalid JSON, non-object JSON, or an unsupported message schema is a protocol error for that connection.
- Maximum payload size is an implementation constant, but must be explicit in `host/protocol.js` and enforced symmetrically by daemon and clients.
- The contract intentionally does not use newline-delimited JSON.

## 2. Daemon protocol v1 message schemas

### Shared scalar contracts

- `protocol`: literal string `"browserpilot.daemon"`.
- `version`: literal integer `1`.
- `id`: string request/correlation id, unique per caller while outstanding.
- `clientId`: string assigned by the daemon in `hello_ack`.
- `role`: one of:
  - `"mcp_adapter"`
  - `"native_host"`
  - `"admin"`
- `toolName`: string MCP tool name.
- `toolArguments`: JSON object whose values are JSON scalars, arrays, or objects; binary data must be represented as strings.
- `result`: JSON object whose values are JSON scalars, arrays, or objects.
- `errorCode`: stable uppercase string code.
- `errorMessage`: human-readable string safe for stderr/log display.
- `details`: optional JSON object containing structured diagnostic fields.
- `timestamp`: ISO-8601 string produced by the sender.

### Message envelope variants

All messages must include `protocol`, `version`, and `type`.

#### `hello`

Sent by any TCP client immediately after connecting.

Required fields:

| Field | Type |
|---|---|
| `protocol` | `"browserpilot.daemon"` |
| `version` | `1` |
| `type` | `"hello"` |
| `id` | string |
| `role` | `"mcp_adapter" | "native_host" | "admin"` |
| `name` | string |
| `pid` | integer |
| `capabilities` | object |

Role-specific capability object contracts:

- `mcp_adapter`: `{ "tools": true }`
- `native_host`: `{ "extensionBridge": true }`
- `admin`: `{ "status": true, "shutdown": true }`

#### `hello_ack`

Sent by daemon in response to `hello`.

Required fields:

| Field | Type |
|---|---|
| `protocol` | `"browserpilot.daemon"` |
| `version` | `1` |
| `type` | `"hello_ack"` |
| `id` | string matching the `hello.id` |
| `clientId` | string |
| `daemon` | object |

`daemon` object fields:

| Field | Type |
|---|---|
| `pid` | integer |
| `host` | `"127.0.0.1"` |
| `port` | `18765` |
| `startedAt` | ISO-8601 string |

#### `tool.call`

Sent by MCP adapter to daemon for routing to the active native host / extension bridge.

Required fields:

| Field | Type |
|---|---|
| `protocol` | `"browserpilot.daemon"` |
| `version` | `1` |
| `type` | `"tool.call"` |
| `id` | string |
| `toolName` | string |
| `toolArguments` | object |
| `timestamp` | ISO-8601 string |

Routing rules:

- Daemon must reject `tool.call` from clients whose role is not `mcp_adapter`.
- Daemon must allow multiple simultaneous `mcp_adapter` clients; this is required for multiple Claude Code / Claude Desktop instances on the same machine.
- Every outstanding `tool.call.id` must be globally unique from the daemon's perspective. Adapter implementations must generate collision-safe ids rather than restarting from `1` per process.
- Daemon pending request state must map `tool.call.id` to the originating adapter client and active native host client.
- Daemon must route each `tool.result` / `tool.error` back only to the adapter that originated the matching `tool.call.id`, even if native host responses arrive out of order.
- Duplicate outstanding `tool.call.id` values must be rejected with a structured protocol error rather than overwriting an existing pending mapping.
- If an adapter disconnects, daemon must clean up only that adapter's pending requests and must not affect other adapters, the active native host, or other pending mappings.
- Daemon must route `tool.call` only to an active `native_host` client.
- If no native host is connected, daemon returns `tool.error` with code `NATIVE_HOST_NOT_CONNECTED`.

#### `tool.result`

Sent by native host to daemon, then daemon to MCP adapter, in response to `tool.call`.

Required fields:

| Field | Type |
|---|---|
| `protocol` | `"browserpilot.daemon"` |
| `version` | `1` |
| `type` | `"tool.result"` |
| `id` | string matching the original `tool.call.id` |
| `result` | object |
| `timestamp` | ISO-8601 string |

#### `tool.error`

Sent by native host or daemon when a tool call fails.

Required fields:

| Field | Type |
|---|---|
| `protocol` | `"browserpilot.daemon"` |
| `version` | `1` |
| `type` | `"tool.error"` |
| `id` | string matching the original `tool.call.id` where available |
| `error` | object |
| `timestamp` | ISO-8601 string |

`error` object fields:

| Field | Type |
|---|---|
| `code` | string |
| `message` | string |
| `details` | optional object |

Reserved daemon error codes:

- `PROTOCOL_VERSION_UNSUPPORTED`
- `PROTOCOL_SCHEMA_INVALID`
- `ROLE_NOT_AUTHORIZED`
- `NATIVE_HOST_NOT_CONNECTED`
- `MCP_ADAPTER_DISCONNECTED`
- `TOOL_TIMEOUT`
- `DAEMON_SHUTTING_DOWN`
- `INTERNAL_DAEMON_ERROR`

#### `status`

Sent by admin clients to daemon as a request, and by daemon as a response.

Request required fields:

| Field | Type |
|---|---|
| `protocol` | `"browserpilot.daemon"` |
| `version` | `1` |
| `type` | `"status"` |
| `id` | string |
| `scope` | `"summary" | "clients" | "health"` |

Response required fields:

| Field | Type |
|---|---|
| `protocol` | `"browserpilot.daemon"` |
| `version` | `1` |
| `type` | `"status"` |
| `id` | string matching request id |
| `daemon` | object |
| `clients` | object |
| `health` | object |
| `timestamp` | ISO-8601 string |

`daemon` fields:

| Field | Type |
|---|---|
| `pid` | integer |
| `host` | `"127.0.0.1"` |
| `port` | `18765` |
| `startedAt` | ISO-8601 string |

`clients` fields:

| Field | Type |
|---|---|
| `mcpAdapters` | integer count |
| `nativeHosts` | integer count |
| `admins` | integer count |
| `activeNativeHostClientId` | string or null |

`health` fields:

| Field | Type |
|---|---|
| `ready` | boolean |
| `acceptingToolCalls` | boolean |
| `lastError` | object or null |

#### `shutdown`

Sent by admin clients to request daemon shutdown, and by daemon to acknowledge it.

Request required fields:

| Field | Type |
|---|---|
| `protocol` | `"browserpilot.daemon"` |
| `version` | `1` |
| `type` | `"shutdown"` |
| `id` | string |
| `mode` | `"graceful"` |

Acknowledgement required fields:

| Field | Type |
|---|---|
| `protocol` | `"browserpilot.daemon"` |
| `version` | `1` |
| `type` | `"shutdown"` |
| `id` | string matching request id |
| `accepted` | boolean |
| `timestamp` | ISO-8601 string |

Rules:

- Only `admin` role may request shutdown.
- Graceful shutdown stops accepting new tool calls, returns `DAEMON_SHUTTING_DOWN` for new calls, resolves or rejects outstanding calls, closes client sockets, then exits.

## 3. Module-level contracts

### `host/protocol.js`

Responsibility: single source of truth for daemon framing and protocol v1 validation.

Must expose:

- Protocol constants:
  - daemon host literal: `127.0.0.1`
  - daemon port literal: `18765`
  - protocol name literal: `browserpilot.daemon`
  - protocol version literal: `1`
  - maximum frame bytes constant
- Frame encode/decode contract:
  - encode one valid protocol message into 4-byte LE length + UTF-8 JSON bytes.
  - incrementally decode zero or more complete frames from an accumulated buffer and return the remaining incomplete buffer.
- Validation contract:
  - validate every message variant listed in this document.
  - reject unsupported protocol/version/type combinations.
  - return structured validation failures using the reserved daemon error codes, not generic `Error` strings as public API.

Must not:

- Open sockets.
- Read stdin/stdout.
- Import MCP SDK.
- Import native messaging code.

### `host/daemon.js`

Responsibility: long-running daemon TCP server.

Must expose/own:

- The only TCP listener in the architecture.
- Binding to `127.0.0.1:18765`.
- Client registration through `hello` / `hello_ack`.
- Role-aware routing between MCP adapter clients and native host clients.
- Admin handling for `status` and `shutdown`.
- Pending request correlation by `tool.call.id`.
- Cleanup on socket close/error.
- Graceful process shutdown semantics.

Must not:

- Speak MCP stdio directly.
- Act as a native messaging host.
- Bind to `0.0.0.0` or any non-loopback address.
- Spawn browser processes unless a later approved contract explicitly adds that responsibility.

### `host/daemon-client.js`

Responsibility: shared TCP client helper for adapter, native host, and CLI admin commands.

Must expose:

- A connect contract requiring caller role, name, pid, and capabilities.
- Automatic initial `hello` and required `hello_ack` validation.
- Frame-based send/receive using `host/protocol.js` only.
- Request/response correlation for messages with `id`.
- Close/error lifecycle events represented as structured states.

Must not:

- Start the daemon implicitly unless a CLI contract explicitly requests daemon launch.
- Register MCP tools.
- Read or write Chrome native messaging stdio directly.

### `host/mcp-adapter.js`

Responsibility: Claude MCP stdio adapter process.

Must expose/own:

- MCP stdio server startup.
- Existing BrowserPilot MCP tool list and input schemas, preserving current tool names.
- Translation from MCP `CallTool` requests to daemon `tool.call` messages.
- Translation from daemon `tool.result` / `tool.error` messages back to MCP tool responses.
- Local diagnostic behavior for `health_check` when daemon or native host is unavailable.

Must not:

- Listen on TCP.
- Accept native host connections.
- Own daemon lifecycle except reporting daemon connection failures.

### Compatibility entrypoint: `host/mcp-server.js`

Responsibility: preserve existing command compatibility while delegating to the adapter contract.

Must expose/own:

- Existing executable entrypoint behavior for users or configs that call `node host/mcp-server.js`.
- Delegation to `host/mcp-adapter.js` as the canonical implementation boundary.

Must not:

- Retain or introduce a TCP server.
- Duplicate protocol/framing logic from `host/protocol.js`.

### `host/native-host.js`

Responsibility: Chrome native messaging host process and daemon TCP client.

Must expose/own:

- Chrome native messaging stdio framing for communication with the browser extension.
- TCP client connection to daemon at `127.0.0.1:18765`.
- `hello` registration with role `native_host`.
- Forwarding daemon `tool.call` messages to the browser extension.
- Forwarding extension responses back as daemon `tool.result` or `tool.error`.
- Reconnect behavior when daemon is temporarily unavailable.

Must not:

- Listen on TCP.
- Register MCP tools.
- Own daemon startup/shutdown lifecycle.

## 4. CLI and macOS LaunchAgent lifecycle contract

CLI commands are listed as externally visible behavior contracts only. This document does not require package metadata changes.

### npm-installed CLI path resolution contract

The LaunchAgent plist must execute the same npm-installed `browserpilot-mcp` CLI that the user invoked for installation.

Required behavior:

- Resolve an absolute CLI executable path at install time from the currently running npm package CLI invocation.
- The resolved command used in LaunchAgent `ProgramArguments` must not depend on:
  - the project source checkout location;
  - relative paths such as `./host/daemon.js`;
  - shell startup files;
  - the runtime `PATH` environment inside `launchd`.
- If the npm bin shim cannot be resolved safely, the installer must resolve an absolute Node executable plus an absolute package entrypoint and write both as explicit `ProgramArguments` entries.
- A generated LaunchAgent must be relocatable only by rerunning `browserpilot-mcp daemon install`; it must not guess future npm global prefix changes.
- The resolver must reject non-absolute executable paths for persistent LaunchAgent installation.
- The resolver must emit structured diagnostics describing which absolute executable path and arguments would be written, especially in `--dry-run` mode.
- The daemon LaunchAgent command must invoke daemon foreground mode:
  - preferred CLI form: absolute path to `browserpilot-mcp`, followed by `daemon`, `start`, `--foreground`;
  - fallback Node form: absolute path to `node`, absolute path to the package CLI entrypoint, then `daemon`, `start`, `--foreground`.

### LaunchAgent plist contract

The macOS user LaunchAgent plist must represent a user-level persistent daemon for the current user only.

Required plist fields:

| Field | Contract |
|---|---|
| `Label` | Stable literal `com.browserpilot.mcp.daemon` unless a later approved contract changes the bundle identifier. |
| `ProgramArguments` | Array of absolute executable/entrypoint paths and literal arguments; must invoke `daemon start --foreground`; must not use `/bin/sh`, `bash`, `zsh`, `env`, or shell command strings. |
| `RunAtLoad` | Boolean `true`. |
| `KeepAlive` | Boolean `true` or an explicit keep-alive dictionary with equivalent restart-on-exit behavior. |
| `StandardOutPath` | Absolute user-writable log path under the user's home directory or user log directory. |
| `StandardErrorPath` | Absolute user-writable log path under the user's home directory or user log directory. |
| `WorkingDirectory` | Optional; if present, must be absolute and must not be required for resolving package source files. |

Rules:

- The plist must not require a shell.
- The plist must not rely on `PATH` to find `node` or `browserpilot-mcp`.
- The plist must not bind or expose any public network interface; the daemon remains bound to `127.0.0.1:18765`.
- The plist target path must be user-level only: `~/Library/LaunchAgents/com.browserpilot.mcp.daemon.plist`.
- Log directories must be user-writable and created only by explicit install commands, never by read-only status or print commands.

### Safety and confirmation contract

Persistent macOS service changes are explicit side effects and must never happen during tests or read-only commands.

Commands that may modify user-level persistent state only when explicitly invoked without `--dry-run`:

- writing or overwriting `~/Library/LaunchAgents/com.browserpilot.mcp.daemon.plist`;
- creating user log directories for daemon stdout/stderr;
- executing `launchctl bootstrap`;
- executing `launchctl bootout`;
- executing `launchctl kickstart`;
- deleting the LaunchAgent plist.

Required behavior:

- `--dry-run` must print or return a complete action plan and generated plist content or plist summary without writing files, deleting files, or executing `launchctl`.
- Existing plist overwrite requires explicit `--force`; without `--force`, install must fail with a deterministic no-clobber result and must not call `launchctl bootstrap` or `launchctl kickstart`.
- Uninstall must not delete unrelated files and must only target the documented plist path.
- Uninstall `--dry-run` must report whether it would call `launchctl bootout` and whether it would delete the plist, but must perform neither action.
- Status commands must be read-only except for connecting to the local daemon/admin protocol.
- Test scripts must not execute `launchctl`, write LaunchAgents, delete plist files, or start persistent services. Tests must use dependency injection, command planning, fixture paths, or `--dry-run` contracts instead.

### `browserpilot-mcp start`

Role: start the Claude MCP stdio adapter.

Required behavior:

- Runs the stdio MCP adapter contract from `host/mcp-adapter.js`.
- Does not listen on TCP.
- Attempts to connect to the daemon as role `mcp_adapter`.
- If daemon is unavailable, MCP startup may still succeed only if tool calls return structured diagnostics; otherwise it must fail with a clear daemon connection error.

### `browserpilot-mcp daemon start`

Role: start the long-running daemon.

Required behavior:

- Starts `host/daemon.js` bound to `127.0.0.1:18765`.
- Supports `--foreground` for LaunchAgent-managed execution.
- In `--foreground` mode, does not daemonize or fork; the process remains attached for `launchd` supervision.
- Reports success only when the daemon is accepting loopback TCP connections and responding to `hello`/`status`.
- If already running, returns a deterministic already-running status instead of starting a second listener.

### `browserpilot-mcp daemon stop`

Role: request graceful daemon shutdown.

Required behavior:

- Connects as role `admin`.
- Sends `shutdown` with mode `graceful`.
- Reports whether shutdown was accepted.
- If daemon is not running, returns a deterministic not-running status.

### `browserpilot-mcp daemon status [--json]`

Role: inspect daemon and LaunchAgent state.

Required behavior:

- Connects as role `admin` when the TCP daemon is reachable.
- Sends `status` with scope `summary` by default when reachable.
- Prints daemon pid, bind address, port, uptime/startedAt, client counts, active native host presence, and readiness.
- Includes LaunchAgent-oriented state where available through read-only inspection: expected label, expected plist path, whether the plist exists, and whether daemon connectivity is healthy.
- If daemon is not running, prints deterministic not-running output and exits according to the implementation's documented CLI exit-code contract.
- With `--json`, emits a typed JSON object with at least:
  - `daemon`: object containing reachability, pid when known, host, port, readiness, and startedAt when known;
  - `launchAgent`: object containing label, plist path, plist presence, and loaded/running state when determinable without mutation;
  - `errors`: array of structured status diagnostics.

### `browserpilot-mcp daemon restart`

Role: stop then start the daemon.

Required behavior:

- Performs graceful stop if running.
- Starts daemon after stop completes.
- Reports final status using the same fields as `daemon status`.

### `browserpilot-mcp daemon install [--force] [--dry-run]`

Role: install and start the user-level macOS LaunchAgent for the npm-installed daemon CLI.

Required behavior:

- Resolves the npm-installed CLI path according to the npm-installed CLI path resolution contract.
- Generates plist content according to the LaunchAgent plist contract.
- Without `--dry-run`, writes the plist only to the documented user LaunchAgent path.
- Without `--dry-run`, starts or reloads the service using explicit LaunchAgent lifecycle actions after the plist has been written.
- Uses `launchctl bootstrap` for initial load where appropriate for the current macOS launchctl domain model.
- Uses `launchctl kickstart` or equivalent explicit launch action only after install/load planning succeeds.
- Does not require users to manually run `browserpilot-mcp daemon start` after successful install.
- Verifies daemon readiness after start by querying `daemon status` / admin protocol on `127.0.0.1:18765`.
- If readiness verification fails, reports a structured install failure including plist path, label, log paths, and next diagnostic command.
- With `--dry-run`, prints the action plan and generated plist content or summary, but must not write files, create log directories, execute `launchctl`, or start a daemon.
- Without `--force`, refuses to overwrite an existing plist and must not call launchctl after detecting the no-clobber condition.
- With `--force`, may replace the existing plist using the same safety rules and must report that replacement was explicitly requested.

### `browserpilot-mcp daemon uninstall [--dry-run]`

Role: stop and remove the user-level macOS LaunchAgent.

Required behavior:

- Targets only the documented label and user LaunchAgent plist path.
- Without `--dry-run`, unloads/stops the user LaunchAgent using `launchctl bootout` or equivalent explicit user-domain operation when it is loaded.
- Without `--dry-run`, deletes the documented plist path after unload/stop succeeds or after determining it is not loaded.
- Must not delete daemon log files unless a later approved contract adds an explicit log cleanup option.
- With `--dry-run`, prints the unload and delete plan but must not execute `launchctl` and must not delete files.
- If the plist does not exist and the service is not loaded, returns a deterministic already-uninstalled result.

### `browserpilot-mcp install --auto`

Role: perform the user-facing automatic setup flow, including daemon LaunchAgent installation/start verification.

Required behavior:

- Must include the daemon install/start/status verification flow rather than asking the user to manually run `browserpilot-mcp daemon start`.
- Must call or share the same contract path as `browserpilot-mcp daemon install`; duplicated install logic is not allowed as a public behavior boundary.
- Must use the npm-installed CLI path resolution contract for the LaunchAgent it creates.
- Must preserve existing install responsibilities not superseded by this document, such as MCP adapter configuration and native messaging manifest setup, subject to their existing contracts.
- Must verify final daemon connectivity on `127.0.0.1:18765` and report whether multiple Claude instances can connect through the daemon architecture.
- Must surface actionable diagnostics if LaunchAgent install succeeds but daemon readiness fails.
- A dry-run mode for the broader installer, if present or added later, must route daemon setup through `browserpilot-mcp daemon install --dry-run` semantics and must not mutate persistent state.

### `browserpilot-mcp launch-agent print`

Role: print configuration/instructions needed by an external launch agent or service manager.

Required behavior:

- Does not modify files.
- Prints the daemon command and lifecycle expectations.
- Must make clear that the daemon binds only to `127.0.0.1:18765`.
- Must use the same plist and CLI path resolution contracts as daemon install when printing generated LaunchAgent content.

### `browserpilot-mcp launch-agent write`

Role: legacy/manual command for writing launch-agent/service-manager configuration.

Required behavior:

- Writes only the explicitly documented launch-agent configuration target selected by the implementation.
- Must be idempotent.
- Must not alter MCP client config, native messaging manifests, browser extension files, or package metadata.
- Must print the written target path and next manual verification command.
- Must not supersede `browserpilot-mcp daemon install`; new automatic install flows must use `daemon install` as the canonical lifecycle command.

## 5. Tests/checks contract: RED first

The following checks should be added before implementation and should fail RED until the contracts are implemented. Script names are contracts; exact test framework is implementation-defined.

### `scripts/check-daemon-contract.mjs`

Verifies module boundary and CLI contract statically:

- `host/protocol.js`, `host/daemon.js`, `host/daemon-client.js`, and `host/mcp-adapter.js` exist.
- `host/mcp-server.js` remains an executable compatibility entrypoint.
- `host/mcp-server.js` and `host/mcp-adapter.js` do not create a TCP server/listener.
- `host/native-host.js` does not create a TCP server/listener.
- Only `host/daemon.js` owns daemon listen behavior.
- No module duplicates frame constants where it should import or consume `host/protocol.js`.

### `scripts/check-daemon-framing.mjs`

Verifies framing behavior:

- A protocol message encodes as 4-byte little-endian length plus UTF-8 JSON bytes.
- Decoding handles fragmented frames.
- Decoding handles multiple frames in one buffer.
- Invalid JSON and oversized payloads produce structured protocol failures.

### `scripts/check-daemon-protocol.mjs`

Verifies protocol v1 schemas:

- Accepts valid `hello`, `hello_ack`, `tool.call`, `tool.result`, `tool.error`, `status`, and `shutdown` messages.
- Rejects missing required fields.
- Rejects unsupported protocol names, versions, and message types.
- Rejects role-forbidden operations such as `tool.call` from `native_host` and `shutdown` from `mcp_adapter`.

### `scripts/check-daemon-cli.mjs`

Verifies CLI wiring contract without requiring interactive commands:

- `browserpilot-mcp start` resolves to the adapter entrypoint, not daemon server code.
- `browserpilot-mcp daemon start|stop|status|restart` resolve to daemon/admin lifecycle paths.
- `browserpilot-mcp daemon status --json` has a typed JSON contract for daemon, LaunchAgent, and structured errors.
- `browserpilot-mcp daemon install --dry-run` resolves an absolute npm-installed CLI path or absolute Node-plus-entrypoint fallback.
- `browserpilot-mcp daemon install --dry-run` produces LaunchAgent `ProgramArguments` for `daemon start --foreground` without shell usage and without relying on `PATH`.
- `browserpilot-mcp daemon uninstall --dry-run` plans only documented LaunchAgent unload/delete actions and performs no mutation.
- `browserpilot-mcp install --auto` routes daemon setup through the daemon install/start/status verification contract rather than printing manual daemon-start instructions.
- `browserpilot-mcp launch-agent print` is read-only.
- `browserpilot-mcp launch-agent write` is isolated to launch-agent configuration and does not modify package metadata or native messaging manifests.

### `scripts/check-launch-agent-plist.mjs`

Verifies LaunchAgent generation without installing or loading it:

- Generated plist label is `com.browserpilot.mcp.daemon`.
- `ProgramArguments` is an array, not a shell command string.
- `ProgramArguments` contains only absolute executable/entrypoint paths where paths are required, plus literal arguments.
- `ProgramArguments` invokes `daemon start --foreground`.
- Generated plist has `RunAtLoad` enabled.
- Generated plist has `KeepAlive` enabled or an equivalent explicit keep-alive dictionary.
- Generated plist contains absolute stdout/stderr log paths in a user-writable location.
- Generated plist does not contain `/bin/sh`, `bash`, `zsh`, `/usr/bin/env`, shell metacharacter command strings, source checkout-relative paths, or dependency on `PATH`.

### `scripts/check-daemon-install-safety.mjs`

Verifies daemon install/uninstall safety through dry-run and fixture planning only:

- `daemon install --dry-run` does not write the LaunchAgent plist, create log directories, execute `launchctl`, or start a daemon.
- `daemon install --dry-run` prints or returns the planned plist path, label, ProgramArguments, launchctl actions, and readiness check.
- Existing plist with no `--force` produces deterministic no-clobber behavior and plans no bootstrap/kickstart action.
- Existing plist with `--force --dry-run` reports replacement intent without writing.
- `daemon uninstall --dry-run` plans bootout/delete for only the documented label/path and performs no mutation.
- Already-uninstalled dry-run returns a deterministic already-uninstalled result.
- Tests use fixture paths, injected command runners, or command plans; tests must fail if real `launchctl`, real `~/Library/LaunchAgents` writes, or real plist deletion are attempted.

### `scripts/check-daemon-multi-adapter.mjs`

Verifies multi-Claude concurrency behavior using a test port:

- Two independent `mcp_adapter` clients can connect to one daemon simultaneously.
- A fake `native_host` receives both adapters' `tool.call` messages with collision-safe ids.
- Fake native host returns responses in reverse/交错 order.
- Each adapter receives only its own matching `tool.result`.
- Disconnecting one adapter does not break another adapter's later request routing.

### `scripts/check-daemon-integration.mjs`

Verifies loopback-only integration behavior after implementation:

- Daemon binds to `127.0.0.1:18765`.
- MCP adapter connects as `mcp_adapter` and does not listen.
- Native host connects as `native_host` and does not listen.
- A `tool.call` from adapter is correlated to exactly one `tool.result` or `tool.error`.
- `status` reports client counts and readiness accurately.
- `shutdown` performs graceful termination.

## Implementation guardrails for the next agents

- Implement `host/protocol.js` first, then write daemon/client code against it.
- Do not move TCP listening back into `host/mcp-server.js` or `host/mcp-adapter.js`.
- Do not make native host a server.
- Do not change `package.json` until CLI contract implementation is explicitly approved.
- Preserve current MCP tool names and schemas unless a separate contract approves tool changes.
- Keep all daemon traffic loopback-only.
- Add RED checks before implementation, then make them pass with minimal production changes.
- Implement LaunchAgent command planning as a testable boundary before invoking filesystem or `launchctl` side effects.
- Keep `browserpilot-mcp daemon install` as the canonical daemon lifecycle installer; `browserpilot-mcp install --auto` should call/share that boundary.
- Never execute `launchctl`, write `~/Library/LaunchAgents`, delete plist files, or start persistent services from contract tests.
