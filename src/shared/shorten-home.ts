/**
 * Browser-safe helper to shorten home paths in strings.
 * No Node built-ins; can be used from control-ui (Vite/browser) build.
 * When display is undefined (e.g. in browser), returns input unchanged.
 */
export function shortenHomeInString(
  input: string,
  display?: { home: string; prefix: string } | null,
): string {
  if (!input) {
    return input;
  }
  if (!display) {
    return input;
  }
  return input.split(display.home).join(display.prefix);
}
