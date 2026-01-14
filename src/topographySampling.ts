export type SamplingPhase = "coarse" | "full";

export function buildSpiralIndexOrder(rows: number, cols: number): number[] {
  const order: number[] = [];
  if (rows <= 0 || cols <= 0) {
    return order;
  }
  const centerRow = Math.floor((rows - 1) / 2);
  const centerCol = Math.floor((cols - 1) / 2);
  const maxRadius = Math.max(
    centerRow,
    rows - 1 - centerRow,
    centerCol,
    cols - 1 - centerCol
  );

  const seen = new Set<number>();
  const pushIfValid = (row: number, col: number) => {
    if (row < 0 || row >= rows || col < 0 || col >= cols) {
      return;
    }
    const index = row * cols + col;
    if (seen.has(index)) {
      return;
    }
    seen.add(index);
    order.push(index);
  };

  pushIfValid(centerRow, centerCol);

  for (let radius = 1; radius <= maxRadius; radius += 1) {
    const top = centerRow - radius;
    const bottom = centerRow + radius;
    const left = centerCol - radius;
    const right = centerCol + radius;

    for (let col = left; col <= right; col += 1) {
      pushIfValid(top, col);
    }
    for (let row = top + 1; row <= bottom; row += 1) {
      pushIfValid(row, right);
    }
    for (let col = right - 1; col >= left; col -= 1) {
      pushIfValid(bottom, col);
    }
    for (let row = bottom - 1; row >= top + 1; row -= 1) {
      pushIfValid(row, left);
    }
  }

  return order;
}

export function buildProgressiveIndexPhases(
  rows: number,
  cols: number,
  stride: number
): Array<{ phase: SamplingPhase; indices: number[] }> {
  const fullOrder = buildSpiralIndexOrder(rows, cols);
  const safeStride = Math.max(1, Math.floor(stride));
  if (safeStride <= 1) {
    return [{ phase: "full", indices: fullOrder }];
  }

  const coarseRows: number[] = [];
  for (let row = 0; row < rows; row += safeStride) {
    coarseRows.push(row);
  }
  if (rows > 0 && coarseRows[coarseRows.length - 1] !== rows - 1) {
    coarseRows.push(rows - 1);
  }

  const coarseCols: number[] = [];
  for (let col = 0; col < cols; col += safeStride) {
    coarseCols.push(col);
  }
  if (cols > 0 && coarseCols[coarseCols.length - 1] !== cols - 1) {
    coarseCols.push(cols - 1);
  }

  const coarseSet = new Set<number>();
  for (const row of coarseRows) {
    for (const col of coarseCols) {
      coarseSet.add(row * cols + col);
    }
  }

  const coarseOrder: number[] = [];
  const fullOrderRemaining: number[] = [];
  for (const index of fullOrder) {
    if (coarseSet.has(index)) {
      coarseOrder.push(index);
    } else {
      fullOrderRemaining.push(index);
    }
  }

  if (coarseOrder.length === 0 || fullOrderRemaining.length === 0) {
    return [{ phase: "full", indices: fullOrder }];
  }

  return [
    { phase: "coarse", indices: coarseOrder },
    { phase: "full", indices: fullOrderRemaining }
  ];
}
