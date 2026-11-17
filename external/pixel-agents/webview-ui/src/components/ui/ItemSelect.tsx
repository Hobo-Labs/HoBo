import { useEffect, useRef } from 'react';

interface ItemSelectProps {
  width: number;
  height: number;
  selected: boolean;
  onClick: () => void;
  title: string;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  deps: unknown[];
}

export function ItemSelect({
  width,
  height,
  selected,
  onClick,
  title,
  draw,
  deps,
}: ItemSelectProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = width;
    canvas.height = height;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);

    draw(ctx, width, height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-0 rounded-none cursor-pointer overflow-hidden shrink-0 border-2 flex items-center justify-center ${
        selected ? 'border-accent' : 'border-transparent'
      }`}
      style={{ width, height }}
    >
      <canvas ref={canvasRef} style={{ width, height, display: 'block' }} />
    </button>
  );
}
