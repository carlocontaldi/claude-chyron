# Claude Chyron

> **chy·ron** · US /ˈkaɪrɑn/, UK /ˈkaɪrɒn/ (*KY-ron*) · *noun*, plural *chyrons*
>
> A line of text laid over the lower part of a video picture, such as the headline or the ticker that runs under a news broadcast.
>
> *After the Chyron Corporation, whose 1970s character generator drew such captions.*

A chyron says what is happening without stopping the broadcast. Claude Chyron does the same for Claude Code: a mod (plugin name `chyron`) that sits between the Focus view and the standard view, showing the latest running tool, background task or subagent call without opening the full transcript.

**Token-free.** It makes no model calls and passes every prompt, tool call and response through unchanged, so it adds nothing to the context and costs none of your usage. Even its token counts are read from the usage the engine already reports.

- **Status line** while something runs or has just run, one entry for every running call and background task, latest start first: `▶ Bash 12s · <description or command> │ ⏳ Agent 340s · <description>`. The last finished call stays as `✓ … done 4s ago` through the turn, so a chain of quick calls does not flash and vanish.
- **During a turn** on the terminal the same line replaces the engine's spinner message. While the model is thinking, requesting or responding, the engine's own word leads it (`Sauteing │ ⏳ Agent 340s · <description>`); while a tool call runs, the call's entry does. On VS Code the spinner is the engine's own and the status line carries the entries all through the turn: a coloured emoji for the state (`🟠` running, `🟢` finished, `⏳` background), the tool name in capitals, then the time, the summary and last the token count, separated by `┃` between entries. The summaries share the room the two rows have left, an equal share each.
- **Token counts** on each entry, in the status line and the spinner, read from usage the engine already reports (no model calls): an Agent shows its subagent's total so far, its latest request's context plus everything it has generated after a `Σ` (`⏳ Agent 340s · <description> Σ39k`); any other call shows the output tokens of the request that issued it after a `↓`, thinking and text included, the same figure on every call that request issued (`▶ Bash 12s · <command> ↓1.5k`). Counts keep two digits where the unit allows (`300`, `1.5k`, `39k`, `151k`, `1.2M`), rounded up. A call a plugin raised, not the model, shows none.
- **Compaction** shows as `Compacting conversation · 12s` at the start of the spinner line, and in the status line when no turn is running (`/compact`).
- **Background Bash and Agent launches** show as `⏳` until their task notification arrives (an agent's notification delivered mid-turn is read from the message queue).

Checked in the VS Code extension panel. Other surfaces are untested.

## Install

At the prompt of a terminal session:

```
/plugin install chyron --marketplace carlocontaldi/claude-chyron
```

From a shell:

```
claude plugin install chyron --marketplace carlocontaldi/claude-chyron
```

## Develop

Clone, then run Claude Code with the clone as a plugin folder; the mod hot-reloads on save:

```
claude --plugin-dir /path/to/claude-chyron
```

or set `CLAUDE_CODE_PLUGIN_DIRS=/path/to/claude-chyron` in the `env` block of `~/.claude/settings.json` to load it in every session.

```
claude plugin validate .
claude plugin test .
tsc -p .
```

`tsc` needs the types the engine writes to `.claude-plugin/types/` the first time it loads the mod (git-ignored).

## Limits

- `Stop` and `SubagentStop` are not delivered to mods in the VS Code panel, so the mod tracks background work from tool calls and task notifications instead.
- Scheduled routines (`/loop`, cron) and the live output of a running call are not shown.

## License

[MIT](LICENSE)
