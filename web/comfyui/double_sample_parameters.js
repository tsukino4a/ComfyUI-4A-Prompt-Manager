import { app } from "../../scripts/app.js";
import { useKSamplerMinimumWidth } from "./sampler_node_size.js";
import { finishParameterReceive, receiveSamplerParameters } from "./widget_utils.js";

const NODE_CLASS = "Double Sample Parameters (4A Prompt Manager)";

function setupDoubleSampleParametersNode(node) {
  if (node.__pm4aDoubleSampleParametersReady) return;
  node.__pm4aDoubleSampleParametersReady = true;

  node.__pm4aDoubleSampleParametersReceive = (parameters) => {
    if (!parameters || typeof parameters !== "object") return { updated: [], skipped: [] };
    const updated = [];
    const skipped = [];
    receiveSamplerParameters(node, parameters, updated, skipped);
    return finishParameterReceive(node, updated, skipped);
  };
}

app.registerExtension({
  name: "ComfyUI-4A-Prompt-Manager.DoubleSampleParameters",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    useKSamplerMinimumWidth(nodeType);

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalCreated?.apply(this, arguments);
      setupDoubleSampleParametersNode(this);
      return result;
    };

    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = originalConfigured?.apply(this, arguments);
      setupDoubleSampleParametersNode(this);
      return result;
    };
  },
});
