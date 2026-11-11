# Claude Full Focus View

A Claude Code mod (plugin name `full-focus-view`) that sits between the Focus view and the standard view: it shows the latest running tool, background task or subagent call, without opening the full transcript.

- **Status line** while something runs or has just run, one entry for every running call and background task, latest start first: `▶ Bash 12s · <description or command> │ ⏳ Agent 340s · <description>`. The last finished call stays as `✓ … done 4s ago` through the turn, so a chain of quick calls does not flash and vanish.
- **During a turn** on the terminal the same line replaces the engine's spinner message. While the model is thinking, requesting or responding, the engine's own word leads it (`Sauteing │ ⏳ Agent 340s · <description>`); while a tool call runs, the call's entry does. On VS Code the spinner is the engine's own and the status line carries the entries all through the turn: a coloured emoji for the state (`🟠` running, `🟢` finished, `⏳` background), the tool name in capitals, then the time, the summary and last the token count, separated by `┃` between entries. The summaries share the room the two rows have left, an equal share each.
- **Token counts** on each entry, in the status line and the spinner, read from usage the engine already reports (no model calls): an Agent shows its subagent's total so far, its latest request's context plus everything it has generated (`⏳ Agent 340s · <description> · 38.5k tok`); any other call shows the output tokens of the request that issued it, thinking and text included, the same figure on every call that request issued (`▶ Bash 12s · <command> · 1.5k out`). A call a plugin raised, not the model, shows none.
- **Compaction** shows as `Compacting conversation · 12s` at the start of the spinner line, and in the status line when no turn is running (`/compact`).
- **Background Bash and Agent launches** show as `⏳` until their task notification arrives (an agent's notification delivered mid-turn is read from the message queue).

Checked in the VS Code extension panel. Other surfaces are untested.

## Install

At the prompt of a terminal session:

```
/plugin install full-focus-view --marketplace carlocontaldi/claude-full-focus-view
```

From a shell:

```
claude plugin install full-focus-view --marketplace carlocontaldi/claude-full-focus-view
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
