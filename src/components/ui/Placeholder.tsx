export default function Placeholder({
  label,
  height = 'h-64',
  className = '',
}: {
  label: string;
  height?: string;
  className?: string;
}) {
  return (
    <div
      className={`${height} border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center bg-gray-50 ${className}`}
    >
      <span className="text-gray-400 text-sm font-mono">
        PLACEHOLDER: {label}
      </span>
    </div>
  );
}
