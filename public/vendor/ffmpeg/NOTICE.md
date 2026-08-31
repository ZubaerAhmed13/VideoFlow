# FFmpeg WebAssembly notices

VideoFlow Professional Core bundles these unmodified npm release assets for local browser processing:

- `@ffmpeg/ffmpeg` 0.12.15 — MIT license — <https://github.com/ffmpegwasm/ffmpeg.wasm>
- `@ffmpeg/core` 0.12.10 — GPL-2.0-or-later — <https://github.com/ffmpegwasm/ffmpeg.wasm/releases>

The complete GNU GPL version 2 text is included as `COPYING.GPL-2.0`. The corresponding upstream source, build scripts, license, and release history are available from the linked ffmpeg.wasm repository. VideoFlow gzip-packages the unmodified WebAssembly bytes for static delivery, expands them locally before execution, and loads the JavaScript and WebAssembly from the same application origin; it does not load a CDN copy.

The ffmpeg.wasm wrapper is distributed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
