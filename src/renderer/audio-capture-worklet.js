// AudioWorkletProcessor for mic capture.
//
// Runs on the audio rendering thread (not the renderer's main JS thread),
// which is what the deprecated ScriptProcessorNode it replaces failed to
// do — that one ran on the UI thread and was a documented source of
// crackle / dropouts / stutter under load.
//
// The host renderer toggles capture by posting 'start' / 'stop' messages
// to this processor's port; while 'started', every render quantum's
// Float32 input is converted to Int16 PCM and posted back via the port.
// While 'stopped', process() returns immediately so the audio thread
// stays cheap. The graph itself is left intact across PTT turns so we
// don't pay getUserMedia / AudioContext startup latency every press.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._enabled = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this._enabled = true;
      else if (e.data === 'stop') this._enabled = false;
    };
  }

  process(inputs) {
    if (!this._enabled) return true;
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const float32 = input[0];
    const pcm16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    // Transfer the buffer rather than copy — the renderer's onmessage
    // handler ships it straight to main via IPC and never touches it
    // again, so transfer ownership is safe and zero-copy.
    this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
