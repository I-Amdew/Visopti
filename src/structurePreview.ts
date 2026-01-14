export interface StructurePreviewGeometry {
  widthM: number;
  lengthM: number;
  heightM: number;
  baseM: number;
}

export interface StructurePreview {
  setStructure: (next: StructurePreviewGeometry) => void;
  setSpinning: (spinning: boolean) => void;
  resize: () => void;
  destroy: () => void;
}

type Vec3 = { x: number; y: number; z: number };
type Vec2 = { x: number; y: number; z: number };

const SPIN_SPEED = 0.6;
const SPIN_TILT = Math.PI / 5;

function rotatePoint(point: Vec3, yaw: number, tilt: number): Vec3 {
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const x1 = point.x * cosYaw - point.y * sinYaw;
  const y1 = point.x * sinYaw + point.y * cosYaw;
  const z1 = point.z;
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  const y2 = y1 * cosTilt - z1 * sinTilt;
  const z2 = y1 * sinTilt + z1 * cosTilt;
  return { x: x1, y: y2, z: z2 };
}

function drawPolygon(
  ctx: CanvasRenderingContext2D,
  points: Vec2[],
  fill: string,
  stroke: string
) {
  if (points.length === 0) {
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

export function createStructurePreview(canvas: HTMLCanvasElement): StructurePreview {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Preview canvas 2D context unavailable.");
  }

  let structure: StructurePreviewGeometry = { widthM: 10, lengthM: 10, heightM: 4, baseM: 0 };
  let viewWidth = 0;
  let viewHeight = 0;
  let spinning = false;
  let angle = 0;
  let rafId: number | null = null;
  let lastTime = 0;
  let resizeObserver: ResizeObserver | null = null;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    if (nextWidth === viewWidth && nextHeight === viewHeight) {
      return;
    }
    viewWidth = nextWidth;
    viewHeight = nextHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const render = (yaw: number, tilt: number) => {
    if (viewWidth <= 0 || viewHeight <= 0) {
      return;
    }
    ctx.clearRect(0, 0, viewWidth, viewHeight);
    ctx.fillStyle = "#11161c";
    ctx.fillRect(0, 0, viewWidth, viewHeight);

    const centerX = viewWidth / 2;
    const centerY = viewHeight / 2;

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(148, 163, 184, 0.2)";
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(viewWidth, centerY);
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, viewHeight);
    ctx.stroke();

    ctx.strokeStyle = "rgba(148, 163, 184, 0.45)";
    ctx.beginPath();
    ctx.moveTo(centerX, 10);
    ctx.lineTo(centerX, 22);
    ctx.stroke();
    ctx.fillStyle = "rgba(148, 163, 184, 0.6)";
    ctx.beginPath();
    ctx.moveTo(centerX, 8);
    ctx.lineTo(centerX - 4, 14);
    ctx.lineTo(centerX + 4, 14);
    ctx.closePath();
    ctx.fill();

    const widthM = Math.max(0.1, structure.widthM);
    const lengthM = Math.max(0.1, structure.lengthM);
    const heightM = Math.max(0.1, structure.heightM);
    const baseM = Number.isFinite(structure.baseM) ? Math.max(0, structure.baseM) : 0;
    const maxDim = Math.max(widthM, lengthM, heightM);
    const target = Math.min(viewWidth, viewHeight) * 0.6;
    const scale = target / maxDim;

    const halfW = widthM / 2;
    const halfL = lengthM / 2;
    const vertices: Vec3[] = [
      { x: -halfW, y: -halfL, z: 0 },
      { x: halfW, y: -halfL, z: 0 },
      { x: halfW, y: halfL, z: 0 },
      { x: -halfW, y: halfL, z: 0 },
      { x: -halfW, y: -halfL, z: heightM },
      { x: halfW, y: -halfL, z: heightM },
      { x: halfW, y: halfL, z: heightM },
      { x: -halfW, y: halfL, z: heightM }
    ];

    const rotated = vertices.map((v) => rotatePoint(v, yaw, tilt));
    const projected: Vec2[] = rotated.map((v) => ({
      x: centerX + v.x * scale,
      y: centerY - v.y * scale,
      z: v.z
    }));

    const stroke = "rgba(240, 249, 255, 0.6)";

    if (tilt < 0.02) {
      drawPolygon(
        ctx,
        [projected[4], projected[5], projected[6], projected[7]],
        "rgba(92, 194, 242, 0.55)",
        stroke
      );
      ctx.fillStyle = "rgba(148, 163, 184, 0.8)";
      ctx.font = "11px 'Segoe UI', sans-serif";
      ctx.fillText(`Base ${Math.round(baseM)} m`, 8, viewHeight - 10);
      return;
    }

    const faces = [
      { idx: [4, 5, 6, 7], fill: "rgba(110, 212, 255, 0.75)" },
      { idx: [0, 1, 5, 4], fill: "rgba(70, 147, 191, 0.8)" },
      { idx: [1, 2, 6, 5], fill: "rgba(60, 132, 173, 0.8)" },
      { idx: [2, 3, 7, 6], fill: "rgba(72, 150, 196, 0.8)" },
      { idx: [3, 0, 4, 7], fill: "rgba(80, 161, 208, 0.8)" }
    ];

    faces
      .map((face) => ({
        ...face,
        depth: face.idx.reduce((sum, index) => sum + rotated[index].z, 0) / face.idx.length
      }))
      .sort((a, b) => a.depth - b.depth)
      .forEach((face) => {
        drawPolygon(ctx, face.idx.map((index) => projected[index]), face.fill, stroke);
      });

    ctx.fillStyle = "rgba(148, 163, 184, 0.8)";
    ctx.font = "11px 'Segoe UI', sans-serif";
    ctx.fillText(`Base ${Math.round(baseM)} m`, 8, viewHeight - 10);
  };

  const tick = (time: number) => {
    const delta = Math.min(0.05, (time - lastTime) / 1000);
    lastTime = time;
    angle += delta * SPIN_SPEED;
    render(angle, SPIN_TILT);
    if (spinning) {
      rafId = window.requestAnimationFrame(tick);
    } else {
      rafId = null;
    }
  };

  const setSpinning = (active: boolean) => {
    if (spinning === active) {
      return;
    }
    spinning = active;
    if (spinning) {
      lastTime = performance.now();
      if (rafId === null) {
        rafId = window.requestAnimationFrame(tick);
      }
    } else {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      angle = 0;
      render(0, 0);
    }
  };

  const setStructure = (next: StructurePreviewGeometry) => {
    structure = { ...next };
    render(spinning ? angle : 0, spinning ? SPIN_TILT : 0);
  };

  const handleResize = () => {
    resize();
    render(spinning ? angle : 0, spinning ? SPIN_TILT : 0);
  };
  window.addEventListener("resize", handleResize);
  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(canvas);
  }

  resize();
  render(0, 0);

  const destroy = () => {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    window.removeEventListener("resize", handleResize);
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  };

  return { setStructure, setSpinning, resize, destroy };
}
