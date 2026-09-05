// Counter windows must never span app closure, focus changes, or recording restarts.
class CaptureHealth {
  constructor() {
    this.reset();
    this.lastWarningAt = -Infinity;
  }

  reset() {
    this.previous = null;
    this.window = { startedAt: 0, renderingLag: 0, encoderDrops: 0 };
    this.focusKey = null;
    this.focusedAt = 0;
    this.previousSampleAt = 0;
  }

  inspect(status, { applications, targets, sessionId, now = Date.now() }) {
    if (!status.recording) {
      this.reset();
      return null;
    }
    const names = new Set(targets.map(name => name.toLowerCase()));
    const focused = applications.find(application => names.has(application.name.toLowerCase()) && application.isForeground);
    // Empty targets mean intentional desktop recording, which needs no game focus.
    const focusKey = names.size ? focused?.name.toLowerCase() : 'desktop';
    const key = focusKey ? `${sessionId}:${focusKey}` : null;
    if (!key || key !== this.focusKey) {
      this.reset();
      this.focusKey = key;
      this.focusedAt = now;
    }
    const current = {
      rendered: Number(status.renderedFrames) || 0,
      lagged: Number(status.laggedFrames) || 0,
      output: Number(status.outputFrames) || 0,
      dropped: Number(status.droppedFrames) || 0
    };
    const previous = this.previous;
    const previousSampleAt = this.previousSampleAt;
    this.previous = current;
    this.previousSampleAt = now;
    if (!key || (names.size && now - this.focusedAt < 10000)) return null;
    if (!previous || Object.keys(current).some(counter => current[counter] < previous[counter])) {
      this.window = { startedAt: now, renderingLag: 0, encoderDrops: 0 };
      return null;
    }
    // Skip the interval crossing the end of the focus grace period as well.
    if (names.size && previousSampleAt < this.focusedAt + 10000) return null;
    const renderingLag = current.lagged - previous.lagged;
    const encoderDrops = current.dropped - previous.dropped;
    if (!renderingLag && !encoderDrops) return null;
    if (now - this.window.startedAt > 60000) this.window = { startedAt: now, renderingLag: 0, encoderDrops: 0 };
    this.window.renderingLag += renderingLag;
    this.window.encoderDrops += encoderDrops;
    const noticeable = renderingLag >= 6 || encoderDrops >= 3 || this.window.renderingLag >= 12 || this.window.encoderDrops >= 6;
    const warning = noticeable && now - this.lastWarningAt >= 60000;
    const result = { renderingLag, encoderDrops, warning, windowRenderingLag: this.window.renderingLag, windowEncoderDrops: this.window.encoderDrops };
    if (warning) {
      this.lastWarningAt = now;
      this.window = { startedAt: now, renderingLag: 0, encoderDrops: 0 };
    }
    return result;
  }
}

module.exports = { CaptureHealth };
