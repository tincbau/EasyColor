/**
 * Saving a generated file.
 *
 * Three hosts, three answers, one call site:
 *
 * - A normal browser tab or the Electron shell: a plain anchor download.
 * - A sandboxed viewer that grants the `downloads` capability: hand the
 *   bytes to the host, which asks the viewer to confirm.
 * - A sandboxed viewer with no capability: nothing can be written, and the
 *   caller is told so rather than the button quietly doing nothing.
 *
 * The capability's allowlist does not include `.cube`, which is the one
 * extension a colour tool most wants to write. Rather than hardcoding that
 * list — it can change, and guessing at it is how a working export breaks
 * silently later — the real extension is attempted first and only swapped
 * for `.txt` if the host actually rejects it. A `.cube` file is plain text,
 * so the fallback is a rename away, and the caller is handed the sentence to
 * say about it.
 */

interface ClaudeDownloads {
  save(request: { filename: string; data: string | Blob }): Promise<{ status: string }>;
}

interface ClaudeHost {
  use?<T = ClaudeDownloads>(name: string): Promise<T | null>;
}

export interface SaveOutcome {
  ok: boolean;
  /** The name the file was actually offered under. */
  filename: string;
  /** Present when the caller should tell the user something. */
  note?: string;
}

function anchorDownload(text: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately cancels the download in some browsers; a short
  // delay is the pragmatic fix everyone lands on.
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unavailable';
}

export async function saveTextFile(
  text: string,
  filename: string,
  mime = 'text/plain',
): Promise<SaveOutcome> {
  const host = (globalThis as { claude?: ClaudeHost }).claude;

  if (!host?.use) {
    anchorDownload(text, filename, mime);
    return { ok: true, filename };
  }

  const downloads = await host.use<ClaudeDownloads>('downloads');
  if (!downloads) {
    // The page is framed by a host that will not let it write a file, and an
    // anchor download here is silently swallowed — so say so instead.
    return {
      ok: false,
      filename,
      note: 'This preview cannot save files. Open the full build to export.',
    };
  }

  try {
    await downloads.save({ filename, data: text });
    return { ok: true, filename };
  } catch (error) {
    const code = errorCode(error);

    if (code === 'rejected_extension' || code === 'extension_not_enabled') {
      const fallback = `${filename}.txt`;
      try {
        await downloads.save({ filename: fallback, data: text });
        const original = filename.split('.').pop();
        return {
          ok: true,
          filename: fallback,
          note: `Saved as ${fallback}. Remove the .txt to use it as a .${original} file — the contents are already correct.`,
        };
      } catch (retryError) {
        return { ok: false, filename, note: describe(errorCode(retryError)) };
      }
    }

    // A viewer declining is a choice, not a failure worth a message.
    if (code === 'declined') return { ok: false, filename };

    return { ok: false, filename, note: describe(code) };
  }
}

function describe(code: string): string {
  switch (code) {
    case 'too_large':
      return 'That file is too large for this viewer to save. Try a smaller cube size.';
    case 'rate_limited':
      return 'A save is already in progress. Try again in a moment.';
    case 'bad_request':
      return 'The file could not be prepared for saving.';
    default:
      return 'This viewer cannot save files. Open the full build to export.';
  }
}

/** Make a string safe to use as a filename. */
export function sanitise(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'easycolor-grade';
}
