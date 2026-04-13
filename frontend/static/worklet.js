/**
 * AudioWorklet processor: collects input samples, resamples to 16 kHz if needed,
 * and posts Float32Array chunks (~100 ms) to the main thread.
 *
 * The AudioContext may be created at any sample rate (48000 on most browsers/devices).
 * We downsample to 16000 here so the server always receives 16 kHz PCM.
 */
class PcmSender extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // sampleRate is a global provided by the AudioWorklet scope
    this._inputRate = sampleRate;          // e.g. 48000
    this._targetRate = 16000;
    this._ratio = this._inputRate / this._targetRate;  // e.g. 3.0

    // Buffer outgoing 16 kHz samples; flush every ~100 ms = 1600 samples
    this._outBuf = [];
    this._flushSize = 1600;

    // Simple linear interpolation state
    this._phase = 0;
    this._prevSample = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    // Downsample via linear interpolation
    for (let i = 0; i < ch.length; i++) {
      const cur = ch[i];
      // Emit all target samples that fall between prevSample and cur
      while (this._phase < 1.0) {
        this._outBuf.push(this._prevSample + (cur - this._prevSample) * this._phase);
        this._phase += this._ratio;
      }
      this._phase -= 1.0;
      this._prevSample = cur;
    }

    // Flush when we have enough
    while (this._outBuf.length >= this._flushSize) {
      const chunk = new Float32Array(this._outBuf.splice(0, this._flushSize));
      this.port.postMessage(chunk.buffer, [chunk.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-sender', PcmSender);
