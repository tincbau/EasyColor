/**
 * Panel-side glue for the EasyColor Premiere extension.
 *
 * Loaded before the app bundle, it installs `window.easycolorPremiere`. The
 * React UI looks for that and shows its Premiere features only when it is
 * present, which is how one build serves the browser, Electron and this
 * panel without any of them carrying the others' code.
 *
 * This deliberately does not use Adobe's CSInterface.js. Everything the
 * panel needs is three calls on `window.__adobe_cep__`, and depending on a
 * vendored copy of a library for that means shipping — and having to keep
 * updating — a few thousand lines to gain nothing.
 */

(function () {
  'use strict';

  var cep = window.__adobe_cep__;
  if (!cep) {
    // Running outside Premiere, e.g. someone opened index.html directly.
    // Leaving the bridge undefined makes the UI behave exactly like the web
    // build, which is the right outcome.
    return;
  }

  /** Run ExtendScript and resolve with its return value as a string. */
  function evalScript(script) {
    return new Promise(function (resolve, reject) {
      try {
        cep.evalScript(script, function (result) {
          // ExtendScript signals a thrown error with this literal string.
          if (result === 'EvalScript error.') {
            reject(new Error('Premiere could not run the panel script. Reload the panel.'));
            return;
          }
          resolve(result);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /** Run a host function that returns our JSON envelope, and unwrap it. */
  function call(expression) {
    return evalScript(expression).then(function (raw) {
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error('Unexpected reply from Premiere: ' + String(raw).slice(0, 200));
      }
      if (!parsed.ok && !parsed.partial) throw new Error(parsed.error || 'Unknown error.');
      return parsed;
    });
  }

  /** ExtendScript string literal escaping, for values crossing the boundary. */
  function literal(value) {
    return JSON.stringify(String(value));
  }

  var hostVersion = 'unknown';
  evalScript('EasyColor.hostVersion()')
    .then(function (raw) {
      try {
        hostVersion = JSON.parse(raw).version || 'unknown';
      } catch (error) {
        /* leave it as unknown */
      }
    })
    .catch(function () {
      /* leave it as unknown */
    });

  window.easycolorPremiere = {
    isPremiere: true,

    get hostVersion() {
      return hostVersion;
    },

    grabFrame: function () {
      return call('EasyColor.grabFrame()').then(function (result) {
        return {
          url: result.url,
          path: result.path,
          clip: result.clip || null,
        };
      });
    },

    installLut: function (name, cubeText, folder) {
      // A 65-cube is around 2MB of text. It crosses the boundary as an
      // ExtendScript string literal, which is slow but is the only channel
      // CEP offers without also demanding Node integration — and demanding
      // that would make the panel refuse to load on locked-down machines.
      var script =
        'EasyColor.installLut(' +
        literal(name) + ',' +
        literal(cubeText) + ',' +
        literal(folder) +
        ')';

      return call(script).then(function (result) {
        return {
          ok: true,
          path: result.path,
          folder: result.folder,
          nextStep:
            result.folder === 'Technical'
              ? 'Open Lumetri Color → Basic Correction → Input LUT and pick "' + name + '".'
              : 'Open Lumetri Color → Creative → Look and pick "' + name + '".',
        };
      });
    },

    applyLutToSelection: function (lutName) {
      return evalScript('EasyColor.applyLutToSelection(' + literal(lutName) + ')').then(
        function (raw) {
          var parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            return { ok: false, message: 'Unexpected reply from Premiere.' };
          }
          return {
            ok: Boolean(parsed.ok),
            message: parsed.message || parsed.error || '',
          };
        },
      );
    },

    revealInOs: function (path) {
      return call('EasyColor.revealInOs(' + literal(path) + ')').then(function () {});
    },

    evalScript: evalScript,
  };
})();
