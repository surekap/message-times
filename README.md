# message-times

A Claude Code mod that puts a time stamp beside the messages in a conversation.

## What it does

- Each message that you send gets a muted time stamp at its side, for example `1:32 PM`.
- The final reply of each Claude turn gets the same stamp. The short notes that Claude writes between tool calls do not get a stamp.
- The stamp uses the local time zone of your computer.
- When a session continues for more than one day, each stamp also shows the date, for example `Nov 12, 1:32 PM`.
- Messages from before the mod loaded also get a stamp. The mod reads their times from the transcript file of the session. This also applies to a session that you resume.
- Task notifications and messages from other agents do not get a stamp.

The mod works in the terminal and in the Code tab of the Claude desktop app.

## Install

At the prompt of a terminal session:

```
/plugin install message-times --marketplace surekap/message-times
```

Type `y` to add the marketplace. Then select a scope.

From a shell:

```bash
claude plugin install message-times --marketplace surekap/message-times
```

In the desktop app, `/plugin` does not run. Click **+** next to the prompt box. Click **Plugins**, then **Add marketplace**, and type `surekap/message-times`. Then click **Add plugin**.

## How it works

- The mod records the time when the session keeps each prompt and each reply.
- At the end of a turn, the mod marks the last reply with text as the final reply.
- When the mod loads, it reads the transcript file of the session. The file is at `~/.claude/projects/<project>/<session id>.jsonl`. The mod gets the earlier times from this file.
- The mod draws the stamp with `ui.render` hooks on the `UserMessage` and `AssistantMessage` components.

## Limits

- At midnight, the stamps on the screen do not change immediately. They show the date after the next message arrives.
- The desktop app identifies a reply by the ID of its API message, not by the ID of its transcript row. Thus the mod finds most replies by their text.
