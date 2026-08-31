export function blendTemporal(current: ImageData, previous: ImageData | null, strength: number): ImageData {
  if (!previous || previous.width !== current.width || previous.height !== current.height || strength <= 0) return current;
  const alpha = Math.max(0, Math.min(0.65, strength));
  const out = new ImageData(current.width, current.height);
  for (let i = 0; i < current.data.length; i += 4) {
    out.data[i] = current.data[i] * (1 - alpha) + previous.data[i] * alpha;
    out.data[i + 1] = current.data[i + 1] * (1 - alpha) + previous.data[i + 1] * alpha;
    out.data[i + 2] = current.data[i + 2] * (1 - alpha) + previous.data[i + 2] * alpha;
    out.data[i + 3] = 255;
  }
  return out;
}
