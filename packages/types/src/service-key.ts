/**
 * Typed token for the kernel's service registry; the TypeScript stand-in for Rust's
 * `services().get::<dyn Trait>()`. Declare one constant next to the interface it names:
 *
 * ```ts
 * export interface ActionSink { ... }
 * export const ActionSinkKey = serviceKey<ActionSink>("ActionSink");
 * ```
 *
 * The id is the Rust type name (without `dyn`), so logs and errors read the same as legacy.
 * Lookups go by key object identity; two keys with the same id are different services.
 */
export class ServiceKey<T> {
  /** Phantom field that carries `T`; never set at runtime. */
  declare readonly __service: (value: T) => T;

  constructor(readonly id: string) {}

  toString(): string {
    return `ServiceKey(${this.id})`;
  }
}

export function serviceKey<T>(id: string): ServiceKey<T> {
  return new ServiceKey<T>(id);
}
