# Code Reference: `src/components/audioPlayer.js`

This file implements the `AudioPlayer` class, which provides a real-time audio preview feature using the browser's native Web Audio API. It allows users to hear the effect of their EQ curve on various test signals or their own audio files without needing to write to Equalizer APO and test system-wide.

## Web Audio Graph Architecture

When the user clicks "Play", `_buildChain()` constructs a Web Audio routing graph:

1.  **Source Node**: Generates or plays the audio signal (White Noise, Pink Noise, Sine Tone, or Audio File).
2.  **Filter Nodes**: An array of `BiquadFilterNode` instances. The player translates the app's EQ filters into native Web Audio nodes.
3.  **Preamp Node**: A `GainNode` that applies the global pre-amplification (usually negative gain to prevent clipping).
4.  **Master Volume**: A `GainNode` linked to the UI volume slider.
5.  **Analyser Node**: An `AnalyserNode` that calculates real-time Fast Fourier Transform (FFT) data.
6.  **Destination**: The default audio output device.

The routing looks like this:
`Source -> Filter 1 -> Filter 2 -> ... -> Preamp -> Volume -> Analyser -> Destination`

### Filter Translation
The `_makeWebAudioFilter` method translates the app's filter models into Web Audio `BiquadFilterNode` types.
*   `PK`, `PEQ`, `Modal` -> `peaking`
*   `LS` -> `lowshelf`
*   `HS` -> `highshelf`
*   `LP` -> `lowpass`
*   `HP` -> `highpass`
*   `BP` -> `bandpass`
*   `NO` -> `notch`
*   `AP` -> `allpass`

*Limitation*: The Web Audio API does not natively support fixed-slope 6dB/12dB shelving filters or generic IIR coefficient injection. These advanced APO filters are currently mapped to standard 12dB/octave shelves or ignored, meaning the preview may not be 100% accurate for highly complex filter chains compared to what APO actually renders.

## Audio Sources

1.  **White Noise**: Generated using `Math.random()`.
2.  **Pink Noise**: Generated using Paul Kellet's algorithm to shape white noise into pink noise (equal energy per octave), which sounds more balanced to human hearing and is the standard for acoustic testing.
3.  **Tone**: Uses an `OscillatorNode`. A slider allows sweeping the frequency from 20Hz to 20kHz logarithmically.
4.  **Audio File**: Uses a `<input type="file">` to let the user load a local `.wav`, `.mp3`, or `.flac` file. It decodes the file into an `AudioBuffer` and plays it in a loop.

## Spectrum Analyser

The component includes a small HTML5 Canvas that visualizes the `AnalyserNode`'s frequency data.
*   `_startAnalyser()` sets up a `requestAnimationFrame` loop.
*   `_drawAnalyser()` fetches the byte frequency data (`getByteFrequencyData`) and draws it as a 64-bar spectrogram with a cyan-to-purple gradient.
*   The class also emits an `onAnalyserChange` event, passing the `AnalyserNode` to `main.js`, which then passes it to `FrequencyGraph` to draw the spectrum overlay directly on the main EQ graph.

## State Management

*   **Hot Swapping**: If the user changes a filter in the UI while audio is playing, `refreshEQ()` is called. It temporarily disconnects the source, rebuilds the filter chain, and reconnects it, ensuring the preview updates instantly without stopping playback.
*   **EQ Toggle**: A checkbox allows A/B testing by completely bypassing the `FilterNodes` in the routing graph while keeping the preamp active to maintain volume matching.
