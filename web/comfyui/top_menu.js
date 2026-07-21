/**
 * Top-bar launcher for ComfyUI-4A-Prompt-Manager.
 * Mirrors ComfyUI-Lora-Manager's top_menu_extension.js:
 * - frontend >= 1.33.9: actionBarButtons API (icon next to LoRA Manager)
 * - older: ComfyButtonGroup inserted before settingsGroup
 */
import { app } from "../../scripts/app.js";
import { configureComfyI18n, getComfyLocale, t } from "./i18n.js?v=1";

configureComfyI18n(app);

const BUTTON_TOOLTIP = t("打开 4A 提示词管理器（右键添加浏览器节点；Shift+点击打开指定尺寸窗口）");
const MANAGER_PATH = "/pm4a/wildcards";
const BROWSER_NODE_CLASS = "Prompt Manager Browser (4A Prompt Manager)";
const NEW_WINDOW_FEATURES =
    "width=1280,height=860,resizable=yes,scrollbars=yes,status=yes";
const MAX_ATTACH_ATTEMPTS = 120;
const BUTTON_GROUP_CLASS = "pm4a-top-menu-group";
const MIN_VERSION_FOR_ACTION_BAR = [1, 33, 9];
const BUTTON_BG = "#2f7d62";
let actionBarObserver = null;
let actionBarStyleFrame = 0;

const openManager = (event) => {
    configureComfyI18n(app);
    const url = `${window.location.origin}${MANAGER_PATH}?lang=${getComfyLocale(app)}`;
    if (event?.shiftKey) {
        window.open(url, "_blank", NEW_WINDOW_FEATURES);
        return;
    }
    window.open(url, "_blank");
};

const getVisibleCanvasCenter = (canvas) => {
    const area = canvas?.visible_area;
    if (
        area?.length >= 4 &&
        Number.isFinite(area[0]) &&
        Number.isFinite(area[1]) &&
        Number.isFinite(area[2]) &&
        Number.isFinite(area[3])
    ) {
        return [area[0] + area[2] / 2, area[1] + area[3] / 2];
    }

    const canvasElement = app.canvasEl || canvas?.canvas;
    const rect = canvasElement?.getBoundingClientRect?.();
    if (rect && typeof canvas?.convertEventToCanvasOffset === "function") {
        return canvas.convertEventToCanvasOffset({
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
        });
    }

    const scale = Number(canvas?.ds?.scale) || 1;
    const offset = canvas?.ds?.offset || [0, 0];
    return [
        (Number(rect?.width) || 1200) / (2 * scale) - Number(offset[0] || 0),
        (Number(rect?.height) || 800) / (2 * scale) - Number(offset[1] || 0),
    ];
};

const addBrowserNode = (event) => {
    event?.preventDefault();
    event?.stopPropagation();

    const canvas = app.canvas;
    const graph = canvas?.getCurrentGraph?.() || canvas?.graph || app.graph;
    const node = globalThis.LiteGraph?.createNode?.(BROWSER_NODE_CLASS);
    if (!canvas || !graph || !node) {
        console.warn("[4A-PM] unable to add Prompt Manager Browser node.");
        return;
    }

    const center = getVisibleCanvasCenter(canvas);
    node.pos = [
        center[0] - Number(node.size?.[0] || 0) / 2,
        center[1] - Number(node.size?.[1] || 0) / 2,
    ];
    graph.add(node);
    canvas.selectNode?.(node, false);
    graph.setDirtyCanvas?.(true, true);
};

const attachButtonInteractions = (button) => {
    if (button.dataset.pm4aContextMenuAttached === "1") return;
    button.dataset.pm4aContextMenuAttached = "1";
    button.addEventListener("contextmenu", addBrowserNode);
};

const getComfyUIFrontendVersion = async () => {
    try {
        if (window["__COMFYUI_FRONTEND_VERSION__"]) {
            return window["__COMFYUI_FRONTEND_VERSION__"];
        }
    } catch (_) {
        /* ignore */
    }

    try {
        const response = await fetch("/system_stats");
        const data = await response.json();
        if (data?.system?.comfyui_frontend_version) {
            return data.system.comfyui_frontend_version;
        }
        if (data?.system?.required_frontend_version) {
            return data.system.required_frontend_version;
        }
    } catch (error) {
        console.warn("[4A-PM] unable to fetch system_stats:", error);
    }
    return "0.0.0";
};

