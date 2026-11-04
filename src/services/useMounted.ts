import { useCallback, useEffect, useRef } from 'react';

/** Async handlers must not commit global changes after their owning screen unmounts. */
export function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current, []);
}
