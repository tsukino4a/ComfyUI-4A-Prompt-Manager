const FALLBACK_KSAMPLER_MIN_WIDTH = 210;

function kSamplerMinWidth() {
  const baseWidth = Number(globalThis.LiteGraph?.NODE_WIDTH);
  return Number.isFinite(baseWidth) && baseWidth > 0
    ? baseWidth * 1.5
    : FALLBACK_KSAMPLER_MIN_WIDTH;
}

export function useKSamplerMinimumWidth(nodeType) {
  const prototype = nodeType?.prototype;
  if (!prototype || prototype.__pm4aKSamplerMinimumWidthReady) return;
  prototype.__pm4aKSamplerMinimumWidthReady = true;

  const originalComputeSize = prototype.computeSize;
  prototype.computeSize = function () {
    const size = originalComputeSize?.apply(this, arguments) || [kSamplerMinWidth(), 0];
    size[0] = kSamplerMinWidth();
    return size;
  };
}
