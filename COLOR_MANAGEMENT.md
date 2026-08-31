# VideoFlow Professional Core 1.0.0 — Colour Management

## Certified boundary

VideoFlow 1.0 preserves and validates **Rec.709 SDR** colour metadata for limited-range and full-range sources when that metadata is present. Unknown source values remain unknown; the application does not invent primaries, transfer, matrix, range, pixel format, or bit depth.

HDR is **NOT CERTIFIED** through the effects, Canvas, overlay, or AI reconstruction pipelines. BT.2020 with PQ (`smpte2084`) or HLG (`arib-std-b67`) is detected and shown before export. An untouched, container-compatible source may use Smart Copy and retain its original compressed HDR stream. Otherwise export is blocked instead of silently tone-mapping or reducing ten-bit HDR through an SDR path.

## Metadata flow

On import, local FFprobe inspection records available:

- `color_primaries`
- `color_transfer`
- `color_space` / matrix
- `color_range`
- pixel format and bit depth
- exact average frame rate

The record is saved with the media asset and its sampled fingerprint. Final SDR composition converts the RGBA working surface to YUV with an explicit Rec.709 matrix/range when known, then writes container/codec metadata using `-color_primaries`, `-color_trc`, `-colorspace`, and `-color_range`. Post-export validation probes those values and fails a preserve-colour job when known intended metadata differs.

## Full and limited range

The pipeline treats these as different representations:

| Source | FFmpeg range | Output conversion | Metadata |
| --- | --- | --- | --- |
| Rec.709 limited | `tv` | `out_color_matrix=bt709:out_range=tv` | Rec.709 / `tv` |
| Rec.709 full | `pc` | `out_color_matrix=bt709:out_range=pc` | Rec.709 / `pc` |

The controlled gate generates colour bars/test patterns, shadow/highlight content, and both range variants. Native output probing passed for both. Objective pixel metrics are content- and representation-sensitive; range-converted values must not be compared as naïve byte-for-byte RGB.

## Browser and AI limits

Browser decoding and Canvas generally expose an SDR RGB surface without complete control over display colour management. For this reason VideoFlow does not claim native HDR preservation after effects. LaMa consumes normalized SDR-compatible RGB; AI Reconstruction is therefore limited to SDR-compatible material in 1.0. Boundary luminance, chroma, and contrast matching corrects the reconstructed patch modestly, but it is not an ICC-managed grading pipeline.

The exact browser colour matrix remains a required Playwright/download probe gate. See `MEDIA_QUALITY_CERTIFICATION.md` and `RELEASE_CERTIFICATION.md` for observed versus blocked results.
