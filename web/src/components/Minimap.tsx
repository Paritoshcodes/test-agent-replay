import { useEffect, useRef, type PointerEvent } from "react";
import type { SwimlaneEngine } from "../engine/SwimlaneEngine";
import { P, rgba } from "../engine/palette";

interface Props {
  engine: SwimlaneEngine;
}

type Drag = { kind: "move"; startX: number; k0: number; k1: number } | { kind: "left" | "right"; startX: number; k0: number; k1: number } | null;

/**
 * The full-run overview strip (Phase 1, docs/DECISIONS.md: "required, not optional" -- what makes a
 * 40-step run navigable). Every node across every lane, condensed onto one row scaled to the FULL [0,
 * kEnd] domain regardless of the main view's current zoom, with a draggable window showing what's
 * currently visible there. Its own small canvas and its own tiny render loop: cheap enough (a few dozen
 * dots) that duplicating a handful of draw calls beats coupling it to the main engine's much heavier
 * per-frame layout pass.
 */
export function Minimap({ engine }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag>(null);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const W = Math.max(1, rect.width);
      const H = Math.max(1, rect.height);
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        canvas.style.width = `${W}px`;
        canvas.style.height = `${H}px`;
      }
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const kEnd = Math.max(1, engine.model.kEnd);
      const xOf = (k: number) => (k / kEnd) * W;

      const lanes = engine.model.lanes;
      const rowH = H / Math.max(1, lanes.length);
      lanes.forEach((lane, i) => {
        const y = rowH * (i + 0.5);
        for (const node of lane.nodes) {
          const x = xOf(node.k);
          ctx.beginPath();
          ctx.arc(x, y, node.flagged ? 1.8 : 1.2, 0, Math.PI * 2);
          ctx.fillStyle = rgba(node.flagged ? P.red : lane.depth === 0 ? P.fg : P.blue, node.flagged ? 0.9 : 0.55);
          ctx.fill();
        }
      });

      if (engine.model.divergenceK !== null) {
        const x = xOf(engine.model.divergenceK - 0.5);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.strokeStyle = rgba(P.red, 0.5);
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Viewport window.
      const wx0 = xOf(engine.viewport.k0);
      const wx1 = xOf(engine.viewport.k1);
      ctx.fillStyle = rgba(P.fg, 0.07);
      ctx.fillRect(wx0, 0, wx1 - wx0, H);
      ctx.strokeStyle = rgba(P.fg, 0.55);
      ctx.lineWidth = 1;
      ctx.strokeRect(wx0 + 0.5, 0.5, Math.max(1, wx1 - wx0 - 1), H - 1);

      // Playhead.
      const px = xOf(Math.max(0, Math.min(engine.getUI().step, kEnd)));
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
      ctx.strokeStyle = rgba(P.fg, 0.9);
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  const kAtClientX = (clientX: number): number => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const t = (clientX - rect.left) / Math.max(1, rect.width);
    return t * engine.model.kEnd;
  };

  const HANDLE_PX = 8;

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = wrapRef.current!.getBoundingClientRect();
    const kEnd = engine.model.kEnd;
    const x0 = (engine.viewport.k0 / kEnd) * rect.width;
    const x1 = (engine.viewport.k1 / kEnd) * rect.width;
    const x = e.clientX - rect.left;
    const kind = Math.abs(x - x0) < HANDLE_PX ? "left" : Math.abs(x - x1) < HANDLE_PX ? "right" : "move";
    dragRef.current = { kind, startX: e.clientX, k0: engine.viewport.k0, k1: engine.viewport.k1 };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    const kEnd = engine.model.kEnd;
    const dk = ((e.clientX - d.startX) / rect.width) * kEnd;
    if (d.kind === "move") {
      const span = d.k1 - d.k0;
      let k0 = d.k0 + dk;
      k0 = Math.max(0, Math.min(kEnd - span, k0));
      engine.setViewportImmediate({ k0, k1: k0 + span });
    } else if (d.kind === "left") {
      engine.setViewportImmediate({ k0: Math.min(d.k1 - 2, d.k0 + dk), k1: d.k1 });
    } else {
      engine.setViewportImmediate({ k0: d.k0, k1: Math.max(d.k0 + 2, d.k1 + dk) });
    }
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };
  const clickToJump = (e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return;
    const k = kAtClientX(e.clientX);
    const span = engine.viewport.k1 - engine.viewport.k0;
    engine.setViewportImmediate({ k0: k - span / 2, k1: k + span / 2 });
  };

  return (
    <div
      className="sw-minimap"
      ref={wrapRef}
      role="scrollbar"
      aria-label="Run overview and viewport window"
      aria-orientation="horizontal"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={(e) => {
        up(e);
        clickToJump(e);
      }}
      onPointerCancel={up}
    >
      <canvas ref={canvasRef} className="sw-minimap-canvas" aria-hidden />
    </div>
  );
}
