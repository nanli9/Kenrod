export default function Loading() {
  return (
    <div className="flex flex-col items-center justify-center gap-5 min-h-[60vh] bg-ink">
      <div className="h-px w-32 bg-white/10 overflow-hidden">
        <div className="h-full w-full bg-accent/80 animate-pulse-soft" />
      </div>
      <span className="font-mono text-[11px] tracking-[0.35em] uppercase text-steel-dim animate-pulse-soft">
        Loading
      </span>
    </div>
  );
}
