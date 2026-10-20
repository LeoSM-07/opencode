# Multiplayer manual test plan

## Run the fork

Use a disposable project: room guests can see the shared transcript, including agent tool output, and can ask the host's agent to work in its workspace.

Both the host server and TUI must run this fork. An installed background server from before these changes will not have the multiplayer RPC.

- If the elected background service already runs this fork, use `bun run dev:live /path/to/project` from the repository root.
- Otherwise use `bun run dev /path/to/project --standalone` for an independent development server/TUI without replacing your existing background service. Start another standalone TUI in a second terminal or on another machine for the guest.
- Configure a working model on the host. The guest uses the host's model and credentials, not its own.
- Hosting sets up an OpenTunnel device tunnel if needed. It needs network access and may take a minute on first use. No separate gateway process is required.

## Happy path

1. Select a model and variant in the host TUI, run `/host`, enter a name, and select a color. Check that a **new** native session opens with that selection saved and the invite URL appears. `/invite` shows it again. The color picker should show named color swatches.
2. Send a message before anyone joins, and wait for the assistant's reply.
3. In the guest TUI, first open a local session and several tabs. Run `/join <invite-url>`, enter a different name, and choose the same color as the host deliberately.
4. Verify the guest sees the earlier messages and response, not just new events. The guest's local tabs should be hidden rather than modified. `/room` should show both members online with distinct assigned colors.
5. Send prompts from both terminals, including while the assistant is working. Verify the normal transcript, streaming, queue/steer delivery, tool output, and participant labels. The host's agent/model remains selected.
   Also test a fresh room where the **guest sends first**: the model and variant should already match the host's selection. Host labels should use `(host)`, and each message border should match its author's name color.
6. Type without submitting in either terminal. The other terminal should show the correct person's typing indicator. Clear the composer and verify it stops; stop typing and verify it expires after about four seconds.
7. Trigger a permission request or question with the host's agent. Only the host should be able to approve/reply. Guest attempts to interrupt, switch the shared model, run shell commands, or mutate sessions should fail, without changing the host.
8. Have the agent spawn a child session. Check that guests can open that child and see its updates, but cannot open unrelated host sessions.
9. Run `/leave` as the guest. Verify the original local session, tabs, and local connection return. Send a local prompt to confirm it goes to the guest's server, not the room.
10. Join again, then run `/stop` as the host. Verify guests return to their local connection automatically and the invite no longer works. The host's session/history should remain readable locally.

## Failure and cleanup

- Bad invite, invalid name, and canceled dialogs: remain on the original connection with no half-joined room.
- Tunnel setup failure: `/host` reports an error, releases its gateway/route, and allows another attempt. A newly created empty local session may remain.
- Brief guest network interruption: presence shows offline, then reconnects; transcript resynchronizes without duplicated messages. Reconnect within 30 seconds; after the offline grace expires, use `/leave` and join again for a new token.
- Host server termination: guest shows disconnected state, and `/leave` still restores its local connection even when the host is unreachable.
- Host TUI exit with its background server still running: the room remains available. A new host TUI can run `/host` in the same location to recover the active room.
- Keep a room active through OpenTunnel for at least five minutes, including a quiet interval and a network interruption. Check that SSE and presence both recover. This live tunnel test is not covered by the local automated tests.
- Resize narrow/wide and switch light/dark/custom themes, including a custom theme with fewer categorical colors. Participant labels should remain readable without affecting ordinary local messages.

## Current scope

- Eight participants including the host; invites expire after one hour. Offline guests expire after 30 seconds.
- Only normal prompts and inline attachments are supported for guests. File references, workspace browsing endpoints, arbitrary commands/RPC, terminals, and shared controls are intentionally not exposed by the gateway.
- Rooms are in-memory and location/plugin scoped; server restart or plugin unload ends access. History remains a normal host session.
- No custom transcript, separate per-person model context, durable presence, or multi-server tabs.

## Automated checks

Run tests from their package directories:

```sh
# packages/multiplayer
bun test

# packages/client
bun test test/solid-connection.test.ts test/solid-data.test.ts

# packages/server
bun test test/process.test.ts

# packages/tui (real join dialogs and native composer submission)
bun test --timeout 30000 test/multiplayer-send.test.tsx

# repository root
bun run check
```

The gateway tests exercise real loopback HTTP/WebSockets, invite exchange, attribution spoofing, route denial, location pinning, token revocation, SSE filtering, and catalog credential removal. Client tests cover replacing/restoring streams and isolation of colliding message/session IDs.
