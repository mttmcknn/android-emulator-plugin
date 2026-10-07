// Safe inline attribute for the optional host-provided appearance snapshot.
export function themeAttribute(theme = null) {
  return JSON.stringify(theme).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
