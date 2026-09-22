# Code Reference: `src/utils/dataLiteral.js`

This file implements a custom, highly constrained JavaScript parser (`LiteralParser`) designed exclusively to evaluate plain-data object and array literals.

## Purpose and Security

In the `modernGraphTool` ecosystem (which Neon Equalizer interfaces with via Squiglink), headphone target curves and reviewer configurations are often published not as pure JSON, but as JavaScript files containing variable assignments and JS arrays/objects with trailing commas or unquoted keys (e.g., `var targets = [{ label: "Harman", data: [...] }];`).

Standard `JSON.parse` cannot read these files. Historically, applications used `eval()` or `new Function("return " + text)` to parse them. This is a massive security vulnerability (Remote Code Execution) if the squiglink database is compromised or man-in-the-middled, and it violates strict Content Security Policies (CSP) which forbid `unsafe-eval`.

`parseDataLiteral(text)` solves this. It tokenizes and parses the text, strictly rejecting any executable code.

## Supported Syntax

The parser acts as an extended JSON parser. It accepts:
*   **Strings**: Double-quoted (`"foo"`), single-quoted (`'foo'`), and template literal backticks (`` `foo` ``) *without* interpolation. Standard escape sequences (`\n`, `\x00`, `\u0000`) are supported.
*   **Numbers**: Integers, floats, negative numbers, scientific notation (`1e-5`), and hexadecimals (`0x1a`).
*   **Booleans & Null**: `true`, `false`, `null`, `undefined`.
*   **Arrays**: Standard brackets `[1, 2, 3]`. Trailing commas and elisions (sparse arrays like `[1,,3]`) are handled gracefully.
*   **Objects**: `{ key: "value" }`. Keys can be strings, numbers, or bare identifiers (`{ foo: 1 }`).
*   **String Concatenation**: A common pattern in these config files is breaking long strings across lines via `+` (e.g., `"foo" + "bar"`). The parser permits `+` *only* between string literals.
*   **Comments**: Both `// single line` and `/* multi-line */` are correctly skipped.

## Rejected Syntax (Security & Safety)

To ensure safety, the parser aggressively throws an error (`literal too deeply nested`, `expressions are not allowed`, etc.) if it encounters:
*   **Identifiers as Values**: Only `true`, `false`, `null`, `undefined` are allowed. Variables are rejected.
*   **Function Calls**: `foo()`, `Math.PI`.
*   **Member Access**: `foo.bar`, `array[0]`.
*   **Operators**: `+` (except for strings), `-` (except for unary negation on numbers), `*`, `/`, `=`, `==`, etc.
*   **Template Interpolation**: `` `Hello ${name}` `` is forbidden.
*   **Spreads**: `...array` or `...object`.
*   **Computed Keys**: `{ [key]: value }`.
*   **Methods / Getters**: `{ foo() {} }`, `{ get x() {} }`.

## Defensive Engineering

1.  **Prototype Pollution Guard**: During object parsing, the keys `__proto__`, `constructor`, and `prototype` are explicitly blocked and will not be assigned to the result object.
2.  **Resource Limits**: To prevent Denial of Service (DoS) attacks via maliciously crafted giant strings, the parser enforces a maximum nesting depth (`MAX_DEPTH = 32`) and a maximum node count (`MAX_NODES = 100000`).
3.  **Strict End-of-File**: After successfully parsing a single root value, it checks that only whitespace or comments remain. Trailing garbage text throws an error.
