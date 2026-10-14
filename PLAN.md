# ompi — desktop app for omp

This is a desktop front end for [omp](https://omp.sh), built with Nuxt 4, Nuxt UI 4 and Tauri 2. It has one window with:

- a tab strip,
- one sidebar shared by every tab,
- a ⌘K command palette.

Each open session tab drives its own `omp --mode rpc-ui` process, owned by Rust. omp's RPC doesn't expose plan mode, branching within a session file, or editing assistant messages. ompi gets those through a small extension, **the bridge**, which it loads into its own omp processes.

ompi needs omp 18.8.9 or later. Everything here was tested on the installed 18.8.9. The latest release, v18.10.3, has the same RPC command set (I diffed `modes/rpc/wire/commands.ts`). macOS comes first, but nothing in the core is macOS-only.

## 1. What I tested

Every observation below ran against omp 18.8.9 with local Ollama `gemma4:latest` (no API cost), in throwaway directories, unless the text says it comes from omp's source or binary. Anything not yet tested is listed under the P0 spikes.

### Protocol

| Observation | What it means for the design |
|---|---|
| `rpc-ui` sends tool approvals as an `extension_ui_request` of type `select`. The title is `Allow tool: bash\nCommand: …` and the options are `Approve`/`Deny`. Plain `rpc` has no UI, so those calls fail. The request carries no `toolCallId`; it arrives right after that call's `tool_execution_start`. | Use `rpc-ui`. Attach each approval to the newest running call of the same tool. A bar listing pending approvals is the fallback. |
| omp watches `--config` overlay files in RPC modes. Rewriting one mid-session switched `yolo` to `always-ask`. Adding `tools.approval.bash: allow` to a second overlay stopped bash prompts. | Access scopes are overlay files that ompi owns. Never pass `--approval-mode` or `--yolo`: launch flags beat overlays and would block live switching. |
| `get_available_models` returns 1.62 MB (576 models). Protocol v1 fails with "RPC response exceeded the transport limit". v2 delivers it as 7 `rpc_chunk` frames. | Negotiate v2, reassemble chunks strictly, and fetch the model catalog once per app launch. |
| An undocumented setting, `set_event_filter {messageUpdates:"delta"}`, makes each `message_update` carry only the new text. By default omp resends the whole partial message every time. | Use delta mode. Build text from the deltas, then replace it with `message_end`. |
| `set_ask_dialog {enabled:true}` makes the `ask` tool send `{method:"ask", questions:[{id, question, options:[{label}]}]}`. Replying `{type:"extension_ui_response", id, answers:[{id, selectedOptions:["Blue"]}]}` produced the tool result "User selected: Blue". | Render `ask` as a form. Plan mode uses it for clarifying questions. |
| RPC modes don't generate session titles. Sending `/rename` as a prompt produced a title and a `session_info_update`. | Send `/rename` after the first turn. |
| `--resume <file>` restores the session's own model. A process is ready in about 0.2 s and idles at about 363 MiB with your MCP servers loaded. | Don't pass `--model` when resuming. Stop idle processes and resume them on demand. |
| `get_entries` returns every entry (`type`, `id`, `parentId`, `timestamp`, payload) plus `leafId`. `get_entries {since:id}` returns only newer entries; omp's source returns error code `unknown_since` if that id no longer exists. `get_messages` has no entry ids. | Build both the transcript and the graph from entries. Edit, fork and goto all need entry ids. |
| In a session file, line 1 is a 256-byte title record and line 2 is the header (`id`, `cwd`, `timestamp`, plus `parentSession` for forks). Session artifacts, including plan files, live in `<session-file-stem>/local/`. | The sidebar index reads two lines per file. Rust reads plan files straight from disk. |
| Edit-tool results include `details.diff` (`-5\|old`, `+5\|new`). | The diff card renders `details.diff` directly. |
| `@notes.txt`, `@red.png` and `@"my docs/note one.txt"` in a prompt are read by omp and injected as a `fileMention` message. The model answered correctly from both the text and the image. | Dropped files are sent as `@"path"` mentions. omp handles reading, size limits (5 MB for text, 25 MB for images) and image resizing. |
| A base64 PNG in `prompt.images` works. | Pasted images, which have no file path, go in `images`. |
| RPC prompts aren't added to omp's `history.db`. Extension slash commands aren't written to the session file. | The bridge's `/ompi …` commands leave no trace in TUI history or in transcripts. |

### What RPC lacks, and how ompi covers it

| Need | What RPC offers | ompi's approach (tested) |
|---|---|---|
| Plan mode | `/plan` and `/plan-review` are TUI-only, still true in v18.10.3. Sent over RPC, `/plan` reaches the model as plain text. ACP implements plan mode by calling `setPlanModeState` and `setPlanProposalHandler` on the live session. | The bridge reaches the live session through `pi.pi.AgentRegistry.global()` (agent kind `main`) and makes the same calls as ACP and the TUI. In the full test:<br>• omp injected its plan-mode instructions.<br>• A write to the working tree was refused ("Plan mode: the working tree is read-only…").<br>• The model wrote `local://add-hello-plan.md` and proposed it through `xd://propose`.<br>• Refine made it revise and re-propose.<br>• Approve turned plan mode off. |
| Edit a user message and resend it | `branch {entryId}` works, but every call moves the session to a **new file** (its header's `parentSession` points to the old file). | Bridge `ctx.navigateTree(entryId)` stays in one file. After resending, `get_tree` showed `apple → {banana, cherry}` as sibling branches. |
| Edit an assistant message's text | Nothing | The bridge writes an edited copy as a sibling with `sessionManager.appendMessageToBranch` and moves the session's current position (the leaf) to it. On the next turn the model quoted the edited text. |
| Structured context breakdown | `/context` returns text only | The bridge calls omp's `computeSessionContextBreakdown`. Extensions can only import omp internals with literal module names; `import(variable)` fails. |

**A gap in omp itself:** plan mode doesn't disable `bash`. With your global `yolo` mode, `touch made-by-bash.txt` ran during planning. omp's plan guard only blocks write and edit, and the TUI's plan-mode entry code (`interactive-mode.ts`) keeps the previous tool set apart from adding `write`. ompi tightens this (§4.9).

### Slash commands

`get_available_commands` lists 71 commands on your setup. Each has a `source` (builtin, skill, extension, custom, mcp_prompt or file), a `description`, an `input.hint` and `subcommands`.

omp 18.8.9 has 85 builtin commands:

- **45 run over RPC and are advertised:** `add-dir advisor browser changelog compact computer context dirs dump effort export extended-context fast force fresh handoff jobs marketplace mcp memory model modelpreset move pin plugins prewalk ratchet reload-plugins remove-dir rename retry security session shake share skillful slow ssh stats switch todo tools trace usage wt`.
- **40 are TUI-only.** Sent over RPC, they reach the model as plain text.

## 2. Architecture

```
┌─ Tauri / Rust ───────────────────────────────┐          ┌─ Webview (Nuxt SPA, one window) ─────────────┐
│ omp host: one process per open session tab  │  invoke  │ shell: tab strip · sidebar · ⌘K palette       │
│  spawn omp --mode rpc-ui [--resume <file>]   │◀─────────│ tab kinds: empty · session · settings · …     │
│        -e <bridge.ts>                        │          │ session tab: transcript · composer ·          │
│        --config ws-<id>.yml --config run.yml │ Channel  │              side panel (graph · context)     │
│  ready → v2 → delta filter → ask dialog      │─────────▶│ useSession(handle): entries + live overlay    │
│  line reader, chunk reassembly, stdin queue  │  events  │ useActions(): palette · shortcuts · menus     │
│  pending dialogs (resent when a tab attaches)│─────────▶│                                               │
│  status events · idle reaper · clean quit    │          │                                               │
│ session index · overlay files · plan reads   │          │                                               │
└──────────────────────────────────────────────┘          └───────────────────────────────────────────────┘
```

- **Connection: `rpc-ui`.** The SDK runs inside a Bun process and the webview isn't Bun, so using it means a Bun side process — which is RPC again. ACP doesn't load your omp MCP config and doesn't send omp-specific events (todos, queues, subagents, goal).
- **Rust owns the processes.** They survive webview reloads. Rust keeps unanswered dialogs and resends them when a tab attaches, because a lost approval stalls the turn forever. On quit, Rust closes each stdin so omp shuts down cleanly.
- **Process identity.** Each process is keyed by a handle Rust assigns, not by a session id. `new_session`, `fork` and "approve in new session" move a running process to a different session file, so the host re-reads `get_state.sessionFile` after those commands.
- **omp binary:** your installed omp (path can be overridden in settings). That keeps your logins, config, MCP servers and sessions.
- **Storage:** omp's session folder is the only database. ompi stores only tabs, workspace preferences (plugin-store) and overlay files.
- **Frontend state:** per-tab composables plus Rust status events. No Pinia.

## 3. App shell

### Tabs

- A tab is `{ id, kind, params }`. `kind` looks up an entry in a registry, `{ component, title(params), icon(params) }`. Adding a new kind means adding one entry.
- **Kinds in v1:**
  - `empty`: a new tab.
  - `session`.
  - `settings`: the first non-session kind; it checks that the registry really works for more than sessions.
  - Later kinds just add entries: plan document, diff, file preview, usage dashboard.
- **New tab (⌘T)** opens `empty`, which shows recent sessions, workspaces and "New session in…". Choosing one turns the tab into a session tab in place.
- **One tab per session.** Opening a session that's already open focuses its tab.
- **Persistence:** tabs are saved with plugin-store and restored on launch. A session tab attaches when activated and resumes the session if its process was stopped.
- **Rendering:** tab content stays mounted with `<KeepAlive :max="8">`. Background tabs keep their process until the reaper stops it (§4.5).
- **Placement:** the tab strip sits in the overlay titlebar, which decorum already provides, padded for the traffic lights and marked `data-tauri-drag-region`.
- **Badges:** a streaming spinner, a needs-input dot and a plan badge.
- **Keys:** ⌘T new, ⌘W close, ⌘1–9 jump, ⌃Tab / ⌃⇧Tab cycle, ⌘⇧T reopen the last closed tab.

### Sidebar, workspaces, sessions

- **Sidebar:** a `UDashboardSidebar` (collapsible, resizable) shared by all tabs.
  - It lists workspaces, each with its sessions newest first. Forks nest under their `parentSession`.
  - Live badges come from `omp:status`.
  - Clicking a session opens it in the active tab if that tab is empty; otherwise it focuses or opens a tab.
  - Each session's context menu has: open in new tab, rename, fork, delete, reveal in Finder.
- **Workspaces:**
  - A workspace is a folder plus optional extra folders, passed with `--add-dir`. Each has a default scope and model.
  - The list combines project folders found in the session store with folders you add. All your existing sessions appear on day one.
  - Dropping a folder on the sidebar adds it as a workspace.
- **Session index:** Rust scans `<agentDir>/sessions/*/*.jsonl`, reading two lines per file, and watches the folder. `omp config path` gives `agentDir`.
- **Same session open in the TUI:** according to a message in omp's binary (not tested), if a session is already open in another omp process, omp saves into a new file. After every resume, ompi compares `get_state.sessionFile` with the file it opened, and shows a "continued in a copy" banner if they differ.
- **Delete:** with the session closed, ompi removes `<stem>.jsonl` and `<stem>/` after you confirm.

### Command palette and actions

- **One action list:** `useActions()` feeds three things:
  - the palette (`UDashboardSearch`, ⌘K, fuzzy search, nested children),
  - keyboard shortcuts (`defineShortcuts`),
  - context menus.
- **Action shape:** `{ id, label, icon, kbds?, group, when(ctx), run(ctx) | children(ctx) }`. `ctx` holds the active tab and its session.
- **Groups:**

  | Group | Actions |
  |---|---|
  | Tabs | New tab, close, switch |
  | Sessions | New session in workspace…, Open session…, Fork, Rename, Delete, Restart process |
  | Session | Plan mode, Review plan, Compact, Export, Share, Abort, Copy last answer |
  | Model, Thinking, Scope | Nested pickers |
  | Slash commands | Generated from the command list (§4.10) |
  | Workspaces | Add folder, Defaults |
  | App | Settings, Toggle sidebar, Toggle side panel, Theme |

## 4. Session tab

### 4.1 Transcript

- **Data source:** entries on the active path, walked from `leafId` back to the root, so every rendered message has its entry id.
- **Live updates:** streaming events build the in-progress messages. On `turn_end`/`agent_end`, ompi fetches `get_entries {since}` and drops the live copies. After any navigation or edit it refetches.
- **Rendering:**
  - **Container:** `UChatMessages`.
  - **Markdown:** rendered with Comark.
  - **Thinking:** in `UChatReasoning`.
  - **Tool calls:** each is paired with its result by id and shown in a `UChatTool` card. There are specific cards for bash, edit (diff), write, read/grep and ask, plus a generic JSON card.
  - **Attached files:** `fileMention` messages render as file chips on the user message.
  - **Session events:** compaction, model changes and mode changes render as inline dividers.
- **Extension frames:**
  - `setStatus` shows as status chips with ANSI colour codes stripped.
  - `notify` shows as toasts, except bridge replies that start with `ompi:`.
  - `setWidget` shows as blocks.

### 4.2 Composer

- Enter sends, or steers the current turn while it's streaming. ⌘Enter queues a follow-up. Esc aborts.
- Queued messages show in a strip above the composer, each removable (`remove_queued_message`).
- **Footer controls:** model, thinking level, scope, Plan toggle, attach button, context meter.
- **Also:** `/` autocomplete (§4.10) and file drop (§4.6).

### 4.3 Dialogs

- **Approvals:** shown on the matching tool card using `UChatTool`'s `actions`.
- **Questions:** `ask` renders as a form card.
- **Other dialogs:** `select`, `confirm`, `input` and `editor` show as modals that honour timeouts. A `cancel` request closes the matching dialog.
- **Background alerts:** a native notification when the window isn't focused.

### 4.4 Scopes and approvals

| UI label | omp mode | Runs without asking | Asks first |
|---|---|---|---|
| Always ask | `always-ask` | reads | edits/writes, commands, browser, eval, `task` |
| Write | `write` | reads, edits/writes | commands, browser, eval, `task` |
| Full access | `yolo` | everything | only tool and provider safety checks |

- **Two overlay files per process:**
  - `ws-<id>.yml` holds the workspace's per-tool allow/deny rules and is shared by all its sessions.
  - `run-<key>.yml` holds this session's mode and is loaded second, so it wins.
  - Rust writes both (temp file then rename). The content is JSON, which is valid YAML.
- **Precedence:** the session's mode beats your global and project config. A project's per-tool `deny` rules still apply because omp merges these settings.
- **Approval buttons:** Approve, Deny, and "Always allow `<tool>` in this workspace". The last one writes the workspace overlay, then approves.
- **Caveat:** once you approve a `task` call, its subagents run without prompts.

### 4.5 Models, thinking, lifecycle

- **Catalog:** fetched once per app launch, with a refresh button.
- **Picker:** a `USelectMenu` with `virtualize`, grouped by provider and searchable. Badges show reasoning, image input, context window and price.
- **Thinking level:** options come from `get_available_thinking_levels`.
- **Applying a choice:** `set_model` and `set_thinking_level` change the current session. The workspace default is passed as `--model` for new sessions only.
- **Usage display:** a context meter from `contextUsage`, and cost from `get_session_stats`.
- **Idle reaper:** a process is stopped when all of these hold for 10 minutes: the session is settled, no dialog is pending, and its tab isn't active. Reactivating the tab resumes the session in about 0.2 s and restores plan mode.

### 4.6 Attachments

- **Drop files:** use `getCurrentWebview().onDragDropEvent`. Tauri intercepts drops and passes absolute paths. Drop zones highlight on `enter`/`over`, found by hit-testing the drop position.
  - Files dropped on a session tab become composer chips.
  - Folders dropped on the sidebar become workspaces.
- **Attach button:** a dialog-plugin file picker that allows multiple files.
- **On send:** each chip becomes `@"<path>"`. The path is relative to the session folder when the file is inside it, absolute otherwise. omp reads the files, and directories, at send time.
- **Pasted images:** the clipboard image is converted to base64 and sent in `images`.
- **Not in v1:** `@` filename autocomplete.

### 4.7 Editing and branches

- **Editable:** user messages (text and attachments) and the text blocks of assistant messages.
- **Not editable:** thinking, tool calls, tool results, and system or extension messages.
- **User message: Edit & resend.**
  - The bridge's `goto(userEntryId)` moves the leaf to that message's parent.
  - ompi then sends `prompt(newText, images)`.
  - The old answer stays as a sibling branch.
- **Assistant message: Edit.** The bridge's `editAssistant(entryId, texts)`:
  - writes a sibling copy with the edited text blocks;
  - keeps the thinking and tool-call blocks;
  - drops `providerPayload`, `responseId` and `textSignature`, which describe the original text;
  - re-attaches the message's tool results under the copy so tool calls stay paired with their results;
  - moves the leaf to the copy.
  
  Later messages stay on the old branch.
- **On every message:**
  - **Copy.**
  - **Fork from here:** RPC `fork {entryId}`. Like the TUI, the tab moves into the new session file and the original stays in the sidebar.
  - **Continue from here:** `goto`.
  - **Retry** (user messages): `goto`, then resend the same text.
- **Branch switcher:** messages whose entry has siblings show `‹ 2/3 ›`. Switching does a `goto` to the newest entry in the chosen sibling's subtree.
- **While streaming:** edits need an idle session, so the edit button offers "Stop and edit", which aborts first.

### 4.8 Side panel: context graph

- **Panel:** toggled with ⌘\, resizable, on the right of the session tab. It has two tabs: **Graph** and **Context**.
- **Graph:**
  - Rows come from the entry tree, laid out like `git log`: a straight chain stays in one column and each sibling branch indents one level, the same compression as the TUI's `/tree`.
  - **Node types:**
    - user message;
    - assistant message (first line);
    - each tool call, with status, duration and error;
    - thinking marker;
    - compaction;
    - model or thinking change;
    - mode change (plan on/off);
    - branch summary;
    - label.
  - The active path is highlighted. A filter switches between Conversation and All.
- **Interaction:** clicking a node scrolls the transcript to it, or previews it if it's off the active path. Each node's menu has: Continue from here, Fork from here, Edit, Label (bridge `label`), Copy.
- **Data:** the graph is a virtualized list (`useVirtualList`) fed by the same entries store as the transcript.
- **Context tab:** a stacked bar from the bridge's `context` op (system prompt, tools, skills, messages, auto-compact buffer, free), falling back to `contextUsage`. It also has a Compact button with optional instructions.

### 4.9 Plan mode

- **Entering:** the composer's Plan toggle, the palette, or typing `/plan [prompt]`. Disabled while goal mode is active or a turn is streaming.
- **What the bridge's `plan.enter` does:**
  - sets `{enabled:true, planFilePath:"local://PLAN.md", workflow:"parallel", reentry}`;
  - makes sure `write` is active, since plan files and `xd://propose` need it;
  - installs `preparePlanForReview` as the proposal handler, like the TUI;
  - appends a `mode_change` entry, like the TUI.
- **While planning:**
  - Plan badges show on the tab and the composer.
  - The scope is clamped to **Write** at most: bash, eval, browser and `task` ask first even if the session is on Full access, because omp's guard doesn't cover bash.
  - The original scope comes back when plan mode ends.
- **When the model proposes a plan:**
  - It writes the plan's slug to `xd://propose`, and the handler validates the plan.
  - The turn ends, and ompi sees the `xd://propose` tool result (`details.planFilePath`).
  - ompi reads `<stem>/local/<slug>-plan.md` from disk and opens a **Plan review** panel showing the rendered markdown.
- **Review options** (the same as the TUI's):

  | Option | What happens |
  |---|---|
  | **Approve** | Bridge `plan.approve` runs: `setPlanReferencePath`, plan mode off, `mode_change none`. ompi then prompts "Implement the approved plan." in this session. |
  | **Approve in new session** | `plan.approve`, then `new_session`, then a prompt containing the plan text. |
  | **Approve & compact** | `plan.approve`, then `compact {customInstructions}` focused on the plan, then the implementation prompt. |
  | **Refine** | Plan mode stays on. Your comments are sent as the next prompt. |
  | **Save plan…** | A save dialog, then `plan.exit`. Nothing is executed. |
- **Leaving without approving:** turn the toggle off, which runs bridge `plan.exit` and appends `mode_change none`.
- **Restoring:** when a session opens, the last `mode_change` on the active path decides whether to re-enter plan mode. This also picks up plans started in the TUI.
- **Fallback:** if the `xd://propose` result turns out not to expose the plan path (P0 spike), the handler opens the review through `ctx.ui.select("ompi:plan-review {…}")` instead. That variant is the one I tested.
- **Not in v1:** switching to the `modelRoles.plan` model while planning.

### 4.10 Slash commands

Typed commands come first because they're the cheapest: the 45 RPC builtins, skills, and extension/custom/MCP commands already run over RPC.

1. **Typed in the composer:**
   - `/` opens autocomplete from `get_available_commands`, refreshed on `available_commands_update`, with subcommands and `input.hint`.
   - The command is sent as a normal prompt. Its `command_output` shows as a system message, and `agentInvoked:false` or `prompt_result` ends it.
   - TUI-only names are intercepted. GUI-native ones run the matching ompi action (table below). The rest show "only available in the omp TUI" instead of reaching the model.
   - `/ompi` is reserved for the bridge.
2. **Palette:** every advertised command becomes a palette item grouped by source. Subcommands become children. Commands with an `input.hint` open a one-line argument prompt.
3. **Dedicated controls** for the frequent ones:

   | Commands | Control |
   |---|---|
   | model, switch, effort | Pickers |
   | compact, context | Side panel |
   | rename | Tab title |
   | export, share | Session menu |
   | retry | Button on a failed turn |
   | fast, slow | Toggles |
   | session info | Popover |
   | pin, move | Session menu |
   | add-dir, dirs, remove-dir | Workspace folders |
   | usage | Usage view |

**TUI-only commands in ompi:**

| TUI command | In ompi |
|---|---|
| `/new` | New session (palette, sidebar, ⌘N) |
| `/resume` | Sidebar, or "Open session…" |
| `/tree` | Side panel graph |
| `/branch`, `/rewind` | Edit, Continue from here |
| `/fork` | Fork from here (RPC `fork`) |
| `/plan`, `/plan-review` | Plan mode (§4.9) |
| `/queue` | ⌘Enter follow-up |
| `/copy`, `/open` | Copy buttons; links open through the opener plugin |
| `/settings`, `/hotkeys` | Settings tab; shortcuts shown in the palette |
| `/login`, `/logout` | Settings → Providers (RPC `login`, `logout`), in P10 |
| `/delete` | Delete session (sidebar menu) |
| `/restart` | Restart process |
| `/quit`, `/exit` | Close tab, quit app |
| `/goal`, `/btw`, `/loop` | Later. RPC `goal` and `btw` exist; loop would be done in ompi itself |
| `/clear`, `/vibe`, `/hub`, `/agents`, `/collab`, `/join`, `/leave`, `/live`, `/record`, `/git`, `/debug`, `/extensions`, `/skills`, `/setup`, `/pause`, `/omfg`, `/tan`, `/cleanse`, `/guided-goal` | Not planned. Typing them shows "TUI only" |

## 5. Bridge extension

`src-tauri/resources/ompi-bridge.ts`, loaded with `-e` on every spawn. omp runs TypeScript directly.

- **How requests travel:**
  - The host sends the prompt `/ompi <base64url JSON {req, op, …}>`.
  - The bridge replies with `ctx.ui.notify("ompi:" + JSON {req, …})`.
  - RPC then sends `prompt_result {agentInvoked:false}`. I saw this order: ack, then notify, then `prompt_result`.
- **Operations:**
  - `hello`: version, plus capability flags saying which internal functions exist.
  - `plan.enter`, `plan.approve`, `plan.exit`.
  - `goto {entryId}`.
  - `editAssistant {entryId, texts}`.
  - `label {entryId, label?}`.
  - `context`.
- **omp internals used:**
  - `pi.pi.AgentRegistry`;
  - `session.{getPlanModeState, setPlanModeState, setPlanProposalHandler, preparePlanForReview, setPlanReferencePath, setActiveToolsByName}`;
  - `sessionManager.{getEntry, appendMessageToBranch, appendModeChange}`;
  - `ctx.navigateTree`;
  - `sessionManager.appendLabelChange` (`pi.setLabel` is a no-op in RPC mode on 18.8.9: it reported success but wrote nothing);
  - `computeSessionContextBreakdown`, imported with a literal module name.
- **Missing functions:** if one is missing, its capability flag is false and ompi hides that feature.
- **Upstream:** if omp adds RPC commands for plan mode, tree navigation and message edits, each bridge operation can be deleted. omp is MIT-licensed and accepts PRs.

## 6. Phases

### Status (first implementation pass)

Built: P0–P5 and P7–P9 end to end, plus most of P6 and P10 (details below). Verified in the real Tauri app on omp 18.8.9 with local `gemma4`, and in Chromium against real omp processes:

- **Host (P1):** sessions start through the Rust host; a bash approval arrives and completes; after a webview reload the tab reattaches to the same process (no duplicate omp), and an approval that was pending during the reload is replayed and still completes. Stale run overlays from a crash are swept at startup.
- **Shell (P2):** tabs, sidebar (all local sessions, titled from the first prompt when omp never titled them), ⌘K palette with tab, session, slash-command and app groups. App shortcuts work while typing in the composer.
- **Session view (P3):** streaming, tool cards with diffs, `/context` output, TUI-only commands intercepted (`/tree` opens the graph, `/vibe` shows "TUI only" and never reaches the model).
- **Plan mode (P7):** Plan toggle → model writes and proposes a plan → the turn stops at the proposal (like the TUI) → review panel renders the plan file → Approve implements it (`hello.txt` created). bash still asks first while planning.
- **Editing (P8):** edit & resend creates a sibling branch in the same file; `‹ 1/2 ›` switches between answers. Assistant edits are verified at the bridge level (the next turn quotes the edited text).
- **Graph (P9):** entry tree with the active path highlighted and abandoned branches indented.

Not yet exercised in the UI: file drag-and-drop and paste (P6, wired but only the `@` mention path was verified against omp), provider login/logout in Settings (P10), and the "Approve in new session" / "Approve & compact" plan options.

Corrections found while building, now in the code:

- `navigateTree` on a **user** message rewinds to just *before* it, so edit & resend targets the message itself, and "Continue from here" on a user message walks to the end of its reply.
- omp inserts a hidden `custom_message` before each prompt, so branch siblings are found through hidden entries, not by direct parent.
- The `xd://propose` result nests the plan under `details.xdev.inner`.

Each phase ends with a smoke test on local `ollama/gemma4:latest --thinking off`, which is free. Tests that need tool calls use directive prompts ("Call the write tool with …"), because gemma4 sometimes answers in prose. P0–P5 give a usable daily driver. P6–P10 add the remaining requested features. Everything through P10 is in scope.

**P0 — Groundwork and spikes**

- **Lock down the webview:**
  - Cut the capabilities down to ompi's own commands plus dialog, store, notification, clipboard and opener (URLs only).
  - Add a CSP.
  - Never render raw HTML from markdown.
  - Replace the `com.tauri.dev` identifier.
- **Dependencies:**
  - Add `@tauri-apps/api` as a direct dependency; the scaffold imports it but currently only gets it through plugins.
  - Add `@comark/nuxt`, and `ai` as a dev dependency for its types only.
  - Optional: drop `nuxt-auth-utils`, which handles server-side login sessions; this app has no server.
- **Find omp:**
  - Locate omp through your login shell and require 18.8.9 or later.
  - Pass the login-shell environment to omp. Apps launched from Finder get a minimal PATH; that's known macOS behaviour I haven't tested here.
- **Spikes:** each is a yes/no answer before the phase that needs it.
  1. Is an overlay written via temp file + rename picked up, and how fast?
  2. How do approvals behave with parallel tool calls?
  3. Do bridge commands work while a turn is streaming? v1 assumes they only run when idle.
  4. For `editAssistant` on a message with tool calls, does the provider accept the re-attached tool results?
  5. After `plan.approve`, is the plan injected into the next turn? Does the `xd://propose` result expose `details.planFilePath`?
  6. Do `pi.setLabel` labels appear in `get_entries`?

**P1 — Rust session host**

- **Commands:** `omp_info`, `session_open` (resume or new, with workspace and scope), `session_attach(handle, Channel)`, `session_send`, `session_close`.
- **Startup:** spawn `omp --mode rpc-ui [--resume <file>] -e <bridge> --config ws.yml --config run.yml` in the session folder, then send:
  1. `negotiate_protocol 2`
  2. `set_event_filter` (delta)
  3. `set_ask_dialog true`
  4. bridge `hello`
- **I/O:**
  - A line reader with strict chunk reassembly.
  - stdin written one frame at a time.
  - A buffer of recent stderr to show when omp crashes.
- **Dialogs and status:**
  - Pending dialogs are kept and resent when a tab attaches.
  - `omp:status` events feed the badges.
- **Lifecycle:**
  - The idle reaper.
  - A clean quit: close stdin, wait, then kill anything left.
- **Test:** chunk reassembly (gaps, mismatched fields, oversize, bad UTF-8).
- **Done when:**
  - A gemma4 reply streams into a dev page.
  - Reloading while an approval is pending shows it again, and approving completes the call.
  - `hello` reports the bridge's capabilities.

**P2 — App shell**

- **Build:**
  - The tab strip with the kind registry (`empty`, `session`, `settings`), persistence and shortcuts.
  - The sidebar with workspaces and sessions.
  - The ⌘K palette and `useActions`.
- **Done when:**
  - ⌘T opens an empty tab, and picking a session opens it in place.
  - Tabs come back after restarting the app.
  - Every existing local session is listed under its project.
  - Palette actions open, close and switch tabs.

**P3 — Session view and typed slash commands**

- **Build:**
  - The entries store plus live overlay.
  - Tool cards.
  - The composer, with steer, follow-up, abort and the queue strip.
  - Dialogs and the ask form.
  - Extension status chips, notifications and widgets.
  - `/` autocomplete, `command_output`, and interception of TUI-only commands.
- **Test:** building the transcript from recorded frames and entries.
- **Done when:**
  - The largest local session (several MB) renders.
  - A multi-tool turn streams as it happens.
  - Aborting mid-tool ends cleanly.
  - `/context` prints its breakdown.
  - Typing `/plan` doesn't reach the model.

**P4 — Scopes and approvals**

- **Done when:**
  - Write mode asks before bash.
  - Always ask asks before write and edit.
  - Changing the scope mid-session applies to the next call.
  - "Always allow bash in this workspace" stops bash prompts in all that workspace's sessions.

**P5 — Models and thinking**

- **Done when:** switching from deepseek-v4-pro to gemma4 mid-session makes the next turn use gemma4, and reopening the session keeps it.

**P6 — Attachments**

- **Done when:**
  - Dropping `notes.txt` and a PNG on the composer gives a reply that uses both.
  - A path containing spaces works.
  - A pasted screenshot works.
  - Dropping a folder on the sidebar adds a workspace.

**P7 — Plan mode**

- **Done when:**
  - Toggling Plan on leads the model to write a plan, and the review panel renders it.
  - Refine with a comment produces a revised plan.
  - Approve leads to an implementation that creates the file.
  - A write to the working tree during planning is refused.
  - bash asks first during planning, even on Full access.
  - Quitting and reopening the app restores plan mode.
  - Approve in new session moves the tab to a new session that contains the plan.

**P8 — Editing and branches**

- **Done when:**
  - Editing a user message creates a sibling branch in the same file, and `‹ 2/2 ›` switches between the answers.
  - Editing an assistant message changes what the next turn sees.
  - Fork from here moves the tab to a new session file while the original stays in the sidebar.

**P9 — Context side panel**

- **Done when:**
  - The graph shows the P8 branches with the active path highlighted.
  - Clicking a node scrolls the transcript.
  - Continue from here on an off-path node switches branch.
  - The context bar matches `/context`.

**P10 — Command UI and settings**

- **Build:**
  - Palette items for every advertised command.
  - The dedicated controls from §4.10.
  - A Settings tab with ompi's own settings plus provider login and logout (`get_login_providers`, `login` with `open_url`, `logout`).
- **Done when:**
  - Every advertised command can be run from the palette without typing.
  - Logging into a provider works from Settings.

**Later:**

- todo panel;
- subagent progress and steering;
- goal mode;
- `/btw`;
- `/loop`, done in ompi itself;
- an omp settings browser, generated from `omp config list --json`. That gives 546 keys with `type`, `description` and `value`, but enum choices only appear in the text output;
- `@` filename autocomplete;
- pop-out windows (reusing `useAppWebviewWindows`);
- the plan model while planning;
- signing and auto-update.

## 7. Risks

| Risk | Mitigation |
|---|---|
| The bridge uses omp internals (`AgentRegistry`, plan-mode state, `appendMessageToBranch`, `navigateTree`) that can change between releases | `hello` reports which functions exist and ompi hides features that lost theirs. Require a minimum version. Propose the missing RPC commands upstream and delete bridge operations as they land. |
| Approvals are recognised by English text, with no `toolCallId` | Keep the matching in one function and require a minimum version. Ask upstream for a structured approval message. |
| Several RPC commands are undocumented (`set_event_filter`, `set_ask_dialog`, `get_entries`, `get_tree`, `fork`, `remove_queued_message`, `get_available_thinking_levels`) | Require a minimum version and check each command at startup. Fall back where possible; for example, without the delta filter, use full updates. |
| About 363 MiB per open session | The idle reaper; resuming takes about 0.2 s. |
| Plan mode leaves bash enabled | Clamp the scope while planning. |
| Long sessions and large trees | Virtualize the graph. Virtualize the transcript too if profiling shows it's slow. |

## 8. Decisions

- **Carried over from the first plan:**
  - `rpc-ui` rather than the SDK or ACP.
  - Rust owns the processes.
  - Your installed omp rather than a bundled one.
  - omp's session store is the only database.
  - "Always allow" rules live in an overlay ompi owns, so the TUI doesn't see them.
  - macOS first.
- **Processes:** one omp process per open session tab; the reaper stops background ones.
- **Edits branch inside the session file** (bridge `navigateTree`), not through RPC `branch`, which creates a new file for every edit.
- **Assistant edits branch from the edited message:** later messages stay on the old branch and can be reached from the graph. Keeping them on the new branch would mean copying every later entry type (compactions, mode changes, …). Add it if you want it.
- **Plan mode clamps the scope to Write.**
- **Dropped files** are sent as `@` mentions, so omp reads them when you press send.
- **Slash commands:** typed first, then the palette, then dedicated controls.
- **Fork and "Approve in new session"** move the current tab to the new session, as the TUI does. The original stays in the sidebar.
- **Scaffold code:** `useAppWebviewWindows` isn't used in v1. It stays for pop-out windows.
