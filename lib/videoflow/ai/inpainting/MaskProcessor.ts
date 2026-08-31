import type { ROI, ROITransform } from "../types";

export function buildModelMask(mask: { x: number; y: number; width: number; height: number; shape: "rectangle" | "ellipse" }, roi: ROI, transform: ROITransform, expansion = 8): Float32Array {
  const output = new Float32Array(transform.modelWidth * transform.modelHeight);
  const sx = transform.scaledWidth / roi.width;
  const sy = transform.scaledHeight / roi.height;
  const x0 = Math.max(0, transform.paddingLeft + (mask.x * roi.sourceWidth - roi.x) * sx - expansion);
  const y0 = Math.max(0, transform.paddingTop + (mask.y * roi.sourceHeight - roi.y) * sy - expansion);
  const x1 = Math.min(transform.modelWidth, transform.paddingLeft + ((mask.x + mask.width) * roi.sourceWidth - roi.x) * sx + expansion);
  const y1 = Math.min(transform.modelHeight, transform.paddingTop + ((mask.y + mask.height) * roi.sourceHeight - roi.y) * sy + expansion);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(1, (x1 - x0) / 2), ry = Math.max(1, (y1 - y0) / 2);
  for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
    const inside = mask.shape === "ellipse" ? ((x - cx) ** 2) / (rx ** 2) + ((y - cy) ** 2) / (ry ** 2) <= 1 : true;
    if (inside && x >= 0 && y >= 0 && x < transform.modelWidth && y < transform.modelHeight) output[y * transform.modelWidth + x] = 1;
  }
  return output;
}
