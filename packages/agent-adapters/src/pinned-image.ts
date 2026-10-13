/** Remove only the optional tag; repository and immutable digest stay exact. */
export function canonicalPinnedImageReference(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("pinned_image_reference_invalid");
  }
  const at = value.indexOf("@"), name = value.slice(0, at);
  const colon = name.lastIndexOf(":"), slash = name.lastIndexOf("/");
  // A colon before the final slash belongs to the registry port.
  if (colon <= slash) return value;
  if (name.slice(0, colon).lastIndexOf(":") > slash || !/^[a-z0-9_][a-z0-9_.-]{0,127}$/.test(name.slice(colon + 1))) {
    throw new Error("pinned_image_reference_invalid");
  }
  return name.slice(0, colon) + value.slice(at);
}
