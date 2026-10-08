# Third-party notices

## ModelTrace

- Source: https://github.com/xqy2006/ModelTrace
- Pinned commit: `df3a0f9d3e054c0dc02d6d586686db8daf8fa7c8`
- License: MIT; the original notice is retained in [vendor/modeltrace/LICENSE](vendor/modeltrace/LICENSE).
- Unmodified vendored files and hashes: [vendor/modeltrace/provenance.json](vendor/modeltrace/provenance.json).
- This optional fingerprint module is separate from Model Guard's native response-signal implementation and is disabled by default.

## Desktop dependencies

Electron and electron-builder are development/build dependencies pinned by package-lock.json. Their distribution notices and licenses must be retained when distributing a packaged desktop application. The build script also obtains the license for the bundled Node.js runtime.

## Measurement references

The measurement design references vLLM benchmark documentation and NVIDIA GenAI-Perf; no runtime dependency on either is included. Relevant links and distinctions are in docs/measurement.md.
