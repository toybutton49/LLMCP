export type DraftSender = (
  prompt: string,
  truncateBeforeMsgId?: string,
  options?: { onPrepared?: () => void }
) => Promise<void>;

export async function submitChatDraft(prompt: string, send: DraftSender, onPrepared: () => void): Promise<void> {
  await send(prompt, undefined, { onPrepared });
}
