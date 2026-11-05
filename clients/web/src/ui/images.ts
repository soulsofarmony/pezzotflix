// Images through GetImage with the contract's widths (w = 160, 320, 640, 1280, 1920). The server lists the
// variants it offers per artwork type; the client only picks among them (it never builds data-plane URLs).
import type { ImageRef } from '../api/types.ts';

export interface PickedImage {
  src: string;
  srcSet: string | undefined;
}

export function pickImage(images: ImageRef[] | undefined, types: ImageRef['type'][], preferredWidth: number): PickedImage | null {
  if (!images?.length) return null;
  for (const type of types) {
    const img = images.find((i) => i.type === type);
    if (!img) continue;
    const variants = Object.entries(img.variants ?? {})
      .map(([w, url]) => [Number(w), url] as const)
      .filter(([w]) => Number.isFinite(w) && w > 0)
      .sort((a, b) => a[0] - b[0]);
    if (variants.length === 0) return { src: img.url, srcSet: undefined };
    const best = variants.find(([w]) => w >= preferredWidth) ?? variants[variants.length - 1];
    return { src: best?.[1] ?? img.url, srcSet: variants.map(([w, url]) => `${url} ${w}w`).join(', ') };
  }
  return null;
}

/** A stable hue from a title, for the generated placeholder cover (ADR 0007 point 9). */
export function placeholderHue(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360;
  return h;
}
