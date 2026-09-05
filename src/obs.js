const childProcess = require('child_process');
const path = require('path');

class ObsController {
  constructor(onEvent, logger) {
    this.onEvent = onEvent;
    this.logger = logger;
    this.child = null;
    this.connected = false;
    this.stopping = false;
    this.nextRequestId = 0;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.settings = null;
    this.applications = [];
    this.availableEncoders = [];
    this.selectedEncoder = '';
    this.lastStatus = { connected: false, recording: false, replayBuffer: false, durationMs: 0, renderedFrames: 0, laggedFrames: 0, outputFrames: 0, droppedFrames: 0 };
  }

  request(command, data = {}, timeoutMs = 30000) {
    const child = this.child;
    if (!child?.stdin?.writable || child.stdin.destroyed || this.stopping) return Promise.reject(new Error('The Clips capture engine is offline.'));
    const id = ++this.nextRequestId;
    if (command !== 'status' && command !== 'microphoneLevel') {
      this.logger?.info('capture request', {
        id,
        command,
        directory: data.directory,
        microphoneDeviceId: data.microphoneDeviceId,
        microphoneVolumePercent: data.microphoneVolumePercent,
        applicationCount: data.applications?.length
      });
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const failure = new Error(`The Clips capture engine timed out while handling ${command}.`);
        reject(failure);

        // capture-host handles requests on one thread. If one libobs call wedges,
        // later requests cannot overtake it, so leaving the process alive only
        // produces an endless sequence of timeouts. Mark it offline immediately
        // and terminate it so the next capture attempt starts with a clean host.
        const child = this.child;
        this.logger?.error?.('capture engine became unresponsive', { id, command });
        this.handleExit(failure);
        if (child && !child.killed) child.kill?.();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      const failWrite = error => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
        this.handleChildError(child, error);
      };
      try {
        child.stdin.write(`${JSON.stringify({ id, command, ...data })}\n`, error => {
          if (error) failWrite(error);
        });
      } catch (error) {
        failWrite(error);
      }
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (this.stdoutBuffer.includes('\n')) {
      const newline = this.stdoutBuffer.indexOf('\n');
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(response.id);
      this.lastStatus = {
        connected: !!response.connected,
        recording: !!response.recording,
        replayBuffer: !!response.replayBuffer,
        durationMs: Number(response.durationMs) || 0,
        renderedFrames: Number(response.renderedFrames) || 0,
        laggedFrames: Number(response.laggedFrames) || 0,
        outputFrames: Number(response.outputFrames) || 0,
        droppedFrames: Number(response.droppedFrames) || 0
      };
      if (response.ok) pending.resolve(response);
      else {
        this.logger?.error('capture request failed', { id: response.id, error: response.error });
        pending.reject(new Error(response.error || 'The Clips capture engine failed.'));
      }
    }
  }

