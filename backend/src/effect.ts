type Metric = { direction: string | null; targetValue: number | null; targetMaximum: number | null };

export function assessEffect(metric: Metric, before: number | null, after: number | null) {
  const { direction, targetValue: target, targetMaximum: maximum } = metric;
  const delta = before !== null && after !== null ? after - before : null;
  const relativePercent = delta !== null && before !== null && before !== 0 ? 100 * (delta / Math.abs(before)) : null;
  const distance = (value: number) => {
    if (target === null) return null;
    switch (direction) {
      case 'DECREASE': return value - target;
      case 'INCREASE': return target - value;
      case 'TARGET': return Math.abs(value - target);
      case 'RANGE': return maximum === null ? null : Math.max(target - value, value - maximum, 0);
      default: return null;
    }
  };
  const beforeDistance = before === null ? null : distance(before);
  const afterDistance = after === null ? null : distance(after);
  const meetsTarget = afterDistance === null ? null : afterDistance <= 0;
  const improved = beforeDistance === null || afterDistance === null ? null : afterDistance < beforeDistance;
  const worsened = beforeDistance === null || afterDistance === null ? null : afterDistance > beforeDistance;
  const maintained = direction === 'RANGE' && beforeDistance === 0 && afterDistance === 0;
  return { before, after, delta: Number.isFinite(delta) ? delta : null, relativePercent: Number.isFinite(relativePercent) ? relativePercent : null,
    meetsTarget, improved, worsened, maintained, direction, target, maximum };
}
