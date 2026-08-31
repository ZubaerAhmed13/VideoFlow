export function calculatePsnr(actual: ArrayLike<number>, reference: ArrayLike<number>, peak?: number): number;
export function calculateSsim(actual: ArrayLike<number>, reference: ArrayLike<number>, peak?: number): number;
export function outsideRoiMeanAbsoluteError(actualRgba: ArrayLike<number>, referenceRgba: ArrayLike<number>, width: number, height: number, roi: { x: number; y: number; width: number; height: number }): number;
export function temporalInstability(frames: Array<ArrayLike<number>>): number;
export function trackingMetrics(actual: Array<{ x: number; y: number; width: number; height: number }>, expected: Array<{ x: number; y: number; width: number; height: number }>): { meanCenterError: number; meanIoU: number };
