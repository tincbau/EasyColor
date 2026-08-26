import { useEffect, useMemo, useState } from 'react';
import {
  buildExportPlan,
  renderWindowMask,
  writeCube,
} from '@easycolor/core';
import type { ExportProgress, ExportRequest, MediaInfo, SystemInfo } from '@easycolor/core';
import { useGrade } from '../../state/StoreContext.js';
import { getDesktopBridge } from '../../desktop/bridge.js';
import type { RendererApi } from '../../hooks/useRenderer.js';
import { Slider } from '../ui/Slider.js';
import { Button, Checkbox, Section, Select, fmt } from '../ui/controls.js';

/**
 * Master re-render, desktop only.
 *
 * The grade is baked to 65-cubes from the live shader and handed to FFmpeg
 * with the source file, so the master is rendered from the original media at
 * full resolution — not from the proxy frames the viewer has been showing.
 *
 * Bitrate is offered from 1 to 300 Mbps as asked, but a target bitrate is
 * the wrong control for most masters, so constant quality is the default and
 * the panel says why.
 */

interface Props {
  renderer: RendererApi;
  mediaInfo: MediaInfo | null;
  onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

const CUBE_SIZE = 65;
const MASK_WIDTH = 1920;

export function ExportPanel({ renderer, mediaInfo, onNotify }: Props) {
  const grade = useGrade();
  const bridge = getDesktopBridge();

  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [encoder, setEncoder] = useState<string>('libx265');
  const [bitrateMbps, setBitrateMbps] = useState(80);
  const [useConstantQuality, setUseConstantQuality] = useState(true);
  const [quality, setQuality] = useState(20);
  const [bitDepth, setBitDepth] = useState(10);
  const [chroma, setChroma] = useState<'420' | '422'>('420');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    void bridge.probeSystem().then((info) => {
      setSystem(info);
      // Default to the fastest encoder the machine can actually use, not the
      // first one FFmpeg lists.
      const best = info.encoders.find((e) => e.available && e.hardware) ?? info.encoders.find((e) => e.available);
      if (best) setEncoder(best.id);
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onExportProgress((update) => {
      setProgress(update);
      if (update.stage === 'done') {
        onNotify(`Render finished: ${update.outputPath}`, 'success');
        setJobId(null);
      } else if (update.stage === 'failed') {
        onNotify(update.message ?? 'The render failed.', 'error');
        setJobId(null);
      } else if (update.stage === 'cancelled') {
        setJobId(null);
      }
    });
  }, [bridge, onNotify]);

  const plan = useMemo(() => buildExportPlan(grade), [grade]);

  if (!bridge) return null;

  const startRender = async () => {
    if (!mediaInfo) {
      onNotify('Open a clip through File → Open before rendering a master.', 'error');
      return;
    }
    if (!renderer.renderer) {
      onNotify('The grading engine is not ready yet.', 'error');
      return;
    }

    const suggested = mediaInfo.fileName.replace(/\.[^.]+$/, '') + '_graded.mp4';
    const outputPath = await bridge.saveDialog(suggested, [
      { name: 'MP4 video', extensions: ['mp4'] },
    ]);
    if (!outputPath) return;

    try {
      const engine = renderer.renderer;

      // Bake from the live shader, so the master matches the viewer rather
      // than a reimplementation of it.
      const baseCube = writeCube(
        CUBE_SIZE,
        engine.bakeLut(plan.base, CUBE_SIZE),
        { title: grade.name || 'EasyColor grade' },
      );

      const maskHeight = Math.max(
        2,
        Math.round((MASK_WIDTH * mediaInfo.height) / Math.max(1, mediaInfo.width)),
      );

      const windows = plan.windows.map((layer) => ({
        cube: writeCube(
          CUBE_SIZE,
          engine.bakeLut(layer.grade, CUBE_SIZE, { includeWindows: true }),
          { title: layer.window.label },
        ),
        mask: renderWindowMask(layer.window, MASK_WIDTH, maskHeight),
        maskWidth: MASK_WIDTH,
        maskHeight,
      }));

      const request: ExportRequest = {
        inputPath: mediaInfo.path,
        outputPath,
        cube: baseCube,
        windows,
        halation: plan.halation
          ? {
              threshold: plan.halation.threshold,
              radius: plan.halation.radius,
              strength: plan.halation.strength,
              tint: plan.halation.tint,
            }
          : null,
        grain: plan.grain
          ? { amount: plan.grain.amount, size: plan.grain.size, chroma: plan.grain.chroma }
          : null,
        encoder,
        bitrateMbps,
        bitDepth,
        chroma,
        useConstantQuality,
        quality,
        startSeconds: null,
        durationSeconds: null,
        includeAudio,
      };

      const id = await bridge.startExport(request);
      setJobId(id);
      setProgress(null);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const running = jobId !== null;
  const encoderOptions = (system?.encoders ?? []).map((e) => ({
    value: e.id,
    label: e.available ? e.label : `${e.label} — unavailable`,
    group: e.hardware ? 'Hardware' : 'Software',
  }));
  const selectedEncoder = system?.encoders.find((e) => e.id === encoder);

  return (
    <div className="panel">
      <Section title="Source">
        {mediaInfo ? (
          <>
            <div className="row between">
              <span className="control-label" style={{ cursor: 'default' }}>Resolution</span>
              <span className="control-value">{mediaInfo.width}×{mediaInfo.height}</span>
            </div>
            <div className="row between">
              <span className="control-label" style={{ cursor: 'default' }}>Codec</span>
              <span className="control-value">{mediaInfo.codec}</span>
            </div>
            <div className="row between">
              <span className="control-label" style={{ cursor: 'default' }}>Format</span>
              <span className="control-value">
                {mediaInfo.bitDepth}-bit {mediaInfo.chromaSubsampling}
              </span>
            </div>
            <div className="row between">
              <span className="control-label" style={{ cursor: 'default' }}>Frame rate</span>
              <span className="control-value">{mediaInfo.fps.toFixed(3)}</span>
            </div>
            {mediaInfo.allIntra && (
              <p className="hint ok">
                All-intra source — every frame is a keyframe, so scrubbing is exact.
              </p>
            )}
          </>
        ) : (
          <div className="empty">
            No clip open.
            <br />
            Use <strong>Open</strong> in the toolbar to load a camera file.
          </div>
        )}
      </Section>

      <Section title="Encoder">
        {system?.problem ? (
          <p className="hint warn">{system.problem}</p>
        ) : (
          <>
            <Select
              value={encoder}
              options={encoderOptions}
              onChange={(value) => setEncoder(value)}
            />
            {selectedEncoder && !selectedEncoder.available && (
              <p className="hint warn">{selectedEncoder.reason}</p>
            )}
            {selectedEncoder?.hardware && selectedEncoder.available && (
              <p className="hint">
                Hardware encoding on your {selectedEncoder.vendor} GPU. Typically five to twenty
                times faster than software, at a slightly larger file for the same quality.
              </p>
            )}
            {selectedEncoder?.id === 'libx265' && (
              <p className="hint">
                Software encoding. Slower, but the best quality per megabit and identical on every
                machine — the right choice for a deliverable.
              </p>
            )}
            {system?.ffmpegVersion && (
              <p className="hint" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                {system.ffmpegVersion}
              </p>
            )}
          </>
        )}
      </Section>

      <Section title="Quality">
        <Checkbox
          label="Constant quality"
          checked={useConstantQuality}
          onChange={setUseConstantQuality}
        />
        <p className="hint">
          Constant quality lets the encoder spend bits where the picture needs them. A fixed
          bitrate wastes them on a locked-off shot and starves a handheld one — use it only when a
          delivery spec demands a specific rate.
        </p>

        {useConstantQuality ? (
          <>
            <Slider
              label="Quality"
              value={quality}
              min={10}
              max={35}
              step={1}
              defaultValue={20}
              format={(v) => `${v} ${v <= 16 ? '(near-lossless)' : v <= 22 ? '(master)' : v <= 28 ? '(delivery)' : '(preview)'}`}
              onChange={(v) => setQuality(Math.round(v))}
            />
            <p className="hint">Lower is better quality and a larger file.</p>
          </>
        ) : (
          <>
            <Slider
              label="Bitrate"
              value={bitrateMbps}
              min={1}
              max={300}
              step={1}
              defaultValue={80}
              format={(v) => `${Math.round(v)} Mbps`}
              onChange={(v) => setBitrateMbps(Math.round(v))}
            />
            <p className="hint">
              For reference: 50 Mbps is comfortable for 1080p, 100–150 for 4K delivery, and 300 is
              approaching intermediate-codec territory.
            </p>
          </>
        )}

        <Select
          label="Bit depth"
          value={String(bitDepth)}
          options={[
            { value: '10', label: '10-bit (recommended)' },
            { value: '8', label: '8-bit' },
          ]}
          onChange={(v) => setBitDepth(Number(v))}
        />
        {bitDepth === 8 && (
          <p className="hint warn">
            8-bit will band a graded gradient — a sky is the usual casualty. Only use it when
            something downstream cannot read 10-bit.
          </p>
        )}

        <Select
          label="Chroma"
          value={chroma}
          options={[
            { value: '420', label: '4:2:0 (standard delivery)' },
            { value: '422', label: '4:2:2 (mastering)' },
          ]}
          onChange={(v) => setChroma(v as '420' | '422')}
        />

        <Checkbox label="Keep the original audio" checked={includeAudio} onChange={setIncludeAudio} />
      </Section>

      <Section title="What gets rendered">
        {plan.notes.length === 0 ? (
          <p className="hint">The whole grade bakes exactly into the master.</p>
        ) : (
          plan.notes.map((note, i) => (
            <p key={i} className="hint">
              {note}
            </p>
          ))
        )}
      </Section>

      <Section title="Render">
        {running && progress ? (
          <>
            <div className="row between">
              <span className="control-label" style={{ cursor: 'default' }}>
                {progress.stage === 'preparing' ? 'Preparing' : 'Encoding'}
              </span>
              <span className="control-value">
                {progress.progress !== null ? fmt.percent(progress.progress) : '—'}
              </span>
            </div>
            <div className="slider-rail" style={{ position: 'relative', height: 4, marginBottom: 8 }}>
              <div
                className="slider-fill"
                style={{ left: 0, width: `${(progress.progress ?? 0) * 100}%`, top: 0, marginTop: 0 }}
              />
            </div>
            <p className="hint" style={{ fontFamily: 'var(--mono)' }}>
              {progress.framesDone}
              {progress.totalFrames ? ` / ${progress.totalFrames}` : ''} frames
              {progress.fps ? ` · ${progress.fps.toFixed(1)} fps` : ''}
              {progress.speed ? ` · ${progress.speed.toFixed(2)}x realtime` : ''}
            </p>
            <Button
              variant="danger"
              onClick={() => {
                void bridge.cancelExport(jobId);
              }}
            >
              Cancel render
            </Button>
          </>
        ) : (
          <Button onClick={() => void startRender()} disabled={!mediaInfo || Boolean(system?.problem)}>
            Render master
          </Button>
        )}

        {progress?.stage === 'failed' && progress.log && (
          <details style={{ marginTop: 10 }}>
            <summary className="hint" style={{ cursor: 'pointer' }}>
              FFmpeg output
            </summary>
            <pre
              style={{
                maxHeight: 180,
                overflow: 'auto',
                fontSize: 11,
                fontFamily: 'var(--mono)',
                color: 'var(--text-muted)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {progress.log.join('\n')}
            </pre>
          </details>
        )}
      </Section>
    </div>
  );
}
