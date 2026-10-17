/**
 * Thumb rows for a vertical scrollbar beside `height` visible rows of `total`, scrolled to `offset`.
 * Returns undefined when everything fits, so callers draw nothing. The thumb is at least one row,
 * and touches the bottom exactly when the view is scrolled to the end.
 */
export function scrollbar(height: number, total: number, offset: number): boolean[] | undefined {
  if (height < 1 || total <= height) return undefined;
  const maxOffset = total - height;
  const size = Math.max(1, Math.round(height * height / total));
  const top = Math.round(Math.max(0, Math.min(offset, maxOffset)) / maxOffset * (height - size));
  return Array.from({ length: height }, (_, row) => row >= top && row < top + size);
}

/** Where a click on the track should scroll: one page toward the click, clamped to the content. */
export function pageToward(row: number, height: number, total: number, offset: number) {
  const thumb = scrollbar(height, total, offset);
  if (!thumb) return offset;
  const top = thumb.indexOf(true), bottom = thumb.lastIndexOf(true);
  const step = Math.max(1, height - 1);
  const next = row < top ? offset - step : row > bottom ? offset + step : offset;
  return Math.max(0, Math.min(total - height, next));
}
