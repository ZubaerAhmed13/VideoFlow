#!/usr/bin/env bash
set -euo pipefail

MODEL_URL="https://huggingface.co/g-ronimo/lama/resolve/main/lama_512_int8.onnx?download=true"
MODEL_SHA256="cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe"
MODEL_SIZE="62074990"
ORT_VERSION="1.29.0"

mkdir -p public/models public/vendor/onnx .tmp-ai-pack

node scripts/restore-large-assets.mjs --if-present

model_is_valid=0
if [[ -f public/models/lama-512-int8.onnx ]] \
  && [[ "$(stat -c '%s' public/models/lama-512-int8.onnx)" == "${MODEL_SIZE}" ]] \
  && echo "${MODEL_SHA256}  public/models/lama-512-int8.onnx" | sha256sum --check --strict >/dev/null 2>&1; then
  model_is_valid=1
fi

runtime_is_complete=1
for name in \
  ort.webgpu.bundle.min.mjs \
  ort-wasm-simd-threaded.jsep.mjs \
  ort-wasm-simd-threaded.jsep.wasm \
  ort-wasm-simd-threaded.mjs \
  ort-wasm-simd-threaded.wasm
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
  for name in \
    ort.webgpu.bundle.min.mjs \
    ort-wasm-simd-threaded.jsep.mjs \
    ort-wasm-simd-threaded.jsep.wasm \
    ort-wasm-simd-threaded.mjs \
    ort-wasm-simd-threaded.wasm
  do
    source_path=".tmp-ai-pack/package/dist/${name}"
    [[ -f "${source_path}" ]] || { echo "Missing ONNX Runtime asset: ${name}" >&2; exit 65; }
    cp "${source_path}" "public/vendor/onnx/${name}"
  done
fi

if [[ "${model_is_valid}" == "1" ]]; then
  echo "[ai] using bundled checksum-pinned LaMa model"
else
  echo "[ai] downloading checksum-pinned LaMa model"
  curl --fail --location --retry 2 --connect-timeout 30 --max-time 300 \
    --output public/models/lama-512-int8.onnx "${MODEL_URL}"
fi
echo "${MODEL_SHA256}  public/models/lama-512-int8.onnx" | sha256sum --check --strict
[[ "$(stat -c '%s' public/models/lama-512-int8.onnx)" == "${MODEL_SIZE}" ]] || { echo "AI model size mismatch" >&2; exit 65; }
rm -rf .tmp-ai-pack

echo "[ai] model/runtime pack staged and verified"
