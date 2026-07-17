'use client';

import { useInView } from './useInView';

// Oversized heading whose characters rise out of a masked line, staggered
// left to right, the first time it scrolls into view.
export default function KineticTitle({
  text,
  as: Tag = 'h2',
  className = '',
}: {
  text: string;
  as?: 'h1' | 'h2' | 'h3';
  className?: string;
}) {
  const { ref, inView } = useInView<HTMLHeadingElement>(0.3);

  return (
    <Tag
      ref={ref}
      aria-label={text}
      className={`overflow-hidden ${inView ? 'is-inview' : ''} ${className}`}
    >
      {text.split('').map((ch, i) => (
        <span
          key={i}
          aria-hidden
          style={{ transitionDelay: `${i * 35}ms` }}
          className={`kinetic-char inline-block will-change-transform transition-transform duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
            inView ? 'translate-y-0 rotate-0' : 'translate-y-[115%] rotate-6'
          }`}
        >
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </Tag>
  );
}