const parseVersion = (versionStr) => {
    if (!versionStr || typeof versionStr !== "string") return [0, 0, 0];
    const clean = versionStr.replace(/^[vV]/, "").split("-")[0];
    const parts = clean.split(".").map((p) => parseInt(p, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return parts;
};

const compareVersions = (a, b) => {
    const v1 = typeof a === "string" ? parseVersion(a) : a;
    const v2 = typeof b === "string" ? parseVersion(b) : b;
    for (let i = 0; i < 3; i++) {
        if (v1[i] > v2[i]) return 1;
        if (v1[i] < v2[i]) return -1;
    }
    return 0;
};

const supportsActionBarButtons = async () => {
    const version = await getComfyUIFrontendVersion();
    return compareVersions(version, MIN_VERSION_FOR_ACTION_BAR) >= 0;
};

/** Full-bleed icon: green fills the whole SVG (like LoRA Manager's L tile). */
const getPm4aIconSvg = () => `
<svg data-pm4a-icon="1" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" preserveAspectRatio="none">
  <rect width="24" height="24" fill="${BUTTON_BG}"/>
  <text x="12" y="16.2" text-anchor="middle" font-size="12" font-family="Segoe UI, Arial, sans-serif" font-weight="700" fill="#ffffff">4A</text>
</svg>
`;

const applyFilledButtonStyle = (button) => {
    button.classList.add("pm4a-top-menu-button");
    button.setAttribute("aria-label", BUTTON_TOOLTIP);
    button.title = BUTTON_TOOLTIP;
    button.innerHTML = getPm4aIconSvg();
    attachButtonInteractions(button);
    button.style.cssText = [
        "border-radius:4px",
        "padding:0",
        "margin:0 6px",
        "border:none",
        "overflow:hidden",
        `background-color:${BUTTON_BG}`,
        "width:28px",
        "height:28px",
        "min-width:28px",
        "min-height:28px",
        "display:inline-flex",
        "align-items:center",
        "justify-content:center",
        "box-sizing:border-box",
        "line-height:0",
    ].join(";");
    const svg = button.querySelector("svg");
    if (svg) {
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.style.display = "block";
    }
};

const createTopMenuButton = async () => {
    const { ComfyButton } = await import("../../scripts/ui/components/button.js");

    const button = new ComfyButton({
        icon: "promptmanager4a",
        tooltip: BUTTON_TOOLTIP,
        app,
        enabled: true,
        classList: "comfyui-button comfyui-menu-mobile-collapse primary",
    });

    applyFilledButtonStyle(button.element);
    button.element.addEventListener("click", openManager);
    return button;
};

const attachTopMenuButton = async (attempt = 0) => {
    if (document.querySelector(`.${BUTTON_GROUP_CLASS}`)) {
        return;
    }

    const settingsGroup = app.menu?.settingsGroup;
    if (!settingsGroup?.element?.parentElement) {
        if (attempt >= MAX_ATTACH_ATTEMPTS) {
            console.warn("[4A-PM] unable to locate ComfyUI settings button group.");
            return;
        }
        requestAnimationFrame(() => attachTopMenuButton(attempt + 1));
        return;
    }

    const managerButton = await createTopMenuButton();
    const { ComfyButtonGroup } = await import(
        "../../scripts/ui/components/buttonGroup.js"
    );

    const buttonGroup = new ComfyButtonGroup(managerButton);
    buttonGroup.element.classList.add(BUTTON_GROUP_CLASS);
    buttonGroup.element.style.margin = "0";
    buttonGroup.element.style.gap = "0";
    settingsGroup.element.before(buttonGroup.element);
};

const injectToolbarStyles = () => {
    const styleId = "pm4a-top-menu-button-styles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
        button.pm4a-top-menu-button {
            margin: 0 6px !important;
            margin-inline: 6px !important;
            padding: 0 !important;
            border: none !important;
            overflow: hidden !important;
            background-color: ${BUTTON_BG} !important;
            width: 28px !important;
            height: 28px !important;
            min-width: 28px !important;
            min-height: 28px !important;
            box-sizing: border-box !important;
            line-height: 0 !important;
        }
        button.pm4a-top-menu-button:hover {
            filter: brightness(1.1);
        }
        button.pm4a-top-menu-button svg {
            width: 100% !important;
            height: 100% !important;
            display: block !important;
        }
        .${BUTTON_GROUP_CLASS} {
            margin: 0 !important;
            margin-inline: 0 !important;
            padding: 0 !important;
            gap: 0 !important;
        }
        /* Tighten gap after our button inside the action bar flex row */
        button.pm4a-top-menu-button + *,
        .${BUTTON_GROUP_CLASS} + * {
            margin-left: 0 !important;
        }
    `;
    document.head.appendChild(style);
};

const styleActionBarButton = () => {
    injectToolbarStyles();

    const replaceButtonIcon = () => {
        const buttons = document.querySelectorAll(
            `button[aria-label="${BUTTON_TOOLTIP}"]`
        );
        buttons.forEach((button) => {
            if (button.querySelector('svg[data-pm4a-icon="1"]')) return;
            applyFilledButtonStyle(button);
            // Collapse empty margin on parent group if present
            const group = button.parentElement;
            if (group) {
                group.style.margin = "0";
                group.style.gap = "0";
                group.style.padding = "0";
                group.classList.add(BUTTON_GROUP_CLASS);
            }
        });
    };
    const scheduleButtonStyle = () => {
        if (actionBarStyleFrame) return;
        actionBarStyleFrame = requestAnimationFrame(() => {
            actionBarStyleFrame = 0;
            replaceButtonIcon();
        });
    };

    scheduleButtonStyle();
    if (!actionBarObserver) {
        actionBarObserver = new MutationObserver(scheduleButtonStyle);
        actionBarObserver.observe(document.body, { childList: true, subtree: true });
    }
};

const createExtensionObject = (useActionBar) => {
    const extensionObj = {
        name: "ComfyUI-4A-Prompt-Manager.TopMenu",
        async setup() {
            configureComfyI18n(app);
            injectToolbarStyles();
            if (!useActionBar) {
                await attachTopMenuButton();
            } else {
                styleActionBarButton();
            }
        },
    };

    if (useActionBar) {
        extensionObj.actionBarButtons = [
            {
                icon: "icon-[mdi--text-box-outline] size-4",
                tooltip: BUTTON_TOOLTIP,
                onClick: openManager,
            },
        ];
    }

    return extensionObj;
};

(async () => {
    const useActionBar = await supportsActionBarButtons();
    app.registerExtension(createExtensionObject(useActionBar));
})();
