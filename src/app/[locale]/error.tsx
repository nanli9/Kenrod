'use client';

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="py-16 px-4 text-center min-h-[70vh] flex flex-col items-center justify-center bg-void">
      <p className="font-mono text-xs tracking-[0.35em] text-acid uppercase mb-6">
        Error / 500
      </p>
      <h1 className="font-display text-8xl md:text-9xl text-smoke uppercase mb-4">500</h1>
      <p className="text-mute mb-10">Something went wrong.</p>
      <button
        onClick={reset}
        className="inline-flex h-11 items-center px-7 rounded-full bg-acid text-void font-mono text-xs uppercase tracking-[0.15em] font-medium hover:bg-smoke transition-colors"
      >
        Try again
      </button>
    </section>
  );
}
