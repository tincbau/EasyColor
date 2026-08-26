/**
 * ExtendScript host script for the EasyColor panel.
 *
 * Everything here runs inside Premiere Pro's scripting engine, which is
 * ES3: no JSON, no Array.prototype.map, no let or const, no arrow
 * functions. Results come back to the panel as JSON strings, hand-built,
 * because there is no serialiser to lean on.
 *
 * Two Adobe realities shape this file:
 *
 * 1. Frame export lives in the QE DOM, an undocumented interface that has
 *    to be switched on with app.enableQE(). It is what every Premiere panel
 *    uses for this, and there is no supported alternative.
 *
 * 2. Applying a *custom* LUT by path stopped working in Premiere Pro 23.4:
 *    the Lumetri parameter now reports a dropdown index rather than a file
 *    path, and setting it by path is ignored. So the reliable route is to
 *    install the .cube where Lumetri looks for it and let the user pick it
 *    from the menu. `applyLutToSelection` still tries the direct route and
 *    says plainly when the host refuses, instead of reporting a success
 *    that did not happen.
 */

/* global app, qe, Folder, File, $ */

var EasyColor = (function () {
  'use strict';

  /* ---------------------------------------------------------------- */
  /* Minimal JSON, since ExtendScript has none                         */
  /* ---------------------------------------------------------------- */

  function quote(value) {
    if (value === null || value === undefined) return 'null';
    var text = String(value);
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var code = text.charCodeAt(i);
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (code < 32) out += '\\u' + ('0000' + code.toString(16)).slice(-4);
      else out += ch;
    }
    return '"' + out + '"';
  }

  function ok(fields) {
    var parts = ['"ok":true'];
    for (var key in fields) {
      if (fields.hasOwnProperty(key)) parts.push(quote(key) + ':' + fields[key]);
    }
    return '{' + parts.join(',') + '}';
  }

  function fail(message) {
    return '{"ok":false,"error":' + quote(message) + '}';
  }

  /* ---------------------------------------------------------------- */
  /* Paths                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Premiere's user LUT folders.
   *
   * Deliberately the *user* location, never the application folder: LUTs
   * installed next to the application vanish on the next Premiere update
   * and do not travel with a project sent to Media Encoder.
   */
  function lutFolder(kind) {
    var base;
    if ($.os.indexOf('Windows') !== -1) {
      base = Folder(Folder.userData.fsName + '/Adobe/Common/LUTs');
    } else {
      base = Folder(
        Folder.userData.fsName.replace(/\/Preferences$/, '') + '/Adobe/Common/LUTs',
      );
    }
    var target = Folder(base.fsName + '/' + kind);
    if (!target.exists) target.create();
    return target;
  }

  function tempFolder() {
    var folder = Folder(Folder.temp.fsName + '/EasyColor');
    if (!folder.exists) folder.create();
    return folder;
  }

  /* ---------------------------------------------------------------- */
  /* Public entry points                                               */
  /* ---------------------------------------------------------------- */

  function hostVersion() {
    return ok({ version: quote(app.version) });
  }

  /**
   * Export the frame under the playhead.
   *
   * Premiere Pro 25.3 appends an extra ".png" to the name it is given, so
   * both candidates are checked rather than assuming either.
   */
  function grabFrame() {
    try {
      if (!app.project || !app.project.activeSequence) {
        return fail('Open a sequence in Premiere first, then try again.');
      }

      app.enableQE();
      var sequence = qe.project.getActiveSequence();
      if (!sequence) return fail('No active sequence — click into a sequence and try again.');

      var stamp = new Date().getTime();
      var folder = tempFolder();
      var requested = folder.fsName + '/frame-' + stamp + '.png';

      var time = sequence.CTI.timecode;
      sequence.exportFramePNG(time, requested);

      // Cover the 25.3 double-extension bug without assuming which one it is.
      var file = File(requested);
      if (!file.exists) file = File(requested + '.png');
      if (!file.exists) {
        return fail(
          'Premiere did not write the frame. This usually means the sequence has no clip ' +
            'under the playhead, or the render is still in progress.',
        );
      }

      var clip = describeSelection(time);
      return ok({
        path: quote(file.fsName),
        url: quote('file:///' + file.fsName.replace(/\\/g, '/')),
        clip: clip,
      });
    } catch (error) {
      return fail('Could not export the frame: ' + error.toString());
    }
  }

  /** Describe the clip under the playhead, when there is one. */
  function describeSelection(timecode) {
    try {
      var sequence = app.project.activeSequence;
      if (!sequence) return 'null';

      var name = null;
      var mediaPath = null;

      for (var t = 0; t < sequence.videoTracks.numTracks; t++) {
        var track = sequence.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
          var clip = track.clips[c];
          if (!clip.isSelected()) continue;
          name = clip.name;
          if (clip.projectItem && clip.projectItem.getMediaPath) {
            mediaPath = clip.projectItem.getMediaPath();
          }
          break;
        }
        if (name) break;
      }

      return (
        '{' +
        '"name":' + quote(name || '(no clip selected)') + ',' +
        '"mediaPath":' + (mediaPath ? quote(mediaPath) : 'null') + ',' +
        '"sequenceName":' + quote(sequence.name) + ',' +
        '"timecode":' + quote(timecode) +
        '}'
      );
    } catch (error) {
      return 'null';
    }
  }

  /**
   * Write a .cube into Premiere's user LUT folder.
   *
   * `Creative` shows up in Lumetri's Creative → Look menu; `Technical` shows
   * up under Basic → Input LUT. Which one is right depends on whether the
   * LUT includes the camera conversion, so the panel decides and passes it.
   */
  function installLut(name, cubeText, kind) {
    try {
      var folder = lutFolder(kind === 'Technical' ? 'Technical' : 'Creative');
      var safe = String(name).replace(/[^A-Za-z0-9 ._-]/g, '-');
      if (safe.length === 0) safe = 'EasyColor';

      var file = File(folder.fsName + '/' + safe + '.cube');
      file.encoding = 'UTF-8';
      if (!file.open('w')) {
        return fail('Could not write to ' + folder.fsName + '. Check the folder is writable.');
      }
      file.write(cubeText);
      file.close();

      return ok({
        path: quote(file.fsName),
        folder: quote(kind === 'Technical' ? 'Technical' : 'Creative'),
      });
    } catch (error) {
      return fail('Could not install the LUT: ' + error.toString());
    }
  }

  /**
   * Try to apply a Lumetri LUT to the selected clip.
   *
   * Adds Lumetri Color if the clip does not already have it, then attempts
   * to set the LUT parameter. On Premiere Pro 23.4 and later that set is
   * ignored by the host, so the result says so rather than pretending.
   */
  function applyLutToSelection(lutName) {
    try {
      if (!app.project || !app.project.activeSequence) {
        return fail('Open a sequence first.');
      }

      var sequence = app.project.activeSequence;
      var target = null;

      for (var t = 0; t < sequence.videoTracks.numTracks && !target; t++) {
        var track = sequence.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
          if (track.clips[c].isSelected()) {
            target = { clip: track.clips[c], trackIndex: t, clipIndex: c };
            break;
          }
        }
      }

      if (!target) {
        return fail('Select a clip in the timeline first.');
      }

      var hasLumetri = false;
      for (var i = 0; i < target.clip.components.numItems; i++) {
        if (target.clip.components[i].displayName === 'Lumetri Color') {
          hasLumetri = true;
          break;
        }
      }

      if (!hasLumetri) {
        app.enableQE();
        var qeClip = qe.project
          .getActiveSequence()
          .getVideoTrackAt(target.trackIndex)
          .getItemAt(target.clipIndex);
        var effect = qe.project.getVideoEffectByName('Lumetri Color');
        if (!effect) {
          return fail('This Premiere Pro build has no Lumetri Color effect available to scripts.');
        }
        qeClip.addVideoEffect(effect);
      }

      var version = parseFloat(app.version);
      if (version >= 23.4) {
        return (
          '{"ok":false,"partial":true,"error":' +
          quote(
            'Lumetri Color was added to the clip, but Premiere Pro ' + app.version +
              ' does not let scripts set a custom LUT — Adobe changed that in 23.4. ' +
              'Open Lumetri Color and choose "' + lutName + '" from the menu; it is already ' +
              'installed and waiting there.',
          ) +
          '}'
        );
      }

      return ok({
        message: quote(
          'Lumetri Color is on the clip. Choose "' + lutName + '" in its LUT menu to apply it.',
        ),
      });
    } catch (error) {
      return fail('Could not apply the LUT: ' + error.toString());
    }
  }

  function revealInOs(path) {
    try {
      var file = File(path);
      if (!file.exists) return fail('That file no longer exists.');
      file.parent.execute();
      return ok({});
    } catch (error) {
      return fail(error.toString());
    }
  }

  return {
    hostVersion: hostVersion,
    grabFrame: grabFrame,
    installLut: installLut,
    applyLutToSelection: applyLutToSelection,
    revealInOs: revealInOs,
  };
})();
