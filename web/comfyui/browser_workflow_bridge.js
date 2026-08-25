import { app } from "../../scripts/app.js";
import {
  readComfyWorkflowSource,
  resolveWorkflowKey,
} from "/pm4a/static/browser_chrome_state.js";

const EVENT_NAME = "pm4a-browser-workflow";

function currentWorkflowKey() {
  return resolveWorkflowKey(readComfyWorkflowSource(window));
}

function publishWorkflowKey() {
  const key = currentWorkflowKey();
  if (window.__pm4aBrowserWorkflowKey === key) return key;
  window.__pm4aBrowserWorkflowKey = key;
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { key } }));
  return key;
}

app.registerExtension({
  name: "ComfyUI-4A-Prompt-Manager.BrowserWorkflow",

  setup() {
    publishWorkflowKey();
    try {
      const workflowApi = app.extensionManager?.workflow;
      if (typeof workflowApi?.$subscribe === "function") {
        workflowApi.$subscribe(() => publishWorkflowKey());
      }
    } catch (_) {
      /* older frontends do not expose a Pinia workflow store */
    }
    window.setInterval(publishWorkflowKey, 800);
  },

  async afterConfigureGraph() {
    publishWorkflowKey();
  },
});
