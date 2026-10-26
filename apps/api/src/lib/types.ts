/** Every field optional and explicitly undefinable, the shape a validated PATCH body has. */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };
