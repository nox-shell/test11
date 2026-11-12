/* ==========================================================================
   Camera — getUserMedia lifecycle, capability negotiation and hardware
   controls (torch, zoom, continuous autofocus, tap-to-focus).
   ========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Camera = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function safeCaps(track) {
    try {
      return (track.getCapabilities && track.getCapabilities()) || {};
    } catch (err) {
      return {};
    }
  }

  function safeSettings(track) {
    try {
      return (track.getSettings && track.getSettings()) || {};
    } catch (err) {
      return {};
    }
  }

  async function applyAdvanced(track, constraints) {
    if (!track || track.readyState !== 'live') return false;
    try {
      await track.applyConstraints({ advanced: constraints });
      return true;
    } catch (err) {
      return false;
    }
  }

  function create(videoEl) {
    var track = null;
    var stream = null;
    var caps = {};
    var focusTimer = 0;
    var deviceId = null;
    var facing = 'environment';
    var torchOn = false;
    var zoomWanted = 1;

    function stopFocusPulse() {
      if (focusTimer) {
        clearInterval(focusTimer);
        focusTimer = 0;
      }
    }

    /* Some platforms expose single-shot focus only. Re-triggering it on a
       slow timer approximates continuous autofocus for a moving handheld. */
    function startFocusPulse() {
      stopFocusPulse();
      focusTimer = setInterval(function () {
        applyAdvanced(track, [{ focusMode: 'single-shot' }]);
      }, 1400);
    }

    async function tuneFocus() {
      var modes = caps.focusMode || [];
      if (modes.indexOf('continuous') !== -1) {
        var ok = await applyAdvanced(track, [{ focusMode: 'continuous' }]);
        if (ok) return 'continuous';
      }
      if (modes.indexOf('single-shot') !== -1) {
        await applyAdvanced(track, [{ focusMode: 'single-shot' }]);
        startFocusPulse();
        return 'pulse';
      }
      return 'native';
    }

    /* Ask for the largest sensor mode the driver will give us. */
    async function maximiseResolution() {
      var w = caps.width && caps.width.max;
      var h = caps.height && caps.height.max;
      if (!w || !h) return;
      try {
        await track.applyConstraints({
          width: { ideal: w },
          height: { ideal: h },
          frameRate: { ideal: 30 },
        });
      } catch (err) {
        /* keep the negotiated default */
      }
    }

    async function attach(newStream, newTrack) {
      stream = newStream;
      track = newTrack;
      caps = safeCaps(track);

      try {
        if ('resizeMode' in caps) {
          await applyAdvanced(track, [{ resizeMode: 'none' }]); // no downscaling
        }
      } catch (err) { /* ignore */ }

      await maximiseResolution();

      videoEl.srcObject = stream;
      videoEl.setAttribute('playsinline', '');
      videoEl.muted = true;
      try {
        await videoEl.play();
      } catch (err) {
        /* autoplay policies — the start button already provides a gesture */
      }

      await tuneFocus();
      if (torchOn) await applyAdvanced(track, [{ torch: true }]);
      await applyZoom(zoomWanted);

      var s = safeSettings(track);
      return {
        width: videoEl.videoWidth || s.width || 0,
        height: videoEl.videoHeight || s.height || 0,
        caps: caps,
        settings: s,
      };
    }

    async function open(constraints) {
      var s = await navigator.mediaDevices.getUserMedia(constraints);
      var t = s.getVideoTracks()[0];
      if (!t) throw new Error('No video track available.');
      return { stream: s, track: t };
    }

    function baseConstraints() {
      var video = {};
      if (deviceId) video.deviceId = { exact: deviceId };
      else video.facingMode = { ideal: facing };
      return {
        audio: false,
        video: Object.assign(video, {
          width: { ideal: 4096 },
          height: { ideal: 3072 },
          frameRate: { ideal: 30 },
        }),
      };
    }

    async function applyZoom(mult) {
      zoomWanted = mult;
      var z = caps.zoom;
      if (!z) return false;
      var target;
      if (z.min >= 10) target = Math.round(mult * 100); // percentage-style drivers
      else target = mult;
      target = Math.min(z.max, Math.max(z.min, target));
      return applyAdvanced(track, [{ zoom: target }]);
    }

    return {
      get track() {
        return track;
      },
      get caps() {
        return caps;
      },
      get settings() {
        return safeSettings(track);
      },
      get isRunning() {
        return !!track && track.readyState === 'live';
      },
      get deviceId() {
        return deviceId || safeSettings(track).deviceId || null;
      },
      get hasTorch() {
        return !!caps.torch;
      },
      get hasZoom() {
        return !!caps.zoom;
      },
      get hasFocus() {
        return !!(caps.focusMode && caps.focusMode.length);
      },

      async start() {
        var opened;
        try {
          opened = await open(baseConstraints());
        } catch (err) {
          // Some drivers reject the large ideal sizes outright.
          if (err && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError')) {
            var fallback = { audio: false, video: {} };
            if (deviceId) fallback.video.deviceId = { exact: deviceId };
            else fallback.video.facingMode = { ideal: facing };
            opened = await open(fallback);
          } else {
            throw err;
          }
        }
        stream = opened.stream;
        track = opened.track;
        var info = await attach(stream, track);
        if (deviceId == null) deviceId = safeSettings(track).deviceId || null;
        return info;
      },

      async switchTo(id) {
        var previous = this.isRunning ? safeSettings(track) : null;
        if (previous && !id) {
          // No target id: cycle to the next physical camera.
          var devices = await this.listCameras();
          if (devices.length > 1) {
            var idx = devices.findIndex(function (d) {
              return d.deviceId === previous.deviceId;
            });
            id = devices[(idx + 1) % devices.length].deviceId;
          } else {
            id = previous.deviceId;
            facing = facing === 'environment' ? 'user' : 'environment';
          }
        }

        this.stop();
        if (id) {
          deviceId = id;
        } else {
          // Flip by facing mode, so drop any pinned device id.
          deviceId = null;
          facing = facing === 'environment' ? 'user' : 'environment';
        }
        torchOn = false;
        var info = await this.start();
        return info;
      },

      async listCameras() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
        var devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(function (d) {
          return d.kind === 'videoinput';
        });
      },

      async setTorch(on) {
        if (!caps.torch) return false;
        var ok = await applyAdvanced(track, [{ torch: !!on }]);
        if (ok) torchOn = !!on;
        return ok;
      },

      setZoom: applyZoom,

      /** Try to pull focus to the closest distance for tiny print. */
      async setMacro(on) {
        var modes = caps.focusMode || [];
        if (on && modes.indexOf('manual') !== -1 && caps.focusDistance) {
          var moved = await applyAdvanced(track, [{
            focusMode: 'manual',
            focusDistance: caps.focusDistance.min,
          }]);
          if (moved) return true;
        }
        if (!on) await tuneFocus();
        return false;
      },

      /** Pinch/tap focus at a normalised point (0..1) of the frame. */
      async focusAt(x, y) {
        var modes = caps.focusMode || [];
        var point = [{ x: x, y: y }];
        if (caps.pointsOfInterest && modes.indexOf('single-shot') !== -1) {
          var ok = await applyAdvanced(track, [{ pointsOfInterest: point, focusMode: 'single-shot' }]);
          if (ok) return true;
        }
        if (caps.pointsOfInterest) {
          var ok2 = await applyAdvanced(track, [{ pointsOfInterest: point }]);
          if (ok2) return true;
        }
        if (modes.indexOf('single-shot') !== -1) {
          return applyAdvanced(track, [{ focusMode: 'single-shot' }]);
        }
        return false;
      },

      stop() {
        stopFocusPulse();
        if (stream) {
          stream.getTracks().forEach(function (t) {
            t.stop();
          });
        }
        if (videoEl) videoEl.srcObject = null;
        stream = null;
        track = null;
        caps = {};
        torchOn = false;
      },

      resetZoom: function () {
        return applyZoom(1);
      },
    };
  }

  return { create: create };
});
