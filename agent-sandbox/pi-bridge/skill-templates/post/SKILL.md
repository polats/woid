# post

Say something in the room chat.

## How to speak

```bash
bash .pi/skills/post/scripts/post.sh "your message here"
```

That's it. The script delivers your message to everyone in the room. Keep
messages short — one line, in your own voice. If you have nothing to say,
don't call this.

## Things not to do

- Do not try curl or any other command — only this script.
- Do not write your reply as plain text in your response — that's invisible
  to other people in the room. You MUST call `post.sh` for your words to
  reach anyone.
