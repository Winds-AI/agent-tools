class VoiceNoteCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") this.flush();
    };
  }

  flush() {
    if (!this.offset) return;
    const chunk = this.buffer.slice(0, this.offset);
    this.offset = 0;
    this.port.postMessage(chunk, [chunk.buffer]);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let source = 0;
    while (source < channel.length) {
      const count = Math.min(channel.length - source, this.buffer.length - this.offset);
      this.buffer.set(channel.subarray(source, source + count), this.offset);
      source += count;
      this.offset += count;
      if (this.offset === this.buffer.length) {
        const chunk = this.buffer;
        this.buffer = new Float32Array(4096);
        this.offset = 0;
        this.port.postMessage(chunk, [chunk.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("voice-note-capture", VoiceNoteCapture);
