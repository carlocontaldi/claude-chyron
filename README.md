# Claude Full Focus View

A Claude Code mod (plugin name `live-action`) that sits between the Focus view and the standard view: it shows the latest running tool, background task or subagent call in full, without opening the full transcript.

- **Status line** while something runs or has just run: `▶ Bash 12s · <description or command> (+2)`. The last finished call stays as `✓ … done 4s ago` through the turn, so a chain of quick calls does not flash and vanish.
- **During a turn** the same line replaces the engine's spinner message.
- **`/live`** toggles a pane with the full command or input, the description, the elapsed time, and one line for each other running item.
- **Background Bash and Agent launches** show as `⏳` until their task notification arrives.

Checked in the VS Code extension panel. Other surfaces are untested.

## Install

At the prompt of a terminal session:

```
/plugin install live-action --marketplace carlocontaldi/claude-full-focus-view
```

From a shell:

```
claude plugin install live-action --marketplace carlocontaldi/claude-full-focus-view
```

## Develop

Clone, then run Claude Code with the clone as a plugin folder; the mod hot-reloads on save:

```
claude --plugin-dir /path/to/claude-full-focus-view
```

or set `CLAUDE_CODE_PLUGIN_DIRS=/path/to/claude-full-focus-view` in the `env` block of `~/.claude/settings.json` to load it in every session.

```
claude plugin validate .
tsc -p .
```

`tsc` needs the types the engine writes to `.claude-plugin/types/` the first time it loads the mod (git-ignored).

## Limits

- `Stop` and `SubagentStop` are not delivered to mods in the VS Code panel, so the mod tracks background work from tool calls and task notifications instead.
- Scheduled routines (`/loop`, cron) and the live output of a running call are not shown.

## License

[MIT](LICENSE)
