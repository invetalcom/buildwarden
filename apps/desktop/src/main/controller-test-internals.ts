import type { AppController } from "./app-controller";
import type { AppServiceContext } from "./services/app-service";
import type { AppServices } from "./services/app-services";

/**
 * For tests only: one object over the context and all services of a controller. Reading, replacing
 * or spying on a member reaches the service that owns it, so tests do not depend on where it lives.
 */
export const internalsOf = <T = unknown>(controller: AppController): T => {
  const { services } = controller as unknown as { services: AppServices };
  const { context } = services.runEvents as unknown as { context: AppServiceContext };
  const owners: object[] = [context, ...Object.values(services)];
  const ownerOf = (key: PropertyKey): object | undefined => owners.find((owner) => key in owner);
  const requireOwner = (key: PropertyKey): object => {
    const owner = ownerOf(key);
    if (!owner) throw new Error(`No service has the member ${String(key)}.`);
    return owner;
  };
  const describe = (key: PropertyKey): PropertyDescriptor | undefined => {
    for (let target: object | null = ownerOf(key) ?? null; target; target = Object.getPrototypeOf(target) as object | null) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor) return { ...descriptor, configurable: true };
    }
    return undefined;
  };
  return new Proxy({}, {
    has: (_target, key) => ownerOf(key) !== undefined,
    get: (_target, key) => {
      const owner = ownerOf(key);
      return owner ? (Reflect.get(owner, key) as unknown) : undefined;
    },
    set: (_target, key, value) => Reflect.set(requireOwner(key), key, value),
    getOwnPropertyDescriptor: (_target, key) => describe(key),
    defineProperty: (_target, key, descriptor) => Reflect.defineProperty(requireOwner(key), key, { ...descriptor, configurable: true }),
    deleteProperty: (_target, key) => Reflect.deleteProperty(requireOwner(key), key),
  }) as T;
};
