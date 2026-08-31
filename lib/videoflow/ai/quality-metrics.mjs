function assertSameLength(a, b) {
  if (a.length !== b.length || !a.length) throw new Error("Metric inputs must have the same non-zero length.");
}

export function calculatePsnr(actual, reference, peak = 255) {
  assertSameLength(actual, reference);
  let squaredError = 0;
  for (let index = 0; index < actual.length; index += 1) squaredError += (Number(actual[index]) - Number(reference[index])) ** 2;
  const mse = squaredError / actual.length;
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((peak * peak) / mse);
}

export function calculateSsim(actual, reference, peak = 255) {
  assertSameLength(actual, reference);
  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < actual.length; index += 1) {
    meanA += Number(actual[index]);
    meanB += Number(reference[index]);
  }
  meanA /= actual.length;
  meanB /= actual.length;
  let varianceA = 0;
  let varianceB = 0;
  let covariance = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const da = Number(actual[index]) - meanA;
    const db = Number(reference[index]) - meanB;
    varianceA += da * da;
    varianceB += db * db;
    covariance += da * db;
  }
  const denominator = Math.max(1, actual.length - 1);
  varianceA /= denominator;
  varianceB /= denominator;
  covariance /= denominator;
  const c1 = (0.01 * peak) ** 2;
  const c2 = (0.03 * peak) ** 2;
  return ((2 * meanA * meanB + c1) * (2 * covariance + c2)) /
    ((meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2));
}

export function outsideRoiMeanAbsoluteError(actualRgba, referenceRgba, width, height, roi) {
  assertSameLength(actualRgba, referenceRgba);
  let error = 0;
  let samples = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= roi.x && x < roi.x + roi.width && y >= roi.y && y < roi.y + roi.height) continue;
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        error += Math.abs(Number(actualRgba[index + channel]) - Number(referenceRgba[index + channel]));
        samples += 1;
      }
    }
  }
  return samples ? error / samples : 0;
}

export function temporalInstability(frames) {
  if (frames.length < 2) return 0;
  let difference = 0;
  let samples = 0;
  for (let frame = 1; frame < frames.length; frame += 1) {
    assertSameLength(frames[frame - 1], frames[frame]);
    for (let index = 0; index < frames[frame].length; index += 1) {
      difference += Math.abs(Number(frames[frame][index]) - Number(frames[frame - 1][index]));
      samples += 1;
    }
  }
  return samples ? difference / samples : 0;
}

export function trackingMetrics(actual, expected) {
  if (actual.length !== expected.length || !actual.length) throw new Error("Tracking metric inputs must align.");
  let centerError = 0;
  let iou = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const a = actual[index];
    const e = expected[index];
    centerError += Math.hypot((a.x + a.width / 2) - (e.x + e.width / 2), (a.y + a.height / 2) - (e.y + e.height / 2));
    const intersectionWidth = Math.max(0, Math.min(a.x + a.width, e.x + e.width) - Math.max(a.x, e.x));
    const intersectionHeight = Math.max(0, Math.min(a.y + a.height, e.y + e.height) - Math.max(a.y, e.y));
    const intersection = intersectionWidth * intersectionHeight;
    const union = a.width * a.height + e.width * e.height - intersection;
    iou += union ? intersection / union : 0;
  }
  return { meanCenterError: centerError / actual.length, meanIoU: iou / actual.length };
}
