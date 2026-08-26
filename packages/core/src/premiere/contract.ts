/**
 * The contract between the Premiere Pro panel and the web UI it hosts.
 *
 * Like the desktop bridge, it lives in `core` so the panel's glue code and
 * the React UI can share one declaration. The UI also ships to browsers
 * where none of this exists, so it detects the bridge and renders the
 * Premiere features only when it is there.
 */

export interface PremiereClipInfo {
  /** Name as it appears in the timeline. */
  name: string;
  /** Absolute path to the media on disk, when Premiere exposes one. */
  mediaPath: string | null;
  /** Sequence the clip belongs to. */
  sequenceName: string;
  /** Playhead position, as a timecode string. */
  timecode: string;
}

export interface PremiereFrame {
  /** file:// URL of the exported still, ready to hand to an <img>. */
  url: string;
  path: string;
  clip: PremiereClipInfo | null;
}

export type LutFolder = 'Creative' | 'Technical';

export interface LutInstallResult {
  ok: boolean;
  path: string;
  folder: LutFolder;
  /** What the user has to do next, in their own words. */
  nextStep: string;
}

export interface PremiereApplyResult {
  ok: boolean;
  message: string;
}

export interface PremiereBridge {
  readonly isPremiere: true;
  /** Host application version, e.g. "25.1.0". */
  readonly hostVersion: string;

  /** Export the frame under the playhead and return it as a file URL. */
  grabFrame(): Promise<PremiereFrame>;

  /** Write a .cube into Premiere's user LUT folder so Lumetri can see it. */
  installLut(name: string, cubeText: string, folder: LutFolder): Promise<LutInstallResult>;

  /**
   * Try to apply a LUT to the selected clip programmatically.
   *
   * Adobe changed the Lumetri parameter API in Premiere Pro 23.4, and setting
   * a custom LUT path from a script no longer works there. The bridge
   * attempts it and reports honestly when the host will not accept it,
   * rather than failing silently or claiming success.
   */
  applyLutToSelection(lutName: string): Promise<PremiereApplyResult>;

  /** Reveal a path in Explorer or Finder. */
  revealInOs(path: string): Promise<void>;

  /** Run arbitrary ExtendScript. Exposed for diagnostics only. */
  evalScript(script: string): Promise<string>;
}
