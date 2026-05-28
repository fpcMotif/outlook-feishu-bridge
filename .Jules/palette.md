## 2024-05-28 - Accessible text inputs and textareas
**Learning:** Found that custom `Textarea` and `input` components (like in `RequestCards.tsx` and `CoworkerPicker.tsx`) lacked proper `aria-label` or `aria-describedby` when they didn't have explicitly linked `<label>` elements visible. This pattern might repeat in other custom form components.
**Action:** Always verify that inputs have an associated `aria-label` or `<label>` and consider adding `aria-describedby` to link helper text (like character counts) to the input.
