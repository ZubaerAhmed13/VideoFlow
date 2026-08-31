const textDecoder = new TextDecoder("latin1");

function ensureBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError("Expected MP4 bytes as Uint8Array or ArrayBuffer.");
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function readU64(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = view.getBigUint64(offset, false);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MP4 box exceeds JavaScript safe integer range.");
  return Number(value);
}

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, false);
}

function writeU64(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(offset, BigInt(Math.max(0, Math.round(value))), false);
}

export function parseBoxes(input, start = 0, end) {
  const bytes = ensureBytes(input);
  const limit = end ?? bytes.byteLength;
  const boxes = [];
  let offset = start;
  while (offset + 8 <= limit) {
    let size = readU32(bytes, offset);
    const type = textDecoder.decode(bytes.subarray(offset + 4, offset + 8));
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > limit) throw new Error(`Invalid extended MP4 box ${type}.`);
      size = readU64(bytes, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = limit - offset;
    }
    if (size < headerSize || offset + size > limit) {
      throw new Error(`Invalid MP4 box ${type} at byte ${offset}.`);
    }
    boxes.push({ offset, size, type, headerSize, end: offset + size });
    offset += size;
  }
  if (offset !== limit) {
    const remainder = limit - offset;
    if (remainder > 0) throw new Error(`Trailing ${remainder} byte(s) after MP4 boxes.`);
  }
  return boxes;
}

function children(bytes, parent, type) {
  const result = parseBoxes(bytes, parent.offset + parent.headerSize, parent.end);
  return type ? result.filter((box) => box.type === type) : result;
}

function child(bytes, parent, type) {
  return children(bytes, parent, type)[0];
}

