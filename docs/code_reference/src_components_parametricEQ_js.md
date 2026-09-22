# Code Reference: `src/components/parametricEQ.js`

This file implements the `ParametricEQ` class, which is responsible for rendering and managing the UI for the Parametric Equalizer panel in the main window. It bridges the gap between the internal filter array (`appState.config.filters`) and the HTML DOM inputs the user interacts with.

## Architecture and Design

Like `frequencyGraph.js`, `ParametricEQ` does not use a virtual DOM framework. It operates via immediate-mode DOM manipulation.
*   **State Management**: It holds a local copy of the filters array. When a user modifies a filter via the UI, it updates its internal state, re-renders the specific row or the whole panel if necessary, and triggers the `onChange` callback to notify the main controller (`src/main.js`).
*   **Data Binding**: When the graph updates a filter (e.g., via node dragging), `updateFilterFromGraph` is called to sync the UI `<input>` fields without causing a full re-render, avoiding input focus loss.

## Features

### Supported Filter Types
The component supports an extensive list of Equalizer APO filter types defined in `FILTER_TYPE_CONFIG`:
*   **Peaking**: `PK`, `PEQ`, `Modal`
*   **Shelving**: `LS`, `LSC`, `HS`, `HSC` (and their fixed 6dB/12dB variants)
*   **Pass Filters**: `LP`, `LPQ`, `HP`, `HPQ`, `BP`
*   **Others**: `NO` (Notch), `AP` (All-Pass), `IIR` (Custom IIR coefficients)

Depending on the filter type selected, the UI dynamically disables irrelevant input fields (e.g., disabling the `Gain` input for a Low-Pass filter since it only requires Frequency and Q).

### Channel Routing
Each filter row includes a channel selector (`filter-channel-select`). By default, filters apply to `all` channels. The UI supports selecting standard APO channels (`L`, `R`, `C`, `LFE`, `SL`, `SR`, etc.).
Crucially, if a configuration file is loaded with a custom channel string (e.g., `L R`), the `_channelOptions` method preserves it verbatim rather than silently discarding it.

### Core Operations
*   `addFilter(params)`: Appends a new filter. Assigns it a unique ID (`filter_<timestamp>_<index>`) and a color from the palette.
*   `removeFilter(id)`: Deletes a filter and re-indexes the colors.
*   `duplicateFilter(id)`: Creates an exact copy of a filter and inserts it immediately after the source, slightly incrementing the frequency (by 3%) to prevent the graph nodes from perfectly overlapping and becoming unselectable.
*   `loadPreset(name)`: Replaces the current filter list with a predefined array of filters (e.g., 'v-shape', 'bass-boost', 'vocal', 'loudness').

## UI Rendering (`_render`)
The `_render` function completely clears the container and rebuilds the DOM for every filter.
*   It generates HTML strings for each row, mapping filter properties (`frequency`, `gain`, `q`, `channel`) to `<input>` and `<select>` values.
*   It binds native DOM event listeners (`click`, `contextmenu`, `input`, `change`) to the newly created elements.
*   **UX Features**:
    *   Left-clicking a row selects it (`selected` class).
    *   Right-clicking a row deletes it.
    *   The toggle button disables/enables the filter without deleting it.

## Limitations and Potential Improvements
*   **Performance**: Rebuilding the entire DOM (`innerHTML = ''`) on operations like `addFilter` or `removeFilter` is slightly inefficient compared to targeted DOM insertion/deletion, though acceptable for lists typically < 20 items.
*   **IIR Filters**: While `IIR` is listed as a supported type, the UI currently lacks specialized input fields for custom coefficients (it only shows disabled Freq/Gain/Q inputs). Users must rely on the text editor or APO files to configure custom IIR strings.
