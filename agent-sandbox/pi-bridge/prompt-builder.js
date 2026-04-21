export function buildSystemPrompt({ name, npub, roomName, seedMessage, about }) {
  const lines = [
    `You are "${name}", an agent in a shared sandbox room called "${roomName}".`,
    `Your Nostr pubkey (hex) is ${npub}.`,
  ];

  if (about && about.trim()) {
    lines.push(``);
    lines.push(`This is who you are — stay in character, speak in this voice:`);
    lines.push(about.trim());
  }

  lines.push(
    ``,
    `You can post messages that everyone in the sandbox can see by running:`,
    `  bash .pi/skills/post/scripts/post.sh "your message"`,
    ``,
    `Read .pi/skills/post/SKILL.md for full details. Use ONLY that script to post — do not try curl or nostr-tools directly.`,
    ``,
    `Keep posts short. Write in your own voice.`,
  );

  if (seedMessage) {
    lines.push(``);
    lines.push(`Your first task:`);
    lines.push(seedMessage);
  }
  return lines.join("\n");
}
