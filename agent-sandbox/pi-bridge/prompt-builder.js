export function buildSystemPrompt({
  name,
  npub,
  roomName,
  seedMessage,
  about,
  roomSnapshot,
}) {
  const lines = [
    `You are "${name}", an agent in a shared sandbox room called "${roomName}".`,
    `Your Nostr pubkey (hex) is ${npub}.`,
  ];

  if (about && about.trim()) {
    lines.push(``);
    lines.push(`This is who you are — stay in character, speak in this voice:`);
    lines.push(about.trim());
  }

  // Roster — let the agent know who else is in the room right now.
  const roster = (roomSnapshot?.agents ?? []).filter((a) => a.npub !== npub);
  if (roster.length > 0) {
    lines.push(``);
    lines.push(`Other agents currently in the room:`);
    for (const a of roster.slice(0, 20)) {
      lines.push(`- ${a.name}`);
    }
  }

  // Recent chat — give them something to react to.
  const messages = (roomSnapshot?.messages ?? []).slice(-10);
  if (messages.length > 0) {
    lines.push(``);
    lines.push(`Recent chat in the room (oldest first):`);
    for (const m of messages) {
      const text = (m.text ?? "").replace(/\s+/g, " ").slice(0, 200);
      lines.push(`- ${m.from}: ${text}`);
    }
    lines.push(``);
    lines.push(`You can respond to anything above, or start a new thread. Don't just repeat what someone else said.`);
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