function concatenate(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseTrackTimescales(bytes) {
  const top = parseBoxes(bytes);
  const moov = top.find((box) => box.type === "moov");
  if (!moov) throw new Error("Fragmented MP4 initialization segment has no moov box.");
  const tracks = new Map();
  for (const trak of children(bytes, moov, "trak")) {
    const tkhd = child(bytes, trak, "tkhd");
    const mdia = child(bytes, trak, "mdia");
    const mdhd = mdia ? child(bytes, mdia, "mdhd") : null;
    if (!tkhd || !mdhd) continue;

    const tkhdFullBoxOffset = tkhd.offset + tkhd.headerSize;
    const tkhdVersion = bytes[tkhdFullBoxOffset];
    const trackIdOffset = tkhdFullBoxOffset + 4 + (tkhdVersion === 1 ? 16 : 8);
    const trackId = readU32(bytes, trackIdOffset);

    const mdhdFullBoxOffset = mdhd.offset + mdhd.headerSize;
    const mdhdVersion = bytes[mdhdFullBoxOffset];
    const timescaleOffset = mdhdFullBoxOffset + 4 + (mdhdVersion === 1 ? 16 : 8);
    const timescale = readU32(bytes, timescaleOffset);
    if (trackId && timescale) tracks.set(trackId, timescale);
  }
  if (!tracks.size) throw new Error("Fragmented MP4 track timescales could not be read.");
  return tracks;
}

function patchMoof(moofBytes, offsetSeconds, sequenceStart, trackTimescales) {
  const patched = new Uint8Array(moofBytes);
  const moof = parseBoxes(patched)[0];
  if (!moof || moof.type !== "moof") throw new Error("Expected a moof fragment.");
  const mfhd = child(patched, moof, "mfhd");
  let nextSequence = sequenceStart;
  if (mfhd) {
    writeU32(patched, mfhd.offset + mfhd.headerSize + 4, nextSequence);
    nextSequence += 1;
  }
  for (const traf of children(patched, moof, "traf")) {
    const tfhd = child(patched, traf, "tfhd");
    const tfdt = child(patched, traf, "tfdt");
    if (!tfhd || !tfdt) continue;
    const trackId = readU32(patched, tfhd.offset + tfhd.headerSize + 4);
    const timescale = trackTimescales.get(trackId);
    if (!timescale) throw new Error(`Unknown track ${trackId} in MP4 media fragment.`);
    const fullBoxOffset = tfdt.offset + tfdt.headerSize;
    const version = patched[fullBoxOffset];
    const decodeTimeOffset = fullBoxOffset + 4;
    const baseDecodeTime = version === 1 ? readU64(patched, decodeTimeOffset) : readU32(patched, decodeTimeOffset);
    const adjusted = baseDecodeTime + Math.round(Math.max(0, offsetSeconds) * timescale);
    if (version === 1) writeU64(patched, decodeTimeOffset, adjusted);
    else {
      if (adjusted > 0xffffffff) throw new Error("MP4 tfdt requires version 1 for this timeline duration.");
      writeU32(patched, decodeTimeOffset, adjusted);
    }
  }
  return { bytes: patched, nextSequence };
}

export function inspectFragmentedMp4(input) {
  const bytes = ensureBytes(input);
  const boxes = parseBoxes(bytes);
  const types = boxes.map((box) => box.type);
  const hasInit = types.includes("ftyp") && types.includes("moov");
  const fragmentCount = types.filter((type) => type === "moof").length;
  const mediaDataCount = types.filter((type) => type === "mdat").length;
  return { hasInit, fragmentCount, mediaDataCount, types };
}

export function createFragmentedMp4State(firstSegmentInput) {
  const bytes = ensureBytes(firstSegmentInput);
  const boxes = parseBoxes(bytes);
  const ftyp = boxes.find((box) => box.type === "ftyp");
  const moov = boxes.find((box) => box.type === "moov");
  if (!ftyp || !moov) throw new Error("The first fragmented MP4 segment must contain ftyp and moov boxes.");
  return {
    initSegment: concatenate([
      bytes.subarray(ftyp.offset, ftyp.end),
      bytes.subarray(moov.offset, moov.end),
    ]),
    trackTimescales: parseTrackTimescales(bytes),
    nextSequence: 1,
  };
}

export function mediaChunksForSegment(segmentInput, state, offsetSeconds = 0) {
  const bytes = ensureBytes(segmentInput);
  const boxes = parseBoxes(bytes);
  const chunks = [];
  let nextSequence = state.nextSequence;
  let pendingMoof = null;
  for (const box of boxes) {
    if (box.type === "moof") {
      if (pendingMoof) throw new Error("MP4 fragment is missing media data after moof.");
      const { bytes: patched, nextSequence: next } = patchMoof(
        bytes.subarray(box.offset, box.end),
        offsetSeconds,
        nextSequence,
        state.trackTimescales,
      );
      pendingMoof = patched;
      nextSequence = next;
    } else if (box.type === "mdat") {
      if (!pendingMoof) continue;
      chunks.push(pendingMoof, bytes.subarray(box.offset, box.end));
      pendingMoof = null;
    }
  }
  if (pendingMoof) throw new Error("MP4 fragment ended before its mdat box.");
  if (!chunks.length) throw new Error("No fragmented MP4 media data was produced.");
  state.nextSequence = nextSequence;
  return chunks;
}

export function combineFragmentedMp4Segments(segments, offsets) {
  if (!segments.length) throw new Error("At least one MP4 segment is required.");
  const first = ensureBytes(segments[0]);
  const state = createFragmentedMp4State(first);
  const chunks = [state.initSegment];
  for (let index = 0; index < segments.length; index += 1) {
    chunks.push(...mediaChunksForSegment(segments[index], state, offsets?.[index] ?? 0));
  }
  return concatenate(chunks);
}

export function makeMp4FragmentArgs(args, frameRate, segmentDuration) {
  const output = args.at(-1);
  if (typeof output !== "string") throw new Error("FFmpeg output argument is missing.");
  const result = [...args.slice(0, -1)];
  const movflagsIndex = result.findIndex((value) => value === "-movflags");
  if (movflagsIndex >= 0) result.splice(movflagsIndex, 2);
  const gop = Math.max(24, Math.ceil(Math.max(1, frameRate) * (Math.max(1, segmentDuration) + 1)));
  result.push(
    "-g", String(gop),
    "-keyint_min", String(gop),
    "-sc_threshold", "0",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
    output,
  );
  return result;
}

export function assertCompatibleFragmentInit(segmentInput, state) {
  const segmentTracks = parseTrackTimescales(ensureBytes(segmentInput));
  if (segmentTracks.size !== state.trackTimescales.size) throw new Error("MP4 segment track count changed during export.");
  for (const [trackId, timescale] of state.trackTimescales) {
    if (segmentTracks.get(trackId) !== timescale) throw new Error(`MP4 track ${trackId} changed timescale during export.`);
  }
  return true;
}