  handleExit(error) {
    const failure = error instanceof Error ? error : new Error('The Clips capture engine stopped unexpectedly.');
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(failure);
    }
    this.pending.clear();
    this.child = null;
    this.connected = false;
    this.lastStatus = { connected: false, recording: false, replayBuffer: false, durationMs: 0, renderedFrames: 0, laggedFrames: 0, outputFrames: 0, droppedFrames: 0 };
    this.onEvent?.();
  }

  handleChildError(child, error) {
    if (this.child !== child) return;
    this.logger?.error?.('capture engine transport failed', { message: error.message, code: error.code });
    this.handleExit(error);
    if (!child.killed) child.kill?.();
  }

  async connect({ executable, runtimeRoot, configRoot, settings }) {
    if (this.connected && this.child) return true;
    if (this.child) await this.disconnect();
    this.settings = { ...settings };
    this.stdoutBuffer = '';
    const child = childProcess.spawn(executable, [], {
      cwd: path.join(runtimeRoot, 'libobs', 'bin', '64bit'),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    this.stopping = false;
    // A failed write invokes its callback AND emits an error on stdin.
    // Keep this listener even after exit to absorb delayed pipe errors.
    child.stdin.on('error', error => this.handleChildError(child, error));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.handleStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      this.logger?.capture(chunk);
      if (process.env.CLIPS_CAPTURE_LOG === '1') process.stderr.write(chunk);
    });
    child.once('error', error => this.handleChildError(child, error));
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.handleExit(new Error(`The Clips capture engine exited (${signal || code}).`));
    });
    const [width, height] = String(settings.obsResolution).split('x').map(Number);
    try {
      const initialized = await this.request('initialize', {
        runtimeRoot,
        configRoot,
        width,
        height,
        fps: Number(settings.obsFps),
        quality: settings.obsRecordingQuality,
        encoder: settings.obsEncoder,
        format: settings.obsFormat,
        clipLengthSeconds: Number(settings.clipLengthSeconds)
      }, 60000);
      this.availableEncoders = Array.isArray(initialized.encoders) ? initialized.encoders : [];
      this.selectedEncoder = String(initialized.selectedEncoder || '');
      this.connected = true;
      this.lastStatus.connected = true;
      this.onEvent?.();
      return true;
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect() {
    const child = this.child;
    if (!child) return;
    if (this.stopping) return;
    const shutdown = this.request('shutdown', {}, 10000);
    this.stopping = true;
    this.connected = false;
    await shutdown.catch(() => {});
    if (this.child !== child) return;
    this.child = null;
    this.connected = false;
    if (!child.killed) child.kill();
    this.handleExit(new Error('The Clips capture engine was stopped.'));
  }

  async status() {
    if (!this.connected || !this.child) return { connected: false, recording: false, replayBuffer: false };
    try {
      await this.request('status');
      return { ...this.lastStatus };
    } catch {
      return { connected: false, recording: false, replayBuffer: false };
    }
  }

  async configureApplicationAudio(applications) {
    this.applications = applications.map(application => ({ ...application }));
  }

  async startSession(outputDirectory, activeGames = [], microphoneDeviceId = 'disabled', microphoneVolumePercent = 100, microphoneNoiseGateDb = -40, microphoneNvidiaNoiseRemoval = true, recording = true) {
    const video = new Set(activeGames.map(name => name.toLowerCase()));
    const applications = this.applications.map(application => ({
      ...application,
      captureVideo: video.has(application.name.toLowerCase()),
      captureDisplay: video.has(application.name.toLowerCase()) && !application.path,
      captureAudio: true
    }));
    if (!video.size) {
      applications.push({
        name: 'clips-desktop-capture',
        title: '',
        windowClass: '',
        path: '',
        bounds: null,
        captureVideo: true,
        captureDisplay: true,
        captureAudio: true
      });
    }
    await this.request('start', {
      directory: outputDirectory,
      applications,
      microphoneDeviceId,
      microphoneVolumePercent,
      microphoneNoiseGateDb,
      microphoneNvidiaNoiseRemoval,
      recording
    }, 45000);
  }

  async setMicrophoneVolume(percent) {
    if (!this.connected) return;
    await this.request('microphoneVolume', {
      microphoneVolumePercent: Math.min(200, Math.max(0, Number(percent) || 0))
    });
  }

  async setMicrophoneNoiseGate(thresholdDb) {
    if (!this.connected) return;
    await this.request('microphoneNoiseGate', {
      microphoneNoiseGateDb: Math.min(-5, Math.max(-60, Number(thresholdDb) || -40))
    });
  }

  async microphoneLevel() {
    if (!this.connected) return -60;
    const response = await this.request('microphoneLevel');
    return Math.min(0, Math.max(-60, Number(response.microphoneLevelDb) || -60));
  }

  async setMicrophoneNvidiaNoiseRemoval(enabled) {
    if (!this.connected) return;
    await this.request('microphoneNvidiaNoiseRemoval', { microphoneNvidiaNoiseRemoval: !!enabled });
  }

  async microphones() {
    if (!this.connected) return [];
    const response = await this.request('microphones');
    return Array.isArray(response.devices) ? response.devices : [];
  }

  async stopSession() {
    if (!this.connected) return;
    await this.request('stop', {}, 60000);
  }

  async stopRecording() {
    if (!this.connected) return;
    await this.request('stopRecording', {}, 60000);
  }

  async saveClip() {
    await this.request('save');
  }

  async applyRecordingSettings({ quality, encoder, resolution, fps, format, clipLengthSeconds }) {
    if (!this.connected) return;
    const [width, height] = String(resolution).split('x').map(Number);
    this.settings = {
      ...this.settings,
      obsRecordingQuality: quality,
      obsEncoder: encoder,
      obsResolution: resolution,
      obsFps: fps,
      obsFormat: format,
      clipLengthSeconds: clipLengthSeconds ?? this.settings?.clipLengthSeconds
    };
    const configured = await this.request('configure', {
      width,
      height,
      fps: Number(fps),
      quality,
      encoder,
      format,
      clipLengthSeconds: Number(this.settings.clipLengthSeconds)
    }, 60000);
    this.availableEncoders = Array.isArray(configured.encoders) ? configured.encoders : this.availableEncoders;
    this.selectedEncoder = String(configured.selectedEncoder || this.selectedEncoder);
  }

  async setReplayBufferDuration(seconds) {
    if (!this.settings) return;
    await this.applyRecordingSettings({
      quality: this.settings.obsRecordingQuality,
      encoder: this.settings.obsEncoder,
      resolution: this.settings.obsResolution,
      fps: this.settings.obsFps,
      format: this.settings.obsFormat,
      clipLengthSeconds: seconds
    });
  }
}

module.exports = { ObsController };
