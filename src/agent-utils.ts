/** Random short id generator (shared by agent modules). */
export function rnd() {
  return Math.random().toString(36).slice(2, 10);
}

/** Current timestamp in ms (shared by agent modules). */
export function now() {
  return Date.now();
}
