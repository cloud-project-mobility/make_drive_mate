export interface RemovableSubscription {
  remove: () => void;
}

/** Owns an asynchronous subscription only if its requesting session is still current. */
export async function attachCurrentSubscription<T extends RemovableSubscription>(
  create: () => Promise<T>,
  isCurrent: () => boolean,
  attach: (subscription: T) => void,
  fail: () => void,
): Promise<'attached' | 'cancelled' | 'failed'> {
  try {
    const subscription = await create();
    if (!isCurrent()) {
      subscription.remove();
      return 'cancelled';
    }
    attach(subscription);
    return 'attached';
  } catch {
    // An older request may reject after pause, unmount, or a successful newer resume.
    // Its failure must never stop the new session or update the unmounted screen.
    if (!isCurrent()) return 'cancelled';
    fail();
    return 'failed';
  }
}
