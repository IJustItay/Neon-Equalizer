# Code Reference: `src/workers/` Modules

This directory contains the Web Worker implementation for the AutoEQ optimization engine. Running coordinate-descent optimization (which can take several seconds to generate a complex filter chain) on the main thread would freeze the UI and block Audio/Canvas rendering.

## `autoeqWorker.js`
A standard Web Worker script.
*   **Purpose**: Imports `runAutoEQ` from `src/components/autoEQEngine.js` and executes it in an isolated thread.
*   **Communication**: It listens for `message` events containing the `measurement`, `target`, and `options`. During optimization, it frequently sends back `progress` messages containing `done`, `total`, and `stage` metrics. Upon completion, it sends a `result` message containing the generated filters and preamp.

## `autoeqClient.js`
A promise-based client/wrapper that the main application imports.
*   **Purpose**: Abstracts away the raw `Worker.postMessage` API, exposing a clean `runAutoEQAsync()` function.
*   **Fallback Mechanism**: In some packaged Electron or `file://` environments, ES Module Web Workers fail to load due to strict CSP or local file restrictions. `autoeqClient.js` catches instantiation errors (`onerror`) and gracefully falls back to executing `runAutoEQ` synchronously on the main thread, ensuring the app still functions (albeit with brief UI freezes).
*   **Progress Callbacks**: It converts the asynchronous worker `progress` messages into synchronous callback invocations (`hooks.onProgress(done, total, stage)`), allowing the UI to draw a smooth progress bar.
