# Code Reference: `src/components/devicePeq/` Modules

This directory contains the Device PEQ subsystem. It replaces the app's legacy `hidManager` singleton, providing a modernized, multi-transport interface for pushing and pulling Parametric EQ filters directly to hardware audio devices (like DAC/Amps, Bluetooth headphones, and network streamers) from the browser.

## The Façade: `index.js`

`index.js` exports the `devicePeq` singleton (instance of `DevicePeqManager`). This is the only module that the main application (`src/main.js`) interacts with. 

It acts as a router/façade over four distinct Web APIs. It handles:
1.  **Transport Selection**: `connect(connectorKey)` loads the correct driver.
2.  **Filter Normalization**: It translates between the app's internal APO-style filter definitions (e.g., `LS`) and the hardware's expected filter types (e.g., `LSQ` or `Low Shelf`), applying device-specific constraints like `maxFilters`.
3.  **API Standardization**: It guarantees a uniform Promise-based API for `push(filters, preamp)` and `pull()`, regardless of how radically different the underlying hardware protocols are.

## The Connectors (`src/components/devicePeq/connectors/`)

The actual hardware communication is delegated to four distinct connector modules. Each connector must implement `connect`, `disconnect`, `push`, `pull`, `getCurrentSlot`, and `getAvailableSlots`.

### 1. `hid.js` (WebHID API)
*   **Protocol**: USB Human Interface Device (HID).
*   **Target Devices**: FiiO (e.g., KA13, BTR15 via USB), Moondrop (FreeDSP), KT (Qudelix), WalkPlay.
*   **Mechanism**: Uses `navigator.hid`. Communication involves sending arrays of raw bytes (hex packets) to specific HID endpoints. This is often the most complex connector because each manufacturer uses proprietary, undocumented hex payloads to represent EQ data.

### 2. `serial.js` (Web Serial API)
*   **Protocol**: USB Serial (RS-232 over USB).
*   **Target Devices**: JDS Labs (Element III), Nothing, and custom Arduino/ESP32-based DSPs.
*   **Mechanism**: Uses `navigator.serial`. Communication is typically ASCII or simple binary commands over a virtual COM port.

### 3. `ble.js` (Web Bluetooth API)
*   **Protocol**: Bluetooth Low Energy (BLE) GATT characteristics.
*   **Target Devices**: Wireless devices like FiiO BT receivers (BTR series), Airoha chipset earbuds.
*   **Mechanism**: Uses `navigator.bluetooth`. Requires requesting the device via specific Service UUIDs, then writing characteristics. BLE has strict payload size limits (often 20 bytes), so this module often handles chunking EQ data into multiple smaller packets.

### 4. `network.js` (Fetch API)
*   **Protocol**: HTTP / REST / UPnP over local Wi-Fi.
*   **Target Devices**: WiiM streamers, Volumio, and other LAN-connected audio gear.
*   **Mechanism**: Uses standard `fetch()`. The easiest connector to implement, typically involving pushing JSON payloads to a local IP address. Requires the device to be on the same subnet as the browser.

## Security and Browser Requirements
Because these modules interact with hardware, they are subject to strict browser security policies:
1.  They only work in Chromium-based browsers (Chrome, Edge, Brave). Safari and Firefox explicitly refuse to implement WebHID/WebSerial/WebBluetooth for security reasons.
2.  They only work in a Secure Context (HTTPS or `localhost`).
3.  A device connection can *only* be initiated as a direct result of a user gesture (like a click event). The app cannot connect silently in the background.
