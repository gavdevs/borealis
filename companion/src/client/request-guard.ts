/** Keeps an older refresh or an unmounted account's response from changing the page. */
export function createRequestGuard() {
  let mounted = false
  let generation = 0
  return {
    get isMounted() { return mounted },
    mount() { mounted = true },
    unmount() { mounted = false; generation += 1 },
    invalidate() { generation += 1 },
    begin() {
      const requestGeneration = ++generation
      return () => mounted && generation === requestGeneration
    },
  }
}
