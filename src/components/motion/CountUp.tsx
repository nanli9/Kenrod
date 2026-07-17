'use client';

import { useEffect, useState } from 'react';
import { useInView } from './useInView';

// Rolls "10+", "100%", "48h" style stats up from zero when scrolled into view.
export default function CountUp({ value, className = '' }: { value: string; className?: string }) {
  const { ref, inView } = useInView<HTMLSpanElement>(0.5);
  const match = value.match(/^(\d+)(.*)$/);
  const target = match ? parseInt(match[1], 10) : 0;
  const suffix = match ? match[2] : '';
  const [n, setN] = useState(0);

  useEffect(() => {
    if (!inView || !match) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setN(target);
      return;
    }
    const dur = 1400;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, target]);

  return (
    <span ref={ref} className={className}>
      {match ? (
        <>
          {n}
          {suffix}
        </>
      ) : (
        value
      )}
    </span>
  );
}
