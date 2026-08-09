export function runtimeSupported(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 24 || (major === 24 && minor >= 15);
}
