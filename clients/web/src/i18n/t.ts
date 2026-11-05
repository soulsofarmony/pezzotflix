// t(key, params): the only way UI code gets a string. Parameter names are read from the message type, so a
// missing or misspelled {param} is a compile error.
import { it, type MessageKey, type Messages } from './it.ts';

type ParamNames<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | ParamNames<Rest> : never;
export type Params<K extends MessageKey> = Record<ParamNames<Messages[K]>, string | number>;

type Args<K extends MessageKey> = [ParamNames<Messages[K]>] extends [never] ? [] : [params: Params<K>];

export function t<K extends MessageKey>(key: K, ...args: Args<K>): string {
  const msg: string = it[key];
  const params = args[0] as Record<string, string | number> | undefined;
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** For keys built at runtime from open enums: falls back when the key is not in the catalog. */
export function tMaybe(key: string, fallback: string): string {
  return key in it ? (it as Record<string, string>)[key] ?? fallback : fallback;
}
