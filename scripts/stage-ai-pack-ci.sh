#!/usr/bin/env bash
set -euo pipefail

ORT_VERSION="1.29.0"
FIXED_MODEL_URL="https://huggingface.co/g-ronimo/lama/resolve/main/lama_512_int8.onnx?download=true"
FIXED_MODEL_SHA256="cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe"
FIXED_MODEL_SIZE="62074990"
DYNAMIC_MODEL_URL="https://huggingface.co/g-ronimo/lama/resolve/main/lama_int8.onnx?download=true"
DYNAMIC_MODEL_SHA256="1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972"
DYNAMIC_MODEL_SIZE="61512617"

mkdir -p public/models public/vendor/onnx .tmp-ai-pack
node scripts/restore-large-assets.mjs --if-present

runtime_is_complete=1
for name in   ort.wasm.bundle.min.mjs   ort.webgpu.bundle.min.mjs   ort-wasm-simd-threaded.asyncify.mjs   ort-wasm-simd-threaded.asyncify.wasm   ort-wasm-simd-threaded.jsep.mjs   ort-wasm-simd-threaded.jsep.wasm   ort-wasm-simd-threaded.jspi.mjs   ort-wasm-simd-threaded.jspi.wasm   ort-wasm-simd-threaded.mjs   ort-wasm-simd-threaded.wasm
do
  [[ -s "public/vendor/onnx/${name}" ]] || runtime_is_complete=0
done

if [[ "${runtime_is_complete}" == "1" ]]; then
  echo "[ai] using bundled ONNX Runtime Web ${ORT_VERSION}"
else
  echo "[ai] staging ONNX Runtime Web ${ORT_VERSION}"
  (
    cd .tmp-ai-pack
    npm pack "onnxruntime-web@${ORT_VERSION}" --silent > package-name.txt
    tar -xzf "$(cat package-name.txt)"
  )
  for name in     ort.wasm.bundle.min.mjs     ort.webgpu.bundle.min.mjs     ort-wasm-simd-threaded.asyncify.mjs     ort-wasm-simd-threaded.asyncify.wasm     ort-wasm-simd-threaded.jsep.mjs     ort-wasm-simd-threaded.jsep.wasm     ort-wasm-simd-threaded.jspi.mjs     ort-wasm-simd-threaded.jspi.wasm     ort-wasm-simd-threaded.mjs     ort-wasm-simd-threaded.wasm
  do
    source_path=".tmp-ai-pack/package/dist/${name}"
    [[ -f "${source_path}" ]] || { echo "Missing ONNX Runtime asset: ${name}" >&2; exit 65; }
    cp "${source_path}" "public/vendor/onnx/${name}"
  done
fi

stage_model() {
  local path="$1"
  local url="$2"
  local sha="$3"
  local size="$4"
  local label="$5"
  if [[ -f "${path}" ]]     && [[ "$(stat -c '%s' "${path}")" == "${size}" ]]     && echo "${sha}  ${path}" | sha256sum --check --strict >/dev/null 2>&1; then
    echo "[ai] using bundled checksum-pinned ${label}"
  else
    echo "[ai] downloading checksum-pinned ${label}"
    curl --fail --location --retry 2 --connect-timeout 30 --max-time 300 --output "${path}" "${url}"
  fi
  echo "${sha}  ${path}" | sha256sum --check --strict
  [[ "$(stat -c '%s' "${path}")" == "${size}" ]] || { echo "${label} size mismatch" >&2; exit 65; }
}

stage_model public/models/lama-512-int8.onnx "${FIXED_MODEL_URL}" "${FIXED_MODEL_SHA256}" "${FIXED_MODEL_SIZE}" "LaMa 512 INT8 production model"
stage_model public/models/lama-dynamic-int8.onnx "${DYNAMIC_MODEL_URL}" "${DYNAMIC_MODEL_SHA256}" "${DYNAMIC_MODEL_SIZE}" "LaMa Dynamic INT8 preview model"

rm -rf .tmp-ai-pack
echo "[ai] dual-model/runtime pack staged and verified"
