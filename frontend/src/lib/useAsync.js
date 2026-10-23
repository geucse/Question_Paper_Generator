import { useCallback, useRef, useState } from 'react';

// Small shared helper for the pivot pages (kept deliberately tiny).
// run(fn, successMsg) shows the server's error (and reasons) instead of rejecting; `loading` is true while any
// run is in flight, so screens can show a loading state instead of a blank one.
// run is stable (it only touches state setters and a ref), so effects and callbacks can list it as a dependency.
export function useAsync() {
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState([]);
  const [ok, setOk] = useState('');
  const [loading, setLoading] = useState(false);
  const pending = useRef(0);
  const run = useCallback(async (fn, successMsg) => {
    setError(''); setReasons([]); setOk('');
    pending.current += 1; setLoading(true);
    try {
      const r = await fn();
      if (successMsg) setOk(successMsg);
      return r;
    } catch (e) {
      setError(e.data?.error || e.message);
      setReasons(e.data?.reasons || e.data?.validation_errors || []);
      return undefined;
    } finally {
      pending.current -= 1;
      if (pending.current === 0) setLoading(false);
    }
  }, []);
  return { error, reasons, ok, loading, run };
}
