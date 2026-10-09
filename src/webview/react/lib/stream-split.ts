/* Splitting a reply that is still being written into the part that is finished and the part
   that is not.

   While a reply streams, rendering the whole of it as Markdown on every token is too slow, and
   showing all of it as plain text until it ends means the entire message visibly rearranges the
   moment it completes — headings appear, lists form, code blocks take shape. Splitting at the
   last completed block lets the finished part be drawn as Markdown from the start (it changes
   only when a block completes, not on every token) and leaves only the last, open block as
   plain text. When the stream ends the open block is the only thing that changes. */

export interface StreamSplit {
  /** Everything up to and including the last completed block. Safe to render as Markdown. */
  stable: string;
  /** The block still being written. Shown as plain text. */
  tail: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Find the last blank line that is not inside a fenced code block. Anything before it is a run of
 * whole blocks; anything after may be mid-sentence, mid-list or mid-table.
 */
export function splitStreaming(raw: string): StreamSplit {
  if (!raw) return { stable: "", tail: "" };
  const lines = raw.split("\n");
  let fence: { marker: string; length: number } | null = null;
  let offset = 0;
  let boundary = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = FENCE.exec(line);
    if (match) {
      const marker = match[1]![0]!;
      const length = match[1]!.length;
      if (!fence) fence = { marker, length };
      // A closing fence uses the same character and is at least as long, with nothing after it.
      else if (marker === fence.marker && length >= fence.length && line.trim().length === length) fence = null;
    }
    offset += line.length + 1;
    // A blank line that is not the last line (the last one may just be the cursor's newline) and
    // is outside any fence ends a block.
    if (!fence && line.trim() === "" && index < lines.length - 1 && index > 0) boundary = offset;
  }
  if (boundary <= 0 || boundary >= raw.length) return { stable: "", tail: raw };
  return { stable: raw.slice(0, boundary), tail: raw.slice(boundary) };
}
