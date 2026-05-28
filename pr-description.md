🎯 **What:** Refactored `CoworkerPicker` to reduce its complexity.
💡 **Why:** The component was very large (250 lines), making it harder to read and maintain. Extracting sub-components (`ClientInfo`, `CoworkerOption`, `CoworkerSearchSection`, `CoworkerList`) and hooks (`useCoworkerList`) into a `coworker-picker` folder improves encapsulation and readability while removing the linting violations (`eslint(max-lines-per-function)`).
✅ **Verification:** Verified by running `oxlint` (which now shows 0 errors instead of the max-lines errors for the component) and `vitest` (which still reports all tests passing).
✨ **Result:** The `CoworkerPicker` file is now much shorter and easier to understand, with complex UI logic divided into self-contained components and custom hooks.
