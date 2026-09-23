# MediaPipe Face Mesh (vendored)

- Package: `@mediapipe/face_mesh` 0.4.1633559619 (npm)
- License: Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0
- Copyright: Google LLC

Only the files needed by browsers with WebAssembly SIMD are bundled so that
camera tracking works offline and never changes version unexpectedly.
Browsers without SIMD load the non-SIMD build of the same pinned version from
https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/.
