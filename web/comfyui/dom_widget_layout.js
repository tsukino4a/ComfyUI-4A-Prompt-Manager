/**
 * Keep DOM widget width aligned with the node.
 *
 * Comfy positions DOM widgets with `(widget.width ?? node.width) - margin * 2`.
 * Opening the properties panel / selection layout can cache a stale widget.width,
 * so the node body stays wide while the DOM content stays narrow (empty right gap).
 */
export function withSyncedDomWidth(options = {}) {
  const prevAfterResize = options.afterResize;
  const prevOnDraw = options.onDraw;

  const syncWidth = (widget, node) => {
    const target = widget?._node || widget?.node || node;
    const nodeWidth = Number(target?.size?.[0]);
    if (!widget || !(nodeWidth > 0)) return;
    if (widget.width !== nodeWidth) widget.width = nodeWidth;
  };

  return {
    ...options,
    afterResize(node) {
      syncWidth(this, node);
      return prevAfterResize?.call(this, node);
    },
    onDraw(widget) {
      syncWidth(widget, widget?._node || widget?.node);
      return prevOnDraw?.(widget);
    },
  };
}
