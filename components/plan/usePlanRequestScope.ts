import { useLayoutEffect, useRef } from 'react';

type PlanRequestScope = { active: boolean; request: number };

// Keyed plan components get a separate lifetime for each owner/date. A new
// object on every setup also keeps StrictMode's retired requests invalid.
export function usePlanRequestScope() {
  const scopeRef = useRef<PlanRequestScope | null>(null);

  useLayoutEffect(() => {
    const scope = { active: true, request: 0 };
    scopeRef.current = scope;
    return () => { scope.active = false; };
  }, []);

  return scopeRef;
}
