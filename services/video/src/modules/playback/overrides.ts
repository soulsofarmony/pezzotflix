// Server-side capability overrides per device (doc 03 I2): declared capabilities corrected for
// devices known to declare the wrong thing. Data, not code, so a rule can be added without touching
// the engine; the web client puts browser, version and OS in device.model (doc 04 P5).
import type { ClientCapabilities } from '../../shared/ports.ts';

export interface CapabilityOverride {
  /** Stable name, for logs and diagnostics. */
  id: string;
  /** Every given field must match. modelPattern is a case-insensitive regular expression on device.model. */
  match: { deviceClass?: ClientCapabilities['device']['class']; modelPattern?: string };
  /** HDR formats the device declares but does not present acceptably (P5: an SDR conversion judged bad). */
  removeHdr?: string[];
  removeVideoCodecs?: string[];
  removeAudioCodecs?: string[];
  /** Caps maxChannels of every audio decoder. */
  maxAudioChannels?: number;
  audioTrackSelection?: boolean;
}

/**
 * No rule yet: the S2 measures found no wrong declaration. Candidates waiting for evidence: P5 (the
 * owner's colour check may remove HDR10 from a browser) and Edge AC-3 on Windows without the Dolby
 * decoder (doc 04 §4.3, already caught by isTypeSupported).
 */
export const DEFAULT_OVERRIDES: readonly CapabilityOverride[] = [];

/** Keeps the rules whose modelPattern compiles; each invalid one is reported once and ignored (m12). */
export function validateOverrides(rules: readonly CapabilityOverride[], onInvalid: (rule: CapabilityOverride, err: unknown) => void): CapabilityOverride[] {
  return rules.filter((o) => {
    if (o.match.modelPattern === undefined) return true;
    try {
      new RegExp(o.match.modelPattern, 'i');
      return true;
    } catch (err) {
      onInvalid(o, err);
      return false;
    }
  });
}

const matches = (o: CapabilityOverride, caps: ClientCapabilities): boolean =>
  (o.match.deviceClass === undefined || o.match.deviceClass === caps.device.class) &&
  (o.match.modelPattern === undefined || new RegExp(o.match.modelPattern, 'i').test(caps.device.model ?? ''));

const without = (list: readonly string[], removed: readonly string[] | undefined): string[] =>
  removed ? list.filter((x) => !removed.some((r) => r.toLowerCase() === x.toLowerCase())) : [...list];

/** Applies every matching rule in order; returns new capabilities and the ids of the rules applied. */
export function applyOverrides(caps: ClientCapabilities, rules: readonly CapabilityOverride[]): { capabilities: ClientCapabilities; applied: string[] } {
  let out: ClientCapabilities = structuredClone(caps);
  const applied: string[] = [];
  for (const o of rules) {
    if (!matches(o, out)) continue;
    applied.push(o.id);
    out = {
      ...out,
      hdr: without(out.hdr ?? [], o.removeHdr),
      video: out.video.filter((v) => !(o.removeVideoCodecs ?? []).some((c) => c.toLowerCase() === v.codec.toLowerCase())),
      audio: out.audio
        .filter((a) => !(o.removeAudioCodecs ?? []).some((c) => c.toLowerCase() === a.codec.toLowerCase()))
        .map((a) => (o.maxAudioChannels === undefined ? a : { ...a, maxChannels: Math.min(a.maxChannels ?? o.maxAudioChannels, o.maxAudioChannels) })),
      ...(o.audioTrackSelection === undefined ? {} : { audioTrackSelection: o.audioTrackSelection }),
    };
  }
  return { capabilities: out, applied };
}
