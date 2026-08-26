import { useState } from 'react';
import { writeCube } from '@easycolor/core';
import type { LutFolder, PremiereFrame } from '@easycolor/core';
import { useGrade } from '../../state/StoreContext.js';
import { getPremiereBridge } from '../../desktop/premiere.js';
import type { RendererApi } from '../../hooks/useRenderer.js';
import { Slider } from '../ui/Slider.js';
import { Button, Section, Select } from '../ui/controls.js';

/**
 * The Premiere Pro side of the panel.
 *
 * The workflow is: grab the frame under the playhead, grade it here with
 * the same tools as everywhere else, then send the look back as a LUT that
 * Lumetri can apply.
 *
 * Sending is done by writing the .cube into Premiere's own user LUT folder
 * rather than by driving Lumetri from a script. That is a deliberate choice,
 * not a shortcut: Adobe changed the Lumetri parameter API in Premiere Pro
 * 23.4 and scripts can no longer set a custom LUT by path. The folder route
 * works on every version, survives Premiere updates, and travels with the
 * project to Media Encoder. The panel still offers the scripted apply, and
 * tells you plainly when your version will not accept it.
 */

interface Props {
  renderer: RendererApi;
  onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void;
  onFrameGrabbed: (frame: PremiereFrame) => void;
}

const SIZES = [17, 33, 65] as const;

export function PremierePanel({ renderer, onNotify, onFrameGrabbed }: Props) {
  const grade = useGrade();
  const bridge = getPremiereBridge();

  const [busy, setBusy] = useState<string | null>(null);
  const [frame, setFrame] = useState<PremiereFrame | null>(null);
  const [lutName, setLutName] = useState('EasyColor Look');
  const [size, setSize] = useState<number>(33);
  const [installed, setInstalled] = useState<{ path: string; nextStep: string } | null>(null);

  if (!bridge) return null;

  /**
   * Which Lumetri menu the LUT belongs in.
   *
   * A LUT that includes the camera conversion is a technical transform and
   * belongs under Input LUT, where it runs first. A purely creative look
   * belongs under Creative → Look, after the correction. Putting either in
   * the wrong slot produces a double-corrected image, so the panel decides
   * from the grade rather than asking.
   */
  const folder: LutFolder = grade.source.logTransform === 'none' ? 'Creative' : 'Technical';

  const grabFrame = async () => {
    setBusy('Exporting the frame from Premiere…');
    try {
      const grabbed = await bridge.grabFrame();
      setFrame(grabbed);
      onFrameGrabbed(grabbed);
      onNotify('Frame loaded from the playhead.', 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const sendLook = async () => {
    if (!renderer.renderer) {
      onNotify('The grading engine is not ready yet.', 'error');
      return;
    }
    setBusy('Baking the look…');
    try {
      const data = renderer.renderer.bakeLut(grade, size);
      const cube = writeCube(size, data, { title: lutName });

      setBusy('Writing it into Premiere’s LUT folder…');
      const result = await bridge.installLut(lutName, cube, folder);
      setInstalled({ path: result.path, nextStep: result.nextStep });
      onNotify('Look sent to Premiere.', 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const applyToClip = async () => {
    setBusy('Applying to the selected clip…');
    try {
      const result = await bridge.applyLutToSelection(lutName);
      onNotify(result.message, result.ok ? 'success' : 'info');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const spatial = [
    grade.film.halation.enabled && grade.film.halation.strength > 0 ? 'halation' : null,
    grade.film.grain.enabled && grade.film.grain.amount > 0 ? 'grain' : null,
    grade.windows.some((w) => w.enabled) ? 'power windows' : null,
  ].filter(Boolean) as string[];

  return (
    <div className="panel">
      <Section title="Frame">
        {frame ? (
          <>
            <img className="reference-thumb" src={frame.url} alt="Frame from Premiere" />
            {frame.clip && (
              <>
                <p className="hint" style={{ color: 'var(--text)' }}>
                  {frame.clip.name}
                </p>
                <p className="hint" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                  {frame.clip.sequenceName} · {frame.clip.timecode}
                </p>
              </>
            )}
          </>
        ) : (
          <div className="empty">
            No frame loaded yet.
            <br />
            Park the playhead on the shot you want to grade, then grab it.
          </div>
        )}
        <Button onClick={() => void grabFrame()} disabled={busy !== null}>
          {frame ? 'Grab the current frame again' : 'Grab the current frame'}
        </Button>
        <p className="hint">
          Premiere writes the frame to a temporary file and the panel opens it. Move the playhead
          and grab again whenever you want a different reference.
        </p>
      </Section>

      <Section title="Send the look back">
        <div className="control">
          <div className="control-head">
            <span className="control-label" style={{ cursor: 'default' }}>
              LUT name
            </span>
          </div>
          <input
            className="field"
            value={lutName}
            onChange={(e) => setLutName(e.target.value)}
            placeholder="EasyColor Look"
          />
        </div>

        <Select
          label="Cube size"
          value={String(size)}
          options={SIZES.map((s) => ({
            value: String(s),
            label: `${s}³${s === 33 ? ' — standard' : s === 65 ? ' — highest precision' : ' — smallest'}`,
          }))}
          onChange={(v) => setSize(Number(v))}
        />

        <div className="row between">
          <span className="control-label" style={{ cursor: 'default' }}>
            Goes to
          </span>
          <span className="control-value">{folder}</span>
        </div>
        <p className="hint">
          {folder === 'Technical'
            ? 'Your grade includes a camera conversion, so this belongs in the Input LUT slot — it has to run before Lumetri’s own correction.'
            : 'This is a creative look with no camera conversion, so it belongs in Creative → Look, after the correction.'}
        </p>

        <Button onClick={() => void sendLook()} disabled={busy !== null || !renderer.ready}>
          Send look to Premiere
        </Button>

        {installed && (
          <div style={{ marginTop: 10 }}>
            <p className="hint ok">{installed.nextStep}</p>
            <p className="hint" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
              {installed.path}
            </p>
            <div className="row">
              <Button small variant="ghost" onClick={() => void bridge.revealInOs(installed.path)}>
                Show the file
              </Button>
              <Button small variant="ghost" onClick={() => void applyToClip()} disabled={busy !== null}>
                Add Lumetri to the selected clip
              </Button>
            </div>
          </div>
        )}

        <p className="hint">
          A LUT sent for the first time only appears in Lumetri’s menu after Premiere restarts —
          Premiere scans those folders at launch. Replacing a LUT of the same name takes effect
          straight away.
        </p>

        {spatial.length > 0 && (
          <p className="hint warn">
            {spatial.join(', ')} {spatial.length === 1 ? 'is' : 'are'} not carried by a LUT — a cube
            maps colour to colour and cannot know where a pixel is in the frame. Recreate those in
            Premiere, or render the master in the EasyColor desktop app, which does apply them.
          </p>
        )}
      </Section>

      <Section title="About this panel">
        <p className="hint">
          Premiere Pro {bridge.hostVersion}.
        </p>
        <p className="hint">
          Since Premiere Pro 23.4, scripts can no longer point Lumetri at a custom LUT file. That
          is why the panel installs the LUT into Premiere’s own folder and asks you to pick it from
          the menu — one extra click, and it works on every version rather than breaking on the
          next update.
        </p>
      </Section>

      {busy && (
        <div className="toast" style={{ position: 'sticky', bottom: 0 }}>
          {busy}
        </div>
      )}
    </div>
  );
}
