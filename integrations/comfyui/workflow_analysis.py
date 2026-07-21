"""Analyze ComfyUI API workflows and expose generation input bindings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

try:
    from ...support.i18n import tr
except ImportError:  # standalone preview
    from support.i18n import tr  # type: ignore


class GenerationConfigError(ValueError):
    """Raised when generation configuration cannot be used safely."""


@dataclass(frozen=True)
class InputBinding:
    node_id: str
    input_name: str

    def public(self) -> dict[str, str]:
        return {"node_id": self.node_id, "input": self.input_name}


@dataclass(frozen=True)
class WorkflowAnalysis:
    output_node: str
    output_class: str
    sampler_node: str
    positive: tuple[InputBinding, ...]
    negative: tuple[InputBinding, ...]
    model: InputBinding
    model_kind: str
    clip: InputBinding | None
    vae: InputBinding | None
    width: InputBinding
    height: InputBinding
    parameters: Mapping[str, InputBinding]
    defaults: Mapping[str, Any]
    classes: tuple[str, ...]

    def public(self) -> dict[str, Any]:
        return {
            "output": {"node_id": self.output_node, "class_type": self.output_class},
            "sampler_node": self.sampler_node,
            "positive": [item.public() for item in self.positive],
            "negative": [item.public() for item in self.negative],
            "model": {**self.model.public(), "kind": self.model_kind},
            "clip": self.clip.public() if self.clip is not None else None,
            "vae": self.vae.public() if self.vae is not None else None,
            "width": self.width.public(),
            "height": self.height.public(),
            "parameters": {
                name: binding.public() for name, binding in self.parameters.items()
            },
            "defaults": dict(self.defaults),
            "classes": list(self.classes),
            "supports_negative": bool(self.negative),
        }


def _is_link(value: object) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
    )


def _nodes(workflow: object) -> dict[str, dict[str, Any]]:
    if not isinstance(workflow, dict) or not workflow:
        raise GenerationConfigError(tr("api.json 必须是非空对象"))
    result: dict[str, dict[str, Any]] = {}
    for raw_id, raw_node in workflow.items():
        node_id = str(raw_id)
        if not isinstance(raw_node, dict):
            raise GenerationConfigError(tr("节点 {node_id} 必须是对象", node_id=node_id))
        class_type = raw_node.get("class_type")
        inputs = raw_node.get("inputs")
        if not isinstance(class_type, str) or not class_type.strip():
            raise GenerationConfigError(
                tr("节点 {node_id} 缺少 class_type", node_id=node_id)
            )
        if not isinstance(inputs, dict):
            raise GenerationConfigError(
                tr("节点 {node_id} 缺少 inputs", node_id=node_id)
            )
        result[node_id] = raw_node
    return result


def _ancestors(nodes: Mapping[str, dict[str, Any]], start: str) -> set[str]:
    found: set[str] = set()
    stack = [start]
    while stack:
        current = stack.pop()
        if current in found:
            continue
        found.add(current)
        node = nodes.get(current)
        if not node:
            continue
        for value in node["inputs"].values():
            if _is_link(value):
                stack.append(str(value[0]))
    return found


def _branch_text_bindings(
    nodes: Mapping[str, dict[str, Any]], link: object, label: str
) -> tuple[InputBinding, ...]:
    localized_label = tr("负面") if label == "负面" else tr("正面")
    if not _is_link(link):
        raise GenerationConfigError(
            tr("无法识别{label}提示词连接", label=localized_label)
        )
    branch = _ancestors(nodes, str(link[0]))
    bindings: list[InputBinding] = []
    bound_nodes: set[str] = set()
    for node_id in branch:
        inputs = nodes[node_id]["inputs"]
        text_names = [
            name
            for name, value in inputs.items()
            if name in {"text", "text_g", "text_l", "prompt"}
            and isinstance(value, str)
        ]
        if text_names:
            bound_nodes.add(node_id)
            bindings.extend(InputBinding(node_id, name) for name in text_names)
    if not bindings:
        raise GenerationConfigError(
            tr("无法找到{label}提示词文本输入", label=localized_label)
        )
    if len(bound_nodes) != 1:
        raise GenerationConfigError(
            tr(
                "{label}提示词链包含多个文本节点，无法自动判断",
                label=localized_label,
            )
        )
    return tuple(sorted(bindings, key=lambda item: (item.node_id, item.input_name)))


def _optional_negative_bindings(
    nodes: Mapping[str, dict[str, Any]], link: object
) -> tuple[InputBinding, ...]:
    if not _is_link(link):
        return ()
    return _branch_text_bindings(nodes, link, "负面")


def _single_binding(
    candidates: list[InputBinding], missing: str, conflict: str
) -> InputBinding:
    unique = list(dict.fromkeys(candidates))
    if not unique:
        raise GenerationConfigError(missing)
    if len(unique) != 1:
        raise GenerationConfigError(conflict)
    return unique[0]


def _optional_unique_binding(
    candidates: list[InputBinding], conflict: str
) -> InputBinding | None:
    unique = list(dict.fromkeys(candidates))
    if not unique:
        return None
    if len(unique) != 1:
        raise GenerationConfigError(conflict)
    return unique[0]


def analyze_workflow(
    workflow: object,
    *,
    available_classes: set[str] | None = None,
    output_classes: set[str] | None = None,
) -> WorkflowAnalysis:
    """Find one unambiguous generation chain in ComfyUI API-format JSON."""

    nodes = _nodes(workflow)
    classes = tuple(sorted({str(node["class_type"]) for node in nodes.values()}))
    if available_classes is not None:
        missing = sorted(set(classes) - available_classes)
        if missing:
            raise GenerationConfigError(
                tr("缺少节点：{nodes}", nodes=", ".join(missing))
            )

    known_outputs = {"PreviewImage", "SaveImage"}
    if output_classes:
        known_outputs.update(output_classes)
    outputs = [
        node_id
        for node_id, node in nodes.items()
        if str(node["class_type"]) in known_outputs
        and _is_link(node["inputs"].get("images"))
    ]
    if not outputs:
        raise GenerationConfigError(tr("工作流缺少可识别的图片输出节点"))
    if len(outputs) != 1:
        raise GenerationConfigError(
            tr("工作流包含多个图片输出节点，请只保留一个最终输出")
        )
    output_node = outputs[0]
    chain = _ancestors(nodes, output_node)

    sampler_candidates = []
    for node_id in chain:
        inputs = nodes[node_id]["inputs"]
        if _is_link(inputs.get("positive")) and (
            "seed" in inputs or "noise_seed" in inputs or "steps" in inputs
        ):
            sampler_candidates.append(node_id)
    if not sampler_candidates:
        raise GenerationConfigError(tr("无法从图片输出反向找到采样器"))
    if len(sampler_candidates) != 1:
        raise GenerationConfigError(tr("图片输出链包含多个采样器，无法自动判断"))
    sampler_node = sampler_candidates[0]
    sampler_inputs = nodes[sampler_node]["inputs"]

    positive = _branch_text_bindings(nodes, sampler_inputs.get("positive"), "正面")
    negative = _optional_negative_bindings(nodes, sampler_inputs.get("negative"))

    loader_candidates: list[InputBinding] = []
    for node_id in chain:
        inputs = nodes[node_id]["inputs"]
        for input_name in ("ckpt_name", "unet_name"):
            if isinstance(inputs.get(input_name), str):
                loader_candidates.append(InputBinding(node_id, input_name))
    model = _single_binding(
        loader_candidates,
        tr("无法找到 ckpt_name 或 unet_name 模型输入"),
        tr("生成链包含多个模型加载输入，无法自动判断"),
    )
    model_kind = "checkpoint" if model.input_name == "ckpt_name" else "unet"

    clip_candidates: list[InputBinding] = []
    vae_candidates: list[InputBinding] = []
    for node_id in chain:
        inputs = nodes[node_id]["inputs"]
        if isinstance(inputs.get("clip_name"), str):
            clip_candidates.append(InputBinding(node_id, "clip_name"))
        if isinstance(inputs.get("vae_name"), str):
            vae_candidates.append(InputBinding(node_id, "vae_name"))
    clip = _optional_unique_binding(
        clip_candidates,
        tr("生成链包含多个 CLIP 加载输入，无法自动判断"),
    )
    vae = _optional_unique_binding(
        vae_candidates,
        tr("生成链包含多个 VAE 加载输入，无法自动判断"),
    )

    latent_link = sampler_inputs.get("latent_image")
    latent_branch = _ancestors(nodes, str(latent_link[0])) if _is_link(latent_link) else chain
    width_candidates: list[InputBinding] = []
    height_candidates: list[InputBinding] = []
    for node_id in latent_branch:
        inputs = nodes[node_id]["inputs"]
        if isinstance(inputs.get("width"), (int, float)) and isinstance(
            inputs.get("height"), (int, float)
        ):
            width_candidates.append(InputBinding(node_id, "width"))
            height_candidates.append(InputBinding(node_id, "height"))
    width = _single_binding(
        width_candidates,
        tr("无法找到宽度输入"),
        tr("Latent 链包含多个宽高节点，无法自动判断"),
    )
    height = _single_binding(
        height_candidates,
        tr("无法找到高度输入"),
        tr("Latent 链包含多个宽高节点，无法自动判断"),
    )

    parameter_aliases = {
        "seed": ("seed", "noise_seed"),
        "steps": ("steps",),
        "cfg": ("cfg",),
        "sampler": ("sampler_name",),
        "scheduler": ("scheduler",),
        "denoise": ("denoise",),
    }
    parameters: dict[str, InputBinding] = {}
    defaults: dict[str, Any] = {
        "model": nodes[model.node_id]["inputs"][model.input_name],
        "width": nodes[width.node_id]["inputs"][width.input_name],
        "height": nodes[height.node_id]["inputs"][height.input_name],
    }
    if clip is not None:
        defaults["clip"] = nodes[clip.node_id]["inputs"][clip.input_name]
    if vae is not None:
        defaults["vae"] = nodes[vae.node_id]["inputs"][vae.input_name]
    for public_name, aliases in parameter_aliases.items():
        input_name = next((name for name in aliases if name in sampler_inputs), None)
        if input_name is None or _is_link(sampler_inputs[input_name]):
            continue
        parameters[public_name] = InputBinding(sampler_node, input_name)
        defaults[public_name] = sampler_inputs[input_name]

    return WorkflowAnalysis(
        output_node=output_node,
        output_class=str(nodes[output_node]["class_type"]),
        sampler_node=sampler_node,
        positive=positive,
        negative=negative,
        model=model,
        model_kind=model_kind,
        clip=clip,
        vae=vae,
        width=width,
        height=height,
        parameters=parameters,
        defaults=defaults,
        classes=classes,
    )
