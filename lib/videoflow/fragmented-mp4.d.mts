export interface Mp4FragmentState {
  initSegment: Uint8Array;
  trackTimescales: Map<number, number>;
  nextSequence: number;
}
export function parseBoxes(input: Uint8Array | ArrayBuffer, start?: number, end?: number): Array<{offset:number;size:number;type:string;headerSize:number;end:number}>;
export function inspectFragmentedMp4(input: Uint8Array | ArrayBuffer): {hasInit:boolean;fragmentCount:number;mediaDataCount:number;types:string[]};
export function createFragmentedMp4State(firstSegmentInput: Uint8Array | ArrayBuffer): Mp4FragmentState;
export function mediaChunksForSegment(segmentInput: Uint8Array | ArrayBuffer, state: Mp4FragmentState, offsetSeconds?: number): Uint8Array[];
export function combineFragmentedMp4Segments(segments: Array<Uint8Array | ArrayBuffer>, offsets?: number[]): Uint8Array;
export function makeMp4FragmentArgs(args: string[], frameRate: number, segmentDuration: number): string[];
export function assertCompatibleFragmentInit(segmentInput: Uint8Array | ArrayBuffer, state: Mp4FragmentState): boolean;
