import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";

import { AvatarImage } from "./avatar-image";

// AvatarImage wraps Radix's Avatar.Image: it stamps data-slot='avatar-image',
// merges the base "aspect-square size-full" classes with the caller's
// className, and forwards the rest (src/alt/...) to the primitive.
//
// Radix only commits the <img> to the DOM once an internal `new window.Image()`
// probe fires its `load` event. jsdom never fires that on its own, so we stub
// window.Image with a fake that lets us drive a synchronous `load`, then render
// inside an Avatar.Root and flip the probe to "loaded".
class FakeImage extends EventTarget {
  src = "";
  referrerPolicy = "";
  crossOrigin: string | null = null;
  // `complete` stays false so resolveLoadingStatus reports "loading" initially;
  // the dispatched `load` event then transitions it to "loaded".
  complete = false;
  naturalWidth = 0;
}

let lastImage: FakeImage | null = null;
let originalImage: typeof window.Image;

beforeEach(() => {
  originalImage = window.Image;
  lastImage = null;
  (window as unknown as { Image: unknown }).Image = function ImageCtor() {
    lastImage = new FakeImage();
    return lastImage as unknown as HTMLImageElement;
  } as unknown as typeof window.Image;
});

afterEach(() => {
  (window as unknown as { Image: unknown }).Image = originalImage;
  vi.restoreAllMocks();
});

function renderLoadedImage(props: React.ComponentProps<typeof AvatarImage>) {
  const utils = render(
    <AvatarPrimitive.Root>
      <AvatarImage {...props} />
    </AvatarPrimitive.Root>,
  );
  // Drive the Radix probe Image to "loaded" so the real <img> commits.
  act(() => {
    lastImage?.dispatchEvent(new Event("load"));
  });
  return utils;
}

describe("AvatarImage", () => {
  it("renders the img with data-slot='avatar-image' and the base classes once loaded", () => {
    const { container } = renderLoadedImage({ src: "http://x/a.png", alt: "Jenny" });
    const el = container.querySelector('[data-slot="avatar-image"]');
    expect(el).not.toBeNull();
    expect(el?.tagName).toBe("IMG");
    expect(el).toHaveClass("aspect-square", "size-full");
  });

  it("forwards src and alt to the underlying image", () => {
    const { container } = renderLoadedImage({ src: "http://x/jenny.png", alt: "Jenny Xu" });
    const el = container.querySelector('[data-slot="avatar-image"]');
    expect(el).toHaveAttribute("src", "http://x/jenny.png");
    expect(el).toHaveAttribute("alt", "Jenny Xu");
  });

  it("merges a caller className with the base classes", () => {
    const { container } = renderLoadedImage({
      src: "http://x/a.png",
      alt: "a",
      className: "ring-2",
    });
    const el = container.querySelector('[data-slot="avatar-image"]');
    expect(el).toHaveClass("ring-2", "aspect-square", "size-full");
  });
});
