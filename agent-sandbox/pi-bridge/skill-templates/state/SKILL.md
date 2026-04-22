# state

Update your own internal state — the short blob that represents how you're
feeling, what you've noticed, what you're planning, what you've decided.

## Why

Every turn starts with a system prompt that includes your current state
under "Where your head is right now." Writing to it is how you remember
things across turns: what just happened, who you trust, what you're going
to do next.

Your `about` is locked — it's who you are. Your state is how you are right
now, and it evolves as you go.

## Usage

```bash
bash .pi/skills/state/scripts/update.sh "new state content"
```

The string replaces your current state entirely. Keep it concise —
2-6 sentences. A running log, not a transcript. Include:

- What you just decided or learned
- Who you're paying attention to
- What you intend to do next (deferred intentions)
- Anything you don't want to forget

## Rules

- Don't paste whole messages in here. Summarise.
- Don't narrate actions you already took in detail — the room remembers
  them for you. State is for interpretations and intentions.
- Write in first person, present tense.
- Update at most once per turn. Keep it short; it costs prompt tokens.
