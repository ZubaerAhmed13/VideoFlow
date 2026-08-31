import { clamp } from "./core.mjs";
import { videoFlowResources } from "./resource-manager";

export interface AudioProcessOptions {
  start: number;
  end: number;
  speed: number;
  pitchSemitones: number;
  gain: number;
  reverse: boolean;
  normalize: boolean;
  equalizer: number[];
  fadeIn?: number;
  fadeOut?: number;
}

function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const array = new ArrayBuffer(44 + frames * blockAlign);
  const view = new DataView(array);
  const write = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + frames * blockAlign, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, frames * blockAlign, true);
  const channelData = Array.from({ length: channels }, (_, index) => buffer.getChannelData(index));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = clamp(channelData[channel][frame], -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([array], { type: "audio/wav" });
}

export async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void context.close();
  }
}

export async function processAudio(blob: Blob, options: AudioProcessOptions, signal: AbortSignal, onProgress: (value: number) => void): Promise<Blob> {
  if (signal.aborted) throw new DOMException("Audio processing cancelled.", "AbortError");
  onProgress(0.08);
  const decoded = await decodeAudio(blob);
  const start = clamp(options.start, 0, Math.max(0, decoded.duration - 0.01));
  const end = clamp(options.end || decoded.duration, start + 0.01, decoded.duration);
  const sourceFrames = Math.max(1, Math.floor((end - start) * decoded.sampleRate));
  const source = new AudioBuffer({ length: sourceFrames, numberOfChannels: decoded.numberOfChannels, sampleRate: decoded.sampleRate });
  const offset = Math.floor(start * decoded.sampleRate);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const input = decoded.getChannelData(channel).subarray(offset, offset + sourceFrames);
    if (options.reverse) source.getChannelData(channel).set(Float32Array.from(input).reverse());
    else source.copyToChannel(input, channel);
  }
  onProgress(0.25);
  if (signal.aborted) throw new DOMException("Audio processing cancelled.", "AbortError");
  const playbackRate = clamp(options.speed * Math.pow(2, options.pitchSemitones / 12), 0.125, 8);
  const outputFrames = Math.max(1, Math.ceil(sourceFrames / playbackRate));
  const offline = new OfflineAudioContext(source.numberOfChannels, outputFrames, source.sampleRate);
  const sourceNode = offline.createBufferSource();
  sourceNode.buffer = source;
  sourceNode.playbackRate.value = playbackRate;
  let tail: AudioNode = sourceNode;
  const frequencies = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
  frequencies.forEach((frequency, index) => {
    const gain = options.equalizer[index] ?? 0;
    if (Math.abs(gain) < 0.01) return;
    const filter = offline.createBiquadFilter();
    filter.type = "peaking"; filter.frequency.value = frequency; filter.Q.value = 1; filter.gain.value = clamp(gain, -12, 12);
    tail.connect(filter); tail = filter;
  });
  const gainNode = offline.createGain();
  const targetGain = clamp(options.gain, 0, 4);
  const renderedDuration = outputFrames / source.sampleRate;
  const fadeIn = clamp(options.fadeIn ?? 0, 0, renderedDuration);
  const fadeOut = clamp(options.fadeOut ?? 0, 0, Math.max(0, renderedDuration - fadeIn));
  gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : targetGain, 0);
  if (fadeIn > 0) gainNode.gain.linearRampToValueAtTime(targetGain, fadeIn);
  if (fadeOut > 0) {
    const fadeStart = Math.max(fadeIn, renderedDuration - fadeOut);
    gainNode.gain.setValueAtTime(targetGain, fadeStart);
    gainNode.gain.linearRampToValueAtTime(0, renderedDuration);
  }
  tail.connect(gainNode).connect(offline.destination);
  sourceNode.start();
  const rendered = await offline.startRendering();
  onProgress(0.76);
  if (signal.aborted) throw new DOMException("Audio processing cancelled.", "AbortError");
  if (options.normalize) {
    let peak = 0;
    for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
      const data = rendered.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) peak = Math.max(peak, Math.abs(data[index]));
    }
    const factor = peak > 0 ? Math.min(8, 0.98 / peak) : 1;
    for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
      const data = rendered.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) data[index] *= factor;
    }
  }
  onProgress(0.9);
  const result = encodeWav(rendered);
  if (result.size <= 44) throw new Error("Audio output validation failed.");
  onProgress(1);
  return result;
}

export async function joinAudio(blobs: Blob[], normalize: boolean, signal: AbortSignal, onProgress: (value: number) => void): Promise<Blob> {
  if (!blobs.length) throw new Error("Choose at least one audio file.");
  const decoded: AudioBuffer[] = [];
  for (let index = 0; index < blobs.length; index += 1) {
    if (signal.aborted) throw new DOMException("Audio join cancelled.", "AbortError");
    decoded.push(await decodeAudio(blobs[index]));
    onProgress((index + 1) / blobs.length * 0.35);
  }
  const sampleRate = Math.max(...decoded.map((buffer) => buffer.sampleRate));
  const channels = Math.min(2, Math.max(...decoded.map((buffer) => buffer.numberOfChannels)));
  const totalFrames = decoded.reduce((sum, buffer) => sum + Math.ceil(buffer.duration * sampleRate), 0);
  const offline = new OfflineAudioContext(channels, totalFrames, sampleRate);
  let at = 0;
  for (const buffer of decoded) {
    const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start(at); at += buffer.duration;
  }
  const rendered = await offline.startRendering();
  if (normalize) {
    let peak = 0;
    for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) for (const sample of rendered.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample));
    const factor = peak > 0 ? Math.min(8, 0.98 / peak) : 1;
    for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) rendered.getChannelData(channel).forEach((sample, index, data) => { data[index] = sample * factor; });
  }
  onProgress(0.9);
  const result = encodeWav(rendered); onProgress(1); return result;
}

function waveformFromBuffer(buffer: AudioBuffer, points: number): number[] {
  const data = buffer.getChannelData(0);
  const safePoints = Math.max(16, Math.min(4096, Math.floor(points)));
  const block = Math.max(1, Math.floor(data.length / safePoints));
  return Array.from({ length: safePoints }, (_, index) => {
    let peak = 0;
    const start = index * block;
    for (let cursor = start; cursor < Math.min(data.length, start + block); cursor += 1)
      peak = Math.max(peak, Math.abs(data[cursor]));
    return peak;
  });
}

export async function waveform(blob: Blob, points = 240): Promise<number[]> {
  return videoFlowResources.run("waveform", async () => waveformFromBuffer(await decodeAudio(blob), points));
}

export async function waveformPyramid(
  blob: Blob,
  levels: number[] = [120, 480, 1920],
): Promise<Record<number, number[]>> {
  return videoFlowResources.run("waveform", async () => {
    const buffer = await decodeAudio(blob);
    return Object.fromEntries(
      [...new Set(levels.map((value) => Math.max(16, Math.min(4096, Math.floor(value)))))]
        .sort((a, b) => a - b)
        .map((points) => [points, waveformFromBuffer(buffer, points)]),
    );
  });
}
